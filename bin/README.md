# Triphammer's scripts

The scripts and systemd user units that run the agents on the agent machine. The machine runs them from Triphammer's
checkout, the one these scripts live in, and the ticket runner keeps that checkout on `origin/main`, so a merged change
here, in `systemd/` or in `status/` goes live on the next runner tick. A project's `CHECKOUT` may be that checkout or a
repository of its own (see Which checkout each file comes from). What differs between projects and machines comes from
the Triphammer config and the project file (see Configuration). Changes to Triphammer always escalate to the owner (its
own `.triphammer/risk-tier.json` lets none merge automatically), so only what the owner merges is deployed.

Agents reach GitHub as the agents' GitHub App, never as the owner. `github-app-token` mints the App's installation
token for git (as its credential helper) and `gh` (the `gh` wrapper here sets `GH_TOKEN` from it). Both live here and
are linked into `~/.local/bin` (see Install); the App's id, owner and private key stay in files the owner fills in,
outside any repository, and no script prints or copies the key. The units put `~/.local/bin` on `PATH`, so every
script that runs `gh` gets the wrapper.

## Which checkout each file comes from

Triphammer's checkout is the one the running script lives in (through the `~/.local/bin` links); the project's
checkout is the config's `CHECKOUT`. When they are one repository, everything comes from it.
When they differ:

| From Triphammer's checkout | From the project's checkout |
| --- | --- |
| Triphammer's scripts in `bin/`, `systemd/` and `status/`, kept on its `origin/main` every tick | `.triphammer/project.json`, read from `CHECKOUT` (and by `local-audit` from the audited commit) |
| the plugin `plugins/triphammer`, which every session and the Qwen audit load, and the Codex audit's reviewer brief | `.triphammer/risk-tier.json` at the pull request's base ref, the rules the classifier applies |
| the git hooks `scripts/git-hooks`, which every worktree's commits run | its own checks, the commands its project file names |
| `land-pr`, `scripts/land-pr.sh` and the classifier (`scripts/risk-tier-base.sh`, `scripts/risk-tier.mjs`), always its `origin/main` copies | the worktrees, branches and pull requests the sessions work on |

So a project needs only `.triphammer/` and its own checks: no `plugins/`, `scripts/git-hooks/`, `scripts/land-pr.sh`
or classifier of its own. This repository's CI is the exception: its workflows run this repository's
`scripts/risk-tier-base.sh` from the base ref, which reads the classifier from the same ref.

## What each piece does

| File | What it does |
| --- | --- |
| `ticket-runner` | One tick of the unattended backlog: self-update, then close a finished parent issue, repair an agent pull request, start a fresh Claude Code session on the next ready issue (the `triphammer:ticket-run` skill), or open and run the weekly upkeep issue. Each tick first removes the worktrees and databases nothing uses any more (see below). Its header lists the order and the owner's brakes; `ticket-runner --plan` prints what the next tick would do. While a session runs, `current` in the state directory (the config's `STATE_DIR`) names the run (the runner's pid and start time, its kind and number, the branch its session works on, and the open pull requests it may push to) for `merge-when-ready`; once the session ends it names no pull request and no branch, and the runner removes it when the run ends. The run's own issue (a ticket) or pull request (a repair) carries the label `agent-working` while the run lasts, telling the owner not to update or push to it; it is information and never a brake, only the runner adds it, and each tick removes any left on anything else first. State and logs are in the state directory. The projects on one machine share a lock, a backoff and a stop file and take turns (see Several projects). |
| `triphammer` | The owner's command, installed by `provision` as `/usr/local/bin/triphammer`: `triphammer add` sets a project up, `doctor` and `plan` run `ticket-runner --doctor` and `--plan` as the service user, `start` starts a project's timers, `update` runs a fresh clone's `provision` and each project's `provision-project` again for what the runner does not update by itself; see On a machine of its own below. |
| `provision` | Run as root (by `install.sh`, through sudo) on a fresh Ubuntu server, turns it into a machine of Triphammer's own with no project yet: the shared toolchain, the service user, Triphammer's checkout, the links, the plugin, the machine file and the `triphammer` command; see On a machine of its own below. |
| `provision-project` | Run as root by `triphammer add`, from a fresh clone of Triphammer: sets one project up on that machine, with its checkout, its toolchains, its modules' extras and its config. |
| `provision-lib.sh` | Sourced by `provision` and `provision-project`: what they share, from the argument checks to the clone, and the machine file `/etc/triphammer.conf`. |
| `doctor` | `ticket-runner --doctor`: lists what is missing or wrong on the machine for the project, one line per problem with its fix, and exits 1 when anything is; see Doctor below. |
| `ticket-decide.py` | Decides what a `ticket-runner` tick does, from the issues and pull requests `gh` returned: prints `close`, `repair`, `ticket`, `upkeep` or nothing; see below. |
| `update-checkout` | Fast-forwards a checkout (Triphammer's, or a project's) to `origin/main` and restarts the long-running servers whose code changed: `triphammer-status.service` for `status/`, the running `demo-gallery@` units for `bin/demo-gallery`, and both for `bin/config.sh`, which each reads at startup. `ticket-runner` calls it; see below. |
| `demo-gallery` | The `demo` module's web server: serves `DEMO_GALLERY_DIR` read-only at `http://DEMO_GALLERY_HOST:DEMO_GALLERY_PORT/` until stopped. GET and HEAD only (anything else gets 405); a directory serves its `index.html` and is never listed; a path that leaves the gallery, by `..` or by a symlink whose target lies outside it, and anything but a regular file get 404. With the module off, `DEMO_GALLERY_DIR` missing or the config malformed it exits 2 naming why. `DEMO_URL` is the address the owner publishes, which may be this server itself or a proxy in front of it. |
| `demo-publish` | The `demo` module. `demo-publish <pr> --summary <line> <folder>` publishes the screenshots and videos under one folder to the gallery in the config's `DEMO_GALLERY_DIR` and prints its `DEMO_URL`, and `demo-publish --reindex` refreshes pull request states, which `ticket-runner` does every tick; with the module off, or either setting missing, it exits 2 naming it. Any other form prints the usage and exits nonzero. It never follows a symlink inside the folder and refuses a folder argument that is itself a symlink (a symlinked parent directory in the argument's path is followed), never copies a file with more than one hard link (another name may lie outside the folder) and never copies a file whose real path is outside the folder; it names each one it skips. When no media survives these checks, or a file cannot be copied or converted, it exits nonzero with one line on stderr and leaves the pull request's earlier demo in place: it builds the new entry in a hidden folder in the gallery and swaps it in only once every file and `meta.json` are written. |
| `publish-demos` | The `demo` module. Runs `demo-publish` for each demo a session left in its worktree; `ticket-runner` calls it when a session ends. See below. |
| `local-audit` | The `qwen-audit` and `codex` modules. Audits one area with Triphammer's local Qwen model or with Codex, the second and third models of the weekly upkeep audit; see below. |
| `security-review` | The `codex` module. Advisory security review by the config's `CODEX_SECURITY_MODEL` (through `local-audit`) of an open pull request that touches Triphammer's safety machinery, posted as one pull request comment; `ticket-runner` calls it after each session. `--full-area` audits the whole area for the monthly upkeep run. See below. |
| `land-pr` | Lands a pull request (the `triphammer:merge-policy` skill): `land-pr <n>`, from the worktree whose HEAD is its pushed head, fetches `main` in Triphammer's checkout (the one `land-pr` resolves to through its link) and runs that `main`'s `scripts/land-pr.sh`, never a working tree's, with `TRIPHAMMER_CHECKOUT` naming the checkout, so `land-pr.sh` runs Triphammer `main`'s classifier against the worktree's branch and its base ref's `.triphammer/risk-tier.json`. It refuses, running nothing, unless it is itself byte for byte that `main`'s `bin/land-pr`, so a branch's copy cannot land anything; until Triphammer's checkout is fast-forwarded after a change to it, the linked copy refuses too. Exits with `land-pr.sh`'s code, or 1 when it refuses. |
| `merge-when-ready` | A serial merge queue per repository, as the GitHub App (the `triphammer:merge-policy` skill), that merges armed pull requests and brings them up to date one at a time, stops for the owner's brakes and keeps off the branches a `ticket-runner` run works on. With a project (`TRIPHAMMER_PROJECT`) it serves only that project's repository, reads that project's runner and starts it after a merge. Its header lists the rules. |
| `github-app-token` | Prints a token of the agents' GitHub App's installation on the account that owns the repository being worked on, cached per account in `${XDG_CACHE_HOME:-~/.cache}/github-app/token-<account>.json` (mode 600) and minted again within ten minutes of expiry; `github-app-token git-credential get` answers git's credential-helper protocol, and `store`, `erase` and any other action do nothing. It reads `app-id`, `owner` and `agents.pem` from `$GITHUB_APP_CONFIG_DIR`, by default `~/.config/github-app`. The account is the first segment of the path git asks about for github.com (sent with `credential.https://github.com.useHttpPath`), else `$GITHUB_APP_OWNER`, which `ticket-runner` and `merge-when-ready` set to the owner of their config's `REPO`, else the `owner` file; an account with no installation stops it naming the account. A missing or unreadable file, a failed request or a response without a token stops it with exit 1, a message naming the fix, no token printed and the cache unchanged; a cache it cannot parse counts as expired. `github-app-token app-slug` prints the App's slug (`GET /app`, from `app-id` and `agents.pem` alone), which `provision-project` uses for `APP_AUTHOR`. Its header lists the rules. |
| `gh` | Runs the first other `gh` on `PATH` with `GH_TOKEN` from the `github-app-token` beside it (symlinks resolved), for the account of its `-R`/`--repo` argument when it has one; when no token can be had it runs nothing and exits 1. |
| `config.sh` | Sourced by the bash scripts, and run with `--print` by the others: reads the Triphammer config and checks the project file (see Configuration). |
| `ticket-runner@.service`, `ticket-runner@.timer` | Run `ticket-runner` for the project named by the instance (`ticket-runner@<project>.timer`) every ten minutes, with `TRIPHAMMER_PROJECT=<project>`; `merge-when-ready@<project>` also starts the service after each merge. |
| `merge-when-ready@.service`, `merge-when-ready@.timer` | Run `merge-when-ready` for the project named by the instance every two minutes. |
| `demo-gallery@.service` | Runs `demo-gallery` for the project named by the instance, with `TRIPHAMMER_PROJECT=<project>`, restarting it when it fails, except on exit 2 (a config to fix). Only for a project with the `demo` module on. |
| `ticket-runner.service`, `ticket-runner.timer`, `merge-when-ready.service`, `merge-when-ready.timer` | The same for the one project of the checkout the scripts live in, without `TRIPHAMMER_PROJECT`, for a machine not yet cut over to the template units (see Install). |

