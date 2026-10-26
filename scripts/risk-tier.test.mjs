import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {classify as classifyWith, compareVersions, minimumReleaseAgeDays, parseRules} from './risk-tier.mjs';
import {gitEnv} from './test-git-repo.mjs';

// The rules of Triphammer's example project (bin/test-fixtures/example-project), which the engine tests run on.
const rules = parseRules(readFileSync(new URL('../bin/test-fixtures/example-project/.triphammer/risk-tier.json', import.meta.url), 'utf8'));
const classify = (changes, source) => classifyWith(changes, source, rules);

// Paths judged by path alone: every file reads as empty on both sides, so no test file loses a test.
const empty = {base: () => '', head: () => '', release: async () => undefined, now: new Date('2026-10-15T00:00:00Z')};
const tier = async (...changes) => (await classify(changes.map(([status, path]) => ({status, path})), empty)).tier;

test('a rule limited to some git statuses, or excepting some, judges only those changes', async () => {
  const migration = 'database/migrations/V0001__initial.sql';
  assert.deepEqual(await classify([{status: 'M', path: migration}], empty),
    {tier: 'blocked', reasons: [`${migration}: applied migrations are immutable; add a new migration`]});
  assert.deepEqual(await classify([{status: 'A', path: 'database/migrations/V0002__next.sql'}], empty),
    {tier: 'escalate', reasons: ['database/migrations/V0002__next.sql: outside the areas that merge automatically']});
  for (const path of ['tests/Pricing.Tests/PricingTests.cs', 'src/web/e2e/chain.spec.ts']) {
    assert.deepEqual(await classify([{status: 'D', path}], empty), {tier: 'escalate', reasons: [`${path}: deletes a test`]}, path);
    assert.equal(await tier(['A', path]), 'auto', path);
  }
});

// A modified test file judged by its base and head text.
const testChange = async (path, before, after) => classify([{status: 'M', path}], {base: () => before, head: () => after});
const csharpTests = (...methods) => `public sealed class PricingTests\n{\n${methods.map(([attribute, name]) =>
  `    ${attribute}\n    public void ${name}() { Assert.True(true); }\n`).join('\n')}}\n`;
const specTests = (...names) => `import {test, expect} from '@playwright/test';\n\ntest.describe('chain', () => {\n${names.map(name =>
  `  test('${name}', async ({page}) => {\n    await test.step('open', async () => expect(/x/.test('x')).toBe(true));\n  });\n`).join('')}});\n`;
const csharpPath = 'tests/Pricing.Tests/PricingTests.cs';
// Adding an #if, #elif or #else to a C# test file escalates on its own; the counting tests below look past that reason.
const countReasons = result => result.reasons.filter(reason => !reason.includes(': adds conditional compilation'));
const specPath = 'src/web/e2e/chain.spec.ts';
// PricingTests with Rounds under the given directive lines, closed by #endif before the class ends.
const wrapped = (...lines) => csharpTests(['[Fact]', 'Prices'], [`${lines.join('\n')}\n    [Fact]`, 'Rounds']).replace(/\n}\n$/, '\n#endif\n}\n');

test('removing a [Fact] or [Theory] from a C# test file that stays escalates and names the file', async () => {
  const before = csharpTests(['[Fact]', 'Prices'], ['[Theory]\n    [InlineData(1)]', 'Rounds'], ['[Fact(Skip = "slow")]', 'Slow']);
  for (const after of [csharpTests(['[Fact]', 'Prices'], ['[Fact(Skip = "slow")]', 'Slow']), csharpTests(['[Fact]', 'Prices'], ['[Theory]', 'Rounds']),
    csharpTests(['[Fact]', 'Prices'], ['// [Theory]', 'Rounds'], ['[Fact(Skip = "slow")]', 'Slow'])]) {
    const result = await testChange(csharpPath, before, after);
    assert.equal(result.tier, 'escalate', after);
    assert.deepEqual(result.reasons, [`${csharpPath}: removes test cases (3 before, 2 after)`]);
  }
});

test('a test case moved into a block comment or an #if false region no longer counts', async () => {
  const before = csharpTests(['[Fact]', 'Prices'], ['[Fact]', 'Rounds']);
  for (const after of [
    csharpTests(['[Fact]', 'Prices'], ['/* [Fact]', 'Rounds']).replace('Assert.True(true); }\n}', 'Assert.True(true); } */\n}'),
    csharpTests(['[Fact]', 'Prices'], ['#if false\n    [Fact]', 'Rounds']).replace(/\n}\n$/, '\n#endif\n}\n'),
    csharpTests(['[Fact]', 'Prices'], ['#if false\n#if DEBUG\n#endif\n    [Fact]', 'Rounds']).replace(/\n}\n$/, '\n#endif\n}\n'),
  ]) {
    const result = await testChange(csharpPath, before, after);
    assert.equal(result.tier, 'escalate', after);
    assert.deepEqual(countReasons(result), [`${csharpPath}: removes test cases (2 before, 1 after)`], after);
  }
  const spec = specTests('loads', 'filters');
  const commented = spec.replace("  test('filters'", "  /* test('filters'").replace(/\}\);\n\}\);\n$/, '}); */\n});\n');
  assert.notEqual(commented, spec);
  const result = await testChange(specPath, spec, commented);
  assert.equal(result.tier, 'escalate', commented);
  assert.deepEqual(result.reasons, [`${specPath}: removes test cases (2 before, 1 after)`]);
});

test('a test case moved under an #if on an undefined symbol, or a later branch of one, no longer counts', async () => {
  const before = csharpTests(['[Fact]', 'Prices'], ['[Fact]', 'Rounds']);
  for (const after of [wrapped('#if NEVER'), wrapped('#if !NEVER'), wrapped('#if NEVER // off'), wrapped('#if false', '#elif NEVER'),
    wrapped('#if NEVER', '#else'), wrapped('#if true', '#else'), wrapped('#if NEVER', '#elif true')]) {
    const result = await testChange(csharpPath, before, after);
    assert.equal(result.tier, 'escalate', after);
    assert.deepEqual(countReasons(result), [`${csharpPath}: removes test cases (2 before, 1 after)`], after);
  }
});

