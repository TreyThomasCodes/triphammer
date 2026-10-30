// agent-guard.py: Write, Edit and NotebookEdit under the persistence rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {decideFile, machineHome, configuredSetup, validConf, fileTools, assertNoOverrideHint} from './agent-guard-fixture.mjs';

// The file tools under the persistence rule.

function assertFilePersistenceDenied(reason, path) {
  assert.ok(reason, `expected a deny: ${path}`);
  assert.match(reason, /persistence rule/);
  assert.match(reason, /the owner does that/);
  assert.match(reason, /Leave this change to the owner and report it/);
  assertNoOverrideHint(reason, path);
}

test('a Write, Edit or NotebookEdit under each persistence directory is refused, without an override', t => {
  const {home, env, cwd, state} = configuredSetup(t, validConf);
  const elsewhere = mkdtempSync(join(tmpdir(), 'agent-guard-shared-'));
  t.after(() => rmSync(elsewhere, {recursive: true, force: true}));
  const config = env.XDG_CONFIG_HOME;
  const paths = [
    join(home, '.local/bin/triphammer-write-probe'),
    join(home, '.config/systemd/user/ticket-runner@p.timer'),
    join(home, '.config/triphammer/p.conf'),
    join(config, 'systemd/user/x.service'),
    join(config, 'triphammer/other.conf'),
    join(home, '.local/state/ticket-runner/write-probe'),
    join(home, '.local/state/triphammer/stop'),
    join(state, 'security-reviewed'),
    join(state, 'attempts', 'new', 'n.ipynb'),
    state,
  ];
  for (const tool of fileTools) {
    for (const path of paths) assertFilePersistenceDenied(decideFile(tool, path, cwd, {env}), `${tool} ${path}`);
    assertFilePersistenceDenied(decideFile(tool, '.local/bin/relative', home, {env}), `${tool} relative`);
    const sharedDir = {...env, TRIPHAMMER_SHARED_DIR: join(elsewhere, 'shared')};
    assertFilePersistenceDenied(decideFile(tool, join(elsewhere, 'shared', 'stop'), cwd, {env: sharedDir}), `${tool} shared dir`);
  }
});

test('a file tool path that reaches a persistence directory through a symlinked directory is refused', t => {
  const {home, env} = machineHome(t);
  const worktree = join(home, 'checkout', '.worktrees', 'issue-1');
  for (const dir of [worktree, join(home, '.local/bin'), join(home, '.local/state/ticket-runner')]) {
    mkdirSync(dir, {recursive: true});
  }
  symlinkSync(join(home, '.local/state/ticket-runner'), join(worktree, 'state'));
  symlinkSync(join(home, '.local'), join(worktree, 'local'));
  for (const tool of fileTools) {
    for (const path of [join(worktree, 'state', 'stop'), join(worktree, 'state', 'not', 'yet', 'there'),
      join(worktree, 'local', 'bin', 'new-script'), 'local/state/ticket-runner/current']) {
      assertFilePersistenceDenied(decideFile(tool, path, worktree, {env}), `${tool} ${path}`);
    }
  }
});

test('a file tool writing in the working directory, scratch locations or beside Triphammer is allowed', t => {
  const {home, env} = machineHome(t);
  const worktree = join(home, 'checkout', '.worktrees', 'issue-1');
  mkdirSync(worktree, {recursive: true});
  const scratch = mkdtempSync(join(tmpdir(), 'agent-guard-scratch-'));
  t.after(() => rmSync(scratch, {recursive: true, force: true}));
  for (const tool of fileTools) {
    for (const path of [join(worktree, 'notes.md'), 'src/new/File.cs', join(scratch, 'x.ipynb'), '/tmp/agent-guard-x',
      join(home, '.local/binder'), join(home, '.local/state/other/x'), join(home, '.config/other/x')]) {
      assert.equal(decideFile(tool, path, worktree, {env}), null, `${tool} ${path}`);
    }
  }
});
