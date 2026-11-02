#!/usr/bin/env python3
# Claude Code hook, part of the Triphammer plugin (its hooks/hooks.json runs it; a project's .claude/settings.json may
# run it too), for the text agents post: pull request and issue titles and bodies, and commit messages.
#
# PreToolUse on Bash: checks `gh pr create|new|edit`, `gh issue create|new|edit` (and glab's mr/issue
# create|new|edit|update) and `git commit`. Each command of a list, pipeline, subshell or substitution is found by its
# words, parsed by agent-guard.py's shell parsing (loaded from beside this file): after variable assignments and the
# wrappers it strips (sudo, env, command, nohup, time and timeout, with their options), named
# by its name or any path to it, quoted or escaped, with gh's -R/--repo and git's options (-C, -c, --no-pager...)
# before the subcommand. The text comes from --title/-t and --body/-b (glab: --description/-d), git's -m/--message,
# a heredoc the command reads, or a --body-file/-F file; a value may be the next word, attached (`-b'text'`, `-am msg`)
# or after `=`, and when an option repeats its last value counts, as gh reads it (git joins its -m values). A `<<WORD`
# inside quotes or a comment is text, not a heredoc. A quote that never closes makes bash refuse the whole command, but
# the commands are still checked as if it closed at the end. A command with -h or --help, and `git commit --amend
# --no-edit` with no -m, -F, -c or -C (it keeps the message it has), post nothing new and are not checked. A
# --body-file that does not exist is refused, so the check cannot be skipped by writing the file in the same command.
# A relative file is read from the directory the command runs in: the hook's cwd, moved by git's -C and by each
# `cd <path>` before it in the same shell (not one in a pipeline, in the background or in a subshell or `{ }` group it
# has left). Such a cd moves it only when the cd certainly runs and its directory exists: it starts a list (at the
# start, after `;`, a newline or `&`, or first in a subshell or `{ }` group that itself certainly runs) or follows `&&`
# after a cd that certainly ran, and is in no if, loop, case or function body. Any other cd (after `&&` or `||` from
# another command, inside such a body, or to a directory that does not exist yet) leaves the directories it may have
# run from too: the file is checked in each of them, and refused as missing only when it is missing from all. After a
# cd it cannot follow (no path, an option, `-`, a computed path, followed by `||`) or a pushd or popd, a relative file
# is not judged, as agent-guard.py does: its text is not checked and it is not refused as missing.
# Not covered: a command run by bash -c, eval, xargs, a script or a gh alias, git's abbreviated long options (--mess),
# and a value given by an unquoted substitution (--body $(cat f)) or computed when it runs.
# Text that breaks a rule is refused with every rule it breaks:
#
#   upstream    DASH, TEST_PLAN, WORTH_KNOWING, CONTEXT_SOLUTION, FIX_FRAMING (not for issues, nor for a title or
#               branch starting with fix/hotfix), TABLE and HARD_WRAP (pull requests and issues), REVIEW_TITLE.
#   repository  for pull requests: FOOTER (no "Generated with Claude Code"), CO_AUTHORED_BY (commits carry the
#               trailer through scripts/git-hooks/commit-msg and GitHub adds it to the squash commit), SECTIONS (no
#               Checks, Decisions, Reviewer notes, Evidence or Test plan section: those go in a PR comment), and for
#               `gh pr create` CLOSES (the last non-empty line is `Closes #N`).
#   HUMANIZER   `gh pr create`, and `gh pr edit` with --title, --body or --body-file, need a run of the
#               `humanizer:humanizer` skill earlier in the same session (subagents share the session_id). A missing or
#               unreadable state directory refuses with the reason.
#
# Code spans and fenced blocks are not prose. `gh pr comment` and issue comments are not checked.
# `# text-lint-override: <reason>` anywhere in the command lets that one command through. Anything else the hook cannot
# work out (malformed input, an exception, agent-guard.py missing) allows the command: it
# never blocks on its own failure, except that the humanizer gate refuses when it cannot read its state.
#
# PostToolUse on Skill: records a run of the humanizer skill for the session_id in the state directory,
# $TRIPHAMMER_HUMANIZER_STATE or ${XDG_STATE_HOME:-~/.local/state}/triphammer/humanizer, outside the repository.
#
# Reads the hook's JSON on stdin; prints a deny decision or nothing, and always exits 0.
#
# The upstream rules, the text extraction and the missing --body-file refusal are adapted from text-lint.py in
# https://github.com/rezk2ll/skills (plugins/text-lint/scripts/text-lint.py, commit bf99b4b), used under the MIT
# License:
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
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys

