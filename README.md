# Triphammer

Triphammer runs Claude Code agents unattended against a GitHub repository's issues. A timer takes the next ready
issue, starts a fresh headless session in a worktree of its own, and the session builds the change, reviews it with
independent agents, opens a pull request and lands it by the project's rules. Changes the rules allow merge when the
checks pass. The rest wait for the owner's approval. The owner steers with issues and labels and stops it with
brakes.

It is a Claude Code plugin (the skills, agents and guard hooks), a set of bash scripts and systemd user units, and a
small read-only status page.

## How it works

- **Work comes from issues.** The runner takes every open issue opened by the owner or the agents' GitHub App whose
  dependencies are closed. An issue says what it waits for at the start of a line: `Depends on #N.` or
  `Slice k of #N.` (slice k waits for slice k-1). The `next` label puts a ready issue first.
- **One session per tick.** Every ten minutes `ticket-runner` updates its own checkout, then does one thing: close a
  finished parent issue, repair an agent pull request the owner asked changes on, start a session on the next ready
  issue, or run the weekly upkeep issue. `ticket-runner --plan` prints what the next tick would do.
- **Review before a pull request.** The session runs the project's checks, has independent reviewer agents check the
  diff against the issue and a checklist of defect classes, and iterates. After three rounds that each find a blocking
  problem, it stops and labels the issue `needs-owner`.
- **Merging is data.** `.triphammer/risk-tier.json` in the project decides, by the paths a change touches, whether it
  merges automatically, escalates to the owner or is blocked. CI runs the base branch's classifier with the base
  branch's rules, so a pull request cannot loosen its own tier. `merge-when-ready` is a serial merge queue that brings
  armed pull requests up to date and merges them one at a time.
- **Brakes, not go.** The pipeline runs by default. The owner stops it with `hold` or `needs-owner` on an issue or
  pull request, a `stop-agents` issue, or a stop file on the machine, and the brakes also stop a session that is already
  running.
- **Guard hooks.** `agent-guard.py` refuses shell commands and file writes that could escape a run or install
  persistence on the machine. In the sessions Triphammer starts, writes are allowed only inside the run's worktree and the
  temporary directories. `text-lint.py` checks pull request, issue and commit text. Each hook's header lists its rules
  and what it does not cover.

## What a project provides

A project that Triphammer serves keeps its own data in `.triphammer/`:

- `project.json`: its name, its check commands (`build`, `focused`, `suite`, `gate`), its own review checklist and
  review skills, the skill that verifies UI changes, the command that tears down a worktree's resources, and the paths
  that get a security review. See `bin/README.md`, The project file.
- `risk-tier.json`: the ordered rules that decide each path's tier. See `plugins/triphammer/skills/merge-policy/`.

Its `AGENTS.md` names the project's own rules. The generic skills read the project's data, so nothing in Triphammer
names a project.

## What the machine configures

Run Triphammer on a machine of its own, such as a VM that holds only Triphammer's credentials: the agents can then
reach nothing of yours. `bin/provision` sets one up from a fresh Ubuntu server. Each project gets a config file,
`~/.config/triphammer/<project>.conf`, with `REPO`, `CHECKOUT`, `APP_AUTHOR` and `STATE_DIR`, and its own pair of
template timers, `ticket-runner@<project>.timer` and `merge-when-ready@<project>.timer`. Several projects on one
machine take turns. Credentials stay in files the config names, never in the config. `bin/README.md` covers
configuration, install, provisioning and self-update.

The agents reach GitHub as a GitHub App with contents, pull requests and issues write and no workflows or
administration permission, so they cannot change CI or the repository's rules. The required checks (`closing-issue`,
`owner-approval` and the project's tests) come from workflows only the owner changes.

## Optional modules

Off unless a project's config names them in `MODULES`:

- `demo`: sessions that change a web UI record a paced walkthrough, which the runner publishes to a static gallery.
- `qwen-audit`: the weekly upkeep audit also runs with a local model behind an Anthropic Messages API server, as a
  second model family.
- `codex`: upkeep's Codex audit, a monthly security audit, and an advisory security review of each pull request that
  touches Triphammer's own machinery, with a weekly cap.

## Install the plugin

```sh
claude plugin marketplace add <owner>/triphammer
claude plugin install triphammer@triphammer --scope user
```

## Tests

```sh
npm run test:tooling
```

## License

MIT. `agent-guard.py` and `text-lint.py` include code used under the MIT License, credited in their headers.
