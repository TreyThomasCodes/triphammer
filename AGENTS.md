# Agent map

Triphammer runs Claude Code agents unattended against a repository's issues. This repository is Triphammer itself, and
Triphammer builds it like any other project. This file names the rules that matter everywhere and points to the documents
that hold the rest.

## Where things live

- `README.md`: what Triphammer does, what a project provides, what the machine configures, the optional
  modules.
- `CREDITS.md`: what Triphammer adapts from other projects, with their licenses. A skill or agent credits its sources
  there, never in its own text.
- `plugins/triphammer/`: the Claude Code plugin, the workflow skills, agents and guard hooks (`triphammer:<name>`).
  `.claude-plugin/marketplace.json` lists it.
- `install.sh`: sets a machine up without a clone, through `bin/provision`.
- `bin/`: the `triphammer` command, the ticket runner, `merge-when-ready`, `land-pr`, `doctor`, `provision`,
  `provision-project` and the optional modules' scripts,
  with their tests and fakes; its README covers configuration, the project file, install, provisioning and
  self-update.
- `systemd/`: the user units, linked from Triphammer's checkout.
- `status/`: the read-only status page.
- `scripts/`: the risk classifier (`risk-tier.mjs`, run as the base branch's copy by `risk-tier-base.sh`),
  `land-pr.sh` and the commit-msg hook.
- `.github/`: the `risk-tier` workflow and the pull request contract check. The agents' App cannot change it.
- `.triphammer/`: this repository's own project data. Every change escalates to the owner.

## Rules that apply everywhere

- **No project in the core.** Nothing outside a project's `.triphammer/` and its config file names a project, a
  machine or a person. Examples in docs and tests use placeholders.
- **Agents never install persistence on the machine** or change its brakes, units, config or state. The owner installs.
- **Never acquire, extract or disclose credentials** beyond the configured workflow. Config holds paths to secrets,
  never values.
- **Fail safe.** A tier that cannot be decided escalates. The guard hook fails open on its own errors, and its header
  says so and lists what it does not cover.
- **Docs describe now.** Issues, pull requests and Git hold history.

## How a run flows

Each step points to its section of `bin/README.md`, which holds the details.

1. `systemd/ticket-runner@.timer` starts `bin/ticket-runner` every ten minutes, which first updates Triphammer's
   checkout (What each piece does, Self-update).
2. `bin/ticket-decide.py` picks the work: close a parent, repair a pull request, a ticket or upkeep (What a tick
   decides).
3. A Claude Code session works in a clone of the project's checkout as `triphammer:orchestrator`, following
   `triphammer:ticket-run` and, before its pull request, `triphammer:review-loop` (Sessions).
4. The pull request's checks run the `risk-tier` workflow (`.github/workflows/risk-tier.yml`), which classifies the
   change with `scripts/risk-tier-base.sh` (Which checkout each file comes from).
5. `bin/land-pr` carries out the classifier's tier, arming auto-merge unless it is blocked, and
   `bin/merge-when-ready`, started by `systemd/merge-when-ready@.timer`, merges it (What each piece does).

A branch's changes to `bin/` take effect only once they merge: `land-pr` runs `main`'s copy and the units run
Triphammer's checkout, which tracks `origin/main` (Self-update).

## Guard hooks

The plugin's `agent-guard.py` and `text-lint.py` (`plugins/triphammer/hooks/`) run in every session and its
subagents: the runner loads the plugin from Triphammer's checkout, and `provision` installs it for the user. Their
headers hold the rules and what each does not cover. The ones a session meets first:

- A git-tracked file under a `shellEditRoots` path of `.triphammer/project.json` changes through Edit or Write, not
  `sed -i`, a redirect or another shell write.
- A `--body-file` must exist before the command that uses it, so write it in an earlier step.
- A pull request body puts each paragraph on one line, and its last non-empty line is `Closes #N`.
- The `humanizer:humanizer` skill runs in the session before `gh pr create`.

## Tests

Behavioral tests with fakes that stand in for the real commands, put first on `PATH`. Each new refusal in a hook has
a test that fails on the hook in `main`.

- `bin/fixture.mjs`: throwaway origin and checkout rigs (`checkoutSetup`, `runnerSetup`), and `fakeCommand`,
  `fakeGh`, `fakeDocker`, `fakeCodex` and `fakeSudo`, which put the fakes on `PATH`.
- `bin/fake-gh.mjs`, `fake-curl.mjs`, `fake-answers.mjs`: canned answers keyed by argument prefix for `gh`, for
  `curl` in the `github-app-token` tests, and for any other command that only needs answers.
- `bin/fake-claude.mjs`, `fake-codex.mjs`: `claude` (a run, `auth status`, plugin installs) and `codex`, recording
  what each was given.
- `bin/fake-docker.mjs`: `docker` and Compose, so a runner test never reaches the real Docker.
- `bin/fake-machine.mjs` and `bin/provision-fixture.mjs`: one fake machine (packages, users, units) for the
  `provision` and `provision-project` tests.
- `bin/test-fixtures/example-project/`: the project file, risk rules and teardown script of a placeholder project.
- `plugins/triphammer/hooks/agent-guard-fixture.mjs`: feeds `agent-guard.py` a tool call and returns its decision,
  for the `agent-guard-*.test.mjs` files.
- `scripts/test-git-repo.mjs`: a throwaway git repository and an environment without a session's variables.

```sh
npm run test:tooling                        # the whole suite
node --test bin/land-pr.test.mjs            # one test file
shellcheck -x <script>                      # each bash script under bin/ and scripts/
actionlint                                  # any change under .github/workflows/
```

The slowest files, slowest first: `bin/provision-project.test.mjs`, `bin/ticket-runner.test.mjs`,
`plugins/triphammer/hooks/agent-guard-session-git.test.mjs` and `bin/doctor.test.mjs`.

## Workflow

Work comes from GitHub issues. Every pull request closes an issue (`Closes #N`; CI checks it). Issues say what they
wait for at the start of a line: `Depends on #N.` or `Slice k of #N.` See `plugins/triphammer/skills/ticket-run/`,
`review-loop/`, `review-checklist/`, `merge-policy/`, `plan-work/` and `upkeep/`.
