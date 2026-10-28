#!/usr/bin/env python3
# Claude Code PreToolUse hook for Bash, Write, Edit and NotebookEdit, part of the Triphammer plugin (its hooks/hooks.json
# runs it; a project's .claude/settings.json may run it too). It refuses three kinds of Bash command in every session,
# file-tool writes under the persistence rule below, and in a session Triphammer started three more (worktree-only,
# git-command, scheduler), each with a reason that says what to do instead:
#
#   persistence  a change to Triphammer's persistence, which agents never make (the owner does): a systemctl --user
#               verb that acts on the whole manager (daemon-reload, daemon-reexec, preset-all, exit, isolate,
#               default, halt, poweroff, reboot, soft-reboot, kexec, switch-root, set-environment, unset-environment,
#               import-environment), or a verb that changes a unit's state or files (enable, disable, reenable, link,
#               mask, unmask, start, stop, restart, reload, kill, preset, revert, edit and the like) on a Triphammer
#               unit (ticket-runner, merge-when-ready, triphammer-status, their @<project> instances and unit files, or
#               a glob that matches one); or a write, link or removal under ~/.local/bin, ~/.config/systemd/user,
#               ~/.config/triphammer (and the same under $XDG_CONFIG_HOME when set), the ticket runner's default
#               state directory ~/.local/state/ticket-runner, the STATE_DIR each Triphammer config
#               ${XDG_CONFIG_HOME:-~/.config}/triphammer/*.conf sets (a `STATE_DIR=/absolute/path` line; a config
#               that is missing, unreadable or malformed adds nothing else), or the shared directory
#               ($TRIPHAMMER_SHARED_DIR, else ${XDG_STATE_HOME:-~/.local/state}/triphammer). Writes are the shell-edit
#               writers below plus rm, rmdir, unlink, shred, mkdir, touch, chmod, chown, chgrp, any ln, install -d
#               and the source of an mv. A path may start with ~, $HOME or ${HOME} (or the variables above), and one
#               whose literal part before a $ already lies inside those directories counts. Untracked paths outside
#               any repository, so this rule needs no git and no project file. eval's arguments are judged as the
#               command they make (a cd in them moves the rest of the command); an eval whose text is computed when
#               it runs (a variable, a command substitution), a source or . of a file the same command writes, a
#               bash, sh, zsh, dash or ash given such a file as its script (`bash s.sh`, not -c text or -s), and a source
#               or . of a process substitution are refused, since the hook cannot read what they run; the write and
#               the run match when they name the same path, spelled with ~, $HOME, ${HOME} or relative to the
#               directory. Reads (cat, ls, readlink, systemctl --user status, show, list-timers, is-enabled) stay
#               allowed. Not covered: python, node or other interpreters that delete or link files outside the
#               script writes below, find -delete or -exec, global package installs, the contents of a file sourced
#               or run by a shell that the command does not write, a written file run some other way (./s.sh, a
#               shell reading it on stdin, a path the hook cannot spell out before it runs), a shell given a process
#               substitution as its script (bash <(...)), a source or . of /dev/stdin (source /dev/stdin <<< '...'),
#               a command substitution inside double quotes (echo "$(...)"), and a STATE_DIR given by
#               $TRIPHAMMER_CONFIG outside the config directory.
#               A Write, Edit or NotebookEdit (its file_path, or notebook_path) is refused when the file lies under
#               one of the directories above, checked both as written and as its real path (symlinks resolved, and
#               for a file that does not exist yet those of its nearest existing parent), so a symlinked directory
#               that leads into one counts; or when its real path is the real path of a symlink directly inside one
#               of them, such as ~/.local/bin/ticket-runner's script in the main checkout; or when its real path lies
#               under the bin, systemd, status, scripts or plugins/triphammer of a main checkout of Triphammer the
#               ticket runner runs from, which it sources, runs, links or loads as plugin on every tick: each CHECKOUT
#               a Triphammer config sets (a `CHECKOUT=/absolute/path` line, read like STATE_DIR) that holds
#               bin/config.sh, and the <checkout> of each such symlink whose real path is <checkout>/bin/<file>,
#               <checkout>/systemd/<unit> or <checkout>/status/<file>, when it holds bin/config.sh. The same files
#               in a worktree (<checkout>/.worktrees/<run>) are other paths and stay allowed. Shell-edit and self-kill
#               judge Bash only.
#   shell-edit  a shell rewrite of a git-tracked file under a shell-edit root of the repository the command runs in
#               (sed -i, perl -i, > or >> redirects, tee, cp, mv, install, ln -f/-b or rsync onto it, dd of=, truncate,
#               a python3/node heredoc or -c script that writes it). Those edits go through Edit or Write so the
#               language servers' diagnostics arrive after each one. The roots are the `shellEditRoots` of that
#               repository's .triphammer/project.json in its working tree, a list of paths relative to its root. A
#               repository whose project file is missing or unreadable, leaves the field out, or gives anything but
#               a list of relative paths inside the repository gets no shell-edit rule.
#   self-kill   pkill -f or pgrep -f with a pattern not written in '[p]attern' form, which also matches the command
#               line of the shell running it; kill of $$, $PPID or the PID of the session or one of its parents. In
#               a Triphammer session, xargs running kill, pkill, pgrep or killall, whose targets its input gives.
#               killall written out, and kill by a PID read at run time other than $$ and $PPID, are not covered.
#
# A session Triphammer started is one whose environment holds $TRIPHAMMER_SESSION, the path of the run's worktree
# (bin/ticket-runner sets it for ticket and repair runs, local-audit for the Qwen audit; subagents inherit it).
# The hook reads it from its own environment and from the environment each of its parent processes started with
# (/proc/<pid>/environ), and a write must fit every value it finds, so nothing a session does later (a settings
# file's env, an exported variable) widens what it may write. An interactive session has no such variable and keeps
# the rules above only.
#
#   worktree-only  a Write, Edit or NotebookEdit, or a write, link or removal by the Bash writers the persistence
#               rule reads (redirections, tee, sed -i, perl -i, cp, mv, ln, install, rsync, dd of=, truncate, rm,
#               rmdir, unlink, shred, mkdir, touch, chmod, chown, chgrp and the python or node script writes the
#               shell-edit rule recognises: cp, mv, ln and install by their destination, mv and rm by their source
#               too), unless the real path of the target lies inside the session's worktree (neither its .git nor,
#               for a recursive change, a directory holding it) or $TMPDIR, /tmp or /var/tmp; /dev/null and the
#               standard streams are always allowed. The real path is the one the kernel reaches: each `..` taken
#               after the symlinks before it, not textually (a file tool's path is checked that way and as written
#               with its `..` removed); for a path that does not exist yet, the real path of its nearest existing
#               parent with the rest appended, and a rest holding a `..` cannot be worked out. The path is checked
#               both fully resolved and with only its directory resolved, so a symlink inside the worktree that
#               leads outside it is refused, and so is the link itself. A symbolic link (ln -s, cp -s) must lead
#               inside them too, its text taken relative to the directory the link lands in (with ln -r, to the
#               current one), so no later write goes through it; and a path under a destination of cp, mv or rsync
#               in the same command cannot be worked out, since cp -a, -P or -R, mv and rsync -a may land a symlink
#               there that the hook cannot see yet. A hard link (ln without -s, cp -l or --link, link, rsync
#               --link-dest) gives its source a second name that writes change, so its source must lie inside them
#               too; and a write that changes an existing regular file's content (not rm, rmdir, unlink or the source
#               of an mv) is refused when the file has more than one hard link (st_nlink above 1), wherever its other
#               names are: git, dotnet and npm leave none in a worktree. A glob (*, ?, [) counts as every existing
#               path it may match whatever the shell options (hidden names and any case included) and as itself; a
#               brace expansion as the words it makes, among the file operands of tee, truncate, rm, mkdir, touch,
#               chmod and the like. A target the hook cannot work out before the command runs is refused too: a part
#               computed at run time ($VAR/x, $(...), `...`, a command substitution among a writer's arguments)
#               other than a leading $HOME, $TMPDIR, $TRIPHAMMER_PROPOSALS (whose file must still lie in those
#               places), $PWD (the directory the command is in) or a variable the
#               persistence rule expands, read from the hook's environment unless the command itself mentions it
#               other than as $NAME or ${NAME} (TMPDIR=, export, read, ${TMPDIR:=x}); ~+ and ~-; a brace expansion
#               anywhere else among a writer's words (cp {a,b}), or in a word with a quote or a $; an extglob
#               pattern; a glob holding ** or matching more than GLOB_LIMIT paths, or one as the destination of cp,
#               mv, ln, install, link or rsync; or a relative path after a cd the hook cannot follow. A wrapper's
#               directory option (env -C or --chdir, sudo -D or --chdir, git -C for a git config --file) moves the
#               directory the command's relative targets are judged against, though not its redirections, which the
#               shell opens first; one the hook cannot work out (computed at run time, a glob or brace expansion)
#               counts as a cd it cannot follow. It follows a
#               cd or pushd to the directory bash ends in, and loses track (so refuses a relative path after it) on:
#               a target it cannot work out, a glob or brace expansion; a `..` after a symlink, where bash's logical
#               directory and the physical one it falls back to (or cd -P and set -P take) differ; a relative name
#               not starting with ./ or ../ when $CDPATH, $BASH_ENV or cdable_vars may be set (in the hook's
#               environment or its parents', or named in the command); pushd -n or +N, popd; a cd behind env, sudo,
#               nohup, coproc and the like; a cd as the last command of a pipeline; a list holding a cd sent to the
#               background with &; and anything after a source or ., a function definition, an alias or a trap,
#               which may cd when they run. A $TRIPHAMMER_SESSION that names no directory leaves only the
#               temporary directories. The main checkout, its .git (where the worktree's git directory lives) and
#               everything under ~ are outside. A command the hook has not finished judging after PARSE_SECONDS
#               (4 seconds, well inside the hook's 10-second timeout, after which Claude Code would run it) is
#               refused: tokens, brace and glob expansion and the path checks all stop there, and a watchdog
#               process stops whatever else is still running a second later.
#   git-command  every git config write, whatever the key and scope (a set, --add, --replace-all, --unset,
#               --unset-all, --rename-section, --remove-section, --edit, a --file, and the set, unset, rename-section,
#               remove-section and edit subcommands, and xargs running git config or -I's string as git's
#               subcommand, a git -c value or an assignment before git), since a worktree's configuration
#               is its repository's (or ~/.gitconfig) and the main checkout's fetch reads it; git remote add, rename,
#               remove, rm, set-head, set-branches and set-url (and xargs running git remote, or git with no
#               subcommand); git -c, git --config-env, GIT_CONFIG_KEY_<n> or GIT_CONFIG_PARAMETERS
#               setting, for one command, a key whose value git runs as a command or reads as more settings:
#               core.hooksPath, core.fsmonitor, core.sshCommand, core.editor, core.pager, core.askpass, core.gitProxy,
#               core.alternateRefsCommand, sequence.editor, pager.*, credential.helper and credential.*.helper,
#               include.path, includeIf.*.path, filter.*.clean/smudge/process, diff.external, diff.*.textconv,
#               diff.*.command, merge.*.driver, gpg.program, gpg.*.program, gpg.ssh.defaultKeyCommand,
#               difftool.*.cmd/path, mergetool.*.cmd/path, remote.*.uploadpack/receivepack,
#               uploadpack.packObjectsHook, hook.*.command, interactive.diffFilter, gc.recentObjectsHook, imap.tunnel,
#               instaweb.httpd, trailer.*.cmd/command, browser.*.cmd/path, man.*.cmd/path, guitool.*.cmd,
#               sendemail.toCmd/ccCmd/headerCmd/sendmailCmd/smtpServer (and sendemail.*.<same>), and alias.* and
#               submodule.*.update whose value starts with !; the keys that let a URL run a command or change where
#               git fetches and pushes: every protocol.* key (protocol.allow, protocol.<name>.allow),
#               init.templateDir, url.*.insteadOf and url.*.pushInsteadOf, remote.*.url and remote.*.pushurl; the
#               keys that change what git fetches, merges and pushes: remote.*.fetch, remote.*.push, remote.*.mirror,
#               remote.pushDefault, branch.*.merge, branch.*.remote and branch.*.pushRemote; git branch
#               -u/--set-upstream-to and git push -u/--set-upstream for a branch other than the one checked out
#               (or one the hook cannot name; --all and --mirror count), git fetch and git pull --set-upstream,
#               --track with git branch --force, checkout -B or switch -C, and checkout or switch
#               --ignore-other-worktrees; each of these upstream settings also when it runs anywhere but in the
#               session's worktree. A key (or such a value, a git config word, or git remote's subcommand) computed at
#               run time counts. Reading config (--get, --get-all, --get-regexp, --list, get, list and the like), git
#               remote -v, show, get-url and prune, and git -c with other keys stay allowed.
#   scheduler   crontab other than -l, at, batch and systemd-run.
#
# These rules judge only the paths and keys a command names: the caches dotnet, npm or npx playwright write, git's
# own writes for a commit, a fetch, a worktree or an init (git -C ~ init), and every other write a program the
# session runs makes are not covered, nor are writes by interpreters (python -c, node -e, perl -e, ruby -e) beyond
# the script writes above, nor symlinks that a
# program other than ln and cp makes (tar -x, unzip, git checkout of a tracked symlink, an interpreter) and the
# same command then writes through, nor a cd made by an alias or function the session's shell already defines (its
# profile snapshot), nor a directory change by any wrapper other than those above, nor git settings that reach the
# repository some other way (a .gitmodules URL that git submodule sync copies). Outside a Triphammer session
# a path computed at run time ($VAR/x) counts only by the directory its literal part ends in; in one the
# worktree-only rule refuses it, as above.
#
# Every rule judges a command behind the wrappers sudo, env, command, builtin, nohup, exec, time, nice, stdbuf,
# timeout, setsid, flock, ionice, taskset, chrt and busybox (whose applet is the command), past their options and
# the operand timeout, flock, taskset and chrt take before it. flock FILE -c LINE, script -c LINE and su or runuser
# -c LINE (or --command, and su's --session-command) have LINE judged as a sh -c script, and runuser -u USER the
# command after it. Without a LINE (or runuser -u's command) each runs a shell that reads its script from stdin,
# which script passes through, so it is judged as sh is: its piped or here-string input as its script. flock's lock
# file counts as a file it creates, and script's typescript (its operand, else ./typescript) and its -I, -O, -B and
# -T log files, and GNU time's -o or --output file (also abbreviated, --out), as files they write; su's login shell (su -, -l) starts in another directory, so the worktree-only
# rule loses track of the directory for its LINE. xargs's command is judged as
# written, and in a Triphammer session xargs running one of the worktree-only rule's writers (tee, cp, rm, touch and
# the rest), sed or perl with or without -i (GNU sed and perl read an -i the input adds after the script), a shell (also through script, su, runuser or flock -c), eval, source, python or
# node with an inline script, git config, git remote or git with no subcommand written (which the input can make a
# write), git with -I's string in a word up to and including its subcommand (the subcommand, a git -c value, an
# environment assignment such as GIT_CONFIG_PARAMETERS or a wrapper's word before git), a wrapper whose own file operand (flock's lock file, script's typescript, time's -o file) the input can give, xargs
# itself (GNU xargs gives its command /dev/null as stdin, so an inner xargs runs the outer one's words as its command),
# kill, pkill, pgrep or killall (see the self-kill rule), or a command
# the input gives (xargs sudo, xargs timeout 5, xargs -I{} {}: the written words end before the command), appended
# or in place of -I's string, is refused, since the hook cannot read the operands xargs adds from its input, nor
# what -I's string becomes inside a script. So is xargs with a long option not named in full (--max-a, --delim),
# which may take the next word and move the command. Not
# covered: any other wrapper (doas, chroot, unshare, nsenter, watch, parallel, find -exec and the like), wrapper
# options the hook does not list (an abbreviated long option other than xargs's and time's), the timing file script
# writes (-tFILE or --timing=FILE; the hook reads the rest of -t's group as that file, as script does),
# busybox --install,
# a LINE run by a shell that reads it differently from sh (su -s), the units xargs adds to a systemctl --user verb
# from its input (xargs systemctl --user enable, or -I{} ... {}), the upstream options xargs adds to git branch,
# push, fetch, pull, checkout or switch from its input (xargs git branch with -u or --set-upstream-to in the input,
# which keeps git branch --merged | xargs git branch -d allowed), and outside a Triphammer session the operands
# xargs adds from its input. There is no OS-level limit on what a Triphammer session may write behind this hook,
# and every round of review has found another shell feature this parser misses: this hook is the only line.
#
# `# guard-override: <reason>` anywhere in the command lets that one Bash command through. A file tool has no command
# text to carry it, so its refusals have no override: the owner makes that change. Heredoc bodies, here-strings
# and quoted arguments (a PR --body, a commit -m) are prose, not commands, unless a shell or interpreter reads them:
# as its -c script, as env -S's command line, or on its stdin from a heredoc, a here-string or an echo or printf in
# the same pipeline. A `<<WORD` inside quotes, a comment or $(( )) is text, not a heredoc, and a heredoc's body
# starts after the next unquoted newline. Every line bash would run is judged: the lines after a heredoc whose
# terminator turns up early in its text, and the lines before one that opens an unbalanced quote (bash runs those,
# then stops at the quote).
# Anything else the hook cannot work out (malformed input, no git, a cwd outside a repository, a path computed at run
# time, a Triphammer config it cannot read, running out of time) allows the command, apart from the eval, source and
# shell-script cases above, a Triphammer session's write target and a Triphammer session's command the hook runs out
# of time on: the hook never blocks on its own failure.
#
# A file tool's path the hook cannot judge (missing, not text, relative without an absolute cwd) is allowed too.
#
# Reads the hook's JSON on stdin; prints a deny decision or nothing, and always exits 0.
#
# The tracked-file and shell-edit-target detection and the heredoc-is-prose rule are adapted from guard.py in
# https://github.com/rezk2ll/skills (plugins/guard/scripts/guard.py, commit bf99b4b), used under the MIT License:
#
#   Copyright (c) 2026 Khaled Ferjani
#
#   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
#   documentation files (the "Software"), to deal in the Software without restriction, including without limitation
#   the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
#   permit persons to whom the Software is furnished to do so, subject to the following conditions:
#
#   The above copyright notice and this permission notice shall be included in all copies or substantial portions of
#   the Software.
#
#   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
#   THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
#   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
#   TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
#   SOFTWARE.
import fnmatch
import functools
import glob
import json
import os
import re
import select
import signal
import stat
import subprocess
import sys
import time

