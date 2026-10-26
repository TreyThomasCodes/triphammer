// The `claude` the local-audit tests put first on PATH: `node fake-claude.mjs <dir> <claude arguments>`. It writes
// <dir>/claude.json with its arguments, environment and working directory, and what git sees there: every commit
// reachable from any ref or reflog, the remotes, and whether $FAKE_CLAUDE_LATER (a commit past the audited one) exists.
// It then prints $FAKE_CLAUDE_STDOUT (default "no blocking findings"), followed by its ANTHROPIC_AUTH_TOKEN when
// $FAKE_CLAUDE_LEAK is set, and exits with $FAKE_CLAUDE_EXIT (default 0).
// `claude --version` prints a version and `claude auth status` the login state, an account included, logged in unless
// $FAKE_CLAUDE_LOGGED_OUT is set or the file <dir>/logged-out exists (then it exits 1); neither writes claude.json.
// `claude auth status` appends to <dir>/auth-calls whether it leads a session of its own and what its stdin is.
// `claude plugin marketplace add <checkout>` (the marketplace named in its .claude-plugin/marketplace.json, or, for a
// GitHub <owner>/<repo>, the one named <repo>),
// `claude plugin install <id> --scope <scope>` and their `list --json` keep their state in <dir>/plugins.json and
// append each call to <dir>/plugin-calls, with whether it leads a session of its own and what its stdin is; they
// write no claude.json either.
import {appendFileSync, existsSync, readFileSync, readlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {gitSnapshot} from './fixture.mjs';

const [dir, ...args] = process.argv.slice(2);
// The session id is the sixth field of /proc/self/stat, after the command name in parentheses.
const sessionLeader = () => Number(readFileSync('/proc/self/stat', 'utf8').split(') ')[1].split(' ')[3]) === process.pid;
if (args[0] === '--version') {
  process.stdout.write('2.1.0 (Claude Code)\n');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  appendFileSync(join(dir, 'auth-calls'), `${JSON.stringify({sessionLeader: sessionLeader(), stdin: readlinkSync('/proc/self/fd/0')})}\n`);
  const loggedIn = !process.env.FAKE_CLAUDE_LOGGED_OUT && !existsSync(join(dir, 'logged-out'));
  process.stdout.write(`${JSON.stringify({loggedIn, email: 'fake-account@example.invalid'})}\n`);
  process.exit(loggedIn ? 0 : 1);
}
if (args[0] === 'plugin') {
  appendFileSync(join(dir, 'plugin-calls'), `${JSON.stringify({args: args.slice(1), sessionLeader: sessionLeader(),
    stdin: readlinkSync('/proc/self/fd/0')})}\n`);
  const file = join(dir, 'plugins.json');
  const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {marketplaces: [], plugins: []};
  const [what, action, value] = args[1] === 'marketplace' ? args.slice(1) : [null, ...args.slice(1)];
  if (action === 'list') {
    process.stdout.write(JSON.stringify(what ? state.marketplaces : state.plugins));
  } else if (what) {
    state.marketplaces.push({name: /^[\w.-]+\/[\w.-]+$/.test(value) ? value.split('/')[1]
      : JSON.parse(readFileSync(join(value, '.claude-plugin/marketplace.json'), 'utf8')).name});
  } else {
    state.plugins.push({id: value, scope: args[args.indexOf('--scope') + 1]});
  }
  writeFileSync(file, JSON.stringify(state));
  process.exit(0);
}
writeFileSync(join(dir, 'claude.json'), JSON.stringify({
  args,
  env: process.env,
  cwd: process.cwd(),
  ...gitSnapshot(process.env.FAKE_CLAUDE_LATER),
}));
process.stdout.write(`${process.env.FAKE_CLAUDE_STDOUT ?? 'no blocking findings'}\n`);
if (process.env.FAKE_CLAUDE_LEAK) process.stdout.write(`token: ${process.env.ANTHROPIC_AUTH_TOKEN}\n`);
process.exit(Number(process.env.FAKE_CLAUDE_EXIT ?? 0));
