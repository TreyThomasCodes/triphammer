import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {git, here, lines, toolingEnv} from './fixture.mjs';
import {readdir} from './provision-fixture.mjs';

// A machine provision has set up, in a temporary directory: the machine file, Triphammer's repository under origins/
// whose bin/provision-project records its arguments and whether sudo ran it, then prints `project: example-project`
// (or exits with the code in <root>/provision-fails), the service user's ticket-runner, which records its project,
// XDG_RUNTIME_DIR and arguments (and exits with the code in <root>/runner-fails), a config per name in `projects`
// (name -> its text), and fakes of sudo, id and systemctl. provision-project and ticket-runner also record, in
// `sessions()`, whether each leads a session of its own and what its stdin is. `uid` and `login` are the caller's.
function setup(t, {projects = {'example-project': 'REPO=example/example-project\n'}, uid = '1000', login = 'owner'} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'triphammer-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const home = join(root, 'home/triphammer');
  const sys = join(root, 'sys');
  const bin = join(root, 'bin');
  const tmp = join(root, 'tmp');
  const record = join(root, 'record');
  const session = name => `[ "$(ps -o sid= -p $$ | tr -d ' ')" = $$ ] && s=leader || s=attached
echo "${name} $s $(readlink /proc/$$/fd/0)" >> '${record}.session'`;
  for (const dir of [join(sys, 'etc'), bin, tmp, join(home, '.local/bin'), join(home, '.config/triphammer')]) {
    mkdirSync(dir, {recursive: true});
  }
  writeFileSync(join(sys, 'etc/triphammer.conf'), '# machine\nTRIPHAMMER_REPO=example/triphammer\n'
    + `TRIPHAMMER_CHECKOUT=${root}/triphammer\nTRIPHAMMER_USER=triphammer\nTRIPHAMMER_HOME=${home}\n`);
  for (const [name, text] of Object.entries(projects)) writeFileSync(join(home, '.config/triphammer', `${name}.conf`), text);

  const work = join(root, 'work');
  mkdirSync(join(work, 'bin'), {recursive: true});
  writeFileSync(join(work, 'bin/provision-project'), `#!/usr/bin/env bash
echo "provision-project sudo=\${UNDER_SUDO:-no} $*" >> '${record}'
${session('provision-project')}
echo "setting it up"
[ ! -e '${root}/provision-fails' ] || exit "$(cat '${root}/provision-fails')"
echo "project: example-project"
`);
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'first');
  git(root, 'clone', '-q', '--bare', work, join(root, 'origins/example/triphammer.git'));

  writeFileSync(join(home, '.local/bin/ticket-runner'), `#!/bin/sh
echo "ticket-runner project=$TRIPHAMMER_PROJECT runtime=$XDG_RUNTIME_DIR $*" >> '${record}'
${session('ticket-runner')}
[ ! -e '${root}/runner-fails' ] || exit "$(cat '${root}/runner-fails')"
`, {mode: 0o755});
  writeFileSync(join(bin, 'sudo'), `#!/bin/sh
echo "sudo $*" >> '${record}'
[ "$1" = -v ] && exit 0
if [ "$1" = -iu ] || [ "$1" = -u ]; then shift 2; fi
UNDER_SUDO=yes exec "$@"
`, {mode: 0o755});
  writeFileSync(join(bin, 'id'), `#!/bin/sh
case "$*" in
  "-u") echo "$FAKE_UID" ;;
  "-un") echo "$FAKE_LOGIN" ;;
  "-u triphammer") echo 1001 ;;
  *) exit 1 ;;
esac
`, {mode: 0o755});
  writeFileSync(join(bin, 'systemctl'), `#!/bin/sh\necho "systemctl runtime=\${XDG_RUNTIME_DIR:-} $*" >> '${record}'\n`, {mode: 0o755});

  const env = {...toolingEnv, PATH: `${bin}:${process.env.PATH}`, TMPDIR: tmp, TRIPHAMMER_PROVISION_ROOT: sys,
    TRIPHAMMER_PROVISION_GIT_BASE: `file://${root}/origins/`, FAKE_UID: uid, FAKE_LOGIN: login, XDG_RUNTIME_DIR: ''};
  return {
    root, home, tmp,
    calls: () => lines(record),
    sessions: () => lines(`${record}.session`),
    fail: (what, code) => writeFileSync(join(root, `${what}-fails`), `${code}\n`),
    run: (...args) => spawnSync(join(here, 'triphammer'), args, {env, encoding: 'utf8'}),
  };
}