OVERRIDE = re.compile(r"#\s*guard-override:\s*\S")
OVERRIDE_HINT = "rerun it with `# guard-override: <reason>` appended"
PROJECT_FILE = os.path.join(".triphammer", "project.json")
DEADLINE = time.monotonic() + 7  # well inside the 10-second hook timeout
# The parse, brace and glob expansion and the path checks stop here, well before DEADLINE and the hook timeout; a machine
# session's command is then refused. $TRIPHAMMER_GUARD_PARSE_SECONDS in the hook's own environment may only shorten it.
PARSE_SECONDS = 4.0


def parse_seconds():
    try:
        return max(0.0, min(PARSE_SECONDS, float(os.environ.get("TRIPHAMMER_GUARD_PARSE_SECONDS", PARSE_SECONDS))))
    except ValueError:
        return PARSE_SECONDS


PARSE_DEADLINE = time.monotonic() + parse_seconds()


class OutOfTime(Exception):
    """The parse ran past PARSE_DEADLINE."""


def check_deadline():
    if time.monotonic() > PARSE_DEADLINE:
        raise OutOfTime()
MAX_DEPTH = 3  # bash -c "bash -c ..." nesting the hook follows

# Shell operators, longest first so `>>` wins over `>`.
OPERATORS = ["&>>", "<<<", "&&", "||", ";;", "|&", ">>", ">&", ">|", "&>", "<<", "<&", "<>",
             "\n", ";", "&", "|", ">", "<", "(", ")"]
# `$(` opens a command substitution, `<(` a process substitution and a backquote either; each reads like a subshell
# group, but eval or source in front of one runs text the hook cannot read.
SEPARATORS = {"\n", ";", ";;", "&", "&&", "||", "(", ")", "$(", "<(", "`"}
OPENERS = {"(", "$(", "<("}
PIPES = {"|", "|&"}
WRITE_REDIRECTS = {">", ">>", ">|", "&>", "&>>", ">&", "<>"}
OTHER_REDIRECTS = {"<", "<<<", "<&"}
WRAPPERS = {"sudo", "env", "command", "builtin", "nohup", "exec", "time", "nice", "stdbuf", "timeout", "setsid",
            "flock", "ionice", "taskset", "chrt", "busybox"}
# Wrapper options that take a value: short letters (value attached, `-n10`, or the next word) and long names (value
# after `=`, `--user=someone`, or the next word).
WRAPPER_VALUE_OPTIONS = {
    "sudo": ("aCcDgpRrTtUu", {"--auth-type", "--login-class", "--close-from", "--chdir", "--group", "--host",
                               "--prompt", "--chroot", "--role", "--type", "--command-timeout", "--other-user",
                               "--user"}),
    # env's -S/--split-string value is itself the command line, which split_string splits into words in place.
    "env": ("aCu", {"--argv0", "--chdir", "--unset"}),
    "exec": ("a", set()),
    "time": ("fo", {"--format", "--output"}),
    "nice": ("n", {"--adjustment"}),
    "stdbuf": ("eio", {"--error", "--input", "--output"}),
    "timeout": ("ks", {"--kill-after", "--signal"}),
    "flock": ("Ew", {"--conflict-exit-code", "--timeout", "--wait"}),
    "ionice": ("cnpPu", {"--class", "--classdata", "--pid", "--pgid", "--uid"}),
    "chrt": ("TPD", {"--sched-runtime", "--sched-period", "--sched-deadline"}),
}
# Every long option of the wrappers whose abbreviations the hook resolves, as getopt does an unambiguous prefix:
# GNU time's, since its --output names a file it writes.
WRAPPER_LONG_OPTIONS = {"time": {"--append", "--format", "--output", "--portability", "--quiet", "--verbose",
                                 "--help", "--version"}}
# Wrappers that take an operand before the command, matching the pattern: timeout's duration, flock's lock file,
# taskset's mask or CPU list and chrt's priority (a number, so a chrt that leaves it out still has its command read).
ANY_OPERAND = re.compile(r".*", re.DOTALL)
WRAPPER_OPERANDS = {"timeout": ANY_OPERAND, "flock": ANY_OPERAND, "taskset": ANY_OPERAND, "chrt": re.compile(r"\d+")}
# Commands that run a shell command line given by an option, as `sh -c` does, and their options that take a value:
# script (-c or --command; its log files and typescript operand are writes) and su and runuser (-c, --command or
# --session-command; their remaining operands after the user go to the shell).
SCRIPT_RUNNERS = {
    "script": ("cEIOBTmo", {"--command", "--echo", "--log-in", "--log-out", "--log-io", "--log-timing",
                           "--logging-format", "--output-limit"}),
    "su": ("cgGsw", {"--command", "--session-command", "--group", "--supp-group", "--shell",
                     "--whitelist-environment"}),
}
# runuser -u USER runs its operands as the command itself, without a shell.
SCRIPT_RUNNERS["runuser"] = ("cgGswu", SCRIPT_RUNNERS["su"][1] | {"--user"})
# The wrappers' and script runners' short letters whose optional value can only be attached: like a letter that takes
# a value, each ends its group, the rest of the word being its value, but never takes the next word. sudo's -h is
# help, or a host when attached (`-hhost`); script's -t is its timing file (`-tc` writes timing to ./c).
OPTIONAL_VALUE_LETTERS = {"sudo": "h", "script": "t"}
# xargs's short options that take the rest of their group or else the next word as their value, its short options
# whose optional value can only be the rest of their group, and its long options that take the next word. GNU xargs
# also takes any unambiguous prefix of a long option, so in a session one not named in full is refused.
# The text of a word standing for one xargs appends from its input; no command line holds a NUL.
XARGS_INPUT = "\0xargs-input\0"
XARGS_VALUE_OPTIONS = ("adEILnPs", "eil", {"--arg-file", "--delimiter", "--max-args", "--max-procs", "--max-chars",
                                           "--process-slot-var"})
XARGS_LONG_OPTIONS = XARGS_VALUE_OPTIONS[2] | {"--null", "--eof", "--replace", "--max-lines", "--interactive",
                                               "--no-run-if-empty", "--open-tty", "--show-limits", "--exit",
                                               "--verbose", "--help", "--version"}
# python's short options without a value, which can stand before c in one group (`-Ic`); c's script is the rest of
# the group or the next word.
PYTHON_SCRIPT_FLAG = re.compile(r"-[bBdEhiIOPqRsSuvVx]*c(.*)", re.DOTALL)
# A shell's short-option group holding c (`-c`, `-lc`, `-ec`): the first operand after it is the script.
SHELL_SCRIPT_FLAG = re.compile(r"-[a-zA-Z]*c[a-zA-Z]*")
# A shell's short-option group (`-eo`, `+O`, the -c group itself): each o or O in it takes the next word as its value.
SHELL_OPTION_GROUP = re.compile(r"[-+][a-zA-Z]+")
# env's split-string option, alone or after its other value-less letters, with the command line attached or next.
ENV_SPLIT_FLAG = re.compile(r"-[iv0]*S(.*)|--split-string(?:=(.*))?", re.DOTALL)
# Reserved words that can stand before a command name: `if true; then sed -i ...; fi` runs sed.
RESERVED = {"if", "then", "else", "elif", "do", "while", "until", "{", "!", "coproc"}
SHELLS = {"bash", "sh", "zsh", "dash", "ash"}
PYTHON = re.compile(r"python(?:3(?:\.\d+)?)?$")
# Script writes the hook recognises, each with the written path as a string literal or a plain variable. A path
# the script builds any other way is not followed, so the script is allowed.
_LIT = r"""[rRbBuU]{0,2}(?:'[^'\n]*'|"[^"\n]*")|`[^`\n$]*`"""
_PATH = rf"(?:(?:pathlib\.)?(?:Pure)?(?:Posix)?Path\(\s*)?({_LIT}|[A-Za-z_]\w*)"  # group 1: the path
_ARG = rf"(?:{_LIT}|[\w.]+(?:\([^()\n]*\))?)"
SCRIPT_WRITES = [
    re.compile(rf"{_PATH}\s*\)?\s*\.\s*(?:write_text|write_bytes)\s*\("),
    re.compile(rf"{_PATH}\s*\)?\s*\.\s*open\s*\(\s*(?:mode\s*=\s*)?[rRbBuU]?['\"][^'\"]*[wax+]"),
    re.compile(rf"\bopen\s*\(\s*{_PATH}\s*\)?\s*,\s*(?:mode\s*=\s*)?[rRbBuU]?['\"][^'\"]*[wax+]"),
    re.compile(rf"\b(?:writeFile|appendFile|createWriteStream)(?:Sync)?\s*\(\s*{_PATH}"),
    re.compile(rf"\b(?:shutil\.(?:copy\w*|move)|os\.(?:replace|rename)|copyFile(?:Sync)?|rename(?:Sync)?|cp(?:Sync)?)"
               rf"\s*\(\s*{_ARG}\s*,\s*{_PATH}"),
    re.compile(rf"\bfileinput\.\w+\(\s*(?:files\s*=\s*)?[(\[]?\s*{_PATH}[^)]*\binplace\s*=\s*(?:True|1)"),
]
# `name = 'path'`, `name = Path('path')`, `const name = "path"`: a plain variable bound to a path literal.
SCRIPT_BINDING = re.compile(rf"(?:\b(?:const|let|var)\s+)?\b([A-Za-z_]\w*)\s*=(?!=)\s*{_PATH}\s*\)?\s*(?:[;\n#]|$)",
                            re.MULTILINE)
# The commands xargs may not run in a Triphammer session, since the self-kill rule judges them by the operands its input
# gives (killall, which the rule does not judge, names its targets the same way).
XARGS_SIGNALLERS = {"kill", "pkill", "pgrep", "killall"}

# pgrep/pkill options that take a value as the next word.
KILL_VALUE_OPTIONS = {"-d", "-g", "-G", "-P", "-s", "-t", "-u", "-U", "-F", "-r", "--delimiter", "--pgroup",
                      "--group", "--parent", "--session", "--terminal", "--euid", "--uid", "--pidfile", "--runstates",
                      "--signal", "--ns", "--nslist", "--env"}
# Triphammer's systemd units: ticket-runner, merge-when-ready and triphammer-status, their @<project> instances and
# template unit files, by name or by path (`systemctl --user link .../ticket-runner@.timer`).
TRIPHAMMER_UNIT = re.compile(r"(?:ticket-runner|merge-when-ready|triphammer-status)(?:@[^/]*)?"
                             r"(?:\.(?:service|timer|path|socket|target))?")
TRIPHAMMER_UNIT_SAMPLES = [f"{name}{instance}.{suffix}"
                           for name in ("ticket-runner", "merge-when-ready", "triphammer-status")
                           for instance in ("", "@", "@project") for suffix in ("service", "timer")]
# systemctl verbs that change the manager's units or their state: refused outright, or when they name a Triphammer unit.
# The first set acts on the whole manager, which the ticket runner, the merge queue and the status page run under.
SYSTEMCTL_GLOBAL = {"daemon-reload", "daemon-reexec", "preset-all", "exit", "isolate", "default", "halt", "poweroff",
                    "reboot", "soft-reboot", "kexec", "switch-root", "set-environment", "unset-environment",
                    "import-environment"}
SYSTEMCTL_CHANGING = {"start", "stop", "reload", "restart", "try-restart", "reload-or-restart", "try-reload-or-restart",
                      "force-reload", "condrestart", "condreload", "condstop", "kill", "clean", "freeze", "thaw",
                      "enable", "disable", "reenable", "preset", "revert", "link", "mask", "unmask", "edit",
                      "set-property", "add-wants", "add-requires", "bind", "mount-image"}
SYSTEMCTL_VALUE_OPTIONS = ("tpPsHMno", {
    "--type", "--property", "--state", "--signal", "--kill-whom", "--kill-value", "--what", "--job-mode", "--root",
    "--image", "--image-policy", "--host", "--machine", "--lines", "--output", "--preset-mode", "--timestamp",
    "--message", "--boot-loader-menu", "--boot-loader-entry", "--reboot-argument", "--drop-in", "--when", "--legend",
    "--check-inhibitors"})
