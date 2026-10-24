#!/usr/bin/env bash
# Runs the risk classifier exactly as it exists on the base branch, against this branch's diff. The classifier reads
# its rules from the base ref too (.triphammer/risk-tier.json there), so a pull request cannot loosen its own tier by
# editing either. If the base has no classifier yet, the answer is "escalate".
# Usage: scripts/risk-tier-base.sh [base-ref]   (default origin/main). Exit codes as scripts/risk-tier.mjs.
# With $TRIPHAMMER_CHECKOUT set (bin/land-pr sets it), the classifier is instead that checkout's
# refs/remotes/origin/main copy, Triphammer's main, for a project that is another repository; the diff and the rules
# still come from this repository and its base ref.
set -u
base="${1:-origin/main}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
from=(git) at="$base"
if [ -n "${TRIPHAMMER_CHECKOUT:-}" ]; then
  from=(git -C "$TRIPHAMMER_CHECKOUT") at=refs/remotes/origin/main
fi
if ! "${from[@]}" show "$at:scripts/risk-tier.mjs" > "$tmp/risk-tier.mjs" 2>/dev/null; then
  printf '{\n  "tier": "escalate",\n  "reasons": ["%s has no scripts/risk-tier.mjs yet"]\n}\n' "$at"
  exit 2
fi
node "$tmp/risk-tier.mjs" "$base"
