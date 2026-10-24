import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fakeCommand, git, here, lines, run, toolingEnv} from './fixture.mjs';

// The commands provision changes or inspects the machine with, each a fake-machine.mjs acting on one state.
const machineCommands = ['apt-get', 'dpkg-query', 'dpkg', 'useradd', 'usermod', 'getent', 'id', 'loginctl', 'systemctl',
  'curl', 'apparmor_parser', 'bwrap', 'runuser', 'chown'];
const scripts = ['ticket-runner', 'merge-when-ready', 'land-pr', 'github-app-token', 'gh', 'demo-gallery'];
const units = ['ticket-runner@.service', 'ticket-runner@.timer', 'merge-when-ready@.service', 'merge-when-ready@.timer',
  'demo-gallery@.service'];
const codename = 'resolute';
const dockerRelease = `https://download.docker.com/linux/ubuntu/dists/${codename}/Release`;
const ghKey = 'https://cli.github.com/packages/githubcli-archive-keyring.gpg';

// What a repository holds: Triphammer's own files (the scripts, units, config.sh and the marketplace file), a
// project's (its project file, a global.json pinning 10.0.400 and a web app pinning Playwright 1.63.0), or both, and the
// Node pin in .node-version.
const triphammerFiles = {
  ...Object.fromEntries(scripts.map(name => [`bin/${name}`, '#!/bin/sh\n'])),
  ...Object.fromEntries(units.map(name => [`systemd/${name}`, '[Unit]\n'])),
  'bin/config.sh': readFileSync(join(here, 'config.sh'), 'utf8'),
  'status/server.mjs': '#!/usr/bin/env node\n',
  'systemd/triphammer-status.service': '[Unit]\n',
  '.claude-plugin/marketplace.json': readFileSync(join(here, '../.claude-plugin/marketplace.json'), 'utf8'),
  '.node-version': '24.19.0\n',
};
const projectFiles = name => ({
  '.triphammer/project.json': JSON.stringify({name}),
  'global.json': JSON.stringify({sdk: {version: '10.0.400', rollForward: 'latestPatch'}}),
  'web/package.json': JSON.stringify({devDependencies: {'@playwright/test': '1.63.0'}}),
  '.node-version': '24.19.0\n',
});

