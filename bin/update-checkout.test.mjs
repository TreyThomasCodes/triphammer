import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {git, here, checkoutSetup, run, runnerSetup, writeConfig} from './fixture.mjs';

test('a clean checkout on main is fast-forwarded to origin/main without restarting triphammer-status or the gallery', t => {
  const r = checkoutSetup(t);
  const target = r.publish('bin/x', 'v2\n');
  assert.match(r.update(), /fast-forwarded/);
  assert.equal(r.head(), target);
  assert.equal(readFileSync(join(r.checkout, 'bin/x'), 'utf8'), 'v2\n');
  assert.equal(r.restartCount(), 0);
  assert.equal(r.galleryRestartCount(), 0);
});

test('a change under status/ restarts triphammer-status once', t => {
  const r = checkoutSetup(t);
  const target = r.publish('status/server.mjs', 'v2\n');
  assert.match(r.update(), /status\/ changed; restarting triphammer-status/);
  assert.equal(r.head(), target);
  assert.equal(r.restartCount(), 1);
  assert.equal(r.update(), '', 'an up-to-date checkout prints nothing and restarts nothing');
  assert.equal(r.restartCount(), 1);
  assert.equal(r.galleryRestartCount(), 0);
});

test('a change to bin/demo-gallery restarts the galleries and not triphammer-status', t => {
  const r = checkoutSetup(t, {'bin/demo-gallery': 'v1\n'});
  const target = r.publish('bin/demo-gallery', 'v2\n');
  assert.match(r.update(), /bin\/demo-gallery changed; restarting demo-gallery/);
  assert.equal(r.head(), target);
  assert.equal(r.galleryRestartCount(), 1);
  assert.equal(r.restartCount(), 0);
});

test('a change to bin/config.sh restarts both servers, which read it at startup', t => {
  const r = checkoutSetup(t, {'bin/config.sh': 'v1\n'});
  r.publish('bin/config.sh', 'v2\n');
  const result = r.update();
  assert.match(result, /bin\/config.sh changed; restarting triphammer-status/);
  assert.match(result, /bin\/config.sh changed; restarting demo-gallery/);
  assert.equal(r.restartCount(), 1);
  assert.equal(r.galleryRestartCount(), 1);
});

test('a failed restart is printed, the other restart still runs, and the update exits non-zero', t => {
  const r = checkoutSetup(t, {'bin/config.sh': 'v1\n'});
  const target = r.publish('bin/config.sh', 'v2\n');
  const result = spawnSync(join(here, 'update-checkout'), [r.checkout], {encoding: 'utf8', env: {...r.env, STATUS_RESTART: 'false'}});
  assert.equal(result.status, 1);
  assert.match(result.stdout, /restarting triphammer-status failed/);
  assert.equal(r.head(), target, 'the fast-forward stands');
  assert.equal(r.galleryRestartCount(), 1);
});

test('a dirty tree is left alone and the reason is printed', t => {
  const r = checkoutSetup(t);
  const before = r.head();
  r.publish('status/server.mjs', 'v2\n');
  writeFileSync(join(r.checkout, 'bin/x'), 'local edit\n');
  assert.match(r.update(), /self-update skipped: .* has uncommitted or untracked changes/);
  assert.equal(r.head(), before);
  assert.equal(r.restartCount(), 0);
});

test('an untracked file counts as a dirty tree', t => {
  const r = checkoutSetup(t);
  const before = r.head();
  r.publish('bin/x', 'v2\n');
  writeFileSync(join(r.checkout, 'stray.txt'), 'x\n');
  assert.match(r.update(), /uncommitted or untracked changes/);
  assert.equal(r.head(), before);
});

test('a checkout on another branch is left alone and the reason is printed', t => {
  const r = checkoutSetup(t);
  git(r.checkout, 'checkout', '-q', '-b', 'experiment');
  const before = r.head();
  r.publish('status/server.mjs', 'v2\n');
  assert.match(r.update(), /self-update skipped: .* is on experiment, not main/);
  assert.equal(r.head(), before);
  assert.equal(git(r.checkout, 'rev-parse', 'main'), before);
  assert.equal(r.restartCount(), 0);
});

