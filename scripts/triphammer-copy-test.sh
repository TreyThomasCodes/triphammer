#!/usr/bin/env bash
# Copies only Triphammer's files into a fresh git repository in a temporary directory and runs their tooling tests
# there, so a test that reads a file outside that set fails here. The only skips allowed are agent-guard's, for a
# repository under a temporary directory, the project-name tests', for a copy without .triphammer/project.json, and
# inside a Triphammer session the one agent-guard test that a session skips in any checkout; any other skip fails the
# run.
# Usage: scripts/triphammer-copy-test.sh
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Triphammer's files: what moves to its own repository.
files=(plugins/triphammer .claude-plugin bin systemd status 'scripts/risk-tier*' 'scripts/land-pr*'
  scripts/git-hooks scripts/commit-msg.test.mjs scripts/test-git-repo.mjs scripts/test-pr-contract.sh
  .github/scripts/validate-pr-contract.sh)
allowed_skips=('the repository lies under a temporary directory' 'no .triphammer/project.json')
[[ -z "${TRIPHAMMER_SESSION:-}" ]] || allowed_skips+=('this test runs inside a Triphammer session')

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
copy="$work/triphammer"
mkdir "$copy"

# The tracked and untracked files of the working tree (not the ignored ones), as they are now.
count=0
while IFS= read -r -d '' path; do
  [[ -e "$root/$path" || -L "$root/$path" ]] || continue  # deleted but not yet staged
  mkdir -p "$copy/$(dirname "$path")"
  cp -P --preserve=mode "$root/$path" "$copy/$path"
  count=$((count + 1))
done < <(git -C "$root" ls-files -z --cached --others --exclude-standard -- "${files[@]}" | sort -zu)

git_fresh() {
  GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME='copy test' GIT_AUTHOR_EMAIL='copy-test@example.invalid' \
    GIT_COMMITTER_NAME='copy test' GIT_COMMITTER_EMAIL='copy-test@example.invalid' git -C "$copy" "$@"
}
git_fresh init -q -b main
git_fresh add -A
git_fresh commit -q -m "Triphammer's files"

shopt -s nullglob
cd "$copy"
tests=(scripts/*.test.mjs plugins/triphammer/hooks/*.test.mjs status/*.test.mjs bin/*.test.mjs)
status=0
node --test --test-reporter=tap "${tests[@]}" > "$work/tap" 2>&1 || status=$?
if [[ "$status" -ne 0 ]]; then
  cat "$work/tap"
  echo "triphammer-copy-test: the tooling tests fail in a copy of only Triphammer's files" >&2
  exit 1
fi
bash scripts/test-pr-contract.sh > "$work/contract" 2>&1 || {
  cat "$work/contract"
  echo "triphammer-copy-test: scripts/test-pr-contract.sh fails in a copy of only Triphammer's files" >&2
  exit 1
}

skips="$(grep -E '^ *ok [0-9]+ - .* # SKIP' "$work/tap" || true)"
unexpected="$skips"
for reason in "${allowed_skips[@]}"; do
  unexpected="$(grep -vF "# SKIP $reason" <<< "$unexpected" || true)"
done
if [[ -n "$unexpected" ]]; then
  echo "$unexpected" >&2
  echo "triphammer-copy-test: tests skipped in the copy for another reason than: ${allowed_skips[*]}" >&2
  exit 1
fi
summary="$(sed -n 's/^# \(tests\|pass\|skipped\) \([0-9]*\)$/\1 \2/p' "$work/tap" | paste -sd ' ')"
echo "triphammer-copy-test: $count files copied; $summary"
for reason in "${allowed_skips[@]}"; do
  echo "triphammer-copy-test: skipped: $(grep -cF "# SKIP $reason" <<< "$skips" || true) x $reason"
done
