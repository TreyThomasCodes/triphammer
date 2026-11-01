import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Feeds text-lint.py the hook JSON Claude Code sends and returns its decision: the deny reason, or null when it lets
// the command through.
const hook = join(import.meta.dirname, 'text-lint.py');
const python = spawnSync('python3', ['-I', '-c', 'import sys; print(sys.executable)'], {encoding: 'utf8'})
  .stdout.trim();

// A scratch home for one test: a humanizer state directory that does not exist yet, a Claude config directory with
// the humanizer plugin installed (or not), and a working directory outside any repository.
function scratch(t, {installed = true} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'text-lint-'));
  t.after(() => {
    try { chmodSync(join(root, 'state'), 0o700); } catch {}
    rmSync(root, {recursive: true, force: true});
  });
  const config = join(root, 'claude');
  mkdirSync(join(config, 'plugins'), {recursive: true});
  const plugins = installed ? {'humanizer@humanizer': [{scope: 'user'}]} : {'csharp-lsp@claude-plugins-official': []};
  writeFileSync(join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({version: 2, plugins}));
  const cwd = join(root, 'work');
  mkdirSync(cwd);
  const state = join(root, 'state');
  const env = {...process.env, TRIPHAMMER_HUMANIZER_STATE: state, CLAUDE_CONFIG_DIR: config};
  return {root, cwd, state, env};
}

function run(input, env) {
  const result = spawnSync(python, ['-I', hook], {input, encoding: 'utf8', env});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  if (result.stdout === '') return null;
  const output = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(output.hookEventName, 'PreToolUse');
  assert.equal(output.permissionDecision, 'deny');
  return output.permissionDecisionReason;
}

const bash = (s, command, {session = 's1', cwd = s.cwd} = {}) =>
  run(JSON.stringify({session_id: session, hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: {command, description: 'test'}, cwd}), s.env);

const skill = (s, name, {session = 's1', event = 'PostToolUse'} = {}) =>
  run(JSON.stringify({session_id: session, hook_event_name: event, tool_name: 'Skill',
    tool_input: {skill: name, args: 'embedded'}, tool_response: {success: true}, cwd: s.cwd}), s.env);

// A scratch home where this session already ran the humanizer skill, so only the writing rules decide.
function humanized(t, options) {
  const s = scratch(t, options);
  assert.equal(skill(s, 'humanizer:humanizer'), null);
  return s;
}

const TITLE = 'Agent hook for pull request text';
const GOOD = 'Adds a hook that checks pull request text before it is posted.\n\n' +
  'It reads the title and body from the command and lists every rule the text breaks.\n\nCloses #547';
const prCreate = (body, title = TITLE) => `gh pr create --title "${title}" --body-file - <<'EOF'\n${body}\nEOF`;
const issueCreate = (body, title = 'Hook for issue text') =>
  `gh issue create --title "${title}" --body "$(cat <<'EOF'\n${body}\nEOF\n)"`;
const commit = message => `git commit -F - <<'EOF'\n${message}\nEOF`;

