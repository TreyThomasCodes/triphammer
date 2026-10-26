#!/usr/bin/env bash
# Runs the risk classifier exactly as it exists on the base branch, against this branch's diff. The classifier reads
# its rules from the base ref too (.triphammer/risk-tier.json there), so a pull request cannot loosen its own tier by
# editing either. If the base has no classifier yet, the answer is "escalate".
# Usage: scripts/risk-tier-base.sh [base-ref]   (default origin/main). Exit codes as scripts/risk-tier.mjs.
# With $TRIPHAMMER_CHECKOUT set, the classifier is instead that checkout's copy at $TRIPHAMMER_REF, by default
# refs/remotes/origin/main, Triphammer's main, for a project that is another repository: bin/land-pr sets only the
# checkout, and the risk-tier workflow, called from a project, sets both to Triphammer at the commit the project pinned.
# The diff and the rules still come from this repository and its base ref.
set -u
base="${1:-origin/main}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
from=(git) at="$base"
if [ -n "${TRIPHAMMER_CHECKOUT:-}" ]; then
  from=(git -C "$TRIPHAMMER_CHECKOUT") at="${TRIPHAMMER_REF:-refs/remotes/origin/main}"
fi
if ! "${from[@]}" show "$at:scripts/risk-tier.mjs" > "$tmp/risk-tier.mjs" 2>/dev/null; then
  printf '{\n  "tier": "escalate",\n  "reasons": ["%s has no scripts/risk-tier.mjs yet"]\n}\n' "$at"
  exit 2
fi
node "$tmp/risk-tier.mjs" "$base"