`ticket-runner` calls `ticket-decide.py`, `update-checkout`, `demo-publish`, `publish-demos` and `security-review`
from the directory it really lives in (symlinks resolved), so it always uses the copies next to it; the last three only
when their module is on (see Modules).

## Configuration

Two files hold what is specific to a project or to this machine; no script carries a default for either.

**The Triphammer config** holds the settings of one project on the machine: `${XDG_CONFIG_HOME:-~/.config}/triphammer/<name>.conf`,
outside any repository, where `<name>` is `$TRIPHAMMER_PROJECT` when that is set (the template units set it to their
instance name), else the `name` in the `.triphammer/project.json` of the checkout the script lives in (symlinks
resolved). `$TRIPHAMMER_CONFIG`, when set, names another file instead; the tests use it. A `TRIPHAMMER_PROJECT` that is
not letters, digits, dots, dashes and underscores, or starts with a dot, stops the script with exit 2. It holds no secret: a key
stays in its own file, and the config names that file. These settings are required:

| Setting | What it is | Example |
| --- | --- | --- |
| `REPO` | The repository the runner serves, `owner/name` | `<owner>/<repo>` |
| `CHECKOUT` | The project's main checkout, an absolute path: Triphammer's checkout or a repository of its own | `/srv/<project>` |
| `APP_AUTHOR` | The GitHub App login whose issues and pull requests the runner trusts, as `gh` reports it | `app/<app-login>` |
| `STATE_DIR` | The ticket runner's state directory, an absolute path | `~/.local/state/ticket-runner`, written out in full |

This setting is optional; the ticket runner reads it:

| Setting | What it is | Default | Checked form |
| --- | --- | --- | --- |
| `OWNER` | The person the runner acts for: it takes their issues, besides the App's, and only their change requests start a repair | the owner part of `REPO` | one GitHub login: letters, digits and single dashes between them, at most 39 characters |

In a repository an organization owns, the owner part of `REPO` is the organization, which opens no issues and writes
no reviews, so a runner acting for it would act for no one. With `OWNER` unset, the runner asks GitHub
(`gh api users/<login>`) what kind of account the owner part of `REPO` is, and when it is an organization it refuses to
plan: `ticket-runner` and `ticket-runner --plan` exit 2 with a message naming `OWNER` and the config file. An `OWNER`
that names an organization is refused the same way, and an owner GitHub cannot look up stops the tick with exit 1.
`GITHUB_APP_OWNER`, the account the App's token comes from (Several accounts), stays the owner part of `REPO`.
The runner gives the session it starts the owner as the environment variable `TRIPHAMMER_OWNER`, and
`scripts/land-pr.sh` requests an escalated pull request's review from that login; run by hand without it, land-pr asks
the repository's owner. The `risk-tier` workflow, which decides whose approval releases an escalated pull request, reads
its owner from the repository variable `TRIPHAMMER_OWNER`, falling back to the repository's owner; in a repository an
organization owns, set that variable to the login `OWNER` gives (`gh variable set TRIPHAMMER_OWNER --body <owner-login>`).

These settings are optional, and only `status/` reads them (its README, "Run"). Every project's config may
give them; two configs that give one different values stop the status page with exit 2:

| Setting | What it is | Default | Checked form |
| --- | --- | --- | --- |
| `STATUS_HOST` | The address the status page listens on | `127.0.0.1` | letters, digits and `._:-` |
| `STATUS_PORT` | The port it listens on | `8787` | a whole number from 1 to 65535 |
| `STATUS_ALLOWED_HOSTS` | The extra `Host` names it answers for (`status/README.md`, "Expose it safely") | none | names, each with an optional `:port`, IPv6 in brackets, separated by commas, no blanks |

The optional modules and their settings are under Modules below.

Each line is `KEY=value`: the key in capitals at the start of the line, `=`, and the rest of the line as the value,
verbatim (no quotes, no expansion, no trimming). Blank lines and lines whose first non-blank character is `#` are
ignored. A line of any other shape, an unknown key, a key set twice, a missing or empty required setting, a `REPO` that
is not `owner/name`, a `CHECKOUT` or `STATE_DIR` that is not absolute, an `APP_AUTHOR` with blanks, or an optional
setting given in the wrong form (below) stops the script with exit 2 and a message naming the file and the setting (or
the line), before it calls `gh` or `git`. An optional setting left empty counts as not given. The file is parsed, never
sourced. `config.sh` is its one reader: the bash scripts source it, and `demo-publish` (Python),
`demo-gallery` and `status/config.mjs` (Node) run `bash config.sh --print` from their own checkout,
which prints the settings they name separated by NUL, and pass on its message.

### Modules

Three optional modules add steps to the core, which runs tickets, repairs, upkeep and merges without them. Each is off
unless `MODULES` names it: `MODULES=demo,qwen-audit,codex` turns all three on (module names separated by commas, no
blanks; an unknown or repeated name stops the script). A module that is off gets none of its steps, and the runner logs
nothing about it. The runner's session prompt names the modules that are on (`Modules on: demo, codex.`, or `No module
is on.`), and the `triphammer:ticket-run` and `triphammer:upkeep` skills skip the steps of the others.

| Module | What it adds | What the machine needs |
| --- | --- | --- |
| `demo` | After each session `ticket-runner` publishes the demos it left (`publish-demos`), and each tick it refreshes the gallery (`demo-publish --reindex`). The `triphammer:ticket-run` skill has a `demo` agent write a walkthrough of a web change when the project also declares `"demos": true`. | `python3`, `ffmpeg` (videos become H.264 MP4), `node` for `demo-gallery`, which serves `DEMO_GALLERY_DIR` (the `demo-gallery@<project>` unit, see Install), and whatever makes that reachable at `DEMO_URL`. |
| `qwen-audit` | Upkeep's second-model audit with a local Qwen model (`local-audit --model qwen`). | An Anthropic Messages API server for the model at `QWEN_BASE_URL`, its key in the file `QWEN_KEY_FILE` names, and `claude`. |
| `codex` | Upkeep's Codex audit (`local-audit --model codex`), its monthly security audit (`security-review --full-area`), and after each session the security review of the run's pull requests (`security-review --pr`). | `codex`, logged in, and `bwrap` for its sandbox (see Codex below). |

| Setting | Module | What it is | Checked form |
| --- | --- | --- | --- |
| `DEMO_GALLERY_DIR` | `demo`, required | The directory the gallery lives in; `demo-publish` creates it | an absolute path |
| `DEMO_URL` | `demo`, required | The URL the gallery is served at; `demo-publish` prints it with each publish | `http://` or `https://`, no blanks |
| `DEMO_GALLERY_HOST` | `demo`, optional | The address `demo-gallery` listens on (default `127.0.0.1`) | letters, digits and `._:-` |
| `DEMO_GALLERY_PORT` | `demo`, optional | The port `demo-gallery` listens on (default `8788`) | a whole number from 1 to 65535 |
| `QWEN_BASE_URL` | `qwen-audit`, required | The model server's Anthropic Messages API | `http://` or `https://`, no blanks |
| `QWEN_KEY_FILE` | `qwen-audit`, required | The file that holds the server's API key; the config never holds the key | an absolute path |
| `QWEN_MODEL` | `qwen-audit`, required | The model name the server serves | letters, digits and `._:/-` |
| `CODEX_AUDIT_MODEL` | `codex`, required by `local-audit --model codex` without `--codex-model` | The model of upkeep's Codex audit | letters, digits and `._:/-` |
| `CODEX_SECURITY_MODEL` | `codex`, required by `security-review` | The model of the security reviews | letters, digits and `._:/-` |
| `CODEX_WEEKLY_CAP` | `codex`, optional | Codex runs allowed in 7 days (default 25) | a whole number |
| `CODEX_FLOOR_PERCENT` | `codex`, optional | The estimated share of the 5-hour window to leave unused (default 10) | a whole number from 0 to 100 |
| `CODEX_RUN_PERCENT` | `codex`, optional | The estimated share of the 5-hour window one run uses (default 5) | a whole number from 0 to 100 |

A module's settings may stay in the file while the module is off. A script that needs a module that is off, or a
required setting the config leaves out, exits 2 naming the module or the setting (`the codex module is off; add it to
MODULES in <file>`, `<file>: the qwen-audit module needs QWEN_MODEL`).