// A fresh Ubuntu machine in a temporary directory: the fakes of `machineCommands` first on PATH, an os-release, the
// repositories under `origins/` (repository -> files), and the downloads provision fetches (Docker's and the GitHub
// CLI's keys, Docker's release file unless `dockerRepo` is false, a Node tarball whose npx and npm are fakes, and the
// dotnet-install and Claude Code installers, which install fakes). With `privateOrigins`, a fake git clones only when
// git's credential helpers give github.com credentials, and GitHub's App API answers github-app-token for the
// installation on `example`. `provision` runs the branch's script on it.
function machine(t, origins, {dockerRepo = true, ghRepo = true, privateOrigins = false} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'provision-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const state = join(root, 'machine');
  const bin = join(root, 'bin');
  const sys = join(root, 'sys');
  const home = join(root, 'home/triphammer');
  for (const dir of [state, bin, join(sys, 'etc'), join(sys, 'tmp'), join(state, 'shims'), join(state, 'claude'), join(state, 'codex'),
    join(root, 'downloads')]) mkdirSync(dir, {recursive: true});
  writeFileSync(join(sys, 'etc/os-release'), `NAME="Ubuntu"\nID=ubuntu\nVERSION_CODENAME=${codename}\n`);
  for (const name of machineCommands) fakeCommand(bin, name, join(state, name), 'machine');
  fakeCommand(join(state, 'shims'), 'claude', join(state, 'claude'));
  fakeCommand(join(state, 'shims'), 'codex', join(state, 'codex'));

  for (const [repo, files] of Object.entries(origins)) {
    const work = join(root, 'work', repo);
    mkdirSync(work, {recursive: true});
    git(work, 'init', '-q', '-b', 'main');
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(work, path, '..'), {recursive: true});
      writeFileSync(join(work, path), content);
    }
    git(work, 'add', '.');
    git(work, 'commit', '-q', '-m', 'first');
    git(root, 'clone', '-q', '--bare', work, join(root, 'origins', `${repo}.git`));
  }

  const download = (name, content, mode = 0o644) => {
    const path = join(root, 'downloads', name);
    writeFileSync(path, content, {mode});
    return path;
  };
  // The fake browsers start once libnss3 is installed, as Chromium does once its libraries are.
  download('chrome', `#!/bin/sh\n[ "$(dpkg-query -W -f='\${db:Status-Status}' libnss3)" = installed ] || exit 1\necho '<html><head></head><body></body></html>'\n`, 0o755);
  const node = join(root, 'node/node-v24.19.0-linux-x64/bin');
  mkdirSync(node, {recursive: true});
  writeFileSync(join(node, 'node'), '#!/bin/sh\n[ "$1" = --version ] && echo v24.19.0\n', {mode: 0o755});
  writeFileSync(join(node, 'npx'), `#!/bin/sh
echo "$*" >> '${state}/npx-calls'
b="$HOME/.cache/ms-playwright"
case "$*" in
  *"install --dry-run chromium") printf '  Install location:    %s\\n' "$b/chromium-1243" "$b/chromium_headless_shell-1243" ;;
  *"install chromium")
    mkdir -p "$b/chromium-1243/chrome-linux64" "$b/chromium_headless_shell-1243/chrome-headless-shell-linux64"
    cp '${root}/downloads/chrome' "$b/chromium-1243/chrome-linux64/chrome"
    cp '${root}/downloads/chrome' "$b/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell"
    touch "$b/chromium-1243/INSTALLATION_COMPLETE" "$b/chromium_headless_shell-1243/INSTALLATION_COMPLETE" ;;
  *"install-deps chromium") [ -e '${state}/deps-unsupported' ] && exit 1; apt-get install -y libnss3 ;;
esac
`, {mode: 0o755});
  writeFileSync(join(node, 'npm'), `#!/bin/sh
echo "$*" >> '${state}/npm-calls'
while [ $# -gt 0 ]; do [ "$1" = --prefix ] && p="$2"; shift; done
mkdir -p "$p/bin" && cp '${state}/shims/codex' "$p/bin/codex"
`, {mode: 0o755});
  const tarball = join(root, 'downloads/node-v24.19.0-linux-x64.tar.xz');
  run('tar', ['-cJf', tarball, '-C', join(root, 'node'), 'node-v24.19.0-linux-x64']);
  const sum = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  const dotnetInstall = download('dotnet-install.sh', `#!/bin/sh
echo "$*" >> '${state}/dotnet-install-calls'
while [ $# -gt 0 ]; do case "$1" in --version) v="$2" ;; --install-dir) d="$2" ;; esac; shift; done
mkdir -p "$d" && printf '#!/bin/sh\\n[ "$1" = --list-sdks ] && echo "%s [%s/sdk]"\\n' "$v" "$d" > "$d/dotnet" && chmod +x "$d/dotnet"
`);
  const claudeInstall = download('claude-install.sh', `#!/bin/sh
echo installed >> '${state}/claude-install-calls'
mkdir -p "$HOME/.local/bin" && cp '${state}/shims/claude' "$HOME/.local/bin/claude"
`);
  const downloads = {
    'https://download.docker.com/linux/ubuntu/gpg': download('docker.asc', 'docker key\n'),
    'https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-x64.tar.xz': tarball,
    'https://nodejs.org/dist/v24.19.0/SHASUMS256.txt': download('SHASUMS256.txt', `${'0'.repeat(64)}  node-v24.19.0-linux-arm64.tar.xz\n${sum}  node-v24.19.0-linux-x64.tar.xz\n`),
    'https://dot.net/v1/dotnet-install.sh': dotnetInstall,
    'https://claude.ai/install.sh': claudeInstall,
  };
  if (dockerRepo) downloads[dockerRelease] = download('Release', 'Origin: Docker\n');
  if (ghRepo) downloads[ghKey] = download('gh.gpg', 'gh key\n');
  if (privateOrigins) {
    fakeCommand(bin, 'git', join(state, 'git'), 'machine');
    downloads['https://api.github.com/app/installations'] = download('installations.json',
      JSON.stringify([{id: 41, account: {login: 'example'}}]));
    downloads['https://api.github.com/app/installations/41/access_tokens'] = download('access-token.json',
      JSON.stringify({token: 'ghs_fake', expires_at: new Date(Date.now() + 3600_000).toISOString().replace(/\.\d+Z$/, 'Z')}));
  }
  writeFileSync(join(state, 'machine.json'), JSON.stringify({bin, downloads, git: run('sh', ['-c', 'command -v git']).trim()}));

  const env = {...toolingEnv, PATH: `${bin}:${process.env.PATH}`, TRIPHAMMER_PROVISION_ROOT: sys,
    TRIPHAMMER_PROVISION_GIT_BASE: `file://${root}/origins/`};
  const calls = () => lines(join(state, 'calls')).map(line => JSON.parse(line));
  return {
    root, sys, home, state, calls,
    machine: () => JSON.parse(readFileSync(join(state, 'machine.json'), 'utf8')),
    provision(...args) {
      const before = calls().length;
      const result = spawnSync(join(here, 'provision'), args, {env, encoding: 'utf8'});
      return {status: result.status, stdout: result.stdout, stderr: result.stderr, output: result.stdout + result.stderr,
        calls: calls().slice(before)};
    },
  };
}