# Commands every operand of which is a path they create, remove or change: the options that take a value, and whether
# a recursive option makes it reach every file under the operand.
PATH_CHANGERS = {
    "rm": ("", set()), "rmdir": ("", set()), "unlink": ("", set()), "shred": ("nsu", {"--iterations", "--size"}),
    "mkdir": ("m", {"--mode", "--context"}), "touch": ("drt", {"--date", "--reference", "--time"}),
    "chmod": ("", {"--reference"}), "chown": ("", {"--reference", "--from"}), "chgrp": ("", {"--reference"}),
}
RECURSIVE = {"-r", "-R", "--recursive"}
CHMOD_MODE = re.compile(r"[0-7]+|[ugoa]*[-+=][-+=,ugoarwxXst0-7]*")  # a mode not written as an option (-x is one)
REMOVERS = {"rm", "rmdir", "unlink"}  # they remove one name of a file, and leave its content under the others
# The writers (besides sed -i and perl -i) whose operands the worktree-only rule judges.
SUBSTITUTION_WRITERS = {"tee", "rsync", "dd", "truncate", "link", "cp", "mv", "ln", "install"} | set(PATH_CHANGERS)
# Leading variables a path may start with, expanded from the hook's own environment, which the shell shares.
PATH_VARIABLES = ("HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "TRIPHAMMER_SHARED_DIR")
# The leading variables the worktree-only rule expands: those, $TMPDIR, $TRIPHAMMER_PROPOSALS (the proposals file
# bin/ticket-runner makes in a temporary directory), and $PWD as the directory the command is in.
SESSION_VARIABLES = PATH_VARIABLES + ("TMPDIR", "TRIPHAMMER_PROPOSALS", "PWD")
HEREDOC = re.compile(r"(?<!<)<<(-?)[ \t]*(['\"]?)([A-Za-z_][\w.-]*)\2")
MARKER = re.compile(r"\x00(\d+)\x00$")


class Word:
    def __init__(self):
        self.value = ""
        self.dynamic = False  # holds an unquoted or double-quoted $ or backquote, so its value is unknown
        self.glob = False  # holds an unquoted glob character
        self.quoted = False  # holds a quote or backslash, so it cannot be a file-descriptor number
        # holds an unquoted { (not ${) before an unquoted }, or ends in ?, *, +, @ or ! before an unquoted (: bash may
        # turn it into other words (brace expansion, an extglob pattern), which the hook does not work out
        self.expands = False
        self.extglob = False  # ends in ?, *, +, @ or ! before an unquoted (
        self.opened = False  # an unquoted { not part of ${ has been seen
        self.after_dollar = False  # the last character was an unquoted $


def strip_heredocs(cmd):
    """Removes heredoc bodies, minding quotes (text-lint.py uses it too): a `<<WORD` counts only outside quotes,
    comments and $(( )), also inside a $( ) or backquotes in a double-quoted word, and its body starts after the next
    unquoted newline. Each becomes `<<` and a marker word naming its body; returns (text, bodies)."""
    out, bodies, pending, stack, i, n = [], [], [], ["code"], 0, len(cmd)
    while i < n:
        c, top = cmd[i], stack[-1]
        if top == "'":
            if c == "'":
                stack.pop()
            out.append(c)
            i += 1
            continue
        if c == "\\":
            out.append(cmd[i:i + 2])
            i += 2
            continue
        if cmd.startswith("$((", i):
            stack.append("((")
            out.append("$((")
            i += 3
            continue
        if cmd.startswith("$(", i):
            stack.append("(")
            out.append("$(")
            i += 2
            continue
        if c == "`":
            if top == "`":
                stack.pop()
            else:
                stack.append("`")
        elif top == '"':
            if c == '"':
                stack.pop()
        elif top == "((":
            if cmd.startswith("))", i):
                stack.pop()
                out.append("))")
                i += 2
                continue
            if c == "(":
                stack.append("(")
        elif c in "'\"":
            stack.append(c)
        elif c == "(":
            stack.append("(")
        elif c == ")" and top == "(":
            stack.pop()
        elif c == "#" and (i == 0 or cmd[i - 1] in " \t\n;&|()<>"):
            end = cmd.find("\n", i)
            end = n if end < 0 else end
            out.append(cmd[i:end])
            i = end
            continue
        elif c == "<" and (match := HEREDOC.match(cmd, i)):
            pending.append((match.group(1), match.group(3)))
            out.append(f"<< \x00{len(bodies) + len(pending) - 1}\x00")
            i = match.end()
            continue
        elif c == "\n" and pending:
            out.append(c)
            i += 1
            for dash, word in pending:
                body = []
                while i < n:
                    end = cmd.find("\n", i)
                    end = n if end < 0 else end
                    line, i = cmd[i:end], end + 1
                    if (line.lstrip("\t") if dash else line) == word:
                        break
                    body.append(line)
                bodies.append("\n".join(body))
            pending = []
            continue
        out.append(c)
        i += 1
    bodies += [""] * len(pending)  # a heredoc on the command's last line has an empty body
    return "".join(out), bodies


class Unbalanced(ValueError):
    """A quote that never closes; start is where it opens."""
    def __init__(self, start):
        super().__init__(f"unbalanced quote at {start}")
        self.start = start


def tokenize(text):
    """Splits shell text into ("op", operator) and ("word", Word) tokens; raises Unbalanced on unbalanced quotes."""
    tokens, word, i, n = [], None, 0, len(text)

    def flush():
        nonlocal word
        if word is not None:
            tokens.append(("word", word))
            word = None

    while i < n:
        check_deadline()
        c = text[i]
        if c in " \t\r":
            flush()
            i += 1
            continue
        if c == "#" and word is None:
            while i < n and text[i] != "\n":
                i += 1
            continue
        if c == "\\":
            if text[i + 1:i + 2] == "\n":
                i += 2
                continue
            word = word or Word()
            word.quoted = True
            word.after_dollar = False
            word.value += text[i + 1:i + 2]
            i += 2
            continue
        if c == "'":
            end = text.find("'", i + 1)
            if end < 0:
                raise Unbalanced(i)
            word = word or Word()
            word.quoted = True
            word.after_dollar = False
            word.value += text[i + 1:end]
            i = end + 1
            continue
        if c == '"':
            word = word or Word()
            word.quoted = True
            word.after_dollar = False
            start, i = i, i + 1
            while i < n and text[i] != '"':
                if text[i] == "\\" and i + 1 < n:
                    word.value += text[i + 1] if text[i + 1] in '"\\$`\n' else text[i:i + 2]
                    i += 2
                    continue
                if text[i] in "$`":
                    word.dynamic = True
                word.value += text[i]
                i += 1
            if i >= n:
                raise Unbalanced(start)
            i += 1
            continue
        if c in "$<" and text[i + 1:i + 2] == "(":
            flush()
            tokens.append(("op", c + "("))  # a command or process substitution
            i += 2
            continue
        if c == "`":
            flush()
            tokens.append(("op", "`"))
            i += 1
            continue
        op = next((o for o in OPERATORS if text.startswith(o, i)), None)
        if op:
            if op == "(" and word is not None and word.value[-1:] in ("?", "*", "+", "@", "!"):
                word.expands = word.extglob = True  # an extglob pattern such as @(a|b)
            if op[0] in "<>" and word is not None and not word.quoted and word.value.isdigit():
                word = None  # the 2 of 2>file or 2>&1 names a file descriptor, not an argument
            flush()
            tokens.append(("op", op))
            i += len(op)
            continue
        word = word or Word()
        if c == "$":
            word.dynamic = True
        elif c in "*?[":
            word.glob = True
        elif c == "{" and not word.after_dollar:
            word.opened = True
        elif c == "}" and word.opened:
            word.expands = True
        word.after_dollar = c == "$"
        word.value += c
        i += 1
    flush()
    return tokens


class Command:
    def __init__(self):
        self.words = []
        self.write_targets = []
        self.heredocs = []  # this command's own heredoc bodies
        self.herestrings = []  # this command's own here-string texts
        self.pipeline_input = []  # every text its pipeline feeds a stdin, which an interpreter in it may read
        self.substituted = False  # a command or process substitution stands among its arguments
        self.function = False  # `name ()`: a function definition


# Operators that open a substitution whose output becomes words of the command.
SUBSTITUTIONS = {"$(", "<(", "`"}


def substituted():
    """The word a substitution makes, whose value the hook cannot know."""
    word = Word()
    word.value, word.dynamic = "$(...)", True
    return word


def pipelines(tokens):
    """Groups tokens into pipelines of commands, and the separator that ends each pipeline."""
    pipeline, command, i, backquotes = [], Command(), 0, 0
    while i < len(tokens):
        kind, value = tokens[i]
        i += 1
        if kind == "word":
            command.words.append(value)
            continue
        if value in WRITE_REDIRECTS or value in OTHER_REDIRECTS or value == "<<":
            target = tokens[i][1] if i < len(tokens) and tokens[i][0] == "word" else None
            i += target is not None
            if target is None:
                if value in WRITE_REDIRECTS and i < len(tokens) and tokens[i][1] in SUBSTITUTIONS:
                    command.write_targets.append(substituted())  # `> $(...)/x`: a target computed when it runs
                continue
            if value == "<<<":
                command.herestrings.append(target.value)
            elif value == "<<":
                marker = MARKER.match(target.value)
                if marker:
                    command.heredocs.append(int(marker.group(1)))
            elif value in WRITE_REDIRECTS and not re.fullmatch(r"\d+|-", target.value):
                command.write_targets.append(target)
            continue
        if value in PIPES:
            pipeline.append(command)
            command = Command()
            continue
        if value == "`":
            backquotes += 1
        if value == "(" and len(command.words) == 1 and i < len(tokens) and tokens[i] == ("op", ")"):
            command.function = True
        if command.words and (value in ("$(", "<(") or value == "`" and backquotes % 2):
            # A substitution among the command's arguments: the words after it close it as another command, so the
            # hook cannot tell which of its operands it names.
            command.substituted = True
        pipeline.append(command)
        yield pipeline, value
        pipeline, command = [], Command()
    pipeline.append(command)
    yield pipeline, None


def strip_prefix(words, chdirs=None, writes=None):
    """Drops variable assignments and wrappers such as sudo or env before the command name. With chdirs, appends to
    it each directory a wrapper option changes to (env -C or --chdir, sudo -D or --chdir), as a word, or None for one
    whose value is missing or that the hook does not follow (su's login). With writes, appends to it each file a
    wrapper creates or writes itself (flock's lock file, script's typescript and logs, time's -o file). A wrapper that runs a shell
    command line (flock FILE -c, script -c, su -c) gives the words `sh -c <line>` in its place."""
    i, wrapper, operand, locked = 0, None, None, False
    while i < len(words):
        value = words[i].value
        name = os.path.basename(value)
        if locked and value in ("-c", "--command"):
            # `flock FILE -c LINE`: flock runs the line with $SHELL -c.
            return shell_words(words[i + 1:i + 2])
        locked = False
        if wrapper == "env" and ENV_SPLIT_FLAG.fullmatch(value):
            words, i = split_string(words, i), 0  # env keeps reading options from the split words
        elif wrapper is not None and value == "--":
            wrapper = None  # the end of the wrapper's options
            i += 1
        elif i > 0 and value == "-":
            i += 1  # env reads a bare - as -i, even after --; no command is named -
        elif wrapper is not None and value.startswith("-"):
            taken = takes_value(wrapper, value)
            following = words[i + 1] if taken and i + 1 < len(words) else None
            if chdirs is not None and chdir_option(wrapper, value):
                chdirs.append(chdir_value(wrapper, words[i], following))
            output = time_output(words[i], following) if wrapper == "time" and writes is not None else None
            if output is not None:
                writes.append((output, True))  # GNU time writes its report to -o's file
            i += 1 + taken
        elif operand is not None and operand[1].fullmatch(value):
            if operand[0] == "flock":
                locked = True
                if writes is not None and i + 1 < len(words):
                    # flock creates its lock file (a lone number with no command after it is a descriptor), and
                    # leaves its content alone.
                    writes.append((words[i], False))
            operand = None
            i += 1
        elif re.match(r"[A-Za-z_]\w*=", value) or value in RESERVED:
            i += 1
        elif name in SCRIPT_RUNNERS:
            return script_runner_words(name, words[i + 1:], chdirs, writes)
        elif name in WRAPPERS:
            wrapper = name
            operand = (name, WRAPPER_OPERANDS[name]) if name in WRAPPER_OPERANDS else None
            i += 1
        else:
            break
    return words[i:]


def literal_word(text):
    word = Word()
    word.value = text
    return word


def shell_words(line):
    """`sh -c` and the command line in the list line (none when it is missing), standing for a wrapper that runs the
    line with a shell."""
    return [literal_word("sh"), literal_word("-c")] + list(line)


def script_runner_words(name, args, chdirs, writes):
    """The words a script, su or runuser with the arguments args stands for: `sh -c <line>` and, for su, the operands
    after the user, which go to the shell; just `sh` and those operands when no line is given, since that shell reads
    its script from stdin (script passes its own stdin through), which a pipeline or here-string can supply. Appends
    script's typescript and log files to writes, as (word, True) pairs, and a None to chdirs for su's login shell,
    which starts in the user's home directory."""
    files, options = split_options(args, *SCRIPT_RUNNERS[name], OPTIONAL_VALUE_LETTERS.get(name, ""))
    given = {option for option, _ in options}
    line = [value for option, value in options
            if option in ("-c", "--command", "--session-command") and value is not None][-1:]
    shell = shell_words(line) if line else [literal_word("sh")]
    if name == "script":
        if writes is not None:
            logs = [value for option, value in options if option in ("-I", "-O", "-B", "-T", "--log-in",
                                                                      "--log-out", "--log-io", "--log-timing")]
            if not files and not given & {"-I", "-O", "-B", "--log-in", "--log-out", "--log-io"}:
                files = [literal_word("typescript")]  # script's default log, in the current directory
            writes += [(value, True) for value in logs + files[:1] if value is not None]
        return shell
    login = bool(files) and files[0].value == "-"
    if login or given & {"-l", "--login"}:
        if chdirs is not None:
            chdirs.append(None)
        files = files[1:] if login else files
    if given & {"-u", "--user"}:
        # runuser -u USER COMMAND runs it directly, and without one a shell
        return shell + files if line else files or shell
    return shell + files[1:]  # the operands after the user go to the shell


def split_string(words, i):
    """The words after env's -S at words[i], its command line split the way a shell splits it."""
    match = ENV_SPLIT_FLAG.fullmatch(words[i].value)
    rest = words[i + 1:]
    line = match.group(1) or match.group(2) or (rest.pop(0).value if rest else "")
    try:
        return [token for kind, token in tokenize(line) if kind == "word"] + rest
    except ValueError:
        return rest


# The wrapper options that change the directory the command runs in: a short letter and a long name, which getopt
# also takes abbreviated (`env --ch DIR`).
CHDIR_OPTIONS = {"env": ("C", "--chdir"), "sudo": ("D", "--chdir")}


def chdir_option(wrapper, option):
    """Whether the wrapper's option word changes the directory: its short letter first among the group's letters that
    take a value, or its long name, abbreviated or not, alone or with `=`."""
    if wrapper not in CHDIR_OPTIONS:
        return False
    letter, long = CHDIR_OPTIONS[wrapper]
    if option.startswith("--"):
        name = option.partition("=")[0]
        return len(name) > 2 and long.startswith(name)
    end = value_letter(option, WRAPPER_VALUE_OPTIONS[wrapper][0], OPTIONAL_VALUE_LETTERS.get(wrapper, ""))
    return end is not None and option[end] == letter


def chdir_value(wrapper, word, following):
    """The directory a chdir option word (see chdir_option) names: attached, or the following word."""
    letter, _ = CHDIR_OPTIONS[wrapper]
    option = word.value
    if option.startswith("--"):
        _, eq, attached = option.partition("=")
        return derived(word, attached) if eq else following
    rest = option[option.index(letter) + 1:]
    return derived(word, rest) if rest else following


def long_name(wrapper, option):
    """The long option an option word names, without its `=value`: the one it abbreviates when the wrapper's long
    options are known (WRAPPER_LONG_OPTIONS) and it is a prefix of exactly one, else as written."""
    name = option.partition("=")[0]
    matches = [full for full in WRAPPER_LONG_OPTIONS.get(wrapper, ()) if full.startswith(name)]
    return matches[0] if len(matches) == 1 and len(name) > 2 else name


def time_output(word, following):
    """The file GNU time's option word writes its report to (-o or --output, abbreviated or not): attached, or the
    following word; None for any other option."""
    option = word.value
    if option.startswith("--"):
        if long_name("time", option) != "--output":
            return None
        _, eq, attached = option.partition("=")
        return derived(word, attached) if eq else following
    end = value_letter(option, WRAPPER_VALUE_OPTIONS["time"][0])
    if end is None or option[end] == "f":
        return None
    return derived(word, option[end + 1:]) if option[end + 1:] else following


def takes_value(wrapper, option):
    """Whether the wrapper's option word leaves its value to the next word."""
    short, long = WRAPPER_VALUE_OPTIONS.get(wrapper, ("", set()))
    if option.startswith("--"):
        return "=" not in option and (long_name(wrapper, option) in long or chdir_option(wrapper, option))
    end = value_letter(option, short, OPTIONAL_VALUE_LETTERS.get(wrapper, ""))
    return end == len(option) - 1 and option[end] in short


def absolute(text, cwd):
    """The normalised absolute path of text, or None when it is relative and cwd is unknown."""
    path = os.path.expanduser(text)
    if not os.path.isabs(path):
        if cwd is None:
            return None
        path = os.path.join(cwd, path)
    return os.path.normpath(path)


def operands(words):
    return [w for w in words if not w.value.startswith("-") or w.value == "-"]


class Findings:
    def __init__(self, start_cwd):
        self.start_cwd = start_cwd
        self.edits = []  # (absolute path, cwd whose repository it is checked against, whether every file under it)
        self.kills = []  # (command name, pattern)
        self.signals = []  # (kill operand, the process it names)
        self.xargs_signals = []  # kill, pkill, pgrep or killall run by xargs in a Triphammer session
        self.persistence_paths = []  # (absolute path written, linked or removed, whether every file under it)
        self.units = []  # systemctl --user invocations that change Triphammer's units, as their text
        self.written = set()  # every path written, linked or removed, as its spellings (see spellings)
        self.sourced = []  # (description, spellings) of each file a source, . or shell runs as its script
        self.unreadable = []  # text the command runs that the hook cannot read, as its description
        self.git_settings = []  # git settings that make git run a command, as their description
        self.schedules = []  # crontab, at, batch and systemd-run invocations, as their text
        # For the worktree-only rule: (absolute path, whether every file under it, whether its content changes) of
        # each path written, linked or removed, the sources of hard links, and the targets it cannot work out.
        self.session_paths = []
        self.link_sources = []
        self.unresolved = []
        self.symlink_targets = []  # the absolute path each symbolic link the command makes leads to
        self.copied = []  # the destinations of cp, mv and rsync, which may land symlinks the hook cannot see yet
        self.assigned = set()  # the SESSION_VARIABLES the command itself may set, whose value the hook cannot know
        self.cdpath = False  # whether $CDPATH (or cdable_vars) may move a relative cd somewhere else
        self.git_redirected = False  # whether the command sets $GIT_DIR, $GIT_WORK_TREE or $GIT_COMMON_DIR
        self.cwd_lost = False  # whether code the hook does not see may move the shell at any point from here on

    def session_path(self, text, dynamic, cwd, base=None):
        """The absolute path a target names, for the worktree-only rule, joined to cwd (or base) as written, `..`
        and symlinks left for physical to resolve; or None when the hook cannot work it out: a part computed at run
        time other than a leading SESSION_VARIABLES the command does not set, ~+ or ~- (bash's $PWD and $OLDPWD), or
        a relative path after a cd it cannot follow."""
        if dynamic:
            text = expand_variables(text, cwd, self.assigned)
            if re.search(r"[$`]", text):
                return None
        if re.match(r"~[+-]", text):
            return None
        text = os.path.expanduser(text)
        if os.path.isabs(text):
            return text
        if self.start_cwd is None:
            return ""  # no cwd in the hook's input: malformed, so it allows the command
        base = cwd if base is None else base
        return None if base is None else os.path.join(base, text)

    def chdir(self, word, cwd):
        """The directory a chdir to word (env -C, sudo -D, git -C) leaves the command in, for the worktree-only rule,
        `..` and symlinks left for physical to resolve as the kernel does; None, so that a relative target after it
        is refused, when the hook cannot work it out (a missing value, a glob or brace expansion, a part computed at
        run time)."""
        if word is None or word.glob or word.expands:
            return None
        return self.session_path(word.value, word.dynamic, cwd) or None

    def symlink(self, word, directory, cwd):
        """A symbolic link whose text is word, made in directory (a word): where writes through it lead."""
        place = self.session_path(directory.value, directory.dynamic, cwd)
        target = place and self.session_path(word.value, word.dynamic, cwd, place)
        if place is None or target is None or word.glob or word.expands or directory.glob or directory.expands:
            self.unresolved.append(f"the target {word.value} of a symbolic link")
        elif target:
            self.symlink_targets.append(target)

    def hard_link(self, word, cwd, source=True):
        """The file a hard link (ln without -s, cp -l, link, rsync --link-dest) shares with its new name, or without
        source the new name of `link`, which only the worktree-only rule judges."""
        path = self.session_path(word.value, word.dynamic, cwd)
        if path is None or word.glob or word.expands:
            self.unresolved.append(word.value)
        elif path and source:
            self.link_sources.append((path, is_directory(word, cwd)))
        elif path:
            self.session_paths.append((path, False, False))

    def edit(self, word_or_text, cwd, tree=False):
        """An edit of the path, or with tree of every file under it."""
        self.change(word_or_text, cwd, tree)
        if isinstance(word_or_text, Word):
            if word_or_text.dynamic:
                return
            text, globbed = word_or_text.value, word_or_text.glob
        else:
            text, globbed = word_or_text, False
        path = absolute(text, cwd)
        if path is None:
            return
        for match in (glob.glob(path) or [path]) if globbed else [path]:
            self.edits.append((match, cwd or self.start_cwd, tree))

    def runs(self, name, word, cwd):
        """A source, . or shell (name) running the file word names as its script."""
        self.sourced.append((f"`{name} {word.value}`", spellings(word.value, word.dynamic, cwd)))

    def change(self, word_or_text, cwd, tree=False, content=True):
        """A write, link or removal of the path (or with tree of every file under it; content is False for a removal,
        which leaves the file's other names alone), which the persistence rule judges. A word whose value is
        computed at run time counts there by its literal part before the first $ or `."""
        check_deadline()
        word = word_or_text if isinstance(word_or_text, Word) else derived(Word(), word_or_text)
        text, dynamic, globbed = word.value, word.dynamic, word.glob
        self.written |= spellings(text, dynamic, cwd)
        if triphammer_sessions():
            self.session_change(word, cwd, tree, content)
        if dynamic:
            text = expand_variables(text)
            cut = re.search(r"[$`]", text)
            if cut:
                text = os.path.dirname(text[:cut.start()] + "x")  # the directory its literal part ends in
                if not text:
                    return
        path = absolute(text, cwd)
        if path is not None:
            for match in [path] + (glob.glob(path) if globbed else []):
                self.persistence_paths.append((match, tree))


    def session_change(self, word, cwd, tree, content):
        """The paths a write, link or removal of word reaches, for the worktree-only rule: each word its brace
        expansion makes (of a word with no quote and nothing computed at run time; any other is not worked out),
        and for a glob every existing path it may match as well as the word itself."""
        texts = [word.value]
        if word.expands:
            texts = None if word.quoted or word.dynamic or word.extglob else brace_expand(word.value)
            if texts is None or any(text.startswith("-") for text in texts):
                self.unresolved.append(word.value)
                return
        for text in texts:
            check_deadline()
            session = self.session_path(text, word.dynamic, cwd)
            if session is None:
                self.unresolved.append(text)
                continue
            matches = [session] if session else []
            if session and word.glob and re.search(r"[*?\[]", text):
                found = glob_candidates(session)
                start = len(session) - len(text)  # where a relative path's own part starts
                if found is None or text[:1] in ("*", "?", "[") and any(m[start:].startswith("-") for m in found):
                    self.unresolved.append(text)  # ** or too many matches, or one bash would pass on as an option
                    continue
                matches += found
            self.session_paths += [(match, tree, content) for match in matches]


BRACE_SEQUENCE = re.compile(r"(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?|([A-Za-z])\.\.([A-Za-z])(?:\.\.(-?\d+))?")


def brace_expand(text):
    """The words bash's brace expansion makes of an unquoted word ({a,b}, {1..3}, {a..c}, nested), or None past
    GLOB_LIMIT words."""
    i = 0
    while True:
        check_deadline()
        start = next((j for j in range(i, len(text)) if text[j] == "{" and text[j - 1:j] != "$"), None)
        if start is None:
            return [text]
        depth, commas, end = 0, [], None
        for j in range(start, len(text)):
            if text[j] == "{":
                depth += 1
            elif text[j] == "}":
                depth -= 1
                if depth == 0:
                    end = j
                    break
            elif text[j] == "," and depth == 1:
                commas.append(j)
        if end is None:
            return [text]
        inner, sequence = text[start + 1:end], None
        if commas:
            bounds = [start] + commas + [end]
            parts = [text[a + 1:b] for a, b in zip(bounds, bounds[1:])]
        elif (sequence := BRACE_SEQUENCE.fullmatch(inner)) is not None:
            parts = brace_sequence(sequence)
        else:
            i = start + 1
            continue
        if parts is None or len(parts) > GLOB_LIMIT:
            return None
        words = []
        for part in parts:
            expanded = brace_expand(text[:start] + part + text[end + 1:])
            if expanded is None or len(words) + len(expanded) > GLOB_LIMIT:
                return None
            words += expanded
        return words


def brace_sequence(match):
    """The words of a {from..to[..step]} sequence, or None for one longer than GLOB_LIMIT."""
    numeric = match.group(1) is not None
    start, end, by = match.groups()[:3] if numeric else match.groups()[3:]
    value = int if numeric else ord
    first, last, step = value(start), value(end), abs(int(by or 1)) or 1
    if abs(last - first) // step >= GLOB_LIMIT:
        return None
    values = range(first, last + (1 if last >= first else -1), step if last >= first else -step)
    if not numeric:
        return [chr(v) for v in values]
    width = max(len(start), len(end)) if re.match(r"-?0\d", start) or re.match(r"-?0\d", end) else 0
    return [str(v).zfill(width) if width else str(v) for v in values]


class ChangesOnly:
    """Findings for the copy helpers whose edits count only as persistence changes: an ln that creates a link without
    replacing a file."""
    def __init__(self, findings):
        self.findings = findings

    def edit(self, word_or_text, cwd, tree=False):
        self.findings.change(word_or_text, cwd, tree, content=False)


def spellings(text, dynamic, cwd):
    """The ways the path text can be matched against another word naming the same file: its text, with a leading
    variable expanded, and its absolute path when nothing in it is left to compute at run time."""
    found = {text}
    if dynamic:
        text = expand_variables(text)
        found.add(text)
        if re.search(r"[$`]", text):
            return found
    path = absolute(text, cwd)
    return found | ({path} if path is not None else set())


def shell_file(args):
    """The script file a shell runs (`bash s.sh`, `sh -e -- ./s.sh`), or None when it runs -c text or stdin (-s)."""
    words = iter(args)
    pending = 0
    for w in words:
        v = w.value
        if pending:
            pending -= 1
        elif v == "--":
            return next(words, None)
        elif v in ("--rcfile", "--init-file"):
            pending = 1
        elif v.startswith("--"):
            continue
        elif SHELL_OPTION_GROUP.fullmatch(v):
            if v[0] == "-" and re.search(r"[cs]", v):
                return None
            pending = v.count("o") + v.count("O")
        else:
            return w
    return None


def expand_variables(text, cwd=None, assigned=None):
    """text with a leading $HOME, ${HOME} or another of PATH_VARIABLES replaced by its value, when it is set. With
    assigned (the worktree-only rule), SESSION_VARIABLES instead, $PWD as cwd, and none the command itself may set."""
    match = re.match(r"\$(?:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)\})(?=/|$)", text)
    name = match and (match.group(1) or match.group(2))
    if assigned is None:
        value = os.environ.get(name) if name in PATH_VARIABLES else None
    elif name in assigned or name not in SESSION_VARIABLES:
        value = None
    else:
        value = cwd if name == "PWD" else os.environ.get(name)
    return value + text[match.end():] if value else text


def assigned_variables(cmd):
    """The SESSION_VARIABLES the command text may set (`TMPDIR=x`, `export PWD`, `read HOME`, `${TMPDIR:=x}`): every
    name it mentions other than as a plain $NAME or ${NAME}."""
    return {name for name in SESSION_VARIABLES
            if re.search(rf"(?<![\w$]){name}(?!\w)(?<!\$\{{{name})|\${{{name}[^}}]", cmd)}


def script_targets(body):
    """The paths a python or node script writes, as literals or plain variables bound to one; reads are not edits."""
    def literal(text):
        text = text.lstrip("rRbBuU")
        return text[1:-1] if len(text) >= 2 and text[0] in "'\"`" and text[-1] == text[0] else None

    bindings = {}
    for match in SCRIPT_BINDING.finditer(body):
        value = literal(match.group(2))
        if value is not None:
            bindings.setdefault(match.group(1), []).append(value)
    targets = []
    for pattern in SCRIPT_WRITES:
        for match in pattern.finditer(body):
            ref = match.group(1)
            value = literal(ref)
            targets += [value] if value is not None else bindings.get(ref, [])
    return [text for text in targets if re.fullmatch(r"[\w./~-]+", text)]


def resolve_cd(words, cwd, findings=None):
    args = operands(words[1:])
    if len(args) != 1 or args[0].value == "-":
        return None
    if findings is not None and triphammer_sessions():
        return session_cd(words, args[0], cwd, findings)
    text = expand_variables(args[0].value) if args[0].dynamic else args[0].value
    return None if args[0].dynamic and re.search(r"[$`]", text) else absolute(text, cwd)


def session_cd(words, arg, cwd, findings):
    """The directory a cd or pushd to arg leaves the shell in, for the worktree-only rule, or None when the hook
    cannot tell: a target it cannot work out, a glob or a brace expansion, a relative name $CDPATH may find
    elsewhere, pushd -n or +N, or a `..` after a symlink, where bash's logical directory (or the physical one it
    falls back to, or that cd -P and set -P take) is not the same place."""
    options = "".join(w.value[1:] for w in words[1:] if re.fullmatch(r"-[A-Za-z@]+", w.value))
    if arg.glob or arg.expands or words[0].value == "pushd" and ("n" in options or re.fullmatch(r"\+\d+", arg.value)):
        return None
    text = findings.session_path(arg.value, arg.dynamic, cwd)
    if not text:
        return None
    if not re.match(r"[/~$]|\.\.?(?:/|$)", arg.value) and findings.cdpath:
        return None  # bash looks a name up in $CDPATH unless it starts with /, ./ or ../
    real = physical(text)
    if "P" in options and "L" not in options:
        return real
    logical = os.path.normpath(text)
    return logical if real is not None and physical(logical) == real and "P" not in options else None


# Wrappers and script runners that run a command in another process, where a cd does not move the shell: every
# one strip_prefix drops but the three that run it in this shell.
FOREIGN_WRAPPERS = (WRAPPERS | set(SCRIPT_RUNNERS)) - {"command", "builtin", "time"} | {"coproc"}


def runs_elsewhere(whole, words):
    """Whether the words strip_prefix dropped from whole before words name a wrapper or script runner that runs the
    command in another process (`env cd`, `runuser -u USER cd`, `nohup eval 'cd x'`)."""
    return bool({os.path.basename(w.value) for w in prefix_of(whole, words)} & FOREIGN_WRAPPERS)


# What analyze returns for a command that leaves the shell's directory as it was.
SAME_CWD = object()


def eval_script(args):
    """The text eval runs: its arguments joined by spaces, or None when one is computed at run time."""
    if args and args[0].value == "--":
        args = args[1:]
    return None if any(w.dynamic for w in args) else " ".join(w.value for w in args)


def prefix_of(whole, words):
    """The words of whole before words[0], the command name strip_prefix found: assignments and wrappers. All of whole
    when it names no command, or when env -S split the words so the name is not one of them."""
    return whole[:next((i for i, w in enumerate(whole) if words and w is words[0]), len(whole))]


def analyze(command, cwd, findings, depth):
    """Judges one command; returns the directory it leaves the shell in (an eval that runs cd), else SAME_CWD."""
    chdirs, wrapper_writes = [], []
    words = strip_prefix(command.words, chdirs, wrapper_writes)
    for target in command.write_targets:
        findings.edit(target, cwd)  # the shell opens a redirection before a wrapper changes the directory
    if triphammer_sessions():
        for directory in chdirs:
            cwd = findings.chdir(directory, cwd)
        if chdirs and command.substituted:
            # `env -C $(...) touch x`: the words after the substitution read as another command, which the
            # directory moves too, so the hook loses track of the directory from here on.
            findings.cwd_lost = True
    for target, content in wrapper_writes:
        if content:
            findings.edit(target, cwd)
        else:
            findings.change(target, cwd, content=False)
    assignments = prefix_of(command.words, words)
    if words and os.path.basename(words[0].value) in EXPORTERS:
        assignments = assignments + words[1:]
    git_environment(assignments, findings)
    if not words:
        return SAME_CWD
    name, args = os.path.basename(words[0].value), words[1:]
    values = [w.value for w in args]

    def scripts(script_of):
        """The pipeline's stdin texts plus each script an option word names; script_of(word, the words after it)
        returns it or None."""
        found = [script_of(v, values[j + 1:]) for j, v in enumerate(values)]
        return command.pipeline_input + [script for script in found if script is not None]

    def python_script(word, later):
        match = PYTHON_SCRIPT_FLAG.fullmatch(word)
        return None if match is None else match.group(1) or next(iter(later), None)

    def node_script(word, later):
        return next(iter(later), None) if word in ("-e", "--eval", "-p", "--print") else None

    def shell_script(word, later):
        """The first operand after the -c group (`bash -c -l 'script'`), past options and their values."""
        if not SHELL_SCRIPT_FLAG.fullmatch(word):
            return None
        later = iter(later)
        pending = word.count("o") + word.count("O")  # each o or O takes the next word as its value
        for v in later:
            if pending:
                pending -= 1
            elif v == "--":
                return next(later, None)
            elif SHELL_OPTION_GROUP.fullmatch(v):
                pending = v.count("o") + v.count("O")
            elif not re.match(r"[-+].", v):
                return v
        return None

    in_place = in_place_edit(name, values)
    if command.substituted and (in_place or name in SUBSTITUTION_WRITERS):
        findings.unresolved.append(f"the operands of `{name}` beside a command substitution")
    if triphammer_sessions() and (in_place or name in SUBSTITUTION_WRITERS):
        # Brace expansion and extglob turn a word into other words, which moves the words after it into other roles,
        # except among the file operands of a writer that changes each of them (each judged as its expansion); a
        # glob as the last operand of a writer that reads it as the destination may expand into several or none.
        targets = (operands(args) if name == "tee"
                   else split_options(args, "sr", {"--size", "--reference"})[0] if name == "truncate"
                   else path_changer_files(name, args)[0] if name in PATH_CHANGERS and not in_place else [])
        if any(w.expands and not any(w is t for t in targets) for w in args):
            findings.unresolved.append(f"the operands of `{name}` with brace expansion or an extglob pattern")
        last = next((w for w in reversed(args) if not w.value.startswith("-")), None)
        if (name in ("cp", "mv", "ln", "install", "link", "rsync") and last is not None and last.glob
                and not any(re.match(r"-[^-]*t|--target-directory", v) for v in values)):
            findings.unresolved.append(f"the destination {last.value} of `{name}`, a glob that may expand to "
                                       f"several words or none")
    if name == "tee":
        for w in operands(args):
            findings.edit(w, cwd)
    elif in_place:
        # The script is the first operand unless an -e (or sed's -f) gives it, so it names no file.
        given = {"-e", "-E"} if name == "perl" else {"-e", "--expression", "-f", "--file"}
        files, options = (split_options(args, "eEI", set()) if name == "perl"
                          else split_options(args, "efl", {"--expression", "--file", "--line-length"}))
        scripted = {option for option, _ in options} & given
        for w in files if scripted else files[1:]:
            findings.edit(w, cwd)
    elif name in COPY_OPTIONS or name == "rsync":
        before = len(findings.session_paths)
        (analyze_rsync(args, cwd, findings) if name == "rsync" else analyze_copy(name, args, cwd, findings))
        if name != "ln":  # cp -a, -P or -R, mv and rsync -a may land symlinks the hook cannot see before they run
            findings.copied += [path for path, _, _ in findings.session_paths[before:]]
    elif name == "dd":
        for w in args:
            if w.value.startswith("of="):
                findings.edit(derived(w, w.value[3:]), cwd)
    elif name == "truncate":
        for w in split_options(args, "sr", {"--size", "--reference"})[0]:
            findings.edit(w, cwd)
    elif name in PATH_CHANGERS:
        files, tree = path_changer_files(name, args)
        for w in files:
            findings.change(w, cwd, tree, content=name not in REMOVERS)
    elif name == "link":  # link FILE NEWNAME: a hard link
        if len(args) == 2:
            findings.hard_link(args[0], cwd)
            findings.hard_link(args[1], cwd, source=False)
    elif name == "xargs":
        analyze_xargs(command, args, cwd, findings, depth)
    elif name == "systemctl":
        analyze_systemctl(args, findings)
    elif name == "git":
        analyze_git(args, cwd, findings)
    elif name in SCHEDULERS and not (name == "crontab" and "-l" in values and not {"-e", "-r", "-i"} & set(values)):
        findings.schedules.append(f"`{' '.join([name] + values)}`")
    elif name in ("pkill", "pgrep"):
        analyze_kill(name, args, findings)
    elif name == "kill":
        analyze_signal(args, findings)
    elif PYTHON.match(name) or name in ("node", "nodejs"):
        for script in scripts(python_script if PYTHON.match(name) else node_script):
            for text in script_targets(script):
                findings.edit(text, cwd)
    elif name in SHELLS:
        if depth < MAX_DEPTH:
            for script in scripts(shell_script):
                walk(script, cwd, findings, depth + 1)
        file = shell_file(args)
        if file is not None:
            findings.runs(name, file, cwd)
    elif name == "eval":
        script = eval_script(args)
        if script is None or depth >= MAX_DEPTH:
            findings.unreadable.append(f"`eval {' '.join(values)}`, whose text is computed when it runs")
        elif script:
            after = walk(script, cwd, findings, depth + 1)
            if not (triphammer_sessions() and runs_elsewhere(command.words, words)):
                return after  # eval runs in this shell, so its cd counts
            if after != cwd:
                return None  # `nohup eval 'cd x'`: another process, so where the shell is is not known
    elif name in ("source", "."):
        files = [w for w in args if w.value != "--"]
        if files:
            findings.runs(name, files[0], cwd)
    return SAME_CWD


def in_place_edit(name, values):
    """Whether sed or perl with the argument values edits its files in place."""
    return (name in ("sed", "gsed") and any(re.match(r"-[nErsuz]*i|--in-place", v) for v in values)
            or name == "perl" and any(re.match(r"-(?![MmIeEx])\w*i", v) for v in values))


def analyze_xargs(command, args, cwd, findings, depth):
    """xargs runs the command after its options (echo when none) with words read from its input appended, or put in
    place of -I's string: the command is judged as written, and in a Triphammer session a writer the worktree-only
    rule reads, sed or perl (whose -i the input can add), a shell, eval, source or an interpreter's inline script, git
    config or git remote (or git with no subcommand, or -I's string up to its subcommand), a wrapper whose file operand (flock's lock file, script's typescript, time's -o file) the input can give, xargs
    itself, kill, pkill, pgrep or killall, or a command the input gives after the written wrappers, is refused, since the hook cannot read the operands xargs
    gives it."""
    i, replace, unknown = 0, None, []
    short, optional, long = XARGS_VALUE_OPTIONS
    while i < len(args):
        v = args[i].value
        if v == "--":
            i += 1
            break
        if not v.startswith("-") or v == "-":
            break
        if v.startswith("--"):
            name, eq, attached = v.partition("=")
            if name == "--replace":
                replace = attached if eq else "{}"
            elif name not in XARGS_LONG_OPTIONS:
                unknown.append(name)
            i += 1 + (v in long)
        else:
            # The first letter that takes a value ends the group: the rest of the word is its value, and only a letter
            # in short that ends the word takes the next word instead.
            letter = value_letter(v, short, optional)
            taken = letter == len(v) - 1 and v[letter] in short
            if letter is not None and v[letter] == "I":
                replace = args[i + 1].value if taken and i + 1 < len(args) else v[letter + 1:] or None
            elif letter is not None and v[letter] == "i":
                replace = v[letter + 1:] or "{}"
            i += 1 + taken
    inner = Command()
    inner.words, inner.pipeline_input, inner.substituted = args[i:], command.pipeline_input, command.substituted
    analyze(inner, cwd, findings, depth)
    if not triphammer_sessions():
        return
    if unknown:
        # An abbreviation (--max-a, --delim) may take the next word as its value, so the command may start later.
        findings.unresolved.append(f"the command xargs runs after `{unknown[0]}`, which may abbreviate an option "
                                   f"that takes the next word")
        return
    if not inner.words:
        return  # xargs runs echo
    # A word standing for the first one xargs appends from its input. When the wrappers take it (as an option's value
    # or their operand) or it is the command, the input gives the command after them, and with it any further wrapper,
    # option or file, however many words that takes: refused, as a command -I's string stands for is.
    writes = []
    words = strip_prefix(inner.words + [literal_word(XARGS_INPUT)], writes=writes)
    for target, _ in writes:
        if XARGS_INPUT in target.value or replace and replace in target.value:
            findings.unresolved.append("the file a wrapper writes, which the input of xargs can give")
    if not words or words[0].value == XARGS_INPUT or replace and replace in words[0].value:
        findings.unresolved.append("the command xargs runs, which its input can give")
        return
    words = [w for w in words if w.value != XARGS_INPUT]
    name = os.path.basename(words[0].value)
    if name == "xargs":
        # GNU xargs gives its command /dev/null as stdin, so an inner xargs with no written command runs the words the
        # outer one appends as its command.
        findings.unresolved.append("the command a nested xargs runs, which the input of the outer one can give")
    elif name in XARGS_SIGNALLERS:
        # The self-kill rule judges these by their operands, which the input gives.
        findings.xargs_signals.append(name)
    elif name in ("sed", "gsed", "perl") or name in SUBSTITUTION_WRITERS:
        # GNU sed and perl read -i after the script too, and the input can give it (or -I's string stand for it).
        findings.unresolved.append(f"the operands `{name}` gets from the input of xargs")
    elif name in SHELLS or name in ("eval", "source", ".") or inline_script(name, [w.value for w in words[1:]]):
        # xargs also puts its input in place of -I's string inside the script, which the hook read as written.
        findings.unresolved.append(f"the script `{name}` runs with words from the input of xargs")
    elif name == "git" and (git_subcommand(words[1:]) in (None, "config", "remote") or replace and any(
            replace in w.value for w in git_prefix(inner.words, words))):
        # The input's words turn a read (git config KEY, git remote) into a write, or name the subcommand itself; -I's
        # string can also stand for the subcommand, a -c value or an environment assignment before git.
        findings.git_settings.append(f"`{' '.join(w.value for w in words)}` with words from the input of xargs, "
                                     f"which can write git configuration")


def git_subcommand(args):
    """The subcommand after git's own options, or None when there is none."""
    i = git_subcommand_index(args)
    return None if i is None else args[i].value


def git_subcommand_index(args):
    """The index of the subcommand after git's own options, or None when there is none."""
    i = 0
    while i < len(args):
        v = args[i].value
        if v in GIT_VALUE_OPTIONS:
            i += 2
        elif v.startswith("-"):
            i += 1
        else:
            return i
    return None


def git_prefix(written, words):
    """The words of a command xargs runs up to and including git's subcommand: the written words strip_prefix dropped
    (wrappers, their options and variable assignments), then git and its own options. words is what strip_prefix left,
    starting with git."""
    sub = git_subcommand_index(words[1:])
    kept = {id(w) for w in words}
    return [w for w in written if id(w) not in kept] + words[:len(words) if sub is None else sub + 2]


def inline_script(name, values):
    """Whether python or node with the argument values runs a script given on its command line."""
    return (PYTHON.match(name) is not None and any(PYTHON_SCRIPT_FLAG.fullmatch(v) for v in values)
            or name in ("node", "nodejs") and any(v in ("-e", "--eval", "-p", "--print") for v in values))


def path_changer_files(name, args):
    """The file operands of rm, mkdir, touch, chmod and the like, and whether a recursive option reaches every file
    under them."""
    files, options = split_options(args, *PATH_CHANGERS[name])
    tree = any(option in RECURSIVE for option, _ in options)
    if files and "--reference" not in {option for option, _ in options} and (
            name in ("chown", "chgrp") or name == "chmod" and CHMOD_MODE.fullmatch(files[0].value)):
        files = files[1:]  # the owner, group or mode
    return files, tree


def derived(word, text):
    """A word holding part of another word's text, such as the value of `--name=value` or `of=path`."""
    part = Word()
    part.value, part.dynamic, part.glob, part.quoted = text, word.dynamic, word.glob, word.quoted
    part.expands, part.extglob = word.expands, word.extglob
    return part


def value_letter(group, short_values, optional_values=""):
    """The index in a short-option group word (`-qtc`) of its first letter that takes a value, which ends the group:
    one in short_values (the rest of the group, or else the next word) or in optional_values (only the rest of the
    group, possibly empty). None when no letter does."""
    return next((j for j, c in enumerate(group[1:], 1) if c in short_values or c in optional_values), None)


def split_options(args, short_values, long_values, optional_values=""):
    """The operand words and the (option, value word or None) pairs of a GNU-style argument list. A short letter in
    short_values takes the rest of its group or the next word, one in optional_values only the rest of its group; a
    long name in long_values takes the next word unless its value is attached with `=`."""
    files, options, i, ended = [], [], 0, False
    while i < len(args):
        w, i = args[i], i + 1
        v = w.value
        if ended or not v.startswith("-") or v == "-":
            files.append(w)
        elif v == "--":
            ended = True
        elif v.startswith("--"):
            name, eq, attached = v.partition("=")
            if eq:
                options.append((name, derived(w, attached)))
            elif name in long_values and i < len(args):
                options.append((name, args[i]))
                i += 1
            else:
                options.append((name, None))
        else:
            end = value_letter(v, short_values, optional_values)
            options += [("-" + letter, None) for letter in v[1:end]]
            if end is not None:
                rest, value = v[end + 1:], None
                if rest:
                    value = derived(w, rest)
                elif v[end] in short_values and i < len(args):
                    value, i = args[i], i + 1
                options.append(("-" + v[end], value))
    return files, options


# cp, mv, install and ln (when it replaces): the short letters and long names that take a value, so no operand.
COPY_OPTIONS = {
    "cp": ("St", {"--suffix", "--target-directory", "--no-preserve", "--sparse"}),
    "mv": ("St", {"--suffix", "--target-directory"}),
    "ln": ("St", {"--suffix", "--target-directory"}),
    "install": ("gmoSt", {"--group", "--mode", "--owner", "--suffix", "--target-directory", "--strip-program"}),
}
# The ln options that replace an existing destination: -f, and the backup ones, which move it aside first.
LN_REPLACING = {"-f", "--force", "-b", "--backup", "-S", "--suffix"}
# rsync's short letters and long names that take a value.
RSYNC_VALUE_OPTIONS = ("BefMT@", {
    "--rsh", "--filter", "--exclude", "--include", "--exclude-from", "--include-from", "--files-from",
    "--block-size", "--remote-option", "--temp-dir", "--rsync-path", "--log-file", "--log-file-format",
    "--out-format", "--chmod", "--chown", "--usermap", "--groupmap", "--partial-dir", "--backup-dir", "--suffix",
    "--compare-dest", "--copy-dest", "--link-dest", "--max-size", "--min-size", "--max-delete", "--bwlimit",
    "--timeout", "--contimeout", "--port", "--sockopts", "--password-file", "--modify-window", "--compress-choice",
    "--compress-level", "--checksum-choice", "--iconv", "--write-batch", "--only-write-batch", "--read-batch",
    "--info", "--debug", "--stop-after", "--stop-at", "--outbuf", "--address", "--skip-compress", "--max-alloc"})


def is_directory(word, cwd):
    """Whether the word names an existing directory, resolved against cwd when relative."""
    return not word.dynamic and os.path.isdir(os.path.join(cwd or "/", os.path.expanduser(word.value)))


def copy_into(sources, dest, cwd, findings, as_file=False, slash_contents=False):
    """A copy of sources onto dest: dest itself when it is a file (or as_file), else each source's name inside it.
    With as_file, a source directory lands its files under dest, so every file under dest counts."""
    if as_file or not is_directory(dest, cwd):
        findings.edit(dest, cwd, tree=any(is_directory(source, cwd) for source in sources))
    else:
        into(sources, dest, cwd, findings, slash_contents)


def into(sources, directory, cwd, findings, slash_contents=False):
    """Each source's name inside directory, where a copy or move of it lands. A source named . or .. (dir/.), or
    with slash_contents (rsync) one ending in /, copies its contents, so every file under where it lands counts; a
    source that is a directory lands as one, so every file under its name inside directory counts."""
    if directory.dynamic:
        return
    for source in sources:
        if source.dynamic:
            continue
        name = os.path.basename(source.value.rstrip("/"))
        if name in (".", ".."):
            findings.edit(os.path.join(directory.value, name), cwd, tree=True)
        elif slash_contents and source.value.endswith("/"):
            findings.edit(directory.value, cwd, tree=True)
        else:
            findings.edit(os.path.join(directory.value, name), cwd, tree=is_directory(source, cwd))


def analyze_copy(name, args, cwd, findings):
    files, options = split_options(args, *COPY_OPTIONS[name])
    names = {option for option, _ in options}
    target_dir = next((value for option, value in reversed(options)
                       if option in ("-t", "--target-directory") and value is not None), None)
    sources = files if target_dir is not None or name == "ln" and len(files) == 1 else files[:-1]
    if (name == "ln" and not names & {"-s", "--symbolic"}
            or name == "cp" and names & {"-l", "--link"}):  # a hard link gives the source a second name
        for w in sources:
            findings.hard_link(w, cwd)
    if name == "ln" and names & {"-s", "--symbolic"} or name == "cp" and names & {"-s", "--symbolic-link"}:
        symlinks(name, files, names, target_dir, cwd, findings)
    if name == "ln" and not names & LN_REPLACING:
        findings = ChangesOnly(findings)  # without -f or a backup option, ln refuses to replace an existing file
    if name == "install" and names & {"-d", "--directory"}:
        for w in files:
            findings.change(w, cwd)
        return  # every operand is a directory to create
    if name == "mv":  # a move removes each source from where it was
        for w in sources:
            findings.change(w, cwd, tree=is_directory(w, cwd), content=False)
    if target_dir is not None:
        into(files, target_dir, cwd, findings)
    elif name == "ln" and len(files) == 1:
        copy_into(files, derived(files[0], "."), cwd, findings)  # ln -f TARGET links into the current directory
    elif len(files) >= 2:
        copy_into(files[:-1], files[-1], cwd, findings, names & {"-T", "--no-target-directory"})


def symlinks(name, files, names, target_dir, cwd, findings):
    """The symbolic links ln -s or cp -s makes: each text, relative to the directory the link lands in (or with
    ln -r to the current directory), where writes through the link lead."""
    if target_dir is not None:
        texts, directories = files, [target_dir]
    elif name == "ln" and len(files) == 1:
        texts, directories = files, [derived(Word(), ".")]
    elif len(files) >= 2:
        dest = files[-1]
        texts = files[:-1]
        directories = [derived(dest, os.path.dirname(dest.value.rstrip("/")) or ".")]
        if is_directory(dest, cwd) or os.path.islink(os.path.join(cwd or "/", os.path.expanduser(dest.value))):
            directories.append(dest)  # the link lands inside it (unless -T or -n), so both count
    else:
        return
    if name == "ln" and names & {"-r", "--relative"}:
        directories = [derived(Word(), ".")]
    for text in texts:
        for directory in directories:
            findings.symlink(text, directory, cwd)


def analyze_rsync(args, cwd, findings):
    files, options = split_options(args, *RSYNC_VALUE_OPTIONS)
    names = {option for option, _ in options}
    if len(files) < 2 or names & {"-n", "--dry-run", "--list-only"}:
        return
    dest = files[-1]
    if re.match(r"[^/]*:|rsync://", dest.value):
        return  # a remote destination
    for option, value in options:
        if option == "--link-dest" and value is not None:  # hard links to its files, a path relative to dest
            if not os.path.isabs(os.path.expanduser(value.value)):
                value = derived(dest if dest.dynamic else value, os.path.join(dest.value, value.value))
            findings.hard_link(value, cwd)
    copy_into(files[:-1], dest, cwd, findings, slash_contents=True)


def analyze_systemctl(args, findings):
    """systemctl --user daemon-reload and the like, or a verb that changes a Triphammer unit's state or files."""
    files, options = split_options(args, *SYSTEMCTL_VALUE_OPTIONS)
    if not files or "--user" not in {option for option, _ in options}:
        return
    verb, units = files[0].value, files[1:]
    if verb in SYSTEMCTL_GLOBAL:
        findings.units.append(f"systemctl --user {verb}")
    elif verb in SYSTEMCTL_CHANGING:
        named = [w.value for w in units if triphammer_unit(w)]
        if named:
            findings.units.append(f"systemctl --user {verb} {' '.join(named)}")


def triphammer_unit(word):
    """Whether the word names a Triphammer unit, by name, path, instance computed at run time, or a glob that matches one."""
    name = os.path.basename(word.value)
    if TRIPHAMMER_UNIT.fullmatch(name):
        return True
    # systemctl matches a pattern itself, so a quoted one counts too.
    return (not word.dynamic and bool(re.search(r"[*?[]", name))
            and any(fnmatch.fnmatchcase(sample, name) for sample in TRIPHAMMER_UNIT_SAMPLES))


# Commands that schedule other commands to run later, outside the session.
SCHEDULERS = {"crontab", "at", "batch", "systemd-run"}
# Builtins whose arguments are variable assignments the commands after them inherit.
EXPORTERS = {"export", "declare", "typeset", "local", "readonly"}
# git settings whose value is a command git runs (or a file of settings, or hooks), by section and name: a name of
# None is any name, and a section in GIT_SUBSECTION_COMMANDS needs a subsection (`filter.<driver>.clean`).
GIT_SENDEMAIL_COMMANDS = {("sendemail", name) for name in ("tocmd", "cccmd", "headercmd", "sendmailcmd", "smtpserver")}
GIT_COMMANDS = {("core", "hookspath"), ("core", "fsmonitor"), ("core", "sshcommand"), ("core", "editor"),
                ("core", "pager"), ("core", "askpass"), ("core", "gitproxy"), ("core", "alternaterefscommand"),
                ("sequence", "editor"), ("include", "path"), ("diff", "external"), ("gpg", "program"),
                ("credential", "helper"), ("uploadpack", "packobjectshook"), ("pager", None),
                ("interactive", "difffilter"), ("gc", "recentobjectshook"), ("imap", "tunnel"),
                ("instaweb", "httpd"), ("init", "templatedir"), ("remote", "pushdefault")} | GIT_SENDEMAIL_COMMANDS
GIT_SUBSECTION_COMMANDS = {("credential", "helper"), ("includeif", "path"), ("filter", "clean"), ("filter", "smudge"),
                           ("filter", "process"), ("diff", "textconv"), ("diff", "command"), ("merge", "driver"),
                           ("gpg", "program"), ("gpg", "defaultkeycommand"), ("difftool", "cmd"),
                           ("difftool", "path"), ("mergetool", "cmd"), ("mergetool", "path"), ("remote", "uploadpack"),
                           ("remote", "receivepack"), ("hook", "command"), ("trailer", "cmd"), ("trailer", "command"),
                           ("browser", "cmd"), ("browser", "path"), ("man", "cmd"), ("man", "path"),
                           ("guitool", "cmd"), ("protocol", "allow"), ("remote", "url"), ("remote", "pushurl"),
                           ("url", "insteadof"), ("url", "pushinsteadof"), ("remote", "fetch"), ("remote", "push"),
                           ("remote", "mirror"), ("branch", "merge"), ("branch", "remote"),
                           ("branch", "pushremote")} | GIT_SENDEMAIL_COMMANDS
# Settings that make git run a command only when their value starts with ! (`alias.st=!sh`, an update of `!cmd`).
GIT_BANG_COMMANDS = {("alias", None), ("submodule", "update")}
# Sections every key of which counts: protocol.allow and protocol.<name>.allow let git use ext::, whose URL is a
# command, and the hook does not tell the other protocol.* keys apart.
GIT_ANY_KEY_SECTIONS = {"protocol"}
# git remote's subcommands that write configuration (a remote's URL, the branches it fetches, its section), which the
# repository's worktrees share: the main checkout's next fetch would use them.
GIT_REMOTE_WRITES = {"add", "rename", "remove", "rm", "set-head", "set-branches", "set-url"}
# git's options before the subcommand that take the next word as their value.
GIT_VALUE_OPTIONS = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix",
                     "--attr-source", "--list-cmds"}
