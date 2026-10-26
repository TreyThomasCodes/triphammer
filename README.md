# Triphammer

Triphammer works through a GitHub repository's issues with Claude Code, unattended. Every ten minutes it picks the
next ready issue and starts a headless session in a fresh worktree. The session writes the change, has other agents
review it, opens a pull request and merges it if the project's rules allow. Anything the rules don't allow waits for
your approval.

You steer it with issues and labels, and it keeps going until you stop it.

## Requirements

- An Ubuntu server for Triphammer alone, such as a VM. A project with a full build, a database per worktree and
  browser tests needs 4 to 8 vCPUs, 16 GB of memory and 100 GB of disk. A lighter project needs less.
- A GitHub App for the agents, installed on each account that owns one of your repositories. Give it read and write
  access to contents, issues and pull requests, and nothing else. Without the workflows or administration
  permissions, the agents can't change your CI or your branch rules.
- A Claude account for Claude Code.

## Install

Setting up takes three steps on the server, as a user who can run `sudo`.

First, set up the machine:

```sh
curl -fsSL https://raw.githubusercontent.com/TreyThomasDotCodes/triphammer/main/install.sh | bash
```

This installs git, Docker, Node, the GitHub CLI and Claude Code, creates a `triphammer` user and clones Triphammer to
`/srv/triphammer`. For that user it installs the Triphammer plugin and the humanizer plugin, which comes from the
`blader/humanizer` marketplace on GitHub. It asks for your password once. You can run it again at any time, since it only changes what isn't
right yet. To see what it would do without doing it, end the line with `bash -s -- --dry-run` instead.

Second, place the credentials. The installer never reads or writes one, so you put each in place by hand:

1. The App's ID, account and private key go in `/home/triphammer/.config/github-app/` as `app-id`, `owner` and
   `agents.pem`, each owned by `triphammer` with mode 600.
2. Log Claude Code in with `sudo -iu triphammer claude auth login`.

Third, add each repository you want served, then start it:

```sh
triphammer add <owner>/<repo>
triphammer start <project>
```

`triphammer add` clones the repository to `/srv/<repo>`, installs the toolchains it pins, writes its config, creates the
labels Triphammer uses that the repository lacks and runs the doctor, which lists anything still missing and how to fix
it, but for the timers. Run again for a project that has a config, it keeps each setting unless you give another, with
`--set KEY=VALUE`, `--modules` or `--app-author`, or remove one with `--unset KEY`, and it prints what each setting
became. `triphammer start` turns on its timers.

[`bin/README.md`](bin/README.md) covers every option, the configuration, and running Triphammer on a machine you also
use for other things.

## Set up a project

A project describes itself in two files in its own repository:

- `.triphammer/project.json` names the project and the commands that build and test it. It can also name a review
  checklist, extra review skills and a skill that checks UI changes.
- `.triphammer/risk-tier.json` decides, from the paths a change touches, whether the change merges by itself, waits
  for your approval or is refused. CI reads these rules from the base branch, so a pull request can't loosen its own.

Then protect the default branch with three required checks: `closing-issue`, `owner-approval` and your tests. Add
this workflow to the project as `.github/workflows/risk-tier.yml` for the first two:

```yaml
name: risk-tier
on:
  pull_request:
    types: [opened, reopened, synchronize, edited, ready_for_review, labeled, unlabeled]
  pull_request_review:
    types: [submitted, dismissed]
permissions:
  contents: read
  issues: read
  pull-requests: write
  statuses: write
jobs:
  risk-tier:
    uses: TreyThomasDotCodes/triphammer/.github/workflows/risk-tier.yml@<commit>
```

Replace `<commit>` with the full SHA of a commit on Triphammer's `main`. The workflow runs Triphammer's checks from
that commit, with the rules from your default branch, and nothing from the pull request. To pick up a change to the
checks, move the pin to a newer commit. If an organization owns the repository, set the variable `TRIPHAMMER_OWNER`
to your own login, on the repository or the organization.

A pull request you open yourself, such as a change under `.github/workflows/` that the App can't push, needs no
approval: `owner-approval` passes at any commit you pushed. If someone else pushes to its branch, it waits for you as
usual.

The Configuration section of [`bin/README.md`](bin/README.md#configuration) lists every field.

## Day to day

Write an issue. Triphammer takes any open issue that you or the App opened, once the issues it depends on are closed.
Say what an issue waits for on a line of its own:

```text
Depends on #12.
Slice 2 of #10.
```

A slice waits for the slice before it. The `next` label moves a ready issue to the front of the queue.

To stop work:

- Label an issue or pull request `hold` or `needs-owner`. A session already working on it stops as well.
- Open an issue labelled `stop-agents` to stop that project.
- Create a file named `stop` in `~/.local/state/triphammer/` as the `triphammer` user to stop every project on the
  machine.

A session that has been through three review rounds, each with a blocking problem, labels its issue `needs-owner` and
explains what it needs from you.

To see what it's doing:

```sh
triphammer plan     # what the next tick would do
triphammer doctor   # what's missing or wrong on the machine
```

With more than one project, name the one you mean, as in `triphammer plan <project>`.

The status page lists what's waiting on you, then the current run, log, recent runs and queue of each project. It
listens on `127.0.0.1:8787`. [`status/README.md`](status/README.md) explains how to reach it safely from another
machine.

## Optional modules

These are off unless a project's config lists them in `MODULES`, which `triphammer add --modules` sets:

- `demo` records a walkthrough of each web UI change and publishes it to a small gallery.
- `qwen-audit` repeats the weekly audit with a local model behind an Anthropic Messages API server, for a second
  opinion.
- `codex` adds Codex to the weekly audit, runs a monthly security audit, and posts an advisory security review on pull
  requests that touch Triphammer's own code.

## Use only the plugin

The skills, agents and guard hooks are a Claude Code plugin, and they work in an interactive session too:

```sh
claude plugin marketplace add TreyThomasDotCodes/triphammer
claude plugin install triphammer@triphammer --scope user
```

The guard hooks refuse commands that would install anything lasting on the machine. In sessions Triphammer starts,
they also allow writes only inside the session's worktree and the temporary directories.

## Development

```sh
npm run test:tooling
```

The tests use fakes for `gh`, `claude`, `docker`, `curl` and the package tools, so they need no network and no
credentials. [`AGENTS.md`](AGENTS.md) has the rules for changes, including the ones Triphammer makes to itself.

## License

MIT. `agent-guard.py` and `text-lint.py` include code used under the MIT License, credited in their headers.
