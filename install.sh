#!/usr/bin/env bash
# Sets a machine up for Triphammer without a clone of its repository first, run as an ordinary user who may use sudo
# (or as root):
#
#   curl -fsSL https://raw.githubusercontent.com/TreyThomasDotCodes/triphammer/main/install.sh | bash
#
# It clones Triphammer into a temporary directory as the caller, runs that clone's bin/provision as root through sudo
# with the arguments given (`| bash -s -- <arguments>`), and removes the clone when provision ends; provision clones
# the checkout the machine keeps. Without --triphammer it adds `--triphammer <TRIPHAMMER_REPO> /srv/triphammer`. Every
# other argument is provision's (bin/README.md, "On a machine of its own"). Projects come afterwards, with
# `triphammer add`.
#
#   TRIPHAMMER_REPO  the repository to clone, <owner>/<name> (default TreyThomasDotCodes/triphammer)
#   TRIPHAMMER_REF   the branch or tag to run provision from (default main)
#
# sudo asks for the password once, from the terminal, before anything is cloned; as root, sudo is not used. provision
# runs in a session of its own with nothing on stdin: its output still reaches the terminal, but no command under it
# can be stopped for touching a terminal it is not in the foreground of, or wait there for an answer. So Ctrl-C at the
# terminal reaches the script and the bash that runs provision (directly or through sudo), but not provision. On an
# INT, TERM or HUP the script sends TERM to that bash (from a session of its own, since some sudo versions do not relay
# a signal sent from the process group the command runs in); on any of the three that bash sends TERM to provision's
# whole process group and waits for provision to end; and only then does the script end, by the signal it got, and
# remove the clone. The script defines functions and calls one on its last line, so a download cut short runs nothing.
set -euo pipefail

# A bash script that runs its arguments in a session of its own with nothing on stdin, waits for it, exits with its
# status, and on an INT, TERM or HUP sends TERM to the session's process group and goes on waiting. bin/triphammer
# holds the same script, and passes it through `sudo -i`, which hands the login shell every character escaped but `$`:
# so it is one line, and every expansion is braced, as `$\{` is literal to that shell.
# shellcheck disable=SC2016  # expanded by the bash that runs it
own_session='stop() { [ -z "${p}" ] || kill -TERM -- "-${p}" 2> /dev/null || kill -TERM "${p}"; }; p=; trap "t=1; stop" INT TERM HUP; (trap - INT QUIT; exec setsid "${@}") < /dev/null & p=${!}; [ -z "${t-}" ] || stop; while :; do wait "${p}" && exit 0 || s=${?}; kill -0 "${p}" 2> /dev/null || exit "${s}"; done'

# detached <prefix...> -- <command...>: runs the command, through the prefix (sudo, or nothing), in a session of its own
# with nothing on stdin, and waits for it; returns its status. An INT, TERM or HUP meanwhile stops it, and once it has
# ended this script ends by that signal.
detached() {
  local prefix=() child="" caught="" woke status
  while [ "$1" != -- ]; do prefix+=("$1"); shift; done
  shift
  trap 'caught=INT woke=1; relay' INT
  trap 'caught=TERM woke=1; relay' TERM
  trap 'caught=HUP woke=1; relay' HUP
  (trap - INT QUIT; exec "${prefix[@]}" bash -c "$own_session" detached "$@") < /dev/null &
  child=$!
  [ -z "$caught" ] || relay
  while :; do
    woke=""
    wait "$child" && status=0 || status=$?
    [ -n "$woke" ] || break
  done
  trap - INT TERM HUP
  [ -z "$caught" ] || kill -s "$caught" "$$"
  return "$status"
}
# relay: sends TERM to detached's child, if it has started.
relay() {
  [ -z "$child" ] || setsid -w kill -s TERM "$child" 2> /dev/null || true
}

main() {
  local repo="${TRIPHAMMER_REPO:-TreyThomasDotCodes/triphammer}" ref="${TRIPHAMMER_REF:-main}"
  local base="${TRIPHAMMER_INSTALL_GIT_BASE:-https://github.com}"  # tests clone from a local directory instead
  local sudo=""
  if [ "$(id -u)" -ne 0 ]; then
    sudo=sudo
    echo "Triphammer's installer sets this machine up as root: packages, a service user and its checkout. sudo asks for your password once."
    sudo -v
  fi
  local arg args=("$@") tri=""
  for arg in "$@"; do [ "$arg" != --triphammer ] || tri=1; done
  [ -n "$tri" ] || args=(--triphammer "$repo" /srv/triphammer "${args[@]}")

  if ! command -v git > /dev/null; then
    echo "install.sh: installing git" >&2
    $sudo env DEBIAN_FRONTEND=noninteractive apt-get update -qq
    $sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git > /dev/null
  fi

  work="$(mktemp -d)"  # global: the EXIT trap runs after main has returned
  trap 'rm -rf "$work"' EXIT
  git clone -q --depth 1 --branch "$ref" "$base/$repo.git" "$work/triphammer"
  detached $sudo -- bash "$work/triphammer/bin/provision" "${args[@]}"
}

main "$@"
