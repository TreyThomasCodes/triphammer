// A throwaway git repository for the tooling tests (not itself a test: `node --test scripts/*.test.mjs` skips it).
import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';

// The test process's environment without the variables a ticket-runner session exports for itself (the project it
// runs, the Triphammer config, the shared directory, the account whose App installation its tokens come from, the runner's own
// update mark and its brake check timings), so a script under test reads only what its test sets and gives the same
// result in any shell. Tests that need one of them set it explicitly.
const {TRIPHAMMER_PROJECT, TRIPHAMMER_CONFIG, TRIPHAMMER_SHARED_DIR, GITHUB_APP_OWNER, TICKET_RUNNER_UPDATED,
  TICKET_RUNNER_BRAKE_SECONDS, TICKET_RUNNER_BRAKE_GRACE_SECONDS, ...toolingEnv} = process.env;
export {toolingEnv};

// Git with a fixed author and no global or system config, so the tests see neither the user's settings nor their
// identity. Tests that spawn a script which runs git hand it this environment too.
export const gitEnv = {
  ...toolingEnv,
  GIT_AUTHOR_NAME: 'tooling test', GIT_AUTHOR_EMAIL: 'tooling@example.invalid',
  GIT_COMMITTER_NAME: 'tooling test', GIT_COMMITTER_EMAIL: 'tooling@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};

// A temporary directory `root`, removed after test `t`, holding a repository `dir` (root/repo) on an unborn main, so a
// test can put other files beside it. `git` runs git in `dir` with gitEnv plus `env` and returns its trimmed output;
// `commit` writes `files` (path under `dir` -> content; null deletes), stages everything, commits with `args` and
// returns the new HEAD.
export function gitRepo(t, prefix, env = {}) {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const dir = join(root, 'repo');
  mkdirSync(dir);
  const git = (...args) => execFileSync('git', args,
    {cwd: dir, env: {...gitEnv, ...env}, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  git('init', '-q', '-b', 'main');
  const commit = (files, ...args) => {
    for (const [path, content] of Object.entries(files)) {
      if (content === null) {
        rmSync(join(dir, path));
      } else {
        mkdirSync(dirname(join(dir, path)), {recursive: true});
        writeFileSync(join(dir, path), content);
      }
    }
    git('add', '-A');
    git('commit', '-q', ...args);
    return git('rev-parse', 'HEAD');
  };
  return {root, dir, git, commit};
}
