import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fakeGh} from '../bin/fixture.mjs';

const script = readFileSync(join(import.meta.dirname, 'land-pr.sh'), 'utf8');
const head = 'abc123';

// Runs land-pr.sh the way the merge-policy skill does (main's copy on stdin of `bash -s`), with a fake `gh` that
// records every call (failing the calls that start with `failOn`), names `someone` as the repository's owner and
// refuses to read repository variables, as the App's token does, and a fake `git` whose main serves this test's
// classifier and this script. `owner` is the TRIPHAMMER_OWNER the ticket runner gives the session (unset when null).
function land(t, {state = 'OPEN', tier, reasons = {tier: 'auto', reasons: []}, failOn = '', localHead = head, owner = null} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'land-pr-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const gh = fakeGh(join(root, 'gh'), {'pr view': {stdout: `${state} ${head}\n`}, 'repo view': {stdout: 'someone\n'}});
  gh.respond({variable: {stderr: 'HTTP 403: Resource not accessible by integration\n', exit: 1}});
  if (failOn) gh.respond({[failOn]: {stderr: `gh: HTTP 502 for ${failOn}\n`, exit: 1}});
  const classifierArgs = join(root, 'classifier-args');
  writeFileSync(join(root, 'land-pr.sh'), script);
  writeFileSync(join(root, 'risk-tier-base.sh'),
    `echo "$@" > '${classifierArgs}'\ncat <<'JSON'\n${JSON.stringify(reasons, null, 2)}\nJSON\nexit ${tier}\n`);
  writeFileSync(join(gh.bin, 'git'), `#!/bin/sh
case "$*" in
  "fetch -q origin main") exit 0 ;;
  "show refs/remotes/origin/main:scripts/risk-tier-base.sh") cat '${root}/risk-tier-base.sh' ;;
  "show refs/remotes/origin/main:scripts/land-pr.sh") cat '${root}/land-pr.sh' ;;
  "rev-parse HEAD") echo ${localHead} ;;
  *) echo "unexpected git $*" >&2; exit 99 ;;
esac
`, {mode: 0o755});
  const env = {...process.env, PATH: `${gh.bin}:${process.env.PATH}`};
  delete env.TRIPHAMMER_OWNER;
  if (owner !== null) env.TRIPHAMMER_OWNER = owner;
  const result = spawnSync('bash', ['-c', 'git show refs/remotes/origin/main:scripts/land-pr.sh | bash -s -- 42'], {
    cwd: root, encoding: 'utf8', env,
  });
  return {...result, ghCalls: gh.calls(), classifierArgs: existsSync(classifierArgs) ? readFileSync(classifierArgs, 'utf8').trim() : null};
}

const view = ['pr', 'view', '42', '--json', 'state,headRefOid', '--jq', '"\\(.state) \\(.headRefOid)"'];
const arm = ['pr', 'merge', '42', '--auto', '--squash', '--delete-branch'];
const repoOwner = ['repo', 'view', '--json', 'owner', '--jq', '.owner.login'];

test('auto arms auto-merge and nothing else', t => {
  const r = land(t, {tier: 0});
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.ghCalls, [view, arm]);
  assert.equal(r.classifierArgs, 'refs/remotes/origin/main', "main's classifier runs against main, fully qualified");
});

test("escalate requests the repository owner's review, comments the classifier reasons and arms auto-merge without touching labels", t => {
  const reasons = {tier: 'escalate', reasons: ['scripts/land-pr.sh: scripts escalate']};
  const r = land(t, {tier: 2, reasons});
  assert.equal(r.status, 0, r.stderr);
  const comment = r.ghCalls[3];
  assert.deepEqual(r.ghCalls, [
    view,
    repoOwner,
    ['pr', 'edit', '42', '--add-reviewer', 'someone'],
    ['pr', 'comment', '42', '--body', comment[4]],
    arm,
  ]);
  assert.ok(comment[4].includes(JSON.stringify(reasons, null, 2)), comment[4]);
  assert.match(r.stdout, /^land-pr: #42 escalates; review requested from someone, auto-merge armed$/m);
});

test('an escalation whose repository owner cannot be read changes nothing', t => {
  const r = land(t, {tier: 2, reasons: {tier: 'escalate', reasons: ['x']}, failOn: 'repo view'});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot read the owner \(TRIPHAMMER_OWNER or the repository's owner\)/);
  assert.deepEqual(r.ghCalls, [view, repoOwner]);
});

test('an escalation requests the review of the owner the ticket runner gives in TRIPHAMMER_OWNER, not the repository owner', t => {
  const r = land(t, {tier: 2, reasons: {tier: 'escalate', reasons: ['x']}, owner: 'example-person'});
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.ghCalls.slice(0, 2), [view, ['pr', 'edit', '42', '--add-reviewer', 'example-person']]);
  assert.match(r.stdout, /^land-pr: #42 escalates; review requested from example-person, auto-merge armed$/m);
});

test('an empty TRIPHAMMER_OWNER falls back to the repository owner', t => {
  const r = land(t, {tier: 2, reasons: {tier: 'escalate', reasons: ['x']}, owner: ''});
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.ghCalls.slice(0, 3), [view, repoOwner, ['pr', 'edit', '42', '--add-reviewer', 'someone']]);
});

test('land-pr never reads repository variables, which the App token may not read', t => {
  for (const owner of [null, 'example-person']) {
    const r = land(t, {tier: 2, reasons: {tier: 'escalate', reasons: ['x']}, owner});
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.ghCalls.some(call => call[0] === 'variable'), JSON.stringify(r.ghCalls));
  }
});

test('blocked refuses with the reasons and changes nothing', t => {
  const reasons = {tier: 'blocked', reasons: ['database/migrations/V0001__x.sql: applied migrations are immutable']};
  const r = land(t, {tier: 3, reasons});
  assert.equal(r.status, 3);
  assert.match(r.stdout, /applied migrations are immutable/);
  assert.match(r.stderr, /blocked/);
  assert.deepEqual(r.ghCalls, [view]);
});

test('a classifier error stops without changing anything', t => {
  const r = land(t, {tier: 1, reasons: 'boom'});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /classifier failed \(exit 1\)/);
  assert.deepEqual(r.ghCalls, [view]);
});

for (const state of ['MERGED', 'CLOSED']) {
  test(`a ${state} pull request is refused before the classifier runs`, t => {
    const r = land(t, {state, tier: 0});
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`#42 is ${state}, not open`));
    assert.deepEqual(r.ghCalls, [view]);
    assert.equal(r.classifierArgs, null);
  });
}

test('a checkout that is not the pull request head is refused before the classifier runs', t => {
  const r = land(t, {tier: 0, localHead: 'def456'});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not the head of pull request #42/);
  assert.deepEqual(r.ghCalls, [view]);
  assert.equal(r.classifierArgs, null);
});

test('a gh failure stops with its error', t => {
  const r = land(t, {tier: 2, reasons: {tier: 'escalate', reasons: ['x']}, failOn: 'pr edit 42'});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /gh: HTTP 502 for pr edit 42/);
  assert.deepEqual(r.ghCalls.map(call => call.slice(0, 2)), [['pr', 'view'], ['repo', 'view'], ['pr', 'edit']]);
});

test('a failing pull request lookup stops before anything else', t => {
  const r = land(t, {tier: 0, failOn: 'pr view 42'});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /gh: HTTP 502 for pr view 42/);
  assert.deepEqual(r.ghCalls, [view]);
  assert.equal(r.classifierArgs, null);
});