function assertRefused(reason, rule) {
  assert.ok(reason, `expected a deny for ${rule}`);
  assert.match(reason, /^text-lint refused this/);
  assert.ok(reason.includes(rule), reason);
  assert.match(reason, /# text-lint-override: <reason>/);
}

// The repository's rules.

test('a description in the repository form is allowed', t => {
  assert.equal(bash(humanized(t), prCreate(GOOD)), null);
});

test('a body with the Claude Code footer is refused', t => {
  const footer = '🤖 Generated with [Claude Code](https://claude.com/claude-code)';
  const body = GOOD.replace('\n\nCloses', `\n\n${footer}\n\nCloses`);
  assertRefused(bash(humanized(t), prCreate(body)), "FOOTER: remove the 'Generated with Claude Code' line.");
});

test('a body with a Co-Authored-By line is refused', t => {
  const body = `${GOOD}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;
  assertRefused(bash(humanized(t), prCreate(body)), 'CO-AUTHORED-BY: remove the Co-Authored-By line from the description.');
});

test('Checks, Decisions for the owner, Reviewer notes and Evidence sections, as headings or bold labels, are refused', t => {
  const s = humanized(t);
  for (const [section, rule] of [['## Checks', 'SECTIONS (checks)'], ['## Decisions for the owner', 'SECTIONS (decisions)'],
    ['## Reviewer notes', 'SECTIONS'], ['**Evidence**', 'SECTIONS'], ['### Evidence', 'SECTIONS'], ['**Decisions for the owner**', 'SECTIONS']]) {
    const body = GOOD.replace('\n\nCloses', `\n\n${section}\n\nSomething.\n\nCloses`);
    assertRefused(bash(s, prCreate(body)), rule);
  }
});

test('a gh pr create body that does not end in Closes #N is refused', t => {
  const s = humanized(t);
  for (const body of [GOOD.replace('\n\nCloses #547', ''), `${GOOD}\n\nThanks.`, 'Closes #547\n\nAdds a hook.']) {
    assertRefused(bash(s, prCreate(body)), 'CLOSES');
  }
});

test('a gh pr edit that changes only the title is not checked for Closes #N', t => {
  assert.equal(bash(humanized(t), `gh pr edit 12 --title "${TITLE}"`), null);
});

// The upstream rules, each with the exemption it carries.

test('DASH: an em-dash, an en-dash or a spaced double hyphen is refused', t => {
  const s = humanized(t);
  for (const dash of ['—', '–', ' -- ']) {
    assertRefused(bash(s, prCreate(GOOD.replace('hook that', `hook${dash}it`))), 'DASH');
  }
  assertRefused(bash(s, `git commit -m "Add a hook — for text"`), 'DASH');
});

test('TEST_PLAN: a Test plan section is refused', t => {
  const reason = bash(humanized(t), prCreate(GOOD.replace('\n\nCloses', '\n\n## Test plan\n\n- run it\n\nCloses')));
  assertRefused(reason, 'TEST PLAN');
  assert.ok(!reason.includes('SECTIONS'), 'a Test plan heading is reported once');
});

test('WORTH_KNOWING: a Worth knowing section is refused', t => {
  const body = GOOD.replace('\n\nCloses', '\n\n## Worth knowing\n\nIt is fast.\n\nCloses');
  assertRefused(bash(humanized(t), prCreate(body)), 'WORTH KNOWING');
});

test('CONTEXT_SOLUTION: a Context or Solution section is refused on a non-fix pull request only', t => {
  const s = humanized(t);
  const body = `## Context\n\nAgents post text.\n\n## Solution\n\nA hook checks it.\n\nCloses #547`;
  assertRefused(bash(s, prCreate(body)), 'CONTEXT/SOLUTION');
  assert.equal(bash(s, prCreate(body, 'Fix the hook for text')), null);
  assert.equal(bash(s, issueCreate('## Problem\n\nAgents post text that breaks the rules.')), null);
});

test('FIX_FRAMING: a feature framed as a fix is refused, but not on issues or a fix title or branch', t => {
  const s = humanized(t);
  const body = GOOD.replace('Adds a hook', 'Until now nothing checked text; adds a hook');
  assertRefused(bash(s, prCreate(body)), "FEATURE FRAMED AS A FIX ('Until now')");
  assertRefused(bash(s, `git commit -m "Add the hook" -m "Previously the rules lived in skills."`), 'FEATURE FRAMED');
  assert.equal(bash(s, prCreate(body, 'Fix unchecked text')), null);
  assert.equal(bash(s, issueCreate('Until now nothing checked pull request text.')), null);
  const repo = join(s.root, 'repo');
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'hotfix/text', repo]).status, 0);
  assert.equal(bash(s, prCreate(body), {cwd: repo}), null);
});