// The calls of a run that change the machine: any package, account, unit or AppArmor change, a download, and every
// command run as the user that writes (sh -c, npm, an installer through bash -c, git clone, npx install).
function changingCalls(calls) {
  return calls.filter(([command, ...args]) => {
    if (['dpkg-query', 'dpkg', 'getent', 'id', 'bwrap', 'git'].includes(command)) return false;
    if (command === 'loginctl') return args[0] !== 'show-user';
    if (command === 'curl') return !args.includes('-fsSIL');
    if (command !== 'runuser') return true;
    const inner = args.slice(args.indexOf('--') + 1).filter(arg => !arg.includes('=') || arg.startsWith('-')).slice(2);
    const [name, ...rest] = inner;
    if (name === 'sh' || name === 'npm') return true;
    if (name === 'bash') return rest.join(' ').includes('curl');
    if (name === 'git') return rest.includes('clone') || (rest[0] === 'config' && !rest.includes('--get') && !rest.includes('--get-all'));
    if (name === 'npx') return !rest.includes('--dry-run');
    if (name === 'claude') return !rest.includes('list') && !rest.includes('--version');
    return false;
  });
}

const today = ['--triphammer', 'example/example-project', '/CHECKOUT', '--project', 'example/example-project', '/CHECKOUT',
  '--app-author', 'app/example-agents'];
// The arguments with /CHECKOUT made a path in the machine's temporary directory, and `--home` its user's home.
const at = (m, args) => [...args.map(arg => arg.replace(/^\/CHECKOUT/, join(m.root, 'checkouts'))), '--home', m.home];

