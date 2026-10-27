import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {interrupt, lines} from './fixture.mjs';

// A script in a temporary directory for interrupt() (fixture.mjs) to wait on: `body` runs under bash, with $pids (a
// file each process of it appends its pid to), $slow (the slow step's log) and $got (where its traps record a signal).
function script(t, body) {
  const root = mkdtempSync(join(tmpdir(), 'fixture-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const path = join(root, 'script');
  writeFileSync(path, `#!/usr/bin/env bash\npids='${root}/pids' slow='${root}/slow' got='${root}/got'\n${body}\n`, {mode: 0o755});
  return {
    path, slow: join(root, 'slow'),
    pids: () => lines(join(root, 'pids')).map(Number),
    got: () => lines(join(root, 'got')),
    spawn: group => spawn(path, [], {stdio: 'ignore', detached: group}),
  };
}
// The pids among `pids` still running (a zombie has ended), after giving their parents a second to go.
async function running(pids) {
  for (let i = 0; i < 50; i++) {
    const left = pids.filter(pid => /^[^Z]/.test(spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], {encoding: 'utf8'}).stdout.trim()));
    if (left.length === 0 || i === 49) return left;
    await sleep(20);
  }
}

for (const group of [false, true]) {
  test(`a script that ignores the signal${group ? ' sent to its process group' : ''} fails interrupt within the limit, naming the signal, the script and its process tree, and nothing of it is left running`, async t => {
    const s = script(t, `trap '' INT
echo $$ >> "$pids"
setsid sleep 60 & echo $! >> "$pids"
sleep 60 & echo $! >> "$pids"
echo started >> "$slow"
wait`);
    const start = Date.now();
    await assert.rejects(interrupt(s.spawn(group), 'SIGINT', group, s.slow, 1000), error => {
      const took = Date.now() - start;
      assert.ok(took >= 1000 && took < 3000, `${took} ms`);
      assert.match(error.message, new RegExp(`^SIGINT did not end ${s.path} within 1000 ms`));
      assert.match(error.message, /^PID PPID PGID SID STAT COMMAND$/m);
      const [own, setsid, plain] = s.pids();
      assert.match(error.message, new RegExp(`^${own} \\d+ \\d+ \\d+ \\S+ bash ${s.path}$`, 'm'));
      for (const pid of [setsid, plain]) assert.match(error.message, new RegExp(`^${pid} ${own} \\d+ \\d+ \\S+ sleep 60$`, 'm'));
      return true;
    });
    assert.equal(s.pids().length, 3);
    assert.deepEqual(await running(s.pids()), []);
  });
}

test('a slow step that never records started fails interrupt within the limit, and the script gets no signal', async t => {
  const s = script(t, `trap 'echo INT >> "$got"' INT
trap 'echo TERM >> "$got"' TERM
echo $$ >> "$pids"
sleep 60 & echo $! >> "$pids"
while :; do wait; done`);
  const start = Date.now();
  await assert.rejects(interrupt(s.spawn(false), 'SIGTERM', false, s.slow, 1000), error => {
    const took = Date.now() - start;
    assert.ok(took >= 1000 && took < 3000, `${took} ms`);
    assert.match(error.message, new RegExp(`^the slow step of ${s.path} did not record started in ${s.slow} within 1000 ms; no signal sent$`, 'm'));
    assert.match(error.message, new RegExp(`^${s.pids()[1]} ${s.pids()[0]} \\d+ \\d+ \\S+ sleep 60$`, 'm'));
    return true;
  });
  assert.deepEqual(s.got(), []);
  assert.equal(s.pids().length, 2);
  assert.deepEqual(await running(s.pids()), []);
});

test('a script that ends before its slow step starts fails interrupt at once', async t => {
  const s = script(t, 'exit 3');
  const start = Date.now();
  await assert.rejects(interrupt(s.spawn(false), 'SIGINT', false, s.slow, 5000),
    {message: new RegExp(`^${s.path} ended \\(exit 3\\) before its slow step recorded started in ${s.slow}; no signal sent$`)});
  assert.ok(Date.now() - start < 2000, `${Date.now() - start} ms`);
});
