import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {git, here, lines} from './fixture.mjs';
import {readdir} from './provision-fixture.mjs';

const script = join(here, '..', 'install.sh');

// A repository at <base>/example-owner/triphammer.git whose bin/provision records its arguments, whether sudo ran it,
// the directory it ran from, and whether it leads a session of its own and what its stdin is, one line each, on `main`;
// on a branch `other` it records `other` first, on `fails` it exits 3, and on `slow` it records `started` in <record>.slow
// and then, from a child of its own, `finished` two seconds later. A fake `id` answers `uid`, and a fake `sudo` records
// its arguments and runs the rest.
function setup(t, uid = '1000') {
  const dir = mkdtempSync(join(tmpdir(), 'install-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const record = join(dir, 'provision.log');
  const sudoLog = join(dir, 'sudo.log');
  const source = join(dir, 'source');
  mkdirSync(join(source, 'bin'), {recursive: true});
  const provision = extra => `#!/usr/bin/env bash\n${extra}printf '%s\\n' "$@" >> '${record}'\n`
    + `echo "\${UNDER_SUDO:-no}" >> '${record}.sudo'\n`
    + `{ [ "$(ps -o sid= -p $$ | tr -d ' ')" = $$ ] && echo leader || echo attached; readlink /proc/$$/fd/0; } >> '${record}.session'\n`
    + `dirname "$(dirname "$(readlink -f "$0")")" >> '${record}.dir'\n`;
  writeFileSync(join(source, 'bin/provision'), provision(''), {mode: 0o755});
  git(source, 'init', '-q', '-b', 'main');
  git(source, 'add', '-A');
  git(source, 'commit', '-q', '-m', 'main');
  git(source, 'switch', '-q', '-c', 'other');
  writeFileSync(join(source, 'bin/provision'), provision(`echo other >> '${record}'\n`), {mode: 0o755});
  git(source, 'commit', '-q', '-am', 'other');
  git(source, 'switch', '-q', '-c', 'fails', 'main');
  writeFileSync(join(source, 'bin/provision'), '#!/usr/bin/env bash\nexit 3\n', {mode: 0o755});
  git(source, 'commit', '-q', '-am', 'fails');
  git(source, 'switch', '-q', '-c', 'slow', 'main');
  writeFileSync(join(source, 'bin/provision'), `#!/usr/bin/env bash\necho started >> '${record}.slow'\n`
    + `sh -c "sleep 2; echo finished >> '${record}.slow'"\n`, {mode: 0o755});
  git(source, 'commit', '-q', '-am', 'slow');
  git(source, 'switch', '-q', 'main');
  const base = join(dir, 'base');
  mkdirSync(join(base, 'example-owner'), {recursive: true});
  git(dir, 'clone', '-q', '--bare', source, join(base, 'example-owner/triphammer.git'));
  const bin = join(dir, 'fakes');
  mkdirSync(bin);
  writeFileSync(join(bin, 'id'), `#!/bin/sh\necho ${uid}\n`, {mode: 0o755});
  writeFileSync(join(bin, 'sudo'), `#!/bin/sh\necho "$*" >> '${sudoLog}'\n[ "$1" = -v ] && exit 0\nUNDER_SUDO=yes exec "$@"\n`,
    {mode: 0o755});
  const tmp = join(dir, 'tmp');
  mkdirSync(tmp);
  const env = {PATH: `${bin}:${process.env.PATH}`, HOME: dir, TMPDIR: tmp, TRIPHAMMER_REPO: 'example-owner/triphammer',
    TRIPHAMMER_INSTALL_GIT_BASE: `file://${base}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1'};
  return {record, sudoLog, env, tmp};
}

// Runs the script as `curl ... | bash -s -- <args>` does, from standard input.
const piped = (env, args, input = readFileSync(script, 'utf8')) =>
  spawnSync('bash', ['-s', '--', ...args], {input, env, encoding: 'utf8'});

test("an ordinary user's run asks sudo once, then runs provision as root with Triphammer's repository at /srv/triphammer first", t => {
  const {record, sudoLog, env} = setup(t);
  const result = piped(env, ['--user', 'triphammer']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /sudo asks for your password once/);
  const sudo = lines(sudoLog);
  assert.equal(sudo[0], '-v');
  assert.match(sudo[1], /^bash -c .*setsid .* detached bash .*\/triphammer\/bin\/provision --triphammer example-owner\/triphammer \/srv\/triphammer --user triphammer$/);
  assert.equal(sudo.length, 2);
  assert.deepEqual(lines(record), ['--triphammer', 'example-owner/triphammer', '/srv/triphammer', '--user', 'triphammer']);
  assert.deepEqual(lines(`${record}.sudo`), ['yes']);
  // Run from a terminal, a command outside its foreground group that touches it is stopped, so provision has none.
  assert.deepEqual(lines(`${record}.session`), ['leader', '/dev/null']);
});

test('root runs provision without sudo', t => {
  const {record, sudoLog, env} = setup(t, '0');
  const result = piped(env, []);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(lines(sudoLog), []);
  assert.deepEqual(lines(`${record}.sudo`), ['no']);
  assert.deepEqual(lines(`${record}.session`), ['leader', '/dev/null']);
  assert.doesNotMatch(result.stdout, /sudo asks/);
});

test('a --triphammer given is passed on as it is, and nothing is added', t => {
  const {record, env} = setup(t);
  const args = ['--triphammer', 'example-owner/fork', '/opt/t', '--dry-run'];
  const result = piped(env, args);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(lines(record), args);
});

test('provision runs from a clone of TRIPHAMMER_REF, which is gone once it ends', t => {
  const {record, env, tmp} = setup(t);
  const result = piped({...env, TRIPHAMMER_REF: 'other'}, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(lines(record)[0], 'other');
  const [ran] = lines(`${record}.dir`);
  assert.ok(ran.startsWith(tmp), ran);
  assert.deepEqual(readdir(tmp), []);
});

test("provision's exit status is the script's, and the clone is removed all the same", t => {
  const {env, tmp} = setup(t);
  const result = piped({...env, TRIPHAMMER_REF: 'fails'}, ['--dry-run']);
  assert.equal(result.status, 3);
  assert.deepEqual(readdir(tmp), []);
});

test('a download cut short before the last line runs nothing', t => {
  const {record, sudoLog, env} = setup(t);
  const cut = readFileSync(script, 'utf8').replace(/\nmain "\$@"\n$/, '\n');
  assert.notEqual(cut, readFileSync(script, 'utf8'));
  const result = piped(env, ['--dry-run'], cut);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(lines(record), []);
  assert.deepEqual(lines(sudoLog), []);
});

// `group` sends the signal as a terminal's Ctrl-C does, to the whole foreground process group the script leads.
for (const [signal, group] of [['SIGINT', false], ['SIGTERM', false], ['SIGINT', true]]) {
  test(`${signal} to the script${group ? "'s process group" : ''} stops provision and the child it started, and the script ends by that signal`, async t => {
    const {record, env, tmp} = setup(t);
    const child = spawn('bash', ['-s', '--', '--dry-run'], {env: {...env, TRIPHAMMER_REF: 'slow'}, stdio: ['pipe', 'ignore', 'ignore'], detached: group});
    const exited = new Promise(done => child.on('exit', (status, by) => done({status, by, at: Date.now()})));
    child.stdin.end(readFileSync(script, 'utf8'));
    for (let i = 0; i < 500 && !lines(`${record}.slow`).includes('started'); i++) await sleep(20);
    const sent = Date.now();
    if (group) process.kill(-child.pid, signal);
    else child.kill(signal);
    const {status, by, at} = await exited;
    assert.equal(by, signal, `exited ${status}`);
    assert.ok(at - sent < 1500, `${at - sent} ms after the signal`);
    await sleep(2500);  // past the moment provision's child would have recorded `finished`
    assert.deepEqual(lines(`${record}.slow`), ['started']);
    assert.deepEqual(readdir(tmp), []);
  });
}