test('tests under #if true, an #elif true or #else after only false branches, or an unchanged conditional keep their count', async () => {
  const before = csharpTests(['[Fact]', 'Prices'], ['[Fact]', 'Rounds']);
  for (const after of [wrapped('#if true'), wrapped('#if false', '#elif true'), wrapped('#if false', '#elif false', '#else'),
    wrapped('#if true', '#if NEVER', '#endif')]) {
    assert.deepEqual(countReasons(await testChange(csharpPath, before, after)), [], after);
  }
  const conditional = wrapped('#if NEVER');
  assert.deepEqual(await testChange(csharpPath, conditional, conditional.replace('Prices', 'PricesAtMid')), {tier: 'auto', reasons: []});
});

test('directives and line comments end at every line break the compiler accepts, not only LF', async () => {
  const path = 'tests/X/FooTests.cs';
  const twoFacts = 'class FooTests{\n[Fact] void A(){}\n[Fact] void B(){}\n}\n';
  const removed = {tier: 'escalate', reasons: [`${path}: removes test cases (2 before, 1 after)`]};
  for (const after of ['class FooTests{\n[Fact] void A(){}\n#if NEVER\r[Fact] void B(){}\n#endif\n}\n',
    'class FooTests{\n[Fact] void A(){}\n#if NEVER\u0085[Fact] void B(){}\n#endif\n}\n',
    'class FooTests{\n[Fact] void A(){}\n#if NEVER\u2028[Fact] void B(){}\n#endif\n}\n']) {
    const result = await testChange(path, twoFacts, after);
    assert.deepEqual({tier: result.tier, reasons: countReasons(result)}, removed, JSON.stringify(after));
  }
  const crlf = text => text.replace(/\n/g, '\r\n');
  const before = crlf(csharpTests(['[Fact]', 'Prices'], ['[Fact]', 'Rounds']));
  const underNever = crlf(csharpTests(['[Fact]', 'Prices'], ['#if NEVER\n    [Fact]', 'Rounds']).replace(/\n}\n$/, '\n#endif\n}\n'));
  assert.deepEqual(countReasons(await testChange(csharpPath, before, underNever)), [`${csharpPath}: removes test cases (2 before, 1 after)`]);
  assert.deepEqual(await testChange(csharpPath, before, before.replace('Prices', 'PricesAtMid')), {tier: 'auto', reasons: []});
  // A line comment ends at a lone CR, so the test after it counts on the base and removing it escalates.
  const commentThenFacts = 'class FooTests{\n// note\r[Fact] void A(){}\n[Fact] void B(){}\n}\n';
  assert.deepEqual(await testChange(path, commentThenFacts, 'class FooTests{\n// note\n[Fact] void B(){}\n}\n'), removed);
  const spec = "test('a', () => {});\n// note test('b', () => {});\n";
  assert.deepEqual(await testChange(specPath, spec, "test('a', () => {});\n"),
    {tier: 'escalate', reasons: [`${specPath}: removes test cases (2 before, 1 after)`]});
});

test('adding an #if, #elif or #else to a C# test file escalates, and a comment marker in an interpolation hole hides no test', async () => {
  const path = 'tests/X/FooTests.cs';
  const twoFacts = 'class FooTests{\n[Fact] void A(){}\n[Fact] void B(){}\n}\n';
  const hidden = 'class FooTests{\n[Fact] void A(){}\nstring s = $"{"/*"}";\n#if NEVER\n*/\n[Fact] void B(){}\n#endif\n}\n';
  assert.deepEqual(await testChange(path, twoFacts, hidden), {tier: 'escalate', reasons: [`${path}: removes test cases (2 before, 1 after)`,
    `${path}: adds conditional compilation (added directive: #if NEVER)`]});
  const debug = 'class FooTests{\n[Fact] void A(){}\n#if DEBUG\n[Fact] void B(){}\n#endif\n}\n';
  assert.deepEqual(await testChange(path, twoFacts, debug), {tier: 'escalate', reasons: [`${path}: removes test cases (2 before, 1 after)`,
    `${path}: adds conditional compilation (added directive: #if DEBUG)`]});
  const debugHelper = twoFacts.replace(/}\n$/, '#if DEBUG\nvoid Log(){}\n#endif\n}\n');
  assert.deepEqual(await testChange(path, twoFacts, debugHelper),
    {tier: 'escalate', reasons: [`${path}: adds conditional compilation (added directive: #if DEBUG)`]});
  assert.deepEqual(await testChange(path, debug, debug.replace('#if DEBUG\n', '#if DEBUG\n[Fact] void C(){}\n#else\n')),
    {tier: 'escalate', reasons: [`${path}: adds conditional compilation (added directive: #else)`]});
  // Swapping one directive for another keeps the total but adds a line the base lacks.
  const swapBase = 'public class FooTests {\n#if DEBUG\n    static int Helper() => 1;\n#endif\n'
    + '    [Fact] public void A() {}\n    [Fact] public void B() {}\n}\n';
  const swapHead = 'public class FooTests {\n    [Fact] public void A() {}\n    static string S = $"{ "/*" }";\n'
    + '#if NEVER\n    // */\n    [Fact] public void B() {}\n#endif\n}\n';
  assert.deepEqual(await testChange('tests/Pricing.Tests/FooTests.cs', swapBase, swapHead), {tier: 'escalate', reasons: [
    'tests/Pricing.Tests/FooTests.cs: removes test cases (2 before, 1 after)',
    'tests/Pricing.Tests/FooTests.cs: adds conditional compilation (added directive: #if NEVER)']});
  // Directive text is compared trimmed with whitespace collapsed, so reindenting one stays automatic.
  assert.deepEqual(await testChange(path, debug, debug.replace('#if DEBUG', '  #  if   DEBUG')), {tier: 'auto', reasons: []});
  // A lone CR or U+2028 starts a directive line too.
  assert.equal((await testChange(path, twoFacts, twoFacts.replace('\n[Fact] void B', '\r#if NEVER\u2028[Fact] void B'))).tier, 'escalate');
  // Unchanged directives with no test removed stay automatic, as does a file that loses a directive.
  assert.deepEqual(await testChange(path, debug, debug.replace('void A', 'void Renamed')), {tier: 'auto', reasons: []});
  assert.deepEqual(await testChange(path, debug, twoFacts), {tier: 'auto', reasons: []});
  // Web specs have no preprocessor.
  const spec = specTests('loads');
  assert.deepEqual(await testChange(specPath, spec, `${spec}// #if NEVER\n`), {tier: 'auto', reasons: []});
});