test('no command prints the usage and exits 2, --help exits 0, and an unknown command exits 2', t => {
  const s = setup(t);
  for (const [args, status] of [[[], 2], [['--help'], 0], [['frobnicate'], 2], [['add'], 2], [['plan', 'a', 'b'], 2]]) {
    const result = s.run(...args);
    assert.equal(result.status, status, `${args}: ${result.stderr}`);
    assert.match(result.stderr, /^usage: triphammer add /m);
  }
  assert.deepEqual(s.calls(), []);
});

test('add, as an ordinary user, asks sudo once, runs a fresh clone\'s provision-project as root, then creates the labels and runs the doctor as the service user', t => {
  const s = setup(t);
  const result = s.run('add', 'example/example-project', '--modules', 'demo', '--set', 'DEMO_URL=http://x.invalid/');
  assert.equal(result.status, 0, result.stderr);
  const calls = s.calls();
  assert.equal(calls[0], 'sudo -v');
  assert.match(calls[1], new RegExp(`^sudo setsid -w bash ${s.tmp}/tmp\\.\\w+/triphammer/bin/provision-project example/example-project --modules demo --set DEMO_URL=http://x\\.invalid/$`));
  assert.equal(calls[2], 'provision-project sudo=yes example/example-project --modules demo --set DEMO_URL=http://x.invalid/');
  assert.equal(calls[3], `sudo -iu triphammer env XDG_RUNTIME_DIR=/run/user/1001 setsid -w env TRIPHAMMER_PROJECT=example-project ${s.home}/.local/bin/ticket-runner --labels`);
  assert.equal(calls[4], 'ticket-runner project=example-project runtime=/run/user/1001 --labels');
  assert.equal(calls[5], `sudo -iu triphammer env XDG_RUNTIME_DIR=/run/user/1001 setsid -w env TRIPHAMMER_PROJECT=example-project ${s.home}/.local/bin/ticket-runner --doctor --before-start`);
  assert.equal(calls[6], 'ticket-runner project=example-project runtime=/run/user/1001 --doctor --before-start');
  assert.equal(calls.length, 7);
  assert.match(result.stdout, /sudo asks for your password once/);
  assert.match(result.stdout, /^setting it up$/m);
  assert.match(result.stdout, /Start it, once the doctor finds nothing missing: triphammer start example-project$/m);
  assert.deepEqual(readdir(s.tmp), [], 'the clone was left behind');
  // Run from a terminal, a command outside its foreground group that touches it is stopped, so these have none.
  assert.deepEqual(s.sessions(), ['provision-project leader /dev/null', 'ticket-runner leader /dev/null',
    'ticket-runner leader /dev/null']);
});

test('add as root runs provision-project without sudo', t => {
  const s = setup(t, {uid: '0', login: 'root'});
  const result = s.run('add', 'example/example-project');
  assert.equal(result.status, 0, result.stderr);
  const calls = s.calls();
  assert.equal(calls[0], 'provision-project sudo=no example/example-project');
  assert.ok(!calls.includes('sudo -v'));
  assert.doesNotMatch(result.stdout, /sudo asks/);
});

