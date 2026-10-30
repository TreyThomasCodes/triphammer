import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';

// The owner checks of .github/workflows/risk-tier.yml, taken from the workflow itself and run with jq and bash, so a
// test fails when the workflow's own text changes. GitHub matches logins in any case, so these must too.
const workflow = readFileSync(new URL('../.github/workflows/risk-tier.yml', import.meta.url), 'utf8');
const filters = [...workflow.matchAll(/jq -r --arg owner "\$OWNER"[^']*'([^']*)'/g)].map(match => match[1]);
const [brake, approval, pushes] = filters;
const authorCheck = workflow.match(/if (\[ "\$\{?PULL_REQUEST_AUTHOR\b[^\]]*\])/)?.[1];
const holdCheck = workflow.match(/if (grep [^;]*\bhold <<< "\$labels");/)?.[1];
const ownerHold = workflow.match(/owner_hold="\$\(jq -r '([^']*)'/)?.[1];

const jq = (filter, input, owner) => {
  const result = spawnSync('jq', ['-r', '--arg', 'owner', owner, '--arg', 'since', '', filter],
    {input: JSON.stringify(input), encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const review = (login, state) => ({user: login === null ? null : {login}, state, commit_id: 'abc123', submitted_at: '2026-10-26T00:00:00Z'});

test('the workflow has the three owner filters, the author check and the hold check the tests run', () => {
  assert.equal(filters.length, 3);
  assert.ok(authorCheck);
  assert.ok(holdCheck);
  assert.ok(ownerHold);
});

test('a hold label holds the pull request whatever its case', () => {
  const held = labels => spawnSync('bash', ['-c', holdCheck], {env: {labels}}).status;
  assert.equal(held('bug\nhold'), 0);
  assert.equal(held('Hold'), 0);
  assert.equal(held('HOLD\nescalated'), 0);
  assert.notEqual(held('bug\nholder\non-hold'), 0);
  assert.notEqual(held(''), 0);
});

test("a hold someone other than a bot added holds until someone other than a bot removes it", () => {
  const held = events => jq(ownerHold, [events], 'owner-login');
  const human = login => ({login, type: 'User'});
  const app = {login: 'agents-app[bot]', type: 'Bot'};
  const hold = (event, actor, name = 'hold') => ({event, actor, label: {name}});
  assert.equal(held([hold('labeled', human('owner-login')), hold('unlabeled', app)]), 'labeled');
  assert.equal(held([hold('labeled', human('Owner-Login'), 'Hold'), hold('unlabeled', {login: 'other[bot]'})]), 'labeled');
  assert.equal(held([hold('labeled', human('owner-login')), hold('unlabeled', app), hold('unlabeled', human('owner-login'))]), 'unlabeled');
  assert.equal(held([hold('labeled', app), hold('unlabeled', app)]), '');
  assert.equal(held([hold('labeled', human('owner-login')), hold('unlabeled', app, 'holder'), {event: 'closed', actor: app}]), 'labeled');
  assert.equal(held([hold('unlabeled', human('owner-login')), hold('labeled', app)]), 'unlabeled');
});

test("the owner's change request holds the pull request whatever the case of either login", () => {
  assert.equal(jq(brake, [[review('Owner-Login', 'CHANGES_REQUESTED')]], 'owner-login'), 'CHANGES_REQUESTED');
  assert.equal(jq(brake, [[review('owner-login', 'CHANGES_REQUESTED')]], 'Owner-Login'), 'CHANGES_REQUESTED');
  assert.equal(jq(brake, [[review('someone-else', 'CHANGES_REQUESTED')]], 'owner-login'), '');
});

test("the owner's approval counts whatever the case of either login", () => {
  assert.equal(jq(approval, [[review('owner-login', 'APPROVED')]], 'Owner-Login'), 'APPROVED abc123');
  assert.equal(jq(approval, [[review('Owner-Login', 'APPROVED')]], 'owner-login'), 'APPROVED abc123');
  assert.equal(jq(approval, [[review('someone-else', 'APPROVED')]], 'owner-login'), '');
});

test("the owner's pushes count whatever the case of either login", () => {
  const push = login => ({actor: login === null ? null : {login}, activity_type: 'push', timestamp: '2026-10-26T00:00:00Z', after: 'def456'});
  assert.equal(jq(pushes, [[push('Owner-Login')]], 'owner-login'), 'def456');
  assert.equal(jq(pushes, [[push('someone-else')]], 'owner-login'), '');
  assert.equal(jq(pushes, [[push(null)]], 'owner-login'), '');
});

test('a review by a deleted account, which GitHub gives no user, matches no owner and stops nothing', () => {
  assert.equal(jq(brake, [[review(null, 'CHANGES_REQUESTED')]], 'owner-login'), '');
  assert.equal(jq(approval, [[review(null, 'APPROVED')]], 'owner-login'), '');
});

test("the owner's own pull request is recognized whatever the case of either login", () => {
  const author = (pullRequestAuthor, owner) => spawnSync('bash', ['-c', authorCheck],
    {env: {PULL_REQUEST_AUTHOR: pullRequestAuthor, OWNER: owner}}).status;
  assert.equal(author('Owner-Login', 'owner-login'), 0);
  assert.equal(author('owner-login', 'Owner-Login'), 0);
  assert.notEqual(author('someone-else', 'owner-login'), 0);
});
