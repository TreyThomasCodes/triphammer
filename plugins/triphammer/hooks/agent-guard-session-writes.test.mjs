// agent-guard.py: The worktree-only and scheduler rules of a Triphammer session.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {
  guard, python, run, decide, fileInputs, decideFile, fileTools, triphammerSession, assertOutsideDenied,
  assertRuleDenied, assertNotLifted, outsidePlaces, shellWriters,
} from './agent-guard-fixture.mjs';

test('in a Triphammer session a file tool writing outside its worktree and temporary directories is refused', t => {
  const s = triphammerSession(t);
  if (!s) return;
  for (const tool of fileTools) {
    for (const path of outsidePlaces(s)) {
      assertOutsideDenied(decideFile(tool, path, s.worktree, {env: s.env}), `${tool} ${path}`, {file: true});
    }
    assertOutsideDenied(decideFile(tool, '../../README.md', s.worktree, {env: s.env}), `${tool} relative`,
      {file: true});
  }
});

test('in a Triphammer session a file tool writes inside its worktree, $TMPDIR, /tmp and /var/tmp', t => {
  const s = triphammerSession(t);
  if (!s) return;
  for (const tool of fileTools) {
    for (const path of [join(s.worktree, 'src/x.cs'), join(s.worktree, 'src/new/dir/File.cs'), 'docs/notes.md',
      join(s.temp, 'scratch.md'), '/tmp/agent-guard-x/y', '/var/tmp/agent-guard-x', s.worktree]) {
      assert.equal(decideFile(tool, path, s.worktree, {env: s.env}), null, `${tool} ${path}`);
    }
  }
});

test('in a Triphammer session a path whose real path lies outside, through a symlink, is refused', t => {
  const s = triphammerSession(t);
  if (!s) return;
  symlinkSync(s.home, join(s.worktree, 'home'));
  symlinkSync(join(s.home, '.bashrc'), join(s.worktree, 'rc'));
  for (const tool of fileTools) {
    for (const path of [join(s.worktree, 'home/.bashrc'), join(s.worktree, 'home/new/file'), join(s.worktree, 'rc')]) {
      assertOutsideDenied(decideFile(tool, path, s.worktree, {env: s.env}), `${tool} ${path}`, {file: true});
    }
  }
  for (const command of ['echo x > home/.bashrc', 'echo x >> rc', 'cp src/x.cs home/.profile', `sed -i 's/a/b/' rc`]) {
    assertOutsideDenied(decide(command, s.worktree, {env: s.env}), command);
  }
  // Removing the link removes only the link, which lies in the worktree.
  assert.equal(decide('rm rc', s.worktree, {env: s.env}), null);
});

test('in a Triphammer session a plain shell write outside its worktree and temporary directories is refused, not naming the override',
  t => {
    const s = triphammerSession(t);
    if (!s) return;
    for (const target of outsidePlaces(s)) {
      for (const command of shellWriters(target)) {
        assertOutsideDenied(decide(command, s.worktree, {env: s.env}), command);
      }
    }
    for (const command of ['echo x > ~/.bashrc', 'echo x >> "$HOME/.profile"', 'mv ~/.ssh/config src/',
      'mv src/x.cs ../../elsewhere.cs', 'rm -rf ../../tools', 'cp -t ~ src/x.cs', 'sudo rm ~/.bashrc']) {
      assertOutsideDenied(decide(command, s.worktree, {env: s.env}), command);
    }
  });

test('in a Triphammer session a shell write inside its worktree, $TMPDIR, /tmp, /var/tmp or a device is allowed', t => {
  const s = triphammerSession(t);
  if (!s) return;
  for (const target of ['src/y.cs', join(s.worktree, 'artifacts/run/log.txt'), join(s.temp, 'out'),
    '/tmp/agent-guard-out', '/var/tmp/agent-guard-out']) {
    for (const command of shellWriters(target)) {
      assert.equal(decide(command, s.worktree, {env: s.env}), null, command);
    }
  }
  for (const command of ['dotnet build Example.slnx 2>&1 | tail -5', 'npm ci > /dev/null', 'npx playwright test',
    'git commit -q -m "Fix the thing" 2>/dev/null', 'git fetch origin', `cp ${join(s.home, '.bashrc')} src/`,
    'cat ~/.bashrc', 'echo x >&2', 'echo x | tee /dev/stderr', 'ln -s ../src/x.cs src/rc-link',
    'rm -rf src/new && mkdir -p src/new']) {
    assert.equal(decide(command, s.worktree, {env: s.env}), null, command);
  }
});

test('in a Triphammer session a computed path, and a relative path after a cd, are left to the write limit', t => {
  const s = triphammerSession(t);
  if (!s) return;
  for (const command of ['echo x > "$dir/x"', 'd=~; echo x >> $d/.bashrc', 'rm "$(echo ~)/.bashrc"',
    'cd .. && touch issue-8/x && echo x > issue-8/y', 'cd ~ && rm .bashrc']) {
    assert.equal(decide(command, s.worktree, {env: s.env}), null, command);
  }
});

test('in a Triphammer session crontab other than -l, at, batch and systemd-run are refused', t => {
  const s = triphammerSession(t);
  if (!s) return;
  for (const command of ['crontab -e', 'crontab -r', 'echo "* * * * * x" | crontab -', 'echo x | at now + 1 minute',
    'echo x | batch', 'systemd-run --user --on-calendar=hourly x']) {
    const reason = decide(command, s.worktree, {env: s.env});
    assertRuleDenied(reason, 'scheduler', command);
    assert.match(reason, /Run the command now, or leave it to the owner/, command);
  }
  assert.equal(decide('crontab -l', s.worktree, {env: s.env}), null);
});

test('the override token lifts no Triphammer-session rule', t => {
  const s = triphammerSession(t);
  if (!s) return;
  for (const [command, rule] of [['echo x > ~/.bashrc', 'worktree-only'], ['crontab -e', 'scheduler'],
    ['echo x | at now', 'scheduler']]) {
    assertNotLifted(command, rule, s.worktree, {env: s.env});
  }
});

test('a Triphammer session cannot widen its places by changing the marker or $TMPDIR the hook sees', t => {
  const s = triphammerSession(t);
  if (!s) return;
  if (!existsSync('/proc/self/environ')) {
    t.skip('no /proc to read the environment the session started with');
    return;
  }
  // A shell that started with the session's marker runs the hook with a wider one, as a settings file's env would.
  const input = JSON.stringify({tool_name: 'Write', tool_input: fileInputs.Write(join(s.home, '.bashrc')),
    cwd: s.worktree});
  for (const [marker, temp] of [['/', s.temp], ['', s.temp], [s.worktree, s.home]]) {
    const result = spawnSync('/bin/sh', ['-c', `TRIPHAMMER_SESSION="$1" TMPDIR="$2" "$3" -I "$4"; exit $?`, 'sh',
      marker, temp, python, guard], {input, encoding: 'utf8', env: s.env});
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout, `expected a deny with marker ${marker} and TMPDIR ${temp}`);
    assertOutsideDenied(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason, marker, {file: true});
  }
});

test('a Triphammer session whose marker names no directory may write only the temporary directories', t => {
  const s = triphammerSession(t);
  if (!s) return;
  const env = {...s.env, TRIPHAMMER_SESSION: '1'};
  assertOutsideDenied(decideFile('Write', join(s.worktree, 'src/x.cs'), s.worktree, {env}), 'worktree', {file: true});
  assert.equal(decideFile('Write', join(s.temp, 'x'), s.worktree, {env}), null);
  assert.equal(run('not json', {env}), null, 'malformed input stays allowed');
});
