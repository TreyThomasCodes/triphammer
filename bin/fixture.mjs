// Throwaway rigs for the bin tests: a bare origin, a publisher clone that pushes to it, and the checkout under
// test, all in a temporary directory, so the real main checkout is never touched.
import {execFileSync, spawnSync} from 'node:child_process';
import {chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import net from 'node:net';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {gitEnv, toolingEnv} from '../scripts/test-git-repo.mjs';

export const here = import.meta.dirname;
export {gitEnv, toolingEnv};
export const run = (file, args, options) => execFileSync(file, args, {stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...options});
export const git = (cwd, ...args) => run('git', args, {cwd, env: gitEnv}).trim();
// A run's clone of `origin` in `dir`, as ticket-runner's add_clone makes it: a repository of its own reading
// `checkout`'s objects through an alternate.
export const runClone = (checkout, origin, dir) => git(checkout, 'clone', '-q', '--no-local', '--reference', checkout, origin, dir);
// `env` without the variables, besides HOME, TMPDIR and XDG_STATE_HOME, that name what session-sandbox makes writable,
// hides or reads, or that it points at the caches inside, so the sandbox derives each from HOME and a test never
// writes the machine's own ~/.codex or ~/.claude.
export const withoutSandboxPaths = ({XDG_DATA_HOME, CLAUDE_CONFIG_DIR, CODEX_HOME, TRIPHAMMER_HUMANIZER_STATE,
  NUGET_PACKAGES, NUGET_HTTP_CACHE_PATH, NUGET_PLUGINS_CACHE_PATH, DOCKER_CONFIG, DOTNET_CLI_HOME, XDG_CACHE_HOME,
  GITHUB_APP_CONFIG_DIR, npm_config_cache, NPM_CONFIG_CACHE, BUILDX_CONFIG, PLAYWRIGHT_BROWSERS_PATH, ...env}) => env;
// The non-empty lines of a file a fake appends to, or none when it never ran.
export const lines = path => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : [];
// `count` placeholder label names, for the tests of the labels past the first 100, which gh does not read.
export const manyLabels = count => Array.from({length: count}, (_, i) => `label-${i}`);
// Sends `signal` to a spawned script once its slow fake step has recorded `started` in `slowLog` (with `group`, to the
// whole process group the script leads, as a terminal's Ctrl-C does), and returns how the script exited, how many
// milliseconds after the signal, and what the step recorded by the time its child would have recorded `finished`.
// Each wait is bounded by `limit` milliseconds: when the step has not started by then (or the script has ended first),
// or the script has not ended that long after the signal, it records the process tree under the script, kills that
// tree, and throws with the tree in the message. Without the step started, it sends no signal but the SIGKILL.
export async function interrupt(child, signal, group, slowLog, limit = 10000) {
  const exited = new Promise(done => {
    if (child.exitCode !== null || child.signalCode !== null) done({status: child.exitCode, by: child.signalCode, at: Date.now()});
    else child.on('exit', (status, by) => done({status, by, at: Date.now()}));
  });
  const script = child.spawnargs.join(' ');
  let ended;
  exited.then(result => { ended = result; });
  for (const until = Date.now() + limit; !lines(slowLog).includes('started');) {
    if (ended) throw new Error(`${script} ended (${ended.by ?? `exit ${ended.status}`}) before its slow step recorded started in ${slowLog}; no signal sent`);
    if (Date.now() >= until) {
      throw new Error(`the slow step of ${script} did not record started in ${slowLog} within ${limit} ms; no signal sent\n${await killTree(child, exited)}`);
    }
    await sleep(20);
  }
  const sent = Date.now();
  if (group) process.kill(-child.pid, signal);
  else child.kill(signal);
  const result = await within(exited, limit);
  if (!result) throw new Error(`${signal} did not end ${script} within ${limit} ms; what ran under it:\n${await killTree(child, exited)}`);
  await sleep(2500);
  return {status: result.status, signal: result.by, after: result.at - sent, steps: lines(slowLog)};
}
// What `promise` resolves to, or undefined once `ms` milliseconds pass first (on a timer that keeps no process alive).
const within = (promise, ms) => Promise.race([promise, sleep(ms, undefined, {ref: false})]);
// The processes under a spawned script: its descendants, and every process in a group or session one of them leads,
// from `ps` (pid, ppid, pgid, sid, state, command). Returns them as a table header first.
function processTree(pid) {
  const rows = execFileSync('ps', ['-ww', '-eo', 'pid=,ppid=,pgid=,sid=,stat=,args='], {encoding: 'utf8'}).split('\n')
    .map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/)).filter(Boolean)
    .map(([, pid, ppid, pgid, sid, state, command]) => ({pid: +pid, ppid: +ppid, pgid: +pgid, sid: +sid, state, command}));
  const under = new Set([pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) {
      if (!under.has(row.pid) && row.pid !== process.pid && [row.ppid, row.pgid, row.sid].some(id => under.has(id))) {
        under.add(row.pid);
        grew = true;
      }
    }
  }
  return rows.filter(row => under.has(row.pid));
}
// Records the process tree under a spawned script, sends SIGKILL to the group it leads (if it leads one) and to each
// process recorded, waits up to two seconds for the script's exit, and returns the tree as text.
async function killTree(child, exited) {
  const tree = processTree(child.pid);
  for (const target of [-child.pid, ...tree.map(row => row.pid)]) {
    try {
      process.kill(target, 'SIGKILL');
    } catch {
      // gone already, or not a group
    }
  }
  await within(exited, 2000);
  return ['PID PPID PGID SID STAT COMMAND', ...tree.map(row => `${row.pid} ${row.ppid} ${row.pgid} ${row.sid} ${row.state} ${row.command}`)]
    .join('\n');
}
// A free port on 127.0.0.1, as the kernel hands one out: bound once, then released.
export function freePort() {
  return new Promise((done, fail) => {
    const probe = net.createServer().on('error', fail).listen(0, '127.0.0.1', () => {
      const {port} = /** @type {net.AddressInfo} */ (probe.address());
      probe.close(() => done(port));
    });
  });
}
// Sets the test process's umask, which the scripts inherit, for one test.
export function withUmask(t, mask) {
  const before = process.umask(mask);
  t.after(() => process.umask(before));
}

