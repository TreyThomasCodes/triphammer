import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {here} from './fixture.mjs';

// GitHub compares logins, owners and repository names in any case, and so does the rest of Triphammer. A comparison
// of one with ==, !=, `[ $a = $b ]`, grep -Fx or a jq `== $owner` must lowercase both sides (ascii_downcase, .lower(),
// ${x,,}), or carry a `# case-sensitive: <reason>` comment saying why that identity is compared as written
// (review-checklist class 10). This is a line-based heuristic: it does not see a comparison whose operands span lines,
// a lone = after && or -a inside one test bracket, `[ $a = $b ]` when only one side names an identity, a value copied
// into a variable without such a name, or a case statement.
const repository = join(here, '..');

// Lower-case names count anywhere, alone or as part of a snake_case name (tri_repo, app_login), but not inside a
// hyphenated word (needs-owner, owner-approval: label and check names) or a longer word (loginctl, repositories).
// `app`, the App's login (APP_AUTHOR), counts only alone: app_dir and app_id are no logins. Upper-case names count
// only as expansions ($REPO, ${OWNER}, $HEAD_REPOSITORY): bare, they are setting names (" REPO CHECKOUT ").
const identity = /(?<![\w-])(?:(?:\w*_)?(?:owner|login|repo|repository|author)(?:_\w*)?|app)(?![\w-])|\$\{?(?:\w*_)?(?:OWNER|REPO|REPOSITORY|AUTHOR)(?:_\w*)?\b/;
const lowered = /ascii_downcase|\.lower\(\)|\.casefold\(\)|\.toLowerCase\(\)|,,\}|\btr\s+(?:'\[:upper:\]'\s+'\[:lower:\]'|A-Z\s+a-z|'A-Z'\s+'a-z')/;
const annotated = /#\s*case-sensitive:\s*\S/;
const openers = '([{', closers = ')]}';
const keyword = /(?:^|[^\w$.-])(?:and|or|not|if|elif|while|return|then|in)$/;

// The text of one operand of the operator at [start, end): walks out from it at bracket depth 0 until an unmatched
// bracket, a pipe, &&, ||, ;, a comma or a keyword such as `and` or `if`.
function operand(line, from, step) {
  let depth = 0, i = from;
  for (; i >= 0 && i < line.length; i += step) {
    const c = line[i];
    if ((step < 0 ? closers : openers).includes(c)) depth++;
    else if ((step < 0 ? openers : closers).includes(c)) { if (depth-- === 0) break; }
    else if (depth === 0 && (c === '|' || c === '&' || c === ';' || c === ',')) break;
    else if (depth === 0 && /\s/.test(c)) {
      if (step < 0 && keyword.test(line.slice(0, i))) break;
      if (step > 0 && /^\s(?:and|or|then|for|if|else)(?![\w$.-])/.test(line.slice(i))) break;
    }
  }
  return step < 0 ? line.slice(i + 1, from + 1) : line.slice(from, i);
}

// Why a line compares an identity case-sensitively, or null when it does not.
function caseSensitiveComparison(line) {
  const trimmed = line.trim();
  if (trimmed.startsWith('#') || trimmed.startsWith('//') || annotated.test(line)) return null;
  for (const m of line.matchAll(/(?<![<>=!])(?:==|!=)=?|(?<=\s)=(?=\s)/g)) {
    const left = operand(line, m.index - 1, -1), right = operand(line, m.index + m[0].length, 1);
    // A lone ` = ` counts only as the first operator of a test bracket, `[ a = b ]` or `[[ a = b ]]`, not as an
    // assignment, and only when both operands name an identity: shell compares a value with a literal this way.
    const bracket = m[0] === '=';
    if (bracket && line[m.index - 1 - left.length] !== '[') continue;
    if ((bracket ? identity.test(left) && identity.test(right) : identity.test(left) || identity.test(right)) &&
        !(lowered.test(left) && lowered.test(right)))
      return `${left.trim()} ${m[0]} ${right.trim()}`;
  }
  for (const m of line.matchAll(/\bgrep((?:\s+--?[\w-]+)+)([^|;&)]*)/g)) {
    const flags = m[1], short = flags.match(/(?<![\w-])-[A-Za-z]+/g)?.join('') ?? '';
    const fixed = short.includes('F') || flags.includes('--fixed-strings');
    const whole = short.includes('x') || flags.includes('--line-regexp');
    const anyCase = short.includes('i') || flags.includes('--ignore-case');
    if (fixed && whole && !anyCase && identity.test(m[2])) return m[0].trim();
  }
  return null;
}

// The scripts and workflows that compare identities. Skipped: the tests (*.test.mjs), and the fakes and rigs
// (fake-*.mjs, *fixture.mjs), whose comparisons are of a command's arguments (`args[0] === 'login'`), not of identities.
function scanned() {
  const list = dir => readdirSync(join(repository, dir)).sort().map(name => join(dir, name));
  return [
    ...list('bin').filter(f => !/(?:\.test\.mjs|\/fake-[^/]*\.mjs|fixture\.mjs)$/.test(f)),
    ...list('scripts').filter(f => f.endsWith('.sh')),
    ...list('.github/workflows').filter(f => f.endsWith('.yml')),
  ].filter(f => statSync(join(repository, f)).isFile());
}