for (const [what, args, message] of [
  ['no argument', [], /--triphammer is missing/],
  ['an unknown flag', [...today, '--frobnicate'], /unknown argument --frobnicate/],
  ['a --triphammer without its checkout', ['--triphammer', 'example/x'], /--triphammer needs a repository and a checkout/],
  ['--triphammer twice', [...today, '--triphammer', 'example/x', '/x'], /--triphammer is given twice/],
  ['a repository that is not owner/name', ['--triphammer', 'nope', '/x', ...today.slice(3)], /--triphammer takes a repository as owner\/name, not nope/],
  ['a relative checkout', [...today.slice(0, 3), '--project', 'example/y', 'y', ...today.slice(6)], /the checkout must be an absolute path/],
  ['a checkout with ..', [...today, '--project', 'example/y', '/srv/../y'], /without \. or \.\. parts/],
  ['no --project', [...today.slice(0, 3), ...today.slice(6)], /no --project is given/],
  ['no --app-author', today.slice(0, 6), /--app-author is missing/],
  ['--modules before any --project', ['--modules', 'demo', ...today], /--modules applies to the --project before it/],
  ['an unknown module', [...today, '--modules', 'nope'], /MODULES names nope, which is not a module/],
  ['--modules twice for a project', [...today.slice(0, 6), '--modules', 'codex', '--modules', 'demo', ...today.slice(6)],
    /--modules is given twice for example\/example-project/],
  ['a module without its settings', [...today.slice(0, 6), '--modules', 'demo', '--set', 'DEMO_URL=http://gallery.example.invalid/', ...today.slice(6)],
    /the demo module needs DEMO_GALLERY_DIR/],
  ['--set of a setting that is not one', [...today.slice(0, 6), '--set', 'NOPE=1', ...today.slice(6)], /--set names NOPE, which is not a setting --set may give/],
  ['--set of REPO', [...today.slice(0, 6), '--set', 'REPO=a/b', ...today.slice(6)], /--set cannot give REPO; --project gives it/],
  ['--set without =', [...today.slice(0, 6), '--set', 'STATUS_PORT', ...today.slice(6)], /--set takes KEY=VALUE/],
  ['--set twice', [...today.slice(0, 6), '--set', 'STATUS_PORT=1', '--set', 'STATUS_PORT=2', ...today.slice(6)], /--set gives STATUS_PORT twice/],
  ['--set with a malformed value', [...today.slice(0, 6), '--set', 'STATUS_PORT=99999', ...today.slice(6)],
    /--project example\/example-project: .*STATUS_PORT must be a port from 1 to 65535, not 99999/],
  ['--set of OWNER that is not a login', [...today.slice(0, 6), '--set', 'OWNER=Example-Org/example-project', ...today.slice(6)],
    /--project example\/example-project: .*OWNER must be one GitHub login/],
  ['--set with a line break', [...today.slice(0, 6), '--set', 'DEMO_URL=http://a/\nREPO=x/y', ...today.slice(6)], /may not hold a line break/],
  ['--set before any --project', ['--set', 'STATUS_PORT=1', ...today], /--set applies to the --project before it/],
  ['a project given twice', [...today, '--project', 'example/example-project', '/elsewhere'], /--project example\/example-project is given twice/],
  ['two projects at one checkout', [...today, '--project', 'example/other', '/CHECKOUT'], /share the checkout/],
  ['a project at Triphammer\'s checkout of another repository', [...today.slice(0, 3), '--project', 'example/other', '/CHECKOUT', ...today.slice(6)],
    /uses the checkout of --triphammer example\/example-project, another repository/],
  ['a malformed --user', [...today, '--user', 'Bad User'], /--user must be a user name/],
  ['a relative --home', [...today, '--home', 'home'], /--home must be an absolute path/],
]) {
  test(`${what} stops provision with exit 2 and the usage before anything runs`, t => {
    const m = machine(t, {});
    const result = m.provision(...args.map(arg => arg.replace(/^\/CHECKOUT/, join(m.root, 'checkouts'))));
    assert.equal(result.status, 2, result.output);
    assert.match(result.stderr, message);
    assert.match(result.stderr, /^usage: provision --triphammer/m);
    assert.deepEqual(result.calls, []);
  });
}