// What git sees in the current directory, for the fake sessions (fake-claude.mjs, fake-codex.mjs) to record: every
// commit reachable from any ref or reflog, the history, the remotes, and whether `later` (a commit past the audited
// one) exists, or undefined when no `later` is given.
export function gitSnapshot(later) {
  const git = (...args) => spawnSync('git', args, {encoding: 'utf8'});
  const list = (...args) => git(...args).stdout.split('\n').filter(Boolean);
  return {
    revs: list('rev-list', '--all', '--reflog'),
    log: list('log', '--format=%H'),
    remotes: list('remote'),
    laterExists: later ? git('cat-file', '-e', `${later}^{commit}`).status === 0 : undefined,
  };
}

// Puts the fake command `name` in `bin`: an executable shim that runs `fake-<fake>.mjs` beside this file (by default
// `fake-<name>.mjs`) with `dir` (where the fake reads its answers and records its calls) before the command's own
// arguments.
export function fakeCommand(bin, name, dir, fake = name) {
  writeFileSync(join(bin, name), `#!/bin/sh\nexec '${process.execPath}' '${join(here, `fake-${fake}.mjs`)}' '${dir}' "$@"\n`, {mode: 0o755});
}

// Puts a fake `sudo` in `bin` that runs its command as the caller with UNDER_SUDO=yes: `-v` succeeds, `-u <user>` and
// `-iu <user>` are dropped, and with `loginShell` `-iu` hands its command to bash as sudo hands it to the login shell,
// each character escaped but alphanumerics, _, - and $. With `log`, each call appends `prefix` and its arguments there.
export function fakeSudo(bin, {log, prefix = '', loginShell = false} = {}) {
  writeFileSync(join(bin, 'sudo'), `#!/bin/sh
${log ? `echo "${prefix}$*" >> '${log}'` : ''}
[ "$1" = -v ] && exit 0
if [ "$1" = -iu ]; then
  shift 2
${loginShell ? `  command=""
  for arg; do command="$command $(printf '%s' "$arg" | sed 's/[^A-Za-z0-9_$-]/\\\\&/g')"; done
  UNDER_SUDO=yes exec bash -c "$command"
` : ''}fi
[ "$1" != -u ] || shift 2
UNDER_SUDO=yes exec "$@"
`, {mode: 0o755});
}