# git's options before the subcommand, and the variables, that point it at another repository or work tree than the
# directory's, which the upstream rule cannot place in the session's worktree.
GIT_REPOSITORY_OPTIONS = {"--git-dir", "--work-tree"}
GIT_REPOSITORY_VARIABLES = {"GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"}
# git config's long options that take the next word as their value (-f is its one short one), its subcommands, its
# actions that only read or list, and its options that write (git takes a unique prefix of a long one).
GIT_CONFIG_VALUE_OPTIONS = {"--file", "--blob", "--type", "--default", "--comment", "--value", "--url"}
GIT_CONFIG_SUBCOMMANDS = {"set", "get", "list", "unset", "rename-section", "remove-section", "edit"}
GIT_CONFIG_READS = {"-l", "--list", "--get", "--get-all", "--get-regexp", "--get-urlmatch", "--get-color",
                    "--get-colorbool", "list", "get"}
GIT_CONFIG_WRITES = {"--add", "--replace-all", "--unset", "--unset-all", "--rename-section", "--remove-section",
                     "--edit"}


def computed(word):
    """Whether the word's text holds a part computed at run time."""
    return word.dynamic and bool(re.search(r"[$`]", word.value))


def git_command_setting(key, value):
    """Whether setting key (to value, a Word or None) makes git run a command; a key or alias value computed at run
    time counts, since the hook cannot tell."""
    if computed(key):
        return True
    parts = key.value.lower().split(".")
    if len(parts) < 2:
        return False
    section, name = parts[0], parts[-1]
    if section in GIT_ANY_KEY_SECTIONS:
        return True
    if (section, None) in GIT_BANG_COMMANDS or len(parts) > 2 and (section, name) in GIT_BANG_COMMANDS:
        return value is not None and (computed(value) or value.value.lstrip().startswith("!"))
    if len(parts) == 2:
        return (section, name) in GIT_COMMANDS or (section, None) in GIT_COMMANDS
    return (section, name) in GIT_SUBSECTION_COMMANDS