OVERRIDE = re.compile(r"#\s*text-lint-override:\s*\S")
OVERRIDE_HINT = "To post it anyway, append `# text-lint-override: <reason>` to the command."
STATE_ENV = "TRIPHAMMER_HUMANIZER_STATE"
HUMANIZER_SKILLS = {"humanizer", "humanizer:humanizer"}
HUMANIZER_INSTALL = ("The humanizer plugin is not installed for this user: ask the owner to run "
                     "`/plugin marketplace add blader/humanizer`, then `/plugin install humanizer@humanizer`.")

# The commands that post text: (tool, group) to kind, and each verb (with its alias) to the verb it is.
KINDS = {("gh", "pr"): "pr", ("glab", "mr"): "pr", ("gh", "issue"): "issue", ("glab", "issue"): "issue"}
VERBS = {"create": "create", "new": "create", "edit": "edit", "update": "update"}
# Per tool: the short option letters that take a value (attached, `-tTitle`, or the next word), the long options that
# take the next word as their value, and the options that carry the title, the body and the body file.
GH = ("aBbFHlmpRrTt", {"--repo", "--title", "--body", "--body-file", "--base", "--head", "--assignee", "--label",
                       "--milestone", "--project", "--reviewer", "--template", "--recover"},
      ("-t", "--title"), ("-b", "--body"), ("-F", "--body-file"))
GLAB = ("abdeFilmRst", {"--repo", "--title", "--description", "--body-file", "--target-branch", "--source-branch",
                        "--assignee", "--label", "--milestone", "--reviewer"},
        ("-t", "--title"), ("-d", "--description"), ("-F", "--body-file"))
TOOLS = {"gh": GH, "glab": GLAB}
# git commit's: -S and -u take a value only attached, so the rest of their group is theirs.
COMMIT_OPTIONS = ("mFcCt", {"--message", "--file", "--author", "--date", "--cleanup", "--trailer", "--fixup",
                            "--squash", "--reuse-message", "--reedit-message", "--template", "--pathspec-from-file"})
ATTACHED_ONLY = {"git": "Su"}
# git's options before the subcommand that take the next word as their value.
GIT_VALUE_OPTIONS = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix",
                     "--attr-source", "--list-cmds"}
# git commit --amend --no-edit keeps the commit's message unless one of these gives another.
MESSAGE_SOURCES = {"-m", "--message", "-F", "--file", "-c", "-C", "--reuse-message", "--reedit-message"}
# Separators after which a command starts a list of the shell it runs in, so nothing before it decides whether it runs.
LIST_STARTS = {None, ";", "\n", "&", "(", "$(", "<(", "`"}
# Reserved words that open a compound command, and those that close one; `function` opens its body.
OPENERS = {"if", "while", "until", "for", "select", "case", "function", "{"}
CLOSERS = {"fi", "done", "esac", "}"}
UNKNOWN = object()  # the text of a file whose directory is not known
MARKER = re.compile(r"\x00(\d+)\x00")  # agent-guard's mark of a heredoc body, also inside a word: "$(cat <<EOF ...)"

FIX_PHRASES = [r"until now", r"previously", r"never reached", r"was missing", r"were missing",
               r"nothing (did|sent|was|reached|published|handled)", r"had no way to", r"there was no way to"]
SECTION_NAMES = r"checks|decisions|reviewer notes|evidence|test plan"
SECTION = re.compile(rf"^\s*(?:#+\s*|\*\*\s*)({SECTION_NAMES})\b", re.I | re.M)


class Refused(Exception):
    pass


def state_dir():
    configured = os.environ.get(STATE_ENV)
    if configured:
        return configured
    base = os.environ.get("XDG_STATE_HOME") or os.path.join(os.path.expanduser("~"), ".local", "state")
    return os.path.join(base, "triphammer", "humanizer")


