import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {git, lines, run} from './fixture.mjs';
import {changingCalls, machine, projectFiles, readdir, triphammerFiles} from './provision-fixture.mjs';

// A machine provision has set up with Triphammer's checkout at <root>/triphammer (Triphammer's repository holding the
// project files too, when `ownProject` is set), and, unless `app` is false, the App's files placed.
function ready(t, origins = {}, {ownProject = false, app = true, ...options} = {}) {
  const files = ownProject ? {...triphammerFiles, ...projectFiles('example-project')} : triphammerFiles;
  const m = machine(t, {'example/triphammer': files, ...origins}, options);
  if (options.privateOrigins) m.placeApp();
  const result = m.provision('--triphammer', 'example/triphammer', join(m.root, 'triphammer'), '--home', m.home);
  assert.equal(result.status, 0, result.output);
  if (app && !options.privateOrigins) m.placeApp();
  return m;
}
const gitConfig = (m, key) => run('git', ['config', '--file', join(m.home, '.gitconfig'), '--get', key]).trim();

const project = ['example/example-project', '/CHECKOUT'];
for (const [what, args, message] of [
  ['no argument', [], /no repository is given/],
  ['a repository that is not owner/name', ['nope'], /the repository must be owner\/name, not nope/],
  ['an unknown flag', [...project, '--frobnicate'], /unknown argument --frobnicate/],
  ['a third argument', [...project, 'more'], /unexpected argument more/],
  ['an unknown module', [...project, '--modules', 'nope'], /MODULES names nope, which is not a module/],
  ['--modules twice', [...project, '--modules', 'codex', '--modules', 'demo'], /--modules is given twice/],
  ['--unset of REPO', [...project, '--unset', 'REPO'], /--unset cannot remove REPO/],
  ['--unset of CHECKOUT', [...project, '--unset', 'CHECKOUT'], /--unset cannot remove CHECKOUT/],
  ['--unset of APP_AUTHOR', [...project, '--unset', 'APP_AUTHOR'], /--unset cannot remove APP_AUTHOR; every config has it/],
  ['--unset of what is not a key', [...project, '--unset', 'owner'], /--unset takes a setting's name, not owner/],
  ['--unset twice', [...project, '--unset', 'OWNER', '--unset', 'OWNER'], /--unset names OWNER twice/],
  ['--set and --unset of one key', [...project, '--set', 'OWNER=example-person', '--unset', 'OWNER'], /--set and --unset both name OWNER/],
  ['--modules and --unset MODULES', [...project, '--modules', '', '--unset', 'MODULES'], /--modules and --unset MODULES are both given/],
  ['--set of a setting that is not one', [...project, '--set', 'NOPE=1'], /--set names NOPE, which is not a setting --set may give/],
  ['--set of REPO', [...project, '--set', 'REPO=a/b'], /--set cannot give REPO/],
  ['--set of APP_AUTHOR', [...project, '--set', 'APP_AUTHOR=x'], /--set cannot give APP_AUTHOR; --app-author gives it/],
  ['--set without =', [...project, '--set', 'STATUS_PORT'], /--set takes KEY=VALUE/],
  ['--set twice', [...project, '--set', 'STATUS_PORT=1', '--set', 'STATUS_PORT=2'], /--set gives STATUS_PORT twice/],
  ['--set with a malformed value', [...project, '--set', 'STATUS_PORT=99999'],
    /example\/example-project: .*STATUS_PORT must be a port from 1 to 65535, not 99999/],
  ['--set of OWNER that is not a login', [...project, '--set', 'OWNER=Example-Org/example-project'], /OWNER must be one GitHub login/],
  ['--set with a line break', [...project, '--set', 'DEMO_URL=http://a/\nREPO=x/y'], /may not hold a line break/],
  ['an --app-author that is not a login', [...project, '--app-author', 'app/two words'], /--app-author must be a login or app\/<slug>/],
]) {
  test(`${what} stops provision-project with exit 2 and the usage before anything runs`, t => {
    const m = machine(t, {});
    const result = m.project(...args.map(arg => arg.replace(/^\/CHECKOUT/, join(m.root, 'example-project'))));
    assert.equal(result.status, 2, result.output);
    assert.match(result.stderr, message);
    assert.match(result.stderr, /^usage: provision-project /m);
    assert.deepEqual(result.calls, []);
  });
}

test('a machine provision has not set up stops provision-project with exit 1, naming the machine file', t => {
  const m = machine(t, {});
  const result = m.project('example/example-project');
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /etc\/triphammer\.conf is missing; set the machine up first/);
  assert.deepEqual(result.calls, []);
});

