# Agent map

Triphammer runs Claude Code agents unattended against a repository's issues. This repository is Triphammer itself, and
Triphammer builds it like any other project. This file names the rules that matter everywhere and points to the documents
that hold the rest.

## Where things live

- `README.md`: what Triphammer does, what a project provides, what the machine configures, the optional
  modules.
- `plugins/triphammer/`: the Claude Code plugin, the workflow skills, agents and guard hooks (`triphammer:<name>`).
  `.claude-plugin/marketplace.json` lists it.
- `bin/`: the ticket runner, `merge-when-ready`, `land-pr`, `doctor`, `provision` and the optional modules' scripts,
  with their tests and fakes; its README covers configuration, the project file, install, provisioning and
  self-update.
- `systemd/`: the user units, linked from Triphammer's checkout.
- `status/`: the read-only status page.
- `scripts/`: the risk classifier (`risk-tier.mjs`, run as the base branch's copy by `risk-tier-base.sh`),
  `land-pr.sh`, the commit-msg hook and the copy test.
- `.github/`: the `risk-tier` workflow and the pull request contract check. The agents' App cannot change it.
- `.triphammer/`: this repository's own project data. Every change escalates to the owner.

## Rules that apply everywhere

- **No project in the core.** Nothing outside a project's `.triphammer/` and its config file names a project, a
  machine, a person or a model. Examples in docs and tests use placeholders.
- **Agents never install persistence on the machine** or change its brakes, units, config or state. The owner installs.
- **Never acquire, extract or disclose credentials** beyond the configured workflow. Config holds paths to secrets,
  never values.
- **Fail safe.** A tier that cannot be decided escalates. The guard hook fails open on its own errors, and its header
  says so and lists what it does not cover.
- **Docs describe now.** Issues, pull requests and Git hold history.

## Tests

Behavioral tests with the fakes in `bin/` (`fake-gh.mjs`, `fake-claude.mjs`, `fake-docker.mjs`, `fake-codex.mjs`).
Each new refusal in a hook has a test that fails on the hook in `main`.

```sh
npm run test:tooling
shellcheck -x <script>                      # each bash script under bin/ and scripts/
actionlint                                  # any change under .github/workflows/
```

## Workflow

Work comes from GitHub issues. Every pull request closes an issue (`Closes #N`; CI checks it). Issues say what they
wait for at the start of a line: `Depends on #N.` or `Slice k of #N.` See `plugins/triphammer/skills/ticket-run/`,
`review-loop/`, `review-checklist/`, `merge-policy/`, `plan-work/` and `upkeep/`.