// A fake command `name` (fake-answers.mjs) in `bin`, recording into `dir` and answering from `answers` (argument
// prefix -> response, '' for every call).
export function fakeAnswers(bin, name, dir, answers) {
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, 'answers.json'), JSON.stringify(answers));
  fakeCommand(bin, name, dir, 'answers');
}

// A fake `gh` (fake-gh.mjs) in `dir/bin`, which goes first on PATH, answering from `routes` (argument prefix ->
// response). `respond` adds or replaces routes, `json` writes a file a route serves, and `calls` lists every call's
// arguments in order.
export function fakeGh(dir, routes = {}) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, {recursive: true});
  fakeCommand(bin, 'gh', dir);
  const json = (file, value) => writeFileSync(join(dir, file), JSON.stringify(value));
  let current = {};
  const gh = {
    bin, json,
    respond(more) {
      current = {...current, ...more};
      json('routes.json', current);
    },
    calls: () => lines(join(dir, 'calls')).map(line => JSON.parse(line)),
  };
  gh.respond(routes);
  return gh;
}

// A fake `docker` (fake-docker.mjs) in `bin`, recording into `dir`. `containers` sets the compose containers `ps`
// lists ([project, working_dir] pairs), `unavailable` makes every call fail, `failDown` makes `compose down` of the
// projects named fail, `compose` sets the version `compose version` reports (null: no Compose plugin), and `calls`
// lists `<COMPOSE_PROJECT_NAME>|<arguments>` per call.
export function fakeDocker(dir, bin) {
  mkdirSync(dir, {recursive: true});
  fakeCommand(bin, 'docker', dir);
  return {
    containers: pairs => writeFileSync(join(dir, 'ps.json'), JSON.stringify(pairs)),
    unavailable: () => writeFileSync(join(dir, 'unavailable'), ''),
    failDown: (...projects) => writeFileSync(join(dir, 'fail-down'), projects.join('\n')),
    compose: version => writeFileSync(join(dir, 'compose-version'), version ?? ''),
    calls: () => lines(join(dir, 'calls')),
  };
}

// A fake `codex` (fake-codex.mjs) in `bin`, recording into `dir`, and the Codex run log local-audit keeps in
// `dir/state/local-audit` against the fixed clock `now`. `codex` is the last `codex exec`, `codexCalls` every call's
// arguments, `pastRuns` records run starts as offsets in seconds before `now`, `settings` writes the settings file, and
// `runs` lists the recorded starts.
export function fakeCodex(dir, bin, now) {
  fakeCommand(bin, 'codex', dir);
  const state = join(dir, 'state', 'local-audit');
  const write = (file, text) => {
    mkdirSync(state, {recursive: true});
    writeFileSync(join(state, file), text);
  };
  return {
    codex: () => JSON.parse(readFileSync(join(dir, 'codex.json'), 'utf8')),
    codexRan: () => existsSync(join(dir, 'codex.json')),
    codexCalls: () => lines(join(dir, 'codex-calls')).map(line => JSON.parse(line)),
    pastRuns: (...ago) => write('codex-runs', ago.map(seconds => `${now - seconds}\n`).join('')),
    settings: text => write('codex-settings', text),
    runs: () => lines(join(state, 'codex-runs')).map(Number),
  };
}

// Writes a Triphammer config file (bin/config.sh) at `path` with `settings` (name -> value; null leaves one out).
export function writeConfig(path, settings) {
  writeFileSync(path, Object.entries(settings).filter(([, value]) => value !== null)
    .map(([key, value]) => `${key}=${value}\n`).join(''));
}

// Copies this branch's bin `files` (a script and the config.sh it sources) into the checkout `dir`.
export function installTriphammerFiles(dir, ...files) {
  mkdirSync(join(dir, 'bin'), {recursive: true});
  for (const file of files) copyFileSync(join(here, file), join(dir, 'bin', file));
}

// The example project (test-fixtures/example-project): a project file, risk rules and a teardown script, as a project
// served by Triphammer holds them. Its project file is the one the runner tests use unless they give another.
export const exampleProject = join(here, 'test-fixtures/example-project');
export const projectJson = readFileSync(join(exampleProject, '.triphammer/project.json'), 'utf8');

