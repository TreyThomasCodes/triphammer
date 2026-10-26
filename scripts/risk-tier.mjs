// Classifies a change by the paths it touches: "auto" may merge on green checks, "escalate" needs the owner,
// "blocked" must not merge. The project's rules are data, read from .triphammer/risk-tier.json on the base ref: an
// ordered list of rules, the first that decides a path wins, and a path no rule decides escalates. The engine never
// imports or runs code from the project; its patterns are regular expressions, and its checks are the ones below.
// Always run the BASE branch's copy (scripts/risk-tier-base.sh) so a pull request cannot reclassify itself; the rules
// come from the base ref too, so editing them in the pull request changes nothing until they merge.
// Usage: node scripts/risk-tier.mjs [base-ref]   (default origin/main)
// Exit code: 0 auto, 2 escalate, 3 blocked, 1 error (including a malformed rules file). Prints JSON {tier, reasons}.
// A base without the rules file escalates every change.
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';

export const rulesPath = '.triphammer/risk-tier.json';

// The rules file: {rules: [rule, ...], unmatchedReason}, every rule with an optional "why" (documentation only):
//   {tier: "auto"|"escalate"|"blocked", paths: [regex], ignoreCase?, statuses? | exceptStatuses?, reason}
//     decides a path that matches any of its patterns (and whose git status is, or is not, listed); an auto rule has
//     no reason. Statuses are git's one-letter codes.
//   {check: "npmDependencyUpdates", manifests: [regex], lockfiles: [regex]}
//     decides a modified manifest or lockfile: auto when it is a plain dependency update (dependencyUpdateProblems),
//     escalate with the problems otherwise.
//   {check: "testFiles", csharp?: {files, removedTests, conditionalCompilation}, javascript?: {files, removedTests}}
//     for a file of a listed language: changing its type escalates; removedTests escalates a modified file that
//     declares fewer test cases (xUnit [Fact]/[Theory] in C#, test( and it( calls in JavaScript and TypeScript);
//     conditionalCompilation escalates a C# file that gains an #if, #elif or #else line. A file that passes is left
//     to the rules after it.
const statusCodes = new Set([...'ABCDMRTUX']);
const tiers = ['auto', 'escalate', 'blocked'];

