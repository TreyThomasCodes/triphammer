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

test('in a Triphammer session a write behind setsid, flock, ionice, taskset, chrt, stdbuf, busybox, script -c, su -c or xargs is refused',
  t => {
    const s = triphammerSession(t);
    if (!s) return;
    for (const command of ['setsid touch ~/.bashrc', 'setsid -f -w touch ~/.bashrc', 'flock /tmp/l touch ~/.bashrc',
      'flock -w 5 -E 3 /tmp/l touch ~/.bashrc', `flock /tmp/l -c 'touch ~/.bashrc'`,
      `flock -n /tmp/l --command 'touch ~/.bashrc'`, 'flock ~/.bashrc true', 'ionice -c3 touch ~/.bashrc',
      'ionice -c 2 -n 7 -t touch ~/.bashrc', 'taskset 1 touch ~/.bashrc', 'taskset -c 0-3 touch ~/.bashrc',
      'chrt -o 0 touch ~/.bashrc', 'chrt --sched-runtime 5 -d 0 touch ~/.bashrc', 'stdbuf -oL touch ~/.bashrc',
      'busybox touch ~/.bashrc', 'nice -n 5 setsid busybox rm ~/.profile', `script -qc "touch ~/.bashrc" /dev/null`,
      `script --command='touch ~/.bashrc' -q /dev/null`, 'script -qc true ~/.bashrc', 'script -q -O ~/.bashrc -c true',
      'script -q -m advanced -c true ~/.bashrc',
      `su -c "touch ~/.bashrc"`, `su - someone -c 'touch ~/.bashrc'`, `sudo runuser -u someone -- rm ~/.x`,
      `runuser someone --command='rm ~/.x'`, `su -l -c 'touch .bashrc'`, 'echo ~/.bashrc | xargs rm', 'xargs touch <<< ~/.bashrc',
      'echo x | xargs -I{} touch {}', 'echo x | xargs -n 1 -P 2 sed -i s/a/b/', 'echo x | xargs sudo tee',
      'echo x | xargs -- xargs cp src/x.cs', 'echo x | busybox xargs rm', 'echo x | xargs touch ~/.bashrc',
      'nohup touch ~/.bashrc', 'time -p touch ~/.bashrc']) {
      assertOutsideDenied(decide(command, s.worktree, {env: s.env}), command);
    }
  });

test('in a Triphammer session xargs running a shell, eval, source or an inline script is refused, since -I puts its input in the script',
  t => {
    const s = triphammerSession(t);
    if (!s) return;
    for (const command of [`echo ~/.bashrc | xargs -I{} sh -c 'echo x > {}'`,
      `echo ~/.bashrc | xargs -I{} sh -c 'touch {}'`, `echo ~/.bashrc | xargs -I{} bash -c 'touch {}'`,
      `echo ~/.bashrc | xargs -i sh -c 'echo x > {}'`, `echo ~/.bashrc | xargs -I{} sudo sh -c 'echo > {}'`,
      `echo ~/.bashrc | xargs --replace sh -c 'touch {}'`, `echo ~/.bashrc | xargs -I{} ash -c 'touch {}'`,
      `echo x | xargs -I{} flock /tmp/l -c 'touch {}'`, `echo x | xargs -I{} script -qc 'touch {}' /dev/null`,
      `echo x | xargs -I{} su someone -c 'touch {}'`, `echo x | xargs -I{} runuser someone -c 'touch {}'`,
      `echo x | xargs eval`, `echo x | xargs source`, `echo ~/.bashrc | xargs -I{} python3 -c "open('{}', 'w')"`,
      `echo ~/.bashrc | xargs -I{} node -e "require('fs').writeFileSync('{}', '')"`]) {
      assertOutsideDenied(decide(command, s.worktree, {env: s.env}), command);
    }
    for (const command of [`echo x | xargs python3 tools/check.py`, `echo x | xargs node tools/check.mjs`]) {
      assert.equal(decide(command, s.worktree, {env: s.env}), null, command);
    }
  });

test('in a Triphammer session the letters of an attached xargs option value are not read as options', t => {
  const s = triphammerSession(t);
  if (!s) return;
  // -e, -i and -l take an optional value only attached, so the rest of their group is it and the next word is the
  // command; the other value options take the rest of their group, or the next word when nothing follows.
  for (const command of ['echo ~/.bashrc | xargs -iP touch P', 'echo ~/.bashrc | xargs -ia touch a',
    'echo ~/.bashrc | xargs -iX touch X', 'echo ~/.bashrc | xargs -en touch', 'echo ~/.bashrc | xargs -r -ea rm',
    'echo ~/.bashrc | xargs -ld touch', 'echo ~/.bashrc | xargs -rn1 touch', 'echo ~/.bashrc | xargs -rn 1 touch',
    'echo ~/.bashrc | xargs -0P2 rm', 'echo ~/.bashrc | xargs -rd, rm', 'echo ~/.bashrc | xargs -rd , rm',
    'echo ~/.bashrc | xargs -rEeof rm', 'echo ~/.bashrc | xargs -rs 99 rm', 'echo ~/.bashrc | xargs -rIP touch P',
    'echo ~/.bashrc | xargs -rL 1 rm', 'xargs -a list rm', 'xargs -ralist rm']) {
    assertOutsideDenied(decide(command, s.worktree, {env: s.env}), command);
  }
});

test('in a Triphammer session ash -c and busybox ash -c have their script read', t => {
  const s = triphammerSession(t);
  if (!s) return;
  for (const command of [`ash -c 'touch ~/.bashrc'`, `busybox ash -c 'touch ~/.bashrc'`]) {
    assertOutsideDenied(decide(command, s.worktree, {env: s.env}), command);
  }
  assert.equal(decide(`ash -c 'touch build/x'`, s.worktree, {env: s.env}), null);
});

test('in a Triphammer session those wrappers writing inside its worktree, and xargs running a command that writes nothing, are allowed',
  t => {
    const s = triphammerSession(t);
    if (!s) return;
    for (const command of ['setsid touch build/x', 'flock /tmp/l touch build/x', `flock /tmp/l -c 'touch build/x'`,
      'flock build/lock true', 'ionice -c3 touch build/x', 'taskset 1 touch build/x', 'taskset -c 0-3 touch build/x',
      'chrt -o 0 touch build/x', 'stdbuf -oL touch build/x', 'busybox touch build/x',
      `script -qc "touch build/x" /dev/null`, 'script -q -c true build/typescript', `su -c 'touch build/x'`,
      'xargs grep foo < src/x.cs', 'echo src/x.cs | xargs wc -l', 'git ls-files | xargs -0 -n 1 grep -l foo',
      'echo x | xargs', 'echo x | xargs echo']) {
      assert.equal(decide(command, s.worktree, {env: s.env}), null, command);
    }
  });
