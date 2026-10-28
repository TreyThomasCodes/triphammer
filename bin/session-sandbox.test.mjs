import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {git, gitEnv, here} from './fixture.mjs';

// The real bwrap, which needs unprivileged user namespaces (bin/README.md, The write limit).
const userns = spawnSync('bwrap', ['--unshare-user', '--ro-bind', '/', '/', 'true']).status === 0;
const skip = userns ? false : 'bwrap is missing or cannot create a user namespace here';

// A rig outside /tmp, which the limit leaves writable: in the repository, which this test may write in a session too.
// It holds a bare origin, a main checkout cloned from it with a worktree `.worktrees/issue-1` on ticket/1, a separate
// Triphammer checkout holding this branch's session-sandbox, and a home directory with a Claude Code directory whose
// settings.json and skills are there. `inside` runs a shell command under the limit in the worktree, as the runner
// does, and returns its exit status and output.
function sandboxRig(t) {
  const root = mkdtempSync(join(here, '..', '.session-sandbox-test-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const origin = join(root, 'origin.git');
  const main = join(root, 'main');
  const triphammer = join(root, 'triphammer');
  const home = join(root, 'home');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, main);
  writeFileSync(join(main, 'tracked.txt'), 'main\n');
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'first');
  git(main, 'push', '-q', 'origin', 'HEAD:main');
  const worktree = join(main, '.worktrees/issue-1');
  git(main, 'worktree', 'add', '-q', '-b', 'ticket/1', worktree);
  mkdirSync(join(triphammer, 'bin'), {recursive: true});
  copyFileSync(join(here, 'session-sandbox'), join(triphammer, 'bin/session-sandbox'));
  git(triphammer, 'init', '-q', '-b', 'main');
  git(triphammer, 'add', '.');
  git(triphammer, 'commit', '-q', '-m', 'first');
  mkdirSync(join(home, '.claude/skills'), {recursive: true});
  writeFileSync(join(home, '.claude/settings.json'), '{}\n');
  const {TMPDIR, XDG_STATE_HOME, CLAUDE_CONFIG_DIR, TRIPHAMMER_HUMANIZER_STATE, ...env} = gitEnv;
  const inside = command => {
    const result = spawnSync(join(triphammer, 'bin/session-sandbox'), [worktree, 'sh', '-c', command],
      {cwd: worktree, env: {...env, HOME: home}, encoding: 'utf8'});
    return {status: result.status, output: result.stdout + result.stderr};
  };
  return {root, main, triphammer, home, worktree, inside};
}

const pythonWrite = path => `python3 -c "open('${path}', 'w').write('planted')"`;

test('under the limit, the main checkout, Triphammer\'s checkout and the home directory are read-only', {skip}, t => {
  const r = sandboxRig(t);
  const targets = {
    "a tracked file of the main checkout": join(r.main, 'tracked.txt'),
    "a new file in the main checkout": join(r.main, 'new.txt'),
    "a tracked file of Triphammer's checkout": join(r.triphammer, 'bin/session-sandbox'),
    'a file in the home directory': join(r.home, 'outside'),
    "Claude Code's settings.json": join(r.home, '.claude/settings.json'),
    "a file in Claude Code's skills": join(r.home, '.claude/skills/planted.md'),
  };
  for (const [what, path] of Object.entries(targets)) {
    const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
    for (const [how, command] of [['python', pythonWrite(path)], ['a shell redirect', `echo planted > '${path}'`]]) {
      const {status, output} = r.inside(command);
      assert.notEqual(status, 0, `${what} was written with ${how}`);
      assert.match(output, /Read-only file system/, `${what} with ${how}: ${output}`);
      assert.equal(existsSync(path) ? readFileSync(path, 'utf8') : null, before, `${what} changed with ${how}`);
    }
  }
  assert.equal(git(r.main, 'status', '--porcelain', '--untracked-files=no'), '');
});

test('under the limit, the worktree, its commits, /tmp and what Claude Code and the hooks write are writable', {skip}, t => {
  const r = sandboxRig(t);
  const scratch = mkdtempSync('/tmp/session-sandbox-test-');
  t.after(() => rmSync(scratch, {recursive: true, force: true}));
  const {status, output} = r.inside(`set -e
echo work > work.txt
${pythonWrite(join(r.worktree, 'script.txt'))}
git add work.txt script.txt && git commit -q -m work
echo tmp > '${scratch}/file'
mkdir -p '${r.home}/.claude/projects/p' && echo session > '${r.home}/.claude/projects/p/session.jsonl'
echo cache > '${r.home}/.cache/file'
echo ran > '${r.home}/.local/state/triphammer/humanizer/marker'
echo override >> '${r.home}/.local/state/triphammer/guard-overrides.log'`);
  assert.equal(status, 0, output);
  assert.equal(git(r.worktree, 'log', '-1', '--format=%s'), 'work');
  assert.equal(git(r.main, 'rev-parse', 'ticket/1'), git(r.worktree, 'rev-parse', 'HEAD'), "the commit is in the main checkout's .git");
  assert.equal(readFileSync(join(scratch, 'file'), 'utf8'), 'tmp\n');
  assert.equal(readFileSync(join(r.home, '.claude/projects/p/session.jsonl'), 'utf8'), 'session\n');
  assert.equal(readFileSync(join(r.home, '.local/state/triphammer/guard-overrides.log'), 'utf8'), 'override\n');
});

test('under the limit, the command cannot see or signal the processes outside', {skip}, t => {
  const r = sandboxRig(t);
  const {status, output} = r.inside(`kill -0 ${process.pid} 2>/dev/null && echo signalled; ls /proc | grep -cx '[0-9]*'`);
  assert.equal(status, 0, output);
  assert.doesNotMatch(output, /signalled/);
  assert.ok(Number(output.trim()) < 10, `the command sees ${output.trim()} processes`);
});

test('a run directory outside any git checkout runs nothing', {skip}, t => {
  const r = sandboxRig(t);
  const outside = join(r.root, 'plain');
  mkdirSync(outside);
  const result = spawnSync(join(r.triphammer, 'bin/session-sandbox'), [outside, 'sh', '-c', 'echo ran'],
    {env: {...gitEnv, HOME: r.home, GIT_CEILING_DIRECTORIES: r.root}, encoding: 'utf8'});
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /is not in a git checkout/);
});
