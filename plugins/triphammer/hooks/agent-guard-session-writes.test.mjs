// agent-guard.py: File tool and shell writes in a Triphammer session.
import test from 'node:test';
import assert from 'node:assert/strict';
import {symlinkSync} from 'node:fs';
import {join, relative} from 'node:path';
import {
  run, decide, decideFile, fileTools, triphammerSession, assertOutsideDenied, outsidePlaces, shellWriters,
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

test('in a Triphammer session a path inside the worktree that a symlink leads outside is refused', t => {
  const s = triphammerSession(t);
  if (!s) return;
  symlinkSync(s.home, join(s.worktree, 'home'));
  symlinkSync(join(s.home, '.bashrc'), join(s.worktree, 'rc'));
  symlinkSync(join(s.home, '.bashrc'), join(s.temp, 'rc'));
  const linked = [join(s.worktree, 'home/.bashrc'), join(s.worktree, 'home/new/file'), join(s.worktree, 'rc'),
    join(s.temp, 'rc')];
  for (const tool of fileTools) {
    for (const path of linked) {
      assertOutsideDenied(decideFile(tool, path, s.worktree, {env: s.env}), `${tool} ${path}`, {file: true});
    }
  }
  for (const command of ['echo x > home/.bashrc', 'echo x >> rc', 'cp a.txt home/.profile', 'touch home/.ssh/x',
    `sed -i 's/a/b/' rc`, `echo x | tee ${join(s.temp, 'rc')}`]) {
    assertOutsideDenied(decide(command, s.worktree, {env: s.env}), command);
  }
});

test('in a Triphammer session a shell write outside its worktree and temporary directories is refused, naming the override',
  t => {
    const s = triphammerSession(t);
    if (!s) return;
    for (const target of outsidePlaces(s)) {
      for (const command of shellWriters(target)) {
        assertOutsideDenied(decide(command, s.worktree, {env: s.env}), command);
      }
    }
    for (const command of ['echo x > ~/.bashrc', 'echo x >> "$HOME/.profile"', 'mv ~/.ssh/config src/',
      'mv src/x.cs ../../elsewhere.cs', 'rm -rf ../../tools', 'cd .. && touch issue-8/x', 'cp -t ~ src/x.cs']) {
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
    'git commit -q -m "Fix the thing" 2>/dev/null', 'git fetch origin', 'git worktree add ../issue-8 origin/main',
    `cp ${join(s.home, '.bashrc')} src/`, 'cat ~/.bashrc', 'echo x >&2', 'echo x | tee /dev/stderr',
    `sed -i '/^class/d' src/x.cs`, 'cd /tmp && echo x > agent-guard-relative', 'ln -s ../src/x.cs src/rc-link',
    'rm -rf src/new && mkdir -p src/new']) {
    assert.equal(decide(command, s.worktree, {env: s.env}), null, command);
  }
});
