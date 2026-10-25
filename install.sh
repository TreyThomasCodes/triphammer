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
# sudo asks for the password once, from the terminal, before anything is cloned; as root, sudo is not used. The script
# is one function called on its last line, so a download cut short runs nothing.
set -euo pipefail

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
  $sudo bash "$work/triphammer/bin/provision" "${args[@]}"
}

main "$@"