test('on a fresh machine it installs everything for one repository that is Triphammer and its one project, and a second run changes nothing', t => {
  const m = machine(t, {'example/example-project': {...triphammerFiles, ...projectFiles('example-project')}});
  const checkout = join(m.root, 'checkouts');
  const first = m.provision(...at(m, today));
  assert.equal(first.status, 0, first.output);

  const {packages, users, linger} = m.machine();
  for (const name of ['git', 'jq', 'python3', 'curl', 'docker-ce', 'docker-compose-plugin', 'gh']) assert.ok(packages.includes(name), name);
  for (const name of ['codex', 'bubblewrap', 'ffmpeg', 'docker.io']) assert.ok(!packages.includes(name), name);
  assert.match(first.stdout, /^Docker Engine: from Docker's repository$/m);
  assert.match(first.stdout, /^GitHub CLI: from the GitHub CLI's repository$/m);
  assert.match(readFileSync(join(m.sys, 'etc/apt/sources.list.d/docker.sources'), 'utf8'), new RegExp(`^Suites: ${codename}$`, 'm'));
  assert.deepEqual(users.triphammer, {home: m.home, groups: ['triphammer', 'docker']});
  assert.deepEqual(linger, ['triphammer']);

  assert.equal(git(checkout, 'remote', 'get-url', 'origin'), `file://${m.root}/origins/example/example-project.git`);
  for (const name of scripts) assert.equal(readlinkSync(join(m.home, '.local/bin', name)), join(checkout, 'bin', name));
  assert.equal(readlinkSync(join(m.home, '.local/bin/triphammer-status')), join(checkout, 'status/server.mjs'));
  for (const name of units) assert.equal(readlinkSync(join(m.home, '.config/systemd/user', name)), join(checkout, 'systemd', name));
  assert.equal(readlinkSync(join(m.home, '.config/systemd/user/triphammer-status.service')), join(checkout, 'systemd/triphammer-status.service'));
  assert.ok(m.calls().some(([command, ...args]) => command === 'systemctl' && args.join(' ') === '--machine=triphammer@ --user daemon-reload'));
  assert.ok(!m.calls().some(([command, ...args]) => command === 'systemctl' && args.includes('enable')), 'provision enabled a unit');

  const config = join(m.home, '.config/triphammer/example-project.conf');
  assert.equal(readFileSync(config, 'utf8'), '# Written by bin/provision; bin/README.md (Configuration) describes each setting.\n'
    + `REPO=example/example-project\nCHECKOUT=${checkout}\nAPP_AUTHOR=app/example-agents\n`
    + `STATE_DIR=${m.home}/.local/state/triphammer/projects/example-project\n`);
  assert.equal(statSync(config).mode & 0o777, 0o600);
  assert.equal(statSync(join(m.home, '.config/github-app')).mode & 0o777, 0o700);
  assert.deepEqual(readdir(join(m.home, '.config/github-app')), []);
  assert.equal(run('git', ['config', '--file', join(m.home, '.gitconfig'), '--get-all', 'credential.https://github.com.helper']),
    '\n!github-app-token git-credential\n');
  const gitConfig = key => run('git', ['config', '--file', join(m.home, '.gitconfig'), '--get', key]).trim();
  assert.equal(gitConfig('credential.https://github.com.useHttpPath'), 'true');
  assert.equal(gitConfig('user.name'), 'example-agents[bot]');
  assert.equal(gitConfig('user.email'), 'example-agents[bot]@users.noreply.github.com');

  assert.equal(run(join(m.sys, 'usr/local/bin/node'), ['--version']), 'v24.19.0\n');
  assert.deepEqual(lines(join(m.state, 'dotnet-install-calls')), [`--version 10.0.400 --install-dir ${m.home}/.dotnet --no-path`]);
  const dropIn = join(m.home, '.config/systemd/user/ticket-runner@.service.d/dotnet.conf');
  assert.equal(readFileSync(dropIn, 'utf8'), '[Service]\nEnvironment=PATH=%h/.local/bin:%h/.dotnet:%h/.dotnet/tools:/usr/local/bin:/usr/bin:/bin\n'
    + 'Environment=DOTNET_ROOT=%h/.dotnet\n');
  assert.equal(statSync(dropIn).mode & 0o777, 0o644);
  assert.match(first.stdout, /^\+ write .*ticket-runner@\.service\.d\/dotnet\.conf\n\+ reload triphammer's systemd units$/m);
  assert.deepEqual(lines(join(m.state, 'claude-install-calls')), ['installed']);
  assert.deepEqual(JSON.parse(readFileSync(join(m.state, 'claude/plugins.json'), 'utf8')),
    {marketplaces: [{name: 'triphammer'}], plugins: [{id: 'triphammer@triphammer', scope: 'user'}]});
  assert.ok(lines(join(m.state, 'npx-calls')).includes('-y playwright@1.63.0 install chromium'));
  assert.ok(lines(join(m.state, 'npx-calls')).includes('-y playwright@1.63.0 install-deps chromium'));
  assert.ok(existsSync(join(m.home, '.cache/ms-playwright/chromium-1243/INSTALLATION_COMPLETE')));
  assert.ok(!existsSync(join(m.state, 'npm-calls')), 'Codex was installed without the codex module');

  assert.match(first.stdout, /change\(s\) made\./);
  assert.match(first.stdout, new RegExp(`Put the App's files in ${m.home}/\\.config/github-app`));
  assert.match(first.stdout, /sudo -iu triphammer env XDG_RUNTIME_DIR=\/run\/user\/1001 TRIPHAMMER_PROJECT=example-project ticket-runner --doctor/);
  assert.match(first.stdout, /sudo systemctl --machine=triphammer@ --user enable --now ticket-runner@example-project\.timer merge-when-ready@example-project\.timer$/m);

  const changed = changingCalls(first.calls).map(call => call.join(' '));
  for (const pattern of [/^runuser .* git .*clone /, /^runuser .* sh -c /, /^apt-get install /, /^useradd /, /^systemctl .* link /]) {
    assert.ok(changed.some(call => pattern.test(call)), `the first run's changes include ${pattern}`);
  }

  const second = m.provision(...at(m, today));
  assert.equal(second.status, 0, second.output);
  assert.match(second.stdout, /^Nothing to change: the machine is as asked\.$/m);
  assert.doesNotMatch(second.stdout, /^\+ /m);
  assert.deepEqual(changingCalls(second.calls), []);

  // A config the owner changed is rewritten with the values given, and the one it replaces is kept beside it.
  writeFileSync(config, 'REPO=example/example-project\n', {mode: 0o600});
  const third = m.provision(...at(m, today));
  assert.equal(third.status, 0, third.output);
  assert.match(third.stdout, /^\+ rewrite .*example-project\.conf \(the file it replaces is kept as .*example-project\.conf\.old\)$/m);
  assert.equal(readFileSync(`${config}.old`, 'utf8'), 'REPO=example/example-project\n');
  assert.match(readFileSync(config, 'utf8'), /^APP_AUTHOR=app\/example-agents$/m);
});

test('a commit identity the user has already is kept, and one given by an account rather than an App is that account', t => {
  const m = machine(t, {'example/example-project': {...triphammerFiles, ...projectFiles('example-project')}});
  mkdirSync(m.home, {recursive: true});
  writeFileSync(join(m.home, '.gitconfig'), '[user]\n\tname = Someone Chosen\n');
  const args = at(m, today).map(arg => arg === 'app/example-agents' ? 'example-account' : arg);
  const result = m.provision(...args);
  assert.equal(result.status, 0, result.output);
  const gitConfig = key => run('git', ['config', '--file', join(m.home, '.gitconfig'), '--get', key]).trim();
  assert.equal(gitConfig('user.name'), 'Someone Chosen');
  assert.equal(gitConfig('user.email'), 'example-account@users.noreply.github.com');
  assert.doesNotMatch(result.stdout, /set git's user\.name/);
  assert.match(m.provision(...args).stdout, /^Nothing to change/m);
});

test('a private repository: the first run creates the App\'s directory and stops at the clone, and once the owner places the App\'s files the next run clones with its token', t => {
  const m = machine(t, {'example/example-project': {...triphammerFiles, ...projectFiles('example-project')}}, {privateOrigins: true});
  const checkout = join(m.root, 'checkouts');
  const app = join(m.home, '.config/github-app');
  const first = m.provision(...at(m, today));
  assert.equal(first.status, 1, first.output);
  assert.match(first.stderr, new RegExp(`could not clone example/example-project into ${checkout}; a private repository needs the App's files in ${app} first`));
  assert.equal(statSync(app).mode & 0o777, 0o700);
  assert.deepEqual(readdir(app), []);
  assert.ok(!existsSync(join(checkout, '.git')), 'the clone happened without credentials');
  assert.deepEqual(readdir(join(m.sys, 'tmp')), [], 'the copy of github-app-token was left behind');

  writeFileSync(join(app, 'app-id'), '12345\n', {mode: 0o600});
  writeFileSync(join(app, 'owner'), 'example\n', {mode: 0o600});
  run('openssl', ['genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048', '-out', join(app, 'agents.pem')]);
  const second = m.provision(...at(m, today));
  assert.equal(second.status, 0, second.output);
  assert.equal(git(checkout, 'remote', 'get-url', 'origin'), `file://${m.root}/origins/example/example-project.git`);
  const clones = second.calls.filter(([command, ...args]) => command === 'git' && args.includes('clone'));
  assert.equal(clones.length, 1);
  assert.match(clones[0].join(' '), new RegExp(`-c credential\\.https://github\\.com\\.helper= -c credential\\.https://github\\.com\\.helper=!${m.sys}/tmp/github-app-token\\.\\w+/github-app-token git-credential clone `));
  assert.deepEqual(readdir(join(m.sys, 'tmp')), [], 'the copy of github-app-token was left behind');
  assert.ok(!second.output.includes('ghs_fake'), 'the token reached the output');
  assert.match(m.provision(...at(m, today)).stdout, /^Nothing to change/m);
});

const readdir = path => run('ls', ['-A', path]).split('\n').filter(Boolean);

test('Triphammer\'s own repository serving two projects, with their modules, gets one config each, and a second run changes nothing', t => {
  const m = machine(t, {
    'example/triphammer': triphammerFiles,
    'example/example-project': {...projectFiles('example-project'), '.node-version': '24.19.0\n'},
    'example/other': {'.triphammer/project.json': JSON.stringify({name: 'other'})},
  });
  const tri = join(m.root, 'triphammer');
  const args = ['--triphammer', 'example/triphammer', tri, '--app-author', 'app/example-agents',
    '--project', 'example/example-project', join(m.root, 'example-project'), '--modules', 'codex,demo',
    '--set', 'CODEX_AUDIT_MODEL=gpt-test', '--set', 'CODEX_SECURITY_MODEL=gpt-test',
    '--set', 'DEMO_GALLERY_DIR=/srv/gallery', '--set', 'DEMO_URL=http://gallery.example.invalid/',
    '--project', 'example/other', join(m.root, 'srv/other'), '--set', 'STATE_DIR=/srv/state/other',
    '--set', 'OWNER=example-person', '--home', m.home];
  const first = m.provision(...args);
  assert.equal(first.status, 0, first.output);

  for (const name of scripts) assert.equal(readlinkSync(join(m.home, '.local/bin', name)), join(tri, 'bin', name));
  assert.equal(git(join(m.root, 'srv/other'), 'remote', 'get-url', 'origin'), `file://${m.root}/origins/example/other.git`);
  assert.equal(readFileSync(join(m.home, '.config/triphammer/example-project.conf'), 'utf8').split('\n').slice(1).join('\n'),
    `REPO=example/example-project\nCHECKOUT=${m.root}/example-project\nAPP_AUTHOR=app/example-agents\n`
    + `STATE_DIR=${m.home}/.local/state/triphammer/projects/example-project\nMODULES=codex,demo\nCODEX_AUDIT_MODEL=gpt-test\n`
    + 'CODEX_SECURITY_MODEL=gpt-test\nDEMO_GALLERY_DIR=/srv/gallery\nDEMO_URL=http://gallery.example.invalid/\n');
  assert.equal(readFileSync(join(m.home, '.config/triphammer/other.conf'), 'utf8').split('\n').slice(1).join('\n'),
    `REPO=example/other\nCHECKOUT=${m.root}/srv/other\nAPP_AUTHOR=app/example-agents\nSTATE_DIR=/srv/state/other\n`
    + 'OWNER=example-person\n');

  const {packages, loaded} = m.machine();
  for (const name of ['bubblewrap', 'apparmor', 'ffmpeg']) assert.ok(packages.includes(name), name);
  assert.deepEqual(lines(join(m.state, 'npm-calls')), [`install -g -q --prefix ${m.home}/.local @openai/codex`]);
  assert.match(readFileSync(join(m.sys, 'etc/apparmor.d/bwrap'), 'utf8'), /^profile bwrap \/usr\/bin\/bwrap flags=\(unconfined\) \{\n {2}userns,$/m);
  assert.deepEqual(loaded, ['bwrap']);
  assert.deepEqual(JSON.parse(readFileSync(join(m.state, 'claude/plugins.json'), 'utf8')).marketplaces, [{name: 'triphammer'}]);
  assert.ok(m.calls().some(([command, ...args]) => command === 'runuser' && args.join(' ').endsWith(`claude plugin marketplace add ${tri}`)));
  assert.match(first.stdout, /Log Codex in: sudo -iu triphammer codex login/);
  assert.match(first.stdout, /enable --now ticket-runner@example-project\.timer merge-when-ready@example-project\.timer demo-gallery@example-project\.service$/m);
  assert.match(first.stdout, /enable --now ticket-runner@other\.timer merge-when-ready@other\.timer$/m);

  const second = m.provision(...args);
  assert.equal(second.status, 0, second.output);
  assert.match(second.stdout, /^Nothing to change: the machine is as asked\.$/m);
  assert.deepEqual(changingCalls(second.calls), []);
});

test('checkouts that pin no .NET SDK get none, and no drop-in puts one on the units\' PATH', t => {
  const m = machine(t, {
    'example/triphammer': triphammerFiles,
    'example/other': {'.triphammer/project.json': JSON.stringify({name: 'other'})},
  });
  const result = m.provision('--triphammer', 'example/triphammer', join(m.root, 'triphammer'), '--app-author', 'app/example-agents',
    '--project', 'example/other', join(m.root, 'other'), '--home', m.home);
  assert.equal(result.status, 0, result.output);
  assert.ok(!existsSync(join(m.state, 'dotnet-install-calls')), 'a .NET SDK was installed');
  assert.ok(!existsSync(join(m.home, '.config/systemd/user/ticket-runner@.service.d')), 'a drop-in was written');
});

test('without the vendors\' repositories for the release, Docker and gh come from Ubuntu\'s archive, and Chromium\'s libraries too when Playwright cannot install them', t => {
  const m = machine(t, {'example/example-project': {...triphammerFiles, ...projectFiles('example-project')}}, {dockerRepo: false, ghRepo: false});
  writeFileSync(join(m.state, 'deps-unsupported'), '');
  const result = m.provision(...at(m, today));
  assert.equal(result.status, 0, result.output);
  assert.match(result.stdout, /^Docker Engine: from Ubuntu's archive \(docker\.io, docker-compose-v2\), as Docker's repository does not serve resolute$/m);
  assert.match(result.stdout, /^GitHub CLI: from Ubuntu's archive \(gh\)/m);
  assert.match(result.stdout, /^Playwright's install-deps does not support this release; installing Chromium's libraries from Ubuntu's archive$/m);
  const {packages} = m.machine();
  for (const name of ['docker.io', 'docker-compose-v2', 'gh', 'libnss3', 'libgbm1']) assert.ok(packages.includes(name), name);
  assert.ok(!packages.includes('docker-ce'));
  assert.ok(!existsSync(join(m.sys, 'etc/apt/sources.list.d/github-cli.sources')), 'the failed vendor repository was left behind');
  assert.match(m.provision(...at(m, today)).stdout, /^Nothing to change/m);
});

test('a Chromium that still does not start headless stops provision with exit 1', t => {
  const m = machine(t, {'example/example-project': {...triphammerFiles, ...projectFiles('example-project')}});
  // A browser that fails whatever libraries are installed.
  writeFileSync(join(m.root, 'downloads/chrome'), '#!/bin/sh\nexit 1\n', {mode: 0o755});
  const result = m.provision(...at(m, today));
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /Playwright 1\.63\.0's Chromium still does not start headless/);
});

test('--dry-run on a fresh machine lists the changes and makes none', t => {
  const m = machine(t, {'example/example-project': {...triphammerFiles, ...projectFiles('example-project')}});
  const result = m.provision(...at(m, today), '--dry-run');
  assert.equal(result.status, 0, result.output);
  assert.match(result.stdout, /^would: install ca-certificates curl git jq python3 openssl xz-utils$/m);
  assert.match(result.stdout, /^would: create the user triphammer with the home /m);
  assert.match(result.stdout, /^would: clone example\/example-project into /m);
  assert.match(result.stdout, /^would: write the config file of example\/example-project, named after its project file, once it is cloned$/m);
  assert.match(result.stdout, /sudo -iu triphammer env XDG_RUNTIME_DIR=\/run\/user\/<uid> TRIPHAMMER_PROJECT=<name> ticket-runner --doctor/);
  assert.match(result.stdout, /change\(s\) to make; nothing was changed\./);
  assert.doesNotMatch(result.stdout, /^\+ /m);
  assert.deepEqual(changingCalls(result.calls), []);
  assert.ok(!existsSync(m.home) && !existsSync(join(m.root, 'checkouts')) && !existsSync(join(m.sys, 'etc/apt')));
});

test('a checkout path that holds something else stops provision with exit 1 before anything changes', t => {
  const m = machine(t, {'example/example-project': {...triphammerFiles, ...projectFiles('example-project')}});
  mkdirSync(join(m.root, 'checkouts'));
  writeFileSync(join(m.root, 'checkouts/stray'), 'x\n');
  const result = m.provision(...at(m, today));
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /checkouts exists and is not triphammer's clone of example\/example-project; move it away/);
  assert.deepEqual(changingCalls(result.calls), []);
});

test('checkouts that pin different Node versions stop provision with exit 1', t => {
  const m = machine(t, {
    'example/triphammer': {...triphammerFiles, '.node-version': '24.20.0\n'},
    'example/example-project': projectFiles('example-project'),
  });
  const result = m.provision('--triphammer', 'example/triphammer', join(m.root, 'triphammer'), '--app-author', 'app/example-agents',
    '--project', 'example/example-project', join(m.root, 'example-project'), '--home', m.home);
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /the checkouts pin different Node versions \(24\.20\.0 24\.19\.0\)/);
});
