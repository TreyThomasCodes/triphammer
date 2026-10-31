import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile, execFileSync} from 'node:child_process';
import {appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {basename, join} from 'node:path';
import {gitEnv, gitRepo} from '../scripts/test-git-repo.mjs';
import {fakeCodex, fakeCommand, freePort, installTriphammerFiles, runClone, writeConfig} from './fixture.mjs';

const model = 'org/qwen-test:q4_k';
const key = 'example-test-key-3f9a1c';
const area = 'session review what-if pricing';
const codexModel = 'codex-audit-test';
const brief = 'You review a change you did not write.';
// A fixed clock for the Codex run counts: LOCAL_AUDIT_NOW, in epoch seconds.
const now = 1_800_000_000;
const hour = 3600;

// A local stand-in for the Qwen server that answers every request and remembers the headers it saw.
async function listen(t) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.headers);
    res.end('ok');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return {url: `http://127.0.0.1:${server.address().port}`, requests};
}

// A repository with three commits on main, a tag and a branch on the last one, so the audited middle commit has
// history after it, and the reviewer brief from its first commit on; the key in a file; the fake `claude`
// (fake-claude.mjs) and `codex` (fake-codex.mjs) first on PATH; HOME and the state directory in the test machine; and a Triphammer config
// ($TRIPHAMMER_CONFIG) whose CHECKOUT is the repository, with the qwen-audit and codex modules on and their settings,
// which `configure` (name -> value; null leaves one out) changes. A `project` (the .triphammer/project.json fields) is
// committed with the brief. local-audit runs from Triphammer's checkout, which is the repository itself (its copy kept
// out of the commits by .git/info/exclude), or with `separate` a repository of its own whose plugin's reviewer brief
// is `triphammerBrief`, so the repository is a project with a plugin copy that must not be used.
const triphammerBrief = "You review a change as Triphammer's reviewer.";
function installAudit(dir) {
  installTriphammerFiles(dir, 'local-audit', 'config.sh');
  return join(dir, 'bin/local-audit');
}
function auditSetup(t, {project, separate = false} = {}) {
  const {root, dir: repo, git, commit} = gitRepo(t, 'local-audit');
  let script;
  if (separate) {
    const triphammer = join(root, 'triphammer');
    mkdirSync(join(triphammer, 'plugins/triphammer/agents'), {recursive: true});
    writeFileSync(join(triphammer, 'plugins/triphammer/agents/reviewer.md'), `---\nname: reviewer\n---\n\n${triphammerBrief}\n`);
    script = installAudit(triphammer);
    execFileSync('git', ['init', '-q', '-b', 'main', triphammer], {env: gitEnv});
  } else {
    script = installAudit(repo);
    mkdirSync(join(repo, '.git/info'), {recursive: true});
    appendFileSync(join(repo, '.git/info/exclude'), '/tools/\n');
  }
  const reviewer = {'plugins/triphammer/agents/reviewer.md': `---\nname: reviewer\nmodel: opus\n---\n\n${brief}\n`};
  const projectFile = project ? {'.triphammer/project.json': JSON.stringify({name: 'acme', ...project})} : {};
  const commits = [commit({...reviewer, ...projectFile, 'first.txt': 'first\n'}, '-m', 'first')];
  for (const name of ['audited', 'later']) {
    commits.push(commit({[`${name}.txt`]: `${name}\n`}, '-m', name));
  }
  git('tag', 'v1');
  git('branch', 'other');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  fakeCommand(bin, 'claude', root);
  const codex = fakeCodex(root, bin, now);
  const keyFile = join(root, 'api-key');
  writeFileSync(keyFile, `${key}\n`);
  const output = join(root, 'audit.txt');
  const [first, audited, later] = commits;
  const configFile = join(root, 'triphammer.conf');
  let overrides = {};
  const configure = (more = {}) => {
    overrides = {...overrides, ...more};
    writeConfig(configFile, {REPO: 'acme/widgets', CHECKOUT: repo, APP_AUTHOR: 'app/widget-bot', STATE_DIR: join(root, 'runner'),
      MODULES: 'qwen-audit,codex', QWEN_BASE_URL: 'http://127.0.0.1:9', QWEN_KEY_FILE: keyFile, QWEN_MODEL: model,
      CODEX_AUDIT_MODEL: codexModel, ...overrides});
  };
  configure();
  return {
    root, repo, commit, script, first, audited, later, keyFile, output, configFile, configure, ...codex,
    run: (args, env = {}, file = script) => new Promise(resolve => {
      execFile(file, args, {
        cwd: root,
        env: {
          ...gitEnv, PATH: `${bin}:${process.env.PATH}`, TRIPHAMMER_CONFIG: configFile, FAKE_CLAUDE_LATER: later,
          FAKE_CODEX_LATER: later, HOME: root, XDG_STATE_HOME: join(root, 'state'), LOCAL_AUDIT_NOW: String(now),
          GH_TOKEN: 'gh-token-must-not-reach', ...env,
        },
      }, (error, stdout, stderr) => resolve({code: error ? error.code : 0, stdout, stderr}));
    }),
    audit(url, env = {}) {
      configure({QWEN_BASE_URL: url});
      return this.run(['--repo', repo, '--commit', audited, '--area', area, '--output', output], env);
    },
    codexAudit(env = {}) {
      return this.run(['--repo', repo, '--commit', audited, '--area', area, '--output', output, '--model', 'codex'], env);
    },
    claude: () => JSON.parse(readFileSync(join(root, 'claude.json'), 'utf8')),
    ran: () => existsSync(join(root, 'claude.json')),
  };
}

