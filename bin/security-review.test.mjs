import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {gitEnv, gitRepo} from '../scripts/test-git-repo.mjs';
import {fakeCodex, fakeGh, here, lines, projectJson, writeConfig} from './fixture.mjs';

const repo = 'Example-Owner/example-project';
// The Triphammer config's CODEX_SECURITY_MODEL; the comment's heading names it without its trailing -latest.
const model = 'codex-security-test-latest';
const heading = 'Security review (codex-security-test)';
const brief = readFileSync(join(here, 'security-review-brief.md'), 'utf8');
const now = 1_800_000_000;
const hour = 3600;
// Words a comment about a review that did not happen must never use.
const cleanWording = /no findings|clean|nothing found|safe to merge/i;

// A bare origin with main (the example project's .triphammer/project.json, which `project` rewrites in the checkout) and pull
// request #5's head under refs/pull/5/head, Triphammer checkout cloned from it, a Triphammer config ($TRIPHAMMER_CONFIG, which
// `config` rewrites) naming the example project's repository and that checkout, with the codex module on and `model` as its
// CODEX_SECURITY_MODEL and a STATE_DIR in the test machine, a fake `gh` (fake-gh.mjs) that serves pr.json for `gh pr view 5`
// and files.json for the paginated REST list of its files, and the fake `codex` (fake-codex.mjs), both first on PATH,
// with the Codex state directory in the test machine.
function reviewSetup(t) {
  const {root, git, commit} = gitRepo(t, 'security-review');
  const origin = join(root, 'origin.git');
  const checkout = join(root, 'checkout');
  git('init', '-q', '--bare', '-b', 'main', origin);
  commit({'bin/ticket-runner': 'v1\n', '.triphammer/project.json': projectJson}, '-m', 'main');
  git('push', '-q', origin, 'main');
  const head = commit({'bin/ticket-runner': 'v2\n'}, '-m', 'the pull request');
  git('push', '-q', origin, 'HEAD:refs/pull/5/head');
  git('clone', '-q', origin, checkout);
  const gh = fakeGh(join(root, 'gh'), {[`pr view 5 -R ${repo} --json`]: {file: 'pr.json'},
    [`api --paginate repos/${repo}/pulls/5/files`]: {file: 'files.json'}});
  const {codex, codexCalls, pastRuns, runs} = fakeCodex(root, gh.bin, now);
  const configFile = join(root, 'triphammer.conf');
  const stateDir = join(root, 'state/ticket-runner');
  const reviewed = join(stateDir, 'security-reviewed');
  const config = settings => writeConfig(configFile, {REPO: repo, CHECKOUT: checkout, APP_AUTHOR: 'app/example-agents',
    STATE_DIR: stateDir, MODULES: 'codex', CODEX_SECURITY_MODEL: model, ...settings});
  config({});
  const env = {...gitEnv, PATH: `${gh.bin}:${process.env.PATH}`, HOME: root, XDG_STATE_HOME: join(root, 'state'),
    LOCAL_AUDIT_NOW: String(now), TRIPHAMMER_CONFIG: configFile};
  const r = {
    root, checkout, head, gh, config, configFile, stateDir,
    // The heads security-review recorded in its state directory, and forgetting them.
    reviewed: () => lines(reviewed),
    // The heads whose review returned findings, which hold their merge until a repair session follows them up.
    findings: () => lines(join(stateDir, 'security-findings')),
    forget: () => rmSync(reviewed, {force: true}),
    project: fields => writeFileSync(join(checkout, '.triphammer/project.json'), JSON.stringify({name: 'example-project', ...fields})),
    // Pull request #5 as `gh pr view` returns it, whose `files` stops at the first 100 as gh's never pages, and its files
    // as the paginated REST list returns them. A comment is its body, by the account the script posts as.
    pr({state = 'OPEN', files = ['bin/ticket-runner'], comments = [], headRefOid = head} = {}) {
      gh.json('pr.json', {state, headRefOid,
        files: files.slice(0, 100).map(path => ({path})),
        comments: comments.map(body => ({body, author: {login: 'example-agents'}}))});
      gh.json('files.json', files.map(filename => ({filename})));
    },
    run: (args, extraEnv = {}) => new Promise(resolve => {
      execFile(join(here, 'security-review'), args, {cwd: root, env: {...env, ...extraEnv}},
        (error, stdout, stderr) => resolve({code: error ? error.code : 0, stdout, stderr}));
    }),
    review: (extraEnv = {}) => r.run(['--pr', '5', '--repo', checkout], extraEnv),
    comments: () => gh.calls().filter(call => call[0] === 'pr' && call[1] === 'comment')
      .map(call => ({pr: call[2], body: call[call.indexOf('--body') + 1]})),
    execs: () => codexCalls().filter(call => call[0] === 'exec'),
    codex, codexCalls, pastRuns, runs,
  };
  r.pr();
  return r;
}