test('TABLE: a markdown table is refused in pull requests and issues, not in commits', t => {
  const s = humanized(t);
  const table = '| Rule | Kind |\n|------|------|\n| DASH | upstream |';
  assertRefused(bash(s, prCreate(GOOD.replace('\n\nCloses', `\n\n${table}\n\nCloses`))), 'TABLE');
  assertRefused(bash(s, issueCreate(table)), 'TABLE');
  assert.equal(bash(s, commit(`Add the hook\n\n${table}`)), null);
});

test('HARD_WRAP: a paragraph broken over lines is refused in pull requests and issues, not in commits', t => {
  const s = humanized(t);
  const wrapped = 'Adds a hook that checks pull request text before it is\nposted, and lists every rule broken.';
  assertRefused(bash(s, prCreate(`${wrapped}\n\nCloses #547`)), 'HARD WRAP');
  assertRefused(bash(s, issueCreate(wrapped)), 'HARD WRAP');
  assert.equal(bash(s, commit(`Add the hook\n\n${wrapped}`)), null);
  assert.equal(bash(s, prCreate('- a bullet that is long enough to count as a line of prose\n- another\n\nCloses #1')),
    null);
});

test('REVIEW_TITLE: a title that only answers a review is refused', t => {
  const s = humanized(t);
  assertRefused(bash(s, prCreate(GOOD, 'Address review comments')), 'TITLE');
  assertRefused(bash(s, 'git commit -m "Apply suggestions from code review"'), 'TITLE');
});

test('every broken rule is listed, numbered', t => {
  const body = 'Previously — nothing.\n\n## Checks\n\nok\n\nCo-Authored-By: Claude <noreply@anthropic.com>';
  const reason = bash(scratch(t), prCreate(body));
  for (const rule of ['DASH', 'FEATURE FRAMED', 'CO-AUTHORED-BY', 'SECTIONS', 'CLOSES', 'HUMANIZER']) {
    assert.ok(reason.includes(rule), `${rule} missing from: ${reason}`);
  }
  assert.match(reason, /\n6\. /);
});

// What is prose and what is not.

test('rule-breaking text inside a fenced block or a code span is allowed', t => {
  const s = humanized(t);
  const fenced = '```\n## Checks\n## Decisions for the owner\nCo-Authored-By: x <noreply@anthropic.com>\n' +
    '🤖 Generated with Claude Code\nA — B, until now\n| a | b |\n|---|---|\n```';
  assert.equal(bash(s, prCreate(GOOD.replace('\n\nCloses', `\n\n${fenced}\n\nCloses`))), null);
  const spans = 'Refuses `## Checks`, `Co-Authored-By:`, `🤖 Generated with Claude Code` and `—` in prose.';
  assert.equal(bash(s, prCreate(`${spans}\n\nCloses #547`)), null);
});

test('comments are not checked', t => {
  const s = scratch(t);
  const body = '## Checks\n\n- dotnet test: 10 passed\n\n## Decisions for the owner\n\nKept it — for now.';
  assert.equal(bash(s, `gh pr comment 12 --body-file - <<'EOF'\n${body}\nEOF`), null);
  assert.equal(bash(s, `gh pr comment 12 --body "${body}"`), null);
  assert.equal(bash(s, `gh issue comment 547 --body "${body}"`), null);
});

test('a command that only mentions gh pr create in its text is not checked', t => {
  const s = scratch(t);
  assert.equal(bash(s, `echo "run gh pr create --body 'Previously — x'"`), null);
  assert.equal(bash(s, `grep -n "gh pr create" plugins/triphammer/skills/review-loop/SKILL.md`), null);
});

// How the command is spelled.

const B = `--title "Adds x" --body "Previously — broken"`;