def marker(session_id):
    return hashlib.sha256(session_id.encode()).hexdigest()


def record_humanizer_run(data):
    tool_input = data.get("tool_input")
    skill = tool_input.get("skill") if isinstance(tool_input, dict) else None
    session_id = data.get("session_id")
    if skill not in HUMANIZER_SKILLS or not isinstance(session_id, str) or not session_id:
        return
    path = state_dir()
    os.makedirs(path, mode=0o700, exist_ok=True)
    with open(os.path.join(path, marker(session_id)), "w") as f:
        f.write(skill + "\n")


def humanizer_installed():
    config = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")
    try:
        with open(os.path.join(config, "plugins", "installed_plugins.json")) as f:
            plugins = json.load(f).get("plugins", {})
        return any(str(name).split("@")[0] == "humanizer" for name in plugins)
    except Exception:
        return False


def humanizer_gap(session_id):
    """None when this session ran the humanizer skill, otherwise why the command is refused."""
    run = ("Run the `humanizer:humanizer` skill (Skill tool) in its embedded mode on the title and description, post "
           "the text it returns (code spans, paths and `Closes #N` as they were), and retry.")
    if not humanizer_installed():
        run += " " + HUMANIZER_INSTALL
    path = state_dir()
    if not isinstance(session_id, str) or not session_id:
        return f"HUMANIZER: the hook input has no session_id, so no humanizer run can be found for it. {run}"
    if not os.path.isdir(path):
        return (f"HUMANIZER: no humanizer run is recorded: the state directory {path} does not exist or is not a "
                f"directory (the PostToolUse hook on Skill creates it on the first run). {run}")
    try:
        names = set(os.listdir(path))
    except OSError as error:
        return (f"HUMANIZER: the state directory {path} cannot be read ({error.strerror}), so this session's humanizer "
                f"run cannot be checked. Fix its permissions, then: {run}")
    if marker(session_id) not in names:
        return f"HUMANIZER: the humanizer skill has not run in this session. {run}"
    return None


def load_guard():
    """agent-guard.py beside this hook, whose shell parsing (strip_heredocs, tokenize, pipelines, strip_prefix) finds
    the commands here."""
    sys.dont_write_bytecode = True  # no __pycache__ in the plugin's directory
    spec = importlib.util.spec_from_file_location(
        "agent_guard", os.path.join(os.path.dirname(os.path.abspath(__file__)), "agent-guard.py"))
    guard = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(guard)
    return guard


def read_options(args, short_values, long_values, attached_only=""):
    """The (option, value) pairs of args in order, and whether they ask for help (-h, --help). A long option's value
    follows `=` or, when it is in long_values, is the next word; a short letter in short_values takes the rest of its
    group (`-b'text'`, `-am msg`) or else the next word; one in attached_only ends the group, which is its value."""
    pairs, i = [], 0
    while i < len(args):
        value = args[i].value
        i += 1
        if value == "--":
            break
        if value in ("-h", "--help"):
            return pairs, True
        if value.startswith("--"):
            name, eq, attached = value.partition("=")
            if eq:
                pairs.append((name, attached))
            elif name in long_values and i < len(args):
                pairs.append((name, args[i].value))
                i += 1
        elif value.startswith("-") and len(value) > 1:
            for j, letter in enumerate(value[1:], 2):
                if letter in attached_only:
                    break
                if letter in short_values:
                    if j < len(value):
                        pairs.append(("-" + letter, value[j:]))
                    elif i < len(args):
                        pairs.append(("-" + letter, args[i].value))
                        i += 1
                    break
    return pairs, False


def recover_tokens(guard, text):
    """text's tokens. When a quote never closes, bash stops with a syntax error and runs no command of that list;
    its commands are still read, as if the quote closed at the end, so a stray quote cannot hide one from the check."""
    for _ in range(8):
        try:
            return guard.tokenize(text)
        except guard.Unbalanced as error:
            text += text[error.start]
    return guard.tokenize(text[:max(text.rfind("\n", 0, error.start), 0)])