const flag = (args, name) => args[args.indexOf(name) + 1];

test('an open pull request touching each trigger path gets one review comment with the findings', async t => {
  const r = reviewSetup(t);
  for (const path of ['bin/ticket-runner', 'status/server.mjs', 'plugins/triphammer/hooks/agent-guard.py',
    'plugins/triphammer/hooks/text-lint.py', 'plugins/triphammer/hooks/hooks.json', '.claude/settings.json',
    'scripts/risk-tier.mjs', 'scripts/risk-tier-base.sh', '.github/workflows/ci.yml', '.triphammer/project.json',
    'deploy/triphammer-status.service', 'tools/x.timer', 'units/watch.path']) {
    r.pr({files: ['src/Domain/Money.cs', path]});
    r.forget();
    const before = r.comments().length;
    const result = await r.review({FAKE_CODEX_RESULT: 'Finding: bin/x:3 lets an issue opener lift a brake. Reproduction: ...'});
    assert.equal(result.code, 0, `${path}: ${result.stdout}${result.stderr}`);
    const added = r.comments().slice(before);
    assert.equal(added.length, 1, path);
    assert.equal(added[0].pr, '5');
    const body = added[0].body;
    assert.equal(body.split('\n')[0], `## ${heading}`);
    assert.match(body, new RegExp(`Head: ${r.head}`));
    assert.match(body, /Finding: bin\/x:3 lets an issue opener lift a brake/);
    assert.match(body, /Nothing reads this comment to decide a merge\. Findings start a repair session and hold the merge of this head until that session has followed them up/);
    assert.match(r.codex().args.at(-1), new RegExp(`the files pull request #5 changes, and whatever they call: src/Domain/Money.cs, ${path.replace(/\./g, '\\.')}`));
  }
  // The pull request has no labels: risk-tier adds needs-owner seconds after it opens, often after the session ends.
  assert.doesNotMatch(flag(r.gh.calls().find(call => call[0] === 'pr' && call[1] === 'view'), '--json'), /labels/);
});

test('a pull request with more than 100 files is reviewed when its only trigger path sorts after them', async t => {
  const r = reviewSetup(t);
  const src = Array.from({length: 150}, (_, i) => `src/Domain/File${String(i).padStart(3, '0')}.cs`);
  r.pr({files: [...src, 'bin/ticket-runner']});
  const result = await r.review();
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(r.comments().length, 1);
  assert.match(r.codex().args.at(-1), /src\/Domain\/File149\.cs, bin\/ticket-runner$/);
});

test('a pull request that only renames a file out of a trigger path is reviewed', async t => {
  const r = reviewSetup(t);
  r.gh.json('files.json', [{filename: 'docs/risk-tier.yml', previous_filename: '.github/workflows/risk-tier.yml',
    status: 'renamed'}]);
  const result = await r.review();
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(r.comments().length, 1);
  assert.match(r.codex().args.at(-1), /changes, and whatever they call: docs\/risk-tier\.yml, \.github\/workflows\/risk-tier\.yml$/);
});