test('gh pr and issue create are checked however the command is spelled', t => {
  const s = humanized(t);
  for (const command of [`gh pr new ${B}`, `gh issue new ${B}`, `gh  pr create ${B}`, `gh\tpr\tcreate ${B}`,
    `env gh pr create ${B}`, `env -u X FOO=1 gh pr create ${B}`, `command gh pr create ${B}`, `\\gh pr create ${B}`,
    `/usr/bin/gh pr create ${B}`, `time gh pr create ${B}`, `nohup gh pr create ${B}`, `sudo -u x gh pr create ${B}`,
    `gh -R a/b pr create ${B}`, `gh --repo a/b pr create ${B}`, `gh --repo=a/b pr create ${B}`,
    `gh pr -R a/b create ${B}`, `true && gh pr create ${B}`, `(gh pr create ${B})`, `gh pr create ${B} | cat`]) {
    assertRefused(bash(s, command), 'DASH');
  }
  assertRefused(bash(s, `gh  pr create ${B}`), 'CLOSES');
  assertRefused(bash(s, `glab mr new --title "Adds x" --description "Previously — broken"`), 'DASH');
});

test('git commit is checked however git is spelled', t => {
  const s = humanized(t);
  for (const command of [`git -c user.name=x commit -m 'x — y'`, `git --no-pager commit -m 'x — y'`,
    `git commit -m"x — y"`, `git commit -am'x — y'`, `git commit --message='x — y'`, `env git commit -m 'x — y'`,
    `git  commit -m 'x — y'`, `/usr/bin/git commit -m 'x — y'`, `git commit -s -m 'x — y'`]) {
    assertRefused(bash(s, command), 'DASH');
  }
});

test('attached option values are read', t => {
  const s = humanized(t);
  const reason = bash(s, `gh pr create -t 'Adds x' -b'a — b'`);
  assertRefused(reason, 'DASH');
  assertRefused(bash(s, `gh pr create --title='Adds x' --body='a — b\n\nCloses #1'`), 'DASH');
  assertRefused(bash(s, `gh pr create -t'Previously x' -b 'Adds it.\n\nCloses #1'`), 'FEATURE FRAMED');
  assertRefused(bash(scratch(t), `gh pr create -t 'Adds x' -b'a — b'`), 'HUMANIZER');
  writeFileSync(join(s.cwd, 'body.md'), 'Previously — x\n\nCloses #1\n');
  assertRefused(bash(s, `gh pr create -t 'Adds x' -Fbody.md`), 'DASH');
  assertRefused(bash(s, `gh pr create -t 'Adds x' --body-file=body.md`), 'DASH');
});

test('a commit -F file is read from the directory git -C names', t => {
  const s = humanized(t);
  mkdirSync(join(s.cwd, 'sub'));
  writeFileSync(join(s.cwd, 'sub', 'message.txt'), 'Add x\n\nPreviously — broken\n');
  assertRefused(bash(s, 'git -C sub commit -F message.txt'), 'DASH');
});

// A clean body in sub/ and, in the hook's cwd, one that breaks DASH, FOOTER and CLOSES.
function twoBodies(t) {
  const s = humanized(t);
  mkdirSync(join(s.cwd, 'sub'));
  writeFileSync(join(s.cwd, 'sub', 'body.md'), `${GOOD.replace('#547', '#5')}\n`);
  writeFileSync(join(s.cwd, 'body.md'), 'Adds x — y.\n\n🤖 Generated with Claude Code\n');
  return s;
}

test('a relative --body-file is read from the directory a cd in the same command moved to', t => {
  const s = twoBodies(t);
  const create = 'gh pr create -t "Add a thing" --body-file body.md';
  for (const command of [`cd sub && ${create}`, `cd sub; ${create}`, `cd ${join(s.cwd, 'sub')} && ${create}`,
    `cd -- sub && ${create}`, `(cd sub && ${create})`, `cd sub && ${create} | cat`]) {
    assert.equal(bash(s, command), null, command);
  }
  for (const command of [`(cd sub) && ${create}`, `(cd sub; true); ${create}`, `cd sub | cat; ${create}`,
    `cd sub & ${create}`, `echo $(cd sub) && ${create}`, `cd sub && cd .. && ${create}`]) {
    const reason = bash(s, command);
    for (const rule of ['DASH', 'FOOTER', 'CLOSES']) assertRefused(reason, rule);
  }
  writeFileSync(join(s.cwd, 'sub', 'message.txt'), 'Add x\n\nPreviously — broken\n');
  assertRefused(bash(s, 'cd sub && git commit -F message.txt'), 'DASH');
  rmSync(join(s.cwd, 'body.md'));
  assert.equal(bash(s, `cd sub && ${create}`), null);
});

