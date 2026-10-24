---
name: plan-work
description: Use after a discussion with the owner about new work, to turn it into sliced GitHub issues that the ticket runner can build without asking anyone.
---

# Plan work

New work starts with a discussion with the owner. Afterwards an agent writes the issues, and the ticket runner starts building them on its next tick, without asking. Each issue is the whole brief for an agent that wasn't in the discussion, and the reviewer checks the change against that issue. A vague issue gets built confidently and reviewed against its own vagueness, so get the issue right.

## 1. Learn what exists

Before writing anything, have a `triphammer:searcher` (or an Explore pass) sweep the code the discussion touches:
- what already exists and can be reused, with its tests;
- which `AGENTS.md` rules, and rules in the documents it points to, apply.

Keep paths and short excerpts, not whole files.

## 2. Slice it

Each issue is one pull request, and each slice is one user-visible behavior. It runs end to end through every layer it needs (the layers `AGENTS.md` describes, through to what the user sees, with tests) and can be demoed on its own. Crossing layers is never a reason to split. Split only when one behavior is still too big to build and review in one pass. Then cut by behavior: a narrower case first, such as one leg type, read before write, or the happy path before the refusal paths, and each slice still runs end to end. The one exception is a layer-only slice (rules or an API with no caller yet), and only when the issue says why, such as shared rules that several later behaviors need. Put shared mechanics in the earliest slice that needs them. Don't make a slice that only sets up a later one. Every slice leaves `main` working and tested.

Work too big for one pass gets a parent issue that states the goal. Each slice is then its own issue whose body starts `Slice k of #N.` The runner builds the slices in order and closes the parent when the last one closes. Other ordering goes in the body as `Depends on #N.`, one line per dependency. The runner reads only these two forms. Each declaration goes at the start of a line, and quoting the syntax anywhere else (in prose, quotation marks, code or a blockquote) is safe, because the runner ignores it there. When two issues will change the same file, give the later one a depends line on the earlier so they're built in order, unless one is a small, separate edit. The same goes for follow-up issues agents file themselves.

## 3. Write each issue

The title says what it delivers, for example "Campaign: open, stage, compare and reset". The body has, in plain short paragraphs:

- **What changes:** the behavior a user or caller sees, in domain words.
- **Builds on:** the existing types, endpoints, web views and test classes to reuse or extend, by path.
- **Acceptance:** the checks a reviewer can confirm against the diff. Each one is an observable behavior or a test that must exist, never "works well". Include the edge cases the discussion settled, such as refusals, stale or superseded answers, and exact-time rules.
- **Rules that apply:** the `AGENTS.md` rules, or rules in the documents it points to, this work must respect, and any `triphammer:review-checklist` class it is prone to.
- **Out of scope:** what the slice must not touch, when that isn't obvious.
- **Dependencies:** the `Slice k of #N.` / `Depends on #N.` lines.

Leave out how to implement it unless the discussion decided that. The builder and reviewer work from the code.

## 4. Report back

Create the issues with `gh issue create`, parent first, so the slices can name it. Then give the owner one short message:
- the issues in build order, with numbers and one line each;
- anything you decided that the discussion did not settle, each with the choice you made;
- the first issue the runner will take (`ticket-runner --plan`).

The runner starts on them within ten minutes. The owner corrects an issue by editing it, or brakes with `hold`. Don't wait for an answer.
