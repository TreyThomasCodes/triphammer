// agent-guard.py: the needs-owner rule, gh commands that may take `needs-owner` off an issue or pull request.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inTriphammerSession, decide, triphammerSession, assertRuleDenied, assertNotLifted,
} from './agent-guard-fixture.mjs';

const removals = [
  'gh issue edit 7 --remove-label needs-owner',
  'gh pr edit 12 --remove-label needs-owner',
  'gh issue edit 7 --remove-label=needs-owner',
  'gh issue edit 7 --remove-label "needs-owner"',
  "gh pr edit 12 --remove-label 'bug,needs-owner'",
  'gh issue edit 7 --remove-label "bug, Needs-Owner"',
  'gh issue edit 7 --add-label ready --remove-label NEEDS-OWNER',
  'gh issue -R owner/name edit 7 --remove-label needs-owner',
  'gh -R o/r issue edit 7 --remove-label needs-owner',
  'gh --repo o/r issue edit 7 --remove-label needs-owner',
  'gh --repo=o/r issue edit 7 --remove-label needs-owner',
  'gh -Ro/r issue edit 7 --remove-label needs-owner',
  'gh -R o/r pr edit 3 --remove-label needs-owner',
  'gh -R o/r label delete needs-owner --yes',
  'gh -R o/r -R o/s label delete needs-owner --yes',
  'gh --repo o/r api -X DELETE repos/o/r/labels/needs-owner',
  'gh --unknown issue edit 7 --remove-label needs-owner',
  'gh --unknown x issue view 7',
  'gh issue edit 7 --repo owner/name --title x --remove-label needs-owner',
  'gh issue edit 7 --remove-label "$LABEL"',
  'gh issue edit 7 --remove-label needs-owner && echo done',
  'bash -c "gh pr edit 12 --remove-label needs-owner"',
  'gh label delete needs-owner --yes',
  'gh label edit Needs-Owner --name owner-done',
  'gh api -X DELETE repos/owner/name/issues/7/labels/needs-owner',
  'gh api --method DELETE /repos/owner/name/issues/7/labels/Needs-Owner',
  'gh api --method=DELETE repos/{owner}/{repo}/issues/7/labels/needs-owner',
  'gh api -XDELETE repos/owner/name/issues/7/labels/needs%2Downer',
  'gh api -X delete repos/owner/name/issues/7/labels/needs%252Downer',
  'gh api repos/owner/name/issues/7/labels/needs-owner -X DELETE',
  'gh api -X DELETE "repos/$REPO/issues/$N/labels/needs-owner"',
  'gh api -X DELETE "repos/owner/name/issues/7/labels/$LABEL"',
  'gh api -X DELETE https://api.github.com/repos/owner/name/issues/7/labels/needs-owner',
  'gh api -X "$METHOD" repos/owner/name/issues/7/labels/needs-owner',
  'gh api -X PUT repos/owner/name/issues/7/labels -f "labels[]=bug"',
  'gh api -X PUT repos/owner/name/issues/7/labels --input labels.json',
  'gh api -X DELETE repos/owner/name/issues/7/labels',
  'gh api -X DELETE repos/owner/name/issues/7/labels/',
  'gh api -X PATCH repos/owner/name/issues/7 -f "labels[]=bug"',
  'gh api -X PATCH repos/owner/name/issues/7 -F labels=@labels.json',
  'gh api -X PATCH repos/owner/name/issues/7 --input issue.json',
  'gh api repos/owner/name/issues/7 -f "labels[]=bug"',
  'gh api -X DELETE repos/owner/name/labels/needs-owner',
  'gh api -X PATCH repos/owner/name/labels/needs-owner -f new_name=x',
  "gh api -X DELETE 'repos/o/r/issues/7/labels/needs-owner#x'",
  "gh api -X DELETE 'repos/o/r/issues/7/labels/Needs-Owner#'",
  "gh api -X DELETE 'repos/o/r/issues/7/labels/needs-owner%23x'",
  "gh api -X DELETE 'repos/o/r/issues/7/labels/needs-owner%3Fx'",
  "gh api -X PUT 'repos/o/r/issues/7/labels#x' -f 'labels[]=bug'",
  "gh api -X DELETE 'repos/o/r/labels/needs-owner#x'",
  'gh api -X DELETE repos/o/r/labels/x/../needs-owner',
  'gh api -X DELETE repos/o/r/labels/./needs-owner',
  'gh api -X PATCH repos/o/r/labels/x/../needs-owner -f new_name=gone',
  'gh api -X DELETE repos/o/r/labels/x/%2E%2E/needs-owner',
  'gh api -X DELETE repos/o/r/labels/x%2F..%2Fneeds-owner',
  'gh api -X DELETE repos/o/r/issues/7/labels/x/../needs-owner',
  'gh api -X DELETE repos/o/r/issues/7/labels/needs-owner/.',
  'gh api -X DELETE repos/o/r/issues/7/labels/needs-owner/x/..',
  'gh api -X DELETE repos/o/r/issues/7/labels/x/../../labels',
  'gh api -X DELETE repos/o/r/labels/../../../../../labels/needs-owner',
  'gh api -X DELETE repos/o/r/labels//needs-owner',
  'gh api -X DELETE repos/o/r//issues/7//labels/needs-owner',
  'gh api -X DELETE repos/o/r/labels/needs-owner/',
  'gh api -X DELETE repos/o/r/labels/needs-owner//',
  'gh api -X DELETE //repos/o/r/labels/needs-owner',
  'gh api -X DELETE https://api.github.com/repos/o/r/labels/x/../needs-owner',
  String.raw`gh api -X DELETE 'repos\o\r\labels\needs-owner'`,
  'gh api -X DELETE repos/o/r/labels%5Cneeds-owner',
  'gh issue edit 7 --body "a <<EOF; x | y" --remove-label needs-owner',
  'echo 7 | xargs gh issue edit --remove-label needs-owner',
  'echo needs-owner | xargs gh issue edit 7 --remove-label',
  'echo needs-owner | xargs -I{} gh pr edit 12 --remove-label {}',
  'echo repos/o/r/issues/7/labels/needs-owner | xargs gh api -X DELETE',
  'echo "issue edit 7 --remove-label needs-owner" | xargs gh',
  'echo issue | xargs -I{} gh {} edit 7 --remove-label needs-owner',
  'echo 7 | xargs gh -R o/r issue edit --remove-label needs-owner',
  'echo needs-owner | xargs gh -R o/r label delete',
  'echo 7 | xargs gh --unknown issue view',
  'echo "issue edit 7 --remove-label needs-owner" | xargs gh -R o/r',
];

