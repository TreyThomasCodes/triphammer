import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {fakeGh, here, lines, manyLabels, toolingEnv, withUmask, writeConfig} from './fixture.mjs';

// The fake gh's routes: the installation's repositories (repos.json), each repository's pull requests
// (graphql-<owner>_<name>-.json), one pull request's head and checks (graphql-<owner>_<name>-<number>.json) and
// stop-agents issues (issues-<owner>_<name>.json, or a failing query when that file is absent), and no issue events
// (`events` serves some). Any other call fails.
const routes = {
  'api /installation/repositories': {file: 'repos.json'},
  'api repos/': {stdout: ''},
  'api graphql': {file: 'graphql-{owner}_{name}-{number}.json'},
  'issue list': {file: 'issues-{repo}.json'},
  'pr update-branch': {},
  'pr merge': {},
  'pr view': {stdout: 'OPEN\n'},
  '': {stderr: 'fake gh: unexpected call\n', exit: 2},
};

// A merge or branch update the fake gh saw, as `merge <repo>#<number> <head>` or `update-branch <repo>#<number>`.
const summary = ([, command, number, ...rest]) =>
  [command, `${rest[rest.indexOf('--repo') + 1]}#${number}`, ...(command === 'merge' ? [rest.at(-1)] : [])].join(' ');

const pr = (number, mergeStateStatus, labels = []) => ({
  number, baseRefName: 'main', headRefName: `branch-${number}`, headRefOid: `${number}`.padEnd(40, 'a'), mergeStateStatus,
  autoMergeRequest: {enabledAt: '2026-10-17T00:00:00Z'},
  labels: {pageInfo: {hasNextPage: false}, nodes: labels.map(name => ({name}))},
});

// An armed pull request whose auto-merge was enabled at `enabledAt` and whose head carries `checks` (CheckRun and
// StatusContext nodes as GitHub's statusCheckRollup returns them).
const queued = (number, mergeStateStatus, enabledAt, checks = []) =>
  ({...pr(number, mergeStateStatus), autoMergeRequest: {enabledAt}, checks});