test('the key reaches the session only through its environment, never argv, the output or the file', async t => {
  const server = await listen(t);
  const r = auditSetup(t);
  const result = await r.audit(server.url);
  assert.equal(result.code, 0, result.stderr);
  const claude = r.claude();
  assert.equal(claude.env.ANTHROPIC_AUTH_TOKEN, key, 'read from the key file, without its trailing newline');
  assert.equal(claude.env.ANTHROPIC_API_KEY, '');
  assert.equal(claude.env.ANTHROPIC_BASE_URL, server.url);
  for (const name of ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL']) {
    assert.equal(claude.env[name], model, name);
  }
  assert.equal(claude.env.GH_TOKEN, undefined, 'the session gets no GitHub token');
  assert.equal(claude.env.TRIPHAMMER_SESSION, claude.cwd, "the agent guard's worktree-only rule covers the clone");
  assert.ok(!JSON.stringify(claude.args).includes(key), 'the key is not on the command line');
  const written = readFileSync(r.output, 'utf8');
  for (const text of [result.stdout, result.stderr, written]) assert.ok(!text.includes(key));
  assert.ok(server.requests.every(headers => !JSON.stringify(headers).includes(key)), 'the probe sends no key');
});

test('a session that prints the key has it redacted from the output file', async t => {
  const server = await listen(t);
  const r = auditSetup(t);
  const result = await r.audit(server.url, {FAKE_CLAUDE_LEAK: '1'});
  assert.equal(result.code, 0, result.stderr);
  const written = readFileSync(r.output, 'utf8');
  assert.ok(!written.includes(key));
  assert.match(written, /token: \[redacted\]/);
});

