// agent-guard.py: The self-kill rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {run, decide} from './agent-guard-fixture.mjs';

// The self-kill rule.

test('pkill -f with a plain pattern is refused with the rule, the bracket form, a saved PID and kill %1', () => {
  const reason = decide('pkill -f web-e2e', tmpdir());
  assert.ok(reason, 'expected a deny');
  assert.match(reason, /self-kill rule/);
  assert.ok(reason.includes(`pkill -f '[w]eb-e2e'`), reason);
  assert.match(reason, /kill "\$pid"/);
  assert.match(reason, /kill %1/);
  assert.match(reason, /# guard-override: <reason>/);
});

test('pgrep -f with a quoted plain pattern is refused', () => {
  const reason = decide('pgrep -f "dotnet test"', tmpdir());
  assert.ok(reason, 'expected a deny');
  assert.match(reason, /self-kill rule/);
  assert.ok(reason.includes(`pgrep -f '[d]otnet test'`), reason);
});

test('pkill -9f, a signal and -f in one group, is refused', () => {
  const reason = decide('pkill -9f dotnet', tmpdir());
  assert.ok(reason, 'expected a deny');
  assert.match(reason, /self-kill rule/);
  assert.ok(reason.includes(`pkill -f '[d]otnet'`), reason);
  assert.match(reason, /# guard-override: <reason>/);
});

test('pkill -f inside a longer command is refused', () => {
  assert.match(decide('scripts/web-e2e.sh & sleep 5; sudo pkill -9 -f "dotnet run" || true', tmpdir()) ?? '',
    /self-kill rule/);
});

test('pkill -f or pgrep -f after a reserved word is refused', () => {
  for (const command of ['if true; then pkill -f web-e2e; fi', 'while pgrep -f web-e2e; do sleep 1; done',
    '{ pkill -f web-e2e; }', 'until ! pgrep -f web-e2e; do sleep 1; done']) {
    assert.match(decide(command, tmpdir()) ?? '', /self-kill rule/, command);
  }
});

test('pkill -f with a bracket pattern, and pkill without -f, are allowed', () => {
  assert.equal(decide(`pkill -f '[w]eb-e2e'`, tmpdir()), null);
  assert.equal(decide(`pgrep -af "[d]otnet test"`, tmpdir()), null);
  assert.equal(decide('pkill dotnet', tmpdir()), null);
  assert.equal(decide('pkill -9 dotnet', tmpdir()), null);
  assert.equal(decide(`git commit -m "Stop using pkill -f web-e2e"`, tmpdir()), null);
});

// kill of the shell, the session or one of its parents. The hook's parent here is this test process.
const selfKills = [
  ['kill "$PPID"', /Claude Code session/],
  ['kill $PPID', /Claude Code session/],
  ['kill -9 ${PPID}', /Claude Code session/],
  ['kill $$', /shell running the command/],
  ['kill -TERM "${$}"', /shell running the command/],
  ['kill -s KILL $PPID', /Claude Code session/],
  ['kill -n 9 $PPID', /Claude Code session/],
  ['kill --signal TERM $$', /shell running the command/],
  ['kill -- -$$', /shell running the command/],
  ['sudo kill -9 $PPID', /Claude Code session/],
  [`kill ${process.pid}`, new RegExp(`process ${process.pid}, the Claude Code session or one of its parents`)],
  [`kill -9 ${process.ppid}`, new RegExp(`process ${process.ppid}`)],
  [`bash -c 'kill -HUP ${process.pid}'`, new RegExp(`process ${process.pid}`)],
];

for (const [command, process_] of selfKills) {
  test(`${command} is refused with the rule, a saved PID, kill %1 and the override token`, () => {
    const reason = decide(command, tmpdir());
    assert.ok(reason, 'expected a deny');
    assert.match(reason, /self-kill rule/);
    assert.match(reason, process_);
    assert.match(reason, /kill "\$pid"/);
    assert.match(reason, /kill %1/);
    assert.match(reason, /# guard-override: <reason>/);
  });
}

test('kill of a PID outside the session, a job or a saved PID is allowed', () => {
  const other = spawnSync('true').pid;  // exited, and never a parent of the hook
  for (const command of [`kill ${other}`, `kill -9 ${other}`, 'kill %1', 'kill "$pid"', 'kill -l', `kill '$PPID'`,
    `git commit -m "Refuse kill $PPID"`]) {
    assert.equal(decide(command, tmpdir()), null, command);
  }
});