test('a cd that may not run, or to a missing directory, leaves the file judged where bash may read it', t => {
  const s = twoBodies(t);
  const create = 'gh pr create -t "Add a thing" --body-file body.md';
  for (const command of [`[ -d nope ] && cd sub; ${create}`, `false && cd sub; ${create}`,
    `if false; then cd sub; fi; ${create}`, `f() { cd sub; }; ${create}`, `while false; do cd sub; done; ${create}`,
    `cd nope; ${create}`, `false && cd sub && cd .; ${create}`, `{ cd sub; } & ${create}`,
    `{ cd sub; } | cat; ${create}`]) {
    const reason = bash(s, command);
    for (const rule of ['DASH', 'FOOTER', 'CLOSES']) assertRefused(reason, rule);
  }
  assert.equal(bash(s, `{ cd sub; ${create}; }`), null);
  rmSync(join(s.cwd, 'body.md'));
  assert.equal(bash(s, `[ -d sub ] && cd sub; ${create}`), null);
  assert.match(bash(s, `cd nope; ${create}`) ?? '', /BODY FILE body.md does not exist/);
});

test('after a cd it cannot follow, a relative --body-file is not judged, as agent-guard does', t => {
  const s = twoBodies(t);
  const create = 'gh pr create -t "Add a thing" --body-file body.md';
  for (const command of [`cd "$X" && ${create}`, `cd && ${create}`, `cd - && ${create}`, `cd -P sub && ${create}`,
    `pushd sub && ${create}`, `popd && ${create}`, `cd sub || exit 1; ${create}`, `cd "$X" && git commit -F message.txt`,
    `cd "$X" && gh pr create -t "Add a thing" --body-file missing.md`]) {
    assert.equal(bash(s, command), null, command);
  }
  assertRefused(bash(s, `cd "$X" && gh pr create -t "Previously x" --body-file body.md`), 'FEATURE FRAMED');
  const reason = bash(s, `cd "$X" && gh pr create -t "Add a thing" --body-file ${join(s.cwd, 'body.md')}`);
  for (const rule of ['DASH', 'FOOTER', 'CLOSES']) assertRefused(reason, rule);
  const unhumanized = scratch(t);
  assert.match(bash(unhumanized, `cd "$X" && ${create}`), /HUMANIZER/);
});

test('commands that post no text are allowed', t => {
  const s = scratch(t);
  for (const command of ['gh pr create --help', 'gh pr create -h', 'gh --help pr create', 'gh pr new --help',
    'gh issue create --help', 'gh pr view 12', 'gh pr list -R a/b', 'git commit --help', 'git log -m',
    'git commit --amend --no-edit', 'command -v gh', 'gh pr checkout 12', 'gh repo create x']) {
    assert.equal(bash(s, command), null, command);
  }
});

test('git commit --amend --no-edit is checked when it is given a message', t => {
  const s = humanized(t);
  for (const command of [`git commit --amend -m 'x — y' --no-edit`, `git commit --amend --no-edit --message='x — y'`,
    `git commit --no-edit --amend -m'Add x' -m 'x — y'`]) {
    assertRefused(bash(s, command), 'DASH');
  }
  writeFileSync(join(s.cwd, 'message.txt'), 'Add x\n\nx — y\n');
  assertRefused(bash(s, 'git commit --amend --no-edit -F message.txt'), 'DASH');
  assert.equal(bash(s, 'git commit --amend --no-edit -C HEAD'), null);
});

