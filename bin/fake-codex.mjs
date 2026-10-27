// The `codex` the local-audit and security-review tests put first on PATH (fixture.mjs's fakeCodex):
// `node fake-codex.mjs <dir> <codex arguments>`. It appends each call's arguments to <dir>/codex-calls.
//
// `codex login status` prints an account line (which local-audit must not pass on) and exits with the number in
// <dir>/login-exit, for callers that clear the environment (provision-project's as_user), else with
// $FAKE_CODEX_LOGIN_EXIT (default 0). `codex --version` prints a version.
//
// `codex exec` writes <dir>/codex.json with its arguments, environment, working directory and standard input, and
// what git sees there: every commit reachable from any ref or reflog, the history, the remotes, and whether
// $FAKE_CODEX_LATER (a commit past the audited one) exists. It then acts out $FAKE_CODEX_MODE on standard output as
// `codex exec --json` events:
// - ok (the default): a command that succeeds, and $FAKE_CODEX_RESULT (default "no blocking findings") in the -o file;
// - empty: the same with an empty -o file;
// - sandbox: every command fails with a bwrap error, and the agent reports no findings in the -o file;
// - usage: the turn fails on the usage limit, exit 1;
// - fail: the stream disconnects, exit 1;
// - hang: sleeps a minute, for the timeout.
import {appendFileSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {gitSnapshot} from './fixture.mjs';

const [dir, ...args] = process.argv.slice(2);
appendFileSync(join(dir, 'codex-calls'), `${JSON.stringify(args)}\n`);

if (args[0] === 'login' && args[1] === 'status') {
  process.stdout.write('Logged in using ChatGPT as fake-account@example.invalid\n');
  const file = join(dir, 'login-exit');
  process.exit(Number(existsSync(file) ? readFileSync(file, 'utf8') : process.env.FAKE_CODEX_LOGIN_EXIT ?? 0));
}
if (args[0] === '--version') {
  process.stdout.write('codex-cli 0.1.0\n');
  process.exit(0);
}
if (args[0] !== 'exec') process.exit(2);

writeFileSync(join(dir, 'codex.json'), JSON.stringify({
  args,
  env: process.env,
  cwd: process.cwd(),
  stdin: readFileSync(0, 'utf8'),
  ...gitSnapshot(process.env.FAKE_CODEX_LATER),
}));

const resultFile = args[args.indexOf('-o') + 1];
const event = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const command = (exitCode, output) => event({
  type: 'item.completed',
  item: {id: 'item_1', type: 'command_execution', command: 'git log -1', aggregated_output: output, exit_code: exitCode, status: exitCode === 0 ? 'completed' : 'failed'},
});
const message = text => event({type: 'item.completed', item: {id: 'item_2', type: 'agent_message', text}});
event({type: 'thread.started', thread_id: 'thread-1'});
event({type: 'turn.started'});
process.stderr.write('sandbox: workspace-write [workdir, /tmp]\n');

const finish = (exitCode, output, text) => {
  command(exitCode, output);
  message(text);
  writeFileSync(resultFile, text);
  event({type: 'turn.completed', usage: {input_tokens: 10, output_tokens: 2}});
};
const fail = text => {
  event({type: 'error', message: text});
  event({type: 'turn.failed', error: {message: text}});
  process.exit(1);
};

switch (process.env.FAKE_CODEX_MODE ?? 'ok') {
  case 'ok':
    finish(0, 'commit abc\n', process.env.FAKE_CODEX_RESULT ?? 'no blocking findings');
    break;
  case 'empty':
    finish(0, 'commit abc\n', '');
    break;
  case 'sandbox':
    finish(1, 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n', 'No findings.');
    break;
  case 'usage':
    fail("You've hit your usage limit. Try again in 3 hours.");
  case 'fail':
    fail('stream disconnected before completion');
  case 'hang':
    await new Promise(resolve => setTimeout(resolve, 60_000));
    break;
}