test('the session runs the reviewer on Qwen with only read-only tools', async t => {
  const server = await listen(t);
  const r = auditSetup(t);
  assert.equal((await r.audit(server.url)).code, 0);
  const {args} = r.claude();
  assert.equal(args[0], '-p');
  assert.match(args[1], new RegExp(`at commit ${r.audited}: ${area}`));
  const after = flag => args[args.indexOf(flag) + 1];
  assert.equal(after('--agent'), 'triphammer:reviewer');
  assert.equal(after('--plugin-dir'), join(r.claude().cwd, 'plugins/triphammer'), 'the plugin of the audited commit, in the clone');
  assert.equal(after('--model'), model);
  assert.equal(after('--permission-mode'), 'dontAsk');
  assert.ok(args.includes('--strict-mcp-config'));
  // The values of a variadic flag: everything up to the next flag.
  const list = flag => {
    const rest = args.slice(args.indexOf(flag) + 1);
    const end = rest.findIndex(arg => arg.startsWith('--'));
    return end < 0 ? rest : rest.slice(0, end);
  };
  assert.deepEqual(list('--tools'), ['Read', 'Grep', 'Glob', 'Bash']);
  assert.deepEqual(list('--allowedTools'), ['Read', 'Grep', 'Glob', 'Bash(git *)'], 'a commit with no project file declares no checks');
  const denied = list('--disallowedTools');
  for (const tool of ['Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'Bash(gh *)', 'Bash(git fetch *)']) {
    assert.ok(denied.includes(tool), tool);
  }
});

test('the clone holds only the audited commit and its ancestors, has no remote, is the prompt\'s scratch copy and is removed afterwards, on Qwen and on Codex', async t => {
  const server = await listen(t);
  for (const [name, audit, session, prompt] of [
    ['Qwen', r => r.audit(server.url), r => r.claude(), seen => seen.args[1]],
    ['Codex', r => r.codexAudit(), r => r.codex(), seen => seen.args.at(-1)],
  ]) {
    const r = auditSetup(t);
    assert.equal((await audit(r)).code, 0, name);
    const seen = session(r);
    assert.match(prompt(seen), /Your working directory is already a throwaway clone of the commit, removed after the audit, so it is your\nscratch copy: run checks there and make no other copy\./, name);
    assert.deepEqual(seen.revs, [r.audited, r.first], name);
    assert.deepEqual(seen.log, [r.audited, r.first], name);
    assert.equal(seen.laterExists, false, name);
    assert.deepEqual(seen.remotes, [], name);
    for (const word of area.split(' ')) assert.ok(!basename(seen.cwd).includes(word), `${name}: ${seen.cwd} names the area`);
    assert.ok(!existsSync(seen.cwd), `${name}: the clone is removed`);
  }
});

test('the output file has the commit, area, model, elapsed time and the reviewer result', async t => {
  const server = await listen(t);
  const r = auditSetup(t);
  const result = await r.audit(server.url, {FAKE_CLAUDE_STDOUT: 'Finding: wrong sign in Foo.cs:12'});
  assert.equal(result.code, 0, result.stderr);
  const written = readFileSync(r.output, 'utf8');
  assert.match(written, new RegExp(`^commit: ${r.audited}\narea: ${area}\nmodel: ${model}\nexit: 0\nelapsed: \\d+s\n\nFinding: wrong sign in Foo.cs:12\n$`));
  assert.match(result.stdout, /audited .* in \d+s; result in /);
});

test('a failed session still writes the output file and exits 1', async t => {
  const server = await listen(t);
  const r = auditSetup(t);
  const result = await r.audit(server.url, {FAKE_CLAUDE_EXIT: '4', FAKE_CLAUDE_STDOUT: 'API Error: 500'});
  assert.equal(result.code, 1);
  assert.match(result.stderr, /reviewer session failed \(exit 4\)/);
  assert.match(readFileSync(r.output, 'utf8'), /exit: 4\n[\s\S]*API Error: 500/);
});

test('a model server that does not answer exits 3 with "local model unavailable" and runs no session', async t => {
  const r = auditSetup(t);
  const url = `http://127.0.0.1:${await freePort()}`;
  const result = await r.audit(url);
  assert.equal(result.code, 3);
  assert.match(result.stdout, new RegExp(`local model unavailable at ${url}`));
  assert.equal(r.ran(), false);
  assert.equal(existsSync(r.output), false);
});

test('a missing or empty key file exits 1 naming the file and runs no session', async t => {
  const server = await listen(t);
  const r = auditSetup(t);
  const missing = join(r.root, 'no-such-key');
  r.configure({QWEN_KEY_FILE: missing});
  let result = await r.audit(server.url);
  assert.equal(result.code, 1);
  assert.match(result.stderr, new RegExp(`cannot read the Qwen API key file ${missing}`));
  writeFileSync(r.keyFile, '');
  r.configure({QWEN_KEY_FILE: r.keyFile});
  result = await r.audit(server.url);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /is empty/);
  assert.equal(r.ran(), false);
  assert.equal(server.requests.length, 0, 'nothing is probed without a key');
});

test('argument errors exit 2 with the usage, and --help exits 0', async t => {
  const r = auditSetup(t);
  const base = ['--repo', r.repo, '--commit', r.audited, '--area', area, '--output', r.output];
  for (const [args, message] of [
    [[], /--commit is required/],
    [base.filter((_, i) => i !== 4 && i !== 5), /--area is required/],
    [base.slice(0, 7), /--output needs a value/],
    [[...base, 'extra'], /unexpected argument: extra/],
    [['--repo', r.repo, '--commit', 'no-such-rev', '--area', area, '--output', r.output], /no-such-rev is not a commit/],
    [[...base.slice(0, 7), join(r.root, 'missing-dir/audit.txt')], /is not a directory/],
    [[...base, '--model', 'gpt'], /--model must be qwen or codex, not gpt/],
  ]) {
    const result = await r.run(args);
    assert.equal(result.code, 2, `${args.join(' ')}: ${result.stderr}`);
    assert.match(result.stderr, message);
  }
  assert.equal(r.ran(), false);
  const help = await r.run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /local-audit --commit <rev> --area <text> --output <file>/);
  assert.match(help.stdout, /3 the model is unavailable/);
  assert.match(help.stdout, /4 Codex was skipped/);
});

test("run from a run's clone of Triphammer's checkout, as an upkeep session runs it, it reviews under the audited commit's plugin", async t => {
  const server = await listen(t);
  const r = auditSetup(t);
  r.configure({QWEN_BASE_URL: server.url});
  const clone = join(r.root, 'run-clone');
  runClone(r.repo, r.repo, clone);
  const script = installAudit(clone);
  const result = await r.run(['--repo', r.repo, '--commit', r.audited, '--area', area, '--output', r.output], {}, script);
  assert.equal(result.code, 0, result.stderr);
  const {args, cwd} = r.claude();
  assert.equal(args[args.indexOf('--plugin-dir') + 1], join(cwd, 'plugins/triphammer'), 'the plugin of the audited commit, in the clone');
});

