# shellcheck shell=bash
# What bin/provision and bin/provision-project share, sourced by both after they define `prog` (their name, for
# messages), `here` (their directory) and `usage`, and before they set `user`, `home` and `dry_run`. Nothing here
# changes the machine until a script calls it.
# shellcheck disable=SC2154  # prog, here, user, home and dry_run are the sourcing script's
# shellcheck disable=SC2034  # codename, arch, node_arch and node_bin are for the sourcing script
# shellcheck disable=SC2016  # the sh -c scripts expand their own arguments, not this shell's
#
# The machine file, $root/etc/triphammer.conf, is how provision-project and the triphammer command find what provision
# set up: Triphammer's repository and checkout, and the service user and its home. provision writes it as root, mode
# 644, one KEY=VALUE per line.
#
# Tests run the scripts with fakes of the package and account tools first on PATH, and two variables meant for them
# only: TRIPHAMMER_PROVISION_ROOT, a directory the system paths the scripts write (/etc, /usr/local, /tmp) and read
# (/etc/os-release) are taken under, and TRIPHAMMER_PROVISION_GIT_BASE, the URL the repositories are cloned under
# instead of https://github.com/.

usage_error() {
  printf '%s: %s\n' "$prog" "$1" >&2
  usage
  exit 2
}
fail() {
  printf '%s: %s\n' "$prog" "$1" >&2
  exit 1
}

root="${TRIPHAMMER_PROVISION_ROOT:-}"
git_base="${TRIPHAMMER_PROVISION_GIT_BASE:-https://github.com/}"
repo_pattern='^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
machine_file="$root/etc/triphammer.conf"
node_bin="$root/usr/local/bin"

