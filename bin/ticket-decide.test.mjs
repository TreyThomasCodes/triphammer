import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Runs ticket-decide.py on made-up issues and pull requests in the shapes `gh issue list` / `gh pr list` return for the
// fields ticket-runner requests, at the tick time `now`, and returns what it printed. Unless `upkeepDone` is false, the
// list also holds a closed upkeep issue (#1) from the day before, so the weekly upkeep is not due.
const app = 'app/example-agents';
const repo = 'Example-Owner/example-project';
const now = '2026-10-17T12:00:00Z';
const daysAgo = days => new Date(Date.parse(now) - days * 86400000).toISOString().replace('.000Z', 'Z');
function jsonFile(t, value) {
  const root = mkdtempSync(join(tmpdir(), 'triphammer-decide-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  writeFileSync(join(root, 'input.json'), JSON.stringify(value));
  return join(root, 'input.json');
}
function ticketDecide(...args) {
  const result = spawnSync('python3', ['-I', join(import.meta.dirname, 'ticket-decide.py'), ...args],
    {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  return result;
}
// `served` is the repository, and `owner`, when given, the owner login the runner passes (the Triphammer config's OWNER).
// `state`, when given, maps the state directory's records (security-findings, security-followed-up) to their lines,
// and the state directory is passed too.
function decide(t, issues, prs = [], {upkeepDone = true, served = repo, owner, state} = {}) {
  const all = upkeepDone ? [upkeep(1, daysAgo(1), 'CLOSED'), ...issues] : issues;
  const extra = owner === undefined && state === undefined ? [] : [owner ?? ''];
  if (state !== undefined) {
    const dir = mkdtempSync(join(tmpdir(), 'triphammer-decide-state-'));
    t.after(() => rmSync(dir, {recursive: true, force: true}));
    for (const [name, records] of Object.entries(state)) writeFileSync(join(dir, name), records.map(r => `${r}\n`).join(''));
    extra.push(dir);
  }
  const result = ticketDecide(jsonFile(t, all), jsonFile(t, prs), app, now, served, ...extra);
  return {action: result.stdout.trim(), log: result.stderr};
}

const labelList = names => names.map(name => ({id: `L${name}`, name, description: '', color: 'ededed'}));
const owner = {id: 'MDQ6VXNlcjUwOTE5NTc=', is_bot: false, login: 'Example-Owner', name: 'Example Owner'};
const theApp = {is_bot: true, login: app};
const stranger = {id: 'U_stranger', is_bot: false, login: 'stranger', name: 'Stranger'};
const issue = (number, body = '', {state = 'OPEN', labels = [], author = theApp} = {}) =>
  ({number, state, author, body, labels: labelList(labels)});
const closed = (number, body = '') => issue(number, body, {state: 'CLOSED'});
const upkeep = (number, createdAt, state = 'OPEN') => ({...issue(number, '', {state, labels: ['upkeep']}), createdAt});

const checkRun = (name, conclusion, startedAt, {workflowName = 'test', status = 'COMPLETED'} = {}) => ({
  __typename: 'CheckRun', name, workflowName, status, conclusion, startedAt,
  completedAt: status === 'COMPLETED' ? startedAt.replace('T10', 'T11') : '0001-01-01T00:00:00Z',
  detailsUrl: `https://github.com/Example-Owner/example-project/actions/runs/${name}`,
});
const statusContext = (context, state, startedAt) =>
  ({__typename: 'StatusContext', context, state, startedAt, targetUrl: 'https://example.invalid/status'});
const passing = [checkRun('build', 'SUCCESS', '2026-10-16T10:00:00Z')];

// An issue reference in the shape of `gh pr list --json closingIssuesReferences`: GitHub's own link from a pull request
// to an issue it closes, `owner/name#number`.
const reference = (owner, name, number) => ({
  id: `I_${number}`, number, url: `https://github.com/${owner}/${name}/issues/${number}`,
  repository: {id: 'R_1', name, owner: {id: 'U_1', login: owner}},
});
const ours = number => reference('Example-Owner', 'example-project', number);

function pr(number, closes, {checks = passing, mergeStateStatus = 'CLEAN', reviews = [], labels = [], isDraft = false,
  author = app, committedDate = '2026-10-16T09:00:00Z', body = `Fixes a thing.\n\nCloses #${closes}`,
  closingIssuesReferences = [ours(closes)], headRefOid = 'abc123'} = {}) {
  return {
    number, body, closingIssuesReferences, author: {is_bot: true, login: author}, isDraft,
    labels: labelList(labels),
    headRefName: `ticket/${closes}`, headRefOid, mergeStateStatus, statusCheckRollup: checks,
    reviews: reviews.map(([state, submittedAt, login = 'Example-Owner']) =>
      ({id: 'R1', author: login === null ? null : {login}, body: '', state, submittedAt})),
    commits: [{oid: 'abc123', committedDate, authoredDate: committedDate, messageHeadline: 'work', messageBody: ''}],
  };
}

// Existing decisions.

test('issues by the owner and the App are taken, and anyone else\'s are skipped with a note', t => {
  assert.equal(decide(t, [issue(50, '', {author: owner})]).action, 'ticket 50');
  assert.equal(decide(t, [issue(50, '', {author: theApp})]).action, 'ticket 50');
  const {action, log} = decide(t, [issue(50, '', {author: stranger}), issue(51, '', {author: owner})]);
  assert.equal(action, 'ticket 51');
  assert.match(log, /#50 waits: its author, stranger, is neither the owner, Example-Owner, nor the App/);
  assert.equal(decide(t, [issue(50, '', {author: stranger, labels: ['next']})]).action, '');
});

test('an issue without an author is skipped', t => {
  const {author, ...authorless} = issue(50);
  for (const unknown of [authorless, {...authorless, author: null}, {...authorless, author: {}}]) {
    const {action, log} = decide(t, [unknown]);
    assert.equal(action, '');
    assert.match(log, /#50 waits: its author, nobody, is neither the owner, Example-Owner, nor the App/);
  }
});

test('a stranger\'s slice declarations neither close a parent nor hold back a slice', t => {
  assert.equal(decide(t, [issue(10), closed(11, 'Slice 1 of #10.')]).action, 'close 10');
  const closedByStranger = {...closed(11, 'Slice 1 of #10.'), author: stranger};
  assert.equal(decide(t, [issue(10), closedByStranger]).action, 'ticket 10');
  const openByStranger = issue(11, 'Slice 1 of #10.', {author: stranger});
  assert.equal(decide(t, [issue(10), openByStranger, issue(12, 'Slice 2 of #10.')]).action, 'ticket 12');
});

test('a parent whose slices are all closed is closed', t => {
  const {action} = decide(t, [issue(10), closed(11, 'Slice 1 of #10.'), closed(12, 'Slice 2 of #10.'), issue(20)]);
  assert.equal(action, 'close 10');
});

for (const brake of ['hold', 'needs-owner', 'stop-agents']) {
  test(`a parent labelled ${brake} stays open when its last slice closes, and the runner says why`, t => {
    const {action, log} = decide(t, [issue(10, '', {labels: [brake]}), closed(11, 'Slice 1 of #10.'),
      closed(12, 'Slice 2 of #10.'), issue(20)]);
    assert.equal(action, 'ticket 20');
    assert.match(log, new RegExp(`skip close 10: labelled ${brake}`));
  });
}

test('a parent with an open slice is not closed, and the open slice is the next ticket', t => {
  const {action} = decide(t, [issue(10), closed(11, 'Slice 1 of #10.'), issue(12, 'Slice 2 of #10.')]);
  assert.equal(action, 'ticket 12');
});

test('a pull request with conflicts is repaired for conflicts', t => {
  const {action} = decide(t, [issue(30)], [pr(40, 30, {mergeStateStatus: 'DIRTY'})]);
  assert.equal(action, 'repair 40 30 conflicts');
});

test('a pull request whose only check failed is repaired for failing-checks', t => {
  const checks = [checkRun('build', 'FAILURE', '2026-10-16T10:00:00Z')];
  assert.equal(decide(t, [issue(30)], [pr(40, 30, {checks})]).action, 'repair 40 30 failing-checks');
});

test('a failing status context is repaired for failing-checks', t => {
  const checks = [...passing, statusContext('ci/external', 'ERROR', '2026-10-16T10:00:00Z')];
  assert.equal(decide(t, [issue(30)], [pr(40, 30, {checks})]).action, 'repair 40 30 failing-checks');
});

test('a failing owner-approval check alone does not trigger a repair', t => {
  const checks = [...passing, checkRun('owner-approval', 'FAILURE', '2026-10-16T10:00:00Z')];
  assert.equal(decide(t, [issue(30)], [pr(40, 30, {checks})]).action, '');
});

test('changes requested after the latest commit are repaired; ones before it are not', t => {
  const after = pr(40, 30, {reviews: [['CHANGES_REQUESTED', '2026-10-16T12:00:00Z']]});
  assert.equal(decide(t, [issue(30)], [after]).action, 'repair 40 30 changes-requested');
  const before = pr(40, 30, {reviews: [['CHANGES_REQUESTED', '2026-10-16T08:00:00Z']]});
  assert.equal(decide(t, [issue(30)], [before]).action, '');
});

test('only the owner\'s changes requested start a repair', t => {
  const fromOwner = pr(40, 30, {reviews: [['CHANGES_REQUESTED', '2026-10-16T12:00:00Z', 'example-owner']]});
  assert.equal(decide(t, [issue(30)], [fromOwner]).action, 'repair 40 30 changes-requested');
  for (const login of ['stranger', app, null]) {
    const other = pr(40, 30, {reviews: [['CHANGES_REQUESTED', '2026-10-16T12:00:00Z', login]]});
    assert.equal(decide(t, [issue(30)], [other]).action, '', String(login));
  }
});

test('the owner\'s latest review that is not a comment decides whether changes are requested', t => {
  const reviews = (...rs) => pr(40, 30, {reviews: rs});
  const withdrawn = reviews(['CHANGES_REQUESTED', '2026-10-16T12:00:00Z'], ['APPROVED', '2026-10-16T13:00:00Z']);
  assert.equal(decide(t, [issue(30)], [withdrawn]).action, '');
  const requested = reviews(['APPROVED', '2026-10-16T12:00:00Z'], ['CHANGES_REQUESTED', '2026-10-16T13:00:00Z']);
  assert.equal(decide(t, [issue(30)], [requested]).action, 'repair 40 30 changes-requested');
  const commented = reviews(['CHANGES_REQUESTED', '2026-10-16T12:00:00Z'], ['COMMENTED', '2026-10-16T13:00:00Z']);
  assert.equal(decide(t, [issue(30)], [commented]).action, 'repair 40 30 changes-requested');
  const approvedByOther = reviews(['CHANGES_REQUESTED', '2026-10-16T12:00:00Z'],
    ['APPROVED', '2026-10-16T13:00:00Z', 'stranger']);
  assert.equal(decide(t, [issue(30)], [approvedByOther]).action, 'repair 40 30 changes-requested');
});

// The security-findings repair: the state directory records the heads whose security review returned findings
// (bin/security-review) and the ones whose repair session ended normally (ticket-runner).
const head = 'a'.repeat(40);
const oldHead = 'b'.repeat(40);
const finding = (number, oid = head, served = repo) => `${served} ${number} ${oid}`;

test('a pull request whose head has security findings and no follow-up is repaired for security-findings', t => {
  const open = pr(40, 30, {headRefOid: head});
  assert.equal(decide(t, [issue(30)], [open], {state: {'security-findings': [finding(40)]}}).action,
    'repair 40 30 security-findings');
  assert.equal(decide(t, [issue(30)], [open], {state: {'security-findings': [finding(40)], 'security-followed-up': []}})
    .action, 'repair 40 30 security-findings', 'an empty follow-up record follows nothing up');
});

test('a head that was followed up, a record of an older head, or of another pull request starts no repair', t => {
  const open = pr(40, 30, {headRefOid: head});
  const followed = {'security-findings': [finding(40)], 'security-followed-up': [finding(40)]};
  assert.equal(decide(t, [issue(30)], [open], {state: followed}).action, '');
  assert.equal(decide(t, [issue(30)], [open], {state: {'security-findings': [finding(40, oldHead)]}}).action, '');
  assert.equal(decide(t, [issue(30)], [open], {state: {'security-findings': [finding(41)]}}).action, '');
  const elsewhere = {'security-findings': [finding(40, head, 'Example-Owner/other-project')]};
  assert.equal(decide(t, [issue(30)], [open], {state: elsewhere}).action, '');
  const newHead = {'security-findings': [finding(40, oldHead), finding(40)], 'security-followed-up': [finding(40, oldHead)]};
  assert.equal(decide(t, [issue(30)], [open], {state: newHead}).action, 'repair 40 30 security-findings',
    'a new head with findings of its own is repaired again');
});

test('without records, or without a state directory, nothing waits for a security follow-up', t => {
  const open = pr(40, 30, {headRefOid: head});
  assert.equal(decide(t, [issue(30)], [open], {state: {}}).action, '');
  assert.equal(decide(t, [issue(30)], [open]).action, '');
});

test('conflicts, failing checks and changes requested win over security findings', t => {
  const state = {'security-findings': [finding(40)]};
  const failing = [checkRun('build', 'FAILURE', '2026-10-16T10:00:00Z')];
  const requested = [['CHANGES_REQUESTED', '2026-10-16T12:00:00Z']];
  for (const [options, reason] of [[{mergeStateStatus: 'DIRTY'}, 'conflicts'], [{checks: failing}, 'failing-checks'],
    [{reviews: requested}, 'changes-requested']]) {
    const open = pr(40, 30, {headRefOid: head, ...options});
    assert.equal(decide(t, [issue(30)], [open], {state}).action, `repair 40 30 ${reason}`);
  }
});

test('a security finding on a draft, a held pull request, or one not by the App starts no repair', t => {
  const state = {'security-findings': [finding(40)]};
  for (const options of [{isDraft: true}, {labels: ['hold']}, {author: 'stranger'}]) {
    const open = pr(40, 30, {headRefOid: head, ...options});
    assert.equal(decide(t, [issue(30)], [open], {state}).action, '', JSON.stringify(options));
  }
});

// A repository an organization owns: the organization's login is the repository's owner, and the owner the runner acts
// for is a person, the Triphammer config's OWNER.
const org = 'Example-Org/example-project';
const person = {id: 'U_person', is_bot: false, login: 'example-person', name: 'Example Person'};
const member = {id: 'U_member', is_bot: false, login: 'example-member', name: 'Example Member'};
const theOrg = {id: 'O_org', is_bot: false, login: 'Example-Org', name: 'Example Org'};
const inOrg = (number, closes, options = {}) =>
  pr(number, closes, {closingIssuesReferences: [reference('Example-Org', 'example-project', closes)], ...options});

test("in an organization's repository, the configured owner's issues are taken and the organization's and its other members' are not", t => {
  const options = {served: org, owner: 'example-person'};
  assert.equal(decide(t, [issue(50, '', {author: person})], [], options).action, 'ticket 50');
  assert.equal(decide(t, [issue(50, '', {author: {...person, login: 'Example-Person'}})], [], options).action, 'ticket 50');
  assert.equal(decide(t, [issue(50, '', {author: theApp})], [], options).action, 'ticket 50');
  for (const who of [member, theOrg, stranger]) {
    const {action, log} = decide(t, [issue(50, '', {author: who})], [], options);
    assert.equal(action, '', who.login);
    assert.match(log, new RegExp(`#50 waits: its author, ${who.login}, is neither the owner, example-person, nor the App`));
  }
  const memberSlice = issue(11, 'Slice 1 of #10.', {author: member});
  assert.equal(decide(t, [issue(10), memberSlice, issue(12, 'Slice 2 of #10.')], [], options).action, 'ticket 12');
});

test("in an organization's repository, only the configured owner's changes requested start a repair", t => {
  const options = {served: org, owner: 'example-person'};
  const fromOwner = inOrg(40, 30, {reviews: [['CHANGES_REQUESTED', '2026-10-16T12:00:00Z', 'Example-Person']]});
  assert.equal(decide(t, [issue(30)], [fromOwner], options).action, 'repair 40 30 changes-requested');
  for (const login of ['example-member', 'Example-Org', 'stranger', app, null]) {
    const other = inOrg(40, 30, {reviews: [['CHANGES_REQUESTED', '2026-10-16T12:00:00Z', login]]});
    assert.equal(decide(t, [issue(30)], [other], options).action, '', String(login));
  }
});

test('an empty owner login falls back to the owner part of the repository', t => {
  assert.equal(decide(t, [issue(50, '', {author: owner})], [], {owner: ''}).action, 'ticket 50');
});

test("the App's pull request is repaired whatever the case of its author's login", t => {
  for (const author of [app, 'App/Example-Agents', app.toUpperCase()]) {
    const {action} = decide(t, [issue(30)], [pr(40, 30, {mergeStateStatus: 'DIRTY', author})]);
    assert.equal(action, 'repair 40 30 conflicts', author);
  }
});

test('held, draft and owner-authored pull requests are not repaired', t => {
  const dirty = {mergeStateStatus: 'DIRTY'};
  const prs = [pr(40, 30, {...dirty, labels: ['hold']}), pr(41, 31, {...dirty, isDraft: true}),
    pr(42, 32, {...dirty, author: 'Example-Owner'})];
  assert.equal(decide(t, [issue(30), issue(31), issue(32)], prs).action, '');
});

test('the lowest-numbered ready issue is taken', t => {
  assert.equal(decide(t, [issue(52), issue(51), issue(53)]).action, 'ticket 51');
});

test('held, needs-owner, stop-agents and in-flight issues are skipped', t => {
  const issues = [issue(50, '', {labels: ['hold']}), issue(51, '', {labels: ['needs-owner']}),
    issue(52, '', {labels: ['stop-agents']}), issue(53), issue(54)];
  assert.equal(decide(t, issues, [pr(60, 53)]).action, 'ticket 54');
});

test('an issue waits for an open dependency and the previous slice, and starts once they are closed', t => {
  assert.equal(decide(t, [issue(50), issue(51, 'Depends on #50.')]).action, 'ticket 50');
  assert.equal(decide(t, [issue(50, '', {labels: ['hold']}), issue(51, 'Depends on #50.')]).action, '');
  assert.equal(decide(t, [closed(50), issue(51, 'Depends on #50.')]).action, 'ticket 51');
  const slices = [issue(10, '', {labels: ['hold']}), issue(11, 'Slice 1 of #10.', {labels: ['hold']}),
    issue(12, 'Slice 2 of #10.')];
  assert.equal(decide(t, slices).action, '');
});

// The `next` label.

const next = (number, body = '', labels = []) => issue(number, body, {labels: ['next', ...labels]});

test('a ready issue labelled next is taken before a lower-numbered ready issue', t => {
  assert.equal(decide(t, [issue(50), next(52), issue(51)]).action, 'ticket 52');
});

test('an issue labelled next waits for an open dependency, says so, and the lower issue is taken', t => {
  const {action, log} = decide(t, [issue(49), issue(50), next(52, 'Depends on #49.')]);
  assert.equal(action, 'ticket 49');
  assert.match(log, /#52 waits: it depends on #49, still open/);
  assert.equal(decide(t, [closed(49), issue(50), next(52, 'Depends on #49.')]).action, 'ticket 52');
});

test('an issue labelled next says when it waits on an open pull request or open slices', t => {
  const inFlight = decide(t, [issue(50), next(52)], [pr(60, 52)]);
  assert.equal(inFlight.action, 'ticket 50');
  assert.match(inFlight.log, /#52 waits: it has an open pull request/);
  const parent = decide(t, [next(10), issue(11, 'Slice 1 of #10.', {labels: ['hold']})]);
  assert.equal(parent.action, '');
  assert.match(parent.log, /#10 waits: its slices #11 are open/);
});

test('an issue labelled next and a brake is skipped', t => {
  for (const brake of ['hold', 'needs-owner', 'stop-agents']) {
    assert.equal(decide(t, [next(52, '', [brake]), issue(53)]).action, 'ticket 53', brake);
  }
});

test('of two ready issues labelled next, the lower number is taken', t => {
  assert.equal(decide(t, [issue(50), next(54), next(53)]).action, 'ticket 53');
});

test('a repair and a parent to close come before an issue labelled next', t => {
  assert.equal(decide(t, [issue(30), next(52)], [pr(40, 30, {mergeStateStatus: 'DIRTY'})]).action,
    'repair 40 30 conflicts');
  assert.equal(decide(t, [issue(10), closed(11, 'Slice 1 of #10.'), next(52)]).action, 'close 10');
});

// Superseded check runs.

test('a check with a cancelled older run and a passing newer run is not repaired', t => {
  const checks = [checkRun('build', 'SUCCESS', '2026-10-16T10:05:00Z'), checkRun('build', 'CANCELLED', '2026-10-16T10:00:00Z')];
  assert.equal(decide(t, [issue(30)], [pr(40, 30, {checks})]).action, '');
});

test('a check whose newer run is still queued is not repaired for its cancelled older run', t => {
  const queued = {...checkRun('build', '', '2026-10-16T10:00:00Z', {status: 'QUEUED'}), startedAt: '0001-01-01T00:00:00Z'};
  const checks = [checkRun('build', 'CANCELLED', '2026-10-16T10:00:00Z'), queued];
  assert.equal(decide(t, [issue(30)], [pr(40, 30, {checks})]).action, '');
});

test('a check whose latest run failed, timed out or was cancelled is repaired for failing-checks', t => {
  for (const conclusion of ['FAILURE', 'TIMED_OUT', 'CANCELLED']) {
    const checks = [checkRun('build', 'SUCCESS', '2026-10-16T10:00:00Z'), checkRun('build', conclusion, '2026-10-16T10:05:00Z')];
    assert.equal(decide(t, [issue(30)], [pr(40, 30, {checks})]).action, 'repair 40 30 failing-checks', conclusion);
  }
});

test('checks with the same name in different workflows count separately', t => {
  const checks = [checkRun('build', 'FAILURE', '2026-10-16T10:00:00Z', {workflowName: 'risk-tier'}),
    checkRun('build', 'SUCCESS', '2026-10-16T10:05:00Z', {workflowName: 'test'})];
  assert.equal(decide(t, [issue(30)], [pr(40, 30, {checks})]).action, 'repair 40 30 failing-checks');
});

test('a status context counts by its latest report', t => {
  const checks = [...passing, statusContext('ci/external', 'SUCCESS', '2026-10-16T10:05:00Z'),
    statusContext('ci/external', 'ERROR', '2026-10-16T10:00:00Z')];
  assert.equal(decide(t, [issue(30)], [pr(40, 30, {checks})]).action, '');
});

// Two issues claiming the same slice.

test('an open issue claiming slice 2 keeps the parent open and blocks slice 3, whatever a closed duplicate says', t => {
  for (const order of [[11, 12, 13], [13, 12, 11]]) {  // the closed duplicate comes before or after the open one
    const byNumber = {11: closed(11, 'Slice 2 of #10.'), 12: issue(12, 'Slice 2 of #10.', {labels: ['hold']}),
      13: issue(13, 'Slice 2 of #10.')};
    const issues = [issue(10), closed(9, 'Slice 1 of #10.'), ...order.map(n => byNumber[n]),
      issue(14, 'Slice 3 of #10.'), issue(20, 'Depends on #10.')];
    // 12 (held) and 13 both claim slice 2; 13 is next, and neither the parent, 14 nor 20 may move.
    assert.equal(decide(t, issues).action, 'ticket 13');
    const busy = decide(t, issues, [pr(40, 13, {checks: passing})]);
    assert.equal(busy.action, '', 'slice 3 and the dependant of #10 wait while slice 2 is open');
  }
});

test('a parent is not closed while an open issue claims a slice that a closed issue also claims', t => {
  for (const duplicates of [[closed(11, 'Slice 2 of #10.'), issue(12, 'Slice 2 of #10.', {labels: ['hold']})],
    [issue(11, 'Slice 2 of #10.', {labels: ['hold']}), closed(12, 'Slice 2 of #10.')]]) {
    const issues = [issue(10), closed(9, 'Slice 1 of #10.'), ...duplicates];
    assert.equal(decide(t, issues).action, '');
  }
});

// Dependencies outside the issue list.

test('a dependency that is not in the issue list keeps the ticket waiting and is logged', t => {
  const {action, log} = decide(t, [issue(50, 'Depends on #49.'), closed(48)]);
  assert.equal(action, '');
  assert.match(log, /#50 waits: it depends on #49, which is not in the issue list/);
  assert.equal(decide(t, [issue(50, 'Depends on #49.'), issue(51)]).action, 'ticket 51');
  assert.equal(decide(t, [issue(50, 'Depends on #48.'), closed(48)]).action, 'ticket 50');
});

// Weekly upkeep.

test('with nothing else to do and no upkeep issue in the last 7 days, the action is upkeep', t => {
  assert.equal(decide(t, [], [], {upkeepDone: false}).action, 'upkeep');
  assert.equal(decide(t, [closed(50), issue(51, '', {labels: ['hold']})], [], {upkeepDone: false}).action, 'upkeep');
  assert.equal(decide(t, [upkeep(50, daysAgo(8), 'CLOSED')], [], {upkeepDone: false}).action, 'upkeep');
  const heldOld = {...upkeep(50, daysAgo(8)), labels: labelList(['upkeep', 'hold'])};
  assert.equal(decide(t, [heldOld], [], {upkeepDone: false}).action, 'upkeep');
});

test('an upkeep issue created 6 days ago, open or closed, means no new one', t => {
  assert.equal(decide(t, [upkeep(50, daysAgo(6), 'CLOSED')], [], {upkeepDone: false}).action, '');
  const held = {...upkeep(50, daysAgo(6)), labels: labelList(['upkeep', 'hold'])};
  assert.equal(decide(t, [held], [], {upkeepDone: false}).action, '');
  assert.equal(decide(t, [upkeep(50, daysAgo(6))], [], {upkeepDone: false}).action, 'ticket 50', 'it runs as a ticket');
});

test('an issue created recently without the upkeep label does not count as upkeep', t => {
  const other = {...closed(50), createdAt: daysAgo(1)};
  assert.equal(decide(t, [other], [], {upkeepDone: false}).action, 'upkeep');
});

test('a parent to close, a repair and a ready ticket all come before upkeep', t => {
  const options = {upkeepDone: false};
  assert.equal(decide(t, [issue(10), closed(11, 'Slice 1 of #10.')], [], options).action, 'close 10');
  assert.equal(decide(t, [issue(30)], [pr(40, 30, {mergeStateStatus: 'DIRTY'})], options).action, 'repair 40 30 conflicts');
  assert.equal(decide(t, [issue(51)], [], options).action, 'ticket 51');
});

// Which issues a pull request closes: GitHub's closingIssuesReferences, the links the pr-contract check counts.

test('every closing phrasing GitHub links makes the issue in flight', t => {
  // Each body as written, with the link GitHub records for it.
  const phrasings = ['Closes #600', 'Closes: #600', 'Fixed #600', 'Close #600', 'closes example-owner/example-project#600',
    'Closes Example-Owner/example-project#600', 'RESOLVES #600'];
  for (const body of phrasings) {
    const {action} = decide(t, [issue(600)], [pr(700, 600, {body})]);
    assert.equal(action, '', `${body}: #600 has an open pull request`);
  }
});

test('a link to this repository counts whatever the case GitHub reports it in', t => {
  const closingIssuesReferences = [reference('example-owner', 'Example-Project', 600)];
  assert.equal(decide(t, [issue(600)], [pr(700, 600, {closingIssuesReferences})]).action, '');
});

test("another repository's #N does not make this repository's #N in flight", t => {
  const other = pr(700, 600, {body: 'Closes other/repo#600', closingIssuesReferences: [reference('other', 'repo', 600)]});
  assert.equal(decide(t, [issue(600)], [other]).action, 'ticket 600');
  const fork = pr(700, 600, {closingIssuesReferences: [reference('Example-Owner', 'example-project-fork', 600)]});
  assert.equal(decide(t, [issue(600)], [fork]).action, 'ticket 600');
});

test('a body naming an issue that GitHub does not link as closing does not count', t => {
  for (const [body, closingIssuesReferences] of [['Closes #6000', [ours(6000)]], ['prefixes #600', []], ['See #600', []]]) {
    const {action} = decide(t, [issue(600)], [pr(700, 600, {body, closingIssuesReferences})]);
    assert.equal(action, 'ticket 600', body);
  }
});

test('a pull request to repair names the issue GitHub links it to', t => {
  const dirty = pr(40, 30, {body: 'Fixed: #30', mergeStateStatus: 'DIRTY'});
  assert.equal(decide(t, [issue(30)], [dirty]).action, 'repair 40 30 conflicts');
});

// Where a declaration counts: at the start of a line, never quoted, in code or inside other text.

// What ticket-decide.py --declarations reads in each issue body.
const declarationsOf = (t, issues) => JSON.parse(ticketDecide('--declarations', jsonFile(t, issues)).stdout);

const counted = {
  'its own line': 'Some context.\n\nDepends on #50.\n',
  'a line that goes on with more text': 'Depends on #50 for its schema, which this reads.',
  'after a - marker': '**Dependencies:**\n- Depends on #50.',
  'after a * marker': '* Depends on #50.',
  'after a 1. marker': '1. Depends on #50.',
  'a later sentence on a line that starts with a declaration': 'Slice 2 of #10. Depends on #50.',
};
for (const [form, body] of Object.entries(counted)) {
  test(`a dependency declared on ${form} counts`, t => {
    // #50 is open but held, so it is never taken itself: #51 waits for it only if the declaration is read.
    assert.equal(decide(t, [issue(50, '', {labels: ['hold']}), issue(51, body)]).action, '', 'it waits for #50');
    assert.equal(decide(t, [closed(50), issue(51, body)]).action, 'ticket 51', 'it starts once #50 is closed');
  });
}

const ignored = {
  'mid-sentence': 'The old runner read "anything", so a body saying it Depends on #50 was enough.',
  'in quotation marks': '"Depends on #50."',
  'in smart quotation marks': '\u201cDepends on #50.\u201d',
  'in inline code': '`Depends on #50.`',
  'in a fenced block': 'Example:\n```\nDepends on #50.\n```\n',
  'in a tilde fenced block': '~~~text\nDepends on #50.\n~~~',
  'in a blockquote': '> Depends on #50.',
  'in a quoted later sentence': 'Depends on #49. Its body says "x. Depends on #50."',
};
for (const [form, body] of Object.entries(ignored)) {
  test(`a dependency ${form} does not count`, t => {
    assert.equal(decide(t, [closed(49), issue(50), issue(51, body)]).action, 'ticket 50');
    const held = [closed(49), issue(50, '', {labels: ['hold']}), issue(51, body)];
    assert.equal(decide(t, held).action, 'ticket 51', 'it does not wait for #50');
  });
}

test('each counted and ignored form reads the declarations it should', t => {
  const read = declarationsOf(t, [
    issue(60, 'Slice 2 of #10. Waits for slice 1.\nDepends on #50 and on its migration.'),
    issue(61, '- Slice 3 of #10. Depends on #50. Depends on #51.'),
    issue(62, 'Text after a fence\n```\nSlice 1 of #10.\n```\nDepends on #52.'),
    issue(63, 'Mentions Slice 1 of #10 and Depends on #50 in prose. `Slice 1 of #10.`\n> Slice 1 of #10.'),
  ]);
  assert.deepEqual(read, {
    60: {slices: [[2, 10]], depends: [50]},
    61: {slices: [[3, 10]], depends: [50, 51]},
    62: {slices: [], depends: [52]},
    63: {slices: [], depends: []},
  });
});

test('a declaration after prose on a declaration-led line does not count', t => {
  const read = declarationsOf(t, [
    issue(64, 'Slice 2 of #10. Waits for slice 1. The old parser read e.g. Depends on #51 anywhere.\nDepends on #50.'),
    issue(65, 'Slice 2 of #10. Waits for slice 1. Depends on #50.'),
    issue(66, 'Depends on #50. The old runner read any mention. Slice 1 of #42 was what it saw.'),
  ]);
  assert.deepEqual(read, {
    64: {slices: [[2, 10]], depends: [50]},
    65: {slices: [[2, 10]], depends: [50]},
    66: {slices: [], depends: [50]},
  });
});

test('a closed issue naming an open parent in a sentence after prose does not close the parent', t => {
  const body = 'Depends on #50. The old runner read any mention. Slice 1 of #42 was what it saw.';
  const {action} = decide(t, [issue(42), closed(50), closed(600, body)]);
  assert.equal(action, 'ticket 42');
});

test('triple backticks on one line are inline code, not a fence that hides the next line', t => {
  const read = declarationsOf(t, [
    issue(67, '```Depends on #49```\nDepends on #50.'),
    issue(68, '~~~ a `tilde` fence\nDepends on #49.\n~~~\nDepends on #50.'),
  ]);
  assert.deepEqual(read, {
    67: {slices: [], depends: [50]},
    68: {slices: [], depends: [50]},
  });
});

test('a closed issue quoting the slice syntax for an open parent mid-line does not close the parent', t => {
  // A reproduction quoted in a body named another issue's slice.
  const quoting = closed(600, 'Reproduction: a body containing "Slice 1 of #42." made the runner read Slice 1 of #42 as a slice.');
  const {action} = decide(t, [issue(42), quoting]);
  assert.equal(action, 'ticket 42');
  const declared = decide(t, [issue(42), closed(600, 'Slice 1 of #42.')]);
  assert.equal(declared.action, 'close 42', 'the same parent closes when the slice is declared');
});
