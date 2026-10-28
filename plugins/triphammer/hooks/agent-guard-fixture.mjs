// Shared by the agent-guard tests (agent-guard-*.test.mjs).
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Feeds agent-guard.py the PreToolUse JSON Claude Code sends for a Bash call (or a Write, Edit or NotebookEdit) and
// returns its decision: the deny reason, or null when it lets the call through.
export const guard = join(import.meta.dirname, 'agent-guard.py');
export const python = spawnSync('python3', ['-I', '-c', 'import sys; print(sys.executable)'], {encoding: 'utf8'})
  .stdout.trim();
// Whether these tests run inside a Triphammer session, whose $TRIPHAMMER_SESSION every hook they start inherits.
export const inTriphammerSession = Boolean(process.env.TRIPHAMMER_SESSION);

export function run(input, {env = process.env} = {}) {
  const started = Date.now();
  const result = spawnSync(python, ['-I', guard], {input, encoding: 'utf8', env, timeout: 15000});
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.equal(result.stderr, '');
  assert.ok(Date.now() - started < 5000, 'the hook must finish well inside its 10-second timeout');
  if (result.stdout === '') return null;
  const output = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(output.hookEventName, 'PreToolUse');
  assert.equal(output.permissionDecision, 'deny');
  return output.permissionDecisionReason;
}

export const decide = (command, cwd, options) =>
  run(JSON.stringify({session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: {command, description: 'test'}, cwd}), options);

// The tool_input each file tool sends for a path.
export const fileInputs = {
  Write: path => ({file_path: path, content: 'x\n'}),
  Edit: path => ({file_path: path, old_string: 'a', new_string: 'b'}),
  NotebookEdit: path => ({notebook_path: path, new_source: 'x', cell_id: 'c1'}),
};
export const decideFile = (tool, path, cwd, options) =>
  run(JSON.stringify({session_id: 's1', hook_event_name: 'PreToolUse', tool_name: tool,
    tool_input: fileInputs[tool](path), cwd}), options);