def git_setting(text, word, findings, how):
    """A `key=value` (or bare key) setting git applies, judged as a setting of key."""
    key, eq, value = text.partition("=")
    if git_command_setting(derived(word, key), derived(word, value) if eq else None):
        findings.git_settings.append(f"{how} {text}")


def analyze_git(args, cwd, findings):
    """git -c and --config-env that set a key which makes git run a command, git config and git remote that write
    configuration, and in a Triphammer session the branch, checkout, switch, push, fetch and pull options that set an
    upstream anywhere but in the session's own worktree or for a branch other than the one checked out there. In a
    Triphammer session, -C moves the directory a relative git config --file is judged against and that must lie in the
    worktree for an upstream."""
    i, redirected = 0, False
    while i < len(args):
        w, v = args[i], args[i].value
        if v in ("-c", "--config-env") and i + 1 < len(args):
            git_setting(args[i + 1].value, args[i + 1], findings, f"git {v}")
            i += 2
        elif v.startswith("--config-env="):
            git_setting(v.partition("=")[2], w, findings, "git --config-env")
            i += 1
        elif v.startswith("-c") and len(v) > 2:
            git_setting(v[2:], w, findings, "git -c")
            i += 1
        elif v in GIT_VALUE_OPTIONS:
            if v == "-C" and triphammer_sessions():
                cwd = findings.chdir(args[i + 1] if i + 1 < len(args) else None, cwd)
            redirected = redirected or v in GIT_REPOSITORY_OPTIONS
            i += 2
        elif v.startswith("-"):
            redirected = redirected or v.partition("=")[0] in GIT_REPOSITORY_OPTIONS
            i += 1
        else:
            break
    if i < len(args) and args[i].value == "config":
        analyze_git_config(args[i + 1:], cwd, findings)
    elif i < len(args) and args[i].value == "remote":
        sub = next((w for w in args[i + 1:] if not w.value.startswith("-")), None)
        if sub is not None and (computed(sub) or sub.value in GIT_REMOTE_WRITES):
            findings.git_settings.append(f"`git {' '.join(w.value for w in args[i:])}`, which writes a remote's "
                                         f"configuration")
    elif i < len(args) and args[i].value in GIT_UPSTREAM_SETTERS and triphammer_sessions():
        branch = None if redirected or findings.git_redirected else session_branch(cwd, findings)
        reason = GIT_UPSTREAM_SETTERS[args[i].value](args[i + 1:], functools.partial(own_branch, branch))
        if reason:
            if branch is None:
                reason = ("sets an upstream from a directory the hook cannot place in the session's worktree (a -C or "
                          "cd elsewhere, --git-dir, --work-tree or $GIT_DIR)")
            findings.git_settings.append(f"`git {' '.join(w.value for w in args[i:])}`, which {reason}")


