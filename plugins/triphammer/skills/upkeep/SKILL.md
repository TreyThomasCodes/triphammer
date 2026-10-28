---
name: upkeep
description: Use when the ticket runner starts you on an issue labelled `upkeep`; audits what merged since the last upkeep, measures how many defects escaped review, checks the agent setup and Triphammer's install, files what it finds, reports on the issue and closes it.
---

# Upkeep

Once a week the ticket runner opens an `Upkeep: week of <date>` issue labelled `upkeep` and starts you on it like any other ticket. You audit what merged, measure how well the pipeline caught defects, check that the agent setup and Triphammer's install still match `main`, and file what you find. You end by posting one report comment and closing the issue. Adapted from the `gardener` skill in https://github.com/rezk2ll/skills (MIT, `plugins/gardener`).

## What you never do

You never edit tracked files, open a pull request, merge anything, or label anything except the issues you file. You never touch `~/.local/bin`, systemd units or the main checkout; drift in its install goes to the owner as an issue. The agents you start are read-only.

The owner stops you the same way as any ticket: `hold` on the upkeep issue, closing it, or the brakes (the `stop` file in the project's `STATE_DIR`, the shared `stop` file `${XDG_STATE_HOME:-~/.local/state}/triphammer/stop`, or `$TRIPHAMMER_SHARED_DIR/stop` when that is set, and an open issue labelled `stop-agents`). Check the issue is still open and has no `hold` before you file anything, and again before you close it.

## 1. The window

The window runs from when the previous `upkeep` issue closed to now:

```sh
gh issue list --label upkeep --state closed --limit 1 --json number,closedAt
```

With no closed upkeep issue, the window is the last 7 days.

## 2. Gather the figures

`STATE_DIR` is the runner's state directory, the `STATE_DIR` line of the project's Triphammer config `${XDG_CONFIG_HOME:-~/.config}/triphammer/<name>.conf`, where `<name>` is the `name` in `.triphammer/project.json` (`bin/README.md`, Configuration). The merge queue's log is `${XDG_STATE_HOME:-~/.local/state}/merge-when-ready-<name>.log` under the `merge-when-ready@<name>` unit, and `merge-when-ready.log` in the same directory under the plain `merge-when-ready` unit.

- Ticket and repair runs: `$STATE_DIR/log` has one line per run start and finish (`ticket #N: run k of 3 starting; transcript <path>`, `repair #N (<reason>): run k of 3 starting`, `run k finished (exit c)`). The transcripts are `$STATE_DIR/runs/<UTC stamp>-ticket-N.jsonl` and `-repair-N.jsonl`, stream-JSON with one `"type":"result"` line at the end. Beside each is its record, the same name ending `.json`: the builder model, the exit status, whether a pull request was opened, the review rounds and whether it handed over (`bin/README.md`, Run records).
- Repair runs that changed nothing: the pull request has no commit between the run's start and finish (`gh pr view <n> --json commits`).
- Merges: the merge queue's log (`<repo>#N: merged by merge-when-ready`) and `gh pr list --state merged --search "merged:>=<window start>"`.
- Reviewer blocking findings: each merged pull request's comment lists its review rounds (`gh pr view <n> --comments`); the `triphammer:reviewer` reports are also in the run transcripts. Count them by `triphammer:review-checklist` class, and put findings that fit no class under "unclassified".
- Auto-mode classifier denials: the `permission_denials` array in each transcript's `result` line, with the tool and command.
- Tool use: per run, the `LSP` calls and the Bash calls whose command runs `grep`, counted from the `tool_use` blocks of each transcript, subagents included (their assistant message lines carry a top-level `parent_tool_use_id`).
- Approvals that stopped counting: a pull request whose `owner-approval` status was `success` on one head and, on a later head, `pending` with a description that starts `Escalate: waiting for`. List its heads with `gh pr view <n> --json commits,files`, and read each head's latest status with `gh api repos/{owner}/{repo}/commits/<sha>/statuses --jq '[.[] | select(.context == "owner-approval")][0] | .state + " " + .description'` (newest first). Note which of its `files` differ between the approved head and the later one (`git diff --name-only <approved> <later>`).
- Conflict repairs: the `repair #N (conflicts): run k of 3 starting` lines in `$STATE_DIR/log`, with the files the pull request changes.
- Branch updates per merge: the `<repo>#N: armed but behind its base at <sha>; updating the branch` lines in the merge queue's log, divided by its `merged by merge-when-ready` lines.
- Hook overrides: search the transcripts in the window for `guard-override` and `text-lint-override`, and read the lines of `guard-overrides.log` in the shared directory (`${TRIPHAMMER_SHARED_DIR:-${XDG_STATE_HOME:-~/.local/state}/triphammer}`) whose `time` falls in the window; quote the reason given with each. The log holds only the overrides the hook honored, which lift the shell-edit rule alone.

Read these with `grep`, `jq` or short scripts. Keep counts and short excerpts in your context, never whole transcripts.

## 3. Audit what merged

Audit the code merged in the window together with whatever it calls and whatever calls it. A merged change is often correct on its own and wrong against an existing caller. Use read-only agents (`triphammer:reviewer`, `triphammer:searcher` or `Explore`), at most five, each with its own share of the merged pull requests. Each reads first for the classes of `triphammer:review-checklist` and of the project checklist the contract names (`reviewChecklist` in `.triphammer/project.json`), then as each of the contract's `reviewSkills` does, and reports only defects with a reproduction: exact inputs and the wrong result, or a test that would fail.

Audit each of those areas again with two more model families, Qwen on the machine and Codex, each only when the runner's prompt names its module as on (`qwen-audit`, `codex`; `bin/README.md`, Modules). A model whose module is off is skipped for every area without a call. Run the audits with `bin/local-audit --commit <main's head> --area "<the area and its pull requests>" --output <file under /tmp> --model qwen` and then `--model codex` (`bin/README.md`). Run one call at a time, never in parallel: the GPUs fit one Qwen request, and Codex runs count against the owner's plan. An area can take about 15 minutes, so give each call a timeout of an hour. Both sessions are read-only toward GitHub: they never edit, label or merge anything. Take the time per area for each model from the `elapsed` line of its output file, and Opus's from its agents' run times. Verify every Qwen and Codex finding with a reproduction, as you verify any other finding, before it counts or is filed. A call that audits nothing is never a failure of upkeep: note the area as not audited by that model, with the reason the script printed, and carry on. That is exit 3 (`local model unavailable`, `Codex unavailable: <reason>`), exit 4 (`Codex: weekly cap reached`, `Codex: 5-hour floor reached`, `Codex: usage limit`), exit 1 (the session failed), or exit 2 (the Triphammer config lacks a setting the module needs; the message names it). After a Codex exit 4, skip Codex for the remaining areas.

Once a month, in the first upkeep of the calendar month (no other `upkeep` issue was created earlier in the same month), and only when the `codex` module is on, also run the security audit of Triphammer's safety machinery: `bin/security-review --full-area --commit <main's head> --output <file under /tmp>`, with an hour's timeout, after the Codex area audits. It counts as 4 Codex runs. Exit 3 or 4 means it was skipped: put the reason in the report and carry on. Verify each finding with a reproduction before filing it, and file each one labelled `needs-owner`.

Then check the agent setup and Triphammer's install against `main`:

- Every hook command, skill, agent and path that `AGENTS.md`, the skills, the agents and the plugin's and the repository's hook settings (`hooks/hooks.json` in this plugin, `.claude/settings.json`) name exists. Hook scripts pass `bash -n` or `python3 -m py_compile`. Every skill and agent has `name` and `description` in its frontmatter.
- The project contract (`.triphammer/project.json`, `bin/README.md` "The project file") names nothing that is missing: every skill and path it names exists, and the first word of every `checks` command is a command on `PATH` or a file in the repository, and each later word that looks like a path (a `/` or a `.` in it) matches at least one path once its `<placeholders>` stand for any name. From the repository root, this prints one line per broken reference and nothing when there is none:

  ```sh
  p=.triphammer/project.json
  jq -r '(.reviewSkills // [])[], (.shellEditRoots // [])[], .reviewChecklist // empty, .uiVerificationSkill // empty, (.worktreeTeardown // [])[0] // empty' "$p" |
    while IFS= read -r path; do [ -e "$path" ] || echo "missing path: $path"; done
  jq -r '(.checks // {}) | to_entries[] | "\(.key)\t\(.value)"' "$p" |
    while IFS=$'\t' read -r name line; do
      read -ra words <<< "$line"
      command -v "${words[0]}" > /dev/null || [ -x "${words[0]}" ] || echo "checks.$name: ${words[0]} is not a command"
      for word in "${words[@]:1}"; do
        case "$word" in
          */*|*.*) compgen -G "$(sed 's/<[^>]*>/*/g' <<< "$word")" > /dev/null || echo "checks.$name: no path matches $word" ;;
        esac
      done
    done
  ```
- Every systemd unit and `~/.local/bin` script of Triphammer is a link into `bin/` in the main checkout, and the main checkout is on `origin/main`. Each project configured on the machine (a `<name>.conf` under `~/.config/triphammer/`) has its template unit timers `ticket-runner@<name>.timer` and `merge-when-ready@<name>.timer` active (`systemctl --user list-timers 'ticket-runner@*' 'merge-when-ready@*'`), and the non-template `ticket-runner.timer` and `merge-when-ready.timer` are not also active for the same project; a machine not yet cut over has those two active instead (`bin/README.md`, Install).

An escaped defect is a bug the audit found in code merged in the window that passed review. The escape rate is escaped defects divided by escaped defects plus the reviewer blocking findings in the same window.

## 4. File what you found

Before filing, search open issues for the same defect or proposal (`gh issue list --state open --search "<key words>"`). When one matches, comment your new evidence on it instead of filing a duplicate. Every filing uses the issue form in `triphammer:plan-work` §3.

- A bug in shipped code with a concrete reproduction becomes an ordinary issue the runner builds, with the reproduction and acceptance. A suspicion you cannot reproduce goes only in the report.
- A proposed new check or rule change becomes an issue labelled `needs-owner`, with one decision for the owner and a draft of the check: a checklist class, or an entry in one of the mechanical checks `AGENTS.md` lists (banned symbols, an architecture test, a hook rule). File one for a finding class seen two or more times that no mechanical check covers yet, and for an enforced check that let its class through again, saying why it missed.
- Drift in Triphammer's install that the owner must fix becomes an issue labelled `needs-owner` with the exact commands that fix it.
- A broken reference in the repository becomes an ordinary issue: a hook command, skill, agent or `AGENTS.md` path that doesn't exist, a command, skill or path the project contract names that doesn't exist, a hook script that fails `bash -n` or `py_compile`, or skill or agent frontmatter without `name` or `description`.

## 5. Report and close

Post one comment on the upkeep issue covering the window, with its start and end:

- ticket runs, repair runs, and repair runs that changed nothing;
- reviewer blocking findings by checklist class;
- escaped defects, each with its pull request and filed issue, and the escape rate;
- for each verified defect, which models found it (Opus, Qwen, Codex);
- for each area, which models ran and how long each took, and for each model that did not audit it, the reason;
- which modules were off, and so which audits did not run (the Qwen audit, the Codex audit, the monthly security audit);
- in the first upkeep of a month, the security audit's findings and filed issues, or why it was skipped (its module was off, or the exit 3 or 4 reason);
- `LSP` calls and Bash `grep` calls, in total and per run;
- approvals that stopped counting, conflict repairs, and branch updates per merge; when either of the first two comes to more than 3 a week, name the files involved;
- auto-mode classifier denials, and hook overrides (`guard-override`, `text-lint-override`) with their reasons, from the transcripts and `guard-overrides.log`;
- links to every issue you filed or commented on, and the suspicions you could not reproduce.

Then close the issue (`gh issue close <n>`). End with one line saying how many issues you filed and that the upkeep issue is closed, followed by the run record line of `triphammer:ticket-run` (Run record).