test("a project that is another repository is reviewed under Triphammer's plugin, with its own project file", async t => {
  const server = await listen(t);
  const r = auditSetup(t, {separate: true, project: {reviewChecklist: '.agents/skills/acme-checklist/SKILL.md'}});
  assert.equal((await r.audit(server.url)).code, 0);
  const {args, cwd} = r.claude();
  const plugin = join(r.root, 'triphammer/plugins/triphammer');
  assert.equal(args[args.indexOf('--plugin-dir') + 1], plugin, "Triphammer's plugin, not the audited commit's copy");
  assert.match(args[1], new RegExp(`Read first for the classes in ${plugin}/skills/review-checklist/SKILL\\.md and\n`
    + '\\.agents/skills/acme-checklist/SKILL\\.md\\.'));
  assert.notEqual(cwd, plugin);

  assert.equal((await r.codexAudit()).code, 0);
  const prompt = r.codex().args.at(-1);
  assert.ok(prompt.startsWith(`${triphammerBrief}\n`), prompt);
  assert.ok(!prompt.includes(brief), "the audited commit's brief is not used");
});

test("the audit prompt names the project's own checklist and review skills from the audited commit, and none when it declares none", async t => {
  const server = await listen(t);
  const named = auditSetup(t, {project: {
    reviewChecklist: '.agents/skills/acme-checklist/SKILL.md',
    reviewSkills: ['.agents/skills/acme-review/SKILL.md', '.agents/skills/acme-money/SKILL.md'],
  }});
  assert.equal((await named.audit(server.url)).code, 0);
  assert.match(named.claude().args[1], new RegExp('Read first for the classes in plugins/triphammer/skills/review-checklist/SKILL\\.md and\n'
    + '\\.agents/skills/acme-checklist/SKILL\\.md, then as \\.agents/skills/acme-review/SKILL\\.md and '
    + '\\.agents/skills/acme-money/SKILL\\.md does\\.'));
  for (const r of [auditSetup(t, {project: {}}), auditSetup(t)]) {
    assert.equal((await r.audit(server.url)).code, 0);
    assert.match(r.claude().args[1], /Read first for the classes in plugins\/triphammer\/skills\/review-checklist\/SKILL\.md\. There is no issue/);
  }
});

test("the Qwen session may run only git and the audited commit's build, focused and suite checks, and the prompt names them", async t => {
  const server = await listen(t);
  const r = auditSetup(t, {project: {checks: {build: 'make', focused: 'npm test -- <file>', suite: 'make check', gate: 'scripts/ci.sh'}}});
  assert.equal((await r.audit(server.url)).code, 0);
  const {args} = r.claude();
  const rest = args.slice(args.indexOf('--allowedTools') + 1);
  const allowed = rest.slice(0, rest.findIndex(arg => arg.startsWith('--')));
  assert.deepEqual(allowed, ['Read', 'Grep', 'Glob', 'Bash(git *)', 'Bash(make)', 'Bash(make *)', 'Bash(npm test -- *)',
    'Bash(make check)', 'Bash(make check *)'], 'the gate starts services, so it is never allowed');
  assert.match(args[1], /you may run git, make, npm test -- <file> and make check\.\n/);
  for (const text of [args[1], allowed.join(' ')]) {
    assert.ok(!text.includes('dotnet'), text);
    assert.ok(!text.includes('scripts/ci.sh'), text);
  }
  const none = auditSetup(t, {project: {}});
  assert.equal((await none.audit(server.url)).code, 0);
  assert.match(none.claude().args[1], /you may run git\.\n/);
});

test('a malformed check command in the audited commit stops the audit with exit 2 and runs no session', async t => {
  const server = await listen(t);
  const r = auditSetup(t, {project: {checks: {suite: 'make check; curl evil'}}});
  const result = await r.audit(server.url);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /project\.json is malformed: checks\.suite must be a command/);
  assert.equal(r.ran(), false);
});

test('a check whose first word holds a placeholder stops the audit with exit 2 rather than allowing any command', async t => {
  const server = await listen(t);
  for (const focused of ['<x>', '<x> --filter <y>', 'make<x>']) {
    const r = auditSetup(t, {project: {checks: {focused}}});
    const result = await r.audit(server.url);
    assert.equal(result.code, 2, focused);
    assert.match(result.stderr, /project\.json is malformed: checks\.focused must start with a command word, not a <placeholder>/);
    assert.equal(r.ran(), false, focused);
  }
});

