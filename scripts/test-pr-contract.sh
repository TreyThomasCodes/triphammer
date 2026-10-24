#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
validator="$repository_root/.github/scripts/validate-pr-contract.sh"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

mkdir -p "$test_root/bin"
cat > "$test_root/bin/gh" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail

if [[ "$1" == "api" && "$2" == "graphql" ]]; then
  jq -n --argjson count "$MOCK_CLOSING_COUNT" '{data:{repository:{pullRequest:{closingIssuesReferences:{totalCount:$count}}}}}'
elif [[ "$1" == "api" && "$2" == "repos/test/example-project/pulls/100" ]]; then
  jq -n --arg base "$MOCK_BASE" --arg default "main" '{base:{ref:$base,repo:{default_branch:$default}}}'
else
  echo "Unexpected mock gh call: $*" >&2
  exit 2
fi
MOCK
chmod +x "$test_root/bin/gh"

export PATH="$test_root/bin:$PATH"
export OWNER=test
export REPOSITORY=example-project
export PULL_REQUEST_NUMBER=100

reset_case() {
  export MOCK_CLOSING_COUNT=1
  export MOCK_BASE=main
}

expect_success() {
  local name="$1"
  if ! bash "$validator" > "$test_root/output" 2>&1; then
    cat "$test_root/output"
    echo "$name should have succeeded." >&2
    exit 1
  fi
}

expect_failure() {
  local name="$1"
  local message="$2"
  if bash "$validator" > "$test_root/output" 2>&1; then
    cat "$test_root/output"
    echo "$name should have failed." >&2
    exit 1
  fi
  if ! grep -qF "$message" "$test_root/output"; then
    cat "$test_root/output"
    echo "$name should have reported: $message" >&2
    exit 1
  fi
}

reset_case
expect_success "Default branch with closing reference"

reset_case
MOCK_CLOSING_COUNT=0
expect_failure "Default branch without closing reference" "must include a valid GitHub closing reference"

reset_case
MOCK_BASE=recovery/289-historical-comparison
expect_failure "Base other than the default branch" "must target main, not 'recovery/289-historical-comparison'"

reset_case
MOCK_BASE=recovery/289-historical-comparison
MOCK_CLOSING_COUNT=0
expect_failure "Base other than the default branch without closing reference" "must target main"

echo "Pull request contract checks passed."
