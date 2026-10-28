// agent-guard.py: Write, Edit and NotebookEdit under the persistence rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, relative} from 'node:path';
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

// A machine installed the way bin/README.md says: ~/.local/bin/ticket-runner links to the main checkout's script.
function linkedSetup(t) {
  const machine = machineHome(t);
  const main = join(machine.home, 'main');
  const worktree = join(machine.home, 'main', '.worktrees', 'issue-1');
  for (const dir of [join(main, 'bin'), join(worktree, 'bin'), join(machine.home, '.local/bin'),
    join(machine.home, '.local/state/ticket-runner')]) {
    mkdirSync(dir, {recursive: true});
  }
  writeFileSync(join(main, 'bin/ticket-runner'), '#!/bin/sh\n');
  writeFileSync(join(main, 'bin/config.sh'), '');
  writeFileSync(join(worktree, 'bin/ticket-runner'), '#!/bin/sh\n');
  symlinkSync(join(main, 'bin/ticket-runner'), join(machine.home, '.local/bin/ticket-runner'));
  return {...machine, main, worktree};
}

test('a file tool writing through a Triphammer symlink, or to the file it points to, is refused; another worktree is not',
  t => {
    const {home, env, main, worktree} = linkedSetup(t);
    for (const tool of fileTools) {
      assertFilePersistenceDenied(decideFile(tool, join(home, '.local/bin/ticket-runner'), worktree, {env}), tool);
      assertFilePersistenceDenied(decideFile(tool, join(main, 'bin/ticket-runner'), main, {env}), tool);
      assertFilePersistenceDenied(decideFile(tool, 'bin/ticket-runner', main, {env}), tool);
      assert.equal(decideFile(tool, join(worktree, 'bin/ticket-runner'), worktree, {env}), null, tool);
    }
  });

// The ticket runner also sources, runs, links or loads the other files of Triphammer's checkout (its scripts, units,
// status page, commit hooks and plugin), so its bin, systemd, status, scripts and plugins/triphammer are protected
// whether a Triphammer config's CHECKOUT or a ~/.local/bin link names it.
function checkoutSetups(t) {
  const linked = linkedSetup(t);
  const configured = machineHome(t);
  const main = join(configured.home, 'checkout');
  const worktree = join(main, '.worktrees', 'issue-1');
  mkdirSync(join(worktree, 'src'), {recursive: true});
  mkdirSync(join(main, 'bin'), {recursive: true});
  writeFileSync(join(main, 'bin/config.sh'), '');
  mkdirSync(join(configured.home, '.config/triphammer'), {recursive: true});
  writeFileSync(join(configured.home, '.config/triphammer/p.conf'),
    `REPO=owner/name\nCHECKOUT=${main}\nAPP_AUTHOR=app/agents\nSTATE_DIR=${join(configured.home, 'state')}\n`);
  return [linked, {...configured, main, worktree}];
}

test('a file tool writing the files of Triphammer\'s main checkout is refused; a worktree and other files are not',
  t => {
    for (const {env, main, worktree} of checkoutSetups(t)) {
      for (const tool of fileTools) {
        for (const file of ['bin/config.sh', 'bin/update-checkout', 'systemd/ticket-runner@.service',
          'status/server.mjs', 'scripts/git-hooks/commit-msg', 'scripts/land-pr.sh',
          'plugins/triphammer/hooks/hooks.json', 'plugins/triphammer/hooks/agent-guard.py']) {
          assertFilePersistenceDenied(decideFile(tool, join(main, file), worktree, {env}), `${tool} ${main} ${file}`);
          assertFilePersistenceDenied(decideFile(tool, file, main, {env}), `${tool} ${main} relative ${file}`);
          assert.equal(decideFile(tool, join(worktree, file), worktree, {env}), null, `${tool} ${worktree} ${file}`);
          assert.equal(decideFile(tool, file, worktree, {env}), null, `${tool} ${worktree} relative ${file}`);
        }
        for (const file of ['src/x.cs', 'bins/x', 'systemdx/x', 'plugins/other/x', 'README.md']) {
          assert.equal(decideFile(tool, join(main, file), main, {env}), null, `${tool} ${main} ${file}`);
        }
      }
    }
  });

test('a CHECKOUT that is not Triphammer\'s checkout, such as a project\'s, protects none of its files', t => {
  const {home, env, cwd} = machineHome(t);
  const project = join(home, 'project');
  mkdirSync(join(project, 'scripts'), {recursive: true});
  mkdirSync(join(home, '.config/triphammer'), {recursive: true});
  writeFileSync(join(home, '.config/triphammer/p.conf'), `CHECKOUT=${project}\n`);
  for (const file of ['bin/x', 'systemd/x.service', 'status/x', 'scripts/x.sh', 'plugins/triphammer/x']) {
    assert.equal(decideFile('Write', join(project, file), cwd, {env}), null, file);
  }
});

test('a ~/.local/bin link into a systemd or status directory protects that checkout only when it is Triphammer\'s', t => {
  const {home, env, cwd} = machineHome(t);
  const triphammer = join(home, 'triphammer');
  const other = join(home, 'other');
  for (const dir of [join(triphammer, 'bin'), join(triphammer, 'status'), join(other, 'status'), join(home, '.local/bin')]) {
    mkdirSync(dir, {recursive: true});
  }
  writeFileSync(join(triphammer, 'bin/config.sh'), '');
  writeFileSync(join(triphammer, 'status/server.mjs'), '');
  writeFileSync(join(other, 'status/server.mjs'), '');
  symlinkSync(join(triphammer, 'status/server.mjs'), join(home, '.local/bin/triphammer-status'));
  symlinkSync(join(other, 'status/server.mjs'), join(home, '.local/bin/other-status'));
  for (const file of ['bin/ticket-runner', 'systemd/ticket-runner@.timer', 'scripts/land-pr.sh']) {
    assertFilePersistenceDenied(decideFile('Write', join(triphammer, file), cwd, {env}), file);
    assert.equal(decideFile('Write', join(other, file), cwd, {env}), null, `other ${file}`);
  }
});

test('a Triphammer config\'s relative CHECKOUT protects no checkout', t => {
  const {home, env, cwd} = machineHome(t);
  mkdirSync(join(home, '.config/triphammer'), {recursive: true});
  writeFileSync(join(home, '.config/triphammer/p.conf'), 'CHECKOUT=checkout\n');
  assert.equal(decideFile('Write', join(home, 'checkout/bin/config.sh'), cwd, {env}), null);
});

test('a file tool path that reaches a persistence directory through a symlinked directory is refused', t => {
  const {home, env, worktree} = linkedSetup(t);
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
  const {home, env, worktree} = linkedSetup(t);
  const scratch = mkdtempSync(join(tmpdir(), 'agent-guard-scratch-'));
  t.after(() => rmSync(scratch, {recursive: true, force: true}));
  for (const tool of fileTools) {
    for (const path of [join(worktree, 'notes.md'), 'src/new/File.cs', join(scratch, 'x.ipynb'), '/tmp/agent-guard-x',
      join(home, '.local/binder'), join(home, '.local/state/other/x'), join(home, '.config/other/x')]) {
      assert.equal(decideFile(tool, path, worktree, {env}), null, `${tool} ${path}`);
    }
  }
});