**The project file** `.triphammer/project.json` holds the project's own data. Each script reads it from the project's
main checkout (`CHECKOUT`, or the `--repo` given to `security-review`), never from a run's worktree, except `local-audit`,
which reads `checks`, `reviewChecklist` and `reviewSkills` from the commit it audits, where the reviewer reads them too.
It is also the project contract of the Triphammer plugin's skills, agents and hooks (`plugins/triphammer`: the skills
`triphammer:ticket-run`, `triphammer:review-loop`, `triphammer:merge-policy`, `triphammer:plan-work`,
`triphammer:upkeep` and `triphammer:review-checklist`, the agents `triphammer:orchestrator`, `triphammer:builder`,
`triphammer:reviewer`, `triphammer:searcher` and `triphammer:simplifier`, and the `agent-guard.py` hook): they name no
project, and read its check commands, checklist, skills and shell-edit roots here. Only `name` is required; a
project that leaves out a field gets none of its step, and the runner logs nothing about it.

| Field | Used by | The example project's (`test-fixtures/example-project`) |
| --- | --- | --- |
| `name` | the Triphammer config's file name | `example-project` |
| `demos` | the `triphammer:ticket-run` skill: `true` when the project has paced demo walkthroughs for the `demo` module to publish | `true` |
| `worktreeTeardown` | `ticket-runner`: the command run in a worktree before it is removed, a list of words whose first is a path relative to the worktree | `["scripts/local-db.sh", "down"]` |
| `shellEditRoots` | the plugin's `agent-guard.py` hook, which reads it from the working tree of the repository a command runs in: the directories whose git-tracked files a shell command may not rewrite (they go through Edit or Write), a list of paths relative to the repository root and inside it; without it the hook has no shell-edit rule | `["src", "tests"]` |
| `composeProjectPattern` | `ticket-runner`: the Docker Compose project names the sweep may prune, an extended regular expression | `^example-project-(local\|it)-[0-9]+$` |
| `securityReviewPaths` | `security-review --pr`: the changed paths that trigger a review, an extended regular expression | `bin/`, `status/` and the other paths under Security review |
| `securityReviewArea` | `security-review --full-area`: the area audited, as text | the same paths, with the `.claude/settings.json` hooks |
| `checks` | `triphammer:review-loop` step 1, the `triphammer:builder` and `triphammer:simplifier`: the commands of each check, an object with any of `build`, `focused` (the tests of the area changed; a `<placeholder>` is filled in), `suite` (the whole test suite) and `gate` (the full gate before a pull request), each a command of plain words separated by single spaces whose first word holds no placeholder. `local-audit` lets its Qwen session run `build`, `focused` and `suite`, never `gate` | `make build`, `make test TEST=<file>`, `make test`, `scripts/gate.sh` |
| `reviewChecklist` | `triphammer:review-checklist`, `local-audit`: the project's own checklist, whose classes are reviewed with the generic ones | `.agents/skills/example-review-checklist/SKILL.md` |
| `reviewSkills` | the `triphammer:reviewer`, `triphammer:upkeep` §3, `local-audit`: the domain review skills followed after the checklists, each where its description says it applies; a list of paths | `[".agents/skills/example-safety-review/SKILL.md"]` |
| `uiVerificationSkill` | the `triphammer:builder`: the skill whose checks a change to the user interface also passes | `.agents/skills/example-web-verification/SKILL.md` |

A project file that is not a JSON object, lacks a valid `name`, or has a field of the wrong type (`demos` is `true` or
`false`), a pattern that does not compile, a check that is unknown or not plain words, or a shell-edit root that is
absolute or leaves the repository stops the script that reads it with exit 2, naming the file and the field; the
`agent-guard.py` hook instead ignores a malformed `shellEditRoots`, as it ignores anything it cannot work out.
`triphammer:upkeep` §3 checks that every command, skill and path the file names
exists.

## Several projects

Triphammer runs the backlog of every project that has a config file, one session at a time: `ticket-runner@<project>`
and `merge-when-ready@<project>` run once per project, and each project keeps its own state directory, log, attempts,
`current` file and merge-queue log (`merge-when-ready-<project>.log`, with its `.brakes` and `.skips`). The projects
share the shared directory, `$TRIPHAMMER_SHARED_DIR` or else `${XDG_STATE_HOME:-~/.local/state}/triphammer`:

| File | What it does |
| --- | --- |
| `lock` | Held by the tick that starts a run, from its decision until the run ends. A tick takes its project's own `lock` first and then this one, both without waiting, so a run in any project makes every other tick that has a run to start exit without claiming anything; two ticks that race cannot deadlock. A tick that only closes a parent issue does not take it. |
| `backoff` | Written when a session stops at a usage or rate limit: the epoch second until which every project pauses (an hour). A `backoff` left in a project's state directory still pauses that project. |
| `stop` | The owner's shared brake: while it exists no project's runner or merge queue does anything. The `stop` file in a project's state directory stops only that project. |
| `last` | The project whose run started last. |
| `waiting/<project>` | The time a tick of that project last had a run to start; removed when it starts one or has nothing to do. |

Projects take turns: once a tick holds the shared lock and has a run to start, it yields when its project is the one in
`last` and another project's `waiting` mark is at most 30 minutes old (three ticks). It logs `<project> ran last and
<other> is waiting; yielding this turn to it` and exits, starting nothing. An older mark, from a project that is stopped
or removed, is ignored, so it cannot hold the others back. `ticket-runner --plan` reads none of this and writes
nothing.

`merge-when-ready@<project>` merges and updates only the pull requests of that project's repository, keeps off the
branches its own runner's `current` file names, and after a merge starts `ticket-runner@<project>.service`. Without
`TRIPHAMMER_PROJECT` it serves every repository the App is installed on, as the non-template unit does.

## Sessions

Each worktree `ticket-runner` creates has `core.hooksPath` set to Triphammer's checkout's `scripts/git-hooks` (an
absolute path) in that worktree's own config (`extensions.worktreeConfig`), so the main checkout and other worktrees
keep their hooks. Triphammer's checkout tracks `origin/main`, so a branch cut before a hook existed, or a project with
no hooks of its own, still runs it and a branch cannot change its own hook. Its `commit-msg` hook adds
the agents' `Co-Authored-By` trailer to a commit that lacks one.

Sessions run under the Triphammer plugin of Triphammer's checkout, never the worktree's copy, so a branch cannot change
the skills, agents or hooks its own session runs under: `ticket-runner` starts `claude -p` with `--plugin-dir
<Triphammer's checkout>/plugins/triphammer --agent triphammer:orchestrator --model opus`, the plugin's `orchestrator` agent
(`plugins/triphammer/agents/orchestrator.md`, without Edit, Write or NotebookEdit) on Opus. Claude Code names the
plugin's agents and skills with its prefix, and the orchestrator starts subagents by those names
(`triphammer:builder`); a bare `--agent orchestrator` would pick a project's own `.claude/agents/orchestrator.md` over
the plugin's. The plugin's hooks run in the session and its subagents. The runner starts the session with
`TRIPHAMMER_SESSION` set to the run's worktree (`local-audit` sets it to its clone for the Qwen audit), which tells
the plugin's `agent-guard.py` that Triphammer started it: such a session writes only inside that worktree (not its `.git`)
and the temporary directories, writes no git configuration (`git config` and `git remote` only read, and an upstream is
set only for its own branch in its worktree), sets no one-command `git -c` key that makes git run a command or changes
what it fetches or pushes, and schedules nothing with `crontab`, `at`, `batch` or `systemd-run`; the hook's header lists what it checks and what it
does not cover. The prompt names the `triphammer:ticket-run` skill and ends by naming the modules that are on. A tick
whose Triphammer `origin/main` has no
`plugins/triphammer/skills/ticket-run/SKILL.md` starts no session.

With the `demo` module on, when a session ends, on every path but a brake (below), before the worktree can be removed,
`ticket-runner` runs `publish-demos` on it.
The `demo` agent leaves a `demo.json` in each demo folder under `artifacts/web-demo/results/` (ignored by git), in the
format of `.agents/agents/demo.md` step 3.
`publish-demos` runs `demo-publish <pr> --summary <summary> <folder>` for each folder that has one, and logs one line
per folder in the runner log: published, skipped (no `demo.json`), malformed, or a failed publish with its output. None
of these fails the run. Agents never run `demo-publish`.

