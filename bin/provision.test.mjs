import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, readFileSync, readlinkSync, statSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {git, here, lines, run} from './fixture.mjs';
import {changingCalls, codename, machine, readdir, scripts, triphammerFiles, units} from './provision-fixture.mjs';

const tri = ['--triphammer', 'example/triphammer', '/CHECKOUT'];
// The arguments with /CHECKOUT made a path in the machine's temporary directory, and `--home` its user's home.
const at = (m, args) => [...args.map(arg => arg.replace(/^\/CHECKOUT/, join(m.root, 'triphammer'))), '--home', m.home];

for (const [what, args, message] of [
  ['no argument', [], /--triphammer is missing/],
  ['an unknown flag', [...tri, '--frobnicate'], /unknown argument --frobnicate/],
  ['a --triphammer without its checkout', ['--triphammer', 'example/x'], /--triphammer needs a repository and a checkout/],
  ['--triphammer twice', [...tri, '--triphammer', 'example/x', '/x'], /--triphammer is given twice/],
  ['a repository that is not owner/name', ['--triphammer', 'nope', '/x'], /--triphammer takes a repository as owner\/name, not nope/],
  ['a relative checkout', ['--triphammer', 'example/y', 'y'], /the checkout must be an absolute path/],
  ['a checkout with ..', ['--triphammer', 'example/y', '/srv/../y'], /without \. or \.\. parts/],
  ['a project argument', [...tri, '--project', 'example/y', '/y'], /--project belongs to triphammer add/],
  ['a malformed --user', [...tri, '--user', 'Bad User'], /--user must be a user name/],
  ['a relative --home', [...tri, '--home', 'home'], /--home must be an absolute path/],
]) {
  test(`${what} stops provision with exit 2 and the usage before anything runs`, t => {
    const m = machine(t, {});
    const result = m.provision(...args.map(arg => arg.replace(/^\/CHECKOUT/, join(m.root, 'triphammer'))));
    assert.equal(result.status, 2, result.output);
    assert.match(result.stderr, message);
    assert.match(result.stderr, /^usage: provision --triphammer/m);
    assert.deepEqual(result.calls, []);
  });
}

