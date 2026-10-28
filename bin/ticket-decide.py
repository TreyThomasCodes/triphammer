# Decides the ticket runner's next action from what `gh` returned; bin/ticket-runner runs it each tick.
#
#   python3 -I ticket-decide.py issues.json prs.json app-author now owner/repo [owner-login [state-dir]]
#   python3 -I ticket-decide.py --closed prs.json owner/repo
#   python3 -I ticket-decide.py --declarations issues.json
#
# `now` is the tick's time in UTC (2026-10-17T12:00:00Z), and `owner-login` the person the runner acts for (Triphammer
# config's OWNER), by default the owner part of owner/repo, and `state-dir` the runner's state directory, whose
# `security-findings` and `security-followed-up` records say which pull request heads wait for a security-findings
# repair (none without it). Prints one action, "close <issue>",
# "repair <pr> <issue> <reason>", "ticket <issue>" or "upkeep", or nothing. Notes on why an otherwise ready issue,
# or an issue labelled `next`, waits, and on why a parent whose slices are all closed stays open (a brake label), go
# to stderr. With --closed it prints, one per line, the issues of owner/repo that the pull requests close
# (ticket-runner's worktree sweep). With --declarations it prints, as JSON, the slice and depends
# declarations it reads in each issue body. ticket-decide.test.mjs covers each decision.
import json, re, sys
from datetime import datetime, timedelta

def closing(pr, repo):
    """The issues of `repo` that GitHub links `pr` as closing (its closingIssuesReferences), which is what the
    pr-contract check counts: every phrasing GitHub accepts, and never another repository's #N."""
    return [ref["number"] for ref in pr.get("closingIssuesReferences") or []
            if f'{ref["repository"]["owner"]["login"]}/{ref["repository"]["name"]}'.lower() == repo.lower()]

DECLARATION = re.compile(r"Slice (\d+) of #(\d+)|Depends on #(\d+)")
FILLER = re.compile(r"Waits for slice \d+[.!?]?$", re.IGNORECASE)

def declarations(body):
    """The `Slice k of #N.` and `Depends on #N.` declarations of an issue body, as ([(k, N)], [N]). One counts only
    when it begins a line, optionally after a `- `, `* ` or `1. ` list marker; on such a line, the sentences that
    follow it count too while each is a declaration or `Waits for slice k.` (`Slice 2 of #N. Waits for slice 1.
    Depends on #M.`), up to the first sentence of other prose. Fenced code blocks, blockquotes, inline code and
    quotation marks never count, so a body can quote the syntax without the runner acting on it. A line of three or
    more backticks followed by more backticks is inline code, not a fence (CommonMark)."""
    slices, depends, fence = [], [], None
    for line in (body or "").splitlines():
        text = line.strip()
        marker = re.match(r"`{3,}(?!.*`)|~{3,}", text)
        if fence:
            if marker and marker.group()[0] == fence[0] and len(marker.group()) >= len(fence):
                fence = None
            continue
        if marker:
            fence = marker.group()
            continue
        if text.startswith(">"):
            continue
        # Inline code and quoted text become a placeholder, so nothing inside them can start a sentence or the line.
        text = re.sub(r'(`+).*?\1|"[^"]*"|\u201c[^\u201d]*\u201d', "\0", text)
        text = re.sub(r"^(?:[-*]|\d+\.)\s+", "", text)
        if not DECLARATION.match(text):
            continue
        for sentence in re.split(r"(?<=[.!?])\s+", text):
            if FILLER.match(sentence):
                continue
            if not (found := DECLARATION.match(sentence)):
                break
            k, parent, dependency = found.groups()
            if dependency:
                depends.append(int(dependency))
            else:
                slices.append((int(k), int(parent)))
    return slices, depends

if sys.argv[1] == "--declarations":
    print(json.dumps({str(i["number"]): dict(zip(("slices", "depends"), declarations(i["body"])))
                      for i in json.load(open(sys.argv[2]))}, sort_keys=True))
    sys.exit()

if sys.argv[1] == "--closed":
    repo = sys.argv[3]
    for n in sorted({n for pr in json.load(open(sys.argv[2])) for n in closing(pr, repo)}):
        print(n)
    sys.exit()

issues = {i["number"]: i for i in json.load(open(sys.argv[1]))}
prs = json.load(open(sys.argv[2]))
app = sys.argv[3]
utc = lambda at: datetime.fromisoformat(at.replace("Z", "+00:00"))
now = utc(sys.argv[4])
repo = sys.argv[5]
labels = lambda item: {label["name"] for label in item["labels"]}
author = lambda item: (item.get("author") or {}).get("login") or ""
# The authors the runner acts for: it repairs only the App's pull requests, and takes, and reads slice declarations
# from, only issues by the App or the owner. An issue without an author is no one's, so it is skipped. GitHub logins
# compare case-insensitively.
owner = sys.argv[6] if len(sys.argv) > 6 and sys.argv[6] else repo.split("/")[0]
trusted = {app.lower(), owner.lower()}
is_trusted = lambda item: author(item).lower() in trusted
is_open = lambda n: n in issues and issues[n]["state"] == "OPEN"

def records(name):
    """The lines of the state directory's record `name`; a missing record, or no state directory, has none."""
    if len(sys.argv) <= 7 or not sys.argv[7]:
        return set()
    try:
        with open(f"{sys.argv[7]}/{name}") as f:
            return set(f.read().splitlines())
    except FileNotFoundError:
        return set()