test('a file list gh cannot read exits 1 with the reason, and reviews and comments nothing', async t => {
  const r = reviewSetup(t);
  r.gh.respond({[`api --paginate repos/${repo}/pulls/5/files`]: {stderr: 'gh: network down\n', exit: 1}});
  const result = await r.review();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /cannot read the files of pull request #5/);
  assert.deepEqual(r.comments(), []);
  assert.deepEqual(r.execs(), []);
});

test('the review runs the security brief on the configured model in a read-only sandbox over the head, as one run', async t => {
  const r = reviewSetup(t);
  assert.equal((await r.review()).code, 0);
  const {args, revs} = r.codex();
  assert.equal(flag(args, '--sandbox'), 'read-only');
  assert.equal(flag(args, '-m'), model);
  assert.equal(flag(args, '-c'), 'model_reasoning_effort="medium"');
  assert.ok(args.at(-1).startsWith(`${brief.trimEnd()}\n\nThe area, at commit ${r.head}: `), 'the brief comes from next to the script');
  assert.equal(revs[0], r.head, 'the clone is at the pull request head');
  assert.deepEqual(r.runs(), [now]);
});

test('a pull request that touches no trigger path, or is not open, gets no review and no comment', async t => {
  const r = reviewSetup(t);
  for (const pr of [{files: ['src/Domain/Money.cs', 'docs/bin.md', 'scripts/gate.sh']},
    {state: 'CLOSED'}, {state: 'MERGED'}]) {
    r.pr(pr);
    const result = await r.review();
    assert.equal(result.code, 0, JSON.stringify(pr));
    assert.equal(result.stdout + result.stderr, '', JSON.stringify(pr));
  }
  assert.deepEqual(r.comments(), []);
  assert.deepEqual(r.execs(), []);
});

test('a look-alike review comment by the account the script posts as does not stop the review', async t => {
  const r = reviewSetup(t);
  // gh answers who the posting account is, so a script that trusted its own comments would take this one for its own.
  r.gh.respond({'api graphql': {stdout: 'example-agents[bot]\n'}});
  r.pr({comments: [`## ${heading}\n\nHead: ${r.head}\n\nNo findings.`]});
  const result = await r.review({FAKE_CODEX_RESULT: 'Finding: one'});
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(r.execs().length, 1, 'the review ran');
  const [{body}] = r.comments();
  assert.match(body, /Finding: one/);
  assert.deepEqual(r.reviewed(), [`${repo} 5 ${r.head}`]);
  assert.doesNotMatch(flag(r.gh.calls().find(call => call[0] === 'pr' && call[1] === 'view'), '--json'), /comments/);
});

test('a head already reviewed, skipped or failed on is not reviewed again and gets no second comment', async t => {
  for (const env of [{FAKE_CODEX_RESULT: 'No findings.'}, {FAKE_CODEX_MODE: 'usage'}, {FAKE_CODEX_MODE: 'fail'}]) {
    const r = reviewSetup(t);
    assert.equal((await r.review(env)).code, 0, JSON.stringify(env));
    assert.equal(r.comments().length, 1, JSON.stringify(env));
    const execs = r.execs().length;
    const result = await r.review(env);
    assert.equal(result.code, 0, JSON.stringify(env));
    assert.equal(result.stdout + result.stderr, '', JSON.stringify(env));
    assert.equal(r.comments().length, 1, `${JSON.stringify(env)}: no second comment`);
    assert.equal(r.execs().length, execs, `${JSON.stringify(env)}: no second run`);
    assert.deepEqual(r.reviewed(), [`${repo} 5 ${r.head}`]);
  }
});

test('a new head on a pull request whose earlier head was reviewed is reviewed', async t => {
  const r = reviewSetup(t);
  r.pr({headRefOid: 'b'.repeat(40)});
  assert.equal((await r.review()).code, 0);
  r.pr();
  const result = await r.review({FAKE_CODEX_RESULT: 'No findings.'});
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(r.comments().length, 2);
  assert.match(r.comments()[1].body, new RegExp(`Head: ${r.head}\n\nNo findings\.`));
  assert.deepEqual(r.reviewed(), [`${repo} 5 ${'b'.repeat(40)}`, `${repo} 5 ${r.head}`]);
});