The owner's brakes stop a session in progress, not only the next one. While a session runs, `ticket-runner` checks
them every `TICKET_RUNNER_BRAKE_SECONDS` (a positive number, default 60): the project's and the shared `stop` files, an open `stop-agents`
issue, `hold` on a ticket's issue, `needs-owner` on it, the ticket's issue being closed, and `hold` on the pull request a
repair works on. `needs-owner` brakes only when someone other than the App added it: a session adds it itself when it
stops for the owner (review-loop step 4, ticket-run), and the runner tells the two apart by the actor of the latest
`labeled` event for it (the issue events API, where the App is `<APP_AUTHOR without app/>[bot]`). A closed issue brakes
unless it is labelled `upkeep` (whose session closes its own issue) or a merged pull request closed it (the last
`ClosedEvent` of the issue's timeline names it as the closer): the run's own pull request, which `merge-when-ready` may
merge while the session's demo agent still runs. When a brake applies, the runner ends the session the way
`systemctl stop` ends the unit's cgroup: SIGTERM to every process of the session, then SIGKILL to whatever is left after
`TICKET_RUNNER_BRAKE_GRACE_SECONDS` (default 90, systemd's default `TimeoutStopSec`). Claude Code runs each Bash tool
command in a session of its own, so the runner finds the session's processes by parent pid and process group in `/proc`
and walks them again each second, which also catches the ones a dying parent leaves behind; a process forked by a parent
that exits between two walks, outside every process group it knows (a double fork), escapes it. It logs
`ended by the owner's brake: <brake>; not counted`, does not count the run toward the three, publishes no demo, starts
no security review, keeps the worktree, and removes `agent-working` and `current` as on every other ending. A brake
lookup that fails (`gh` exits non-zero), or a `needs-owner` actor or closer GitHub does not report yet, is logged and
the session goes on.

## Worktrees and databases nothing uses

A worktree's sessions can leave resources behind, such as a database compose project per worktree that the project's
scripts start (in the example project, `example-project-local-<cksum of the worktree path>`, which lives until
`scripts/local-db.sh down`, and a gate's `example-project-it-<cksum>`). A session killed by the 6-hour limit, or a
killed gate run, never stops them. So:

- Before `ticket-runner` removes a worktree with `git worktree remove`, it runs the project's `worktreeTeardown` in that
  worktree, when the worktree has its first word as an executable file, and logs `tore down <worktree>: <its last line
  of output>` when it printed anything (`teardown failed in <worktree>: ...` when it failed).
- Each tick, after the self-update and before it decides anything, it removes the runner worktrees no run will use
  again: `.worktrees/issue-N` when issue N is closed, has an open pull request, or used all 3 runs (its
  `attempts/ticket-N` file says 3), and `.worktrees/pr-N` when `gh pr view` says pull request N is closed or merged.
  It never removes the worktree the `current` file names, nor any worktree not named `issue-N` or `pr-N` (manual and
  harness worktrees), and an issue missing from the issue list keeps its worktree. It logs each removal with its
  reason, then runs `git worktree prune`.
- Then, when the project declares a `composeProjectPattern`, it lists the compose containers (`docker ps -a`) and
  removes every project whose name matches it and whose `com.docker.compose.project.working_dir` label names a
  directory that no longer exists, in a worktree that no longer exists either, with `docker compose -p <project> down --volumes --remove-orphans`, logging `pruned database <project>
  (worktree <path> is gone)`. A project with any container whose working directory exists, or that has none, is never
  touched, running or stopped. When Docker is unavailable the tick logs `database sweep skipped: docker is
  unavailable` and carries on.
- A failed removal is logged (`could not remove worktree ...`, `could not prune database ...`) and the tick carries on.

`ticket-runner --prune-dry-run` prints `would remove worktree ...` and `would prune database ...` lines for what the
sweep would remove and exits. It takes no lock, ignores the brakes, writes no state or log, and only reads from `gh`,
`git` and Docker.

## What a tick decides

`ticket-decide.py` reads the issue list (`gh issue list --state all --limit 1000`) and the open pull requests, and
prints the one action described in `ticket-runner`'s header. A few rules decide the edge cases:

- A pull request's checks count by the latest run of each check, keyed by workflow and check name (status contexts by
  context). An older run that a newer one superseded, usually left `CANCELLED`, does not count; a latest run that
  failed, timed out or was cancelled does. A run still queued counts as the latest. `owner-approval` never counts.
- A pull request closes the issues GitHub links it to (`closingIssuesReferences`, what the `pr-contract` check
  counts), so every phrasing GitHub accepts counts and another repository's `#N` never does. The same rule decides
  whether an issue has an open pull request and whether a run made progress.
- Only issues the owner (the config's `OWNER`, Configuration) or the App (the config's `APP_AUTHOR`) opened count,
  logins compared case-insensitively: the runner takes no one
  else's issue, and their `Slice k of #N` declarations neither hold back nor close anything. An issue without an
  author counts as no one's. Each skipped open issue is printed to standard error.
- A `changes-requested` repair starts only when the owner's latest review that is not a comment is `CHANGES_REQUESTED`
  and newer than the pull request's last commit, the rule of the `owner-approval` brake: a later approval or dismissal
  withdraws it. Anyone else's review, or one without an author, counts for nothing. The repair session's prompt names
  the owner, whose reviews alone it reads.
- Several issues may claim the same `Slice k of #N`. Any open one keeps parent `#N` open and holds back slice `k+1`.
  A parent labelled `hold`, `needs-owner` or `stop-agents` stays open after its last slice closes, and the reason is
  printed to standard error.
- A `Depends on #N.` is satisfied only when `#N` is a known, closed issue. A number missing from the issue list (a pull
  request, a typo, an issue past the list limit) keeps the issue waiting, and the reason is printed to standard error.
- Ready issues labelled `next` are taken before other ready issues, lowest number first. The label never makes an issue
  ready or outranks a parent to close or a repair; when a `next` issue waits, the reason is printed to standard error.

## Labels

Triphammer reads and sets these labels in each project's repository. `bin/labels.sh` defines them, with the color
and description each gets, for both `ticket-runner --labels` and the doctor.

| Label | What Triphammer does with it |
| --- | --- |
| `hold` | The owner's brake: the runner starts nothing on an issue or pull request that carries it and stops a run on it (Sessions), and `merge-when-ready` neither merges nor updates such a pull request. A pull request three repair runs could not move gets it. |
| `needs-owner` | Waits for the owner: the runner starts no run on an issue that carries it, a session adds it when it stops for the owner, and a ticket that ends three runs without a pull request gets it. Added by anyone but the App, it stops a run on its issue. The `risk-tier` workflow adds it to a pull request that escalates. |
| `stop-agents` | An open issue that carries it pauses the project and stops a run in progress. |
| `next` | Ready issues that carry it are taken first (What a tick decides). |
| `agent-working` | Set by the runner on the issue or pull request of the run in progress, telling the owner not to update or push to it; information, never a brake. |

`ticket-runner --labels` creates each of them that the repository lacks, as the App, and leaves the ones it has as they
are; it fails when it cannot list the labels or create one, and starts no tick. `triphammer add` runs it (On a machine
of its own), and the doctor reports each one missing. `upkeep` is not among them: the runner makes sure it exists when
it opens an upkeep issue (Weekly upkeep).

## Weekly upkeep

When a tick has nothing else to do (no parent to close, no pull request to repair, no ready issue) and no issue
labelled `upkeep`, open or closed, was created in the last 7 days, `ticket-decide.py` prints `upkeep`. `ticket-runner`
then makes sure the `upkeep` label exists, opens an issue titled `Upkeep: week of <date>` (the tick's UTC date) with
that label, and runs it as a ticket in the same kind of session. The session follows the `triphammer:upkeep` skill,
reports on the issue and closes it, with no pull request. An upkeep issue without a creation time in the list counts as
recent, so missing data never opens a second one.

The brakes stop it like any other action: the `stop` file, a `stop-agents` issue, and `hold` on the open upkeep issue.
`ticket-runner --plan` prints `upkeep` and creates nothing. A run that ends with its issue closed made progress, so it
never counts toward the three runs that earn `needs-owner`; an upkeep issue still open after a run counts like any
other ticket, and an open one stays a ready issue that later ticks retry.

`ticket-decide.test.mjs` runs the script with `python3` on small made-up issue and pull request lists in the shapes
`gh` returns, covering each decision. It runs with the other tooling tests (`npm run test:tooling`), which CI runs in
the `test` workflow (`.github/workflows/test.yml`).

## Second-model audit

`local-audit --commit <rev> --area <text> --output <file> [--repo <path>] [--model qwen|codex]` runs the
`triphammer:reviewer` agent on one area in an isolated clone. Upkeep runs it on each area its Opus agents audit (the
`triphammer:upkeep` skill §3), once with Qwen and once with Codex, one run at a time, each only when its module (`qwen-audit`, `codex`) is on.
It reads the Triphammer config on every run, and exits 2 when the model's module is off or lacks a required setting.

- It clones only `<rev>` and its ancestors from `<repo>` (default the config's `CHECKOUT`) into a fresh
  `mktemp -d` directory whose name says nothing about the area, with no remote, and refuses to run when the clone holds
  any commit past `<rev>`. The clone is removed when the script exits.
- The session stops after `$LOCAL_AUDIT_TIMEOUT` (a `timeout` duration, default `1h`) and gets no GitHub token.
- `<file>` gets the commit, area, model, the session's exit status and elapsed seconds, then the reviewer's result.
- The audit prompt asks the reviewer to read for the classes of `triphammer:review-checklist` and of the audited commit's
  `reviewChecklist`, then as its `reviewSkills` do, and names the commands it may run: git and the commit's `build`,
  `focused` and `suite` checks, which are also the only commands besides git the Qwen session is allowed. A commit
  without a project file gets neither; a malformed one stops the audit with exit 2.

### Qwen (`--model qwen`, the default; the `qwen-audit` module)

The model is the config's `QWEN_MODEL`, served by an Anthropic Messages API at its `QWEN_BASE_URL`. A local model
server usually fits about one request, so runs never overlap.

- The session is `claude -p --plugin-dir <plugin> --agent triphammer:reviewer --model <QWEN_MODEL>`, the Triphammer
  plugin's reviewer: `<clone>/plugins/triphammer`, at the audited commit, when `<repo>` is Triphammer's own repository,
  and Triphammer's checkout's `plugins/triphammer` when it is another one, with every Claude model alias pointed at Qwen, project settings only, no MCP servers and `--permission-mode dontAsk`. It may use Read, Grep, Glob, `git`
  and the audited commit's `build`, `focused` and `suite` checks (each command with or without more arguments; one with
  a `<placeholder>` with anything in its place); edits, the web, subagents, `gh` and `git` commands that reach a remote are denied.
- The API key is read from the file the config's `QWEN_KEY_FILE` names and goes only
  into the session's environment as `ANTHROPIC_AUTH_TOKEN`, never on a command line or into any output; a result that
  echoes it has it redacted. The cost figures Claude Code reports for these sessions are not real.

### Codex (`--model codex`, the `codex` module)

The session is `codex exec -c model_reasoning_effort="medium" --sandbox workspace-write --ephemeral -m
<CODEX_AUDIT_MODEL> --json -o <result file>` in the clone. The prompt is the reviewer brief from that same plugin's
`agents/reviewer.md`, without its frontmatter, followed by the same area prompt Qwen gets; Codex
reads `AGENTS.md` and the skills it names by itself. Its sandbox blocks the network and lets commands write only in the clone and `/tmp`.

Prerequisites on the machine: `/usr/bin/bwrap` with the AppArmor profile at `/etc/apparmor.d/bwrap`, and `codex login` on
the owner's ChatGPT account. The script uses only the exit status of `codex login status`, and never reads, copies or
prints Codex's auth files.

Codex runs on the owner's ChatGPT Plus plan, so the script limits them. It records the start of each run (whatever its
outcome) in `~/.local/state/local-audit/codex-runs` (`$XDG_STATE_HOME/local-audit` when that is set), and before a run:

- skips it when the runs in the last 7 days reach the weekly cap;
- skips it when `100 - run_percent * (runs in the last 5 hours + 1)` is under the floor: `codex exec --json` reports no
  usage, so each run is estimated to use `run_percent` of the 5-hour window.

Each limit comes from its environment variable, else from a `key=value` line in
`~/.local/state/local-audit/codex-settings` (`#` starts a comment), else from the Triphammer config, else from its default:

| `codex-settings` key | Variable | Config setting | Default |
| --- | --- | --- | --- |
| `weekly_cap` | `CODEX_AUDIT_WEEKLY_CAP` | `CODEX_WEEKLY_CAP` | 25 runs |
| `floor_percent` | `CODEX_AUDIT_FLOOR_PERCENT` | `CODEX_FLOOR_PERCENT` | 10 (% of the 5-hour window left) |
| `run_percent` | `CODEX_AUDIT_RUN_PERCENT` | `CODEX_RUN_PERCENT` | 5 (% of the 5-hour window per run) |

The result counts as an audit only when the session exited 0, at least one command succeeded in the sandbox, no error
event names the sandbox or a usage limit, and the result file is not empty. A sandbox that fails every command can
otherwise end in an agent message that looks like an empty audit.

### Exit status

| Exit | Meaning | `<file>` |
| --- | --- | --- |
| 0 | The audit ran: `audited <sha> in <n>s`. | written |
| 1 | The session failed, the Qwen key file is missing, unreadable or empty, or the commit has no reviewer brief (Codex). | written when a session ran |
| 2 | Bad arguments, a bad Codex setting, a bad Triphammer config, or the model's module is off or lacks a required setting (named in the message). | not written |
| 3 | The model is unavailable, nothing was audited: `local model unavailable at <url>` when the Qwen server does not answer an HTTP request (the probe sends no key), or `Codex unavailable: <reason>` (not installed, not logged in, sandbox failure, timeout, no result). | not written |
| 4 | Codex was skipped, nothing was audited: `Codex: weekly cap reached`, `Codex: 5-hour floor reached` or `Codex: usage limit` (an error from Codex). | not written |

`local-audit.test.mjs` runs it against throwaway repositories, a local HTTP listener, a fake `claude`
(`fake-claude.mjs`) and a fake `codex` (`fake-codex.mjs`) that record their arguments, environment, working directory
and the history they can see; the fake `codex` also acts out a clean run, an empty result, a sandbox failure, a usage
limit, a failed stream and a hang. `LOCAL_AUDIT_NOW` (epoch seconds) fixes the clock the run counts use.

Four options apply to Codex only, for `security-review`: `--codex-model <name>` (default the config's
`CODEX_AUDIT_MODEL`, which is then not required), `--brief
<file>` (a prompt that replaces the reviewer brief and the audit prompt; the commit and area follow it), `--sandbox
read-only` (commands write nowhere; the default is `workspace-write`), and `--weight <n>` (default 1): the run counts
as `n` runs, so it is skipped unless the cap and the floor leave room for all `n`, and it records `n` lines in
`codex-runs`. Reasoning effort stays medium.

## Security review

`security-review` belongs to the `codex` module: with the module off, or without the config's `CODEX_SECURITY_MODEL`,
it exits 2 naming which, and `ticket-runner` never calls it. Its comments are headed `Security review (<model>)`,
the model's name without a trailing `-latest`.

`security-review --pr <n> [--repo <path>]` runs after every session (`ticket-runner`, after `publish-demos`) on each
open pull request of the run: the ones closing the ticket's issue, listed again after the session, or the repaired one.
The repository is the config's `REPO`, and `<repo>` defaults to its `CHECKOUT`. It reviews a pull request only when it
is open and changes a path the project's `securityReviewPaths` matches (the example project's: `bin/`,
`status/`, `plugins/triphammer/hooks/`, `.claude/settings.json`, `scripts/risk-tier*`, `.github/`, `.triphammer/`
or a systemd unit, `*.service`, `*.timer`, `*.path`; a project that declares none has nothing reviewed), and its head
commit is not yet in `security-reviewed` in the state directory. That file is the script's own record, one line
`<REPO> <n> <head>` per head it posted a comment on, reviewed, skipped or failed; `agent-guard.py` keeps agents from
writing the state directory, and pull request comments are never read, so a comment that looks like a review cannot
stop one.
The file filter decides and labels are not read: the `risk-tier` workflow adds `needs-owner` some seconds after the pull
request opens, often after the session has ended, and every path the filter matches escalates anyway. It reads
the changed files from the paginated REST list (`gh api --paginate repos/<owner>/<repo>/pulls/<n>/files`), since `gh pr
view` stops at 100, and exits 1 without a comment when it cannot. It fetches `pull/<n>/head` into `<repo>` and runs
`local-audit --model codex --codex-model <CODEX_SECURITY_MODEL> --sandbox read-only --brief security-review-brief.md
--weight 1` over the changed files and whatever they call. The brief is the copy next to the script, in the main
checkout, so a pull request cannot change the prompt that reviews it.

It then posts one comment headed `Security review (<model>)` with the head commit: the model's findings with
their reproductions, or its `No findings.` line, when the run audited something; otherwise `Skipped: <reason>` (exit 3
or 4, such as the weekly cap) or `Failed (exit <n>): <reason>`, saying that nothing was reviewed, and appends the head
to `security-reviewed`; when it posted the comment but cannot record the head it exits 1 saying so. The comment is
advisory: merge-policy, `land-pr` and `merge-when-ready` never read it, and a missing, skipped or failed review never
blocks or delays a merge. The runner logs the script's output and failures and carries on. Before the reviews it
rewrites its `current` file without the session's pull requests and branch, so `merge-when-ready` may update them
while a review runs.

`security-review --full-area --commit <rev> --output <file>` is upkeep's monthly audit of the whole area, the
project's `securityReviewArea` (the example project's: the paths above, with the `.claude/settings.json` hooks and
`scripts/risk-tier.mjs` and `risk-tier-base.sh`); it exits 2 when the project declares none. It is one run of
weight 4, writes `local-audit`'s `<file>`, posts nothing and exits with `local-audit`'s status.