// The compiled rules, or an Error naming the first problem: invalid JSON, a missing or unknown key, a wrong type, an
// unknown check or an invalid pattern. Only "why", "ignoreCase" (false) and a status filter (none) may be left out, so
// a typo cannot quietly switch a rule or check off.
export function parseRules(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw Error(`is not valid JSON: ${error.message}`);
  }
  const fail = (where, problem) => { throw Error(`${where}: ${problem}`); };
  const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);
  const keys = (value, where, required, optional = []) => {
    if (!isObject(value)) fail(where, 'must be an object');
    for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key)) fail(where, `unknown key "${key}"`);
    for (const key of required) if (!Object.hasOwn(value, key)) fail(where, `missing "${key}"`);
  };
  const nonEmpty = (value, where) => {
    if (typeof value !== 'string' || value.trim() === '') fail(where, 'must be a non-empty string');
    return value;
  };
  const flag = (value, where) => {
    if (typeof value !== 'boolean') fail(where, 'must be true or false');
    return value;
  };
  const list = (value, where) => {
    if (!Array.isArray(value) || value.length === 0) fail(where, 'must be a non-empty array');
    return value;
  };
  const patterns = (value, where, ignoreCase = false) => list(value, where).map((source, i) => {
    nonEmpty(source, `${where}[${i}]`);
    try {
      return new RegExp(source, ignoreCase ? 'i' : '');
    } catch (error) {
      return fail(`${where}[${i}]`, `invalid pattern ${JSON.stringify(source)}: ${error.message}`);
    }
  });
  const statuses = (value, where) => new Set(list(value, where).map((code, i) => {
    if (!statusCodes.has(code)) fail(`${where}[${i}]`, `unknown git status ${JSON.stringify(code)}`);
    return code;
  }));
  keys(data, 'the rules file', ['rules', 'unmatchedReason']);
  const rules = list(data.rules, 'rules').map((rule, i) => {
    const where = `rules[${i}]`;
    if (isObject(rule) && Object.hasOwn(rule, 'check')) {
      if (rule.check === 'npmDependencyUpdates') {
        keys(rule, where, ['check', 'manifests', 'lockfiles'], ['why']);
        return {check: rule.check, manifests: patterns(rule.manifests, `${where}.manifests`), lockfiles: patterns(rule.lockfiles, `${where}.lockfiles`)};
      }
      if (rule.check === 'testFiles') {
        keys(rule, where, ['check'], ['why', 'csharp', 'javascript']);
        const languages = [];
        if (Object.hasOwn(rule, 'csharp')) {
          keys(rule.csharp, `${where}.csharp`, ['files', 'removedTests', 'conditionalCompilation']);
          languages.push({csharp: true, files: patterns(rule.csharp.files, `${where}.csharp.files`), testCase: csharpTestCase,
            removedTests: flag(rule.csharp.removedTests, `${where}.csharp.removedTests`),
            conditionalCompilation: flag(rule.csharp.conditionalCompilation, `${where}.csharp.conditionalCompilation`)});
        }
        if (Object.hasOwn(rule, 'javascript')) {
          keys(rule.javascript, `${where}.javascript`, ['files', 'removedTests']);
          languages.push({csharp: false, files: patterns(rule.javascript.files, `${where}.javascript.files`), testCase: javascriptTestCase,
            removedTests: flag(rule.javascript.removedTests, `${where}.javascript.removedTests`), conditionalCompilation: false});
        }
        if (languages.length === 0) fail(where, 'names no language (csharp, javascript)');
        return {check: rule.check, languages};
      }
      fail(`${where}.check`, `unknown check ${JSON.stringify(rule.check)} (known: npmDependencyUpdates, testFiles)`);
    }
    const auto = isObject(rule) && rule.tier === 'auto';
    keys(rule, where, auto ? ['tier', 'paths'] : ['tier', 'paths', 'reason'], ['why', 'ignoreCase', 'statuses', 'exceptStatuses']);
    if (!tiers.includes(rule.tier)) fail(`${where}.tier`, `unknown tier ${JSON.stringify(rule.tier)} (known: ${tiers.join(', ')})`);
    if (Object.hasOwn(rule, 'statuses') && Object.hasOwn(rule, 'exceptStatuses')) fail(where, 'has both "statuses" and "exceptStatuses"');
    const ignoreCase = Object.hasOwn(rule, 'ignoreCase') ? flag(rule.ignoreCase, `${where}.ignoreCase`) : false;
    return {
      tier: rule.tier,
      paths: patterns(rule.paths, `${where}.paths`, ignoreCase),
      statuses: Object.hasOwn(rule, 'statuses') ? statuses(rule.statuses, `${where}.statuses`) : undefined,
      exceptStatuses: Object.hasOwn(rule, 'exceptStatuses') ? statuses(rule.exceptStatuses, `${where}.exceptStatuses`) : new Set(),
      reason: auto ? undefined : nonEmpty(rule.reason, `${where}.reason`),
    };
  });
  for (const [i, rule] of data.rules.entries()) if (Object.hasOwn(rule, 'why')) nonEmpty(rule.why, `rules[${i}].why`);
  return {rules, unmatchedReason: nonEmpty(data.unmatchedReason, 'unmatchedReason')};
}

