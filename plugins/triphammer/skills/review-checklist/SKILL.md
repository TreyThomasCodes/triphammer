---
name: review-checklist
description: The defect classes independent reviews keep finding in this repository. Use at the start of every independent review (review-loop step 3) and when self-reviewing a diff, before reading for anything else.
---

# Review checklist

Each class below produced blocking findings in earlier work, usually one review round at a time. The classes that hold for any project are here; the project's own classes are in the checklist its contract names (`reviewChecklist` in `.triphammer/project.json`, `bin/README.md` "The project file"), and the two share one numbering, so a class keeps its number in either file. Check every class of both against the diff first, explicitly, then review as usual (with the contract's `reviewSkills`, each where its description says it applies). A finding still needs a reproduction: a failing test, a probe, or exact inputs traced through the code.

When a review finds a defect that fits none of these classes and could recur, add a class in the same pull request, with one line on where it was found: here when it can happen in any project, in the project checklist when it rests on the project's own types or stack, numbered after the last class of either file.

## 1. Overlapping or superseded async work

A late answer must never land on newer state. Check every request the change starts:

- Is an answer applied only if it still answers the latest action (a version, ticket or key check), not just the latest request of its own kind?
- Is a newer action built from state that an older, still-pending action is about to change (so the older change is lost)?
- Does a ref or `stateRef` read between `setState` and the next render see the old value?
- Does a check that cannot fail today (a counter, an abort) still cover the early-return path, removal of the thing it guards, and unmount?

Found in: #436 (session moves; 4 rounds), #440 (quantity checks answering out of order).

## 2. Half-committed state

A change that takes several reads must become visible all at once, or not at all.

- Can the UI show, or a rollback return to, a state that was never complete (a date with no expiration listing, a draft half applied)?
- Does a refused or cancelled action leave flags (busy, pending, loading) set?

Found in: #436 (a refused date rolled back to a half-landed selection).

## 7. Tests that cannot fail

- Would the new test fail on `main` without the fix? Check by reasoning through the old code, or run it there.
- Does a held or delayed answer in a test ever get released, and does its key actually match a request?
- Does a fake re-implement the server's rule differently from the server in a way the test relies on?
- Does a fake answer more cleanly than the server: its field keys, its exact messages (including any exception text the server leaks), its response shape and the order of its checks? Probe the real endpoint with the same input and compare; a spec that asserts exact text against a fake proves nothing about the server.

Found in: #436 (a stale-answer test only exercised the abort path), #441 (fakes had diverged from the server), #450 (the fake's clean errors and rejection text hid the server's `request` key and `(Parameter ...)` suffix through two rounds).

## 8. Production code only its tests reach

Production code that no production code reaches (no caller, registration, entry point or serialization) is dead, even when tests cover it. Delete it with those tests; keep or move any coverage of behavior that is still live. Find a symbol's callers, references and implementations with `LSP` where the project has a language server for its language, as `AGENTS.md` describes. The project checklist's class 8 says where production code and tests live, what reaches code in this project, and which check catches this mechanically.

- Does the change leave a type, member, overload or alias whose only references are in tests?
- Did removing a caller (a feature, a desktop view, an endpoint) orphan the code it called, and that code's own helpers in turn?

Found in: #507 (the desktop removal left a session loader, a comparison-export writer, a portable replay loader and other members only tests reached).

## 9. Shell checks that ignore quoting

A check that reads command text before tokenizing it (a line-based heredoc scan, a split on `;` or `|`) takes text inside a quoted value as shell syntax. The parse then fails, and a fallback that drops the command lets it through unchecked.

- For any hook or parser change, feed a quoted value that holds shell syntax (`-b '... <<EOF ...'`, `;`, `|`, `$(`, a quote left open across lines). Is the command still checked?
- Does a parse failure mean "allow" in a rule that refuses? It must refuse, or check the raw text instead.

Found in: a guard hook's heredoc scan, which read `<<EOF` inside a quoted pull request body as a heredoc and let the command past its rule.

## 10. Checks that look somewhere else

A health check, brake or gate vouches for code that runs later. It must read the same source, account, environment and spelling as that code does at run time. Otherwise it passes while the real run fails, or stops a run that was fine.

- Does a doctor or preflight run before the environment the real run sets up (its `PATH`, its credential helper, its variables), or with a token that cannot read what the run reads?
- Does the check ask about the account the code acts as, or about another one?
- Is a setting read from a different checkout or file than the one the service loads?
- Is a login, owner or `owner/repo` compared with `==`, `!=`, `[ "$a" = "$b" ]` or `grep -Fx`, when GitHub compares them in any case? `bin/identity-case.test.mjs` catches this half mechanically: compare with `ascii_downcase`, `.lower()` or `${x,,}`, or end the line with `# case-sensitive: <reason>`.

Reproduce by making the two sources differ: run the check without the run's environment, spell the login in another case, or change the file the service loads and not the one the check reads. If the check's answer does not change, it reads the wrong source.

Found in: tools found on the caller's PATH, a credential helper set up after the clone, a unit read from the project's checkout, a variable the App token cannot read, a login and a repository name compared case-sensitively, a doctor checking the App token for a different account than the runner uses.

## 11. Option tables that miss a value-taking option

A parser that skips a command's options before judging its operands needs the list of options that take a value. An option missing from that list makes the parser read its value as the first operand, so the real operand (a file the command writes, a program it runs) is never judged.

- For each table of value-taking options (short letters and long names), compare it with the installed tool's `--help` or man page. Is every option that takes a value there, in both spellings?
- Is there a test that puts a value-taking option before the operand, and does the command still get checked?

Found in: a guard hook's `script` entry, which lacked `-m` (`--logging-format`), so `script -q -m advanced -c true ~/.bashrc` read `advanced` as the file and let the write through.