// A bare origin `dir/origin.git`, a publisher clone that pushes to it and a checkout `dir/checkout`, whose main starts
// with `files` (path -> content, null for none; a file starting with #! is executable). `publish` commits a change to
// one file on origin/main and returns the new commit.
function seed(dir, files) {
  const origin = join(dir, 'origin.git');
  const publisher = join(dir, 'publisher');
  const checkout = join(dir, 'checkout');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(dir, 'clone', '-q', origin, publisher);
  git(publisher, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  const write = (path, content) => {
    mkdirSync(join(publisher, path, '..'), {recursive: true});
    writeFileSync(join(publisher, path), content);
  };
  for (const [path, content] of Object.entries(files)) {
    if (content === null) continue;
    write(path, content);
    if (content.startsWith('#!')) chmodSync(join(publisher, path), 0o755);
  }
  git(publisher, 'add', '.');
  git(publisher, 'commit', '-q', '-m', 'first');
  git(publisher, 'push', '-q', 'origin', 'main');
  git(dir, 'clone', '-q', origin, checkout);
  return {
    origin, checkout,
    publish(path, content) {
      write(path, content);
      git(publisher, 'add', path);
      git(publisher, 'commit', '-q', '-m', `change ${path}`);
      git(publisher, 'push', '-q', 'origin', 'main');
      return git(publisher, 'rev-parse', 'HEAD');
    },
  };
}

// A machine whose checkout starts with `files` (path -> content, null for none) as origin/main has them, and whose Triphammer config
// ($TRIPHAMMER_CONFIG, `configFile`) names the example project's repository and App author, this checkout and a state
// directory in the temporary directory, each overridden by `config` (name -> value; null leaves one out). The checkout
// is Triphammer's checkout, the scripts under test run from it; `separateProject` gives the project a repository of its
// own instead.
export function checkoutSetup(t, files = {}, config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'triphammer-update-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const {checkout, publish} = seed(root, {'status/server.mjs': 'v1\n', 'bin/x': 'v1\n', ...files});
  const restarts = join(root, 'restarts');
  const galleryRestarts = join(root, 'gallery-restarts');
  const configFile = join(root, 'triphammer.conf');
  const settings = {REPO: 'Example-Owner/example-project', CHECKOUT: checkout, APP_AUTHOR: 'app/example-agents',
    STATE_DIR: join(root, 'state/ticket-runner')};
  writeConfig(configFile, {...settings, ...config});
  // XDG_STATE_HOME keeps the shared directory, and the stop file update-checkout may create, inside the test's root.
  const env = {...gitEnv, TRIPHAMMER_CONFIG: configFile, XDG_STATE_HOME: join(root, 'state'), STATUS_RESTART: `echo restarted >> '${restarts}'`,
    DEMO_GALLERY_RESTART: `echo restarted >> '${galleryRestarts}'`};
  return {
    root, checkout, env, configFile, publish,
    update: () => run(join(here, 'update-checkout'), [checkout], {env}),
    restartCount: () => lines(restarts).length,
    galleryRestartCount: () => lines(galleryRestarts).length,
    head: () => git(checkout, 'rev-parse', 'HEAD'),
    // A project that is a repository of its own (root/project: its origin, `checkout` and `publish`), whose main has
    // only `files` (by default the example project's .triphammer/project.json: no plugins/, scripts/git-hooks/ or
    // scripts/land-pr.sh), made the Triphammer config's CHECKOUT, so this Triphammer's checkout is Triphammer's alone.
    separateProject(projectFiles = {'.triphammer/project.json': projectJson}) {
      const dir = join(root, 'project');
      mkdirSync(dir);
      const project = seed(dir, projectFiles);
      writeFileSync(configFile, readFileSync(configFile, 'utf8').replace(/^CHECKOUT=.*$/m, `CHECKOUT=${project.checkout}`));
      return {...project, head: () => git(project.checkout, 'rev-parse', 'HEAD')};
    },
  };
}

// A machine whose checkout holds this branch's ticket-runner, config.sh, labels.sh, ticket-decide.py, update-checkout
// and session-sandbox, the example project's .triphammer/project.json (or `project`), plus `files`, and a runner that
// executes the checkout's copy with its state in the temporary directory and `bin` (name -> script) first on PATH. Its
// Triphammer config is Triphammer's, with `config` over it. Its `gh` is a fakeGh answering from `gh` (argument prefix -> response), so by default it answers
// nothing (no stop-agents issue) but that the owner is a person (`api users/`), and its `docker` a fakeDocker listing
// no containers, so a test never reaches the machine's real Docker. Its `bwrap` appends its arguments as one JSON line
// to bwrap-calls (`bwrapCalls`) and runs the command after `--` with no limit, so a test never needs the real one; a
// `bin` entry named bwrap replaces it. Its HOME is `home`, in the temporary directory, with a ~/.codex, so the
// runtime directories the sandbox creates in Codex's directory (~/.codex/sessions) land there as they do on a machine
// with Codex. Its
// bin/github-app-token appends its arguments and $GITHUB_APP_OWNER to $XDG_STATE_HOME/github-app-token-calls
// (`tokenCalls`), fails when $TOKEN_FAIL is set, and for `session-file <file>` writes the account's token ghs_session_<n>,
// n its call count, expiring in 2099, to the file through a rename.
export function runnerSetup(t, {runner = readFileSync(join(here, 'ticket-runner'), 'utf8'), files = {}, bin = {}, gh = {},
  project = projectJson, config = {}} = {}) {
  const r = checkoutSetup(t, {
    'bin/ticket-runner': runner,
    'bin/config.sh': readFileSync(join(here, 'config.sh'), 'utf8'),
    'bin/labels.sh': readFileSync(join(here, 'labels.sh'), 'utf8'),
    'bin/ticket-decide.py': readFileSync(join(here, 'ticket-decide.py'), 'utf8'),
    'bin/update-checkout': readFileSync(join(here, 'update-checkout'), 'utf8'),
    'bin/session-sandbox': readFileSync(join(here, 'session-sandbox'), 'utf8'),
    'bin/github-app-token': `#!/bin/sh
calls="$XDG_STATE_HOME/github-app-token-calls"
echo "$* $GITHUB_APP_OWNER" >> "$calls"
[ -z "$TOKEN_FAIL" ] || { echo "github-app-token: $TOKEN_FAIL" >&2; exit 1; }
[ "$1" = session-file ] || exit 2
printf '{"account":"%s","token":"ghs_session_%s","expires_at":"2099-01-01T00:00:00Z"}\\n' "$GITHUB_APP_OWNER" \\
  "$(wc -l < "$calls")" > "$2.tmp" && mv -f "$2.tmp" "$2"
`,
    'bin/demo-publish': '#!/bin/sh\nexit 0\n',
    '.triphammer/project.json': project,
    ...files,
  }, config);
  const fake = fakeGh(join(r.root, 'gh'), {'api users/': {stdout: 'User\n'}, ...gh});
  const docker = fakeDocker(join(r.root, 'docker'), fake.bin);
  const bwrapCalls = join(r.root, 'bwrap-calls');
  writeFileSync(join(fake.bin, 'bwrap'), `#!/bin/sh
python3 -c 'import json, sys; print(json.dumps(sys.argv[1:]))' "$@" >> '${bwrapCalls}'
while [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done
shift
exec "$@"
`, {mode: 0o755});
  for (const [name, script] of Object.entries(bin)) writeFileSync(join(fake.bin, name), script, {mode: 0o755});
  const home = join(r.root, 'home');
  mkdirSync(join(home, '.codex'), {recursive: true});
  const env = {...withoutSandboxPaths(r.env), HOME: home, XDG_STATE_HOME: join(r.root, 'state'), PATH: `${fake.bin}:${process.env.PATH}`};
  return {
    ...r, env, home, gh: fake, docker,
    bwrapCalls: () => lines(bwrapCalls).map(line => JSON.parse(line)),
    tokenCalls: () => lines(join(r.root, 'state/github-app-token-calls')),
    runTicketRunner: (args = [], extraEnv = {}) =>
      run(join(r.checkout, 'bin/ticket-runner'), args, {env: {...env, ...extraEnv}}),
    log: () => readFileSync(join(r.root, 'state/ticket-runner/log'), 'utf8'),
  };
}
