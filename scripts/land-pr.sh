#!/usr/bin/env bash
# Lands a pull request as the triphammer:merge-policy skill decides: runs main's risk classifier against the branch
# checked out here and carries out its tier. It never decides the tier itself.
#   auto      arm auto-merge (squash, delete the branch)
#   escalate  request the review of the owner ($TRIPHAMMER_OWNER, else the repository's owner), comment the classifier's
#             reasons, arm auto-merge (the risk-tier workflow, not this script, sets needs-owner while the owner's
#             approval of the current head is missing, and escalated permanently)
#   blocked   refuse with the reasons and change nothing
# Usage, from the pull request's branch, always with main's copy so a branch cannot change its own landing:
#   git fetch origin main && git show refs/remotes/origin/main:scripts/land-pr.sh | bash -s -- <pr>
# or, for a project that is another repository than Triphammer's checkout <dir> (bin/land-pr does this):
#   git -C <dir> show refs/remotes/origin/main:scripts/land-pr.sh | TRIPHAMMER_CHECKOUT=<dir> bash -s -- <pr>
# Exit code: 0 landed (auto or escalate), 3 blocked, 1 anything else (a closed or merged PR, a classifier or gh error).
set -euo pipefail

# One function, read whole before it runs, with stdin closed: under `bash -s` the rest of stdin is this script, and
# nothing it starts may read from it.
main() {
  pr="${1:-}"
  [[ "$pr" =~ ^[1-9][0-9]*$ ]] || { echo "usage: land-pr.sh <pull request number>" >&2; exit 1; }

  info="$(gh pr view "$pr" --json state,headRefOid --jq '"\(.state) \(.headRefOid)"')"
  read -r state head <<< "$info"
  if [ "$state" != OPEN ]; then
    echo "land-pr: pull request #$pr is $state, not open; nothing landed. Put further work on a new issue and pull request from main." >&2
    exit 1
  fi
  if [ "$(git rev-parse HEAD)" != "$head" ]; then
    echo "land-pr: HEAD here is not the head of pull request #$pr ($head); check out and push its branch first" >&2
    exit 1
  fi

  # Main's wrapper and main's classifier, fully qualified so a tag named origin/main cannot stand in for it. Both come
  # from Triphammer's checkout, $TRIPHAMMER_CHECKOUT (bin/land-pr sets it, and risk-tier-base.sh reads it too),
  # or this repository when that is unset; the diff and the rules come from this repository's origin/main.
  from=(git)
  [ -z "${TRIPHAMMER_CHECKOUT:-}" ] || from=(git -C "$TRIPHAMMER_CHECKOUT")
  tier=0
  reasons="$(git fetch -q origin main && "${from[@]}" show refs/remotes/origin/main:scripts/risk-tier-base.sh \
    | bash -s -- refs/remotes/origin/main)" || tier=$?
  printf '%s\n' "$reasons"

  arm() { gh pr merge "$pr" --auto --squash --delete-branch; }
  case "$tier" in
    0)
      arm
      echo "land-pr: #$pr is auto; auto-merge armed" ;;
    2)
      # The owner is a person: the ticket runner gives the session the login it acts for in TRIPHAMMER_OWNER, which
      # in a repository an organization owns is not the repository's owner. Unset or empty, as when a person runs
      # this by hand on their own repository, it is the repository's owner.
      owner="${TRIPHAMMER_OWNER:-}"
      [ -n "$owner" ] || owner="$(gh repo view --json owner --jq .owner.login)" || owner=""
      if [ -z "$owner" ]; then
        echo "land-pr: cannot read the owner (TRIPHAMMER_OWNER or the repository's owner) to request their review; nothing changed. Report it." >&2
        exit 1
      fi
      gh pr edit "$pr" --add-reviewer "$owner"
      gh pr comment "$pr" --body "$(printf 'Risk tier: escalate. The owner approves before this merges.\n\n```json\n%s\n```' "$reasons")"
      arm
      echo "land-pr: #$pr escalates; review requested from $owner, auto-merge armed" ;;
    3)
      echo "land-pr: #$pr is blocked and must not merge; see the reasons above. Nothing changed." >&2
      exit 3 ;;
    *)
      echo "land-pr: the classifier failed (exit $tier); nothing changed. Report it." >&2
      exit 1 ;;
  esac
}
main "$@" </dev/null