`security-review.test.mjs` runs it with the fake `gh` and the fake `codex` against throwaway repositories.

## Self-update

At the start of each tick, after the brakes (the project's and the shared `stop` files, the shared `backoff`, a
`stop-agents` issue) and before it plans anything, `ticket-runner` runs `update-checkout` on Triphammer's checkout, the
one it lives in, whether or not any project's `CHECKOUT` is that checkout, and then on the project's `CHECKOUT` when
that is another repository:

- It updates only a checkout on `main` with a clean tree: no staged, unstaged or untracked files outside `.gitignore`.
  Otherwise it logs why (another branch, a detached HEAD, local changes, or a `main` that cannot fast-forward) and the
  tick carries on with the checkout as it is. It never merges, rebases or resets.
- When the fast-forward changed `status/` or `bin/config.sh`, it runs
  `systemctl --user restart triphammer-status.service`.
- When the fast-forward changed `bin/demo-gallery` or `bin/config.sh`, it runs
  `systemctl --user try-restart 'demo-gallery@*.service'`, which restarts every running gallery and starts none.
- A failure (a fetch that cannot reach GitHub, a failed restart) is logged and the tick carries on; a failed restart
  does not stop the other one.
- `ticket-runner --plan` never updates the checkout.

Bash reads a script while it runs it, so a pull that rewrites `ticket-runner` must not change the run in progress. The
self-update is one `if` block, which bash reads whole before running any of it. When the update changed
`ticket-runner`, the block ends by re-executing the updated copy from its start with `TICKET_RUNNER_UPDATED=1`, which
skips the self-update (so it happens at most once per tick) and keeps the project's lock already held on file
descriptor 9 (the shared lock is taken later, on file descriptor 8). The rest of the tick then runs entirely from the new
copy. The copy it re-executes is always the one next to the running script, in Triphammer's checkout, which every
project's tick updates.

The self-update reaches only what the service user owns: the checkouts, and with them the linked scripts, units and the
plugin that sessions load from Triphammer's checkout. It reloads no unit. On a machine of its own, `triphammer update`
installs what root does (packages, Node, `/usr/local/bin/triphammer`, the user-scope plugins, each project's
toolchains) when it is missing or a pin changed, and reloads the units when one changed (On a machine of its own,
Update).

