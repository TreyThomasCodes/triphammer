#!/usr/bin/env python3
# Claude Code hook, part of the Triphammer plugin (its hooks/hooks.json runs it; a project's .claude/settings.json may
# run it too), for the text agents post: pull request and issue titles and bodies, and commit messages.
#
# PreToolUse on Bash: checks `gh pr create|edit`, `gh issue create|edit` (and glab's mr/issue create|edit|update) and
# `git commit`. The text comes from --title/-t, --body/-b, -m/--message, a heredoc, or a --body-file/-F file. A
# --body-file that does not exist is refused, so the check cannot be skipped by writing the file in the same command.
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
# work out (malformed input, an exception) allows the command: it never blocks on its own failure, except that the
# humanizer gate refuses when it cannot read its state.
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

# Only at command position (after optional VAR=value assignments): a script or heredoc that merely mentions the
# command is not one.
AT = r"(?:^|[;&|(]\s*|\n\s*)(?:[A-Za-z_]\w*=\S*\s+)*"
PR = re.compile(AT + r"(gh pr|glab mr) (create|edit|update)\b")
ISSUE = re.compile(AT + r"(gh|glab) issue (create|edit|update)\b")
COMMIT = re.compile(AT + r"git(?:\s+-C\s+\S+)?\s+commit\b")
GATED_PR = re.compile(AT + r"gh pr (create|edit)\b")
HEREDOC = re.compile(r"(<<-?\s*'?\"?(\w+)'?\"?\n)(.*?)(\n\s*\2\b)", re.S)
QUOTED = re.compile(r"\"(?:[^\"\\]|\\.)*\"|'[^']*'", re.S)

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


def unquote(text):
    if text.startswith("'"):
        return text[1:-1]
    return re.sub(r"\\([\"\\$`])", r"\1", text[1:-1])


def lint(cmd, cwd, session_id):
    """(kind, failures) for cmd, or None when it is not checked or passes."""
    if m := PR.search(cmd):
        kind, verb = "pr", m.group(2)
    elif m := ISSUE.search(cmd):
        kind, verb = "issue", m.group(2)
    elif COMMIT.search(cmd) and not re.search(r"--amend --no-edit|--no-edit --amend", cmd):
        kind, verb = "commit", "commit"
    else:
        return None

    heredoc = HEREDOC.search(cmd)
    heredoc = heredoc.group(3) if heredoc else None
    head = HEREDOC.sub(lambda m: m.group(1) + m.group(4), cmd)  # flags and quoted values, without heredoc bodies
    quoted_spans = [m.span() for m in QUOTED.finditer(head)]

    def flag_values(flags, value):
        """The matches of each flag in flags followed by value, skipping flags that are inside a quoted argument."""
        pattern = r"(?:^|\s)(?P<flag>%s)(?:[ =](%s)|$)" % ("|".join(flags), value)
        return [m for m in re.finditer(pattern, head, re.S | re.M)
                if not any(start <= m.start("flag") < end for start, end in quoted_spans)]

    def quoted_after(flags):
        return [unquote(m.group(2)) for m in flag_values(flags, QUOTED.pattern) if m.group(2)]

    def file_after(flags):
        m = next((m for m in flag_values(flags, QUOTED.pattern + r"|[^\s;&|'\"]+") if m.group(2)), None)
        if not m:
            return None
        path = m.group(2)
        if path[:1] in "'\"" and path[-1:] == path[:1]:
            path = path[1:-1]
        if path == "-":
            return None  # stdin: the heredoc carries the text
        full = os.path.expanduser(path)
        if not os.path.isabs(full) and isinstance(cwd, str) and os.path.isabs(cwd):
            full = os.path.join(cwd, full)
        try:
            with open(full) as f:
                return f.read()
        except OSError:
            raise Refused(f"text-lint: BODY FILE {path} does not exist yet, so nothing can be checked. Write it with "
                          f"the Write tool first, then run the command on its own, with a literal path.")

    if kind == "commit":
        messages = quoted_after(["-m", "-am", "--message"])
        msg = file_after(["-F", "--file"]) or heredoc or "\n\n".join(messages)
        title, _, body = msg.partition("\n")
    else:
        titles = quoted_after(["--title", "-t"])
        title = titles[0] if titles else ""
        bodies = quoted_after(["--body", "-b", "--description", "-d"])
        body = file_after(["--body-file", "-F"]) or heredoc or (bodies[0] if bodies else "")

    fail = []
    gated = GATED_PR.search(cmd)
    if gated and (gated.group(1) == "create" or flag_values(["--title", "-t", "--body", "-b", "--body-file", "-F"],
                                                            r"\S")):
        gap = humanizer_gap(session_id)
        if gap:
            fail.append(gap)

    if title or body:
        fail = text_failures(kind, verb, title, body, cwd) + fail
    return (kind, fail) if fail else None


def text_failures(kind, verb, title, body, cwd):
    try:
        git_cwd = ["-C", cwd] if isinstance(cwd, str) and os.path.isdir(cwd) else []
        branch = subprocess.run(["git", *git_cwd, "branch", "--show-current"], capture_output=True, text=True,
                                timeout=3).stdout.strip()
    except Exception:
        branch = ""
    is_fix = bool(re.match(r"(hot)?fix\b", title, re.I) or re.match(r"(hot)?fix/", branch))
    is_adr = bool(re.search(r"\badr\b", title, re.I))

    prose = re.sub(r"```.*?```", "", body, flags=re.S)
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
            fail.append("FOOTER: no 'Generated with Claude Code' line. The description is the squash commit message.")
        if re.search(r"^\s*co-authored-by:", prose, re.I | re.M):
            fail.append("CO-AUTHORED-BY: no Co-Authored-By line in the description. Your commits carry the trailer "
                        "and GitHub adds it to the squash commit.")
        sections = {m.group(1).lower() for m in SECTION.finditer(prose)}
        if test_plan and not re.search(r"^\s*\*\*\s*test plan\b", prose, re.I | re.M):
            sections.discard("test plan")
        if sections:
            fail.append(f"SECTIONS ({', '.join(sorted(sections))}): the description says what changed and why. Put "
                        f"checks, review rounds, the risk tier, evidence and decisions in a PR comment "
                        f"(`gh pr comment`).")
        if verb == "create":
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