test('a quoted <<WORD is text, not a heredoc', t => {
  const s = humanized(t);
  assertRefused(bash(s, "gh pr create -t 'Adds x' -b 'Reads `<<EOF` heredocs. x — y\n\nCloses #1'"), 'DASH');
  assertRefused(bash(s, "git commit -m 'Read cat <<EOF bodies\n\nx — y'"), 'DASH');
  assertRefused(bash(s, "git commit -m \"Read <<EOF\nx — y\nEOF\nmore\""), 'DASH');
  assertRefused(bash(s, "gh pr create -t 'Adds x' -b \"$(echo '<<EOF')\nx — y\nEOF\n\nCloses #1\""), 'DASH');
  assertRefused(bash(scratch(t), "gh pr create -t 'Adds x' -b 'Reads `<<EOF` heredocs.\n\nCloses #1'"), 'HUMANIZER');
  // A real heredoc after a quoted mention, and one in arithmetic or a comment before it, are still read.
  assertRefused(bash(s, "echo '<<X' && git commit -F - <<'X'\nAdd x\n\nx — y\nX"), 'DASH');
  assertRefused(bash(s, "echo $((1<<2)) # it's <<X\ngit commit -F - <<X\nAdd x\n\nx — y\nX"), 'DASH');
  assert.equal(bash(s, "git commit -m 'Read <<EOF bodies' -m 'Adds it.'"), null);
});

test('a quote that never closes does not hide the command from the check', t => {
  const s = humanized(t);
  assertRefused(bash(s, "gh pr create -t 'Adds x' -b 'x — y\n\nCloses #1"), 'DASH');
  assertRefused(bash(s, "git commit -m \"x — y"), 'DASH');
  assertRefused(bash(scratch(t), "gh pr create -t 'Adds x' -b 'Adds it.\n\nCloses #1"), 'HUMANIZER');
});

test('glab reads -d as the description, and -b as its target branch', t => {
  const s = humanized(t);
  assertRefused(bash(s, `glab mr create -t 'Adds x' -d 'a — b\n\nCloses #1'`), 'DASH');
  assert.equal(bash(s, `glab mr create -t 'Adds x' -b main -d 'Adds it.\n\nCloses #1'`), null);
});

// Where the text comes from.

test('text is read from --title and --body, -m, a heredoc and a --body-file', t => {
  const s = humanized(t);
  const bad = 'Previously nothing checked it.';
  assertRefused(bash(s, `gh pr create --title "${TITLE}" --body "${bad}\n\nCloses #1"`), 'FEATURE FRAMED');
  assertRefused(bash(s, `gh pr create --title="${bad}" --body='Adds it.\n\nCloses #1'`), 'FEATURE FRAMED');
  assertRefused(bash(s, `git -C ${s.cwd} commit -m "Add the hook" -m "${bad}"`), 'FEATURE FRAMED');
  assertRefused(bash(s, `GIT_EDITOR=true git commit -m "${bad}"`), 'FEATURE FRAMED');
  assertRefused(bash(s, `git commit -am "${bad}"`), 'FEATURE FRAMED');
  assertRefused(bash(s, `cd ${s.cwd} && git commit -F - <<'EOF'\nAdd the hook\n\n${bad}\nEOF`), 'FEATURE FRAMED');
  writeFileSync(join(s.cwd, 'body.md'), `${bad}\n\nCloses #1\n`);
  writeFileSync(join(s.cwd, 'message.txt'), `Add the hook\n\n${bad}\n`);
  assertRefused(bash(s, `gh pr create --title "${TITLE}" --body-file body.md`), 'FEATURE FRAMED');
  assertRefused(bash(s, `gh pr edit 12 -F ${join(s.cwd, 'body.md')}`), 'FEATURE FRAMED');
  assertRefused(bash(s, 'git commit -F message.txt'), 'FEATURE FRAMED');
});

test('a --body-file that exists and passes is allowed', t => {
  const s = humanized(t);
  writeFileSync(join(s.cwd, 'body.md'), `${GOOD}\n`);
  assert.equal(bash(s, `gh pr create --title "${TITLE}" --body-file body.md`), null);
  assert.equal(bash(s, `gh pr create --title "${TITLE}" --body-file "${join(s.cwd, 'body.md')}"`), null);
});