for (const [what, args, message] of [
  ['a relative checkout', ['example/example-project', 'srv/x'], /the checkout must be an absolute path/],
  ['another repository at Triphammer\'s checkout', ['example/other', '/TRIPHAMMER'], /example\/other would use Triphammer's checkout .*, which holds example\/triphammer/],
]) {
  test(`${what} stops provision-project with exit 2 before anything changes`, t => {
    const m = ready(t);
    const result = m.project(...args.map(arg => arg.replace(/^\/TRIPHAMMER$/, join(m.root, 'triphammer'))));
    assert.equal(result.status, 2, result.output);
    assert.match(result.stderr, message);
    assert.deepEqual(changingCalls(result.calls), []);
  });
}

test("Triphammer's own repository as a project shares its checkout, gets its toolchains, config and identity from the App's slug, and a second run changes nothing", t => {
  const m = ready(t, {}, {ownProject: true});
  const checkout = join(m.root, 'triphammer');
  const first = m.project('example/triphammer');
  assert.equal(first.status, 0, first.output);
  assert.match(first.stdout, /^APP_AUTHOR: app\/example-agents, the App's slug$/m);
  assert.ok(!first.calls.some(([command, ...args]) => command === 'runuser' && args.includes('clone')), 'the shared checkout was cloned again');

  const config = join(m.home, '.config/triphammer/example-project.conf');
  assert.equal(readFileSync(config, 'utf8'), '# Written by bin/provision-project; bin/README.md (Configuration) describes each setting.\n'
    + `REPO=example/triphammer\nCHECKOUT=${checkout}\nAPP_AUTHOR=app/example-agents\n`
    + `STATE_DIR=${m.home}/.local/state/triphammer/projects/example-project\n`);
  assert.equal(statSync(config).mode & 0o777, 0o600);
  assert.equal(gitConfig(m, 'user.name'), 'example-agents[bot]');
  assert.equal(gitConfig(m, 'user.email'), 'example-agents[bot]@users.noreply.github.com');

  assert.deepEqual(lines(join(m.state, 'dotnet-install-calls')), [`--version 10.0.400 --install-dir ${m.home}/.dotnet --no-path`]);
  const dropIn = join(m.home, '.config/systemd/user/ticket-runner@.service.d/dotnet.conf');
  assert.equal(readFileSync(dropIn, 'utf8'), '[Service]\nEnvironment=PATH=%h/.local/bin:%h/.dotnet:%h/.dotnet/tools:/usr/local/bin:/usr/bin:/bin\n'
    + 'Environment=DOTNET_ROOT=%h/.dotnet\n');
  assert.equal(statSync(dropIn).mode & 0o777, 0o644);
  assert.match(first.stdout, /^\+ write .*ticket-runner@\.service\.d\/dotnet\.conf\n\+ reload triphammer's systemd units$/m);
  assert.ok(lines(join(m.state, 'npx-calls')).includes('-y playwright@1.63.0 install chromium'));
  assert.ok(lines(join(m.state, 'npx-calls')).includes('-y playwright@1.63.0 install-deps chromium'));
  assert.ok(existsSync(join(m.home, '.cache/ms-playwright/chromium-1243/INSTALLATION_COMPLETE')));
  assert.ok(!existsSync(join(m.state, 'npm-calls')), 'Codex was installed without the codex module');
  assert.ok(!m.calls().some(([command, ...args]) => command === 'systemctl' && args.includes('enable')), 'provision-project enabled a unit');
  assert.match(first.stdout, /\nproject: example-project\n$/);
  assert.deepEqual(readdir(join(m.sys, 'tmp')), [], 'the copy of github-app-token was left behind');

  const second = m.project('example/triphammer');
  assert.equal(second.status, 0, second.output);
  assert.match(second.stdout, /^Nothing to change: the machine is as asked\.$/m);
  assert.doesNotMatch(second.stdout, /^\+ /m);
  assert.deepEqual(changingCalls(second.calls), []);

  // A config the owner changed is rewritten with the values given, and the one it replaces is kept beside it.
  writeFileSync(config, 'REPO=example/triphammer\n', {mode: 0o600});
  const third = m.project('example/triphammer');
  assert.equal(third.status, 0, third.output);
  assert.match(third.stdout, /^\+ rewrite .*example-project\.conf \(the file it replaces is kept as .*example-project\.conf\.old\)$/m);
  assert.equal(readFileSync(`${config}.old`, 'utf8'), 'REPO=example/triphammer\n');
  assert.match(readFileSync(config, 'utf8'), /^APP_AUTHOR=app\/example-agents$/m);
});

test('without --app-author and without the App\'s files it stops with exit 1 before anything changes, naming what to place', t => {
  const m = ready(t, {'example/example-project': projectFiles('example-project')}, {app: false});
  const result = m.project('example/example-project', join(m.root, 'example-project'));
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /no --app-author is given, and the App's slug could not be read \(.*app-id is missing.*\); place app-id and agents\.pem in .*\.config\/github-app, or give --app-author app\/<slug>/);
  assert.deepEqual(changingCalls(result.calls), []);
  assert.ok(!existsSync(join(m.root, 'example-project')));
});

test('a commit identity the user has already is kept, and one given by an account rather than an App is that account', t => {
  const m = ready(t, {'example/example-project': projectFiles('example-project')}, {app: false});
  writeFileSync(join(m.home, '.gitconfig'), `${readFileSync(join(m.home, '.gitconfig'), 'utf8')}[user]\n\tname = Someone Chosen\n`);
  const args = ['example/example-project', join(m.root, 'example-project'), '--app-author', 'example-account'];
  const result = m.project(...args);
  assert.equal(result.status, 0, result.output);
  assert.equal(gitConfig(m, 'user.name'), 'Someone Chosen');
  assert.equal(gitConfig(m, 'user.email'), 'example-account@users.noreply.github.com');
  assert.doesNotMatch(result.stdout, /set git's user\.name/);
  assert.match(readFileSync(join(m.home, '.config/triphammer/example-project.conf'), 'utf8'), /^APP_AUTHOR=example-account$/m);
  assert.match(m.project(...args).stdout, /^Nothing to change/m);
});

test('two projects, with their modules, get one config and their own extras each, and a second run changes nothing', t => {
  const m = ready(t, {
    'example/example-project': projectFiles('example-project'),
    'example/other': {'.triphammer/project.json': JSON.stringify({name: 'other'})},
  });
  const one = ['example/example-project', join(m.root, 'example-project'), '--modules', 'codex,demo',
    '--set', 'CODEX_AUDIT_MODEL=gpt-test', '--set', 'CODEX_SECURITY_MODEL=gpt-test',
    '--set', 'DEMO_GALLERY_DIR=/srv/gallery', '--set', 'DEMO_URL=http://gallery.example.invalid/'];
  const two = ['example/other', join(m.root, 'srv/other'), '--set', 'STATE_DIR=/srv/state/other', '--set', 'OWNER=example-person'];
  const first = m.project(...one);
  assert.equal(first.status, 0, first.output);
  const other = m.project(...two);
  assert.equal(other.status, 0, other.output);

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
  assert.match(first.stdout, /Log Codex in: sudo -iu triphammer codex login/);
  assert.doesNotMatch(other.stdout, /Log Codex in/);
  assert.match(other.stdout, /\nproject: other\n$/);

  for (const args of [one, two]) {
    const again = m.project(...args);
    assert.equal(again.status, 0, again.output);
    assert.match(again.stdout, /^Nothing to change: the machine is as asked\.$/m);
    assert.deepEqual(changingCalls(again.calls), []);
  }
});

test("a private project clones with the App's token, and the token never reaches the output", t => {
  const m = ready(t, {'example/example-project': projectFiles('example-project')}, {privateOrigins: true});
  const checkout = join(m.root, 'example-project');
  const result = m.project('example/example-project', checkout);
  assert.equal(result.status, 0, result.output);
  assert.equal(git(checkout, 'remote', 'get-url', 'origin'), `file://${m.root}/origins/example/example-project.git`);
  assert.ok(!result.output.includes('ghs_fake'), 'the token reached the output');
  assert.deepEqual(readdir(join(m.sys, 'tmp')), [], 'the copy of github-app-token was left behind');
});

test('a checkout that pins no .NET SDK gets none, and no drop-in puts one on the units\' PATH', t => {
  const m = ready(t, {'example/other': {'.triphammer/project.json': JSON.stringify({name: 'other'})}});
  const result = m.project('example/other', join(m.root, 'other'));
  assert.equal(result.status, 0, result.output);
  assert.ok(!existsSync(join(m.state, 'dotnet-install-calls')), 'a .NET SDK was installed');
  assert.ok(!existsSync(join(m.home, '.config/systemd/user/ticket-runner@.service.d')), 'a drop-in was written');
});

test('Chromium\'s libraries come from Ubuntu\'s archive when Playwright cannot install them', t => {
  const m = ready(t, {'example/example-project': projectFiles('example-project')});
  writeFileSync(join(m.state, 'deps-unsupported'), '');
  const result = m.project('example/example-project', join(m.root, 'example-project'));
  assert.equal(result.status, 0, result.output);
  assert.match(result.stdout, /^Playwright's install-deps does not support this release; installing Chromium's libraries from Ubuntu's archive$/m);
  const {packages} = m.machine();
  for (const name of ['libnss3', 'libgbm1']) assert.ok(packages.includes(name), name);
  assert.match(m.project('example/example-project', join(m.root, 'example-project')).stdout, /^Nothing to change/m);
});

test('run from a directory holding a Playwright and an .npmrc the service user could plant, every npx runs from /', t => {
  const m = ready(t, {'example/example-project': projectFiles('example-project')});
  const planted = join(m.root, 'planted');
  mkdirSync(join(planted, 'node_modules/.bin'), {recursive: true});
  writeFileSync(join(planted, 'node_modules/.bin/playwright'), `#!/bin/sh\ntouch '${planted}/ran'\n`, {mode: 0o755});
  writeFileSync(join(planted, '.npmrc'), 'prefix=/nonexistent\n');
  const result = m.projectFrom(planted, 'example/example-project', join(m.root, 'example-project'));
  assert.equal(result.status, 0, result.output);
  const cwds = lines(join(m.state, 'npx-cwds'));
  assert.ok(cwds.includes('/ -y playwright@1.63.0 install-deps chromium'), cwds.join('\n'));
  assert.deepEqual(cwds.filter(line => !line.startsWith('/ ')), []);
});

test('a Chromium that still does not start headless stops provision-project with exit 1', t => {
  const m = ready(t, {'example/example-project': projectFiles('example-project')});
  writeFileSync(join(m.root, 'downloads/chrome'), '#!/bin/sh\nexit 1\n', {mode: 0o755});
  const result = m.project('example/example-project', join(m.root, 'example-project'));
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /Playwright 1\.63\.0's Chromium still does not start headless/);
});

test('--dry-run lists the changes and makes none, and the checkout defaults to /srv/<name>', t => {
  const m = ready(t, {'example/example-project': projectFiles('example-project')});
  const result = m.project('example/example-project', '--dry-run');
  assert.equal(result.status, 0, result.output);
  assert.match(result.stdout, /^would: set git's user\.name for triphammer to example-agents\[bot\]$/m);
  assert.match(result.stdout, /^would: clone example\/example-project into \/srv\/example-project as triphammer$/m);
  assert.match(result.stdout, /^would: write the config file of example\/example-project, named after its project file, once it is cloned$/m);
  assert.match(result.stdout, /change\(s\) to make; nothing was changed\./);
  assert.match(result.stdout, /\nproject: <named once cloned>\n$/);
  assert.doesNotMatch(result.stdout, /^\+ /m);
  assert.deepEqual(changingCalls(result.calls), []);
  assert.ok(!existsSync(join(m.home, '.config/triphammer')));
});

test('a checkout path that holds something else stops provision-project with exit 1 before anything changes', t => {
  const m = ready(t, {'example/example-project': projectFiles('example-project')});
  mkdirSync(join(m.root, 'example-project'));
  writeFileSync(join(m.root, 'example-project/stray'), 'x\n');
  const result = m.project('example/example-project', join(m.root, 'example-project'));
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /example-project exists and is not triphammer's clone of example\/example-project; move it away/);
  assert.deepEqual(changingCalls(result.calls), []);
});

test('a project that pins another Node than the machine has stops provision-project with exit 1', t => {
  const m = ready(t, {'example/example-project': {...projectFiles('example-project'), '.node-version': '24.20.0\n'}});
  const result = m.project('example/example-project', join(m.root, 'example-project'));
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /pins Node 24\.20\.0, and the machine's Node is v24\.19\.0; one Node is on the units' PATH/);
});

test('a config of another repository with the same checkout or the same project name stops provision-project with exit 1', t => {
  const m = ready(t, {
    'example/example-project': projectFiles('example-project'),
    'example/copy': projectFiles('example-project'),
  });
  assert.equal(m.project('example/example-project', join(m.root, 'example-project')).status, 0);
  const sameCheckout = m.project('example/other', join(m.root, 'example-project'));
  assert.equal(sameCheckout.status, 1, sameCheckout.output);
  assert.match(sameCheckout.stderr, /example-project\.conf already uses the checkout .*example-project for another repository/);
  const sameName = m.project('example/copy', join(m.root, 'copy'));
  assert.equal(sameName.status, 1, sameName.output);
  assert.match(sameName.stderr, /example-project\.conf is the config of another repository named example-project/);
});

// A project added with an owner, two modules and their settings; `config` is its config file.
function added(t) {
  const m = ready(t, {'example/example-project': projectFiles('example-project')});
  const checkout = join(m.root, 'example-project');
  const first = m.project('example/example-project', checkout, '--modules', 'codex,demo', '--set', 'OWNER=example-person',
    '--set', 'CODEX_AUDIT_MODEL=gpt-test', '--set', 'CODEX_SECURITY_MODEL=gpt-test',
    '--set', 'DEMO_GALLERY_DIR=/srv/gallery', '--set', 'DEMO_URL=http://gallery.example.invalid/');
  assert.equal(first.status, 0, first.output);
  assert.match(first.stdout, /^config: OWNER added \(example-person\)$/m);
  assert.match(first.stdout, /^config: MODULES added \(codex,demo\)$/m);
  const config = join(m.home, '.config/triphammer/example-project.conf');
  return {m, checkout, config, text: readFileSync(config, 'utf8')};
}
const settingsOf = text => text.split('\n').slice(1).join('\n');

test('a second run with no flags keeps every setting the config has, byte for byte, and says so', t => {
  const {m, checkout, config, text} = added(t);
  assert.equal(settingsOf(text), `REPO=example/example-project\nCHECKOUT=${checkout}\nAPP_AUTHOR=app/example-agents\n`
    + `STATE_DIR=${m.home}/.local/state/triphammer/projects/example-project\nMODULES=codex,demo\nOWNER=example-person\n`
    + 'CODEX_AUDIT_MODEL=gpt-test\nCODEX_SECURITY_MODEL=gpt-test\nDEMO_GALLERY_DIR=/srv/gallery\nDEMO_URL=http://gallery.example.invalid/\n');
  const again = m.project('example/example-project');
  assert.equal(again.status, 0, again.output);
  assert.equal(readFileSync(config, 'utf8'), text);
  for (const line of ['OWNER kept (example-person)', 'MODULES kept (codex,demo)', `CHECKOUT kept (${checkout})`,
    'APP_AUTHOR kept (app/example-agents)', 'DEMO_URL kept (http://gallery.example.invalid/)']) {
    assert.ok(again.stdout.split('\n').includes(`config: ${line}`), `${line}\n${again.stdout}`);
  }
  assert.doesNotMatch(again.stdout, /^config: \w+ (added|changed|removed)/m);
  assert.doesNotMatch(again.stdout, /APP_AUTHOR: app\/example-agents, the App's slug/);
  assert.match(again.stdout, /^Nothing to change: the machine is as asked\.$/m);
  assert.deepEqual(changingCalls(again.calls), []);
});

test('a run that gives one setting changes that one and keeps the others, and --dry-run shows the same', t => {
  const {m, config, text} = added(t);
  const dry = m.project('example/example-project', '--set', 'OWNER=another-person', '--dry-run');
  assert.equal(dry.status, 0, dry.output);
  assert.match(dry.stdout, /^config: OWNER changed \(example-person, now another-person\)$/m);
  assert.match(dry.stdout, /^config: MODULES kept \(codex,demo\)$/m);
  assert.match(dry.stdout, /^would: rewrite .*example-project\.conf/m);
  assert.equal(readFileSync(config, 'utf8'), text);

  const result = m.project('example/example-project', '--set', 'OWNER=another-person');
  assert.equal(result.status, 0, result.output);
  assert.match(result.stdout, /^config: OWNER changed \(example-person, now another-person\)$/m);
  assert.match(result.stdout, /^config: CODEX_AUDIT_MODEL kept \(gpt-test\)$/m);
  assert.equal(readFileSync(config, 'utf8'), text.replace('OWNER=example-person', 'OWNER=another-person'));
});

test('--unset removes a setting, and --modules \'\' turns every module off and keeps their settings', t => {
  const {m, config, text} = added(t);
  const unset = m.project('example/example-project', '--modules', 'codex', '--unset', 'DEMO_URL', '--unset', 'QWEN_MODEL');
  assert.equal(unset.status, 0, unset.output);
  assert.match(unset.stdout, /^config: MODULES changed \(codex,demo, now codex\)$/m);
  assert.match(unset.stdout, /^config: DEMO_URL removed \(it was http:\/\/gallery\.example\.invalid\/\)$/m);
  assert.match(unset.stdout, /^config: DEMO_GALLERY_DIR kept \(\/srv\/gallery\)$/m);
  assert.match(unset.stdout, /^config: QWEN_MODEL is not set, so --unset removes nothing$/m);
  assert.equal(readFileSync(config, 'utf8'),
    text.replace('MODULES=codex,demo', 'MODULES=codex').replace('DEMO_URL=http://gallery.example.invalid/\n', ''));

  const off = m.project('example/example-project', '--modules', '');
  assert.equal(off.status, 0, off.output);
  assert.match(off.stdout, /^config: MODULES removed \(it was codex\)$/m);
  const now = readFileSync(config, 'utf8');
  assert.doesNotMatch(now, /^MODULES=/m);
  assert.match(now, /^OWNER=example-person$/m);
  assert.match(now, /^CODEX_AUDIT_MODEL=gpt-test$/m);
});

test('a module the settings that result leave without what it needs stops provision-project with exit 2 before anything changes', t => {
  const {m, config, text} = added(t);
  const result = m.project('example/example-project', '--unset', 'DEMO_URL');
  assert.equal(result.status, 2, result.output);
  assert.match(result.stderr, /the demo module needs DEMO_URL/);
  assert.match(result.stderr, /^usage: provision-project /m);
  assert.deepEqual(changingCalls(result.calls), []);
  assert.equal(readFileSync(config, 'utf8'), text);

  const fresh = ready(t, {'example/other': {'.triphammer/project.json': JSON.stringify({name: 'other'})}});
  const first = fresh.project('example/other', join(fresh.root, 'other'), '--modules', 'demo', '--set', 'DEMO_URL=http://gallery.example.invalid/');
  assert.equal(first.status, 2, first.output);
  assert.match(first.stderr, /the demo module needs DEMO_GALLERY_DIR/);
  assert.deepEqual(changingCalls(first.calls), []);
});

test('a key the config has that is not a setting stops provision-project until --unset removes it, whose value stays hidden when it looks secret', t => {
  const {m, config, text} = added(t);
  writeFileSync(config, `${text}EXAMPLE_TOKEN=s3cret-value\n`, {mode: 0o600});
  const refused = m.project('example/example-project');
  assert.equal(refused.status, 2, refused.output);
  assert.match(refused.stderr, /example-project\.conf sets EXAMPLE_TOKEN, which is not a config setting; --unset EXAMPLE_TOKEN removes it/);
  assert.deepEqual(changingCalls(refused.calls), []);

  const removed = m.project('example/example-project', '--unset', 'EXAMPLE_TOKEN');
  assert.equal(removed.status, 0, removed.output);
  assert.match(removed.stdout, /^config: EXAMPLE_TOKEN removed \(it was <not shown>\)$/m);
  assert.ok(!removed.output.includes('s3cret-value'), 'the value reached the output');
  assert.equal(readFileSync(config, 'utf8'), text);
});
