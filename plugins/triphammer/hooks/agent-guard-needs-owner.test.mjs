// agent-guard.py: the needs-owner rule, gh issue edit and gh pr edit taking `needs-owner` off.
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
  'gh --repo=o/r pr edit 3 --remove-label needs-owner',
  'gh issue edit 7 --repo owner/name --title x --remove-label needs-owner',
  'gh issue edit 7 --remove-label needs-owner && echo done',
  'gh issue edit 7 --body "a <<EOF; x | y" --remove-label needs-owner',
  'gh issue edit 7 --add-label -R --remove-label needs-owner',
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
  "gh issue comment 7 --body 'x; gh issue edit 7 --remove-label needs-owner'",
  'echo gh issue edit 7 --remove-label needs-owner',
  'gh label list',
  'gh -R o/r issue edit 7 --remove-label bug',
];

test('in a Triphammer session gh issue edit or gh pr edit removing needs-owner is refused', t => {
  const s = triphammerSession(t);
  if (!s) return;
  for (const command of removals) {
    const reason = decide(command, s.worktree, {env: s.env});
    assertRuleDenied(reason, 'needs-owner', command);
    assert.match(reason, /only someone other than the App lifts it/, command);
    assert.match(reason, /comment on the issue what you need from the owner/, command);
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