export function runGit(...args) {
  const result = spawnSync('git', args, {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
}

// A throwaway repository with tracked files under src/, tests/ and docs/, an untracked src/ file and a scratch
// directory outside it that also has a src/. Its .triphammer/project.json is `contract` (by default one whose
// shell-edit roots are src and tests), or there is none when `contract` is null.
export function repo(t, {contract = {name: 'sample', shellEditRoots: ['src', 'tests']}} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agent-guard-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const dir = join(root, 'repo');
  for (const path of ['src/App', 'tests/App.Tests', 'docs', '.triphammer', join('..', 'scratch', 'src')]) {
    mkdirSync(join(dir, path), {recursive: true});
  }
  if (contract !== null) {
    writeFileSync(join(dir, '.triphammer/project.json'),
      typeof contract === 'string' ? contract : JSON.stringify(contract));
  }
  writeFileSync(join(dir, 'src/x.cs'), 'class X {}\n');
  writeFileSync(join(dir, 'src/App/Y.cs'), 'class Y {}\n');
  writeFileSync(join(dir, 'tests/App.Tests/X.cs'), 'class XTests {}\n');
  writeFileSync(join(dir, 'docs/notes.md'), 'notes\n');
  runGit('-C', dir, 'init', '-q');
  runGit('-C', dir, 'add', '.');
  writeFileSync(join(dir, 'src/untracked.cs'), 'class U {}\n');
  writeFileSync(join(root, 'scratch', 'src', 'x.cs'), 'class S {}\n');
  return {dir, scratch: join(root, 'scratch')};
}

export const pyEdit = path => `python3 - <<'PY'
from pathlib import Path
p = Path("${path}")
p.write_text(p.read_text().replace("X", "Z"))
PY`;
export const editsOf = path => [
  `sed -i 's/X/Z/' ${path}`,
  `cat > ${path} <<EOF\nclass Z {}\nEOF`,
  pyEdit(path),
];

export function assertShellEditDenied(reason, file) {
  assert.ok(reason, 'expected a deny');
  assert.match(reason, /shell-edit rule/);
  assert.ok(reason.includes(file), reason);
  assert.match(reason, /Edit \(or Write/);
  assert.match(reason, /diagnostics/);
  assert.match(reason, /# guard-override: <reason>/);
}

// The variables that move Triphammer's directories or name a run's proposals file, which each rig below removes.
const triphammerVariables = ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'TRIPHAMMER_SHARED_DIR', 'TRIPHAMMER_PROPOSALS'];

// Changes to Triphammer's persistence. Each test runs the hook with a throwaway HOME and none of the variables that move
// Triphammer's directories, so nothing depends on the real home directory; machineHome sets those it is given.
export function machineHome(t, vars = {}) {
  const home = mkdtempSync(join(tmpdir(), 'agent-guard-home-'));
  t.after(() => rmSync(home, {recursive: true, force: true}));
  const env = {...process.env, HOME: home};
  for (const name of triphammerVariables) delete env[name];
  Object.assign(env, vars);
  return {home, env, cwd: home};
}

// A Triphammer config may move the ticket runner's state directory anywhere.
export function configuredSetup(t, conf) {
  const elsewhere = mkdtempSync(join(tmpdir(), 'agent-guard-conf-'));
  t.after(() => rmSync(elsewhere, {recursive: true, force: true}));
  const config = join(elsewhere, 'config');
  mkdirSync(join(config, 'triphammer'), {recursive: true});
  const state = join(elsewhere, 'state', 'ticket-runner');
  if (conf !== null) writeFileSync(join(config, 'triphammer', 'p.conf'), conf(state));
  return {...machineHome(t, {XDG_CONFIG_HOME: config}), state};
}

export const validConf = state =>
  `# example-project\nREPO=owner/name\nCHECKOUT=/opt/checkout\nAPP_AUTHOR=app/agents\nSTATE_DIR=${state}\n`;

export const fileTools = Object.keys(fileInputs);

// Sessions Triphammer started ($TRIPHAMMER_SESSION names the run's worktree) write only inside that worktree and
// the temporary directories. The temporary directories are always allowed, so each fixture lives under the
// repository's ignored artifacts/ instead: a main checkout with the run's worktree in .worktrees, a HOME, a $TMPDIR
// and a directory elsewhere. A repository that itself lies under a temporary directory cannot hold one.
export const sandboxRoot = join(import.meta.dirname, '..', '..', '..', 'artifacts');
export const sandboxInTemp = ['/tmp', '/var/tmp', tmpdir()].some(dir => {
  const real = realpathSync(dir);
  const root = realpathSync(join(import.meta.dirname, '..', '..', '..'));
  return root === real || root.startsWith(`${real}/`);
});

export function triphammerSession(t, marker) {
  if (sandboxInTemp) {
    t.skip('the repository lies under a temporary directory, which a Triphammer session may always write');
    return null;
  }
  mkdirSync(sandboxRoot, {recursive: true});
  const base = realpathSync(mkdtempSync(join(sandboxRoot, 'agent-guard-')));
  t.after(() => rmSync(base, {recursive: true, force: true}));
  const checkout = join(base, 'checkout');
  const worktree = join(checkout, '.worktrees', 'issue-7');
  const home = join(base, 'home');
  const temp = join(base, 'tmp');
  const elsewhere = join(base, 'elsewhere');
  for (const dir of [join(worktree, 'src'), join(checkout, '.git', 'worktrees', 'issue-7'), join(checkout, 'bin'),
    join(home, '.ssh'), join(home, '.claude'), temp, elsewhere]) {
    mkdirSync(dir, {recursive: true});
  }
  writeFileSync(join(worktree, '.git'), `gitdir: ${join(checkout, '.git', 'worktrees', 'issue-7')}\n`);
  writeFileSync(join(worktree, 'src/x.cs'), 'class X {}\n');
  writeFileSync(join(home, '.bashrc'), '# bashrc\n');
  const env = {...process.env, HOME: home, TMPDIR: temp, TRIPHAMMER_SESSION: marker ?? worktree};
  for (const name of triphammerVariables) delete env[name];
  return {base, checkout, worktree, home, temp, elsewhere, env};
}

export function assertOutsideDenied(reason, what, {file = false} = {}) {
  assert.ok(reason, `expected a deny: ${what}`);
  assert.match(reason, /worktree-only rule/, what);
  assert.match(reason, /\$TMPDIR, \/tmp and \/var\/tmp/, what);
  if (file) assert.match(reason, /a file tool has no override/, what);
  else assert.match(reason, /# guard-override: <reason>/, what);
}

// A deny by the named rule that a command's `# guard-override:` lets through.
export function assertRuleDenied(reason, rule, what) {
  assert.ok(reason, `expected a deny: ${what}`);
  assert.match(reason, new RegExp(`${rule} rule`), what);
  assert.match(reason, /# guard-override: <reason>/, what);
}

// Places outside the session's worktree and temporary directories, relative to a triphammerSession.
export const outsidePlaces = s => [
  join(s.home, '.bashrc'), join(s.home, '.profile'), join(s.home, '.claude/settings.json'),
  join(s.home, '.ssh/authorized_keys'), join(s.home, '.config/autostart/x.desktop'), join(s.checkout, 'README.md'),
  join(s.checkout, 'bin/new-script'), join(s.checkout, '.git/config'),
  join(s.checkout, '.git/worktrees/issue-7/config'), join(s.worktree, '.git'), join(s.elsewhere, 'x', 'y'),
  join(s.worktree, '..', 'issue-8', 'x'),
];

// Each shell writer, aimed at a target (outside or inside); the targets it names are the ones checked.
export const shellWriters = target => [
  `echo x > ${target}`, `echo x >> ${target}`, `echo x &> ${target}`, `echo x | tee -a ${target}`,
  `cp src/x.cs ${target}`, `mv src/x.cs ${target}`, `ln -s src/x.cs ${target}`, `ln -sf src/x.cs ${target}`,
  `install -m 755 src/x.cs ${target}`, `rm -f ${target}`, `rm -rf ${target}`, `chmod +x ${target}`,
  `chown "$USER" ${target}`, `touch ${target}`, `mkdir -p ${target}`, `sed -i 's/a/b/' ${target}`,
  `sed -i -e 's/a/b/' ${target}`, `truncate -s 0 ${target}`,
];