def resolve(guard, word, directories):
    """The directories a path word names from each of directories, as agent-guard.py reads a path; None when one is
    unknown."""
    targets = [guard.literal_path(word, directory) for directory in directories or (None,)]
    return None if None in targets else tuple(dict.fromkeys(targets))


def changed_directories(guard, words, directories, certain):
    """The directories the shell may be in after a cd, pushd or popd run from directories, or None (unknown): those
    `cd <path>` names when it can be read as agent-guard.py reads a path, joined by the ones it ran from when it may
    not run or its directory does not exist yet."""
    args = words[1:]
    if args and args[0].value == "--":
        args = args[1:]
    if words[0].value != "cd" or len(args) != 1 or args[0].value.startswith("-"):
        return None  # pushd, popd, cd to $HOME or $OLDPWD, or with options
    targets = resolve(guard, args[0], directories)
    if targets is None:
        return None
    targets = tuple(dict.fromkeys(os.path.normpath(target) for target in targets))
    if certain and all(os.path.isdir(target) for target in targets):
        return targets
    return None if directories is None else tuple(dict.fromkeys(directories + targets))


def posting_commands(cmd, cwd):
    """(tool, kind, verb, options, heredoc, directories) for each command in cmd that posts text, found by its words
    after any assignments and wrappers: options as read_options returns them, heredoc the first heredoc body it reads
    (also one inside a word, as in --body "$(cat <<'EOF' ...)"), directories the absolute ones its relative files may be
    read from, or None when a cd made it unknown."""
    guard = load_guard()
    text, bodies = guard.strip_heredocs(cmd)
    directories = (cwd,) if isinstance(cwd, str) and os.path.isabs(cwd) else None
    outer, before = [], None  # the directories of the shells each open subshell or substitution was entered from
    blocks = []  # (whether it certainly runs, the directories before it, in a pipeline) for each open compound command
    after_cd = False  # the last list element was a cd that certainly ran, so one after its && does too
    for pipeline, separator in guard.pipelines(recover_tokens(guard, text)):
        starts = before in LIST_STARTS or before == "&&" and after_cd
        after_cd = False
        for command in pipeline:
            for word in command.words:  # the reserved words that open or close a compound command before its name
                if word.value in OPENERS:  # only `{` certainly runs, when it starts its list (a function body,
                    certain = word.value == "{" and starts and all(c for c, _, _ in blocks)  # f() {, does not)
                    blocks.append((certain, directories, len(pipeline) > 1))
                elif word.value in CLOSERS and blocks:
                    _, entered, piped = blocks.pop()
                    if piped or len(pipeline) > 1 or separator == "&":
                        directories = entered  # it ran in a subshell: a cd inside ends with it
                elif word.value not in ("then", "else", "elif", "do", "!"):
                    break
            words = guard.strip_prefix(command.words)
            if not words:
                continue
            if words[0].value in ("cd", "pushd", "popd"):
                if len(pipeline) == 1 and separator != "&":  # a pipeline's or background job's cd runs in a subshell
                    certain = starts and all(c for c, _, _ in blocks)
                    if separator == "||":  # what follows runs only when it failed
                        directories = None
                    else:
                        after = changed_directories(guard, words, directories, certain)
                        after_cd = certain and after is not None and all(os.path.isdir(d) for d in after)
                        directories = after
                continue
            tool, args, here, i = os.path.basename(words[0].value), words[1:], directories, 0
            if tool in TOOLS:
                positional = []  # the group and the verb, around -R/--repo and other options
                while i < len(args) and len(positional) < 2:
                    value = args[i].value
                    if value in ("-h", "--help", "--"):
                        break
                    i += 2 if value in ("-R", "--repo") else 1
                    if not value.startswith("-"):
                        positional.append(value)
                kind = KINDS.get(tuple([tool] + positional[:1])) if len(positional) == 2 else None
                verb = VERBS.get(positional[1]) if kind else None
                if not verb:
                    continue
                short, long = TOOLS[tool][:2]
            elif tool == "git":
                while i < len(args) and args[i].value.startswith("-"):
                    value = args[i].value
                    if value == "-C" and i + 1 < len(args):
                        here = resolve(guard, args[i + 1], here)
                    i += 2 if value in GIT_VALUE_OPTIONS else 1
                if i >= len(args) or args[i].value != "commit":
                    continue
                amend_as_is = {"--amend", "--no-edit"} <= {w.value for w in args[i + 1:]}
                kind, verb, (short, long) = "commit", "commit", COMMIT_OPTIONS
                i += 1
            else:
                continue
            options, helped = read_options(args[i:], short, long, ATTACHED_ONLY.get(tool, ""))
            if helped:
                continue  # prints help and posts nothing
            if kind == "commit" and amend_as_is and not {name for name, _ in options} & MESSAGE_SOURCES:
                continue  # keeps the message it has
            marks = list(command.heredocs) + [int(k) for w in words for k in MARKER.findall(w.value)]
            heredoc = next((bodies[k] for k in marks if k < len(bodies)), None)
            yield tool, kind, verb, options, heredoc, here
        top = outer[-1][0] if outer else None
        if separator == "`" and top == "`" or separator == ")" and top not in (None, "`"):
            directories = outer.pop()[1]  # a cd inside ends with the subshell
        elif separator in ("(", "$(", "<(", "`"):
            outer.append((separator, directories))
        before = separator