test('a new C# test file that declares tests and has an #if, #elif or #else escalates', async () => {
  const added = (path, head) => classify([{status: 'A', path}], {base: () => { throw Error('absent'); }, head: () => head});
  const path = 'tests/X/FooTests.cs';
  assert.deepEqual(await added(path, 'class FooTests{\n#if NEVER\n[Fact] void A(){}\n#endif\n}\n'),
    {tier: 'escalate', reasons: [`${path}: adds conditional compilation (added directive: #if NEVER)`]});
  assert.deepEqual(await added(path, 'class FooTests{\n[Fact] void A(){}\n}\n'), {tier: 'auto', reasons: []});
  assert.deepEqual(await added('tests/X/Support/Cases.cs', 'class Cases{\n#if DEBUG\n#endif\n}\n'), {tier: 'auto', reasons: []});
});

test('changing the type of a test file, such as replacing it with a symlink, escalates', async () => {
  for (const path of [csharpPath, specPath, 'tests/Pricing.Tests/Support/PricingCases.cs', 'src/web/src/chain.test.ts']) {
    assert.deepEqual(await classify([{status: 'T', path}], empty),
      {tier: 'escalate', reasons: [`${path}: changes the type of a test file (for example to a symlink)`]}, path);
  }
  assert.equal(await tier(['T', 'src/web/src/App.tsx']), 'auto');
});

test('comment markers inside strings and the #else of an #if false region keep their test cases counted', async () => {
  const before = csharpTests(['[Fact]', 'Prices'], ['[Fact]', 'Rounds']);
  const after = 'class PricingTests\n{\n    string Url = "http://x/*";\n    [Fact] public void Prices() {}\n#if false\n    void Old() {}\n#else\n'
    + '    [Fact] public void Rounds() {}\n#endif\n    string End = @"*/";\n}\n';
  assert.deepEqual(countReasons(await testChange(csharpPath, before, after)), []);
  const spec = specTests('loads', 'filters');
  assert.deepEqual(await testChange(specPath, spec, spec.replace("test('loads'", "test('loads http://x/* '")), {tier: 'auto', reasons: []});
});

test('a C# test case named only inside a regular, verbatim, interpolated or raw string no longer counts', async () => {
  const path = 'tests/X/PricingTests.cs';
  const facts = (...lines) => `class PricingTests{\n[Fact] void A(){}\n${lines.join('\n')}\n}\n`;
  const removed = {tier: 'escalate', reasons: [`${path}: removes test cases (2 before, 1 after)`]};
  for (const string of ['const string S = "[Fact]";', 'const string S = """\n[Fact]\n""";', 'const string S = """[Fact]""";',
    'string S = @"say ""hi"" [Fact]";', 'string S = @"\n[Fact]\n";', 'string S = $"{N} [Fact]";', 'string S = $"{(N > 0 ? "a" : "b")} [Fact]";',
    'string S = $@"{N}\n[Fact]";', 'string S = @$"{N}\n[Fact]";', 'string S = $"""\n{N} [Fact]\n""";', 'string S = $$"""\n{N} {{N}} [Fact]\n""";',
    'string S = $"{N:F2} [Fact]";', "char Q = '\"'; string S = \"[Fact]\";"]) {
    assert.deepEqual(await testChange(path, facts('[Fact] void B(){}'), facts(string)), removed, string);
  }
  // Quotes inside a literal end nothing early, so a real test after it still counts.
  for (const string of ['string S = "\\"[";', "char Q = '\"';", 'string S = @"""";', 'string S = """ a "" b """;', 'string S = $"{"}"}";']) {
    assert.deepEqual(await testChange(path, facts('[Fact] void B(){}'), facts(string, '[Fact] void B(){}')), {tier: 'auto', reasons: []}, string);
  }
});

test('a JavaScript test case named only inside a string, template, regex, comment after a regex or JSX text no longer counts', async () => {
  const path = 'src/web/src/x.test.ts';
  const two = "test('a', () => {});\ntest('b', () => {});\n";
  for (const after of ["const r = /'/; // test('b', () => {})", "const s = 'test(';", 'const s = "it(";', "const s = `\n${n} test('b', () => {})`;",
    "const s = `${`}`} test('b')`;", "const r = /[/'\"]/; // test('b')", "if (ok) /'/.test(s); // test('b', () => {})",
    "const r = x ? /'/ : y; // test('b')", "return typeof /'/; // test('b')", "const half = total! / 2; const r = /'/; // test('b')"]) {
    const head = `test('a', () => {});\n${after}\n`;
    assert.deepEqual(await testChange(path, two, head), {tier: 'escalate', reasons: [`${path}: removes test cases (2 before, 1 after)`]}, after);
  }
  const tsx = 'src/web/src/x.test.tsx';
  assert.deepEqual(await testChange(tsx, two, "test('a', () => {});\nconst e = <p title=\"it(\">don't test('b', () => {})</p>;\n"),
    {tier: 'escalate', reasons: [`${tsx}: removes test cases (2 before, 1 after)`]});
});