test('add exits with provision-project\'s status when it fails, runs no doctor and removes the clone', t => {
  const s = setup(t);
  s.fail('provision', 3);
  const result = s.run('add', 'example/example-project');
  assert.equal(result.status, 3, result.stderr);
  assert.ok(!s.calls().some(call => call.startsWith('ticket-runner')));
  assert.deepEqual(readdir(s.tmp), []);
});

test('add --dry-run creates no label and runs no doctor, and labels or a doctor that fail do not fail add', t => {
  const s = setup(t);
  const dry = s.run('add', 'example/example-project', '--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.ok(!s.calls().some(call => call.startsWith('ticket-runner')));
  s.fail('runner', 1);
  const result = s.run('add', 'example/example-project');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(s.calls().filter(call => call.startsWith('ticket-runner')).map(call => call.split(' ').slice(3).join(' ')),
    ['--labels', '--doctor --before-start']);
  assert.match(result.stderr, /not every label Triphammer uses could be created; the doctor lists the missing ones/);
});

test('without the machine file every command but usage exits 1 naming it', t => {
  const s = setup(t);
  rmSync(join(s.root, 'sys/etc/triphammer.conf'));
  for (const args of [['add', 'example/example-project'], ['doctor'], ['plan'], ['start']]) {
    const result = s.run(...args);
    assert.equal(result.status, 1, `${args}: ${result.stderr}`);
    assert.match(result.stderr, /triphammer\.conf is missing; set the machine up first with install\.sh/);
  }
  assert.deepEqual(s.calls(), []);
});

test('doctor and plan run ticket-runner for the only project, or the one named, and return its status', t => {
  const s = setup(t);
  assert.equal(s.run('doctor').status, 0);
  assert.equal(s.calls().at(-1), 'ticket-runner project=example-project runtime=/run/user/1001 --doctor');
  s.fail('runner', 4);
  assert.equal(s.run('plan', 'other').status, 4);
  assert.equal(s.calls().at(-1), 'ticket-runner project=other runtime=/run/user/1001 --plan');
  assert.deepEqual(s.sessions(), ['ticket-runner leader /dev/null', 'ticket-runner leader /dev/null']);
});

test('doctor with several projects and none named lists them and exits 2; with none it says how to add one', t => {
  const several = setup(t, {projects: {a: 'REPO=x/a\n', b: 'REPO=x/b\n'}});
  const result = several.run('doctor');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /name the project, one of: a b/);
  const none = setup(t, {projects: {}});
  const empty = none.run('plan');
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /no project is set up yet; add one with triphammer add <owner>\/<repo>/);
});

test('the service user runs doctor without sudo', t => {
  const s = setup(t, {login: 'triphammer', uid: '1001'});
  assert.equal(s.run('doctor').status, 0);
  assert.ok(!s.calls().some(call => call.startsWith('sudo')));
});

test('start enables and starts the project\'s timers, and its gallery with the demo module', t => {
  const s = setup(t, {projects: {'example-project': 'REPO=example/example-project\nMODULES=codex,demo\n'}});
  const result = s.run('start');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(s.calls().at(-1), 'systemctl runtime= --machine=triphammer@ --user enable --now '
    + 'ticket-runner@example-project.timer merge-when-ready@example-project.timer demo-gallery@example-project.service');
  assert.ok(s.calls().includes('sudo systemctl --machine=triphammer@ --user enable --now ticket-runner@example-project.timer '
    + 'merge-when-ready@example-project.timer demo-gallery@example-project.service'));
  assert.match(result.stdout, /^Started ticket-runner@example-project\.timer/m);
});

test('the service user starts its own timers through its user manager, and a project without a config is refused', t => {
  const s = setup(t, {login: 'triphammer', uid: '1001'});
  assert.equal(s.run('start', 'example-project').status, 0);
  assert.equal(s.calls().at(-1), 'systemctl runtime=/run/user/1001 --user enable --now ticket-runner@example-project.timer '
    + 'merge-when-ready@example-project.timer');
  const missing = s.run('start', 'nope');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /nope has no config/);
});