def lint(cmd, cwd, session_id):
    """(kind, failures) for the first command in cmd that posts text breaking a rule, or None. A command whose relative
    file may be read from more than one directory is checked in each, and refused as missing only when it is missing
    from every one."""
    for tool, kind, verb, options, heredoc, directories in posting_commands(cmd, cwd):
        candidates, missing = directories or (None,), []
        for directory in candidates:
            try:
                result = lint_command(tool, kind, verb, options, heredoc, directory, session_id)
            except Refused as refusal:
                missing.append(refusal)
                continue
            if result:
                return result
        if len(missing) == len(candidates):
            raise missing[0]
    return None


def lint_command(tool, kind, verb, options, heredoc, directory, session_id):
    def values(names):
        return [value for name, value in options if name in names]

    def last(names):
        found = values(names)
        return found[-1] if found else None

    def file_text(names):
        path = last(names)
        if not path or path == "-":
            return None  # stdin: the heredoc carries the text
        full = os.path.expanduser(path)
        if not os.path.isabs(full):
            if directory is None:
                return UNKNOWN  # relative to a directory a cd made unknown: not judged, as agent-guard.py does
            full = os.path.join(directory, full)
        try:
            with open(full) as f:
                return f.read()
        except OSError:
            raise Refused(f"text-lint: BODY FILE {path} does not exist yet, so nothing can be checked. Write it with "
                          f"the Write tool first, then run the command on its own, with a literal path.")

    if kind == "commit":
        msg = file_text(["-F", "--file"])
        msg = "" if msg is UNKNOWN else msg or heredoc or "\n\n".join(values(["-m", "--message"]))
        title, _, body = msg.partition("\n")
        text_options = []
    else:
        title_flags, body_flags, file_flags = TOOLS[tool][2:]
        title = last(title_flags) or ""
        body = file_text(file_flags)
        body = None if body is UNKNOWN else body or heredoc or last(body_flags) or ""
        text_options = values(title_flags + body_flags + file_flags)

    fail = []
    if (tool, kind) == ("gh", "pr") and (verb == "create" or verb == "edit" and text_options):
        gap = humanizer_gap(session_id)
        if gap:
            fail.append(gap)

    if title or body:
        fail = text_failures(kind, verb, title, body, directory) + fail
    return (kind, fail) if fail else None