test('on a fresh machine it installs everything but a project, and a second run changes nothing', t => {
  const m = machine(t, {'example/triphammer': triphammerFiles});
  const checkout = join(m.root, 'triphammer');
  const first = m.provision(...at(m, tri));
  assert.equal(first.status, 0, first.output);

  const {packages, users, linger} = m.machine();
  for (const name of ['git', 'jq', 'python3', 'curl', 'docker-ce', 'docker-compose-plugin', 'gh']) assert.ok(packages.includes(name), name);
  for (const name of ['codex', 'bubblewrap', 'ffmpeg', 'docker.io']) assert.ok(!packages.includes(name), name);
  assert.match(first.stdout, /^Docker Engine: from Docker's repository$/m);
  assert.match(first.stdout, /^GitHub CLI: from the GitHub CLI's repository$/m);
  assert.match(readFileSync(join(m.sys, 'etc/apt/sources.list.d/docker.sources'), 'utf8'), new RegExp(`^Suites: ${codename}$`, 'm'));
  assert.deepEqual(users.triphammer, {home: m.home, groups: ['triphammer', 'docker']});
  assert.deepEqual(linger, ['triphammer']);

  assert.equal(git(checkout, 'remote', 'get-url', 'origin'), `file://${m.root}/origins/example/triphammer.git`);
  for (const name of scripts) assert.equal(readlinkSync(join(m.home, '.local/bin', name)), join(checkout, 'bin', name));
  assert.equal(readlinkSync(join(m.home, '.local/bin/triphammer-status')), join(checkout, 'status/server.mjs'));
  for (const name of units) assert.equal(readlinkSync(join(m.home, '.config/systemd/user', name)), join(checkout, 'systemd', name));
  assert.equal(readlinkSync(join(m.home, '.config/systemd/user/triphammer-status.service')), join(checkout, 'systemd/triphammer-status.service'));
  assert.ok(m.calls().some(([command, ...args]) => command === 'systemctl' && args.join(' ') === '--machine=triphammer@ --user daemon-reload'));
  assert.ok(!m.calls().some(([command, ...args]) => command === 'systemctl' && args.includes('enable')), 'provision enabled a unit');

  assert.equal(statSync(join(m.home, '.config/github-app')).mode & 0o777, 0o700);
  assert.deepEqual(readdir(join(m.home, '.config/github-app')), []);
  assert.equal(run('git', ['config', '--file', join(m.home, '.gitconfig'), '--get-all', 'credential.https://github.com.helper']),
    '\n!github-app-token git-credential\n');
  const gitConfig = key => run('git', ['config', '--file', join(m.home, '.gitconfig'), '--get', key]).trim();
  assert.equal(gitConfig('credential.https://github.com.useHttpPath'), 'true');
  assert.ok(!existsSync(join(m.home, '.config/triphammer')), 'provision wrote a project config');

  assert.equal(run(join(m.sys, 'usr/local/bin/node'), ['--version']), 'v24.19.0\n');
  assert.deepEqual(lines(join(m.state, 'claude-install-calls')), ['installed']);
  assert.deepEqual(JSON.parse(readFileSync(join(m.state, 'claude/plugins.json'), 'utf8')),
    {marketplaces: [{name: 'triphammer'}], plugins: [{id: 'triphammer@triphammer', scope: 'user'}]});
  // Run from a terminal, a claude outside the terminal's foreground group that touches it is stopped, so each one runs
  // in a session of its own with nothing on stdin.
  const pluginCalls = lines(join(m.state, 'claude/plugin-calls')).map(line => JSON.parse(line));
  assert.ok(pluginCalls.length >= 4, `expected the list and change calls, got ${pluginCalls.length}`);
  for (const call of pluginCalls) {
    assert.deepEqual({sessionLeader: call.sessionLeader, stdin: call.stdin}, {sessionLeader: true, stdin: '/dev/null'},
      `claude plugin ${call.args.join(' ')} ran attached`);
  }
  assert.ok(!existsSync(join(m.state, 'dotnet-install-calls')), 'provision installed a project toolchain');

  const machineFile = join(m.sys, 'etc/triphammer.conf');
  assert.equal(readFileSync(machineFile, 'utf8').split('\n').slice(1).join('\n'),
    `TRIPHAMMER_REPO=example/triphammer\nTRIPHAMMER_CHECKOUT=${checkout}\nTRIPHAMMER_USER=triphammer\nTRIPHAMMER_HOME=${m.home}\n`);
  assert.equal(statSync(machineFile).mode & 0o777, 0o644);
  const command = join(m.sys, 'usr/local/bin/triphammer');
  assert.equal(readFileSync(command, 'utf8'), readFileSync(join(here, 'triphammer'), 'utf8'));
  assert.equal(statSync(command).mode & 0o777, 0o755);
  assert.equal(statSync(command).isSymbolicLink(), false);

  assert.match(first.stdout, /change\(s\) made\./);
  assert.match(first.stdout, new RegExp(`Put the App's files in ${m.home}/\\.config/github-app`));
  assert.match(first.stdout, /^ {2}3\. Add a project: triphammer add <owner>\/<repo>$/m);

  const changed = changingCalls(first.calls).map(call => call.join(' '));
  for (const pattern of [/^runuser .* git .*clone /, /^runuser .* sh -c /, /^apt-get install /, /^useradd /, /^systemctl .* link /]) {
    assert.ok(changed.some(call => pattern.test(call)), `the first run's changes include ${pattern}`);
  }

  const second = m.provision(...at(m, tri));
  assert.equal(second.status, 0, second.output);
  assert.match(second.stdout, /^Nothing to change: the machine is as asked\.$/m);
  assert.doesNotMatch(second.stdout, /^\+ /m);
  assert.deepEqual(changingCalls(second.calls), []);

  // A triphammer command that is not this script's copy is put back.
  writeFileSync(command, '#!/bin/sh\necho changed\n');
  const third = m.provision(...at(m, tri));
  assert.equal(third.status, 0, third.output);
  assert.equal(readFileSync(command, 'utf8'), readFileSync(join(here, 'triphammer'), 'utf8'));
});

test('a private repository: the first run creates the App\'s directory and stops at the clone, and once the owner places the App\'s files the next run clones with its token', t => {
  const m = machine(t, {'example/triphammer': triphammerFiles}, {privateOrigins: true});
  const checkout = join(m.root, 'triphammer');
  const app = join(m.home, '.config/github-app');
  const first = m.provision(...at(m, tri));
  assert.equal(first.status, 1, first.output);
  assert.match(first.stderr, new RegExp(`could not clone example/triphammer into ${checkout}; a private repository needs the App's files in ${app} first`));
  assert.equal(statSync(app).mode & 0o777, 0o700);
  assert.deepEqual(readdir(app), []);
  assert.ok(!existsSync(join(checkout, '.git')), 'the clone happened without credentials');
  assert.deepEqual(readdir(join(m.sys, 'tmp')), [], 'the copy of github-app-token was left behind');

  m.placeApp();
  const second = m.provision(...at(m, tri));
  assert.equal(second.status, 0, second.output);
  assert.equal(git(checkout, 'remote', 'get-url', 'origin'), `file://${m.root}/origins/example/triphammer.git`);
  const clones = second.calls.filter(([command, ...args]) => command === 'git' && args.includes('clone'));
  assert.equal(clones.length, 1);
  assert.match(clones[0].join(' '), new RegExp(`-c credential\\.https://github\\.com\\.helper= -c credential\\.https://github\\.com\\.helper=!${m.sys}/tmp/github-app-token\\.\\w+/github-app-token git-credential clone `));
  assert.deepEqual(readdir(join(m.sys, 'tmp')), [], 'the copy of github-app-token was left behind');
  assert.ok(!second.output.includes('ghs_fake'), 'the token reached the output');
  assert.match(m.provision(...at(m, tri)).stdout, /^Nothing to change/m);
});

test('without the vendors\' repositories for the release, Docker and gh come from Ubuntu\'s archive', t => {
  const m = machine(t, {'example/triphammer': triphammerFiles}, {dockerRepo: false, ghRepo: false});
  const result = m.provision(...at(m, tri));
  assert.equal(result.status, 0, result.output);
  assert.match(result.stdout, /^Docker Engine: from Ubuntu's archive \(docker\.io, docker-compose-v2\), as Docker's repository does not serve resolute$/m);
  assert.match(result.stdout, /^GitHub CLI: from Ubuntu's archive \(gh\)/m);
  const {packages} = m.machine();
  for (const name of ['docker.io', 'docker-compose-v2', 'gh']) assert.ok(packages.includes(name), name);
  assert.ok(!packages.includes('docker-ce'));
  assert.ok(!existsSync(join(m.sys, 'etc/apt/sources.list.d/github-cli.sources')), 'the failed vendor repository was left behind');
  assert.match(m.provision(...at(m, tri)).stdout, /^Nothing to change/m);
});

test('--dry-run on a fresh machine lists the changes and makes none', t => {
  const m = machine(t, {'example/triphammer': triphammerFiles});
  const result = m.provision(...at(m, tri), '--dry-run');
  assert.equal(result.status, 0, result.output);
  assert.match(result.stdout, /^would: install ca-certificates curl git jq python3 openssl xz-utils$/m);
  assert.match(result.stdout, /^would: create the user triphammer with the home /m);
  assert.match(result.stdout, /^would: clone example\/triphammer into /m);
  assert.match(result.stdout, /^would: write .*\/etc\/triphammer\.conf$/m);
  assert.match(result.stdout, /^Node: the version comes from Triphammer's checkout, which is not cloned yet/m);
  assert.match(result.stdout, /change\(s\) to make; nothing was changed\./);
  assert.doesNotMatch(result.stdout, /^\+ /m);
  assert.deepEqual(changingCalls(result.calls), []);
  assert.ok(!existsSync(m.home) && !existsSync(join(m.root, 'triphammer')) && !existsSync(join(m.sys, 'etc/apt'))
    && !existsSync(join(m.sys, 'etc/triphammer.conf')));
});

test('a checkout path that holds something else stops provision with exit 1 before anything changes', t => {
  const m = machine(t, {'example/triphammer': triphammerFiles});
  mkdirSync(join(m.root, 'triphammer'));
  writeFileSync(join(m.root, 'triphammer/stray'), 'x\n');
  const result = m.provision(...at(m, tri));
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /triphammer exists and is not triphammer's clone of example\/triphammer; move it away/);
  assert.deepEqual(changingCalls(result.calls), []);
});

test('a Triphammer checkout that pins no Node version stops provision with exit 1', t => {
  const {'.node-version': _, ...files} = triphammerFiles;
  const m = machine(t, {'example/triphammer': files});
  const result = m.provision(...at(m, tri));
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /pins no Node version in \.node-version/);
});
