#!/usr/bin/env python3
# Claude Code PreToolUse hook for Bash, Write, Edit and NotebookEdit, part of the Triphammer plugin (its hooks/hooks.json
# runs it; a project's .claude/settings.json may run it too). It catches honest mistakes early, each with a refusal
# that says what to do instead. It is not a security boundary: the write limit (bin/session-sandbox) and the runner
# hold the boundaries of the threat model in bin/security-review-brief.md, and a command written to get past this hook
# gets past it. It reads commands in their plain forms: each command of a list, pipeline, subshell or substitution,
# after variable assignments and the wrappers sudo, env, command, nohup, time and timeout. The plain writers are
# redirections, tee, cp, mv, rm, ln and sed -i; a path counts when it is literal, or starts with ~, $HOME or one of
# $XDG_CONFIG_HOME, $XDG_STATE_HOME and $TRIPHAMMER_SHARED_DIR. A path computed at run time is allowed, and so is a
# relative one after a cd. Heredoc bodies and quoted arguments are text, not commands.
#
# In every session:
#   persistence  systemctl --user verbs that change the manager or a Triphammer unit (ticket-runner, merge-when-ready,
#               triphammer-status), and writes by the plain writers or the file tools under ~/.local/bin,
#               ~/.config/systemd/user, ~/.config/triphammer (or under $XDG_CONFIG_HOME), ~/.local/state/ticket-runner,
#               the STATE_DIR each Triphammer config sets, and the shared directory ($TRIPHAMMER_SHARED_DIR, else
#               ${XDG_STATE_HOME:-~/.local/state}/triphammer), as written or with symlinks resolved.
#   shell-edit  a plain writer other than rm and ln rewriting a git-tracked file under a `shellEditRoots` path of the
#               .triphammer/project.json of the repository the command runs in, or a python or node script given by
#               -c, -e or a heredoc that opens such a file for writing by a literal path: open(path, mode) with w, a, x
#               or + in the mode, Path(path).write_text or write_bytes, or fs.writeFile, appendFile and their Sync forms.
#   self-kill   pkill -f or pgrep -f with a pattern not in '[p]attern' form, and kill of $$, $PPID or the PID of the
#               session or one of its parents.
# In a session Triphammer started, whose environment or a parent's holds $TRIPHAMMER_SESSION (the run's clone):
#   worktree-only  a plain writer or file tool writing a path whose real path lies outside that clone (or in its .git)
#               and outside $TMPDIR, /tmp and /var/tmp; /dev/null and the standard streams are allowed.
#   needs-owner  gh issue edit or gh pr edit with --remove-label naming needs-owner.
#   scheduler   crontab other than -l, at, batch and systemd-run.
#
# `# guard-override: <reason>` in a Bash command lifts only the shell-edit rule, and the hook appends one JSON line
# (time, session, rule, reason, command) to guard-overrides.log in the shared directory; a failure to write it prints a
# line on stderr and still allows the command. The hook fails open: anything it cannot work out (malformed input, no
# git, an unreadable config, an error of its own) allows the call. It reads the hook's JSON on stdin, prints a deny
# decision or nothing, and always exits 0.
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
import functools
import glob
import json
import os
import re
import subprocess
import sys
import time

OVERRIDE = re.compile(r"#\s*guard-override:[ \t]*(\S[^\n]*)")
# The one rule the override lifts; decide() returns its refusal only when no other rule refuses the command.
SHELL_EDIT_RULE = "agent-guard shell-edit rule"
OVERRIDE_LOG = "guard-overrides.log"
PROJECT_FILE = os.path.join(".triphammer", "project.json")
FILE_TOOLS = {"Write", "Edit", "NotebookEdit"}
SESSION_MARKER = "TRIPHAMMER_SESSION"

# Shell operators, longest first so `>>` wins over `>`.
OPERATORS = ["&>>", "<<<", "&&", "||", ";;", "|&", ">>", ">&", ">|", "&>", "<<", "<&", "<>",
             "\n", ";", "&", "|", ">", "<", "(", ")"]