def session_branch(cwd, findings):
    """The branch checked out in the Triphammer session's worktree ("" when none is), when cwd lies in every session's
    worktree and git there reaches the innermost one's repository; None otherwise, and when the hook cannot tell."""
    sessions = triphammer_sessions()
    real = physical(cwd) if cwd and os.path.isabs(cwd) and not findings.cdpath else None
    if real is None or any(tree is None or not within(real, tree) for tree, _ in sessions):
        return None
    tree = max((tree for tree, _ in sessions), key=len)
    here, there = (git(place, "rev-parse", "--absolute-git-dir") for place in (real, tree))
    if not here or not there or os.path.realpath(here.decode(errors="replace").strip()) != os.path.realpath(
            there.decode(errors="replace").strip()):
        return None
    out = git(tree, "symbolic-ref", "-q", "--short", "HEAD")
    return out.decode(errors="replace").strip() if out else ""


def own_branch(branch, word):
    """Whether word (None for the branch the command acts on when it names none) names branch, the one checked out in
    the session's worktree (HEAD, @, or its name); never when branch is None (the command runs elsewhere) or the hook
    cannot tell."""
    if branch is None:
        return False
    if word is None:
        return True
    if computed(word) or word.glob or word.expands:
        return False
    if word.value in ("HEAD", "@"):
        return True
    return bool(branch) and word.value in (branch, "refs/heads/" + branch)


def git_options(args, short_values, long_values):
    """The option names (a short letter as -x, a long name as written up to `=`) and the operands of git's
    arguments; see split_options."""
    operands, options = split_options(args, short_values, long_values)
    return {name for name, _ in options}, operands


def long_option(names, full, shortest):
    """Whether names hold the long option full or a prefix of it at least as long as shortest: git takes a unique
    prefix for the whole name."""
    return any(len(name) >= len(shortest) and full.startswith(name) for name in names if name.startswith("--"))


def git_branch_upstream(args, own):
    """git branch -u/--set-upstream-to naming a branch other than the checked-out one, or --track with --force."""
    names, operands = git_options(args, "u", {"--set-upstream-to"})
    if "-u" in names or long_option(names, "--set-upstream-to", "--se"):
        if not own(operands[0] if operands else None):
            return "sets the upstream of a branch other than the one checked out here"
    if ("-t" in names or long_option(names, "--track", "--tr")) and ("-f" in names
                                                                     or long_option(names, "--force", "--forc")):
        return "sets the upstream of a branch it forces over an existing one"
    return None


def git_checkout_upstream(args, own):
    """git checkout or switch with --track and a forced create or outside the session's worktree, or with
    --ignore-other-worktrees."""
    names, _ = git_options(args, "bBcC", set())
    if long_option(names, "--ignore-other-worktrees", "--ig"):
        return "takes over a branch another worktree has checked out"
    if "-t" in names or long_option(names, "--track", "--tr"):
        if {"-B", "-C"} & names or long_option(names, "--force-create", "--force-"):
            return "sets the upstream of a branch it forces over an existing one"
        if not own(None):
            return "sets the upstream of a branch"
    return None


def git_fetch_upstream(args, own):
    """git fetch or pull --set-upstream outside the session's worktree, which sets the upstream of the branch checked
    out where it runs (git fetch's -u is --update-head-ok)."""
    names, _ = git_options(args, "jo", {"--upload-pack", "--depth", "--deepen", "--shallow-since", "--shallow-exclude",
                                        "--server-option", "--jobs", "--refmap", "--negotiation-tip", "--strategy",
                                        "--strategy-option", "--recurse-submodules-default", "--submodule-prefix",
                                        "--filter"})
    if long_option(names, "--set-upstream", "--se") and not own(None):
        return "sets the upstream of the branch checked out there"
    return None


def git_push_upstream(args, own):
    """git push -u/--set-upstream of a branch other than the checked-out one (a refspec's source, --all and the
    like)."""
    names, operands = git_options(args, "o", {"--repo", "--receive-pack", "--exec", "--push-option"})
    if not ("-u" in names or long_option(names, "--set-upstream", "--se")):
        return None
    if names & {"--all", "--branches", "--mirror"}:
        return "sets the upstream of every branch"
    if len(operands) < 2 and not own(None):
        return "sets the upstream of the branch checked out there"
    for refspec in operands[1:]:
        source = refspec.value.lstrip("+").partition(":")[0]
        if source and not own(derived(refspec, source)):
            return "sets the upstream of a branch other than the one checked out here"
    return None


# git subcommands with options that write branch.<name>.remote and .merge, which a Triphammer session may set only for the
# branch it has checked out: the main checkout's branch.main.merge decides what its pull merges.
GIT_UPSTREAM_SETTERS = {"branch": git_branch_upstream, "checkout": git_checkout_upstream,
                        "switch": git_checkout_upstream, "push": git_push_upstream, "fetch": git_fetch_upstream,
                        "pull": git_fetch_upstream}


def analyze_git_config(args, cwd, findings):
    """git config that writes configuration, whatever the key and scope: a set, --add, --replace-all, an unset, a
    section rename or removal, --edit and their subcommands, and a word computed at run time that could be one. Only
    reading and listing stay off the list. The file a --file write names counts as written."""
    operands, options = split_options(args, "f", GIT_CONFIG_VALUE_OPTIONS)
    names = {name for name, _ in options}
    if operands and not computed(operands[0]) and operands[0].value in GIT_CONFIG_SUBCOMMANDS:
        names.add(operands[0].value)
        operands = operands[1:]
    writes = (names & {"-e", "set", "unset", "rename-section", "remove-section", "edit"}
              or any(long_option(names, full, "--a") for full in GIT_CONFIG_WRITES))
    reads = names & GIT_CONFIG_READS
    if not writes and (reads or len(operands) < 2 and not any(computed(w) for w in args)):
        return
    findings.git_settings.append(f"`git config {' '.join(w.value for w in args)}`, which writes git configuration")
    for name, value in options:
        if name in ("-f", "--file") and value is not None:
            findings.change(value, cwd)  # the file it writes