Tests (`npm run test:tooling`) run the scripts against throwaway git repositories, never the real checkout:
`TRIPHAMMER_CONFIG` names a Triphammer config in the test's temporary directory (`checkoutSetup` and `runnerSetup` in `fixture.mjs`
write one, with the example project's repository and App author and the throwaway checkout, and copy the project file of the
example project in `test-fixtures/example-project` into it), `STATUS_RESTART` and `DEMO_GALLERY_RESTART` replace the restart commands, `TICKET_RUNNER_START`
stands in for the runner start,
`TICKET_RUNNER_BRAKE_SECONDS` and `TICKET_RUNNER_BRAKE_GRACE_SECONDS` shorten the brake checks during a session,
and fakes of `gh`,
`claude`, `codex`, `docker` and `demo-publish` stand in for the real ones. `runnerSetup` always puts the fake `docker`
(`fake-docker.mjs`) on `PATH`, so a runner test never reaches the machine's real Docker. Every test that fakes `gh` uses `fakeGh` in `fixture.mjs`,
which records each call and answers from canned responses keyed by argument prefix (`fake-gh.mjs`). The
`github-app-token` tests put a fake `curl` (`fake-curl.mjs`) first on `PATH`, answering with canned GitHub responses
for one or two installations,
sign with a key openssl generates in the test, and point `GITHUB_APP_CONFIG_DIR`, `XDG_CACHE_HOME` and `HOME` into the
test's temporary directory, so they never read Triphammer's App files or reach GitHub.
A new fake command is a `fake-<name>.mjs` script beside the tests, put on `PATH` with `fakeCommand(bin, name, dir)` in
`fixture.mjs`, which writes the shim that runs it with the directory it reads from and records into. The
`provision` and `provision-project` tests (through `provision-fixture.mjs`) act out a whole machine with
`fake-machine.mjs`, one fake for the package and account tools
(`apt-get`, `dpkg-query`, `useradd`, `loginctl`, `systemctl`, `curl`, `runuser` and the rest) sharing one state file,
take the system paths under `TRIPHAMMER_PROVISION_ROOT` and clone from local repositories under
`TRIPHAMMER_PROVISION_GIT_BASE`, so they run without root and change nothing outside their temporary directory. For a
private repository its `git` clones only when git's credential helpers give github.com credentials, which the real
`github-app-token` mints from a test key against canned GitHub responses.

The example project stands in for a project Triphammer serves: a project file, risk rules for the engine tests in
`scripts/risk-tier.test.mjs`, and the teardown script the runner tests run. CI runs the node tests in three shards
side by side (`TEST_SHARD=k/3 npm run test:node`).

## Doctor

`ticket-runner --doctor` (with `TRIPHAMMER_PROJECT=<project>` on a machine of several projects) checks the machine the
project runs on and starts no tick: no self-update, no claims, no sessions. It prints one line per problem,
`<what is wrong>. Fix: <the fix>`, then `<n> problem(s) found` and exits 1; with nothing wrong it prints `all good`
and exits 0. A missing or malformed Triphammer config stops it with exit 2 and the config's own message (Configuration).
It looks every command up on the units' PATH, not on the caller's: the `Environment=PATH` of `ticket-runner@.service`
in Triphammer's checkout, or of the last of the user's drop-ins for it that sets one (`ticket-runner@.service.d/` and
`ticket-runner@<project>.service.d/` under `${XDG_CONFIG_HOME:-~/.config}/systemd/user`, by file name, the project's
file before the template's of the same name; Install, A project's toolchain), with `%h` as `$HOME`. It reports that
unit file when it is missing or sets no PATH. `ticket-runner --doctor --before-start`, which `triphammer add` runs,
leaves out the Units check, as only `triphammer start` enables them, and prints `left out the units <unit>..., which
triphammer start <project> enables` before its last line; any other argument exits 2.