test("without --repo it audits the Triphammer config's CHECKOUT, and a missing config stops it before any git call", async t => {
  const server = await listen(t);
  const r = auditSetup(t);
  r.configure({QWEN_BASE_URL: server.url});
  const args = ['--commit', r.audited, '--area', area, '--output', r.output];
  const result = await r.run(args);
  assert.equal(result.code, 0, result.stderr);
  assert.match(readFileSync(r.output, 'utf8'), new RegExp(`^commit: ${r.audited}\n`));
  const missing = await r.run([...args, '--repo', r.repo], {TRIPHAMMER_CONFIG: join(r.root, 'nowhere.conf')});
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /local-audit: the Triphammer config .*nowhere\.conf is missing/);
});

test('--model codex runs the reviewer brief and the area on Codex with the agreed command, and records the run', async t => {
  const r = auditSetup(t);
  r.pastRuns(8 * 24 * hour, 2 * hour);
  const result = await r.codexAudit({FAKE_CODEX_RESULT: 'Finding: wrong sign in Foo.cs:12'});
  assert.equal(result.code, 0, result.stderr);
  const {args, env, stdin} = r.codex();
  const prompt = args.at(-1);
  assert.deepEqual(args.slice(0, -1).filter(arg => !arg.startsWith('/')), [
    'exec', '-c', 'model_reasoning_effort="medium"', '--sandbox', 'workspace-write', '--ephemeral', '-m', codexModel, '--json', '-o',
  ]);
  assert.ok(prompt.startsWith(`${brief}\n`), 'the prompt starts with the reviewer brief, without its frontmatter');
  assert.ok(!prompt.includes('name: reviewer'));
  assert.match(prompt, new RegExp(`at commit ${r.audited}: ${area}`));
  assert.equal(stdin, '', 'nothing on stdin for codex to append to the prompt');
  assert.equal(env.GH_TOKEN, undefined, 'the session gets no GitHub token');
  assert.deepEqual(r.codexCalls()[0], ['login', 'status']);
  const written = readFileSync(r.output, 'utf8');
  assert.match(written, new RegExp(`^commit: ${r.audited}\narea: ${area}\nmodel: ${codexModel}\nexit: 0\nelapsed: \\d+s\n\nFinding: wrong sign in Foo.cs:12\n$`));
  assert.match(result.stdout, /audited .* in \d+s; result in /);
  assert.ok(!(result.stdout + result.stderr + written).includes('fake-account'), 'the login status output is not passed on');
  assert.deepEqual(r.runs(), [now - 2 * hour, now], 'the run is recorded and runs older than a week are dropped');
});

test('Codex at the weekly cap, by default 500, is skipped with exit 4 and runs nothing; runs older than a week do not count', async t => {
  const r = auditSetup(t);
  // 500 runs a thousand seconds apart: all in the last 7 days, and 18 in the last 5 hours, well above the floor.
  const week = Array.from({length: 500}, (_, i) => 1000 + i * 1000);
  r.pastRuns(...week);
  let result = await r.codexAudit();
  assert.equal(result.code, 4, result.stderr);
  assert.match(result.stdout, /Codex: weekly cap reached \(500 of 500 runs in the last 7 days\)/);
  assert.deepEqual(r.codexCalls(), [], 'not even codex login status');
  assert.equal(existsSync(r.output), false);
  assert.equal(r.runs().length, 500, 'a skip is not counted');

  r.pastRuns(...week.slice(1), 7 * 24 * hour + 1);
  result = await r.codexAudit();
  assert.equal(result.code, 0, result.stdout + result.stderr);
});

