import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmodSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fakeSudo, here, lines} from './fixture.mjs';
import {changingCalls, machine, projectFiles, readdir, triphammerFiles} from './provision-fixture.mjs';

// `triphammer update` on the fake machine of provision-fixture.mjs, running the real provision and provision-project
// from the clone it makes: Triphammer's repository holds this branch's scripts, and its ticket-runner records each
// doctor run in ~/.local/ticket-runner-calls. The machine is set up as install.sh and triphammer add leave it, with two
// projects: project-a pins a .NET SDK and Playwright, project-b pins nothing. The caller is root (the fake id says so),
// and a fake sudo runs `sudo -iu <user> <command...>` as the caller.
const real = name => readFileSync(join(here, name), 'utf8');
function setUp(t) {
  const m = machine(t, {
    'example/triphammer': {...triphammerFiles,
      ...Object.fromEntries(['provision', 'provision-lib.sh', 'provision-project', 'triphammer', 'github-app-token']
        .map(name => [`bin/${name}`, real(name)])),
      'bin/ticket-runner': '#!/bin/sh\necho "$TRIPHAMMER_PROJECT $*" >> "$(dirname "$0")/../ticket-runner-calls"\n'},
    'example/project-a': projectFiles('project-a'),
    'example/project-b': {'.triphammer/project.json': JSON.stringify({name: 'project-b'}), '.node-version': '24.19.0\n'},
  });
  const checkout = join(m.root, 'triphammer');
  const provisioned = m.provision('--triphammer', 'example/triphammer', checkout, '--home', m.home);
  assert.equal(provisioned.status, 0, provisioned.output);
  m.placeApp();
  for (const name of ['project-a', 'project-b']) {
    const added = m.project(`example/${name}`, join(m.root, 'srv', name));
    assert.equal(added.status, 0, added.output);
  }
  chmodSync(join(checkout, 'bin/ticket-runner'), 0o755);
  fakeSudo(join(m.root, 'bin'));
  const tmp = join(m.root, 'update-tmp');
  mkdirSync(tmp);
  const config = name => readFileSync(join(m.home, '.config/triphammer', `${name}.conf`));
  const update = (...args) => {
    const before = m.calls().length;
    const result = spawnSync(join(here, 'triphammer'), ['update', ...args], {env: {...m.env, TMPDIR: tmp}, encoding: 'utf8'});
    // systemctl show only asks whether a unit changed on disk.
    const calls = m.calls().slice(before).filter(([command, ...rest]) => command !== 'systemctl' || !rest.includes('show'));
    return {...result, output: result.stdout + result.stderr, calls};
  };
  return {m, tmp, config, update, doctors: () => lines(join(m.home, '.local/ticket-runner-calls'))};
}

// What provision's report says is left on the machine setUp leaves: neither project started, nor the status page.
const ownerSteps = `
Next, as the owner (provision never reads or writes a credential):
  1. Start the projects whose timers are off (triphammer add <owner>/<repo> adds another):
     - project-a: triphammer start project-a
     - project-b: triphammer start project-b
  2. Optionally the status page: sudo systemctl --machine=triphammer@ --user enable --now triphammer-status.service
`;
const endsWithOwnerSteps = output => {
  assert.ok(output.endsWith(ownerSteps), output);
  assert.equal(output.split('Next, as the owner (provision never').length, 2, 'the report came more than once');
};

test('update on a machine with two projects and nothing to change changes nothing, keeps both configs byte for byte, and runs each doctor', t => {
  const {m, tmp, config, update, doctors} = setUp(t);
  const before = [config('project-a'), config('project-b')];
  const result = update();
  assert.equal(result.status, 0, result.output);
  assert.match(result.stdout, /^Nothing to change: the machine and every project are as asked\.$/m);
  assert.doesNotMatch(result.stdout, /^\+ /m);
  // provision and each provision-project ran, and each found nothing to change.
  assert.equal(result.stdout.match(/^Nothing to change: the machine is as asked\.$/gm).length, 3);
  assert.match(result.stdout, /^project: project-a$[^]*^project: project-b$/m);
  assert.deepEqual(changingCalls(result.calls), []);
  assert.deepEqual([config('project-a'), config('project-b')], before);
  assert.deepEqual(doctors(), ['project-a --doctor', 'project-b --doctor']);
  // It ends with what is left for the owner, after the doctors.
  endsWithOwnerSteps(result.stdout);
  assert.equal(readFileSync(join(m.sys, 'usr/local/bin/triphammer'), 'utf8'), real('triphammer'));
  assert.deepEqual(readdir(tmp), [], 'the clone was left behind');
});

test('after a project\'s SDK pin changes, update --dry-run lists the install and changes nothing, and update installs it', t => {
  const {m, config, update, doctors} = setUp(t);
  const checkout = join(m.root, 'srv/project-a');
  writeFileSync(join(checkout, 'global.json'), JSON.stringify({sdk: {version: '10.0.500', rollForward: 'latestPatch'}}));
  const before = [config('project-a'), config('project-b')];
  const installs = () => lines(join(m.state, 'dotnet-install-calls'));
  const installed = installs();

  const dry = update('--dry-run');
  assert.equal(dry.status, 0, dry.output);
  assert.match(dry.stdout, /^would: install the \.NET SDK 10\.0\.500 into .* with dotnet-install$/m);
  assert.match(dry.stdout, /^The changes above would be made; nothing was changed\.$/m);
  assert.deepEqual(changingCalls(dry.calls), []);
  assert.deepEqual(installs(), installed);
  assert.deepEqual(doctors(), [], 'a dry run ran the doctor');
  endsWithOwnerSteps(dry.stdout);

  const result = update();
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(installs().slice(installed.length), [`--version 10.0.500 --install-dir ${m.home}/.dotnet --no-path`]);
  assert.match(result.stdout, /^The changes above were made\.$/m);
  assert.deepEqual([config('project-a'), config('project-b')], before);
  assert.deepEqual(doctors(), ['project-a --doctor', 'project-b --doctor']);
  assert.match(update().stdout, /^Nothing to change: the machine and every project are as asked\.$/m);
});