test('where the scanner cannot tell code from text, the declarations there count on the base only', async () => {
  const unread = (path, before, after) => ({tier: 'escalate',
    reasons: [`${path}: removes test cases (${before} before, ${after} after, counting those in text it cannot read on the base only)`]});
  const spec = 'src/web/src/x.test.ts';
  // A / after a } starts a regex after a block and divides after an object literal.
  const blockThenSlash = "test('a', () => {});\n{}\n/x/g.exec(s); test('b', () => {});\n";
  assert.deepEqual(await testChange(spec, blockThenSlash, blockThenSlash.replace("'a'", "'a2'")), unread(spec, 2, 1));
  const two = "test('a', () => {});\ntest('b', () => {});\n";
  assert.deepEqual(await testChange(spec, two, "test('a', () => {});\nconst s = 'open;\ntest('b', () => {});\n"), unread(spec, 2, 1));
  assert.deepEqual(await testChange(spec, two, "test('a', () => {});\nconst s = `${x;\ntest('b', () => {});\n"), unread(spec, 2, 1));
  // In TSX a generic arrow's <T extends U> is no JSX element, and a closing tag naming another element ends none.
  const tsx = 'src/web/src/x.test.tsx';
  const generic = "const id = <T extends unknown>(x: T) => x;\ntest('a', () => {});\ntest('b', () => {});\n// renders </p>\n";
  assert.deepEqual(await testChange(tsx, generic, generic.replace("test('b', () => {});\n", '')), unread(tsx, 2, 0));
  const mismatched = "const e = <div>text</span>;\ntest('a', () => {});\ntest('b', () => {});\n// </div>\n";
  assert.deepEqual(await testChange(tsx, mismatched, mismatched.replace("test('b', () => {});\n", '')), unread(tsx, 2, 0));
  const path = 'tests/X/PricingTests.cs';
  const facts = 'class PricingTests{\n[Fact] void A(){}\n[Fact] void B(){}\n}\n';
  assert.deepEqual(await testChange(path, facts, facts.replace('[Fact] void B', 'const string S = """\n[Fact] void B')), unread(path, 2, 1));
  assert.deepEqual(await testChange(path, facts, facts.replace('[Fact] void B', 'string S = $"{N\n[Fact] void B')), unread(path, 2, 1));
});