# The heads whose security review returned findings (bin/security-review --pr writes `<repo> <pr> <head>`) and whose
# security-findings repair session has not ended normally yet (ticket-runner then writes the same line). Only whole
# lines match, so a record of an older head starts nothing.
pending_follow_up = records("security-findings") - records("security-followed-up")
BRAKES = {"hold", "needs-owner", "stop-agents"}  # the runner never closes or starts an issue labelled with one

slices = {}  # parent -> {k: [issues claiming slice k]}; several issues may claim the same k
for n, issue in sorted(issues.items()):
    if not is_trusted(issue):
        continue
    for k, parent in declarations(issue["body"])[0]:
        slices.setdefault(parent, {}).setdefault(k, []).append(n)

def children(parent):
    return [child for claimants in slices.get(parent, {}).values() for child in claimants]

def deps(n):
    claimed, found = declarations(issues[n]["body"])
    for k, parent in claimed:
        found += slices.get(parent, {}).get(k - 1, [])
    return found

def latest_checks(rollup):
    """The latest run of each check. A rerun or a newer run that superseded an older one (concurrency) leaves the
    older run in the rollup, usually CANCELLED; only the newest run of a check says whether it passes."""
    def started(check):  # a queued run has no start yet (gh prints the zero time); it is the newest of its check
        at = check.get("startedAt") or ""
        return (1, "") if at in ("", "0001-01-01T00:00:00Z") else (0, at)
    latest = {}
    for check in sorted(rollup, key=lambda c: (started(c), c.get("completedAt") or "")):
        if check.get("__typename") == "StatusContext" or check.get("context"):
            key = ("status", check.get("context"))
        else:
            key = ("check", check.get("workflowName") or "", check.get("name"))
        latest[key] = check  # sorted is stable, so on equal times the later rollup entry wins
    return list(latest.values())

for parent in sorted(slices):
    if is_open(parent) and all(not is_open(child) for child in children(parent)):
        if brakes := sorted(labels(issues[parent]) & BRAKES):
            print(f"skip close {parent}: labelled {', '.join(brakes)}", file=sys.stderr)
            continue
        print(f"close {parent}"); sys.exit()

failing = {"FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "ERROR"}
for pr in sorted(prs, key=lambda pr: pr["number"]):
    if author(pr).lower() != app.lower() or pr["isDraft"] or "hold" in labels(pr):
        continue
    issue = (closing(pr, repo) or [0])[0]
    checks = [c for c in latest_checks(pr["statusCheckRollup"] or [])
              if (c.get("name") or c.get("context")) != "owner-approval"]
    last_commit = pr["commits"][-1]["committedDate"] if pr["commits"] else ""
    # Only the owner's change requests start a repair, since the repair session acts on the review's text; GitHub
    # logins compare case-insensitively, and a review without an author is no one's. As in the owner-approval brake,
    # the owner's latest review that is not a comment decides: a later approval or dismissal withdraws the request.
    answers = sorted((r for r in pr["reviews"] if r["state"] != "COMMENTED"
                      and author(r).lower() == owner.lower()), key=lambda r: r["submittedAt"])
    requested = answers and answers[-1]["state"] == "CHANGES_REQUESTED" and answers[-1]["submittedAt"] > last_commit
    reason = ("conflicts" if pr["mergeStateStatus"] == "DIRTY"
              else "failing-checks" if any((c.get("conclusion") or c.get("state")) in failing for c in checks)
              else "changes-requested" if requested
              else "security-findings" if f"{repo} {pr['number']} {pr.get('headRefOid')}" in pending_follow_up
              else None)
    if reason:
        print(f"repair {pr['number']} {issue} {reason}"); sys.exit()

in_flight = {n for pr in prs for n in closing(pr, repo)}
cite = lambda numbers: ", ".join(f"#{d}" for d in numbers)
# Ready issues labelled `next` first, then the rest but those labelled `cleanup` (the proposals sessions leave, which
# ticket-runner files), then those, each lowest number first; `next` never makes an issue ready.
for n in sorted(issues, key=lambda n: ("next" not in labels(issues[n]), "cleanup" in labels(issues[n]), n)):
    if not is_open(n) or labels(issues[n]) & BRAKES:
        continue
    if not is_trusted(issues[n]):
        who = author(issues[n]) or "nobody"
        print(f"#{n} waits: its author, {who}, is neither the owner, {owner}, nor the App", file=sys.stderr)
        continue
    first = "next" in labels(issues[n])
    open_slices = [child for child in children(n) if is_open(child)]
    if n in in_flight or open_slices:
        if first:
            print(f"#{n} waits: " + ("it has an open pull request" if n in in_flight
                                     else f"its slices {cite(open_slices)} are open"), file=sys.stderr)
        continue
    waits_on = deps(n)
    unknown = [d for d in waits_on if d not in issues]
    if unknown:  # a pull request, a typo, or an issue past the list limit: never assume it is closed
        print(f"#{n} waits: it depends on {cite(unknown)}, which is not in the issue list", file=sys.stderr)
        continue
    open_deps = [d for d in waits_on if is_open(d)]
    if not open_deps:
        print(f"ticket {n}"); sys.exit()
    if first:
        print(f"#{n} waits: it depends on {cite(open_deps)}, still open", file=sys.stderr)

# Weekly upkeep (the triphammer:upkeep skill) only when nothing else is due: no issue labelled `upkeep`, open or
# closed, was created in the last 7 days. One without a creation time counts as recent, so missing data never opens a
# duplicate.
if not any("upkeep" in labels(i) and (not i.get("createdAt") or utc(i["createdAt"]) >= now - timedelta(days=7))
           for i in issues.values()):
    print("upkeep")