test('the weekly cap comes from the settings file, and the environment overrides it', async t => {
  const r = auditSetup(t);
  r.settings('# owner settings\nweekly_cap = 2\n');
  r.pastRuns(6 * hour, 12 * hour);
  let result = await r.codexAudit();
  assert.equal(result.code, 4);
  assert.match(result.stdout, /weekly cap reached \(2 of 2/);
  result = await r.codexAudit({CODEX_AUDIT_WEEKLY_CAP: '3'});
  assert.equal(result.code, 0, result.stdout + result.stderr);
});

test('Codex is skipped once the estimated 5-hour window left after another run would fall under the floor', async t => {
  const r = auditSetup(t);
  // 99 runs in the window at the default 1% each: another leaves about 0%, which the default 0% floor allows.
  const recent = Array.from({length: 99}, (_, i) => 60 + i * 60);
  r.pastRuns(...recent);
  assert.equal((await r.codexAudit()).code, 0);
  assert.equal(r.runs().length, 100);
  // 100 runs: another would leave about -1%.
  const result = await r.codexAudit();
  assert.equal(result.code, 4);
  assert.match(result.stdout, /Codex: 5-hour floor reached \(100 runs in the last 5 hours, about -1% left after another; floor 0%\)/);
  assert.equal(r.runs().length, 100);
  // Runs that left the 5-hour window no longer count.
  r.pastRuns(...Array.from({length: 100}, () => 5 * hour + 1));
  assert.equal((await r.codexAudit()).code, 0);
});

test('the floor and the per-run estimate come from the settings file or the environment', async t => {
  const r = auditSetup(t);
  r.settings('floor_percent=50\nrun_percent=20\n');
  r.pastRuns(60, 120);
  let result = await r.codexAudit();
  assert.equal(result.code, 4);
  assert.match(result.stdout, /about 40% left after another; floor 50%/);
  result = await r.codexAudit({CODEX_AUDIT_FLOOR_PERCENT: '40'});
  assert.equal(result.code, 0, result.stdout + result.stderr);
});

test('a malformed or unknown setting exits 2 and runs nothing', async t => {
  const r = auditSetup(t);
  r.settings('weekly_cap=lots\n');
  let result = await r.codexAudit();
  assert.equal(result.code, 2);
  assert.match(result.stderr, /invalid Codex setting weekly_cap=lots/);
  r.settings('weekly_limit=3\n');
  result = await r.codexAudit();
  assert.equal(result.code, 2);
  assert.match(result.stderr, /unknown Codex setting weekly_limit/);
  result = await r.codexAudit({CODEX_AUDIT_FLOOR_PERCENT: '101'});
  assert.equal(result.code, 2);
  assert.deepEqual(r.codexCalls(), []);
});

test('a Codex limit with a leading zero, which bash arithmetic reads as octal, exits 2 and runs nothing', async t => {
  const r = auditSetup(t);
  r.configure({CODEX_RUN_PERCENT: '08'});
  let result = await r.codexAudit();
  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /CODEX_RUN_PERCENT must be a whole number from 0 to 100, not 08/);
  r.configure({CODEX_RUN_PERCENT: null});
  r.settings('run_percent=08\n');
  result = await r.codexAudit();
  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /invalid Codex setting run_percent=08/);
  r.settings('');
  result = await r.codexAudit({CODEX_AUDIT_FLOOR_PERCENT: '09'});
  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /invalid Codex setting floor_percent=09/);
  assert.deepEqual(r.codexCalls(), []);
  assert.deepEqual(r.runs(), []);
  result = await r.codexAudit({CODEX_AUDIT_FLOOR_PERCENT: '0'});
  assert.equal(result.code, 0, 'a bare 0 is still a limit');
});