test('a regex after default, extends or for await (...), a TSX type parameter list and an HTML-like comment hide no removed test', async () => {
  const two = "test('a', () => {});\ntest('b', () => {});\n";
  const removes = /: removes test cases \(2 before, 1 after/;
  const cases = [
    ['src/web/src/x.test.ts', 'export default /[test(]/;'],
    ['src/web/src/x.test.ts', 'class A extends /[test(]/.constructor {}'],
    ['src/web/src/x.test.ts', 'async function f(y) { for await (const x of y) /[test(]/.exec(x); }'],
    ['src/web/src/x.test.tsx', "interface Api { map: <T>(x: T) => T }\nconst close = '</T>', label = 'test(', done = 'x';"],
    ['src/web/src/x.test.tsx', "type F = <T>(x: T) => T;\nconst s = '</T>', t = 'test(', u = 'x';"],
    ['src/web/src/x.test.js', "<!-- test('b', () => {});"],
    ['src/web/src/x.test.js', "x = 1\n--> test('b', () => {});"],
  ];
  for (const [path, line] of cases) {
    const result = await testChange(path, two, `test('a', () => {});\n${line}\n`);
    assert.equal(result.tier, 'escalate', line);
    assert.match(result.reasons.join('\n'), removes, line);
  }
  // Ordinary JSX in a TSX test still reads as code around it.
  const tsx = 'src/web/src/x.test.tsx';
  const jsx = "render(<Foo />);\nconst e = expect(<div>a</div>);\nfunction F() { return <div title=\"it(\">b</div>; }\n"
    + "test('a', () => {});\ntest('b', () => {});\n";
  assert.deepEqual(await testChange(tsx, jsx, jsx.replace("'a'", "'a2'")), {tier: 'auto', reasons: []});
  assert.deepEqual(await testChange(tsx, jsx, jsx.replace("test('b', () => {});\n", '')),
    {tier: 'escalate', reasons: [`${tsx}: removes test cases (2 before, 1 after)`]});
});

test('division, JSX text with quotes and literals holding quotes or slashes keep later test cases counted', async () => {
  const path = 'src/web/src/x.test.tsx';
  const spec = "const half = (a + b) / 2 / c;\nconst ratio = total! / count;\nconst e = <p className=\"x\">Don't {n}/2 it(</p>;\n"
    + "const f = <><Ui.Row><b>it(</b><br/></ Ui.Row ></>;\n"
    + "const s = `it's ${'}'} ${`${n}`}`;\nconst r = /[/]\\/'/g;\nconst q = a++ / 2;\nconst o = {a: 1};\n"
    + "test('a', () => {});\ntest('b', () => {});\n";
  assert.deepEqual(await testChange(path, spec, spec.replace("'a'", "'a2'")), {tier: 'auto', reasons: []});
  const csharp = 'class PricingTests{\n#region don\'t\n#endregion\nchar Q = \'\\\'\';\nstring S = $"{{ {N} }}";\n[Fact] void A(){}\n[Fact] void B(){}\n}\n';
  assert.deepEqual(await testChange('tests/X/PricingTests.cs', csharp, csharp.replace('void A', 'void A2')), {tier: 'auto', reasons: []});
});

test('removing a test( from a web spec that stays escalates and names the file', async () => {
  const result = await testChange(specPath, specTests('loads', 'filters'), specTests('loads'));
  assert.equal(result.tier, 'escalate');
  assert.deepEqual(result.reasons, [`${specPath}: removes test cases (2 before, 1 after)`]);
});

test('renaming, moving or adding tests within a file that keeps its count merges automatically', async () => {
  const csharp = csharpTests(['[Fact]', 'Prices'], ['[Theory]', 'Rounds']);
  for (const after of [csharpTests(['[Theory]', 'Rounds'], ['[Fact]', 'PricesAtMid']), csharpTests(['[Fact]', 'Prices'], ['[Theory]', 'Rounds'], ['[Fact]', 'New'])]) {
    assert.deepEqual(await testChange(csharpPath, csharp, after), {tier: 'auto', reasons: []}, after);
  }
  assert.deepEqual(await testChange(specPath, specTests('loads', 'filters'), specTests('filters by expiry', 'loads')), {tier: 'auto', reasons: []});
  assert.deepEqual(await testChange('tests/Pricing.Tests/FakeMarket.cs', 'class A {}', ''), {tier: 'auto', reasons: []});
});

test('a modified test file escalates when its versions cannot be read', async () => {
  const unreadable = {base: () => { throw Error('missing'); }, head: () => ''};
  assert.equal((await classify([{status: 'M', path: specPath}], unreadable)).tier, 'escalate');
});

test('one escalating path escalates the whole change', async () => {
  assert.equal(await tier(['M', 'src/X.cs'], ['M', 'AGENTS.md']), 'escalate');
});

// Dependency files judged by content: base and head text per path, and a fake registry of releases.
const now = new Date('2026-10-15T00:00:00Z');
const daysAgo = days => new Date(now - days * 86_400_000);
const judge = async (files, releases = {}) => {
  const source = {
    base: path => files[path][0],
    head: path => files[path][1],
    release: async (name, version) => releases[`${name}@${version}`],
    now,
  };
  return classify(Object.keys(files).map(path => ({status: 'M', path})), source);
};
const manifest = devDependencies => JSON.stringify({name: 'example-project', private: true, scripts: {typecheck: 'tsc'}, devDependencies});
const lockEntry = (name, version, extra = {}) => ({
  version, resolved: `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`, integrity: `sha512-${name}${version}`, ...extra,
});
const npmRelease = (name, version, days, extra = {}) => ({[`${name}@${version}`]: {published: daysAgo(days), integrity: `sha512-${name}${version}`, dependencies: {}, bin: {}, ...extra}});
const lockfile = (devDependencies, packages) => JSON.stringify({
  name: 'example-project', lockfileVersion: 3, requires: true,
  packages: {'': {name: 'example-project', devDependencies}, ...Object.fromEntries(Object.entries(packages).map(([name, entry]) => [`node_modules/${name}`, entry]))},
});
const pi = '@earendil-works/pi-coding-agent';
const oldPi = {[pi]: '^0.84.3'};
const newPi = {[pi]: '^1.1.0'};
const baseLock = lockfile(oldPi, {[pi]: lockEntry(pi, '0.84.4', {dependencies: {undici: '8.9.0'}}), undici: lockEntry('undici', '8.9.0')});
const headLock = lockfile(newPi, {
  [pi]: lockEntry(pi, '1.1.0', {dependencies: {undici: '8.10.2', 'brace-expansion': '^5.0.12'}}), undici: lockEntry('undici', '8.10.2'),
  'brace-expansion': lockEntry('brace-expansion', '5.0.12'),
});
const weekOld = {
  ...npmRelease(pi, '1.1.0', 8, {dependencies: {undici: '8.10.2', 'brace-expansion': '^5.0.12'}}),
  ...npmRelease('undici', '8.10.2', 30), ...npmRelease('brace-expansion', '5.0.12', 31),
};

test('a version-only npm update to week-old registry releases merges automatically, new transitive packages included', async () => {
  const result = await judge({'package.json': [manifest(oldPi), manifest(newPi)], 'package-lock.json': [baseLock, headLock]}, weekOld);
  assert.deepEqual(result, {tier: 'auto', reasons: []});
});

test(`a release younger than ${minimumReleaseAgeDays} days, an unknown one or an implausible date escalates`, async () => {
  const young = {...weekOld, ...npmRelease(pi, '1.1.0', 3, {dependencies: {undici: '8.10.2', 'brace-expansion': '^5.0.12'}})};
  const result = await judge({'package-lock.json': [baseLock, headLock]}, young);
  assert.equal(result.tier, 'escalate');
  assert.match(result.reasons[0], /pi-coding-agent 1\.1\.0 was published 3 days ago/);
  const unknown = {...weekOld};
  delete unknown['undici@8.10.2'];
  assert.match((await judge({'package-lock.json': [baseLock, headLock]}, unknown)).reasons[0], /cannot confirm when undici 8\.10\.2/);
  const ancient = {...weekOld, 'undici@8.10.2': {...weekOld['undici@8.10.2'], published: new Date('1900-01-01T00:00:00Z')}};
  assert.match((await judge({'package-lock.json': [baseLock, headLock]}, ancient)).reasons[0], /cannot confirm when undici 8\.10\.2/);
});

test('adding or removing a direct dependency, or changing scripts or settings, escalates', async () => {
  const cases = [
    manifest({...oldPi, 'left-pad': '^1.3.0'}),
    manifest({...oldPi, constructor: '^1.0.0'}),
    manifest({}),
    JSON.stringify({...JSON.parse(manifest(oldPi)), scripts: {typecheck: 'tsc', postinstall: 'node x.js'}}),
    manifest({[pi]: 'github:someone/pi'}),
  ];
  for (const head of cases) {
    assert.equal((await judge({'package.json': [manifest(oldPi), head]}, weekOld)).tier, 'escalate', head);
  }
});

test('lockfile entries from outside the registry, aliases, links or not matching the registry release escalate', async () => {
  const variants = [
    lockEntry('undici', '8.10.2', {resolved: 'https://evil.example/undici-8.10.2.tgz'}),
    lockEntry('undici', '8.10.2', {resolved: 'git+ssh://git@github.com/someone/undici.git#abc'}),
    lockEntry('undici', '8.10.2', {integrity: undefined}),
    lockEntry('undici', '8.10.2', {integrity: 'sha512-other'}),
    lockEntry('undici', '8.10.2', {name: 'not-undici'}),
    lockEntry('undici', '8.10.2', {dependencies: {evil: '1.0.0'}}),
    {...lockEntry('undici', '8.10.2'), link: true},
  ];
  for (const entry of variants) {
    const head = lockfile(oldPi, {[pi]: lockEntry(pi, '0.84.4', {dependencies: {undici: '8.9.0'}}), undici: entry});
    assert.equal((await judge({'package-lock.json': [baseLock, head]}, weekOld)).tier, 'escalate', JSON.stringify(entry));
  }
  const workspace = JSON.stringify({...JSON.parse(baseLock), packages: {...JSON.parse(baseLock).packages, 'tools/x': lockEntry('x', '1.0.0')}});
  assert.equal((await judge({'package-lock.json': [baseLock, workspace]}, weekOld)).tier, 'escalate');
  const settings = JSON.stringify({...JSON.parse(baseLock), lockfileVersion: 2});
  assert.equal((await judge({'package-lock.json': [baseLock, settings]}, weekOld)).tier, 'escalate');
});

test('a package wired in through an existing entry, or one nothing depends on, escalates', async () => {
  // The lockfile claims pi 0.84.4 depends on evil; the registry release does not, so the edge is invented.
  const wired = lockfile(oldPi, {
    [pi]: lockEntry(pi, '0.84.4', {dependencies: {undici: '8.9.0', evil: '1.0.0'}}), undici: lockEntry('undici', '8.9.0'), evil: lockEntry('evil', '1.0.0'),
  });
  const releases = {...npmRelease(pi, '0.84.4', 60, {dependencies: {undici: '8.9.0'}}), ...npmRelease('evil', '1.0.0', 30)};
  assert.match((await judge({'package-lock.json': [baseLock, wired]}, releases)).reasons[0], /lists evil@1\.0\.0, which the registry release does not/);
  const orphan = lockfile(oldPi, {[pi]: lockEntry(pi, '0.84.4', {dependencies: {undici: '8.9.0'}}), undici: lockEntry('undici', '8.9.0'), evil: lockEntry('evil', '1.0.0')});
  assert.match((await judge({'package-lock.json': [baseLock, orphan]}, releases)).reasons[0], /evil is new and nothing depends on it/);
});

test('install scripts: a package that already ran one may move versions; a new one escalates, whatever the lockfile says', async () => {
  const withEsbuild = (version, extra) => lockfile(oldPi, {
    [pi]: lockEntry(pi, '0.84.4', {dependencies: {undici: '8.9.0', esbuild: '^0.28.0'}}), undici: lockEntry('undici', '8.9.0'), esbuild: lockEntry('esbuild', version, extra),
  });
  const releases = npmRelease('esbuild', '0.28.2', 20, {installScript: true});
  const trusted = withEsbuild('0.28.1', {hasInstallScript: true});
  assert.equal((await judge({'package-lock.json': [trusted, withEsbuild('0.28.2', {hasInstallScript: true})]}, releases)).tier, 'auto');
  const untrusted = withEsbuild('0.28.1');
  for (const head of [withEsbuild('0.28.2', {hasInstallScript: true}), withEsbuild('0.28.2')]) {
    assert.match((await judge({'package-lock.json': [untrusted, head]}, releases)).reasons[0], /esbuild 0\.28\.2 adds an install script/);
  }
});

test('a lockfile bin that is not the release\'s own, or an unknown lockfile field, escalates', async () => {
  const typescript = (extra = {}) => lockfile(oldPi, {
    [pi]: lockEntry(pi, '0.84.4', {dependencies: {undici: '8.9.0'}}), undici: lockEntry('undici', '8.9.0'),
    typescript: lockEntry('typescript', '6.0.3', {bin: {tsc: 'bin/tsc', tsserver: 'bin/tsserver'}, ...extra}),
  });
  const releases = npmRelease('typescript', '6.0.3', 40, {bin: {tsc: 'bin/tsc', tsserver: 'bin/tsserver'}});
  // Base has no typescript entry details that differ only in harmless metadata: the license changes and that is fine.
  assert.equal((await judge({'package-lock.json': [typescript(), typescript({license: 'Apache-2.0'})]}, releases)).tier, 'auto');
  const hijacked = typescript({bin: {tsc: 'bin/tsserver', tsserver: 'bin/tsserver'}});
  assert.match((await judge({'package-lock.json': [typescript(), hijacked]}, releases)).reasons[0], /typescript 6\.0\.3 bin does not match the registry/);
  const unknown = typescript({inBundle: true});
  assert.match((await judge({'package-lock.json': [typescript(), unknown]}, releases)).reasons[0], /carries lockfile fields inBundle/);
});

test('a downgrade escalates', async () => {
  const down = lockfile(oldPi, {[pi]: lockEntry(pi, '0.84.4', {dependencies: {undici: '8.9.0'}}), undici: lockEntry('undici', '8.8.0')});
  assert.match((await judge({'package-lock.json': [baseLock, down]}, npmRelease('undici', '8.8.0', 90))).reasons[0], /undici goes back from 8\.9\.0 to 8\.8\.0/);
  assert.ok(compareVersions('1.0.0-rc.2', '1.0.0-rc.10') < 0 && compareVersions('1.0.0', '1.0.0-rc.1') > 0 && compareVersions('2.0.0', '10.0.0') < 0);
});

test('a dependency update merged with a policy change still escalates, and a new manifest escalates by path', async () => {
  const source = {base: () => manifest(oldPi), head: () => manifest(newPi), release: async () => undefined, now};
  const changes = [{status: 'M', path: 'package.json'}, {status: 'M', path: 'AGENTS.md'}];
  assert.equal((await classify(changes, source)).tier, 'escalate');
  assert.equal((await classify([{status: 'A', path: 'tools/package.json'}], source)).tier, 'escalate');
});

// A made-up project with other paths, other reasons and only JavaScript tests.
const otherRules = parseRules(JSON.stringify({
  rules: [
    {tier: 'blocked', paths: ['^vendor/'], reason: 'vendored code is never edited here'},
    {tier: 'escalate', paths: ['^infra/', '(^|/)Dockerfile$'], reason: 'infrastructure'},
    {tier: 'escalate', paths: ['^spec/.+_test\\.js$'], statuses: ['D'], reason: 'deletes a test'},
    {check: 'testFiles', javascript: {files: ['^spec/.+_test\\.js$'], removedTests: true}},
    {tier: 'auto', paths: ['^lib/', '^spec/']},
  ],
  unmatchedReason: 'not in lib/ or spec/',
}));

test('another project\'s rules file tiers its own paths, and the example project\'s rules play no part', async () => {
  const other = async (source, ...changes) => classifyWith(changes.map(([status, path]) => ({status, path})), source, otherRules);
  assert.deepEqual(await other(empty, ['M', 'lib/a.py'], ['A', 'spec/a_test.js'], ['D', 'spec/helpers.js']), {tier: 'auto', reasons: []});
  assert.deepEqual(await other(empty, ['M', 'infra/main.tf'], ['A', 'lib/Dockerfile']),
    {tier: 'escalate', reasons: ['infra/main.tf: infrastructure', 'lib/Dockerfile: infrastructure']});
  assert.deepEqual(await other(empty, ['M', 'lib/a.py'], ['M', 'vendor/x.js']), {tier: 'blocked', reasons: ['vendor/x.js: vendored code is never edited here']});
  assert.deepEqual(await other(empty, ['D', 'spec/a_test.js']), {tier: 'escalate', reasons: ['spec/a_test.js: deletes a test']});
  // The example project's auto paths, agent files and build configuration are just unmatched paths here.
  for (const path of ['src/Domain/X.cs', 'AGENTS.md', 'package.json']) {
    assert.deepEqual(await other(empty, ['M', path]), {tier: 'escalate', reasons: [`${path}: not in lib/ or spec/`]}, path);
  }
  const spec = "it('a', () => {});\nit('b', () => {});\n";
  assert.deepEqual(await other({base: () => spec, head: () => "it('a', () => {});\n"}, ['M', 'spec/a_test.js']),
    {tier: 'escalate', reasons: ['spec/a_test.js: removes test cases (2 before, 1 after)']});
  // The C# checks are off: no csharp language is listed, so a .cs file under spec/ is judged by path.
  assert.deepEqual(await other({base: () => '[Fact] void A(){}', head: () => '#if NEVER\n'}, ['M', 'spec/A.cs']), {tier: 'auto', reasons: []});
});

test('a check switched off in the rules file is not applied', async () => {
  const off = parseRules(JSON.stringify({
    rules: [{check: 'testFiles', csharp: {files: ['^tests/'], removedTests: false, conditionalCompilation: false}}, {tier: 'auto', paths: ['^tests/']}],
    unmatchedReason: 'unmatched',
  }));
  const before = 'class T{\n[Fact] void A(){}\n[Fact] void B(){}\n}\n';
  const after = 'class T{\n#if NEVER\n[Fact] void A(){}\n#endif\n}\n';
  assert.deepEqual(await classifyWith([{status: 'M', path: 'tests/T.cs'}], {base: () => before, head: () => after}, off), {tier: 'auto', reasons: []});
  assert.equal((await classifyWith([{status: 'T', path: 'tests/T.cs'}], empty, off)).tier, 'escalate');
});

test('a malformed rules file, an unknown key, switch or check, or an invalid pattern is refused with the problem named', () => {
  const valid = {rules: [{tier: 'auto', paths: ['^lib/']}], unmatchedReason: 'unmatched'};
  const refused = (rulesFile, message) => assert.throws(() => parseRules(typeof rulesFile === 'string' ? rulesFile : JSON.stringify(rulesFile)), message);
  assert.doesNotThrow(() => parseRules(JSON.stringify(valid)));
  refused('{"rules": [', /is not valid JSON/);
  refused({...valid, extra: true}, /the rules file: unknown key "extra"/);
  refused({rules: valid.rules}, /the rules file: missing "unmatchedReason"/);
  refused({...valid, rules: []}, /rules: must be a non-empty array/);
  refused({...valid, rules: [{check: 'testFiles', csharp: {files: ['^t/'], removedTests: true, conditionalCompilation: true, countsTheory: true}}]},
    /rules\[0\]\.csharp: unknown key "countsTheory"/);
  refused({...valid, rules: [{check: 'testFiles', javascript: {files: ['^t/'], removedTests: true, conditionalCompilation: true}}]},
    /rules\[0\]\.javascript: unknown key "conditionalCompilation"/);
  refused({...valid, rules: [{check: 'testFiles', javascript: {files: ['^t/']}}]}, /rules\[0\]\.javascript: missing "removedTests"/);
  refused({...valid, rules: [{check: 'testFiles', javascript: {files: ['^t/'], removedTests: 'yes'}}]}, /rules\[0\]\.javascript\.removedTests: must be true or false/);
  refused({...valid, rules: [{check: 'testFiles'}]}, /rules\[0\]: names no language/);
  refused({...valid, rules: [{check: 'pythonTests'}]}, /rules\[0\]\.check: unknown check "pythonTests"/);
  refused({...valid, rules: [{tier: 'auto', paths: ['^lib/', '(unclosed']}]}, /rules\[0\]\.paths\[1\]: invalid pattern "\(unclosed"/);
  refused({...valid, rules: [{check: 'npmDependencyUpdates', manifests: ['['], lockfiles: ['x']}]}, /rules\[0\]\.manifests\[0\]: invalid pattern/);
  refused({...valid, rules: [{tier: 'escalate', paths: ['^x/']}]}, /rules\[0\]: missing "reason"/);
  refused({...valid, rules: [{tier: 'auto', paths: ['^x/'], reason: 'r'}]}, /rules\[0\]: unknown key "reason"/);
  refused({...valid, rules: [{tier: 'maybe', paths: ['^x/'], reason: 'r'}]}, /rules\[0\]\.tier: unknown tier "maybe"/);
  refused({...valid, rules: [{tier: 'escalate', paths: ['^x/'], reason: 'r', statuses: ['Z']}]}, /rules\[0\]\.statuses\[0\]: unknown git status "Z"/);
  refused({...valid, rules: [{tier: 'escalate', paths: ['^x/'], reason: 'r', statuses: ['D'], exceptStatuses: ['A']}]}, /both "statuses" and "exceptStatuses"/);
  refused({...valid, rules: [{tier: 'escalate', paths: ['^x/'], reason: 'r', ignoreCase: 1}]}, /rules\[0\]\.ignoreCase: must be true or false/);
  refused({...valid, rules: [{tier: 'auto', paths: ['^x/'], why: 3}]}, /rules\[0\]\.why: must be a non-empty string/);
});

// The engine and wrapper as they run for real: a throwaway repository whose main holds this engine and a rules file,
// and a pull-request branch on top, classified by scripts/risk-tier-base.sh against main.
const baseScript = fileURLToPath(new URL('./risk-tier-base.sh', import.meta.url));
const engine = readFileSync(new URL('./risk-tier.mjs', import.meta.url), 'utf8');
const sampleRules = JSON.stringify({rules: [{tier: 'escalate', paths: ['^tools/'], reason: 'tooling'}, {tier: 'auto', paths: ['^lib/']}],
  unmatchedReason: 'unmatched'});
// files: {path: text or null (delete)} committed on main, then on the pr branch; returns the wrapper's exit code and output.
// `env` adds to the wrapper's environment.
function tierInRepo(mainFiles, prFiles, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'risk-tier-'));
  try {
    const git = (...args) => {
      const result = spawnSync('git', args, {cwd: dir, env: gitEnv, encoding: 'utf8'});
      assert.equal(result.status, 0, result.stderr);
    };
    const commit = files => {
      for (const [path, text] of Object.entries(files)) {
        if (text === null) rmSync(join(dir, path));
        else {
          mkdirSync(dirname(join(dir, path)), {recursive: true});
          writeFileSync(join(dir, path), text);
        }
      }
      git('add', '-A');
      git('commit', '-q', '--allow-empty', '-m', 'change');
    };
    git('init', '-q', '-b', 'main');
    commit({'lib/a.txt': 'a', ...mainFiles});
    git('checkout', '-q', '-b', 'pr');
    commit(prFiles);
    const run = spawnSync('bash', [baseScript, 'main'], {cwd: dir, env: {...gitEnv, ...env}, encoding: 'utf8'});
    return {code: run.status, output: run.stdout, error: run.stderr};
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

test('the base branch\'s rules decide: a pull request that rewrites the rules or the engine keeps its tier', () => {
  const base = {'scripts/risk-tier.mjs': engine, '.triphammer/risk-tier.json': sampleRules};
  const looser = JSON.stringify({rules: [{tier: 'auto', paths: ['.*']}], unmatchedReason: 'unmatched'});
  const result = tierInRepo(base, {'.triphammer/risk-tier.json': looser, 'scripts/risk-tier.mjs': 'console.log("{}");\n', 'tools/run.sh': 'x'});
  assert.equal(result.code, 2, result.error);
  assert.deepEqual(JSON.parse(result.output), {tier: 'escalate', reasons: ['.triphammer/risk-tier.json: unmatched', 'scripts/risk-tier.mjs: unmatched', 'tools/run.sh: tooling']});
  const plain = tierInRepo(base, {'lib/b.txt': 'b'});
  assert.equal(plain.code, 0, plain.error);
  assert.deepEqual(JSON.parse(plain.output), {tier: 'auto', reasons: []});
  // A pull request that adds the rules file the base lacks still escalates.
  const added = tierInRepo({'scripts/risk-tier.mjs': engine}, {'.triphammer/risk-tier.json': looser, 'lib/b.txt': 'b'});
  assert.equal(added.code, 2, added.error);
  assert.deepEqual(JSON.parse(added.output), {tier: 'escalate', reasons: ['main has no .triphammer/risk-tier.json, so every change escalates']});
});

test('a malformed rules file on the base fails the run naming the file and the problem', () => {
  for (const [rulesFile, message] of [['{"rules": [', /main:\.triphammer\/risk-tier\.json: is not valid JSON/],
    [JSON.stringify({rules: [{tier: 'auto', paths: ['(']}], unmatchedReason: 'u'}), /main:\.triphammer\/risk-tier\.json: rules\[0\]\.paths\[0\]: invalid pattern "\("/],
    [JSON.stringify({rules: [{check: 'testFiles', javascript: {files: ['^t/'], removedTests: true, skipped: true}}], unmatchedReason: 'u'}),
      /rules\[0\]\.javascript: unknown key "skipped"/]]) {
    const result = tierInRepo({'scripts/risk-tier.mjs': engine, '.triphammer/risk-tier.json': rulesFile}, {'lib/b.txt': 'b'});
    assert.equal(result.code, 1, result.output);
    assert.match(result.error, message);
    assert.equal(result.output, '');
  }
});

test('a base without the engine escalates every change', () => {
  const result = tierInRepo({}, {'lib/b.txt': 'b'});
  assert.equal(result.code, 2, result.error);
  assert.deepEqual(JSON.parse(result.output), {tier: 'escalate', reasons: ['main has no scripts/risk-tier.mjs yet']});
});

test("called from a project, Triphammer's engine at the pinned commit classifies with the project's base rules", t => {
  // Triphammer's repository: the engine at the pinned commit, and a later commit whose engine says auto to everything.
  const triphammer = mkdtempSync(join(tmpdir(), 'risk-tier-triphammer-'));
  t.after(() => rmSync(triphammer, {recursive: true, force: true}));
  const git = (...args) => spawnSync('git', args, {cwd: triphammer, env: gitEnv, encoding: 'utf8'}).stdout.trim();
  git('init', '-q', '-b', 'main');
  mkdirSync(join(triphammer, 'scripts'));
  writeFileSync(join(triphammer, 'scripts/risk-tier.mjs'), engine);
  git('add', '-A');
  git('commit', '-q', '-m', 'engine');
  const pinned = git('rev-parse', 'HEAD');
  writeFileSync(join(triphammer, 'scripts/risk-tier.mjs'), 'console.log(JSON.stringify({tier: "auto", reasons: []}));\n');
  git('commit', '-q', '-am', 'later');

  // The project has no engine of its own; its base rules escalate tools/.
  const env = {TRIPHAMMER_CHECKOUT: triphammer, TRIPHAMMER_REF: pinned};
  const result = tierInRepo({'.triphammer/risk-tier.json': sampleRules}, {'tools/run.sh': 'x'}, env);
  assert.equal(result.code, 2, result.error);
  assert.deepEqual(JSON.parse(result.output), {tier: 'escalate', reasons: ['tools/run.sh: tooling']});
  const unknown = '0'.repeat(40);
  const missing = tierInRepo({'.triphammer/risk-tier.json': sampleRules}, {'lib/b.txt': 'b'}, {...env, TRIPHAMMER_REF: unknown});
  assert.equal(missing.code, 2, missing.error);
  assert.deepEqual(JSON.parse(missing.output), {tier: 'escalate', reasons: [`${unknown} has no scripts/risk-tier.mjs yet`]});
});
