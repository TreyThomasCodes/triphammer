import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readdirSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {here, runnerSetup} from './fixture.mjs';

const rootful = 'unix:///var/run/docker.sock';

// A machine whose checkout holds this branch's docker-probe beside session-sandbox and config.sh, with the runner
// rig's fakes (bin/fixture.mjs, runnerSetup): a bwrap that records its arguments and runs the command, a docker that
// records the daemon each call reaches and refuses the rootful one, and a machine file naming the rootless daemon's
// socket. `probe` runs docker-probe as the service user, whose home is the rig's.
function probeSetup(t) {
  const r = runnerSetup(t, {files: {'bin/docker-probe': readFileSync(join(here, 'docker-probe'), 'utf8')}});
  r.docker.refuse(rootful);
  return {
    ...r,
    probe() {
      const result = spawnSync(join(r.checkout, 'bin/docker-probe'), [], {env: r.env, encoding: 'utf8'});
      return {status: result.status, output: result.stdout + result.stderr};
    },
    // The docker commands that ran under the write limit, each with the daemon it reached.
    inside: () => r.bwrapCalls().map(call => call.slice(call.indexOf('--') + 1)),
    leftovers: () => readdirSync(r.home).filter(name => name.startsWith('docker-probe-')),
  };
}

test('the probe runs its containers under the write limit against the rootless daemon and passes when they cannot write', t => {
  const r = probeSetup(t);
  const {status, output} = r.probe();
  assert.equal(status, 0, output);
  assert.deepEqual(output.split('\n').filter(Boolean), [
    `PASS: a container that mounts / cannot write in ${r.home}`,
    `PASS: a privileged container that mounts / cannot write in ${r.home}`,
    'PASS: the rootful daemon at /var/run/docker.sock does not answer under the write limit',
    'PASS: the rootful daemon at /var/run/docker.sock does not answer this user',
  ]);
  const inside = r.inside();
  assert.deepEqual(inside.map(command => command.slice(0, 2).join(' ')),
    ['docker run', 'docker run', 'docker run', 'docker -H']);
  assert.ok(inside[1].includes('/:/host') && inside[2].includes('--privileged'), JSON.stringify(inside));
  // As a Docker project's session: the rootful sockets' directory hidden, the rootless daemon's left as it is.
  const tmpfs = call => call.flatMap((arg, i) => arg === '--tmpfs' ? [call[i + 1]] : []);
  for (const call of r.bwrapCalls()) {
    assert.ok(tmpfs(call).includes('/run') && !tmpfs(call).includes(realpathSync(dirname(r.dockerSocket))), JSON.stringify(call));
  }
  const runs = r.docker.hosts().filter(call => call.includes('|run '));
  assert.equal(runs.length, 3);
  assert.ok(runs.every(call => call.startsWith(`${r.dockerHost}|`)), runs.join('\n'));
  assert.deepEqual(r.docker.hosts().filter(call => call.endsWith(' info')).map(call => call.split('|')[0]), [rootful, rootful]);
});

test('the probe fails when a container that mounts / creates the file in the home directory, and removes the file', t => {
  const r = probeSetup(t);
  r.docker.writes();
  const {status, output} = r.probe();
  assert.equal(status, 1, output);
  assert.match(output, new RegExp(`^FAIL: a container that mounts / created ${r.home}/docker-probe-[0-9]+-mount$`, 'm'));
  assert.match(output, new RegExp(`^FAIL: a privileged container that mounts / created ${r.home}/docker-probe-[0-9]+-privileged$`, 'm'));
  assert.deepEqual(r.leftovers(), [], 'the files the containers created are removed');
});

test('the probe fails when the rootful daemon answers, and when the rootless one cannot run a container', t => {
  const r = probeSetup(t);
  r.docker.refuse();
  const answered = r.probe();
  assert.equal(answered.status, 1, answered.output);
  assert.match(answered.output, /^FAIL: the rootful daemon at \/var\/run\/docker\.sock answers under the write limit$/m);
  assert.match(answered.output, /^FAIL: the rootful daemon at \/var\/run\/docker\.sock answers this user;/m);
  r.docker.refuse(rootful, r.dockerHost);
  const down = r.probe();
  assert.equal(down.status, 1, down.output);
  assert.match(down.output, new RegExp(`^FAIL: the rootless daemon at ${r.dockerSocket} could not run busybox under the write limit: Cannot connect`));
  assert.doesNotMatch(down.output, /PASS/);
});

test('the probe fails at once on a machine whose machine file names no rootless daemon', t => {
  const r = probeSetup(t);
  writeFileSync(r.machineFile, readFileSync(r.machineFile, 'utf8').replace(/^TRIPHAMMER_DOCKER_.*\n/gm, ''));
  const {status, output} = r.probe();
  assert.equal(status, 1);
  assert.equal(output, 'FAIL: the machine file names no rootless Docker daemon; run sudo bin/provision first\n');
  assert.deepEqual(r.docker.calls(), []);
});