| Check | Passes when |
| --- | --- |
| .NET SDK | `dotnet --list-sdks` lists an SDK the checkout's `global.json` accepts: with `rollForward` `disable` the pinned version only; `patch`, `latestPatch` or none, the same feature band at or after it; `feature` or `latestFeature`, the same major.minor; `minor` or `latestMinor`, the same major; `major` or `latestMajor`, any later one. A prerelease counts only with `allowPrerelease` true. A checkout without `global.json` is not checked. |
| Node | `node --version` is within the checkout's `package.json` `engines.node` when its comparators are `>=`, `>`, `<=`, `<`, `=` or bare versions of one to three parts, blank-separated; other forms (`^`, `~`, `\|\|`) only need `node` to run. A partial version is a range as in semver: `24` is `24.x`, `<=24` is `<25.0.0`, `>24` is `>=25.0.0`, `<24` is `<24.0.0`, and `24.1` is `24.1.x`. |
| Docker | `docker info` answers the user running the doctor, and `docker compose version` is 2 or later. |
| Playwright | Checked only when the checkout pins Playwright as `provision-project` reads it: a `package.json` that `git ls-files` lists names `@playwright/test` or `playwright` in `dependencies` or `devDependencies`. When the doctor cannot tell (no `jq`, no git checkout, a `package.json` that is not JSON), it checks. `${PLAYWRIGHT_BROWSERS_PATH:-~/.cache/ms-playwright}` holds a Chromium, and the newest revision of each kind there (`chromium-*/chrome-linux*/chrome` and `chromium_headless_shell-*/chrome-*/chrome-headless-shell`) prints a blank page with `--headless --no-sandbox --dump-dom about:blank` within 60 seconds, as Playwright starts it; one that cannot lacks its system libraries. Which revision the project's Playwright wants is left to the web tests. |
| Git identity | `git config user.name` and `user.email` are set for the user running the doctor (in the checkout, so any scope counts); git refuses to commit without them on a machine whose host name has no domain. Only whether they are set is checked, not their values. |
| Tools | `git`, `jq`, `python3` (Python 3), `gh`, `claude`, and `codex` with the `codex` module on, each run `--version`. Without `jq` the .NET SDK, Node `engines.node`, Claude Code login and plugin checks are skipped, and only `jq` is reported. |
| Credential files | `app-id`, `owner` and `agents.pem` in `${GITHUB_APP_CONFIG_DIR:-~/.config/github-app}`, and `QWEN_KEY_FILE` with the `qwen-audit` module on, are regular files owned by the user running the doctor, mode 600. It looks at them with `stat` only and never opens, reads or prints them. |
| The App | `gh api installation/repositories` succeeds, which only the App's installation token can do (the `gh` wrapper, see Install). |
| Labels | Once the App check passes, `gh label list` for `REPO` lists `hold`, `needs-owner`, `stop-agents`, `next` and `agent-working` (Labels), names compared case-insensitively. Each missing one is a problem whose fix is running `triphammer add <REPO>` again with the options the project was added with; a list that fails is a problem of its own, never a pass. |
| Logins | `claude auth status` reports logged in; `codex login status` succeeds with the `codex` module on. |
| Plugins | `claude plugin list --json` lists at user scope the Triphammer plugin (named by `.claude-plugin/marketplace.json` in Triphammer's checkout) and `humanizer@humanizer`, as `provision` checks them. Each missing one is a problem whose fix is running the installer again; a list that fails is a problem of its own, never a pass. Skipped without `jq`. |
| bwrap | With the `codex` module on, `bwrap --version` runs and `bwrap --unshare-user --ro-bind / / true` succeeds: Codex's sandbox needs unprivileged user namespaces, which Ubuntu restricts with AppArmor. |
| Qwen | `QWEN_BASE_URL` answers an HTTP request within 10 seconds, with the `qwen-audit` module on (any status counts; no key is sent). |
| Units | `systemctl --user is-enabled` says `enabled` for `ticket-runner@<project>.timer` and `merge-when-ready@<project>.timer`, and for `demo-gallery@<project>.service` with the `demo` module on. Left out with `--before-start`. |
| Checkout | `CHECKOUT` is on `main` with a clean tree, and after `git fetch origin` (the doctor's one change) its HEAD is `origin/main`, neither behind nor ahead. |

It passes on no command's output but version numbers, so no token, key or account name reaches what it prints. The
user it checks is the one running it, so run it as the service user.

## Install

This is the setup on a shared machine, such as the owner's workstation, where Triphammer runs as the owner's own
user and a session can reach whatever that user can: the owner's `~/.claude`, caches, Docker daemon and logins. It is
the weaker setup; a machine of its own (below) holds nothing but Triphammer's credentials.

The owner runs this once; agents cannot install persistence on the machine. Replace the placeholders with the project's
repository, checkout, App and owner. Each project gets a config file named after it and its own
instances of the template units; the scripts and units are linked once, from Triphammer's main checkout.

```sh
checkout=/srv/<project>                                               # Triphammer's checkout
git -C "$checkout" pull --ff-only                                     # the checkout must have bin/
project="$(jq -r .name "$checkout/.triphammer/project.json")"         # <project>
config="${XDG_CONFIG_HOME:-$HOME/.config}/triphammer"
mkdir -p "$config"
cat > "$config/$project.conf" <<EOF
REPO=<owner>/<repo>
CHECKOUT=$checkout
APP_AUTHOR=app/<app-login>
STATE_DIR=$HOME/.local/state/ticket-runner
OWNER=<owner-login>
EOF
# Optional: append MODULES and the settings of each module this machine runs (Configuration, Modules) to that file.
for unit in ticket-runner@.service ticket-runner@.timer merge-when-ready@.service merge-when-ready@.timer \
    demo-gallery@.service; do
  systemctl --user link "$checkout/systemd/$unit"
done
for script in ticket-runner merge-when-ready land-pr github-app-token gh demo-gallery; do
  ln -sfn "$checkout/bin/$script" ~/.local/bin/"$script"
done
# The App's files, filled in by the owner, each mode 600: app-id (its numeric id), owner (the account it is installed
# on, the default when the account can't be told) and agents.pem (its private key).
mkdir -p ~/.config/github-app && chmod 700 ~/.config/github-app
ls -l ~/.config/github-app/app-id ~/.config/github-app/owner ~/.config/github-app/agents.pem
# git asks github-app-token for github.com credentials, and only it (the empty value drops the helpers set before it).
git config --global --replace-all credential.https://github.com.helper ''
git config --global --add credential.https://github.com.helper '!github-app-token git-credential'
# git names the repository it asks about, so the token is for the App's installation on that repository's account.
git config --global credential.https://github.com.useHttpPath true
github-app-token > /dev/null && echo 'the App token works'
TRIPHAMMER_PROJECT="$project" ticket-runner --plan                    # reads the config; prints the next action
systemctl --user daemon-reload
systemctl --user enable --now "ticket-runner@$project.timer" "merge-when-ready@$project.timer"
systemctl --user list-timers 'ticket-runner@*' 'merge-when-ready@*'
# Optional, when the config turns the demo module on: serve the gallery at DEMO_GALLERY_HOST:DEMO_GALLERY_PORT.
systemctl --user enable --now "demo-gallery@$project.service"
TRIPHAMMER_PROJECT="$project" ticket-runner --doctor                  # lists anything still missing, with its fix
```

**A project's toolchain.** The units put only `~/.local/bin` and the system directories on `PATH`. A project whose
checks need a toolchain from elsewhere, such as one in the user's home, adds it with a systemd drop-in: a file
`~/.config/systemd/user/ticket-runner@.service.d/<name>.conf` for every project's sessions, or
`ticket-runner@<project>.service.d/<name>.conf` for one project's (`ticket-runner.service.d/` for the non-template
unit). systemd reads it after the unit, so its `PATH` replaces the unit's and must keep the unit's directories. A
project that pins a .NET SDK in `global.json`, installed into `~/.dotnet`, needs this one, which `provision-project`
writes when it installs an SDK:

```sh
mkdir -p ~/.config/systemd/user/ticket-runner@.service.d
cat > ~/.config/systemd/user/ticket-runner@.service.d/dotnet.conf <<'EOF'
[Service]
Environment=PATH=%h/.local/bin:%h/.dotnet:%h/.dotnet/tools:/usr/local/bin:/usr/bin:/bin
Environment=DOTNET_ROOT=%h/.dotnet
EOF
systemctl --user daemon-reload
systemctl --user show -p Environment "ticket-runner@$project.service"   # shows the drop-in's PATH and DOTNET_ROOT
```

`systemctl --user edit ticket-runner@.service` opens the same kind of file in an editor.

**Several accounts.** An installation token reaches only the repositories of the account the App is installed on.
When the projects belong to more than one account, such as the owner's own account and an organization, the owner
installs the App on each of those accounts. The `owner` file stays one login, the default account, and each tool picks
the installation itself: `ticket-runner` and `merge-when-ready` give everything they start the owner of their
project's `REPO` (`GITHUB_APP_OWNER`), the `gh` wrapper takes it from `-R`/`--repo`, and git from the URL once the
`useHttpPath` line above is set, which a machine installed before it needs only for git run outside those two. Each
account's token is cached on its own. A project an organization owns also needs `OWNER` in its config and the
repository variable `TRIPHAMMER_OWNER` (Configuration).

Another project on the same machine needs only its config file, `<name>.conf` with its own `REPO`, `CHECKOUT` and
`STATE_DIR`, and `systemctl --user enable --now ticket-runner@<name>.timer merge-when-ready@<name>.timer`; the projects
then run one session at a time between them (Several projects).

A machine that runs the non-template units (`ticket-runner.timer` and `merge-when-ready.timer`, which serve the project of
the checkout the scripts live in) cuts over by linking the template units as above, checking that the project's
config is `<name>.conf` under `~/.config/triphammer/`, and then running:

```sh
systemctl --user disable --now ticket-runner.timer merge-when-ready.timer
systemctl --user daemon-reload
systemctl --user enable --now "ticket-runner@$project.timer" "merge-when-ready@$project.timer"
```

A run already in progress under `ticket-runner.service` finishes; it holds the shared lock, so the template unit's ticks
start nothing until it ends. The merge queue's log becomes `merge-when-ready-<project>.log`.

All the services set `UMask=0077`, and `ticket-runner` and `merge-when-ready` set `umask 077` themselves, so the state
in the state directory (the session transcripts in `runs/` hold tool output), the shared directory and the merge queue's
logs are readable only by the service user; `ticket-runner` also makes its state directory, `runs/` and `attempts/` mode
700 on every start, and the shared directory and its `waiting/` once it has decided what to do. `demo-publish` sets its
own umask of 022, so the gallery stays readable when something running as another user, such as a proxy, serves it
instead of `demo-gallery`. Run
`systemctl --user daemon-reload` after pulling changed units, since the units are linked from the checkout (on a
machine of its own, `triphammer update` does).

The units name no checkout: they run the `~/.local/bin` symlinks, which point into Triphammer's checkout. The symlinks
also keep `ticket-runner`, `merge-when-ready`, `land-pr`, `github-app-token`, `gh` and `demo-gallery` on `PATH` for agents and for
`status/`, with the `gh` wrapper ahead of GitHub's own `gh`, which it runs;
`ticket-runner` calls `demo-publish` by path. Under systemd, `XDG_CONFIG_HOME` is whatever the user manager has, usually
unset, so keep the config under `~/.config/triphammer/` unless the manager sets it. Stopping the timer does not stop a
run in progress; `systemctl --user stop ticket-runner@<project>.service` does, and so do the owner's brakes (Sessions). `status/README.md` installs the
status page the same way.

## On a machine of its own

`provision` turns a fresh Ubuntu server, a VM the owner creates, into a machine that runs Triphammer and nothing else:
its own service user, Docker daemon, `~/.claude` and caches, and only Triphammer's credentials. A session that takes
over the machine reaches no more than a run already has, and the owner rebuilds the machine from the script. It
assumes no Ubuntu release: the tools whose own install does not depend on the release come from their vendors (the .NET
SDK through `dotnet-install`, Node from nodejs.org, Playwright's browsers, Claude Code's installer), and Docker Engine
and the GitHub CLI come from their vendors' apt repositories, or from Ubuntu's own packages (`docker.io` with
`docker-compose-v2`, `gh`) when a vendor's repository does not serve the release; it prints which one it used.

**Size.** It depends on the projects' checks. For a project whose ticket run builds and tests .NET, runs a full gate
with a database container per worktree and web end-to-end tests in Chromium, one session at a time, 4 vCPUs and 16 GB of memory are a working minimum (8 vCPUs make
the gate noticeably quicker), and 100 GB of disk holds the Docker images and gate databases, the worktrees, the .NET
SDK and NuGet cache, the npm cache, Playwright's browsers (about 1 GB per version) and the session transcripts.

**Set the machine up.** The owner runs `install.sh` as an ordinary user who may use sudo, or as root. It asks sudo for
the password once, clones Triphammer into a temporary directory, runs that clone's `provision` as root with the
arguments given and removes the clone afterwards; without `--triphammer` it adds
`--triphammer <TRIPHAMMER_REPO> /srv/triphammer`. `TRIPHAMMER_REPO` (default this repository) and `TRIPHAMMER_REF`
(default `main`) choose what it clones:

```sh
curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/install.sh | TRIPHAMMER_REPO=<owner>/<repo> bash
```

From a clone, `sudo bin/provision --triphammer <owner>/<repo> /srv/triphammer` does the same.

| `provision` argument | What it is |
| --- | --- |
| `--triphammer <owner/name> <checkout>` | Triphammer's repository and where to clone it. The units, the `~/.local/bin` links and the plugin install point at this checkout. |
| `--user <name>` | The service user, default `triphammer`. |
| `--home <dir>` | The user's home when provision creates it, default `/home/<user>`. |
| `--dry-run` | Prints each change it would make (`would: ...`) and makes none. Steps that read a checkout that is not cloned yet are listed without their details. |
| `--no-owner-steps` | Leaves out the closing list of what is left for the owner. |
| `--owner-steps` | Alone: prints only that list, for the user and home the machine file names, and changes nothing. |

It installs what every project shares: git, `jq`, Python 3, curl and openssl from Ubuntu's archive, Docker Engine with
Compose v2, `gh`, the service user in the `docker` group with lingering on (so its user units run without a login),
Triphammer's checkout cloned as that user, Node at the version its `.node-version` pins (one Node for every project,
into `/usr/local`) and Claude Code. It links the scripts, `triphammer-status` and the units as Install does, including
`demo-gallery@.service` and `triphammer-status.service`, installs the Triphammer plugin at user scope from Triphammer's
checkout and the humanizer plugin (`humanizer@humanizer`) at user scope from the `blader/humanizer` marketplace on
GitHub, each only when it is missing, points git's github.com credentials at `github-app-token` with `useHttpPath` on and creates
`~/.config/github-app` (mode 700, empty). It writes the machine file `/etc/triphammer.conf` (Triphammer's repository
and checkout, the service user and its home), and installs `bin/triphammer` as `/usr/local/bin/triphammer`, a copy root
owns rather than a link into the checkout the service user can write. It enables no timer.

**What is left.** `provision` ends with the owner's steps that are still left, numbered, each with its fix, or with
`Nothing left for the owner: the machine is ready.` It tells from what it can check without reading a credential's
value, and prints no file's content and no command's output:

1. The App's files: `app-id`, `owner` and `agents.pem` in `~/.config/github-app`, each owned by the service user with
   mode 600, checked by owner and mode alone as the doctor does. A file that is missing, not a regular file, someone
   else's (`chown`) or of another mode (`chmod 600`) gets a line of its own. When all three pass, it runs
   `github-app-token app-slug` as the service user (the copy beside `provision`), and a failure means GitHub did not
   accept the key, or could not be reached: `app-id` or `agents.pem` is not the App's.
2. Claude Code's login: the exit status of `claude auth status`, run as the service user in a session of its own.
3. Projects: with no config in `~/.config/triphammer/`, `triphammer add <owner>/<repo>`; once one project's timers
   (`ticket-runner@<name>.timer`, `merge-when-ready@<name>.timer`) are not both enabled, each project, with
   `triphammer start <name>` for those.
