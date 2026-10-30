// The `docker` Triphammer tests put first on PATH (see fakeDocker in fixture.mjs): `node fake-docker.mjs <dir> <docker
// arguments>`. It appends `<COMPOSE_PROJECT_NAME>|<arguments>` to <dir>/calls, and fails every call while
// <dir>/unavailable exists, as docker does when its daemon is down. `ps` prints <dir>/ps.json (an array of
// [project, working_dir]) as tab-separated lines, whatever the --format asks. `compose ... down` for the project
// named by -p or COMPOSE_PROJECT_NAME fails when <dir>/fail-down lists it; otherwise it prints compose's `Removed`
// line for each of the project's containers and drops them from ps.json. `info` prints an engine version. `compose
// version` prints the Compose version in <dir>/compose-version (default 2.32.4), or fails as docker does without the
// Compose plugin when that file is empty. The daemon a call reaches is the -H (--host) it gives, else $DOCKER_HOST, else
// unix:///var/run/docker.sock: it appends `<daemon>|<arguments>` to <dir>/hosts, and fails the call as docker does
// when its daemon is down when <dir>/refuse lists that daemon, but for `compose version`, which asks no daemon. `run ... sh -c <script>` does nothing unless
// <dir>/writes exists, and then creates, outside, each file the script's `touch /host<path>` names, as a container
// that may write through its mount of / would.
import {appendFileSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

const [dir, ...args] = process.argv.slice(2);
appendFileSync(join(dir, 'calls'), `${process.env.COMPOSE_PROJECT_NAME ?? ''}|${args.join(' ')}\n`);
const at = args.findIndex(arg => arg === '-H' || arg === '--host');
const daemon = at >= 0 ? args[at + 1] : process.env.DOCKER_HOST || 'unix:///var/run/docker.sock';
appendFileSync(join(dir, 'hosts'), `${daemon}|${args.join(' ')}\n`);
if (at >= 0) args.splice(at, 2);
const refused = !(args[0] === 'compose' && args[1] === 'version') && existsSync(join(dir, 'refuse'))
  && readFileSync(join(dir, 'refuse'), 'utf8').split('\n').includes(daemon);
if (existsSync(join(dir, 'unavailable')) || refused) {
  console.error(`Cannot connect to the Docker daemon at ${daemon}. Is the docker daemon running?`);
  process.exit(1);
}
const psFile = join(dir, 'ps.json');
const containers = existsSync(psFile) ? JSON.parse(readFileSync(psFile, 'utf8')) : [];
const composeFile = join(dir, 'compose-version');
if (args[0] === 'info') {
  console.log('28.0.1');
} else if (args[0] === 'compose' && args[1] === 'version') {
  const version = existsSync(composeFile) ? readFileSync(composeFile, 'utf8') : '2.32.4';
  if (version === '') {
    console.error("docker: unknown command: docker compose");
    process.exit(1);
  }
  console.log(version);
} else if (args[0] === 'run') {
  const script = args[args.indexOf('-c') + 1] ?? '';
  if (existsSync(join(dir, 'writes'))) {
    for (const [, path] of script.matchAll(/touch "?\/host(\/[^"\s]+)/g)) writeFileSync(path, '');
  }
} else if (args[0] === 'ps') {
  for (const [project, workingDir] of containers) console.log(`${project}\t${workingDir}`);
} else if (args[0] === 'compose' && args.includes('down')) {
  const at = args.indexOf('-p');
  const project = at < 0 ? process.env.COMPOSE_PROJECT_NAME : args[at + 1];
  const failing = existsSync(join(dir, 'fail-down')) ? readFileSync(join(dir, 'fail-down'), 'utf8').split('\n') : [];
  if (failing.includes(project)) {
    console.error(`Error response from daemon: removal of container ${project}-db-1 is already in progress`);
    process.exit(1);
  }
  for (const [name] of containers.filter(([name]) => name === project)) console.error(` Container ${name}-db-1  Removed`);
  writeFileSync(psFile, JSON.stringify(containers.filter(([name]) => name !== project)));
}