def git_environment(assignments, findings):
    """GIT_CONFIG_KEY_<n> and GIT_CONFIG_PARAMETERS assignments, which set git keys for the commands that inherit
    them, and GIT_REPOSITORY_VARIABLES assignments, which point them at another repository."""
    values = {}
    for w in assignments:
        if w.value.partition("=")[0] in GIT_REPOSITORY_VARIABLES:
            findings.git_redirected = True
        match = re.fullmatch(r"(GIT_CONFIG_(?:KEY|VALUE)_\d+|GIT_CONFIG_PARAMETERS)=(.*)", w.value, re.DOTALL)
        if match:
            values[match.group(1)] = derived(w, match.group(2))
    for name, word in values.items():
        if name.startswith("GIT_CONFIG_KEY_"):
            value = values.get(name.replace("KEY", "VALUE", 1))
            if git_command_setting(word, value if value is not None else derived(word, "!")):
                findings.git_settings.append(f"{name}={word.value}")
        elif name == "GIT_CONFIG_PARAMETERS":
            pairs = re.findall(r"'([^']*)'(?:=('[^']*'))?", word.value)
            if computed(word) or any(git_command_setting(derived(word, key), derived(word, value.strip("'")) if value
                                                       else None) for key, value in pairs):
                findings.git_settings.append(f"GIT_CONFIG_PARAMETERS={word.value}")


# The shell variables a kill operand can name the shell itself ($$) or its parent, the Claude Code session ($PPID) by.
OWN_SHELL, OWN_SESSION = "the shell running the command", "the Claude Code session that runs the shell"
SELF_PIDS = {"$$": OWN_SHELL, "${$}": OWN_SHELL, "$PPID": OWN_SESSION, "${PPID}": OWN_SESSION}


@functools.cache
def ancestors():
    """The PIDs of this hook's parent, the Claude Code session, and each of its parents in turn."""
    pids, pid = [], os.getppid()
    while pid > 0 and pid not in pids and len(pids) < 64:
        pids.append(pid)
        try:
            with open(f"/proc/{pid}/stat") as file:
                pid = int(file.read().rsplit(")", 1)[1].split()[1])
        except (OSError, ValueError, IndexError):
            if DEADLINE - time.monotonic() < 1.5:
                break
            try:  # no /proc, as on macOS
                out = subprocess.run(["ps", "-o", "ppid=", "-p", str(pid)], capture_output=True, timeout=1).stdout
                pid = int(out.decode().strip() or 0)
            except Exception:
                break
    return pids


def analyze_signal(args, findings):
    """kill of $$, $PPID or the PID of the session or one of its parents (also as a process group, `-- -$$`)."""
    pending, ended = False, False
    for w in args:
        v = w.value
        if pending:
            pending = False
            continue
        if not ended:
            if v == "--":
                ended = True
                continue
            if v in ("-l", "-L", "--list", "--table"):
                return  # lists signal names
            if v in ("-s", "-n", "--signal"):
                pending = True
                continue
            if v.startswith("-"):
                continue  # a signal (-9, -TERM, -sKILL, --signal=TERM)
        target = v[1:] if v.startswith("-") else v
        if w.dynamic and target in SELF_PIDS:
            findings.signals.append((v, SELF_PIDS[target]))
        elif not w.dynamic and target.isdigit() and int(target) in ancestors():
            findings.signals.append((v, f"process {target}, the Claude Code session or one of its parents"))


def analyze_kill(name, args, findings):
    full, pattern, skip = False, None, False
    for w in args:
        v = w.value
        if skip:
            skip = False
        elif v == "--full" or re.fullmatch(r"-[a-zA-Z0-9]*f[a-zA-Z0-9]*", v):  # -f, -af, -9f
            full = True
        elif v in KILL_VALUE_OPTIONS:
            skip = True
        elif v.startswith("-") and v != "-":
            pass
        elif pattern is None:
            pattern = v
    if full and pattern is not None and not re.search(r"\[[^\]]+\]", pattern):
        findings.kills.append((name, pattern))


def stdin_texts(command, bodies):
    """The command's heredoc bodies and here-strings, and what it prints when it is an echo or printf."""
    texts = [bodies[k] for k in command.heredocs if k < len(bodies)] + command.herestrings
    words = strip_prefix(command.words)
    if words and os.path.basename(words[0].value) in ("echo", "printf"):
        printed = " ".join(w.value for w in operands(words[1:]))
        texts.append(printed.replace("\\n", "\n").replace("\\t", "\t"))  # as echo -e and printf print them
    return texts


def walk(cmd, cwd, findings, depth=0):
    """Judges every command of the shell text; returns the directory it leaves the shell in."""
    text, bodies = strip_heredocs(cmd)
    try:
        tokens = tokenize(text)
    except Unbalanced as error:
        # bash runs every line before the one where the quote opens, then stops with a syntax error.
        try:
            tokens = tokenize(text[:max(text.rfind("\n", 0, error.start), 0)])
        except ValueError:
            return cwd
    saved, in_session, moved, backquotes = [], bool(triphammer_sessions()), False, 0
    for pipeline, separator in pipelines(tokens):
        check_deadline()
        stdin = [text for command in pipeline for text in stdin_texts(command, bodies)]
        before = cwd
        for command in pipeline:
            command.pipeline_input = stdin
            after = analyze(command, cwd, findings, depth)
            if after is not SAME_CWD and len(pipeline) == 1:
                cwd = after
        words = strip_prefix(pipeline[0].words) if len(pipeline) == 1 else []
        last = strip_prefix(pipeline[-1].words)
        if words and words[0].value in ("cd", "pushd"):
            if in_session and runs_elsewhere(pipeline[0].words, words):
                cwd = None  # `env cd`, `runuser -u USER cd`: another process, so where the shell is is not known
            else:
                cwd = resolve_cd(words, cwd, findings)
        elif words and words[0].value == "popd" and in_session:
            cwd = None  # back to a directory the hook does not track
        elif in_session and len(pipeline) > 1 and last and last[0].value in ("cd", "pushd", "popd"):
            cwd = None  # shopt -s lastpipe runs the last command of a pipeline in the shell
        if in_session and runs_unseen_code(pipeline, findings):
            findings.cwd_lost = True
        if in_session:
            moved = moved or cwd != before
            if separator == "&" and moved:
                cwd = None  # a cd in a list sent to the background moves only its subshell
        name = os.path.basename(last[0].value) if last else None
        if name == "eval" and separator in ("$(", "`"):
            findings.unreadable.append("an eval of a command substitution's output")
        elif name in ("source", ".") and separator == "<(" and len(last) == 1:
            findings.unreadable.append(f"`{name}` of a process substitution's output")
        if in_session and separator == "`":
            backquotes += 1
        if separator in OPENERS or in_session and separator == "`" and backquotes % 2:
            saved.append((cwd, moved))
        elif (separator == ")" or in_session and separator == "`") and saved:
            cwd, moved = saved.pop()
        if findings.cwd_lost:
            cwd = None
    return cwd


def runs_unseen_code(pipeline, findings):
    """Whether a pipeline sets up shell code the worktree-only rule does not see run, which may cd or set $CDPATH
    at any later point: a source or . of a file, a function definition, an alias or a trap."""
    for command in pipeline:
        words = strip_prefix(command.words)
        name = os.path.basename(words[0].value) if words else None
        if name in ("source", ".", "function", "alias", "trap") or command.function:
            findings.cdpath = True
            return True
    return False


def git(cwd, *args):
    remaining = DEADLINE - time.monotonic()
    if remaining <= 0.5:
        return None
    env = dict(os.environ, GIT_OPTIONAL_LOCKS="0")
    try:
        result = subprocess.run(["git", "-C", cwd, *args], capture_output=True, timeout=min(3, remaining), env=env)
    except Exception:
        return None
    return result.stdout if result.returncode == 0 else None


@functools.cache
def edit_roots(top):
    """The shell-edit roots the project file of the repository at top declares, as relative paths with / separators;
    none when the file is missing, unreadable or malformed, or leaves the field out."""
    try:
        with open(os.path.join(top, PROJECT_FILE), encoding="utf-8") as file:
            roots = json.load(file).get("shellEditRoots")
    except Exception:
        return ()
    if not isinstance(roots, list):
        return ()
    clean = []
    for root in roots:
        if not isinstance(root, str):
            return ()
        segments = root.rstrip("/").split("/")
        if root.startswith("/") or any(s in ("", os.curdir, os.pardir) for s in segments):
            return ()
        clean.append("/".join(segments))
    return tuple(clean)


def tracked_edits(edits):
    """The edited paths that are git-tracked files under the shell-edit roots of the repository of their cwd; for a
    tree edit, the tracked files under those roots inside it, or the path itself when it is a tracked file."""
    tops, by_top, trees = {}, {}, {}
    for path, cwd, tree in edits:
        if cwd not in tops:
            out = git(cwd, "rev-parse", "--show-toplevel") if cwd and os.path.isdir(cwd) else None
            tops[cwd] = os.path.realpath(out.decode().strip()) if out else None
        top = tops[cwd]
        if top is None:
            continue
        roots = edit_roots(top)
        rel = os.path.relpath(os.path.realpath(path), top).replace(os.sep, "/")
        if any(rel == root or rel.startswith(root + "/") for root in roots):
            (trees if tree else by_top).setdefault(top, set()).add(rel)
        elif tree:
            # A tree edit of the repository, a directory above it, or a directory that holds a root.
            above = set(rel.split("/")) <= {os.curdir, os.pardir}
            trees.setdefault(top, set()).update(root for root in roots if above or root.startswith(rel + "/"))
    tracked = []
    for top in sorted(by_top.keys() | trees.keys()):
        rels, roots = by_top.get(top, set()), trees.get(top, set())
        out = git(top, "--literal-pathspecs", "ls-files", "-z", "--", *sorted(rels | roots))
        if out:
            files = set(out.decode(errors="replace").split("\0")) - {""}
            tracked += sorted(f for f in files
                              if f in rels or f in roots or any(f.startswith(r + "/") for r in roots))
    return tracked


def persistence_roots():
    """The directories that hold Triphammer's persistence: its installed scripts, units, config and state."""
    home = os.path.expanduser("~")
    config = [os.path.join(home, ".config")] + ([os.environ["XDG_CONFIG_HOME"]] if os.environ.get("XDG_CONFIG_HOME")
                                                else [])
    state = os.environ.get("XDG_STATE_HOME") or os.path.join(home, ".local", "state")
    roots = [os.path.join(home, ".local", "bin"), os.path.join(home, ".local", "state", "ticket-runner"),
             os.environ.get("TRIPHAMMER_SHARED_DIR") or os.path.join(state, "triphammer")]
    roots += configured_paths(home, "STATE_DIR")
    roots += [os.path.join(c, sub) for c in config for sub in (os.path.join("systemd", "user"), "triphammer")]
    return {os.path.normpath(r) for root in roots if os.path.isabs(root) for r in (root, os.path.realpath(root))}


def configured_paths(home, key):
    """The value every Triphammer config in ${XDG_CONFIG_HOME:-~/.config}/triphammer sets for key, STATE_DIR or CHECKOUT
    (bin/README.md, Configuration): a `KEY=` line whose value is an absolute path, taken verbatim. A file that
    is missing, unreadable or malformed adds nothing it does not set that way, and an error reading one never stops
    the hook."""
    config = os.environ.get("XDG_CONFIG_HOME") or os.path.join(home, ".config")
    paths = []
    try:
        files = sorted(glob.glob(os.path.join(glob.escape(os.path.join(config, "triphammer")), "*.conf")))
    except Exception:
        return paths
    for path in files[:64]:
        try:
            if not os.path.isfile(path):  # a FIFO would block the read
                continue
            with open(path, encoding="utf-8", errors="replace") as file:
                text = file.read(1 << 16)
        except Exception:
            continue
        paths += [match.group(1) for line in text.split("\n")
                  for match in [re.fullmatch(re.escape(key) + r"=(/.*)", line)] if match]
    return paths


def persistence_changes(paths):
    """The changed paths inside a persistence directory, or for a tree change holding one, as their text."""
    roots = persistence_roots()

    def inside(candidate, tree):
        check_deadline()
        return any(candidate == root or candidate.startswith(root + os.sep)
                   or tree and root.startswith(candidate.rstrip(os.sep) + os.sep) for root in roots)
    return list(dict.fromkeys(path for path, tree in paths
                              if inside(path, tree) or inside(os.path.realpath(path), tree)))


MAX_LINKS = 512  # entries read from each persistence directory when collecting the files its symlinks point to
FILE_TOOLS = {"Write", "Edit", "NotebookEdit"}


def link_targets(roots):
    """The real paths of the symlinks directly inside Triphammer directories, such as the main checkout's scripts that
    ~/.local/bin links to; a directory that is missing or unreadable adds nothing."""
    targets = set()
    for root in roots:
        try:
            with os.scandir(root) as entries:
                for count, entry in enumerate(entries):
                    if count >= MAX_LINKS:
                        break
                    if entry.is_symlink():
                        targets.add(os.path.realpath(entry.path))
        except OSError:
            continue
    return targets


# The directories of Triphammer's checkout that the ticket runner sources, runs, links or loads: its scripts, units,
# status page, the commit hooks and classifier, and the plugin. A checkout is Triphammer's when it holds bin/config.sh.
CHECKOUT_TREES = ("bin", "systemd", "status", "scripts", os.path.join("plugins", "triphammer"))
LINKED_TREES = ("bin", "systemd", "status")
CHECKOUT_MARKER = os.path.join("bin", "config.sh")


def checkout_trees(targets):
    """The real paths of the bin, systemd, status, scripts and plugins/triphammer of each main checkout of Triphammer
    the ticket runner runs from: each CHECKOUT a Triphammer config sets that is Triphammer's checkout, and the
    <checkout> of each symlink target <checkout>/bin/<file>, <checkout>/systemd/<unit> or <checkout>/status/<file>.
    The ticket runner sources, runs or loads those files from there on every tick (its worktrees under .worktrees
    are other paths)."""
    checkouts = configured_paths(os.path.expanduser("~"), "CHECKOUT")
    checkouts += [os.path.dirname(os.path.dirname(target)) for target in targets
                  if any(os.path.dirname(target).endswith(os.sep + tree) for tree in LINKED_TREES)]
    return {os.path.realpath(os.path.join(checkout, tree)) for checkout in checkouts
            if os.path.isfile(os.path.join(checkout, CHECKOUT_MARKER)) for tree in CHECKOUT_TREES}


def decide_file(tool, path, cwd):
    """The refusal of a file tool's write of path, or None when it touches none of Triphammer's persistence."""
    if not isinstance(path, str) or not path:
        return None
    cwd = cwd if isinstance(cwd, str) and os.path.isabs(cwd) else None
    raw = os.path.join(cwd, path) if cwd and not os.path.isabs(path) else path  # `..` left for physical
    path = absolute(path, cwd)
    if path is None:
        return None
    changed = persistence_changes([(path, False)])
    real = os.path.realpath(path)
    targets = link_targets(persistence_roots())
    if not changed and real in targets:
        changed = [f"{path}, which a symlink in a persistence directory points to"]
    if not changed and any(real == tree or real.startswith(tree + os.sep) for tree in checkout_trees(targets)):
        changed = [f"{path}, in the bin, systemd, status, scripts or plugins/triphammer of Triphammer's checkout"]
    if not changed:
        if triphammer_sessions() and (outside_session(path, False) or outside_session(raw, False)):
            return (f"agent-guard worktree-only rule: this {tool} writes {path}, outside the places a session the "
                    f"Triphammer started may write: {session_places()}. Leave a change anywhere else to the owner and "
                    f"report it; a file tool has no override.")
        if triphammer_sessions() and hard_linked(path):
            return worktree_hard_link(path, f"this {tool} writes", "leave the change to the owner and report it; a "
                                      "file tool has no override")
        return None
    return (f"agent-guard persistence rule: this {tool} changes Triphammer's persistence ({listed(changed)}). Agents "
            f"never install or change Triphammer's systemd units, the scripts in ~/.local/bin (or the files they link "
            f"to), Triphammer's checkout, its config or its state; the owner does "
            f"that. The override, `# guard-override: <reason>`, applies only to Bash commands, so leave this change "
            f"to the owner and report it.")


SESSION_MARKER = "TRIPHAMMER_SESSION"
# Files a write may always name: they hold nothing.
DEVICES = re.compile(r"/dev/(?:null|zero|full|stdout|stderr|tty|fd/\d+)|/proc/self/fd/\d+")