4. The status page, optional, while `triphammer-status.service` is not enabled.

**Add a project.** Once the owner has placed the App's files and logged Claude Code in (Credentials, below):

```sh
triphammer add <owner>/<repo>
triphammer add <owner>/<repo> /srv/<project> --modules demo,codex --set OWNER=<owner-login> \
  --set DEMO_GALLERY_DIR=/home/triphammer/demo-gallery --set DEMO_URL=http://127.0.0.1:8788/ \
  --set CODEX_AUDIT_MODEL=<model> --set CODEX_SECURITY_MODEL=<model>
```

`triphammer add` asks sudo for the password once, clones Triphammer's repository (from the machine file) into a
temporary directory as the caller, runs that clone's `provision-project` as root and removes the clone, so root never
runs code from the checkout the service user can write. It then runs `ticket-runner --labels` as the service user, whose
`gh` acts as the App, to create the labels Triphammer uses that the repository lacks (Labels; a failure is reported and
undoes nothing, and the doctor lists what is still missing), runs the doctor for the project with `--before-start`,
which leaves out the units `start` enables and says so (Doctor), and prints the command that starts it. With
`--dry-run` it does neither.

| `provision-project` argument | What it is |
| --- | --- |
| `<owner/name>` | The repository. Its config is `~/.config/triphammer/<name>.conf`, with `<name>` from its `.triphammer/project.json`, and it gets its own pair of timers. |
| `<checkout>` | Where to clone it, default `/srv/<repository name>`, or Triphammer's checkout when it is Triphammer's own repository. |
| `--modules <m,...>` | The modules the project turns on (`MODULES`, Configuration), in place of those its config has; `--modules ''` turns every module off. Each module's required settings must come with it or be in the config already. |
| `--set KEY=VALUE` | One more setting of its config, any optional one (Configuration, Modules) or `STATE_DIR`, which defaults to `~/.local/state/triphammer/projects/<name>`. |
| `--unset KEY` | Removes a setting the config has, any but `REPO`, `CHECKOUT` and `APP_AUTHOR`, and not one the same run gives with `--set`, nor `MODULES` with `--modules`. A `STATE_DIR` removed goes back to its default. |
| `--app-author <login>` | `APP_AUTHOR`. Without it, the config's `APP_AUTHOR`, or else `app/<slug>` with the App's slug, which `github-app-token app-slug` reads from the App's files; when they are not placed yet it stops and says so. |
| `--dry-run` | Prints each change it would make and makes none. |

It installs what the project needs for a ticket run, a repair run, the full gate and the web end-to-end tests: its
checkout cloned as the service user, the .NET SDK its `global.json` pins (into `~/.dotnet`, with the drop-in under A
project's toolchain), and Playwright's Chromium at the version each `package.json` pins, with its system libraries from
Playwright's `install-deps`, or from Ubuntu's archive when Playwright does not know the release; Chromium must then start
headless. A project whose `.node-version` pins another Node than the machine's is refused. With the `codex` module it
also installs Codex (into `~/.local`), bubblewrap and the AppArmor profile `/etc/apparmor.d/bwrap`, which lets `bwrap`
create user namespaces (a profile there that it did not write is left alone), and with the `demo` module ffmpeg. It
gives git a commit identity in the user's `~/.gitconfig` and writes the project's config; a config with other content is
rewritten and the old one kept as `<name>.conf.old`. When the project has a config already (the one that names its
repository), each setting in it, its checkout included, stays unless the run gives another or removes it with
`--unset`; the file is read as `KEY=VALUE` lines and never run, and a key in it that is not a setting stops the run
until `--unset` removes it. It prints a line for each setting, `config: <KEY> added`, `kept`, `changed` or `removed`,
with the value unless the key's name looks like a secret's, and `--dry-run` prints the same lines. Another config of a different repository at the same checkout or
with the same name stops it. It enables no timer.

Both scripts check every argument before anything changes; an unknown flag or a bad value exits 2 with the usage, and
the project's settings go through `config.sh`, so a config `provision-project` writes is one the scripts accept. Each
step runs only when what it makes is missing or different, so a second run changes nothing that is already right and
ends with `Nothing to change`. What they run in the user's checkouts, git and `jq` among them, runs as the user, never
as root. A failed step exits 1 naming it, and the next run carries on from there. A checkout path that holds anything
but the user's clone of its repository stops them before anything changes.

**Private repositories.** `~/.config/github-app` and the credential helper come before any clone, and every clone asks
`github-app-token` for github.com credentials: the one Triphammer's checkout links into `~/.local/bin` once it is
cloned, and until then a copy of the one beside the running `provision`, which it puts in a directory under `/tmp`
that root owns and the user may read and run, given to that clone alone (`git -c credential.<url>.helper=...`) and
removed when the script ends. A private repository therefore clones once the App's files are in place: the first run
stops at the clone, naming the directory, the owner places them (below) and runs it again.

**Commit identity.** git refuses to commit without a name and email on a machine whose host name has no domain, and a
session may not set them, so `provision-project` sets `user.name` and `user.email` in the user's global git config, each
only when it is not set already: for an `APP_AUTHOR` of `app/<slug>`, the App's bot, `<slug>[bot]` at
`<slug>[bot]@users.noreply.github.com`; for an account login, that login at `<login>@users.noreply.github.com`. GitHub
links a bot's commits to it by the form `<id>+<slug>[bot]@users.noreply.github.com`; to use it, set `user.email` that
way as the user (`git config --global user.email ...`) and `provision-project` keeps it.

**Credentials.** Neither script reads or writes one; `provision` ends by listing those still missing (What is left,
above) and `provision-project` the ones it needs. The owner places them by hand, each owned by the service user and
mode 600:

- the App's files in `~/.config/github-app`: `app-id`, `owner` and `agents.pem` (Install);
- a Claude Code login: `sudo -iu triphammer claude auth login`, which prints a URL to open on any machine. Or
  `claude setup-token`, which prints a long-lived token for `CLAUDE_CODE_OAUTH_TOKEN`; it then goes in a file under
  `~/.config/environment.d/`, which the user's systemd manager reads when it starts, and the doctor's login check needs
  it in the shell it runs in too;
- with `qwen-audit`, the Qwen server's key in the file `QWEN_KEY_FILE` names;
- with `codex`, `sudo -iu triphammer codex login`.

**Check and start.** `triphammer doctor [<project>]` lists what is still missing (Doctor), `triphammer plan
[<project>]` prints what the next tick would do, and `triphammer start [<project>]` enables and starts
`ticket-runner@<name>.timer` and `merge-when-ready@<name>.timer`, plus `demo-gallery@<name>.service` with the `demo`
module. A project left out is the machine's only one; with several, the command lists them. `doctor` and `plan` run
`ticket-runner` as the service user (`sudo -iu triphammer env XDG_RUNTIME_DIR=/run/user/<uid> TRIPHAMMER_PROJECT=<name>
~/.local/bin/ticket-runner --doctor`, without sudo when the caller is that user): `sudo -i` leaves `XDG_RUNTIME_DIR`
unset, and without it the doctor's `systemctl --user` check cannot reach the user's manager; lingering keeps
`/run/user/<uid>` there. `triphammer doctor` checks the units too, so it reports the timers as not enabled until they
are started; the doctor `add` runs leaves them out. `start` runs
`sudo systemctl --machine=triphammer@ --user enable --now ...`. The status page is
`sudo systemctl --machine=triphammer@ --user enable --now triphammer-status.service`. The status page and the gallery
listen where the configs say (`STATUS_HOST`, `DEMO_GALLERY_HOST`).

**Update.** The runner keeps what the service user owns current by itself: each tick fast-forwards Triphammer's
checkout and the project's (Self-update), and sessions load the plugin from Triphammer's checkout. What `provision`
and `provision-project` install as root does not follow by itself: a package a newer `provision` needs, the Node that
Triphammer's `.node-version` pins, `/usr/local/bin/triphammer`, a plugin missing at user scope, and each project's
toolchains (the .NET SDK and Playwright's Chromium its checkout pins). The owner runs `triphammer update [--dry-run]`
for those, as `add` is run; nothing runs it on a timer. Like the scripts it runs, it installs what is missing or
different and upgrades no package or plugin that is installed already. It asks sudo for the password
once, clones Triphammer's repository into a temporary directory and runs that clone's `provision` as root with the
machine file's repository, checkout, user and home, then the clone's `provision-project` for each project that has a
config, with the `REPO` its config names and no setting, so each keeps its settings. When systemd reports that a unit
the projects use changed on disk (`NeedDaemonReload`), or cannot say, it runs
`sudo systemctl --machine=triphammer@ --user daemon-reload`; it enables, starts and stops no unit. It says whether
anything changed, then runs the doctor for each project and exits 1 when a doctor finds a problem. It ends with what
is left for the owner, from the clone's `provision --owner-steps` as root (What is left, above; its first `provision`
run leaves the list out with `--no-owner-steps`); a report that fails makes it exit 1. A failing `provision` stops it;
a failing `provision-project` does not stop the other projects, and `update` exits with its status. `--dry-run` passes
`--dry-run` to each script, prints `would: reload ...` for the reload, runs no doctor and changes nothing; it still
ends with the list, which only reads.

**Moving an existing install.** Two machines must never run the same project at once. On the old machine, stop its
timers (`systemctl --user disable --now 'ticket-runner@*.timer' 'merge-when-ready@*.timer'`, or the non-template
`ticket-runner.timer` and `merge-when-ready.timer`, and the gallery and status units) and let a run in progress end, or
stop it with `systemctl --user stop 'ticket-runner@*.service'`. Then start the new machine's timers as above. Leave the
old checkout, its worktrees and its state alone: nothing on the new machine reads them, and they stay as a record and a
way back.