test('a main that has diverged from origin/main is neither merged nor reset', t => {
  const r = checkoutSetup(t);
  writeFileSync(join(r.checkout, 'local.txt'), 'x\n');
  git(r.checkout, 'add', '.');
  git(r.checkout, 'commit', '-q', '-m', 'local');
  const before = r.head();
  r.publish('status/server.mjs', 'v2\n');
  assert.match(r.update(), /cannot fast-forward/);
  assert.equal(r.head(), before);
  assert.equal(r.restartCount(), 0);
});

test('ticket-runner updates its checkout at the start of a tick and runs the updated copy of itself once', t => {
  const runner = readFileSync(join(here, 'ticket-runner'), 'utf8');
  const r = runnerSetup(t, {runner});
  const marker = 'set -euo pipefail\n';
  assert.ok(runner.includes(marker));
  const target = r.publish('bin/ticket-runner', runner.replace(marker, `${marker}echo ran >> "$XDG_STATE_HOME/updated-copy-runs"\n`));
  // The tick stops after the self-update because origin/main has no ticket-run skill.
  const result = r.runTicketRunner();
  assert.equal(r.head(), target);
  assert.match(result, /fast-forwarded/);
  assert.match(result, /self-update changed ticket-runner; running the updated copy/);
  const log = readFileSync(join(r.root, 'state/ticket-runner/log'), 'utf8');
  assert.equal(log.match(/running the updated copy/g)?.length, 1, log);
  assert.equal(readFileSync(join(r.root, 'state/updated-copy-runs'), 'utf8'), 'ran\n', 'the updated copy runs exactly once');
});

test('ticket-runner --plan never updates the checkout', t => {
  const r = runnerSetup(t);
  const before = r.head();
  r.publish('status/server.mjs', 'v2\n');
  r.runTicketRunner(['--plan']);
  assert.equal(r.head(), before);
  assert.equal(r.restartCount(), 0);
});

test("ticket-runner keeps Triphammer's checkout current when no project's CHECKOUT is it, and the project's checkout too", t => {
  const runner = readFileSync(join(here, 'ticket-runner'), 'utf8');
  const r = runnerSetup(t, {runner});
  const project = r.separateProject();
  const marker = 'set -euo pipefail\n';
  r.publish('status/server.mjs', 'v2\n');
  const target = r.publish('bin/ticket-runner', runner.replace(marker, `${marker}echo ran >> "$XDG_STATE_HOME/updated-copy-runs"\n`));
  const projectTarget = project.publish('lib/a.txt', 'a\n');
  // The tick stops after the self-update because Triphammer's origin/main has no ticket-run skill.
  const result = r.runTicketRunner();
  assert.equal(r.head(), target);
  assert.equal(project.head(), projectTarget, "the project's checkout is fast-forwarded too");
  assert.match(result, new RegExp(`fast-forwarded ${r.checkout} `));
  assert.match(result, new RegExp(`fast-forwarded ${project.checkout} `));
  assert.match(result, /status\/ changed; restarting triphammer-status/);
  assert.equal(r.restartCount(), 1);
  assert.equal(readFileSync(join(r.root, 'state/updated-copy-runs'), 'utf8'), 'ran\n', 'the updated copy runs exactly once');

  const before = r.head();
  r.publish('bin/x', 'v2\n');
  r.runTicketRunner(['--plan']);
  assert.equal(r.head(), before, '--plan updates nothing');
});

test('without an argument it updates the checkout the Triphammer config names, and without a config it stops', t => {
  const r = checkoutSetup(t);
  const other = join(r.root, 'other');
  git(r.root, 'clone', '-q', join(r.root, 'origin.git'), other);
  writeConfig(r.configFile, {REPO: 'acme/widgets', CHECKOUT: other, APP_AUTHOR: 'app/widget-bot', STATE_DIR: join(r.root, 'state')});
  const before = r.head();
  const target = r.publish('bin/x', 'v2\n');
  assert.match(run(join(here, 'update-checkout'), [], {env: r.env}), new RegExp(`fast-forwarded ${other} `));
  assert.equal(git(other, 'rev-parse', 'HEAD'), target);
  assert.equal(r.head(), before, 'only the configured checkout moves');

  const missing = join(r.root, 'nowhere.conf');
  const result = spawnSync(join(here, 'update-checkout'), [], {encoding: 'utf8', env: {...r.env, TRIPHAMMER_CONFIG: missing}});
  assert.equal(result.status, 2);
  assert.match(result.stderr, new RegExp(`update-checkout: the Triphammer config ${missing} is missing`));
});
