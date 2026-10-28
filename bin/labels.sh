# shellcheck shell=bash
# The labels Triphammer reads and sets in a project's repository: the owner's brakes and priority, which the owner
# applies, the runner's `agent-working`, and `cleanup`, which the runner puts on the issues it files from a session's
# proposals. `ticket-runner --labels` (which `triphammer add` runs as the service
# user) creates the ones the repository lacks with create_labels, and the doctor reports them with missing_labels, so
# both read this one list. bin/README.md ("Labels") lists what each does. `upkeep` is not here: ticket-runner makes
# sure it exists when it opens an upkeep issue.
#
# Each entry: name|color|description. GitHub limits a description to 100 characters.
triphammer_labels=(
  "hold|D93F0B|The owner's brake: Triphammer skips this issue or pull request and stops a run on it"
  "needs-owner|5319E7|Waits for the owner: Triphammer neither runs nor merges it while this label is on"
  "stop-agents|B60205|An open issue with this label pauses Triphammer in this repository"
  "next|0E8A16|Triphammer takes this ready issue before the other ready issues"
  "agent-working|FBCA04|Triphammer is working on this; don't update or push to it"
  "light|C2E0C6|Triphammer's first run on this issue uses the Sonnet builder; later runs use Opus"
  "cleanup|BFD4F2|A cleanup a session proposed; Triphammer takes it after the other ready issues"
)

# $labelled_jq: a jq prelude defining labelled($name), true when the input's labels include $name, given in lowercase,
# in any case, as GitHub matches label names. It reads both shapes the scripts get: `.labels[].name` (gh --json) and
# `.labels.nodes[].name` (GraphQL). ticket-runner and merge-when-ready prefix their label filters with it:
# --jq "$labelled_jq"'labelled("hold")'. It also defines labels_unread, true when the input's `.labels` (the gh --json
# shape) holds 100 labels or more: gh reads only the first 100 and says nothing of the rest, so a brake may be among them.
# It must stay at 100, the most gh returns. bin/ticket-decide.py's UNREAD is one lower and leaves out agent-working, as
# the runner adds that label before its first brake check: an item picked at 99 would be braked here on every tick.
# shellcheck disable=SC2034,SC2016  # read by the scripts that source this file; the $ is jq's
labelled_jq='def labelled($name): any((.labels | if type == "object" then .nodes else . end)[]?; .name | ascii_downcase == $name);
  def labels_unread: (.labels | length) >= 100; '

# missing_labels <owner/repo>: prints the name of each label of triphammer_labels the repository lacks, one per line,
# comparing names case-insensitively as GitHub does. Fails, printing nothing, when the labels cannot be listed.
missing_labels() {
  local have entry name missing=""
  have="$(gh label list -R "$1" --limit 1000 --json name --jq '.[].name')" || return 1
  for entry in "${triphammer_labels[@]}"; do
    name="${entry%%|*}"
    grep -qixF -- "$name" <<< "$have" || missing+="$name"$'\n'
  done
  printf '%s' "$missing"
}

# create_labels <owner/repo>: creates each label of triphammer_labels the repository lacks, with its color and
# description, and leaves the ones it has as they are (no --force). Prints a line per label created and fails, after
# trying every one, when the labels cannot be listed or one cannot be created.
create_labels() {
  local missing entry name rest color description status=0
  if ! missing="$(missing_labels "$1")"; then
    echo "could not list the labels of $1" >&2
    return 1
  fi
  for entry in "${triphammer_labels[@]}"; do
    name="${entry%%|*}" rest="${entry#*|}"
    color="${rest%%|*}" description="${rest#*|}"
    grep -qxF -- "$name" <<< "$missing" || continue
    if gh label create "$name" -R "$1" --color "$color" --description "$description" >/dev/null; then
      echo "created the label $name in $1"
    else
      echo "could not create the label $name in $1" >&2
      status=1
    fi
  done
  return "$status"
}
