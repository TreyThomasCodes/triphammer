You are reviewing the security of this repository's agent workflow: the scripts, hooks, settings and units that
run unattended coding agents and merge their work. Review the area named at the end, at the commit named there.

The threat model:

- Unattended Claude Code agents run in auto mode, one session per issue.
- Issue, PR and review text and branch names reach those agents.
- A GitHub App merges according to `main`'s risk tier.
- The owner's brakes are labels, the stop file, closing issues and reviews.

The repository is private and has one collaborator, the owner. Judge each finding's severity for that setting: say
whether exploiting it needs write access to the repository or only the ability to open an issue or comment.

Read the area together with whatever it calls and whatever calls it. Your commands run in a read-only sandbox with no
network: you can read files and run git and other commands that write nothing.

Rules for the report:

- Report only findings you reproduced. For each, give the file and line, what goes wrong, the minimal reproduction you
  ran and its result, and whether it needs write access or only the ability to open an issue.
- Write no exploit payload beyond the minimal reproduction.
- Never read, print or search for credentials, tokens or keys, in the repository or outside it.
- When you have no reproduced finding, reply with exactly one line: `No findings.`