test('a --body-file that does not exist is refused, telling the agent to write it first', t => {
  const s = humanized(t);
  for (const command of [`gh pr create --title "${TITLE}" --body-file /tmp/text-lint-missing/body.md`,
    `gh issue create --title "Hook" -F missing.md`, 'git commit -F missing.txt']) {
    const reason = bash(s, command);
    assert.ok(reason, command);
    assert.match(reason, /BODY FILE .*missing.* does not exist yet/);
    assert.match(reason, /Write it with the Write tool first/);
  }
});

test('a flag inside a quoted body does not count as one', t => {
  const s = humanized(t);
  assert.equal(bash(s, `gh pr create --title "${TITLE}" --body "Reads -F missing.md text.\n\nCloses #1"`), null);
});

// The override.

test('every refused command is allowed with the override token', t => {
  const s = scratch(t);
  const refused = [
    prCreate('🤖 Generated with Claude Code'),
    prCreate(`${GOOD}\n\nCo-Authored-By: x <noreply@anthropic.com>`),
    prCreate('## Checks\n\nok\n\nCloses #1'),
    prCreate('## Decisions for the owner\n\nok\n\nCloses #1'),
    prCreate('Adds it.'),
    prCreate(GOOD),
    `gh pr create --title "${TITLE}" --body-file missing.md`,
    'git commit -m "Previously — nothing"',
    issueCreate('| a | b |\n|---|---|'),
  ];
  for (const command of refused) {
    assert.ok(bash(s, command), `expected a deny without the override: ${command}`);
    const [first, ...rest] = command.split('\n');
    assert.equal(bash(s, [`${first}  # text-lint-override: owner asked for it`, ...rest].join('\n')), null, command);
  }
});

// The humanizer gate.

test('gh pr create with no humanizer run in the session is refused, saying to run the skill and retry', t => {
  const s = scratch(t);
  assert.equal(skill(s, 'review-loop'), null);
  const reason = bash(s, prCreate(GOOD));
  assertRefused(reason, 'HUMANIZER');
  assert.match(reason, /humanizer:humanizer/);
  assert.match(reason, /retry/);
  assert.ok(!reason.includes('/plugin install'), 'no install hint when the plugin is installed');
});

test('gh pr create after a recorded humanizer run in the same session is allowed', t => {
  const s = scratch(t);
  assert.equal(skill(s, 'humanizer:humanizer', {session: 'session-a'}), null);
  assert.equal(bash(s, prCreate(GOOD), {session: 'session-a'}), null);
  assert.equal(bash(s, `gh pr edit 12 --title "${TITLE}" --body-file - <<'EOF'\n${GOOD}\nEOF`, {session: 'session-a'}),
    null);
});

test('without TRIPHAMMER_HUMANIZER_STATE the runs are kept under triphammer/humanizer in XDG_STATE_HOME', t => {
  const s = scratch(t);
  const {TRIPHAMMER_HUMANIZER_STATE: _, ...rest} = s.env;
  const xdg = join(s.root, 'xdg');
  const d = {...s, env: {...rest, XDG_STATE_HOME: xdg}};
  assert.equal(skill(d, 'humanizer:humanizer', {session: 'session-a'}), null);
  assert.equal(readdirSync(join(xdg, 'triphammer', 'humanizer')).length, 1);
  assert.equal(bash(d, prCreate(GOOD), {session: 'session-a'}), null);
});

test('a humanizer run recorded for a different session_id does not count', t => {
  const s = scratch(t);
  assert.equal(skill(s, 'humanizer:humanizer', {session: 'session-a'}), null);
  assertRefused(bash(s, prCreate(GOOD), {session: 'session-b'}), 'HUMANIZER: the humanizer skill has not run');
});

test('gh pr edit with --title, --body or --body-file is gated; other edits are not', t => {
  const s = scratch(t);
  writeFileSync(join(s.cwd, 'body.md'), `${GOOD}\n`);
  for (const command of [`gh pr edit 12 --title "${TITLE}"`, `gh pr edit 12 --body "Adds it."`,
    'gh pr edit 12 --body-file body.md', `gh pr edit 12 -t "${TITLE}"`]) {
    assertRefused(bash(s, command), 'HUMANIZER');
  }
  assert.equal(bash(s, 'gh pr edit 12 --add-label needs-owner'), null);
  assert.equal(bash(s, 'gh pr edit 12 --base main'), null);
});