def environment_of(pid):
    """The environment process pid started with (/proc/<pid>/environ), which nothing it does later changes."""
    with open(f"/proc/{pid}/environ", "rb") as file:
        data = file.read(1 << 20)
    pairs = (item.partition(b"=") for item in data.split(b"\0"))
    return {key.decode(errors="replace"): value.decode(errors="replace") for key, eq, value in pairs if eq}


@functools.cache
def environments():
    """The hook's own environment and the one each of its parent processes started with."""
    found = [dict(os.environ)]
    for pid in ancestors():
        try:
            found.append(environment_of(pid))
        except Exception:
            continue
    return found


@functools.cache
def triphammer_sessions():
    """The places each Triphammer session this hook runs under may write: (its worktree's real path or None, its temporary
    directories' real paths), one for the hook's own environment and one for each parent process that started with
    $TRIPHAMMER_SESSION set. A write must fit every one of them, so a value the session sets later (a settings
    file's env) only narrows them. Empty when no environment sets it: an interactive session."""
    sessions = set()
    for env in environments():
        marker = env.get(SESSION_MARKER)
        if not marker:
            continue
        worktree = os.path.realpath(marker) if os.path.isabs(marker) and os.path.isdir(marker) else None
        temps = frozenset(os.path.realpath(t) for t in ("/tmp", "/var/tmp", env.get("TMPDIR") or "")
                          if os.path.isabs(t))
        sessions.add((worktree, temps))
    return sessions


def within(path, root):
    return path == root or path.startswith(root.rstrip(os.sep) + os.sep)


def physical(path):
    """The real path the kernel reaches for an absolute path: each `..` taken after the symlinks before it, not
    textually. For a path that does not exist yet, the real path of its nearest existing parent with the rest
    appended; None when that rest holds a `..`, whose meaning depends on what the command creates first."""
    check_deadline()
    parts = [part for part in path.split(os.sep) if part]
    for i in range(len(parts), -1, -1):
        prefix = os.sep + os.sep.join(parts[:i])
        if os.path.lexists(prefix):
            rest = [part for part in parts[i:] if part != "."]
            return None if ".." in rest else os.path.join(os.path.realpath(prefix), *rest)
    return None


def session_candidates(path):
    """The real paths a write, link or removal of path reaches: its physical path, and its directory's with its own
    name (the link an rm, mv or ln acts on); None when the hook cannot work one out."""
    path = path.rstrip(os.sep) or os.sep
    full, name = physical(path), os.path.basename(path)
    if full is None or name in ("", ".", ".."):
        return None if full is None else {full}
    parent = physical(os.path.dirname(path))
    return None if parent is None else {full, os.path.join(parent, name)}


GLOB_LIMIT = 5000  # matches a glob may have before the hook stops listing them


# What a glob part's token stands for: any text, or any one character; every other token is a literal character.
ANY_TEXT, ANY_CHARACTER = object(), object()


def glob_tokens(part):
    """The tokens of a pattern matching every name bash's pathname expansion of part could, whatever its shell options
    (nocaseglob, dotglob) and whichever of part's glob characters were quoted: * as any text, ? as any character, and
    from the first [ to the last ] after it as any text."""
    first, last = part.find("["), part.rfind("]")
    tokens, i = [], 0
    while i < len(part):
        c = part[i]
        if i == first and last > first:
            tokens, i = tokens + [ANY_TEXT], last + 1
            continue
        tokens.append(ANY_TEXT if c == "*" else ANY_CHARACTER if c == "?" else c)
        i += 1
    return tokens


def same_letter(a, b):
    return a == b or a.lower() == b.lower() or a.upper() == b.upper()


def glob_match(tokens, name):
    """Whether name matches the tokens (see glob_tokens), ignoring case. Each * keeps only the latest place to resume
    from, so a match takes at most len(tokens) * len(name) steps however many * there are, where a backtracking
    regex takes exponentially many."""
    t = n = 0
    resume = None  # (the token after the latest *, the name index that * stops at so far)
    while n < len(name):
        if t < len(tokens) and tokens[t] is ANY_TEXT:
            resume, t = (t + 1, n), t + 1
        elif t < len(tokens) and (tokens[t] is ANY_CHARACTER or same_letter(tokens[t], name[n])):
            t, n = t + 1, n + 1
        elif resume is not None:
            t, n = resume[0], resume[1] + 1
            resume = (t, n)
        else:
            return False
    return all(token is ANY_TEXT for token in tokens[t:])


def glob_candidates(path):
    """Every existing path bash's pathname expansion of the absolute path could reach (hidden names included, and .
    and .. for a part that starts with a dot), or None for a part holding ** (globstar descends into directories) or
    more than GLOB_LIMIT matches."""
    found = [""]
    for part in path.split(os.sep)[1:]:
        if not re.search(r"[*?\[]", part):
            found = [base + os.sep + part for base in found]
            continue
        if "**" in part:
            return None
        tokens, matched = glob_tokens(part), []
        for base in found:
            check_deadline()
            try:
                names = os.listdir(base or os.sep) + ([".", ".."] if part.startswith(".") else [])
            except OSError:
                continue
            matched += [base + os.sep + name for name in names if glob_match(tokens, name)]
            if len(matched) > GLOB_LIMIT:
                return None
        found = matched
    return found


def outside_session(path, tree):
    """Whether a Triphammer session may not write path (with tree, every file under it): a real path it reaches (see
    session_candidates) lies outside the worktree or under its .git, and outside the temporary directories, of some
    Triphammer session, or the hook cannot work one out."""
    if DEVICES.fullmatch(path):
        return False
    candidates = session_candidates(path)
    if candidates is None:
        return True
    for worktree, temps in triphammer_sessions():
        git_dir = worktree and os.path.join(worktree, ".git")
        for candidate in candidates:
            in_worktree = (worktree is not None and within(candidate, worktree) and not within(candidate, git_dir)
                           and not (tree and within(git_dir, candidate)))
            if not in_worktree and not any(within(candidate, temp) for temp in temps):
                return True
    return False


def session_places():
    worktrees = sorted({worktree for worktree, _ in triphammer_sessions() if worktree})
    return (f"{' and '.join(worktrees) or 'no worktree (its $' + SESSION_MARKER + ' names no directory)'}, apart from "
            f"its .git, and $TMPDIR, /tmp and /var/tmp")


def hard_linked(path):
    """Whether path is an existing regular file with another name (st_nlink above 1), which may lie outside the
    places a Triphammer session may write; git, dotnet and npm leave none in a worktree."""
    check_deadline()
    try:
        status = os.stat(path)
    except (OSError, ValueError):
        return False
    return stat.S_ISREG(status.st_mode) and status.st_nlink > 1


def worktree_hard_link(paths, what, then):
    return (f"agent-guard worktree-only rule: {what} {paths}, a file with more than one hard link, whose other names "
            f"may lie outside the places a session Triphammer started may write: {session_places()}. Write a new file "
            f"instead (remove this name first, which leaves the others alone), or {then}.")


def bracket(pattern):
    match = re.search(r"[A-Za-z0-9]", pattern)
    if not match:
        return "[p]attern"
    i = match.start()
    return f"{pattern[:i]}[{pattern[i]}]{pattern[i + 1:]}"


def listed(items, limit=3, separator="; "):
    """The first limit items joined, with a count of the rest."""
    rest = len(items) - limit
    return separator.join(items[:limit]) + (f" and {rest} more" if rest > 0 else "")


def decide(cmd, cwd):
    findings = Findings(cwd if isinstance(cwd, str) and os.path.isabs(cwd) else None)
    findings.assigned = assigned_variables(cmd)
    findings.cdpath = bool(triphammer_sessions()) and (
        any("CDPATH" in env or "BASH_ENV" in env for env in environments())
        or bool(re.search(r"CDPATH|cdable_vars|BASH_ENV", cmd)))
    walk(cmd, findings.start_cwd, findings)
    persistence = findings.units + persistence_changes(findings.persistence_paths)
    unreadable = findings.unreadable + [f"{described}, a file the command writes"
                                        for described, spelled in findings.sourced if spelled & findings.written]
    if persistence:
        return (f"agent-guard persistence rule: this command changes Triphammer's persistence "
                f"({listed(persistence)}). Agents never install or change Triphammer's systemd units, the scripts in "
                f"~/.local/bin, its config or its state; the owner does that. If the command is text you meant to "
                f"write to a file, a heredoc terminator that turns up early in that text (or an unbalanced quote) runs "
                f"the rest as commands: pick a unique terminator. If the change really is yours to make, "
                f"{OVERRIDE_HINT}.")
    if unreadable:
        return (f"agent-guard persistence rule: this command runs text the hook cannot read before it runs "
                f"({listed(unreadable)}), so it cannot tell whether that text changes Triphammer's persistence, which "
                f"agents never do. Write the command out in the command itself instead of building it at run time or "
                f"writing it to a file first. If the text really is safe, {OVERRIDE_HINT}.")
    if triphammer_sessions():
        reached = ([path for path, _, _ in findings.session_paths] + [path for path, _ in findings.link_sources]
                   + findings.symlink_targets)
        unknown = {path for path in reached if not DEVICES.fullmatch(path) and session_candidates(path) is None}
        findings.unresolved += [f"{path} (a `..` after a part that does not exist yet)" for path in sorted(unknown)]
        copied = {physical(path) for path in findings.copied} - {None}
        findings.unresolved += [f"{path} (under {real}, which the same command copies or moves, so it may hold "
                                f"symlinks the hook cannot see yet)" for path in reached for real in copied
                                if path not in unknown and physical(path) != real and within(physical(path), real)]
        outside = list(dict.fromkeys(path for path, tree, _ in findings.session_paths
                                     if path not in unknown and outside_session(path, tree)))
        outside += [f"{path} (as the source of a hard link, which writes through the link change)"
                    for path, tree in findings.link_sources if path not in unknown and outside_session(path, tree)]
        outside += [f"{path} (as the target of a symbolic link, which writes through the link reach)"
                    for path in findings.symlink_targets if path not in unknown and outside_session(path, False)]
        if outside:
            return (f"agent-guard worktree-only rule: this command writes, links or removes {listed(outside)}, "
                    f"outside the places a session Triphammer started may write: {session_places()}. Write inside "
                    f"the worktree or a temporary directory, and leave a change anywhere else to the owner and report "
                    f"it. If the write really is yours to make, {OVERRIDE_HINT}.")
        linked = list(dict.fromkeys(path for path, tree, content in findings.session_paths
                                    if content and not tree and hard_linked(path)))
        if linked:
            return worktree_hard_link(listed(linked), "this command writes", OVERRIDE_HINT)
        if findings.unresolved:
            return (f"agent-guard worktree-only rule: this command writes, links or removes a path the hook cannot "
                    f"work out before it runs ({listed(list(dict.fromkeys(findings.unresolved)))}), so it cannot "
                    f"tell whether it lies inside the places a session Triphammer started may write: "
                    f"{session_places()}. Spell the path out: literally, after a cd the hook can follow, or starting "
                    f"with $HOME, $TMPDIR or $PWD (which the command does not set). If the write really is yours to "
                    f"make, {OVERRIDE_HINT}.")
        if findings.git_settings:
            return (f"agent-guard git-command rule: this command writes git configuration, sets git configuration "
                    f"that makes git run a command, or changes where or what git fetches, merges and pushes "
                    f"({listed(findings.git_settings)}), which a session Triphammer started never does: the worktree "
                    f"shares its repository's configuration, so git would use it later, in this worktree, the main "
                    f"checkout or the owner's sessions. Reading configuration stays allowed, and so does `git -c` with "
                    f"other keys for one command. If the setting really is yours to make, {OVERRIDE_HINT}.")
        if findings.schedules:
            return (f"agent-guard scheduler rule: {listed(findings.schedules)} schedules a command to run later, "
                    f"outside the session, which a session Triphammer started never does (`crontab -l` stays allowed). "
                    f"If it really is yours to do, {OVERRIDE_HINT}.")
    if findings.kills:
        name, pattern = findings.kills[0]
        effect = "kills that shell (exit code 144)" if name == "pkill" else "lists that shell as well"
        return (f"agent-guard self-kill rule: `{name} -f {pattern}` also matches the command line of the shell that "
                f"runs it, so it {effect}. Write the pattern in bracket form (`{name} -f '{bracket(pattern)}'`), "
                f"kill the PID you saved when you started the process (`kill \"$pid\"`), or use `kill %1` for a job "
                f"this shell started. If the pattern really is right, {OVERRIDE_HINT}.")
    if findings.signals:
        target, process = findings.signals[0]
        return (f"agent-guard self-kill rule: `kill {target}` signals {process}, so it ends the command or the "
                f"session itself. Kill the PID you saved when you started the process (`kill \"$pid\"`), or use "
                f"`kill %1` for a job this shell started. If the target really is right, {OVERRIDE_HINT}.")
    if findings.xargs_signals:
        name = findings.xargs_signals[0]
        return (f"agent-guard self-kill rule: `xargs {name}` takes what it signals or lists from its input, which the "
                f"hook cannot read, so it may end the command or the session itself. Write the target out: kill the "
                f"PID you saved when you started the process (`kill \"$pid\"`), use `kill %1` for a job this shell "
                f"started, or give pkill -f or pgrep -f a pattern in bracket form (`'[p]attern'`). If it really is "
                f"safe, {OVERRIDE_HINT}.")
    files = tracked_edits(findings.edits)
    if files:
        return (f"agent-guard shell-edit rule: this command rewrites git-tracked {listed(files, 5, ', ')} through the "
                f"shell. Make the change with Edit (or Write for a new or wholly replaced file), so the language "
                f"server's diagnostics arrive after it. If the shell really is the right tool, {OVERRIDE_HINT}.")
    return None


def out_of_time(tool):
    then = ("leave the change to the owner and report it; a file tool has no override" if tool in FILE_TOOLS
            else f"split it into shorter commands with fewer brace expansions and globs, or if it really is "
                 f"safe, {OVERRIDE_HINT}")
    return (f"agent-guard worktree-only rule: the hook ran out of time ({parse_seconds():g} seconds) working out what "
            f"this {'command' if tool == 'Bash' else tool} writes, so it cannot tell whether it stays inside the "
            f"places a session Triphammer started may write: {session_places()}. Instead, {then}.")


def judge(tool, tool_input, cwd):
    """The deny reason for the tool call, or None to allow it."""
    try:
        if tool in FILE_TOOLS:
            return decide_file(tool, tool_input.get("file_path") or tool_input.get("notebook_path"), cwd)
        cmd = tool_input.get("command")
        if not isinstance(cmd, str) or OVERRIDE.search(cmd):
            return None
        return decide(cmd, cwd)
    except OutOfTime:
        # Outside a Triphammer session the hook never blocks on its own failure; in one, a command it cannot finish judging
        # is refused rather than left to the hook timeout, after which Claude Code would run it.
        return out_of_time(tool) if triphammer_sessions() else None


# How long after PARSE_DEADLINE a Triphammer session's watchdog gives the judgement before refusing (never past DEADLINE).
WATCHDOG_GRACE = 1.0


def watched(tool, tool_input, cwd):
    """judge in a child process, which the hook stops once the deadline passes and refuses the call: a slow path the
    parse's own check_deadline calls miss (a long system call, a slow regex, which holds the interpreter so no
    thread or signal handler could run) cannot outlive it."""
    read_end, write_end = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(read_end)
        try:
            out = (judge(tool, tool_input, cwd) or "").encode()
        except BaseException:
            out = b""
        with os.fdopen(write_end, "wb") as pipe:
            pipe.write(out)
        os._exit(0)
    os.close(write_end)
    stop, chunks = min(DEADLINE, PARSE_DEADLINE + WATCHDOG_GRACE), []
    with os.fdopen(read_end, "rb", buffering=0) as pipe:
        while True:
            remaining = stop - time.monotonic()
            if remaining <= 0 or not select.select([pipe], [], [], remaining)[0]:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
                return out_of_time(tool)
            chunk = pipe.read(65536)
            if not chunk:
                break
            chunks.append(chunk)
    os.waitpid(pid, 0)
    return b"".join(chunks).decode() or None


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        return
    if not isinstance(data, dict) or not isinstance(data.get("tool_input"), dict):
        return
    tool, tool_input, cwd = data.get("tool_name"), data["tool_input"], data.get("cwd")
    if tool not in FILE_TOOLS and tool != "Bash":
        return
    reason = watched(tool, tool_input, cwd) if triphammer_sessions() and hasattr(os, "fork") else judge(tool, tool_input, cwd)
    if reason:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                                 "permissionDecisionReason": reason}}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