def text_failures(kind, verb, title, body, cwd):
    """The rules title and body break; body None is a body that cannot be read, whose rules are not checked."""
    try:
        branch = subprocess.run(["git", "-C", cwd, "branch", "--show-current"], capture_output=True, text=True,
                                timeout=3).stdout.strip() if cwd and os.path.isdir(cwd) else ""
    except Exception:
        branch = ""
    is_fix = bool(re.match(r"(hot)?fix\b", title, re.I) or re.match(r"(hot)?fix/", branch))
    is_adr = bool(re.search(r"\badr\b", title, re.I))

    prose = re.sub(r"```.*?```", "", body or "", flags=re.S)
    prose = re.sub(r"`[^`\n]*`", "", prose)
    text = title + "\n" + prose
    fail = []

    if re.search(r"[—–]| -- ", text):
        fail.append("DASH: em-dash, en-dash or ' -- ' in prose. Use a comma, parentheses or a period.")

    test_plan = re.search(r"^#+\s*test plan", prose, re.I | re.M)
    if test_plan:
        fail.append("TEST PLAN: no Test plan section, CI is the test plan.")

    if re.search(r"^#+\s*worth knowing", prose, re.I | re.M):
        fail.append("WORTH KNOWING: drop the section. If a caveat blocks the reviewer, say it in one line.")

    if (kind == "pr" and not is_fix and not is_adr
            and re.search(r"^#+\s*(context|problem|solution)\b", prose, re.I | re.M)):
        fail.append("CONTEXT/SOLUTION on a non-fix PR: say what the change adds in one or two sentences.")

    if kind != "issue" and not is_fix:
        hit = re.search(r"\b(%s)\b" % "|".join(FIX_PHRASES), text, re.I)
        if hit:
            fail.append(f"FEATURE FRAMED AS A FIX ('{hit.group(0)}'): describe what it adds, in the present tense.")

    if kind != "commit" and re.search(r"^\s*\|.*\|\s*\n\s*\|[\s:|-]+\|\s*$", prose, re.M):
        fail.append("TABLE: use bullets.")

    if kind != "commit":
        lines = prose.splitlines()

        def plain(line):
            return line.strip() and not re.match(r"\s*([-*+>#|]|\d+\.)", line)

        if any(plain(a) and plain(b) and len(a) >= 50 and not a.rstrip().endswith((".", ":", "?", "!"))
               for a, b in zip(lines, lines[1:])):
            fail.append("HARD WRAP: a paragraph is broken over several lines. Put each paragraph on one line.")

    if re.search(r"\b(address(ed|ing)? (the )?review|apply suggestions|review (comments|feedback|fixes)|fix review)\b",
                 title, re.I):
        fail.append(f"TITLE '{title}': say what changed, not that it answers a review.")

    if kind == "pr":
        if re.search(r"generated with \[?claude code", text, re.I):
            fail.append("FOOTER: remove the 'Generated with Claude Code' line. The description is the squash commit "
                        "message.")
        if re.search(r"^\s*co-authored-by:", prose, re.I | re.M):
            fail.append("CO-AUTHORED-BY: remove the Co-Authored-By line from the description. Your commits carry the "
                        "trailer and GitHub adds it to the squash commit.")
        sections = {m.group(1).lower() for m in SECTION.finditer(prose)}
        if test_plan and not re.search(r"^\s*\*\*\s*test plan\b", prose, re.I | re.M):
            sections.discard("test plan")
        if sections:
            fail.append(f"SECTIONS ({', '.join(sorted(sections))}): the description says what changed and why. Put "
                        f"checks, review rounds, the risk tier, evidence and decisions in a PR comment "
                        f"(`gh pr comment`).")
        if verb == "create" and body is not None:
            lines = [line for line in body.splitlines() if line.strip()]
            if not lines or not re.fullmatch(r"\s*closes #\d+\s*", lines[-1], re.I):
                fail.append("CLOSES: the last non-empty line of the description must be `Closes #N`, with nothing "
                            "after it.")
    return fail


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        return
    if not isinstance(data, dict):
        return
    if data.get("tool_name") == "Skill" and data.get("hook_event_name") == "PostToolUse":
        record_humanizer_run(data)
        return
    if data.get("tool_name") != "Bash":
        return
    tool_input = data.get("tool_input")
    cmd = tool_input.get("command") if isinstance(tool_input, dict) else None
    if not isinstance(cmd, str) or OVERRIDE.search(cmd):
        return
    try:
        result = lint(cmd, data.get("cwd"), data.get("session_id"))
    except Refused as refusal:
        reason = str(refusal)
    else:
        if not result:
            return
        kind, fail = result
        reason = f"text-lint refused this {kind}.\n\n" + "\n".join(f"{i}. {f}" for i, f in enumerate(fail, 1))
        reason += f"\n\nFix the text. {OVERRIDE_HINT}"
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                             "permissionDecisionReason": reason}}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