// Test-case declarations: C# methods attributed [Fact] or [Theory] (with arguments such as Skip), and test( or it( calls
// in JavaScript and TypeScript. Renaming or moving a test within a file keeps the count; moving it to another file
// lowers this one's. Declarations inside comments, string, regex or template literals or JSX text, or inside a C# #if
// region that may not compile, do not count (see scan and testRemovalProblem).
const csharpTestCase = /[[,]\s*(?:Xunit\.)?(?:Fact|Theory)(?:Attribute)?\s*[\](,]/g;
const javascriptTestCase = /(?<![\w.$])(?:test|it)(?:\.(?:only|skip|fixme|fail))?\s*\(/g;

// A release this new could be a hijacked publish that nobody has noticed yet; it waits, or the owner takes it.
export const minimumReleaseAgeDays = 7;
const dependencySections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const exactOrCaretVersion = /^[~^]?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
// Lockfile entry fields an update may carry: checked against the registry below, or metadata and placement flags that npm
// computes and that change nothing about what runs. Anything else (a new npm field) escalates until it is understood.
const verifiedFields = new Set(['name', 'version', 'resolved', 'integrity', 'dependencies', 'optionalDependencies', 'peerDependencies', 'bin', 'hasInstallScript']);
const harmlessFields = new Set(['license', 'engines', 'funding', 'deprecated', 'peerDependenciesMeta', 'os', 'cpu', 'libc', 'dev', 'optional', 'devOptional', 'peer']);

// A modified manifest or lockfile that only changes the versions of packages already in use, to registry releases at
// least minimumReleaseAgeDays old, returns no problems. Anything else (a new direct dependency, a script, a git or file
// source, a new install script, an alias, an unreadable file or registry) is a problem, so the change escalates.
// The lockfile is written by the pull request, so each new or changed entry is checked against the registry's record of
// that release (integrity, dependencies, install scripts), and a package new to the tree must be a dependency of one.
// NuGet updates are not judged this way: without a NuGet lockfile, transitive packages and new build targets go unchecked.
// manifest: whether the path is a package.json (otherwise a package-lock.json).
// source: {base(path), head(path), release(name, version) -> registry record | undefined, now: Date}
//   record: {published: Date, integrity, dependencies: {name: range}, bin: {command: path}, installScript}
async function dependencyUpdateProblems(path, manifest, source) {
  let base, head;
  try {
    base = source.base(path);
    head = source.head(path);
  } catch {
    return ['cannot read both versions of the file'];
  }
  const problems = [];
  const changed = [];
  let before, after;
  try {
    before = JSON.parse(base);
    after = JSON.parse(head);
  } catch {
    return ['is not valid JSON'];
  }
  if (manifest) {
    problems.push(...manifestProblems(before, after));
  } else {
    const {packages: beforePackages = {}, ...beforeRest} = before;
    const {packages: afterPackages = {}, ...afterRest} = after;
    if (!isDeepStrictEqual(beforeRest, afterRest)) problems.push('changes lockfile settings, not only packages');
    problems.push(...manifestProblems(beforePackages[''] ?? {}, afterPackages[''] ?? {}));
    const packageName = key => key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const entryDependencies = entry => ({...entry.peerDependencies, ...entry.optionalDependencies, ...entry.dependencies});
    // Packages that already ran an install script on main may move versions (the age rule covers them).
    const trustedScripts = new Set(Object.entries(beforePackages).filter(([, entry]) => entry.hasInstallScript).map(([key]) => packageName(key)));
    const knownNames = new Set(Object.keys(beforePackages).map(packageName));
    const dependedOn = new Set(Object.values(afterPackages).flatMap(entry => Object.keys(entryDependencies(entry))));
    for (const [key, entry] of Object.entries(afterPackages)) {
      if (key === '' || isDeepStrictEqual(entry, beforePackages[key])) continue;
      const name = packageName(key);
      const tarball = `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${entry.version}.tgz`;
      if (!key.startsWith('node_modules/') || entry.link) problems.push(`${key} is a workspace or linked package`);
      else if (entry.name !== undefined && entry.name !== name) problems.push(`${key} is an alias for ${entry.name}`);
      else if (entry.resolved !== tarball || !entry.integrity) problems.push(`${name} ${entry.version} is not resolved from the npm registry`);
      else if (!knownNames.has(name) && !dependedOn.has(name)) problems.push(`${name} is new and nothing depends on it`);
      else {
        const unknown = Object.keys(entry).filter(field => !verifiedFields.has(field) && !harmlessFields.has(field));
        if (unknown.length > 0) problems.push(`${name} ${entry.version} carries lockfile fields ${unknown.join(', ')}`);
        else if (beforePackages[key] && compareVersions(entry.version, beforePackages[key].version) < 0) {
          problems.push(`${name} goes back from ${beforePackages[key].version} to ${entry.version}`);
        } else changed.push({name, version: entry.version, entry, scriptsTrusted: trustedScripts.has(name), entryDependencies});
      }
    }
  }
  const releases = new Map();
  for (const {name, version, entry, scriptsTrusted, entryDependencies} of changed) {
    const id = `${name}@${version}`;
    if (!releases.has(id)) releases.set(id, await Promise.resolve().then(() => source.release(name, version)).catch(() => undefined));
    const release = releases.get(id);
    const published = release?.published;
    if (!(published instanceof Date) || Number.isNaN(published.getTime()) || published.getUTCFullYear() < 2000) {
      problems.push(`cannot confirm when ${name} ${version} was published`);
      continue;
    }
    const days = (source.now - published) / 86_400_000;
    if (days < minimumReleaseAgeDays) {
      problems.push(`${name} ${version} was published ${Math.max(0, Math.floor(days))} days ago; updates wait ${minimumReleaseAgeDays} days`);
    }
    if (entry.integrity !== release.integrity) problems.push(`${name} ${version} integrity does not match the registry`);
    const declared = release.dependencies ?? {};
    for (const [dependency, range] of Object.entries(entryDependencies(entry))) {
      if (!Object.hasOwn(declared, dependency) || declared[dependency] !== range) {
        problems.push(`${name} ${version} lists ${dependency}@${range}, which the registry release does not`);
      }
    }
    // npm links node_modules/.bin from the lockfile's bin field, so it must be the release's own.
    if (!isDeepStrictEqual(entry.bin ?? {}, release.bin)) problems.push(`${name} ${version} bin does not match the registry`);
    if ((entry.hasInstallScript || release.installScript) && !scriptsTrusted) problems.push(`${name} ${version} adds an install script`);
  }
  return problems;
}

// package.json (or the lockfile's root entry): only the version ranges of dependencies already listed may change.
function manifestProblems(before, after) {
  const problems = [];
  const rest = manifest => Object.fromEntries(Object.entries(manifest).filter(([key]) => !dependencySections.includes(key)));
  if (!isDeepStrictEqual(rest(before), rest(after))) problems.push('changes more than dependency versions (scripts, settings or metadata)');
  for (const section of dependencySections) {
    const beforeDependencies = before[section] ?? {};
    const afterDependencies = after[section] ?? {};
    const names = new Set([...Object.keys(beforeDependencies), ...Object.keys(afterDependencies)]);
    for (const name of names) {
      if (!Object.hasOwn(beforeDependencies, name)) problems.push(`adds ${section} entry ${name}`);
      else if (!Object.hasOwn(afterDependencies, name)) problems.push(`removes ${section} entry ${name}`);
      else if (beforeDependencies[name] !== afterDependencies[name] && !exactOrCaretVersion.test(afterDependencies[name])) {
        problems.push(`${name} ${afterDependencies[name]} is not a registry version range`);
      }
    }
  }
  return problems;
}

// The npm registry's record of one release, or undefined when it has none. Each package's document is fetched once.
const npmDocuments = new Map();
async function registryRelease(name, version) {
  if (!npmDocuments.has(name)) {
    npmDocuments.set(name, fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}`, {signal: AbortSignal.timeout(30_000)})
      .then(response => (response.ok ? response.json() : undefined)));
  }
  const document = await npmDocuments.get(name);
  const manifest = document?.versions?.[version];
  if (!manifest || !document.time?.[version]) return undefined;
  const scripts = manifest.scripts ?? {};
  return {
    published: new Date(document.time[version]),
    integrity: manifest.dist?.integrity,
    dependencies: {...manifest.peerDependencies, ...manifest.optionalDependencies, ...manifest.dependencies},
    bin: normalizedBin(name, manifest.bin),
    installScript: Boolean(scripts.preinstall || scripts.install || scripts.postinstall || manifest.gypfile),
  };
}

// Orders npm versions (major.minor.patch, a prerelease before its release); NaN when either is not a version.
export function compareVersions(a, b) {
  const parse = version => /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(version ?? '');
  const [x, y] = [parse(a), parse(b)];
  if (!x || !y) return Number.NaN;
  for (let part = 1; part <= 3; part++) if (+x[part] !== +y[part]) return +x[part] - +y[part];
  if (x[4] === y[4]) return 0;
  if (x[4] === undefined) return 1;
  if (y[4] === undefined) return -1;
  const [p, q] = [x[4].split('.'), y[4].split('.')];
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    if (p[i] === q[i]) continue;
    const numeric = /^\d+$/.test(p[i]) && /^\d+$/.test(q[i]);
    return numeric ? +p[i] - +q[i] : p[i] < q[i] ? -1 : 1;
  }
  return 0;
}

// Thrown where the scanner below cannot tell code from text.
class Unreadable extends Error {}
// A JavaScript / starts a regex after an operator, at the start of an expression, after one of these keywords, or after
// the ) of if, while, for (for await too) or with; after a name, a literal, a ] or any other ) it divides.
const regexAfterWords = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'default',
  'do', 'else', 'extends', 'yield', 'await']);
const regexAfterParens = new Set(['if', 'while', 'for', 'with']);

// A C# or JavaScript file read left to right as its compiler reads it: code is the text with comments, the inside of
// every string, character, regex and template literal and JSX text blanked (delimiters and line breaks kept, so blanked
// text never joins two tokens), and C# directive lines other than #if, #elif, #else and #endif blanked. Template, JSX and
// C# interpolation holes are code. Where the scanner cannot tell (an unterminated string, character, regex, template,
// comment or JSX element, an unbalanced bracket, a JavaScript / after a }, which ends a block when a regex follows and
// an object literal when it divides, or a JavaScript <!-- or -->, which outside a module can comment out the rest of
// the line), it stops: unsure is the raw text from the start of that token to the end of the
// file, and code holds none of it. JSX is read only where jsx is true; in TypeScript a < there is a generic or a type.
// Line breaks arrive as \n, but for U+2028 and U+2029 in JavaScript, which end a comment or regex and not a string.
function scan(text, {csharp, jsx: readsJsx}) {
  const lineEnd = csharp ? /\n/g : /[\n\u2028\u2029]/g;
  const endOfLine = from => {
    lineEnd.lastIndex = from;
    return lineEnd.exec(text)?.index ?? text.length;
  };
  const out = text.split('');
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '; };
  const fail = () => { throw new Unreadable(); };
  const match = pattern => { pattern.lastIndex = i; return pattern.exec(text)?.[0]; };
  // A name, keyword or number: word characters and anything outside ASCII but whitespace.
  const word = csharp ? /(?:\w|[^\s\0-\x7f])+/y : /(?:[\w$]|[^\s\0-\x7f])+/y;
  let i = 0, top = 0;
  // The $ and @ prefixes and the quotes that open a C# string at from, or null.
  const opening = /(\$*)(@?)(\$*)("+)/y;
  const stringOpener = from => {
    opening.lastIndex = from;
    return opening.exec(text);
  };

  // Code up to the end of the file or, in a hole, up to the } that closes it, where it stops.
  function code(nested) {
    const opens = [];
    let previous = 'operator', lastWord, lineStart = !nested;
    while (i < text.length) {
      if (!nested) top = i;
      const c = text[i];
      if (c === '\n') lineStart = true;
      if (/\s/.test(c)) { i++; continue; }
      if (csharp && lineStart && c === '#') { directive(); continue; }
      lineStart = false;
      if (text.startsWith('//', i)) {
        const end = endOfLine(i);
        blank(i, end);
        i = end;
        continue;
      }
      if (text.startsWith('/*', i)) {
        const end = text.indexOf('*/', i + 2);
        if (end < 0) fail();
        blank(i, end + 2);
        i = end + 2;
        continue;
      }
      const after = lastWord;
      lastWord = undefined;
      const opener = csharp && /[$@"]/.test(c) ? stringOpener(i) : null;
      if (opener) {
        // A run of three or more quotes opens a raw string, unless verbatim, where "" is an escaped quote.
        const [all, before, verbatim, between, run] = opener;
        const dollars = before.length + between.length;
        if (!verbatim && run.length >= 3) {
          i += all.length;
          raw(run.length, dollars);
        } else {
          i += all.length - run.length + 1;
          if (verbatim) doubled(dollars > 0);
          else escaped('"', dollars > 0);
        }
        previous = 'operand';
        continue;
      }
      if (c === '"' || c === "'") { i++; escaped(c, false); previous = 'operand'; continue; }
      if (!csharp && c === '`') { i++; template(); previous = 'operand'; continue; }
      if (!csharp && (text.startsWith('<!--', i) || text.startsWith('-->', i))) fail();
      if (!csharp && c === '/') {
        if (previous === 'unsure') fail();
        if (previous === 'operator') { regex(); previous = 'operand'; continue; }
      }
      if (readsJsx && c === '<' && previous === 'operator' && /[\w$>]/.test(text[i + 1] ?? '')) { jsx(); previous = 'operand'; continue; }
      if (csharp && nested && c === ':' && opens.length === 0) { format(); continue; }
      const name = match(word);
      if (name) {
        i += name.length;
        const property = text[i - name.length - 1] === '.';
        previous = !property && regexAfterWords.has(name) ? 'operator' : 'operand';
        // for await ( opens a condition as for ( does.
        if (!property) lastWord = name === 'await' && after === 'for' ? 'for' : name;
        continue;
      }
      i++;
      if ('([{'.includes(c)) {
        opens.push(c === '(' && regexAfterParens.has(after) ? 'condition' : c);
        previous = 'operator';
      } else if (')]}'.includes(c)) {
        if (opens.length === 0 && nested && c === '}') {
          i--;
          return;
        }
        const open = opens.pop();
        if (open !== {')': '(', ']': '[', '}': '{'}[c] && !(c === ')' && open === 'condition')) fail();
        previous = c === '}' ? 'unsure' : open === 'condition' ? 'operator' : 'operand';
      } else if ((c === '+' || c === '-') && text[i] === c) {
        i++;
        previous = 'operand';
      } else if (!(c === '!' && previous === 'operand' && text[i] !== '=')) {
        // A ! after an operand is TypeScript's non-null assertion, which leaves an operand.
        previous = 'operator';
      }
    }
    if (nested) fail();
  }
  // A C# directive line: #if, #elif, #else and #endif stay for withoutDisabledRegions (less any comment), others go.
  function directive() {
    const end = endOfLine(i);
    const line = text.slice(i, end);
    const comment = line.indexOf('//');
    blank(/^#\s*(?:if|elif|else|endif)\b/.test(line) ? (comment < 0 ? end : i + comment) : i, end);
    i = end;
  }
  // A hole of n braces in an interpolated string or a template, from its opening braces past its closing ones.
  function hole(n) {
    i += n;
    code(true);
    if (!text.startsWith('}'.repeat(n), i)) fail();
    i += n;
  }
  // A C# interpolation's format (after the :), which runs to the } that closes the hole.
  function format() {
    const end = text.indexOf('}', i);
    if (end < 0 || /["\n]/.test(text.slice(i, end))) fail();
    blank(i, end);
    i = end;
  }
  // A JavaScript string, a C# regular string or character literal: backslash escapes, ending at the line's end.
  function escaped(quote, holes) {
    let from = i;
    for (;;) {
      const c = text[i];
      if (c === undefined || c === '\n') fail();
      if (c === '\\') {
        if (i + 1 >= text.length) fail();
        i += 2;
      } else if (c === quote) {
        blank(from, i++);
        return;
      } else if (holes && text.startsWith('{{', i)) {
        i += 2;
      } else if (holes && c === '{') {
        blank(from, i);
        hole(1);
        from = i;
      } else i++;
    }
  }
  // A C# verbatim string (@"", $@"", @$""): a doubled quote is a quote, and it may span lines.
  function doubled(holes) {
    let from = i;
    for (;;) {
      const c = text[i];
      if (c === undefined) fail();
      if (text.startsWith('""', i) || (holes && text.startsWith('{{', i))) {
        i += 2;
      } else if (c === '"') {
        blank(from, i++);
        return;
      } else if (holes && c === '{') {
        blank(from, i);
        hole(1);
        from = i;
      } else i++;
    }
  }
  // A C# raw string opened by quotes (three or more) quotes, interpolated with that many braces when dollars is not 0.
  function raw(quotes, dollars) {
    let from = i;
    for (;;) {
      const c = text[i];
      if (c === undefined) fail();
      if (c === '"') {
        const run = match(/"+/y).length;
        if (run > quotes) fail();
        if (run === quotes) {
          blank(from, i);
          i += run;
          return;
        }
        i += run;
      } else if (dollars && c === '{') {
        const run = match(/\{+/y).length;
        if (run >= 2 * dollars) fail();
        i += run;
        if (run >= dollars) {
          i -= dollars;
          blank(from, i);
          hole(dollars);
          from = i;
        }
      } else i++;
    }
  }
  // A JavaScript template literal, from after its backtick.
  function template() {
    let from = i;
    for (;;) {
      const c = text[i];
      if (c === undefined) fail();
      if (c === '\\') {
        i += 2;
      } else if (c === '`') {
        blank(from, i++);
        return;
      } else if (text.startsWith('${', i)) {
        blank(from, i);
        i++;
        hole(1);
        from = i;
      } else i++;
    }
  }
  // A JavaScript regex literal and its flags; a / inside a [class] does not end it.
  function regex() {
    const from = ++i;
    const end = endOfLine(i);
    let inClass = false;
    for (;;) {
      const c = text[i];
      if (i >= end) fail();
      if (c === '\\') {
        if (i + 1 >= end) fail();
        i += 2;
        continue;
      }
      i++;
      if (inClass) inClass = c !== ']';
      else if (c === '[') inClass = true;
      else if (c === '/') break;
    }
    blank(from, i - 1);
  }
  // A JSX element or fragment from its <: attribute strings and text are blanked, {} holes are code. A TSX generic
  // arrow (<T,>() => ..., <T = U>() => ...) read as one does not parse, and a tag followed by extends, or an opening tag
  // followed by (, is taken for a type parameter list (<T extends U>() => ..., type F = <T>(x: T) => T), so all are
  // unsure, JSX text that starts with ( included.
  function jsx() {
    i++;
    if (text[i] === '>') {
      i++;
      children('');
      return;
    }
    const tag = match(/[\w$.:-]+/y);
    if (!tag) fail();
    i += tag.length;
    if (match(/\s+extends\b/y)) fail();
    for (;;) {
      while (/\s/.test(text[i] ?? '')) i++;
      const c = text[i];
      if (c === undefined) fail();
      if (text.startsWith('/>', i)) {
        i += 2;
        return;
      }
      if (c === '>') {
        i++;
        if (match(/\s*\(/y)) fail();
        children(tag);
        return;
      }
      if (c === '{') {
        hole(1);
        continue;
      }
      const attribute = match(/[\w$:-]+/y);
      if (!attribute) fail();
      i += attribute.length;
      while (/\s/.test(text[i] ?? '')) i++;
      if (text[i] !== '=') continue;
      i++;
      while (/\s/.test(text[i] ?? '')) i++;
      const value = text[i];
      if (value === '"' || value === "'") {
        const end = text.indexOf(value, i + 1);
        if (end < 0) fail();
        blank(i + 1, end);
        i = end + 1;
      } else if (value === '{') hole(1);
      else if (value === '<') jsx();
      else fail();
    }
  }
  // A JSX element's children, up to and past its closing tag, which must name tag ('' for a fragment). Any other
  // closing tag means the < that opened the element was not JSX, so it is unsure.
  function children(tag) {
    let from = i;
    for (;;) {
      const c = text[i];
      if (c === undefined) fail();
      if (c === '{') {
        blank(from, i);
        hole(1);
        from = i;
      } else if (c === '<') {
        blank(from, i);
        if (text[i + 1] === '/') {
          const closing = match(/<\/\s*([\w$.:-]*)\s*>/y);
          if (!closing || closing.slice(2, -1).trim() !== tag) fail();
          i += closing.length;
          return;
        }
        jsx();
        from = i;
      } else i++;
    }
  }

  try {
    code(false);
    return {code: out.join(''), unsure: ''};
  } catch (error) {
    if (!(error instanceof Unreadable)) throw error;
    blank(top, text.length);
    return {code: out.join(''), unsure: text.slice(top)};
  }
}
// C# lines that compile for certain when no preprocessor symbol is defined (the test projects define none this relies
// on). Only the literal conditions true and false are known: a branch under any other condition (#if NEVER, #if !DEBUG)
// does not count, nor does a later #elif or #else of it, since which branch compiles is then unknown. The #else of an
// #if false counts, and a nested conditional counts only inside a branch that counts.
function withoutDisabledRegions(text) {
  const branches = [];
  const active = () => branches.every(branch => branch.active);
  return text.split('\n').filter(line => {
    const directive = /^\s*#\s*(if|elif|else|endif)\b(.*)$/.exec(line);
    if (!directive) return active();
    const condition = directive[2].trim();
    const known = condition === 'true' ? true : condition === 'false' ? false : undefined;
    const branch = branches.at(-1);
    if (directive[1] === 'if') branches.push({active: known === true, decided: known !== false});
    else if (!branch) return false;
    else if (directive[1] === 'endif') branches.pop();
    else {
      // decided: an earlier branch compiled or might have, so no later branch counts for certain.
      branch.active = !branch.decided && (directive[1] === 'else' || known === true);
      branch.decided ||= directive[1] === 'else' || known !== false;
    }
    return false;
  }).join('\n');
}

// Every line break rewritten as \n, so a line comment or a directive line ends where the compiler ends it: C# breaks
// lines at CR, LF, CRLF, U+0085, U+2028 and U+2029. JavaScript breaks them at all of these but U+0085; there only CR and
// CRLF are rewritten, since a string may hold U+2028 and U+2029 (scan ends comments and regexes at them).
const csharpLines = text => text.replace(/\r\n|[\r\u0085\u2028\u2029]/g, '\n');
// The test cases a test file of the language declares in code (outside comments and literals, and in C# outside regions
// that may not compile), and those in the text the scanner cannot read.
function countTestCases(path, language, text) {
  const {csharp} = language;
  const jsx = !csharp && !/\.[mc]?ts$/i.test(path);
  const {code, unsure} = scan(csharp ? csharpLines(text) : text.replace(/\r\n?/g, '\n'), {csharp, jsx});
  const count = part => part.match(language.testCase)?.length ?? 0;
  return {code: count(csharp ? withoutDisabledRegions(code) : code), unsure: count(unsure)};
}

// The #if, #elif and #else lines of a C# file as a count per line text (trimmed, whitespace runs collapsed, `# if` read
// as `#if`), read on its raw text: a string or comment the tokenizer misreads (such as a comment marker inside an
// interpolation hole) cannot hide one. A directive inside a verbatim string also counts, which only escalates.
function conditionalDirectives(text) {
  const counts = new Map();
  for (const line of csharpLines(text).match(/^[^\S\n]*#[^\S\n]*(?:if|elif|else)\b.*$/gm) ?? []) {
    const directive = line.trim().replace(/\s+/g, ' ').replace(/^# /, '#');
    counts.set(directive, (counts.get(directive) ?? 0) + 1);
  }
  return counts;
}

// Why a C# test file escalates for adding conditional compilation, which can switch tests off in ways the count above
// may miss, or undefined when every #if/#elif/#else line on the head occurs at most as often on the base. Comparing
// the lines rather than their total keeps a head that drops one directive and adds another from passing. An added
// file has no base, so it escalates when it declares a test case anywhere in its raw text (comments and strings
// included) and has a directive.
function conditionalProblem(path, status, language, source) {
  let before, after, head;
  try {
    head = source.head(path);
    before = status === 'A' ? new Map() : conditionalDirectives(source.base(path));
    after = conditionalDirectives(head);
  } catch {
    return 'cannot read both versions to count its conditional directives';
  }
  if (status === 'A' && !csharpLines(head).match(language.testCase)) return undefined;
  const added = [...after].filter(([directive, count]) => count > (before.get(directive) ?? 0)).map(([directive]) => directive);
  return added.length ? `adds conditional compilation (added directive: ${added.join('; ')})` : undefined;
}

// Why a modified test file escalates, or undefined when it keeps at least as many test cases as on the base. Evidence
// fails closed: a declaration in text the scanner cannot read counts on the base and not on the head, so a head that
// hides one there escalates.
function testRemovalProblem(path, language, source) {
  let base, head;
  try {
    base = countTestCases(path, language, source.base(path));
    head = countTestCases(path, language, source.head(path));
  } catch {
    return 'cannot read both versions to count its test cases';
  }
  const [before, after] = [base.code + base.unsure, head.code];
  if (after >= before) return undefined;
  const unread = base.unsure || head.unsure ? ', counting those in text it cannot read on the base only' : '';
  return `removes test cases (${before} before, ${after} after${unread})`;
}

// The bin map as npm writes it to the lockfile: a string names the package's own command, and paths lose a leading ./.
function normalizedBin(name, bin) {
  const map = typeof bin === 'string' ? {[name.split('/').pop()]: bin} : bin ?? {};
  return Object.fromEntries(Object.entries(map).map(([command, path]) => [command, String(path).replace(/^(\.\/)+/, '')]));
}

// changes: [{status: 'A'|'M'|'D'|'T'|..., path}] with renames already split into a delete and an add
// (and no copy detection, so a copy is an add).
// source: how to judge dependency files and test files by content (see dependencyUpdateProblems, testRemovalProblem
// and conditionalProblem).
// rules: parseRules' result for the base's rules file.
export async function classify(changes, source, rules) {
  const reasons = [];
  let tier = 'auto';
  for (const {status, path} of changes) {
    for (const [to, why] of await judgePath(status, path, source, rules)) {
      reasons.push(`${path}: ${why}`);
      if (tiers.indexOf(to) > tiers.indexOf(tier)) tier = to;
    }
  }
  return {tier, reasons};
}

// The [tier, reason] pairs that raise one path above auto: none when it is auto. The first rule that decides wins;
// a path no rule decides escalates.
async function judgePath(status, path, source, rules) {
  const matches = patterns => patterns.some(pattern => pattern.test(path));
  for (const rule of rules.rules) {
    if (rule.check === 'npmDependencyUpdates') {
      const manifest = matches(rule.manifests);
      if (status !== 'M' || !(manifest || matches(rule.lockfiles))) continue;
      const problems = await dependencyUpdateProblems(path, manifest, source);
      return problems.length > 0 ? [['escalate', `not a plain dependency update: ${problems.join('; ')}`]] : [];
    }
    if (rule.check === 'testFiles') {
      const language = rule.languages.find(candidate => matches(candidate.files));
      if (!language) continue;
      if (status === 'T') return [['escalate', 'changes the type of a test file (for example to a symlink)']];
      const problems = [
        status === 'M' && language.removedTests ? testRemovalProblem(path, language, source) : undefined,
        ['M', 'A'].includes(status) && language.conditionalCompilation ? conditionalProblem(path, status, language, source) : undefined,
      ].filter(Boolean);
      if (problems.length > 0) return problems.map(problem => ['escalate', problem]);
      continue;
    }
    if (rule.statuses && !rule.statuses.has(status)) continue;
    if (rule.exceptStatuses.has(status) || !matches(rule.paths)) continue;
    return rule.tier === 'auto' ? [] : [[rule.tier, rule.reason]];
  }
  return [['escalate', rules.unmatchedReason]];
}

function mergeBases(base) {
  const bases = spawnSync('git', ['merge-base', '--all', base, 'HEAD'], {encoding: 'utf8'});
  if (bases.status !== 0) throw Error(bases.stderr.trim() || `git merge-base against ${base} failed`);
  return bases.stdout.trim().split('\n');
}

// bases: the merge bases of base and HEAD.
function changedFiles(base, bases) {
  // With several merge bases, base...HEAD diffs against only one of them and can disagree with the merge GitHub makes.
  if (bases.length > 1) return [{status: 'M', path: '(several merge bases with the base branch)'}];
  const diff = spawnSync('git', ['diff', '--name-status', '--no-renames', `${base}...HEAD`], {encoding: 'utf8'});
  if (diff.status !== 0) throw Error(diff.stderr.trim() || `git diff against ${base} failed`);
  return diff.stdout.split('\n').filter(Boolean).map(line => {
    const [status, path] = line.split('\t');
    return {status: status[0], path};
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const base = process.argv[2] ?? 'origin/main';
    const show = ref => path => {
      const file = spawnSync('git', ['show', `${ref}:${path}`], {encoding: 'utf8', maxBuffer: 256 * 1024 * 1024});
      if (file.status !== 0) throw Error(file.stderr.trim());
      return file.stdout;
    };
    const bases = mergeBases(base);
    const exists = spawnSync('git', ['cat-file', '-e', `${base}:${rulesPath}`]);
    let result;
    if (exists.status !== 0) {
      result = {tier: 'escalate', reasons: [`${base} has no ${rulesPath}, so every change escalates`]};
    } else {
      let rules;
      try {
        rules = parseRules(show(base)(rulesPath));
      } catch (error) {
        throw Error(`${base}:${rulesPath}: ${error.message}`);
      }
      const changes = changedFiles(base, bases);
      const source = {base: show(bases[0]), head: show('HEAD'), release: registryRelease, now: new Date()};
      result = await classify(changes, source, rules);
    }
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = {auto: 0, escalate: 2, blocked: 3}[result.tier];
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