test('a comment it cannot record exits 1 saying so after posting', async t => {
  const r = reviewSetup(t);
  mkdirSync(join(r.stateDir, 'security-reviewed'), {recursive: true});
  const result = await r.review();
  assert.equal(result.code, 1);
  assert.equal(r.comments().length, 1);
  assert.match(result.stderr, /commented on #5 at [0-9a-f]{40} but cannot record it in .*security-reviewed/);
});

test('a review skipped for budget posts a skipped note that never reads as a clean review', async t => {
  const r = reviewSetup(t);
  r.config({CODEX_WEEKLY_CAP: '25'});
  r.pastRuns(...Array.from({length: 25}, (_, i) => 6 * hour + i * 6 * hour));
  const result = await r.review();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(r.execs(), []);
  const [{body}] = r.comments();
  assert.match(body, /Skipped: Codex: weekly cap reached \(25 of 25/);
  assert.match(body, /Nothing was reviewed for this head/);
  assert.match(body, new RegExp(`Head: ${r.head}`));
  assert.doesNotMatch(body, cleanWording);
});

test('a failed or unavailable review posts a note saying so that never reads as a clean review', async t => {
  for (const [env, said] of [
    [{FAKE_CODEX_MODE: 'fail'}, /Failed \(exit 1\): the reviewer session failed/],
    [{FAKE_CODEX_MODE: 'sandbox'}, /Skipped: Codex unavailable: sandbox failure/],
    [{FAKE_CODEX_LOGIN_EXIT: '1'}, /Skipped: Codex unavailable: not logged in/],
    [{FAKE_CODEX_MODE: 'usage'}, /Skipped: Codex: usage limit/],
  ]) {
    const r = reviewSetup(t);
    const result = await r.review(env);
    assert.equal(result.code, 0, result.stderr);
    const comments = r.comments();
    assert.equal(comments.length, 1, JSON.stringify(env));
    assert.match(comments[0].body, said);
    assert.match(comments[0].body, /Nothing was reviewed for this head/);
    assert.doesNotMatch(comments[0].body, cleanWording, JSON.stringify(env));
  }
});

test('a head that cannot be fetched posts a failed note and runs nothing', async t => {
  const r = reviewSetup(t);
  r.pr({headRefOid: 'b'.repeat(40)});
  assert.equal((await r.review()).code, 0);
  const [{body}] = r.comments();
  assert.match(body, /Failed \(exit 1\): could not fetch the head/);
  assert.doesNotMatch(body, cleanWording);
  assert.deepEqual(r.execs(), []);
});

test("a review with no findings posts the model's line", async t => {
  const r = reviewSetup(t);
  assert.equal((await r.review({FAKE_CODEX_RESULT: 'No findings.'})).code, 0);
  const [{body}] = r.comments();
  assert.match(body, /\n\nNo findings\.\n\nNothing reads this comment/);
});

test('a review with findings records the head in security-findings as well as security-reviewed', async t => {
  const r = reviewSetup(t);
  const result = await r.review({FAKE_CODEX_RESULT: 'Finding: bin/x:3 lets an issue opener lift a brake.'});
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(r.findings(), [`${repo} 5 ${r.head}`]);
  assert.deepEqual(r.reviewed(), [`${repo} 5 ${r.head}`]);
});

test('a review with no findings, an empty result, or one skipped or failed records no findings', async t => {
  for (const env of [{FAKE_CODEX_RESULT: 'No findings.'}, {FAKE_CODEX_RESULT: '\n  No findings.  \n\n'},
    {FAKE_CODEX_RESULT: ''}, {FAKE_CODEX_RESULT: '  \n'}, {FAKE_CODEX_MODE: 'usage'}, {FAKE_CODEX_MODE: 'sandbox'},
    {FAKE_CODEX_MODE: 'fail'}, {FAKE_CODEX_LOGIN_EXIT: '1'}]) {
    const r = reviewSetup(t);
    const result = await r.review(env);
    assert.equal(result.code, 0, `${JSON.stringify(env)}: ${result.stdout}${result.stderr}`);
    assert.equal(r.comments().length, 1, JSON.stringify(env));
    assert.deepEqual(r.findings(), [], JSON.stringify(env));
    assert.deepEqual(r.reviewed(), [`${repo} 5 ${r.head}`], JSON.stringify(env));
  }
});

test('findings it cannot record exit 1 saying so after posting, and leave the head to be reviewed again', async t => {
  const r = reviewSetup(t);
  mkdirSync(join(r.stateDir, 'security-findings'), {recursive: true});
  const result = await r.review({FAKE_CODEX_RESULT: 'Finding: bin/x:3.'});
  assert.equal(result.code, 1);
  assert.equal(r.comments().length, 1);
  assert.match(result.stderr, /commented on #5 at [0-9a-f]{40} but cannot record its findings in .*security-findings/);
  assert.deepEqual(r.reviewed(), []);
});

test('a pull request gh cannot read, or a comment gh cannot post, exits 1 with the reason', async t => {
  const r = reviewSetup(t);
  r.gh.respond({[`pr view 5 -R ${repo} --json`]: {stderr: 'gh: network down\n', exit: 1}});
  let result = await r.review();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /cannot read pull request #5/);
  r.gh.respond({[`pr view 5 -R ${repo} --json`]: {file: 'pr.json'}, 'pr comment': {exit: 1}});
  result = await r.review();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /cannot comment on pull request #5/);
});

test('--full-area audits the whole area as a run of weight 4, writes the output and posts nothing', async t => {
  const r = reviewSetup(t);
  const output = join(r.root, 'full.txt');
  let result = await r.run(['--full-area', '--commit', r.head, '--output', output, '--repo', r.checkout],
    {FAKE_CODEX_RESULT: 'Finding: one'});
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(r.runs(), [now, now, now, now]);
  assert.match(readFileSync(output, 'utf8'), /model: codex-security-test-latest\n[\s\S]*Finding: one/);
  const {args} = r.codex();
  assert.equal(flag(args, '--sandbox'), 'read-only');
  assert.match(args.at(-1), /bin\/, status\/, the Triphammer plugin's hooks \(plugins\/triphammer\/hooks\/\), the hooks in \.claude\/settings\.json, scripts\/risk-tier\.mjs and scripts\/risk-tier-base\.sh, \.github\/, \.triphammer\/, and the systemd units/);
  assert.deepEqual(r.gh.calls(), []);

  rmSync(output);
  r.config({CODEX_WEEKLY_CAP: '25'});
  r.pastRuns(...Array.from({length: 22}, (_, i) => 6 * hour + i * 6 * hour));
  result = await r.run(['--full-area', '--commit', r.head, '--output', output, '--repo', r.checkout]);
  assert.equal(result.code, 4, 'the exit status passes through');
  assert.match(result.stdout, /weekly cap reached \(22 of 25 runs in the last 7 days; this run counts as 4\)/);
  assert.equal(existsSync(output), false);
  assert.equal(r.execs().length, 1);
});

test('the trigger paths are the project\'s securityReviewPaths, read from the checkout', async t => {
  const r = reviewSetup(t);
  r.project({securityReviewPaths: '^deploy/'});
  r.pr({files: ['bin/ticket-runner']});
  assert.equal((await r.review()).code, 0);
  assert.deepEqual(r.comments(), [], "the example project's trigger paths no longer count");
  r.pr({files: ['deploy/setup.sh']});
  assert.equal((await r.review()).code, 0);
  assert.equal(r.comments().length, 1);
});

test('a project that declares no trigger paths has nothing reviewed and reads nothing from GitHub', async t => {
  const r = reviewSetup(t);
  r.project({});
  assert.equal((await r.review()).code, 0);
  assert.deepEqual(r.gh.calls(), []);
  assert.deepEqual(r.execs(), []);
});

test("--full-area audits the project's securityReviewArea, and refuses a project that declares none", async t => {
  const r = reviewSetup(t);
  const output = join(r.root, 'full.txt');
  r.project({securityReviewArea: 'deploy/ and the widget units'});
  const args = ['--full-area', '--commit', r.head, '--output', output, '--repo', r.checkout];
  assert.equal((await r.run(args)).code, 0);
  assert.match(r.codex().args.at(-1), /The area, at commit [0-9a-f]+: deploy\/ and the widget units/);
  r.project({});
  const result = await r.run(args);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /declares no securityReviewArea/);
});

test("the repository is the Triphammer config's REPO, and a missing or malformed config stops before any gh call", async t => {
  const r = reviewSetup(t);
  r.config({REPO: 'acme/widgets'});
  await r.review();
  assert.deepEqual(r.gh.calls()[0].slice(0, 4), ['pr', 'view', '5', '-R']);
  assert.equal(r.gh.calls()[0][4], 'acme/widgets');
  for (const [settings, message] of [[{CHECKOUT: null}, 'does not set CHECKOUT'], [{REPO: 'acme'}, 'REPO must be owner/name']]) {
    const bad = reviewSetup(t);
    bad.config(settings);
    const result = await bad.review();
    assert.equal(result.code, 2, message);
    assert.ok(result.stderr.includes(`security-review: ${bad.configFile}`) && result.stderr.includes(message), result.stderr);
    assert.deepEqual(bad.gh.calls(), []);
  }
});

test('argument errors exit 2', async t => {
  const r = reviewSetup(t);
  for (const args of [[], ['--pr', 'x'], ['--pr', '5', '--commit', 'HEAD'], ['--full-area', '--commit', 'HEAD'],
    ['--full-area', '--pr', '5', '--commit', 'HEAD', '--output', 'o'], ['--other']]) {
    const result = await r.run(args);
    assert.equal(result.code, 2, args.join(' '));
    if (args.length === 0) assert.match(result.stderr, /^security-review --pr <n> \[--repo <path>\]\nsecurity-review --full-area/);
  }
  assert.deepEqual(r.gh.calls(), []);
});

test('with the codex module off, or without CODEX_SECURITY_MODEL, it exits 2 naming the setting before any gh call', async t => {
  for (const [settings, message] of [
    [{MODULES: null}, file => `security-review: the codex module is off; add it to MODULES in ${file} (bin/README.md)`],
    [{MODULES: 'demo,qwen-audit'}, file => `security-review: the codex module is off; add it to MODULES in ${file} (bin/README.md)`],
    [{CODEX_SECURITY_MODEL: null, CODEX_AUDIT_MODEL: 'codex-audit-test'}, file => `security-review: ${file}: the codex module needs CODEX_SECURITY_MODEL; triphammer update writes its default`],
  ]) {
    const r = reviewSetup(t);
    r.config(settings);
    for (const args of [['--pr', '5', '--repo', r.checkout], ['--full-area', '--commit', r.head, '--output', join(r.root, 'o'), '--repo', r.checkout]]) {
      const result = await r.run(args);
      assert.equal(result.code, 2, `${args[0]}: ${result.stdout}${result.stderr}`);
      assert.equal(result.stderr.trim(), message(r.configFile));
    }
    assert.deepEqual(r.gh.calls(), []);
    assert.deepEqual(r.codexCalls(), []);
  }
});

test('a model name without -latest is the heading as it is', async t => {
  const r = reviewSetup(t);
  r.config({CODEX_SECURITY_MODEL: 'codex-security-pinned'});
  assert.equal((await r.review()).code, 0);
  assert.equal(r.comments()[0].body.split('\n')[0], '## Security review (codex-security-pinned)');
  assert.equal(flag(r.codex().args, '-m'), 'codex-security-pinned');
});