test('issues, comments and commits are not gated', t => {
  const s = scratch(t);
  assert.equal(bash(s, issueCreate('Agents post text that breaks the rules.')), null);
  assert.equal(bash(s, 'gh issue edit 547 --title "Hook for issue text" --body "Checks the text."'), null);
  assert.equal(bash(s, 'gh pr comment 12 --body "Checks ran."'), null);
  assert.equal(bash(s, 'git commit -m "Add the text hook"'), null);
});

test('a missing state directory refuses with the reason', t => {
  const s = scratch(t);
  const reason = bash(s, prCreate(GOOD));
  assertRefused(reason, 'HUMANIZER');
  assert.ok(reason.includes(`state directory ${s.state} does not exist`), reason);
});

test('a state directory that is a file refuses with the reason', t => {
  const s = scratch(t);
  writeFileSync(s.state, 'not a directory');
  assert.match(bash(s, prCreate(GOOD)) ?? '', /HUMANIZER: .*is not a directory/);
});

test('an unreadable state directory refuses with the reason', {skip: process.getuid?.() === 0 && 'root reads anything'},
  t => {
    const s = scratch(t);
    assert.equal(skill(s, 'humanizer:humanizer'), null);
    chmodSync(s.state, 0o300);
    const reason = bash(s, prCreate(GOOD));
    assertRefused(reason, 'HUMANIZER');
    assert.ok(reason.includes(`state directory ${s.state} cannot be read`), reason);
  });

test('the refusal says how to install the humanizer plugin when it is not installed', t => {
  const reason = bash(scratch(t, {installed: false}), prCreate(GOOD));
  assertRefused(reason, 'HUMANIZER');
  assert.ok(reason.includes('`/plugin marketplace add blader/humanizer`, then `/plugin install humanizer@humanizer`'),
    reason);
});

test('only a PostToolUse run of the humanizer skill is recorded', t => {
  const s = scratch(t);
  assert.equal(skill(s, 'humanizer:humanizer', {event: 'PreToolUse'}), null);
  assert.equal(skill(s, 'review-loop'), null);
  assert.equal(skill(s, 'other:humanizer-ish'), null);
  assertRefused(bash(s, prCreate(GOOD)), 'HUMANIZER');
  assert.equal(skill(s, 'humanizer'), null);
  assert.equal(bash(s, prCreate(GOOD)), null);
  assert.equal(readdirSync(s.state).length, 1, 'one record for the session');
});

// The hook never blocks on its own failure.

test('malformed hook input allows the command', t => {
  const s = scratch(t);
  for (const input of ['', 'not json', '[]', '{"tool_name": "Bash"}', '{"tool_name": "Bash", "tool_input": 3}',
    JSON.stringify({tool_name: 'Bash', tool_input: {command: 7}, cwd: '/'}),
    JSON.stringify({tool_name: 'Skill', hook_event_name: 'PostToolUse', tool_input: 'humanizer'}),
    JSON.stringify({tool_name: 'Bash', tool_input: {command: 'gh issue create --title "Hook" --body "unbalanced'}})]) {
    assert.equal(run(input, s.env), null, input);
  }
});

test('gh pr create without a session_id refuses with the reason rather than allowing silently', t => {
  const s = humanized(t);
  const reason = run(JSON.stringify({tool_name: 'Bash', tool_input: {command: prCreate(GOOD)}, cwd: s.cwd}), s.env);
  assertRefused(reason, 'HUMANIZER: the hook input has no session_id');
});

test('other tools are not judged', t => {
  const s = scratch(t);
  assert.equal(run(JSON.stringify({tool_name: 'Write', tool_input: {command: prCreate('Previously — x')}}), s.env),
    null);
});