const allowed = [
  'gh issue edit 7 --remove-label bug',
  'gh pr edit 12 --remove-label "bug,ready"',
  'gh issue edit 7 --add-label needs-owner',
  'gh pr edit 12 --add-label needs-owner',
  'gh issue edit 7 --body-file body.md',
  'gh issue view 7 --json labels',
  'gh pr create --title x --body-file body.md --label needs-owner',
  'gh issue comment 7 --body "remove needs-owner when you are done"',
  'gh label list',
  'gh label edit needs-owner --description "work stops for the owner"',
  'gh api repos/owner/name/issues/7/labels',
  'gh api repos/owner/name/issues/7/labels -f "labels[]=needs-owner"',
  'gh api -X POST repos/owner/name/issues/7/labels -f "labels[]=needs-owner"',
  'gh api -X DELETE repos/owner/name/issues/7/labels/bug',
  "gh api -X DELETE 'repos/owner/name/issues/7/labels/bug#needs-owner'",
  'gh api repos/owner/name/issues/7/labels/needs-owner',
  'gh api -X PATCH repos/owner/name/issues/7 -f body=x -f "title=$TITLE"',
  'gh api repos/owner/name/labels/needs-owner',
  'gh api -X DELETE repos/o/r/labels/bug',
  'gh api -X DELETE repos/o/r/labels/x/../bug',
  'gh api -X DELETE repos/o/r/labels/needs-owner/../bug',
  'gh api -X DELETE repos/o/r/issues/7/labels//bug/',
  'gh api repos/o/r/labels/x/../needs-owner',
  'echo gh issue edit 7 --remove-label needs-owner',
  "gh issue comment 7 --body 'x; gh issue edit 7 --remove-label needs-owner'",
  'gh issue edit 7 --attach shot.png --remove-label bug',
  'echo 7 | xargs gh issue view',
  'echo 12 | xargs gh pr view --json labels',
  'gh -R o/r issue edit 7 --remove-label bug',
  'gh --repo=o/r issue view 7 --json labels',
  'gh -R o/r label list',
  'gh --version',
  'gh --help',
  'echo 7 | xargs gh -R o/r issue view',
];

test('in a Triphammer session a gh command that may take needs-owner off an issue or pull request is refused', t => {
  const s = triphammerSession(t);
  if (!s) return;
  for (const command of removals) {
    const reason = decide(command, s.worktree, {env: s.env});
    assertRuleDenied(reason, 'needs-owner', command);
    assert.match(reason, /only someone other than the App lifts it/, command);
  }
  assertNotLifted(removals[0], 'needs-owner', s.worktree, {env: s.env});
});

test('in a Triphammer session adding needs-owner, removing other labels and reading stay allowed', t => {
  const s = triphammerSession(t);
  if (!s) return;
  for (const command of allowed) {
    assert.equal(decide(command, s.worktree, {env: s.env}), null, command);
  }
});

test('outside a Triphammer session gh may remove needs-owner', t => {
  if (inTriphammerSession) {
    t.skip('the hook reads $TRIPHAMMER_SESSION from its parents too, which run inside a Triphammer session');
    return;
  }
  const s = triphammerSession(t);
  if (!s) return;
  const {TRIPHAMMER_SESSION: _, ...env} = s.env;
  for (const command of removals) {
    assert.equal(decide(command, s.worktree, {env}), null, command);
  }
});