# check_place <flag> <repo> <path>: a repository as owner/name and a checkout as a plain absolute path, or exit 2.
check_place() {
  [[ "$2" =~ $repo_pattern ]] || usage_error "$1 takes a repository as owner/name, not $2"
  [[ "$3" == /* && "$3" != */ && "$3" != *//* && "/$3/" != */../* && "/$3/" != */./* ]] \
    || usage_error "$1 $2: the checkout must be an absolute path without . or .. parts or a trailing /, not $3"
}

# machine_text <repo> <checkout> <user> <home>: the machine file's content.
machine_text() {
  printf '# Written by bin/provision: Triphammer on this machine (bin/README.md, On a machine of its own).\n'
  printf 'TRIPHAMMER_REPO=%s\nTRIPHAMMER_CHECKOUT=%s\nTRIPHAMMER_USER=%s\nTRIPHAMMER_HOME=%s\n' "$@"
}
# read_machine: sets tri_repo, tri_checkout, user and home from the machine file, or exits 1 naming what is wrong.
read_machine() {
  local line key value
  tri_repo="" tri_checkout="" user="" home=""
  [ -r "$machine_file" ] || fail "$machine_file is missing; set the machine up first (install.sh, or bin/provision)"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    key="${line%%=*}" value="${line#*=}"
    case "$key" in
      TRIPHAMMER_REPO) tri_repo="$value" ;;
      TRIPHAMMER_CHECKOUT) tri_checkout="$value" ;;
      TRIPHAMMER_USER) user="$value" ;;
      TRIPHAMMER_HOME) home="$value" ;;
    esac
  done < "$machine_file"
  [[ "$tri_repo" =~ $repo_pattern && "$tri_checkout" == /* && "$user" =~ ^[a-z_][a-z0-9_-]{0,31}$ && "$home" == /* ]] \
    || fail "$machine_file does not name Triphammer's repository, checkout, user and home; run bin/provision again"
}

# check_ubuntu: run as root on Ubuntu, amd64 or arm64; sets codename, arch and node_arch.
check_ubuntu() {
  [ "$(id -u)" = 0 ] || fail "run it as root (sudo $0 ...); --dry-run too, as it reads what only root may"
  [ -r "$root/etc/os-release" ] || fail "$root/etc/os-release is missing; $prog runs on Ubuntu"
  local os_id
  os_id="$(sed -n 's/^ID=//p' "$root/etc/os-release" | tr -d '"')"
  codename="$(sed -n 's/^VERSION_CODENAME=//p' "$root/etc/os-release" | tr -d '"')"
  [ "$os_id" = ubuntu ] || fail "this is ${os_id:-an unknown system}, not Ubuntu; $prog runs on Ubuntu"
  [[ "$codename" =~ ^[a-z]+$ ]] || fail "$root/etc/os-release names no release (VERSION_CODENAME)"
  arch="$(dpkg --print-architecture)"
  case "$arch" in
    amd64) node_arch=x64 ;;
    arm64) node_arch=arm64 ;;
    *) fail "the machine's architecture is $arch; $prog supports amd64 and arm64" ;;
  esac
}

changes=0
# change <what> <command...>: runs a change, or with --dry-run prints it; either way it counts.
change() {
  local what="$1"
  shift
  changes=$((changes + 1))
  if [ -n "$dry_run" ]; then
    printf 'would: %s\n' "$what"
    return 0
  fi
  printf '+ %s\n' "$what"
  "$@"
}
note() { printf '%s\n' "$1"; }
# summary: how many changes the run made or would make.
summary() {
  echo
  if [ "$changes" -eq 0 ]; then
    echo "Nothing to change: the machine is as asked."
  elif [ -n "$dry_run" ]; then
    echo "$changes change(s) to make; nothing was changed."
  else
    echo "$changes change(s) made."
  fi
}

user_exists() { getent passwd "$user" >/dev/null 2>&1; }
# as_user <command...>: runs a command as the service user, from /, with only its own environment. Before the user
# exists (with --dry-run) it fails, as every check that needs the user then does.
as_user() {
  user_exists || return 1
  (cd / && runuser -u "$user" -- env -i HOME="$home" USER="$user" LOGNAME="$user" SHELL=/bin/bash LANG=C.UTF-8 \
    PATH="$home/.local/bin:$home/.dotnet:$home/.dotnet/tools${root:+:$root/usr/local/bin}:/usr/local/bin:/usr/bin:/bin" \
    DOTNET_ROOT="$home/.dotnet" DOTNET_CLI_TELEMETRY_OPTOUT=1 "$@")
}
# as_user_claude <args...>: runs the user's claude in a session of its own, with nothing on stdin. Run from a terminal,
# claude can touch the terminal after its work is done, and a process outside the terminal's foreground group that
# does is stopped, so the step would never return.
as_user_claude() { as_user setsid -w claude "$@" < /dev/null; }

# A checkout is absent, an empty directory, or already a clone of its repository; anything else is the owner's to sort
# out, so it stops there before anything changes.
same_remote() {
  local url="${1%/}" want="${2,,}"
  url="${url%.git}" url="${url,,}"
  local base="${git_base,,}"
  [ "$url" = "$base$want" ] || [ "$url" = "https://github.com/$want" ] || [ "$url" = "git@github.com:$want" ] \
    || [ "$url" = "ssh://git@github.com/$want" ]
}
# checkout_state <repo> <path>: prints absent, empty or cloned, or fails naming what is wrong.
checkout_state() {
  if [ ! -e "$2" ] && [ ! -L "$2" ]; then
    echo absent
  elif [ -d "$2" ] && [ ! -L "$2" ] && [ -z "$(ls -A -- "$2")" ]; then
    echo empty
  elif user_exists && [ "$(as_user git -C "$2" rev-parse --show-toplevel 2>/dev/null)" = "$(readlink -f -- "$2")" ] \
      && same_remote "$(as_user git -C "$2" remote get-url origin 2>/dev/null)" "$1"; then
    echo cloned
  else
    fail "$2 exists and is not $user's clone of $1; move it away, or give another checkout"
  fi
}

# Packages from Ubuntu's archive (or a vendor's repository once it is added).
apt_fresh=""
installed() {
  [ "$(dpkg-query -W -f='${db:Status-Status}' "$1" 2>/dev/null)" = installed ]
}
apt_update() {
  [ -n "$apt_fresh" ] || { apt-get update -q && apt_fresh=1; }
}
apt_run() {
  apt_update && DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends "$@"
}
# apt_install <package...>: installs the packages that are not installed yet.
apt_install() {
  local missing=() package
  for package; do installed "$package" || missing+=("$package"); done
  [ ${#missing[@]} -eq 0 ] || change "install ${missing[*]}" apt_run "${missing[@]}" \
    || fail "apt-get could not install ${missing[*]}"
}
# root_file <path> <mode> <content>: writes a file root owns, unless it holds exactly <content> with <mode> already.
write_root_file() {
  install -d -m 755 -- "$(dirname "$1")" && printf '%s' "$3" > "$1.provision" && chmod "$2" "$1.provision" \
    && mv -f -- "$1.provision" "$1"
}
same_root_file() {
  [ -f "$1" ] && [ ! -L "$1" ] && cmp -s -- "$1" <(printf '%s' "$3") && [ "$(stat -c %a -- "$1")" = "$2" ]
}
root_file() {
  same_root_file "$@" || change "write $1" write_root_file "$@" || fail "could not write $1"
}

# bootstrap_helper: a copy of the github-app-token beside this script, in a directory root owns that the user may read
# and run, removed when the script ends; $bootstrap names the directory. Clones use it until Triphammer's checkout puts
# github-app-token on the user's PATH, and provision-project asks it for the App's slug.
bootstrap=""
bootstrap_helper() {
  [ -z "$bootstrap" ] || return 0
  bootstrap="$(mktemp -d "$root/tmp/github-app-token.XXXXXX")" || return 1
  trap 'rm -rf -- "$bootstrap"' EXIT
  [[ "$bootstrap" =~ ^[A-Za-z0-9/._-]+$ ]] || { echo "$prog: the temporary directory $bootstrap needs quoting" >&2; return 1; }
  chmod 755 -- "$bootstrap" && install -m 755 -- "$here/github-app-token" "$bootstrap/github-app-token"
}
# clone <repo> <path>: clones the repository as the user unless it is cloned there already.
clone_into() {
  if [ ! -e "$2" ]; then mkdir -p -- "$2" || return 1; fi
  chown -- "$user:" "$2" || return 1
  if as_user test -x "$home/.local/bin/github-app-token"; then
    as_user git clone -q -- "$git_base$1.git" "$2"
  else
    bootstrap_helper || return 1
    as_user git -c credential.https://github.com.helper= \
      -c "credential.https://github.com.helper=!$bootstrap/github-app-token git-credential" \
      clone -q -- "$git_base$1.git" "$2"
  fi
}
clone() {
  local state
  state="$(checkout_state "$1" "$2")"
  [ "$state" != cloned ] || return 0
  change "clone $1 into $2 as $user" clone_into "$1" "$2" \
    || fail "could not clone $1 into $2; a private repository needs the App's files in $home/.config/github-app first (bin/README.md, On a machine of its own), then run $prog again"
}
# cloned <repo> <path>: succeeds when the checkout is there: always, but with --dry-run, where a clone may only be
# planned.
cloned() { [ -z "$dry_run" ] || [ "$(checkout_state "$1" "$2" 2>/dev/null)" = cloned ]; }
# user_link <link> <target>: a symlink the user owns, unless it points there already.
user_link() {
  [ "$(readlink -- "$1" 2>/dev/null)" = "$2" ] && return 0
  change "link $1 to $2" as_user sh -c 'mkdir -p "$(dirname "$1")" && ln -sfn "$2" "$1"' sh "$1" "$2" \
    || fail "could not link $1"
}
# user_file <path> <mode> <content>: a file the user owns, unless it holds exactly <content> with <mode> already. A
# file with other content is kept beside it as <path>.old.
write_user_file() {
  printf '%s' "$3" | as_user sh -c 'umask 077 && mkdir -p "$(dirname "$1")" && { [ ! -e "$1" ] || cp -p "$1" "$1.old"; } \
    && cat > "$1.provision" && chmod "$2" "$1.provision" && mv -f "$1.provision" "$1"' sh "$1" "$2"
}
user_file() {
  if printf '%s' "$3" | as_user cmp -s -- "$1" - 2>/dev/null && [ "$(stat -c %a -- "$1")" = "$2" ]; then return 0; fi
  local what="write $1"
  [ ! -e "$1" ] || what="rewrite $1 (the file it replaces is kept as $1.old)"
  change "$what" write_user_file "$@" || fail "could not write $1"
}
# reload_units: reloads the user's systemd units.
reload_units() {
  change "reload $user's systemd units" systemctl --machine="$user@" --user daemon-reload \
    || fail "systemctl could not reload $user's units"
}