test('a usage-limit error from Codex is skipped with exit 4 as "Codex: usage limit" and writes no audit', async t => {
  const r = auditSetup(t);
  const result = await r.codexAudit({FAKE_CODEX_MODE: 'usage'});
  assert.equal(result.code, 4, result.stderr);
  assert.match(result.stdout, /Codex: usage limit \(You've hit your usage limit/);
  assert.equal(existsSync(r.output), false);
  assert.deepEqual(r.runs(), [now], 'the attempt counts toward the limits');
});

test('Codex not logged in is "Codex unavailable" with exit 3 and runs no session', async t => {
  const r = auditSetup(t);
  const result = await r.codexAudit({FAKE_CODEX_LOGIN_EXIT: '1'});
  assert.equal(result.code, 3);
  assert.match(result.stdout, /Codex unavailable: not logged in/);
  assert.ok(!(result.stdout + result.stderr).includes('fake-account'));
  assert.equal(r.codexRan(), false);
  assert.equal(existsSync(r.output), false);
  assert.deepEqual(r.runs(), []);
});

test('a sandbox failure is "Codex unavailable", never an empty clean audit', async t => {
  const r = auditSetup(t);
  const result = await r.codexAudit({FAKE_CODEX_MODE: 'sandbox'});
  assert.equal(result.code, 3);
  assert.match(result.stdout, /Codex unavailable: sandbox failure \(bwrap: loopback/);
  assert.equal(existsSync(r.output), false);
});

test('a session where no command succeeded or with an empty result file is "Codex unavailable"', async t => {
  const r = auditSetup(t);
  let result = await r.codexAudit({FAKE_CODEX_MODE: 'empty'});
  assert.equal(result.code, 3);
  assert.match(result.stdout, /Codex unavailable: no result/);
  result = await r.codexAudit({FAKE_CODEX_MODE: 'hang', LOCAL_AUDIT_TIMEOUT: '1'});
  assert.equal(result.code, 3);
  assert.match(result.stdout, /Codex unavailable: timeout after 1/);
  assert.equal(existsSync(r.output), false);
});

test('a Codex session that fails otherwise writes the output file and exits 1', async t => {
  const r = auditSetup(t);
  const result = await r.codexAudit({FAKE_CODEX_MODE: 'fail'});
  assert.equal(result.code, 1);
  assert.match(result.stderr, /reviewer session failed \(exit 1\)/);
  assert.match(readFileSync(r.output, 'utf8'), new RegExp(`model: ${codexModel}\nexit: 1\n[\\s\\S]*stream disconnected`));
});

test('a commit without the reviewer brief exits 1 before Codex runs', async t => {
  const r = auditSetup(t);
  r.commit({'plugins/triphammer/agents/reviewer.md': null}, '-m', 'no brief');
  const result = await r.run(['--repo', r.repo, '--commit', 'HEAD', '--area', area, '--output', r.output, '--model', 'codex']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /no reviewer brief/);
  assert.equal(r.codexRan(), false);
  assert.deepEqual(r.runs(), []);
});

// The Codex options bin/security-review uses: another model, a brief file, a read-only sandbox and a weight.

test('--codex-model, --brief and --sandbox read-only run the brief and the area, without the reviewer brief', async t => {
  const r = auditSetup(t);
  const briefFile = join(r.root, 'security-brief.md');
  writeFileSync(briefFile, 'Review Triphammer for security.\n');
  const result = await r.run(['--repo', r.repo, '--commit', r.audited, '--area', area, '--output', r.output, '--model', 'codex',
    '--codex-model', 'codex-security-test-latest', '--brief', briefFile, '--sandbox', 'read-only']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const {args} = r.codex();
  assert.deepEqual(args.slice(0, -1).filter(arg => !arg.startsWith('/')), [
    'exec', '-c', 'model_reasoning_effort="medium"', '--sandbox', 'read-only', '--ephemeral', '-m', 'codex-security-test-latest', '--json', '-o',
  ]);
  assert.equal(args.at(-1), `Review Triphammer for security.\n\nThe area, at commit ${r.audited}: ${area}`);
  assert.match(readFileSync(r.output, 'utf8'), /^commit: .*\narea: .*\nmodel: codex-security-test-latest\n/);
});

test('a run of weight 4 records four runs, and is skipped when the cap or the floor leaves room for fewer', async t => {
  const r = auditSetup(t);
  const weighted = (env = {}) => r.run(['--repo', r.repo, '--commit', r.audited, '--area', area, '--output', r.output,
    '--model', 'codex', '--weight', '4'], env);
  r.configure({CODEX_WEEKLY_CAP: '25', CODEX_FLOOR_PERCENT: '10', CODEX_RUN_PERCENT: '5'});
  r.pastRuns(...Array.from({length: 21}, (_, i) => 6 * hour + i * 6 * hour));
  let result = await weighted();
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(r.runs().filter(time => time === now).length, 4);
  assert.equal(r.runs().length, 25);

  r.pastRuns(...Array.from({length: 22}, (_, i) => 6 * hour + i * 6 * hour));
  result = await weighted();
  assert.equal(result.code, 4);
  assert.match(result.stdout, /Codex: weekly cap reached \(22 of 25 runs in the last 7 days; this run counts as 4\)/);
  assert.equal(r.runs().length, 22, 'a skip is not counted');

  // 15 runs in the window at 5% each: 4 more would leave about 5%, under the 10% floor.
  r.pastRuns(...Array.from({length: 15}, (_, i) => 60 + i * 60));
  result = await weighted();
  assert.equal(result.code, 4);
  assert.match(result.stdout, /5-hour floor reached \(15 runs in the last 5 hours, about 5% left after another; floor 10%; this run counts as 4\)/);
  assert.equal(r.codexRan(), true, 'only the first run reached codex exec');
  assert.equal(r.codexCalls().filter(call => call[0] === 'exec').length, 1);
});

test('the Codex options are refused without --model codex or with a bad value', async t => {
  const r = auditSetup(t);
  const base = ['--repo', r.repo, '--commit', r.audited, '--area', area, '--output', r.output];
  for (const [args, message] of [
    [[...base, '--sandbox', 'read-only'], /--sandbox only with --model codex/],
    [[...base, '--weight', '4', '--codex-model', 'x'], /--weight --codex-model only with --model codex/],
    [[...base, '--model', 'codex', '--sandbox', 'danger-full-access'], /--sandbox must be read-only or workspace-write/],
    [[...base, '--model', 'codex', '--weight', '0'], /--weight must be 1 to 99/],
    [[...base, '--model', 'codex', '--codex-model', 'gpt 6; rm'], /--codex-model must be a model name/],
    [[...base, '--model', 'codex', '--brief', join(r.root, 'missing.md')], /the brief .* is missing or empty/],
  ]) {
    const result = await r.run(args);
    assert.equal(result.code, 2, `${args.join(' ')}: ${result.stderr}`);
    assert.match(result.stderr, message);
  }
  assert.deepEqual(r.codexCalls(), []);
});

// The Triphammer config's qwen-audit and codex modules (bin/README.md, "Configuration").

test('the Qwen server, key file and model come from the Triphammer config', async t => {
  const server = await listen(t);
  const r = auditSetup(t);
  const otherKey = join(r.root, 'other-key');
  writeFileSync(otherKey, 'other-test-key\n');
  r.configure({QWEN_KEY_FILE: otherKey, QWEN_MODEL: 'another-qwen'});
  const result = await r.audit(server.url);
  assert.equal(result.code, 0, result.stderr);
  const {args, env} = r.claude();
  assert.equal(args[args.indexOf('--model') + 1], 'another-qwen');
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'another-qwen');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'other-test-key');
  assert.equal(env.ANTHROPIC_BASE_URL, server.url);
  assert.ok(server.requests.length > 0, 'the configured server was probed');
});

test('a model whose module is off exits 2 naming the module and the file, and runs nothing', async t => {
  const server = await listen(t);
  for (const [modules, run, module] of [
    [null, r => r.audit(server.url), 'qwen-audit'],
    ['codex', r => r.audit(server.url), 'qwen-audit'],
    ['demo,qwen-audit', r => r.codexAudit(), 'codex'],
  ]) {
    const r = auditSetup(t);
    r.configure({MODULES: modules});
    const result = await run(r);
    assert.equal(result.code, 2, `${module}: ${result.stdout}${result.stderr}`);
    assert.equal(result.stderr.trim(), `local-audit: the ${module} module is off; add it to MODULES in ${r.configFile} (bin/README.md)`);
    assert.equal(r.ran(), false);
    assert.deepEqual(r.codexCalls(), []);
    assert.equal(existsSync(r.output), false);
  }
  assert.equal(server.requests.length, 0, 'nothing is probed');
});

test('a module that is on without a setting it needs exits 2 naming the setting, and runs nothing', async t => {
  const server = await listen(t);
  for (const [setting, run] of [
    ['QWEN_BASE_URL', r => r.run(['--repo', r.repo, '--commit', r.audited, '--area', area, '--output', r.output])],
    ['QWEN_KEY_FILE', r => r.audit(server.url)],
    ['QWEN_MODEL', r => r.audit(server.url)],
    ['CODEX_AUDIT_MODEL', r => r.codexAudit()],
  ]) {
    const r = auditSetup(t);
    r.configure({[setting]: null});
    const result = await run(r);
    assert.equal(result.code, 2, `${setting}: ${result.stdout}${result.stderr}`);
    const module = setting.startsWith('QWEN') ? 'qwen-audit' : 'codex';
    const hint = module === 'codex' ? '; triphammer update writes its default' : '';
    assert.equal(result.stderr.trim(), `local-audit: ${r.configFile}: the ${module} module needs ${setting}${hint}`);
    assert.equal(r.ran(), false);
    assert.deepEqual(r.codexCalls(), []);
  }
  assert.equal(server.requests.length, 0, 'nothing is probed');
});

test('--codex-model needs no CODEX_AUDIT_MODEL, but still needs the codex module', async t => {
  const r = auditSetup(t);
  r.configure({CODEX_AUDIT_MODEL: null});
  const args = ['--repo', r.repo, '--commit', r.audited, '--area', area, '--output', r.output, '--model', 'codex', '--codex-model', 'codex-other'];
  const result = await r.run(args);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(r.codex().args[r.codex().args.indexOf('-m') + 1], 'codex-other');
  r.configure({MODULES: 'qwen-audit'});
  const off = await r.run(args);
  assert.equal(off.code, 2);
  assert.match(off.stderr, /the codex module is off/);
});

test("the Codex limits come from the Triphammer config, under the settings file and the environment", async t => {
  const r = auditSetup(t);
  r.configure({CODEX_WEEKLY_CAP: '2', CODEX_FLOOR_PERCENT: '50', CODEX_RUN_PERCENT: '20'});
  r.pastRuns(60, 120);
  let result = await r.codexAudit();
  assert.equal(result.code, 4);
  assert.match(result.stdout, /weekly cap reached \(2 of 2/);
  r.settings('weekly_cap=3\n');
  result = await r.codexAudit();
  assert.equal(result.code, 4, 'the settings file lifts the cap, and the config floor applies');
  assert.match(result.stdout, /about 40% left after another; floor 50%/);
  result = await r.codexAudit({CODEX_AUDIT_FLOOR_PERCENT: '40'});
  assert.equal(result.code, 0, result.stdout + result.stderr);
});