// Timestamps relative to the wall clock the script reads, at GitHub's whole-second precision.
const minutesAgo = minutes => new Date(Date.now() - minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

const checkRun = (name, conclusion, startedAt = '2026-10-17T00:00:00Z', isRequired = true) => ({
  __typename: 'CheckRun', name, status: conclusion ? 'COMPLETED' : 'IN_PROGRESS', conclusion, startedAt,
  checkSuite: {createdAt: startedAt}, isRequired,
});
const passed = checkRun('pr-contract', 'SUCCESS');
const running = startedAt => checkRun('pr-contract', null, startedAt);
const ownerApproval = (state, isRequired = true) =>
  ({__typename: 'StatusContext', context: 'owner-approval', state, createdAt: '2026-10-17T00:00:00Z', isRequired});

// Two installation repositories, o/a and o/b, with no pull requests and no stop-agents issue; the state directory and
// the fake gh live in a temporary directory. The Triphammer config ($TRIPHAMMER_CONFIG, `config` rewrites it) has the ticket
// runner serve o/a with its state in state/ticket-runner, and starting the runner appends to a file that `starts` reads.
function queueSetup(t) {
  const root = mkdtempSync(join(tmpdir(), 'triphammer-merge-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const fake = join(root, 'gh');
  const gh = fakeGh(fake, routes);
  const state = join(root, 'state');
  const json = gh.json;
  const repositories = ['o/a', 'o/b'];
  const startsFile = join(root, 'starts');
  const configFile = join(root, 'triphammer.conf');
  const r = {
    root,
    runnerState: join(state, 'ticket-runner'),
    config: settings => writeConfig(configFile,
      {REPO: 'o/a', CHECKOUT: root, APP_AUTHOR: 'app/agents', STATE_DIR: join(state, 'ticket-runner'), ...settings}),
    env: {TRIPHAMMER_CONFIG: configFile, TICKET_RUNNER_START: `echo started >> '${startsFile}'`},
    script: join(here, 'merge-when-ready'),
    repositories: names => json('repos.json', {repositories: names.map(full_name => ({full_name}))}),
    pulls(repository, nodes) {
      const [owner, name] = repository.split('/');
      json(`graphql-${owner}_${name}-.json`, {data: {repository: {
        defaultBranchRef: {name: 'main'}, pullRequests: {nodes: nodes.map(({checks, ...node}) => node)},
      }}});
      for (const {number, headRefOid, mergeStateStatus, checks = []} of nodes) {
        json(`graphql-${owner}_${name}-${number}.json`, {data: {repository: {pullRequest: {
          headRefOid, mergeStateStatus,
          commits: {nodes: [{commit: {statusCheckRollup: {contexts: {nodes: checks}}}}]},
        }}}});
      }
    },
    stopIssues: (repository, issues) => json(`issues-${repository.replace('/', '_')}.json`, issues),
    failStopQuery: repository => rmSync(join(fake, `issues-${repository.replace('/', '_')}.json`)),
    // Runs the shell `command` each time gh is asked to merge, before the fake answers, as an owner acting mid-tick.
    onMerge(command) {
      const wrapper = join(gh.bin, 'gh');
      writeFileSync(wrapper, readFileSync(wrapper, 'utf8').replace('\n', `\nif [ "$1 $2" = "pr merge" ]; then ${command}; fi\n`));
    },
    tick() {
      const result = spawnSync(r.script, [], {
        encoding: 'utf8',
        env: {...toolingEnv, XDG_STATE_HOME: state, PATH: `${gh.bin}:${process.env.PATH}`, ...r.env},
      });
      return {status: result.status, output: result.stdout + result.stderr};
    },
    gh,
    calls: () => gh.calls().filter(([group, command]) => group === 'pr' && ['merge', 'update-branch'].includes(command))
      .map(summary).sort(),
    log: () => readFileSync(join(state, 'merge-when-ready.log'), 'utf8'),
    starts: () => lines(startsFile).length,
  };
  r.config({});
  r.repositories(repositories);
  for (const repository of repositories) {
    r.pulls(repository, []);
    r.stopIssues(repository, []);
  }
  return r;
}

// Holds an exclusive flock on `file` from a child process, as ticket-runner holds its lock for a whole session, and
// returns that process.
async function holdLock(t, file) {
  const holder = spawn('flock', [file, 'sleep', '30'], {stdio: 'ignore'});
  t.after(() => holder.kill());
  for (let i = 0; i < 100; i++) {
    if (spawnSync('flock', ['-n', file, 'true']).status !== 0) return holder;
    await sleep(20);
  }
  throw new Error(`could not take the lock on ${file}`);
}

// Field 22 of /proc/<pid>/stat: when the process started, in clock ticks since boot.
const startTicks = pid => {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[22 - 3];
};

// Writes ticket-runner's `current` file as the runner writes it, naming process `pid` (by default with its own start
// time), the branch its session works on and the pull requests its run may push to.
function writeCurrent(r, {pid, started = startTicks(pid), kind, number, branch = `ticket/${number}`, prs = []}) {
  writeFileSync(join(r.runnerState, 'current'),
    `pid ${pid}\nstarted ${started}\nkind ${kind}\nnumber ${number}\nbranch ${branch}\nprs ${prs.join(' ')}\n`);
}

// A machine whose ticket-runner holds its lock, with the holding process.
async function busySetup(t) {
  const r = queueSetup(t);
  mkdirSync(r.runnerState, {recursive: true});
  return {r, holder: await holdLock(t, join(r.runnerState, 'lock'))};
}

test('with no brakes, clean pull requests merge and behind ones are updated', t => {
  const r = queueSetup(t);
  r.pulls('o/a', [pr(1, 'CLEAN'), pr(2, 'BEHIND'), pr(3, 'DIRTY'), {...pr(4, 'CLEAN'), autoMergeRequest: null}]);
  r.pulls('o/b', [pr(5, 'CLEAN'), {...pr(6, 'CLEAN'), baseRefName: 'feature'}]);
  assert.equal(r.tick().status, 0);
  assert.deepEqual(r.calls(), [`merge o/a#1 ${pr(1).headRefOid}`, `merge o/b#5 ${pr(5).headRefOid}`, 'update-branch o/a#2']);
  assert.match(r.log(), /o\/a#1: merged by merge-when-ready/);
});

test("every gh call gets the token of the App's installation on the served repository's account", t => {
  const r = queueSetup(t);
  r.config({REPO: 'Other-Org/a'});
  r.env.GITHUB_APP_OWNER = 'someone-else';
  const owners = join(r.root, 'owners');
  const wrapper = join(r.gh.bin, 'gh');
  writeFileSync(wrapper, readFileSync(wrapper, 'utf8').replace('\n', `\necho "$GITHUB_APP_OWNER" >> '${owners}'\n`));
  assert.equal(r.tick().status, 0);
  assert.ok(r.gh.calls().length > 0);
  assert.deepEqual([...new Set(lines(owners))], ['Other-Org']);
});

test('the stop file stops every merge and branch update', t => {
  const r = queueSetup(t);
  r.pulls('o/a', [pr(1, 'CLEAN'), pr(2, 'BEHIND')]);
  mkdirSync(r.runnerState, {recursive: true});
  writeFileSync(join(r.runnerState, 'stop'), '');
  assert.equal(r.tick().status, 0);
  assert.deepEqual(r.calls(), []);
  assert.match(r.log(), /paused: .*ticket-runner\/stop exists/);
});

test('an open stop-agents issue in any installation repository stops every merge and branch update', t => {
  const r = queueSetup(t);
  r.pulls('o/a', [pr(1, 'CLEAN'), pr(2, 'BEHIND')]);
  r.stopIssues('o/b', [{number: 9}]);
  assert.equal(r.tick().status, 0);
  assert.deepEqual(r.calls(), []);
  assert.match(r.log(), /paused: an open issue in o\/b is labelled stop-agents/);
});

test('a failed stop-agents query fails closed', t => {
  const r = queueSetup(t);
  r.pulls('o/a', [pr(1, 'CLEAN'), pr(2, 'BEHIND')]);
  r.failStopQuery('o/b');
  assert.equal(r.tick().status, 1);
  assert.deepEqual(r.calls(), []);
  assert.match(r.log(), /paused: the stop-agents query for o\/b failed/);
});

test('a pull request labelled hold is neither merged nor updated', t => {
  const r = queueSetup(t);
  r.pulls('o/a', [pr(1, 'CLEAN', ['hold']), pr(2, 'BEHIND', ['bug', 'hold']), pr(3, 'CLEAN', ['bug'])]);
  assert.equal(r.tick().status, 0);
  assert.deepEqual(r.calls(), [`merge o/a#3 ${pr(3).headRefOid}`]);
  assert.match(r.log(), /o\/a#1: labelled hold; not merging or updating it/);
  assert.match(r.log(), /o\/a#2: labelled hold; not merging or updating it/);
});

test('a pull request labelled Hold, in another case, is neither merged nor updated', t => {
  const r = queueSetup(t);
  r.pulls('o/a', [pr(1, 'CLEAN', ['Hold']), pr(2, 'BEHIND', ['HOLD']), pr(3, 'CLEAN')]);
  assert.equal(r.tick().status, 0);
  assert.deepEqual(r.calls(), [`merge o/a#3 ${pr(3).headRefOid}`]);
  assert.match(r.log(), /o\/a#1: labelled hold; not merging or updating it/);
  assert.match(r.log(), /o\/a#2: labelled hold; not merging or updating it/);
});

test('a pull request with more labels than one page, or with no page info, is neither merged nor updated', t => {
  const r = queueSetup(t);
  const many = pr(1, 'CLEAN', manyLabels(100));
  many.labels.pageInfo.hasNextPage = true;
  const unread = pr(2, 'BEHIND');
  delete unread.labels.pageInfo;
  r.pulls('o/a', [many, unread, pr(3, 'CLEAN')]);
  assert.equal(r.tick().status, 0);
  assert.deepEqual(r.calls(), [`merge o/a#3 ${pr(3).headRefOid}`]);
  assert.match(r.log(), /o\/a#1: more labels than merge-when-ready reads, so it may be labelled hold; not merging or updating it/);
  assert.match(r.log(), /o\/a#2: more labels than merge-when-ready reads/);
});

// The owner's brakes outlive the App's lifting them: the fake gh serves `value` as the events of `path` (issue #9 of
// o/b is `o/b/issues/9`, and the repository's issue events, newest first, `o/b/issues`), or a failed read for null.
const events = (r, path, value) => {
  const file = `events-${path.replaceAll('/', '_')}.json`;
  if (value !== null) r.gh.json(file, value);
  r.gh.respond({[`api repos/${path}/events`]: value === null ? {stderr: 'gh: HTTP 502\n', exit: 1} : {file}});
};
const labelEvent = (event, login, name) => ({event, actor: {login}, label: {name}});
const stateEvent = (event, login) => ({event, actor: {login}});
const stopAgentsLabelled = [{created_at: '2026-10-17T10:00:00Z', event: 'labeled', actor: {login: 'Example-Owner'},
  label: {name: 'stop-agents'}, issue: {number: 9}}];

test("a pull request whose hold the owner added and the App removed is neither merged nor updated; the owner's removal lifts it", t => {
  const r = queueSetup(t);
  r.pulls('o/a', [pr(1, 'CLEAN'), pr(2, 'BEHIND', ['bug']), pr(3, 'CLEAN')]);
  const appRemoved = [labelEvent('labeled', 'Example-Owner', 'hold'), labelEvent('unlabeled', 'agents[bot]', 'hold')];
  events(r, 'o/a/issues/1', appRemoved);
  events(r, 'o/a/issues/2', appRemoved);
  events(r, 'o/a/issues/3', [labelEvent('labeled', 'agents[bot]', 'hold'), labelEvent('unlabeled', 'agents[bot]', 'hold')]);
  assert.equal(r.tick().status, 0);
  assert.deepEqual(r.calls(), [`merge o/a#3 ${pr(3).headRefOid}`], "the App's own hold, removed, holds nothing");
  assert.match(r.log(), /o\/a#1: under the owner's hold, which the App removed; not merging or updating it/);
  assert.match(r.log(), /o\/a#2: under the owner's hold, which the App removed; not merging or updating it/);

  const lifted = queueSetup(t);
  lifted.pulls('o/a', [pr(1, 'CLEAN')]);
  events(lifted, 'o/a/issues/1', [...appRemoved, labelEvent('labeled', 'agents[bot]', 'Hold'),
    labelEvent('unlabeled', 'example-owner', 'Hold')]);
  assert.equal(lifted.tick().status, 0);
  assert.deepEqual(lifted.calls(), [`merge o/a#1 ${pr(1).headRefOid}`]);
});

test('a pull request whose events cannot be read is neither merged nor updated', t => {
  const r = queueSetup(t);
  r.pulls('o/a', [pr(1, 'CLEAN'), pr(2, 'CLEAN')]);
  events(r, 'o/a/issues/1', null);
  assert.equal(r.tick().status, 0);
  assert.deepEqual(r.calls(), [`merge o/a#2 ${pr(2).headRefOid}`]);
  assert.match(r.log(), /o\/a#1: could not read its events, which hold the owner's hold; not merging or updating it/);
});

test("an issue the owner labelled stop-agents stops every merge after the App closed or unlabelled it; the owner's lifts it", t => {
  const paused = /paused: issue #9 in o\/b is under the owner's stop-agents, which only the owner's unlabelling or closing lifts/;
  for (const [after, held] of [[stateEvent('closed', 'agents[bot]'), true],
    [labelEvent('unlabeled', 'agents[bot]', 'Stop-Agents'), true],
    [stateEvent('closed', 'Example-Owner'), false], [labelEvent('unlabeled', 'example-owner', 'stop-agents'), false]]) {
    const r = queueSetup(t);
    r.pulls('o/a', [pr(1, 'CLEAN'), pr(2, 'BEHIND')]);
    events(r, 'o/b/issues', stopAgentsLabelled);
    events(r, 'o/b/issues/9', [labelEvent('labeled', 'Example-Owner', 'stop-agents'), after]);
    assert.equal(r.tick().status, 0);
    if (held) {
      assert.deepEqual(r.calls(), [], JSON.stringify(after));
      assert.match(r.log(), paused);
    } else {
      assert.deepEqual(r.calls(), [`merge o/a#1 ${pr(1).headRefOid}`, 'update-branch o/a#2'], JSON.stringify(after));
    }
  }
});

test('a failed read of the stop-agents events fails closed', t => {
  for (const path of ['o/b/issues', 'o/b/issues/9']) {
    const r = queueSetup(t);
    r.pulls('o/a', [pr(1, 'CLEAN'), pr(2, 'BEHIND')]);
    events(r, 'o/b/issues', stopAgentsLabelled);
    events(r, 'o/b/issues/9', [labelEvent('labeled', 'Example-Owner', 'stop-agents'), stateEvent('closed', 'Example-Owner')]);
    events(r, path, null);
    assert.equal(r.tick().status, 1);
    assert.deepEqual(r.calls(), []);
    assert.match(r.log(), /paused: reading the stop-agents events of o\/b failed/);
  }
});

test('while ticket-runner holds its lock with no current file, branches are not updated but clean pull requests still merge', async t => {
  const {r} = await busySetup(t);
  r.pulls('o/a', [pr(1, 'CLEAN'), pr(2, 'BEHIND')]);
  r.pulls('o/b', [pr(3, 'BEHIND')]);
  assert.equal(r.tick().status, 0);
  assert.deepEqual(r.calls(), [`merge o/a#1 ${pr(1).headRefOid}`]);
  assert.match(r.log(), /ticket-runner holds its lock and .*ticket-runner\/current is missing; not updating any branch/);
  assert.match(r.log(), /o\/a#2: behind its base; not updating it while ticket-runner holds its lock/);
});

test('while ticket-runner works on a ticket with no pull request, a behind pull request is updated', async t => {
  const {r, holder} = await busySetup(t);
  writeCurrent(r, {pid: holder.pid, kind: 'ticket', number: 50});
  r.pulls('o/a', [pr(2, 'BEHIND')]);
  assert.equal(r.tick().status, 0);
  assert.deepEqual(r.calls(), ['update-branch o/a#2']);
  assert.doesNotMatch(r.log(), /not updating/);
});

test('while ticket-runner repairs #N, #N is not updated and another behind pull request is', async t => {
  const {r, holder} = await busySetup(t);
  writeCurrent(r, {pid: holder.pid, kind: 'repair', number: 2, prs: [2]});
  r.pulls('o/a', [queued(2, 'BEHIND', '2026-10-17T09:00:00Z'), queued(3, 'BEHIND', '2026-10-17T10:00:00Z')]);
  r.pulls('o/b', [pr(2, 'BEHIND')]);  // the same number in a repository ticket-runner does not serve
  assert.equal(r.tick().status, 0);
  assert.deepEqual(r.calls(), ['update-branch o/a#3', 'update-branch o/b#2']);
  assert.match(r.log(), /o\/a#2: not updating it while ticket-runner is repairing it/);
});

test('a pull request opened during the run on the branch ticket-runner works on is not updated', async t => {
  const {r, holder} = await busySetup(t);
  writeCurrent(r, {pid: holder.pid, kind: 'ticket', number: 50});
  r.pulls('o/a', [{...queued(2, 'BEHIND', '2026-10-17T09:00:00Z'), headRefName: 'ticket/50'},
    queued(3, 'BEHIND', '2026-10-17T10:00:00Z')]);
  assert.equal(r.tick().status, 0);
  assert.deepEqual(r.calls(), ['update-branch o/a#3']);
  assert.match(r.log(), /o\/a#2: not updating it while ticket-runner is working on its issue/);
});

test('a pull request ticket-runner repairs still holds the line while in flight', async t => {
  const {r, holder} = await busySetup(t);
  writeCurrent(r, {pid: holder.pid, kind: 'repair', number: 2, prs: [2]});
  r.pulls('o/a', [queued(2, 'BLOCKED', '2026-10-17T09:00:00Z', [running(minutesAgo(5))]),
    queued(3, 'BEHIND', '2026-10-17T10:00:00Z', [passed])]);
  r.tick();
  assert.deepEqual(r.calls(), []);
  assert.match(r.log(), /o\/a#2 in flight; not updating #3/);
});

test('a current file not written by the process holding the lock now, or unreadable, updates nothing', async t => {
  const variants = [
    [holder => ({pid: holder.pid, started: Number(startTicks(holder.pid)) - 1}), /names an earlier process/],
    [() => ({pid: process.pid}), /names process \d+, which does not hold the lock/],
    [() => ({pid: 999999999, started: 1}), /names process 999999999, which has ended/],
    [holder => ({pid: holder.pid, number: 'seven'}), /current is unreadable/],
    [holder => ({pid: holder.pid, branch: ''}), /current is unreadable/],
  ];
  for (const [fields, why] of variants) {
    const {r, holder} = await busySetup(t);
    writeCurrent(r, {kind: 'repair', number: 2, prs: [2], ...fields(holder)});
    r.pulls('o/a', [pr(3, 'BEHIND')]);
    assert.equal(r.tick().status, 0);
    assert.deepEqual(r.calls(), [], String(why));
    assert.match(r.log(), why);
    assert.match(r.log(), /o\/a#3: behind its base; not updating it while ticket-runner holds its lock/);
  }
});

test('a current file is not read while the lock is free', t => {
  const r = queueSetup(t);
  mkdirSync(r.runnerState, {recursive: true});
  writeFileSync(join(r.runnerState, 'current'), 'garbage\n');
  r.pulls('o/a', [pr(2, 'BEHIND')]);
  r.tick();
  assert.deepEqual(r.calls(), ['update-branch o/a#2']);
  assert.doesNotMatch(r.log(), /current/);
});

test('a lock file nobody holds does not stop branch updates, and a missing one is not created', t => {
  const r = queueSetup(t);
  r.pulls('o/a', [pr(2, 'BEHIND')]);
  r.tick();
  assert.equal(existsSync(r.runnerState), false, 'the runner state directory is not created');
  mkdirSync(r.runnerState, {recursive: true});
  writeFileSync(join(r.runnerState, 'lock'), '');
  r.tick();
  assert.deepEqual(r.calls(), ['update-branch o/a#2', 'update-branch o/a#2']);
});

test('a skip is logged once when it starts and once when it clears', t => {
  const r = queueSetup(t);
  r.pulls('o/a', [pr(1, 'CLEAN', ['hold'])]);
  r.stopIssues('o/a', [{number: 9}]);
  r.tick();
  r.tick();
  assert.equal(r.log().match(/paused: an open issue/g)?.length, 1, r.log());
  r.stopIssues('o/a', []);
  r.tick();
  r.tick();
  assert.equal(r.log().match(/cleared: paused: an open issue/g)?.length, 1, r.log());
  assert.equal(r.log().match(/o\/a#1: labelled hold/g)?.length, 1, 'a hold skip under a pause is logged once the pause clears');
  r.pulls('o/a', [pr(1, 'CLEAN')]);
  r.tick();
  assert.equal(r.log().match(/cleared: o\/a#1: labelled hold/g)?.length, 1, r.log());
  assert.deepEqual(r.calls(), [`merge o/a#1 ${pr(1).headRefOid}`]);
});

test('of two armed pull requests behind their base, only the one armed first is updated', t => {
  const r = queueSetup(t);
  r.pulls('o/a', [queued(3, 'BEHIND', '2026-10-17T10:00:00Z', [passed]), queued(7, 'BEHIND', '2026-10-17T09:00:00Z', [passed])]);
  assert.equal(r.tick().status, 0);
  assert.deepEqual(r.calls(), ['update-branch o/a#7']);
});

test('while an armed pull request is in flight no branch is updated, logged once until it clears', t => {
  const r = queueSetup(t);
  const behind = queued(2, 'BEHIND', '2026-10-17T10:00:00Z', [passed]);
  r.pulls('o/a', [queued(1, 'BLOCKED', '2026-10-17T09:00:00Z', [running(minutesAgo(5))]), behind]);
  r.tick();
  r.tick();
  assert.deepEqual(r.calls(), []);
  assert.equal(r.log().match(/o\/a#1 in flight; not updating #2/g)?.length, 1, r.log());
  r.pulls('o/a', [queued(1, 'BLOCKED', '2026-10-17T09:00:00Z', [passed]), behind]);
  r.tick();
  assert.deepEqual(r.calls(), ['update-branch o/a#2']);
  assert.equal(r.log().match(/cleared: o\/a#1 in flight; not updating #2/g)?.length, 1, r.log());
});

test('a pending check that is not required, or a pending owner-approval, does not hold the line', t => {
  const r = queueSetup(t);
  r.pulls('o/a', [
    queued(1, 'BLOCKED', '2026-10-17T08:00:00Z', [passed, ownerApproval('PENDING'), checkRun('lint', null, minutesAgo(5), false)]),
    queued(2, 'BEHIND', '2026-10-17T09:00:00Z', [passed, ownerApproval('SUCCESS')]),
    queued(3, 'BEHIND', '2026-10-17T10:00:00Z', [passed]),
  ]);
  r.tick();
  assert.deepEqual(r.calls(), ['update-branch o/a#2']);
});

test('of two clean armed pull requests, only the one armed first is merged', t => {
  const r = queueSetup(t);
  r.pulls('o/a', [queued(4, 'CLEAN', '2026-10-17T10:00:00Z', [passed]), queued(8, 'CLEAN', '2026-10-17T09:00:00Z', [passed])]);
  assert.equal(r.tick().status, 0);
  assert.deepEqual(r.calls(), [`merge o/a#8 ${pr(8).headRefOid}`]);
});

test('a pull request behind its base and waiting for owner-approval is not updated until approved', t => {
  const r = queueSetup(t);
  const waiting = queued(1, 'BEHIND', '2026-10-17T09:00:00Z', [passed, ownerApproval('PENDING')]);
  const next = queued(2, 'BEHIND', '2026-10-17T10:00:00Z', [passed, ownerApproval('SUCCESS')]);
  r.pulls('o/a', [waiting, next]);
  r.tick();
  assert.deepEqual(r.calls(), ['update-branch o/a#2']);
  assert.match(r.log(), /o\/a#1: behind its base, waiting for owner-approval; not updating it/);
  r.pulls('o/a', [{...waiting, checks: [passed, ownerApproval('SUCCESS')]}, next]);
  r.tick();
  assert.deepEqual(r.calls(), ['update-branch o/a#1', 'update-branch o/a#2']);
});

test('a pull request behind its base with a failed required check is skipped for the next', t => {
  const r = queueSetup(t);
  r.pulls('o/a', [
    queued(1, 'BEHIND', '2026-10-17T09:00:00Z', [checkRun('pr-contract', 'FAILURE')]),
    // A cancelled run superseded by a later passing run of the same check does not count as failed.
    queued(2, 'BEHIND', '2026-10-17T10:00:00Z', [checkRun('pr-contract', 'SUCCESS', '2026-10-17T01:00:00Z'),
      checkRun('pr-contract', 'CANCELLED', '2026-10-17T00:30:00Z')]),
    queued(3, 'BEHIND', '2026-10-17T11:00:00Z', [passed]),
  ]);
  r.tick();
  assert.deepEqual(r.calls(), ['update-branch o/a#2']);
  assert.match(r.log(), /o\/a#1: behind its base with a failed required check; not updating it/);
});

// Appends "<repo> <number> <head>" lines to security-review's findings record, or to ticket-runner's follow-up record.
function securityRecord(r, file, ...entries) {
  mkdirSync(r.runnerState, {recursive: true});
  writeFileSync(join(r.runnerState, file), entries.map(([repo, number, head]) => `${repo} ${number} ${head}\n`).join(''),
    {flag: 'a'});
}

test('an approved clean pull request whose head has security findings not followed up waits, then merges once followed up', t => {
  const r = queueSetup(t);
  const approved = [passed, ownerApproval('SUCCESS')];
  r.pulls('o/a', [queued(1, 'CLEAN', '2026-10-17T09:00:00Z', approved), queued(2, 'CLEAN', '2026-10-17T10:00:00Z', approved)]);
  securityRecord(r, 'security-findings', ['o/a', 1, pr(1).headRefOid]);
  assert.equal(r.tick().status, 0);
  // The held one does not take the merge slot: the next clean one merges.
  assert.deepEqual(r.calls(), [`merge o/a#2 ${pr(2).headRefOid}`]);
  assert.match(r.log(), /o\/a#1: security-review findings on 1aaaaaa not yet followed up; not merging it/);
  r.pulls('o/a', [queued(1, 'CLEAN', '2026-10-17T09:00:00Z', approved)]);
  securityRecord(r, 'security-followed-up', ['o/a', 1, pr(1).headRefOid]);
  assert.equal(r.tick().status, 0);
  assert.deepEqual(r.calls(), [`merge o/a#1 ${pr(1).headRefOid}`, `merge o/a#2 ${pr(2).headRefOid}`]);
  assert.match(r.log(), /cleared: o\/a#1: security-review findings/);
});

test('a behind pull request whose head has security findings not followed up is not updated, and the next one is', t => {
  const r = queueSetup(t);
  r.pulls('o/a', [queued(1, 'BEHIND', '2026-10-17T09:00:00Z', [passed]), queued(2, 'BEHIND', '2026-10-17T10:00:00Z', [passed])]);
  securityRecord(r, 'security-findings', ['o/a', 1, pr(1).headRefOid]);
  // A follow-up of another pull request, or of another repository's #1, does not count.
  securityRecord(r, 'security-followed-up', ['o/a', 2, pr(1).headRefOid], ['o/b', 1, pr(1).headRefOid]);
  assert.equal(r.tick().status, 0);
  assert.deepEqual(r.calls(), ['update-branch o/a#2']);
  assert.match(r.log(), /o\/a#1: security-review findings on 1aaaaaa not yet followed up; not updating it/);
});

test('a findings record for an earlier head, or for another repository, does not hold a pull request', t => {
  const r = queueSetup(t);
  r.pulls('o/a', [queued(1, 'CLEAN', '2026-10-17T09:00:00Z', [passed]), queued(2, 'BEHIND', '2026-10-17T10:00:00Z', [passed])]);
  r.pulls('o/b', [queued(1, 'CLEAN', '2026-10-17T09:00:00Z', [passed])]);
  securityRecord(r, 'security-findings', ['o/a', 1, 'f'.repeat(40)], ['o/a', 2, 'f'.repeat(40)], ['o/b', 1, pr(1).headRefOid]);
  assert.equal(r.tick().status, 0);
  assert.deepEqual(r.calls(), [`merge o/a#1 ${pr(1).headRefOid}`, `merge o/b#1 ${pr(1).headRefOid}`, 'update-branch o/a#2']);
  assert.doesNotMatch(r.log(), /security-review findings/);
});

test('an approved clean pull request with no security record merges', t => {
  const r = queueSetup(t);
  r.pulls('o/a', [queued(1, 'CLEAN', '2026-10-17T09:00:00Z', [passed, ownerApproval('SUCCESS')])]);
  assert.equal(r.tick().status, 0);
  assert.deepEqual(r.calls(), [`merge o/a#1 ${pr(1).headRefOid}`]);
});

test('a pull request in flight past the stall limit stops holding the line, and the stall is logged once', t => {
  const r = queueSetup(t);
  r.pulls('o/a', [
    queued(1, 'BLOCKED', '2026-10-17T09:00:00Z', [running(minutesAgo(46))]),
    queued(2, 'BEHIND', '2026-10-17T10:00:00Z', [passed]),
    queued(3, 'BEHIND', '2026-10-17T11:00:00Z', [passed]),
  ]);
  r.tick();
  r.tick();
  assert.deepEqual(r.calls(), ['update-branch o/a#2', 'update-branch o/a#2']);
  assert.equal(r.log().match(/o\/a#1: in flight since .*; stalled/g)?.length, 1, r.log());
});

test('each repository keeps its own line', t => {
  const r = queueSetup(t);
  r.pulls('o/a', [queued(1, 'BLOCKED', '2026-10-17T09:00:00Z', [running(minutesAgo(5))]), queued(2, 'BEHIND', '2026-10-17T10:00:00Z', [passed])]);
  r.pulls('o/b', [queued(3, 'BEHIND', '2026-10-17T11:00:00Z', [passed]), queued(4, 'BEHIND', '2026-10-17T12:00:00Z', [passed])]);
  r.tick();
  assert.deepEqual(r.calls(), ['update-branch o/b#3']);
});

test('a tick that merged into the served repository starts the ticket runner once, however many it merged', t => {
  const r = queueSetup(t);
  r.pulls('o/a', [pr(1, 'CLEAN')]);
  r.pulls('o/b', [pr(5, 'CLEAN')]);
  assert.equal(r.tick().status, 0);
  assert.deepEqual(r.calls(), [`merge o/a#1 ${pr(1).headRefOid}`, `merge o/b#5 ${pr(5).headRefOid}`]);
  assert.equal(r.starts(), 1);
  assert.match(r.log(), /started ticket-runner after merging o\/a#1\n/);
});

test('a merge only in another installation repository does not start the ticket runner', t => {
  const r = queueSetup(t);
  r.pulls('o/b', [pr(5, 'CLEAN')]);
  assert.equal(r.tick().status, 0);
  assert.deepEqual(r.calls(), [`merge o/b#5 ${pr(5).headRefOid}`]);
  assert.equal(r.starts(), 0);
  assert.doesNotMatch(r.log(), /ticket-runner after merging/);
});

test('a tick that merged nothing, or found the merge already done by GitHub, does not start the ticket runner', t => {
  const r = queueSetup(t);
  r.pulls('o/a', [pr(2, 'BEHIND')]);
  assert.equal(r.tick().status, 0);
  assert.equal(r.starts(), 0);
  r.pulls('o/a', [pr(1, 'CLEAN')]);
  r.gh.respond({'pr merge': {exit: 1}, 'pr view': {stdout: 'MERGED\n'}});
  assert.equal(r.tick().status, 0);
  assert.match(r.log(), /o\/a#1: already merged \(GitHub auto-merge\)/);
  assert.equal(r.starts(), 0);
});

test('the stop file, there before the tick or made during it, keeps the ticket runner from starting', t => {
  const r = queueSetup(t);
  r.pulls('o/a', [pr(1, 'CLEAN')]);
  mkdirSync(r.runnerState, {recursive: true});
  const stop = join(r.runnerState, 'stop');
  writeFileSync(stop, '');
  r.tick();
  assert.equal(r.starts(), 0);
  rmSync(stop);
  r.onMerge(`touch '${stop}'`);
  assert.equal(r.tick().status, 0);
  assert.deepEqual(r.calls(), [`merge o/a#1 ${pr(1).headRefOid}`]);
  assert.equal(r.starts(), 0);
  assert.match(r.log(), /not starting ticket-runner after merging o\/a#1: paused: .*ticket-runner\/stop exists/);
});

test('an open stop-agents issue, there before the tick or opened during it, keeps the ticket runner from starting', t => {
  const r = queueSetup(t);
  r.pulls('o/a', [pr(1, 'CLEAN')]);
  r.stopIssues('o/b', [{number: 9}]);
  r.tick();
  assert.equal(r.starts(), 0);
  r.stopIssues('o/b', []);
  r.onMerge(`echo '[{"number": 9}]' > '${join(r.root, 'gh', 'issues-o_b.json')}'`);
  assert.equal(r.tick().status, 0);
  assert.deepEqual(r.calls(), [`merge o/a#1 ${pr(1).headRefOid}`]);
  assert.equal(r.starts(), 0);
  assert.match(r.log(), /not starting ticket-runner after merging o\/a#1: paused: an open issue in o\/b is labelled stop-agents/);
});

test('a failed start is logged and the tick still succeeds', t => {
  const r = queueSetup(t);
  r.pulls('o/a', [pr(1, 'CLEAN')]);
  r.env.TICKET_RUNNER_START = 'exit 3';
  assert.equal(r.tick().status, 0);
  assert.match(r.log(), /starting ticket-runner after merging o\/a#1 failed/);
});

test("the served repository and the runner's state directory are the Triphammer config's REPO and STATE_DIR", t => {
  const r = queueSetup(t);
  r.config({REPO: 'o/b', STATE_DIR: join(r.root, 'elsewhere')});
  mkdirSync(join(r.root, 'elsewhere'));
  writeFileSync(join(r.root, 'elsewhere/stop'), '');
  assert.equal(r.tick().status, 0);
  assert.match(r.log(), new RegExp(`paused: ${join(r.root, 'elsewhere/stop')} exists`));
  rmSync(join(r.root, 'elsewhere/stop'));
  r.pulls('o/a', [pr(1, 'CLEAN')]);
  r.pulls('o/b', [pr(2, 'CLEAN')]);
  assert.equal(r.tick().status, 0);
  assert.deepEqual(r.calls(), [`merge o/a#1 ${pr(1).headRefOid}`, `merge o/b#2 ${pr(2).headRefOid}`]);
  assert.equal(r.starts(), 1);
  assert.match(r.log(), /started ticket-runner after merging o\/b#2\n/);
  assert.doesNotMatch(r.log(), /after merging o\/a#1/);
});

test('a missing or malformed Triphammer config stops the tick before any gh call, naming the file and the setting', t => {
  for (const [write, message] of [
    [r => rmSync(r.env.TRIPHAMMER_CONFIG), 'is missing or unreadable'],
    [r => r.config({STATE_DIR: null}), 'does not set STATE_DIR'],
    [r => r.config({REPO: 'not a repository'}), 'REPO must be owner/name, not not a repository'],
    [r => r.config({SERVED: 'o/a'}), 'sets SERVED, which is not a config setting'],
  ]) {
    const r = queueSetup(t);
    write(r);
    const result = r.tick();
    assert.equal(result.status, 2, message);
    assert.ok(result.output.includes('merge-when-ready: ') && result.output.includes(r.env.TRIPHAMMER_CONFIG), result.output);
    assert.ok(result.output.includes(message), result.output);
    assert.deepEqual(r.gh.calls(), [], message);
  }
});

test('the log and skip files are private to the service user under the usual umask of 022', t => {
  withUmask(t, 0o022);
  const r = queueSetup(t);
  r.pulls('o/a', [pr(1, 'CLEAN'), pr(2, 'CLEAN', ['hold'])]);
  assert.equal(r.tick().status, 0);
  for (const name of ['merge-when-ready.log', 'merge-when-ready.brakes', 'merge-when-ready.skips']) {
    assert.equal(statSync(join(r.root, 'state', name)).mode & 0o077, 0, name);
  }
});

// Two projects on one machine, as the template units run them: a.conf serves o/a with its runner's state in state/a and
// b.conf serves o/b with state/b, both under XDG_CONFIG_HOME, and the tick runs as merge-when-ready@<project>. Starting
// a runner appends `started <project>` (TRIPHAMMER_PROJECT, which the start command sees) to the file `projectStarts`
// reads.
function projectSetup(t, project) {
  const r = queueSetup(t);
  const config = join(r.root, 'xdg/triphammer');
  mkdirSync(config, {recursive: true});
  for (const name of ['a', 'b']) {
    mkdirSync(join(r.root, 'state', name), {recursive: true});
    writeConfig(join(config, `${name}.conf`),
      {REPO: `o/${name}`, CHECKOUT: r.root, APP_AUTHOR: 'app/agents', STATE_DIR: join(r.root, 'state', name)});
  }
  const startsFile = join(r.root, 'project-starts');
  r.env = {TRIPHAMMER_CONFIG: '', TRIPHAMMER_PROJECT: project, XDG_CONFIG_HOME: join(r.root, 'xdg'),
    TICKET_RUNNER_START: `echo "started $TRIPHAMMER_PROJECT" >> '${startsFile}'`};
  return {...r, projectStarts: () => lines(startsFile), projectLog: () => readFileSync(join(r.root, 'state', `merge-when-ready-${project}.log`), 'utf8')};
}

test("with a project, a merge in its repository starts that project's runner, never another's", t => {
  const r = projectSetup(t, 'b');
  r.pulls('o/a', [pr(1, 'CLEAN')]);
  r.pulls('o/b', [pr(2, 'CLEAN')]);
  assert.equal(r.tick().status, 0);
  assert.deepEqual(r.calls(), [`merge o/b#2 ${pr(2).headRefOid}`], "it leaves o/a's queue to merge-when-ready@a");
  assert.deepEqual(r.projectStarts(), ['started b']);
  assert.match(r.projectLog(), /started ticket-runner after merging o\/b#2\n/);
  assert.equal(existsSync(join(r.root, 'state/merge-when-ready.log')), false, 'the log is per project');
});

test("with a project and no TICKET_RUNNER_START, a merge starts that project's runner unit", t => {
  const r = projectSetup(t, 'b');
  const recorded = join(r.root, 'systemctl-calls');
  writeFileSync(join(r.gh.bin, 'systemctl'), `#!/bin/sh\necho "$*" >> '${recorded}'\n`, {mode: 0o755});
  delete r.env.TICKET_RUNNER_START;
  r.pulls('o/b', [pr(2, 'CLEAN')]);
  assert.equal(r.tick().status, 0);
  assert.deepEqual(lines(recorded), ['--user start --no-block ticket-runner@b.service']);
});

test("with a project, its runner's current file protects its own branches only", async t => {
  const r = projectSetup(t, 'b');
  // Project a's runner holds its lock with no current file, which would stop every update if b's tick read it.
  await holdLock(t, join(r.root, 'state/a/lock'));
  const holder = await holdLock(t, join(r.root, 'state/b/lock'));
  writeCurrent({runnerState: join(r.root, 'state/b')}, {pid: holder.pid, kind: 'repair', number: 2, prs: [2]});
  r.pulls('o/a', [queued(4, 'BEHIND', '2026-10-17T08:00:00Z')]);
  r.pulls('o/b', [queued(2, 'BEHIND', '2026-10-17T09:00:00Z'), queued(3, 'BEHIND', '2026-10-17T10:00:00Z')]);
  assert.equal(r.tick().status, 0);
  assert.deepEqual(r.calls(), ['update-branch o/b#3']);
  assert.match(r.projectLog(), /o\/b#2: not updating it while ticket-runner is repairing it/);
});

test('the shared stop file stops every project\'s merge queue', t => {
  for (const project of ['a', 'b']) {
    const r = projectSetup(t, project);
    mkdirSync(join(r.root, 'state/triphammer'), {recursive: true});
    writeFileSync(join(r.root, 'state/triphammer/stop'), '');
    r.pulls(`o/${project}`, [pr(1, 'CLEAN')]);
    assert.equal(r.tick().status, 0);
    assert.deepEqual(r.calls(), [], project);
    assert.match(r.projectLog(), /paused: .*triphammer\/stop exists/);
  }
});

// The config may spell REPO in any case; the installation lists the canonical name, here o/a and o/b.
test('with REPO spelled in another case, the pull request ticket-runner repairs is still not updated', async t => {
  const {r, holder} = await busySetup(t);
  r.config({REPO: 'O/A'});
  writeCurrent(r, {pid: holder.pid, kind: 'repair', number: 2, prs: [2]});
  r.pulls('o/a', [queued(2, 'BEHIND', '2026-10-17T09:00:00Z')]);
  assert.equal(r.tick().status, 0);
  assert.deepEqual(r.calls(), []);
  assert.match(r.log(), /o\/a#2: not updating it while ticket-runner is repairing it/);
});

test('with REPO spelled in another case, a merge into the served repository starts the ticket runner', t => {
  const r = queueSetup(t);
  r.config({REPO: 'O/A'});
  r.pulls('o/a', [pr(1, 'CLEAN')]);
  assert.equal(r.tick().status, 0);
  assert.deepEqual(r.calls(), [`merge o/a#1 ${pr(1).headRefOid}`]);
  assert.equal(r.starts(), 1);
  assert.match(r.log(), /started ticket-runner after merging o\/a#1\n/);
});

test("with a project whose REPO is spelled in another case, the tick still runs that repository's queue", t => {
  const r = projectSetup(t, 'b');
  writeConfig(join(r.root, 'xdg/triphammer/b.conf'),
    {REPO: 'O/B', CHECKOUT: r.root, APP_AUTHOR: 'app/agents', STATE_DIR: join(r.root, 'state/b')});
  r.pulls('o/b', [pr(2, 'CLEAN'), pr(3, 'BEHIND')]);
  assert.equal(r.tick().status, 0);
  assert.deepEqual(r.calls(), [`merge o/b#2 ${pr(2).headRefOid}`, 'update-branch o/b#3']);
  assert.deepEqual(r.projectStarts(), ['started b']);
});
