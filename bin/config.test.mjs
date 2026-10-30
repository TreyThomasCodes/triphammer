import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {here, toolingEnv} from './fixture.mjs';

// machine_get <key> run against a machine file under a throwaway TRIPHAMMER_PROVISION_ROOT holding `text` (none when null).
function machineGet(t, text, key) {
  const root = mkdtempSync(join(tmpdir(), 'config-machine-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  if (text !== null) {
    mkdirSync(join(root, 'etc'));
    writeFileSync(join(root, 'etc/triphammer.conf'), text);
  }
  return spawnSync('bash', ['-c', 'source "$1" && machine_get "$2"', 'bash', join(here, 'config.sh'), key],
    {encoding: 'utf8', env: {...toolingEnv, TRIPHAMMER_PROVISION_ROOT: root}});
}

const machineFile = [
  '# Written by bin/provision: TRIPHAMMER_USER=commented',
  'TRIPHAMMER_REPO=example/triphammer',
  'TRIPHAMMER_USER=first',
  '',
  'TRIPHAMMER_HOME= /home/with space="quoted"=and#more ',
  'TRIPHAMMER_USER=triphammer',
  'TRIPHAMMER_USERNAME=other',
  'TRIPHAMMER_CHECKOUT',
  'TRIPHAMMER_EMPTY=',
  'TRIPHAMMER_LAST=no newline',
].join('\n');

test('machine_get prints the value after the first = of the last line that gives the key, as it stands', t => {
  for (const [key, value] of [
    ['TRIPHAMMER_REPO', 'example/triphammer'],
    ['TRIPHAMMER_USER', 'triphammer'],
    ['TRIPHAMMER_HOME', ' /home/with space="quoted"=and#more '],
    ['TRIPHAMMER_LAST', 'no newline'],
  ]) {
    const result = machineGet(t, machineFile, key);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, value, key);
  }
});

test('machine_get prints nothing for a key the file leaves out, gives empty or names without =, or a missing file', t => {
  for (const [text, key] of [
    [machineFile, 'TRIPHAMMER_DOCKER_SOCKET'],
    [machineFile, 'TRIPHAMMER_EMPTY'],
    [machineFile, 'TRIPHAMMER_CHECKOUT'],
    [machineFile, 'TRIPHAMMER'],
    [null, 'TRIPHAMMER_REPO'],
  ]) {
    const result = machineGet(t, text, key);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '', `${key} in ${text === null ? 'no file' : 'the file'}`);
    assert.equal(result.stderr, '');
  }
});
