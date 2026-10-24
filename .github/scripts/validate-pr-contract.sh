#!/usr/bin/env bash
set -euo pipefail

: "${OWNER:?OWNER is required}"
: "${REPOSITORY:?REPOSITORY is required}"
: "${PULL_REQUEST_NUMBER:?PULL_REQUEST_NUMBER is required}"

repository="$OWNER/$REPOSITORY"
pull_request="$(gh api "repos/$repository/pulls/$PULL_REQUEST_NUMBER")"
default_branch="$(jq -r '.base.repo.default_branch' <<< "$pull_request")"
base_branch="$(jq -r '.base.ref' <<< "$pull_request")"

if [[ "$base_branch" != "$default_branch" ]]; then
  echo "A PR must target $default_branch, not '$base_branch'. Retarget it to $default_branch and include a closing reference, such as: Closes #276."
  exit 1
fi

query='query($owner: String!, $repository: String!, $number: Int!) {
  repository(owner: $owner, name: $repository) {
    pullRequest(number: $number) {
      closingIssuesReferences(first: 1) {
        totalCount
      }
    }
  }
}'

response="$(gh api graphql -f query="$query" -F owner="$OWNER" -F repository="$REPOSITORY" -F number="$PULL_REQUEST_NUMBER")"
closing_issue_count="$(jq -r '.data.repository.pullRequest.closingIssuesReferences.totalCount' <<< "$response")"

if [[ "$closing_issue_count" == "0" ]]; then
  echo "A PR targeting $default_branch must include a valid GitHub closing reference, such as: Closes #276."
  exit 1
fi