PIPES = {"|", "|&"}
WRITE_REDIRECTS = {">", ">>", ">|", "&>", "&>>", ">&", "<>"}
OTHER_REDIRECTS = {"<", "<<<", "<&"}
# The wrappers strip_prefix drops before the command name, and their options that take the next word as a value.
WRAPPERS = {"sudo", "env", "command", "nohup", "time", "timeout"}
WRAPPER_VALUE_OPTIONS = {
    "sudo": ("aCcDgpRrTtUu", {"--auth-type", "--login-class", "--close-from", "--chdir", "--group", "--host",
                               "--prompt", "--chroot", "--role", "--type", "--command-timeout", "--other-user",
                               "--user"}),
    "env": ("aCu", {"--argv0", "--chdir", "--unset"}),
    "time": ("fo", {"--format", "--output"}),
    "timeout": ("ks", {"--kill-after", "--signal"}),
}
# Reserved words that can stand before a command name: `if true; then sed -i ...; fi` runs sed.
RESERVED = {"if", "then", "else", "elif", "do", "while", "until", "{", "!", "coproc"}
HEREDOC = re.compile(r"(?<!<)<<(-?)[ \t]*(['\"]?)([A-Za-z_][\w.-]*)\2")
MARKER = re.compile(r"\x00(\d+)\x00$")
# Leading variables a path may start with, expanded from the hook's own environment, which the shell shares.
PATH_VARIABLES = ("HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "TRIPHAMMER_SHARED_DIR")
# Files a write may always name: they hold nothing.
DEVICES = re.compile(r"/dev/(?:null|zero|full|stdout|stderr|tty|fd/\d+)|/proc/self/fd/\d+")
# Interpreters whose script, from -c or -e or a heredoc on stdin, the shell-edit rule reads: the option letters that
# give the script, the other letters that take a value, and the long options that take the next word as a value (node's
# common ones; the rest written with `=` cost nothing).
INTERPRETERS = {
    "python": ("c", "mWX", {"--check-hash-based-pycs"}),
    "node": ("ep", "rC", {"--require", "--import", "--loader", "--experimental-loader", "--conditions", "--input-type",
                          "--env-file", "--env-file-if-exists", "--title", "--disable-warning", "--redirect-warnings"}),
}
# A script's writes to a literal path: open(path, mode) with a writing mode, Path(path).write_text or write_bytes, and
# node's fs.writeFile and appendFile (also Sync).
SCRIPT_WRITES = re.compile(
    r"\bopen\(\s*(['\"])([^'\"]+)\1\s*,\s*(?:mode\s*=\s*)?['\"][^'\"]*[wax+]"
    r"|\bPath\(\s*(['\"])([^'\"]+)\3\s*\)\s*\.\s*write_(?:text|bytes)\b"
    r"|\b(?:write|append)File(?:Sync)?\(\s*(['\"`])([^'\"`]+)\5")

# Triphammer's systemd units, their @<project> instances and template unit files, by name or by path.
TRIPHAMMER_UNIT = re.compile(r"(?:ticket-runner|merge-when-ready|triphammer-status)(?:@[^/]*)?"
                             r"(?:\.(?:service|timer|path|socket|target))?")
# systemctl verbs that act on the whole manager, which runs the ticket runner, the merge queue and the status page.
SYSTEMCTL_GLOBAL = {"daemon-reload", "daemon-reexec", "preset-all", "exit", "isolate", "default", "halt", "poweroff",
                    "reboot", "soft-reboot", "kexec", "switch-root", "set-environment", "unset-environment",
                    "import-environment"}
# systemctl verbs that change a unit's state or files.
SYSTEMCTL_CHANGING = {"start", "stop", "reload", "restart", "try-restart", "reload-or-restart", "try-reload-or-restart",
                      "force-reload", "condrestart", "condreload", "condstop", "kill", "clean", "freeze", "thaw",
                      "enable", "disable", "reenable", "preset", "revert", "link", "mask", "unmask", "edit",
                      "set-property", "add-wants", "add-requires", "bind", "mount-image"}
SYSTEMCTL_VALUE_OPTIONS = ("tpPsHMCno", {
    "--type", "--property", "--state", "--signal", "--kill-whom", "--kill-value", "--kill-subgroup", "--what", "--job-mode", "--root",
    "--image", "--image-policy", "--host", "--machine", "--capsule", "--lines", "--output", "--preset-mode",
    "--timestamp", "--message", "--boot-loader-menu", "--boot-loader-entry", "--reboot-argument", "--drop-in", "--when",
    "--legend", "--check-inhibitors"})
# cp, mv and ln: the options that take a value.
COPY_OPTIONS = ("St", {"--suffix", "--target-directory", "--no-preserve", "--sparse"})
RECURSIVE = {"-r", "-R", "--recursive"}
SCHEDULERS = {"crontab", "at", "batch", "systemd-run"}
# pgrep/pkill options that take a value as the next word.
KILL_VALUE_OPTIONS = {"-d", "-g", "-G", "-P", "-s", "-t", "-u", "-U", "-F", "-r", "--delimiter", "--pgroup",
                      "--group", "--parent", "--session", "--terminal", "--euid", "--uid", "--pidfile", "--runstates",
                      "--signal", "--ns", "--nslist", "--env", "-q", "--queue", "-O", "--older", "--cgroup"}
# The label a session never removes: the owner's brake, which only someone other than the App lifts.
OWNER_LABEL = "needs-owner"
# The options of gh issue edit and gh pr edit that take a value.
GH_EDIT_VALUE_OPTIONS = ("RbFmtB", {"--repo", "--add-label", "--remove-label", "--add-assignee", "--remove-assignee",
                                     "--add-project", "--remove-project", "--add-reviewer", "--remove-reviewer",
                                     "--body", "--body-file", "--milestone", "--title", "--base", "--attach",
                                     "--add-blocked-by", "--remove-blocked-by", "--add-blocking", "--remove-blocking",
                                     "--add-sub-issue", "--remove-sub-issue", "--parent", "--type"})
# The shell variables a kill operand can name the shell itself ($$) or its parent, the Claude Code session ($PPID) by.
OWN_SHELL, OWN_SESSION = "the shell running the command", "the Claude Code session that runs the shell"
SELF_PIDS = {"$$": OWN_SHELL, "${$}": OWN_SHELL, "$PPID": OWN_SESSION, "${PPID}": OWN_SESSION}


class Word:
    def __init__(self, value="", dynamic=False):
        self.value = value
        self.dynamic = dynamic  # holds an unquoted or double-quoted $ or backquote, so its value is unknown
        self.quoted = False  # holds a quote or backslash, so it cannot be a file-descriptor number


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
            word.value += text[i + 1:i + 2]
            i += 2
            continue
        if c == "'":
            end = text.find("'", i + 1)
            if end < 0:
                raise Unbalanced(i)
            word = word or Word()
            word.quoted = True
            word.value += text[i + 1:end]
            i = end + 1
            continue
        if c == '"':
            word = word or Word()
            word.quoted = True
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
            if op[0] in "<>" and word is not None and not word.quoted and word.value.isdigit():
                word = None  # the 2 of 2>file or 2>&1 names a file descriptor, not an argument
            flush()
            tokens.append(("op", op))
            i += len(op)
            continue
        word = word or Word()
        if c == "$":
            word.dynamic = True
        word.value += c
        i += 1
    flush()
    return tokens


class Command:
    def __init__(self):
        self.words = []
        self.write_targets = []
        self.heredocs = []  # this command's own heredoc bodies, by index


def pipelines(tokens):
    """Groups tokens into pipelines of commands, and the separator that ends each pipeline."""
    pipeline, command, i = [], Command(), 0
    while i < len(tokens):
        kind, value = tokens[i]
        i += 1
        if kind == "word":
            command.words.append(value)
            continue
        if value in WRITE_REDIRECTS or value in OTHER_REDIRECTS or value == "<<":
            target = tokens[i][1] if i < len(tokens) and tokens[i][0] == "word" else None
            if target is None:
                continue
            i += 1
            if value == "<<":
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
        pipeline.append(command)
        yield pipeline, value
        pipeline, command = [], Command()
    pipeline.append(command)
    yield pipeline, None


def strip_prefix(words):
    """Drops variable assignments, reserved words and the wrappers (with their options and timeout's duration) before
    the command name."""
    i, wrapper = 0, None
    while i < len(words):
        value = words[i].value
        name = os.path.basename(value)
        if wrapper is not None and value == "--":
            wrapper = None  # the end of the wrapper's options
            i += 1
        elif wrapper is not None and value.startswith("-"):
            i += 1 + takes_value(wrapper, value)
        elif wrapper == "timeout":
            wrapper = None  # its duration
            i += 1
        elif re.match(r"[A-Za-z_]\w*=", value) or value in RESERVED:
            i += 1
        elif name in WRAPPERS:
            wrapper = name
            i += 1
        else:
            break
    return words[i:]


def takes_value(wrapper, option):
    """Whether the wrapper's option word leaves its value to the next word."""
    short, long = WRAPPER_VALUE_OPTIONS.get(wrapper, ("", set()))
    if option.startswith("--"):
        return option in long
    end = value_letter(option, short)
    return end == len(option) - 1


def value_letter(group, short_values):
    """The index in a short-option group word (`-qtc`) of its first letter that takes a value, which ends the group,
    or None when no letter does."""
    return next((j for j, c in enumerate(group[1:], 1) if c in short_values), None)


def split_options(args, short_values, long_values):
    """The operand words and the (option, value word or None) pairs of a GNU-style argument list. A short letter in
    short_values takes the rest of its group or the next word; a long name in long_values takes the next word unless
    its value is attached with `=`."""
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
                options.append((name, Word(attached, w.dynamic)))
            elif name in long_values and i < len(args):
                options.append((name, args[i]))
                i += 1
            else:
                options.append((name, None))
        else:
            end = value_letter(v, short_values)
            options += [("-" + letter, None) for letter in v[1:end]]
            if end is not None:
                value = None
                if v[end + 1:]:
                    value = Word(v[end + 1:], w.dynamic)
                elif i < len(args):
                    value, i = args[i], i + 1
                options.append(("-" + v[end], value))
    return files, options


def operands(words):
    return [w for w in words if not w.value.startswith("-") or w.value == "-"]


def expand_variables(text):
    """text with a leading $HOME, ${HOME} or another of PATH_VARIABLES replaced by its value, when it is set."""
    match = re.match(r"\$(?:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)\})(?=/|$)", text)
    name = match and (match.group(1) or match.group(2))
    value = os.environ.get(name) if name in PATH_VARIABLES else None
    return value + text[match.end():] if value else text


def literal_path(word, cwd):
    """The absolute path a word names, `..` and symlinks left as written; None when part of it is computed at run time
    (other than a leading PATH_VARIABLES), or it is relative and the directory is not known."""
    text = word.value
    if word.dynamic:
        text = expand_variables(text)
        if re.search(r"[$`]", text):
            return None
    text = os.path.expanduser(text)
    if os.path.isabs(text):
        return text
    return None if cwd is None else os.path.join(cwd, text)


class Findings:
    def __init__(self):
        self.writes = []  # (absolute path, whether every file under it, whether it removes the name, an edit)
        self.units = []  # systemctl --user invocations that change Triphammer's units, as their text
        self.kills = []  # (pkill or pgrep, pattern)
        self.signals = []  # (kill operand, the process it names)
        self.schedules = []  # crontab, at, batch and systemd-run invocations, as their text
        self.label_removals = []  # gh commands that take needs-owner off, as their text
        self.script_edits = []  # absolute paths a python or node script opens for writing

    def write(self, word, cwd, tree=False, removal=False, edit=True):
        path = literal_path(word, cwd)
        if path is not None:
            self.writes.append((path, tree, removal, edit and not removal))


def walk(cmd, cwd, findings):
    """Judges every command of the shell text. A relative path after a cd, pushd or popd is not judged."""
    text, bodies = strip_heredocs(cmd)
    try:
        tokens = tokenize(text)
    except Unbalanced as error:
        # bash runs every line before the one where the quote opens, then stops with a syntax error.
        try:
            tokens = tokenize(text[:max(text.rfind("\n", 0, error.start), 0)])
        except ValueError:
            return
    for pipeline, _ in pipelines(tokens):
        for command in pipeline:
            words = analyze(command, cwd, findings, bodies)
            if words and words[0].value in ("cd", "pushd", "popd"):
                cwd = None


def analyze(command, cwd, findings, bodies):
    """Judges one command, whose heredocs are among bodies; returns its words from the command name on."""
    for target in command.write_targets:
        findings.write(target, cwd)
    words = strip_prefix(command.words)
    if not words:
        return words
    name, args = os.path.basename(words[0].value), words[1:]
    values = [w.value for w in args]
    if name == "tee":
        for w in operands(args):
            findings.write(w, cwd)
    elif name in ("sed", "gsed") and any(re.match(r"-[nErsuz]*i|--in-place", v) for v in values):
        files, options = split_options(args, "efl", {"--expression", "--file", "--line-length"})
        scripted = any(option in ("-e", "--expression", "-f", "--file") for option, _ in options)
        for w in files if scripted else files[1:]:  # the script is the first operand unless -e or -f gives it
            findings.write(w, cwd)
    elif name in ("cp", "mv", "ln"):
        analyze_copy(name, args, cwd, findings)
    elif name == "rm":
        files, options = split_options(args, "", set())
        tree = any(option in RECURSIVE for option, _ in options)
        for w in files:
            findings.write(w, cwd, tree=tree, removal=True)
    elif name == "systemctl":
        analyze_systemctl(args, findings)
    elif name == "gh":
        analyze_gh(args, findings)
    elif name in SCHEDULERS and not (name == "crontab" and "-l" in values and not {"-e", "-r", "-i"} & set(values)):
        findings.schedules.append(f"`{' '.join([name] + values)}`")
    elif name in ("pkill", "pgrep"):
        analyze_kill(name, args, findings)
    elif name == "kill":
        analyze_signal(args, findings)
    elif (kind := re.sub(r"[\d.]*$", "", name)) in INTERPRETERS:
        for script in interpreter_scripts(kind, args, [bodies[i] for i in command.heredocs if i < len(bodies)]):
            for match in SCRIPT_WRITES.finditer(script):
                path = literal_path(Word(match.group(2) or match.group(4) or match.group(6), dynamic=True), cwd)
                if path is not None:
                    findings.script_edits.append(path)
    return words


def interpreter_scripts(kind, args, heredocs):
    """The script texts a python or node command runs: its -c or -e value, else its heredocs when it reads the script
    from stdin (no script file named, or `-`)."""
    script_letters, value_letters, long_values = INTERPRETERS[kind]
    i = 0
    while i < len(args):
        v, i = args[i].value, i + 1
        if v == "-" or not v.startswith("-"):
            return heredocs if v == "-" else []
        if v.startswith("--"):
            name, eq, attached = v.partition("=")
            if kind == "node" and name in ("--eval", "--print"):
                return [attached] if eq else [args[i].value] if i < len(args) else []
            i += not eq and name in long_values
            continue
        end = value_letter(v, script_letters + value_letters)
        if end is None:
            continue
        value = v[end + 1:]
        if not value and i < len(args):
            value, i = args[i].value, i + 1
        if v[end] in script_letters:
            return [value]
        if v[end] == "m":
            return []
    return heredocs


def analyze_copy(name, args, cwd, findings):
    """cp, mv and ln: the destination (or each source's name inside it), and the sources mv removes."""
    files, options = split_options(args, *COPY_OPTIONS)
    target_dir = next((value for option, value in reversed(options)
                       if option in ("-t", "--target-directory") and value is not None), None)
    edit = name != "ln"
    if target_dir is not None:
        sources, dest = files, target_dir
    elif name == "ln" and len(files) == 1:
        sources, dest = files, Word(".")  # ln TARGET links into the current directory
    elif len(files) >= 2:
        sources, dest = files[:-1], files[-1]
    else:
        return
    if name == "mv":
        for w in sources:
            findings.write(w, cwd, removal=True)
    directory = literal_path(dest, cwd)
    if target_dir is None and not (directory and os.path.isdir(directory)):
        findings.write(dest, cwd, edit=edit)
        return
    for w in sources:
        inside = Word(os.path.join(dest.value, os.path.basename(w.value.rstrip("/"))), dest.dynamic or w.dynamic)
        findings.write(inside, cwd, edit=edit)


def analyze_systemctl(args, findings):
    """systemctl --user daemon-reload and the like, or a verb that changes a Triphammer unit's state or files."""
    files, options = split_options(args, *SYSTEMCTL_VALUE_OPTIONS)
    if not files or "--user" not in {option for option, _ in options}:
        return
    verb, units = files[0].value, files[1:]
    if verb in SYSTEMCTL_GLOBAL:
        findings.units.append(f"systemctl --user {verb}")
    elif verb in SYSTEMCTL_CHANGING:
        named = [w.value for w in units if TRIPHAMMER_UNIT.fullmatch(os.path.basename(w.value))]
        if named:
            findings.units.append(f"systemctl --user {verb} {' '.join(named)}")


def analyze_gh(args, findings):
    """gh issue edit or gh pr edit with --remove-label naming needs-owner (in any case, also in a comma-separated list
    or as --remove-label=...)."""
    positional, i = [], 0
    while i < len(args) and len(positional) < 2:
        value = args[i].value
        i += 2 if value in ("-R", "--repo") else 1
        if not value.startswith("-"):
            positional.append(value)
    if positional not in (["issue", "edit"], ["pr", "edit"]):
        return
    _, options = split_options(args, *GH_EDIT_VALUE_OPTIONS)
    for option, value in options:
        if option == "--remove-label" and value is not None and any(
                label.strip().lower() == OWNER_LABEL for label in value.value.split(",")):
            findings.label_removals.append(f"`gh {' '.join(w.value for w in args)}`")
            return


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


def git(cwd, *args):
    env = dict(os.environ, GIT_OPTIONAL_LOCKS="0")
    try:
        result = subprocess.run(["git", "-C", cwd, *args], capture_output=True, timeout=3, env=env)
    except Exception:
        return None
    return result.stdout if result.returncode == 0 else None


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


def tracked_edits(paths, cwd):
    """The edited paths that are git-tracked files under the shell-edit roots of the repository cwd lies in."""
    if not paths or cwd is None or not os.path.isdir(cwd):
        return []
    out = git(cwd, "rev-parse", "--show-toplevel")
    if not out:
        return []
    top = os.path.realpath(out.decode().strip())
    roots = edit_roots(top)
    rels = {rel for rel in (os.path.relpath(os.path.realpath(path), top).replace(os.sep, "/") for path in paths)
            if any(rel == root or rel.startswith(root + "/") for root in roots)}
    if not rels:
        return []
    out = git(top, "--literal-pathspecs", "ls-files", "-z", "--", *sorted(rels))
    return sorted(set(out.decode(errors="replace").split("\0")) & rels) if out else []


def shared_dir():
    """Triphammer's shared state directory: $TRIPHAMMER_SHARED_DIR, else ${XDG_STATE_HOME:-~/.local/state}/triphammer."""
    state = os.environ.get("XDG_STATE_HOME") or os.path.join(os.path.expanduser("~"), ".local", "state")
    return os.environ.get("TRIPHAMMER_SHARED_DIR") or os.path.join(state, "triphammer")


def configured_state_dirs(home):
    """The STATE_DIR every Triphammer config in ${XDG_CONFIG_HOME:-~/.config}/triphammer sets (bin/README.md,
    Configuration): a `STATE_DIR=` line whose value is an absolute path, taken verbatim. A file that is missing,
    unreadable or malformed adds nothing."""
    config = os.environ.get("XDG_CONFIG_HOME") or os.path.join(home, ".config")
    paths = []
    for path in sorted(glob.glob(os.path.join(glob.escape(os.path.join(config, "triphammer")), "*.conf")))[:64]:
        try:
            if not os.path.isfile(path):  # a FIFO would block the read
                continue
            with open(path, encoding="utf-8", errors="replace") as file:
                text = file.read(1 << 16)
        except Exception:
            continue
        paths += [match.group(1) for line in text.split("\n") for match in [re.fullmatch(r"STATE_DIR=(/.*)", line)]
                  if match]
    return paths


def persistence_roots():
    """The directories that hold Triphammer's persistence: its installed scripts, units, config and state."""
    home = os.path.expanduser("~")
    config = [os.path.join(home, ".config")] + ([os.environ["XDG_CONFIG_HOME"]] if os.environ.get("XDG_CONFIG_HOME")
                                                else [])
    roots = [os.path.join(home, ".local", "bin"), os.path.join(home, ".local", "state", "ticket-runner"),
             shared_dir()] + configured_state_dirs(home)
    roots += [os.path.join(c, sub) for c in config for sub in (os.path.join("systemd", "user"), "triphammer")]
    return {os.path.normpath(r) for root in roots if os.path.isabs(root) for r in (root, os.path.realpath(root))}


def persistence_changes(writes):
    """The written paths inside a persistence directory, as written or with symlinks resolved, or for a tree change
    holding one."""
    roots = persistence_roots()

    def inside(candidate, tree):
        return any(within(candidate, root) or tree and within(root, candidate) for root in roots)
    return list(dict.fromkeys(os.path.normpath(path) for path, tree, _, _ in writes
                              if inside(os.path.normpath(path), tree) or inside(os.path.realpath(path), tree)))


def environment_of(pid):
    """The environment process pid started with (/proc/<pid>/environ), which nothing it does later changes."""
    with open(f"/proc/{pid}/environ", "rb") as file:
        data = file.read(1 << 20)
    pairs = (item.partition(b"=") for item in data.split(b"\0"))
    return {key.decode(errors="replace"): value.decode(errors="replace") for key, eq, value in pairs if eq}


@functools.cache
def triphammer_sessions():
    """The places each Triphammer session this hook runs under may write: (its clone's real path or None, its temporary
    directories' real paths), one for the hook's own environment and one for each parent process that started with
    $TRIPHAMMER_SESSION set; a write must fit every one. Empty in an interactive session."""
    environments = [dict(os.environ)]
    for pid in ancestors():
        try:
            environments.append(environment_of(pid))
        except Exception:
            continue
    sessions = set()
    for env in environments:
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


def outside_session(path, removal=False):
    """Whether a Triphammer session may not write path: its real path (for a removal, its directory's real path and its
    own name) lies outside the clone or in its .git, and outside the temporary directories, of some session."""
    if DEVICES.fullmatch(os.path.normpath(path)):
        return False
    name = os.path.basename(path)
    if removal and name not in ("", ".", ".."):
        real = os.path.join(os.path.realpath(os.path.dirname(path)), name)
    else:
        real = os.path.realpath(path)
    for worktree, temps in triphammer_sessions():
        in_worktree = worktree is not None and within(real, worktree) and not within(real, os.path.join(worktree, ".git"))
        if not in_worktree and not any(within(real, temp) for temp in temps):
            return True
    return False


def session_places():
    worktrees = sorted({worktree for worktree, _ in triphammer_sessions() if worktree})
    return (f"{' and '.join(worktrees) or 'no worktree (its $' + SESSION_MARKER + ' names no directory)'}, apart from "
            f"its .git, and $TMPDIR, /tmp and /var/tmp")


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
    cwd = cwd if isinstance(cwd, str) and os.path.isabs(cwd) else None
    findings = Findings()
    walk(cmd, cwd, findings)
    persistence = findings.units + persistence_changes(findings.writes)
    if persistence:
        return (f"agent-guard persistence rule: this command changes Triphammer's persistence "
                f"({listed(persistence)}). Agents never install or change Triphammer's systemd units, the scripts in "
                f"~/.local/bin, its config or its state; the owner does that. Leave the change to the owner and report "
                f"it. If the command is text you meant to write to a file, a heredoc terminator that turns up early in "
                f"that text (or an unbalanced quote) runs the rest as commands: pick a unique terminator.")
    if triphammer_sessions():
        outside = list(dict.fromkeys(os.path.normpath(path) for path, _, removal, _ in findings.writes
                                     if outside_session(path, removal)))
        if outside:
            return (f"agent-guard worktree-only rule: this command writes or removes {listed(outside)}, outside the "
                    f"places a session Triphammer started may write: {session_places()}. Write inside the worktree or "
                    f"a temporary directory, and leave a change anywhere else to the owner and report it.")
        if findings.schedules:
            return (f"agent-guard scheduler rule: {listed(findings.schedules)} schedules a command to run later, "
                    f"outside the session, which a session Triphammer started never does (`crontab -l` stays "
                    f"allowed). Run the command now, or leave it to the owner and report it.")
        if findings.label_removals:
            return (f"agent-guard needs-owner rule: {listed(findings.label_removals)} takes `needs-owner` off an "
                    f"issue or pull request, which a session Triphammer started never does: the label stops work for "
                    f"the owner, and only someone other than the App lifts it. Leave the label in place, comment on "
                    f"the issue what you need from the owner, and end.")
    if findings.kills:
        name, pattern = findings.kills[0]
        effect = "kills that shell (exit code 144)" if name == "pkill" else "lists that shell as well"
        return (f"agent-guard self-kill rule: `{name} -f {pattern}` also matches the command line of the shell that "
                f"runs it, so it {effect}. Write the pattern in bracket form (`{name} -f '{bracket(pattern)}'`), "
                f"kill the PID you saved when you started the process (`kill \"$pid\"`), or use `kill %1` for a job "
                f"this shell started.")
    if findings.signals:
        target, process = findings.signals[0]
        return (f"agent-guard self-kill rule: `kill {target}` signals {process}, so it ends the command or the "
                f"session itself. Kill the PID you saved when you started the process (`kill \"$pid\"`), or use "
                f"`kill %1` for a job this shell started.")
    files = tracked_edits([path for path, _, _, edit in findings.writes if edit] + findings.script_edits, cwd)
    if files:
        return (f"{SHELL_EDIT_RULE}: this command rewrites git-tracked {listed(files, 5, ', ')} through the "
                f"shell. Make the change with Edit (or Write for a new or wholly replaced file), so the language "
                f"server's diagnostics arrive after it. If the shell really is the right tool, rerun it with "
                f"`# guard-override: <reason>` appended.")
    return None


def decide_file(tool, path, cwd):
    """The refusal of a file tool's write of path, or None."""
    if not isinstance(path, str) or not path:
        return None
    cwd = cwd if isinstance(cwd, str) and os.path.isabs(cwd) else None
    path = literal_path(Word(path), cwd)
    if path is None:
        return None
    if persistence_changes([(path, False, False, True)]):
        return (f"agent-guard persistence rule: this {tool} changes Triphammer's persistence "
                f"({os.path.normpath(path)}). Agents never install or change Triphammer's systemd units, the scripts in "
                f"~/.local/bin, its config or its state; the owner does that. Leave this change to the owner and report "
                f"it.")
    if triphammer_sessions() and outside_session(path):
        return (f"agent-guard worktree-only rule: this {tool} writes {os.path.normpath(path)}, outside the places a "
                f"session Triphammer started may write: {session_places()}. Leave a change anywhere else to the owner "
                f"and report it.")
    return None


def log_override(session_id, reason, cmd):
    """Append the override the hook honors to guard-overrides.log in the shared state directory; a failure goes to
    stderr and leaves the decision alone."""
    log = os.path.join(shared_dir(), OVERRIDE_LOG)
    entry = {"time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
             "session": {"session_id": session_id if isinstance(session_id, str) else None,
                         SESSION_MARKER: os.environ.get(SESSION_MARKER)},
             "rule": "shell-edit", "reason": reason.strip(), "command": cmd}
    try:
        if not os.path.isabs(log):
            raise OSError(f"{log} is not an absolute path")
        os.makedirs(os.path.dirname(log), exist_ok=True)
        fd = os.open(log, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        with os.fdopen(fd, "a", encoding="utf-8") as out:
            out.write(json.dumps(entry) + "\n")
    except Exception as error:
        print(f"agent-guard: could not log the override to {log}: {error}", file=sys.stderr)


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        return
    if not isinstance(data, dict) or not isinstance(data.get("tool_input"), dict):
        return
    tool, tool_input, cwd = data.get("tool_name"), data["tool_input"], data.get("cwd")
    if tool in FILE_TOOLS:
        reason = decide_file(tool, tool_input.get("file_path") or tool_input.get("notebook_path"), cwd)
    elif tool == "Bash" and isinstance(tool_input.get("command"), str):
        reason = decide(tool_input["command"], cwd)
    else:
        return
    override = OVERRIDE.search(tool_input["command"]) if tool == "Bash" and reason else None
    if override and reason.startswith(SHELL_EDIT_RULE):
        log_override(data.get("session_id"), override.group(1), tool_input["command"])
        reason = None
    if reason:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                                 "permissionDecisionReason": reason}}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