test('the matcher flags a case-sensitive identity comparison and passes a lowercased or annotated one', () => {
  const flagged = [
    'elif [ "$by" != "$app_login" ]; then',
    'if [[ "$owner" == "$1" ]]; then',
    `jq -r --arg owner "$o" '.[] | select(.account.login == $owner) | .id'`,
    `jq '.[] | select((.user.login | ascii_downcase) == $owner)'`,
    'if pr["author"]["login"] != owner:',
    'if author(pr) != app or pr["isDraft"] or "hold" in labels(pr):',
    'if [ "$by" == "$APP_AUTHOR" ]; then',
    'grep -qxF "REPO=$repo" "$config"',
    'grep -Fx -- "$REPO" <<< "$installed"',
    'if [ "$WORKFLOW_REPOSITORY" = "$REPOSITORY" ]; then',
    '[ -n "$a" ] && [[ "$head_repository" = "${repository}" ]] && echo same',
    'if [ "$HEAD_REPOSITORY" != "$REPOSITORY" ]; then',
    `jq '.[] | select(.repository.full_name == $repository)'`,
  ];
  for (const line of flagged) assert.ok(caseSensitiveComparison(line), `flagged: ${line}`);
  const passed = [
    'elif [ "${by,,}" != "${app_login,,}" ]; then',
    `jq '.[] | select((.user.login | ascii_downcase) == ($owner | ascii_downcase))'`,
    'if pr["author"]["login"].lower() != owner.lower():',
    'if (author(pr) or "").lower() != app.lower() or pr["isDraft"] or "hold" in labels(pr):',
    'grep -qixF "REPO=$repo" "$config"',
    'elif [ "$by" != "$app_login" ]; then  # case-sensitive: the sample says why',
    // Not identities: label and check names, setting names, other words, and operands that hold none.
    'if [[ "$facts" == *" needs-owner "* ]]; then',
    `'.[] | select(.name != "owner-approval")'`,
    'if [[ " REPO CHECKOUT APP_AUTHOR " != *" $key "* ]]; then',
    'if [ "$(loginctl show-user "$user" --property=Linger --value)" != yes ]; then',
    `jq '.[] | select(.account.login? | type == "string")'`,
    '[[ "$tri_repo" =~ $pattern && "$home" == /* ]]',
    'if [ "$(stat -c %a -- "$app_dir")" != 700 ]; then',
    'same_repository "$1" "$served" && grep -qsxF -- "$line" "$state/findings"',
    'if [ "${WORKFLOW_REPOSITORY,,}" = "${REPOSITORY,,}" ]; then',
    // A lone = outside a test bracket assigns, and inside one against a literal or a uid it compares no identity.
    'repository = args.repository',
    'if [ "$owner_type" = Organization ]; then',
    '[ "$owner" = "$(id -u)" ] || problem "$path is not owned by $(id -un)"',
  ];
  for (const line of passed) assert.equal(caseSensitiveComparison(line), null, `passed: ${line}`);
});

// Comparisons the scan finds in files the agents' App cannot change (.github/workflows/), which only the owner can
// lowercase or annotate. Each entry is the file and the exact trimmed line; once the owner fixes the line, the entry
// matches nothing and the scan fails until it is removed.
const owed = [
  // github.repository against job.workflow_repository, equal in Triphammer's own runs. Both name the same repository
  // as GitHub records it, but were they ever to differ in case, the run would take its scripts from WORKFLOW_SHA, a
  // commit the pull request can change, instead of the default branch.
  ['.github/workflows/risk-tier.yml', 'if [ "$WORKFLOW_REPOSITORY" = "$REPOSITORY" ]; then'],
  // github.repository against the pull request's head.repo.full_name. A difference in case leaves the owner's pull
  // request waiting for approval, the safe side.
  ['.github/workflows/risk-tier.yml',
    'if [ "${PULL_REQUEST_AUTHOR,,}" = "${OWNER,,}" ] && [ "$HEAD_REPOSITORY" = "$REPOSITORY" ]; then'],
];

test('no script or workflow compares a login, owner or repository name case-sensitively', () => {
  const files = scanned();
  assert.ok(files.includes('bin/ticket-runner') && files.includes('.github/workflows/risk-tier.yml'), 'scans the tree');
  const unused = new Set(owed.map(entry => entry.join('\0')));
  const hits = files.flatMap(file => readFileSync(join(repository, file), 'utf8').split('\n').flatMap((line, i) => {
    const why = caseSensitiveComparison(line);
    if (why && unused.delete(`${file}\0${line.trim()}`)) return [];
    return why ? [`${file}:${i + 1}: ${why}`] : [];
  }));
  assert.deepEqual([...unused].map(entry => entry.replace('\0', ': ')), [],
    'these owed comparisons are fixed or gone, so remove their entries from `owed`');
  assert.deepEqual(hits, [], 'compare logins, owners and repositories in any case, with ascii_downcase, .lower() or ' +
    '${x,,} on both sides, or end the line with `# case-sensitive: <reason>`:\n' + hits.join('\n'));
});
