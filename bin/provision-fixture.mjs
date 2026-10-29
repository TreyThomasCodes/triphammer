// The fake machine the provision and provision-project tests share: machine() sets one up, and changingCalls() picks
// the calls of a run that change it.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fakeCommand, git, here, lines, realCommand, run, toolingEnv} from './fixture.mjs';

// The commands provision changes or inspects the machine with, each a fake-machine.mjs acting on one state.
const machineCommands = ['apt-get', 'dpkg-query', 'dpkg', 'useradd', 'usermod', 'getent', 'id', 'loginctl', 'systemctl',
  'curl', 'apparmor_parser', 'bwrap', 'runuser', 'chown'];
export const scripts = ['ticket-runner', 'merge-when-ready', 'land-pr', 'github-app-token', 'gh', 'demo-gallery'];
export const units = ['ticket-runner@.service', 'ticket-runner@.timer', 'merge-when-ready@.service', 'merge-when-ready@.timer',
  'demo-gallery@.service'];
export const codename = 'resolute';
const dockerRelease = `https://download.docker.com/linux/ubuntu/dists/${codename}/Release`;
const ghKey = 'https://cli.github.com/packages/githubcli-archive-keyring.gpg';

// What a repository holds: Triphammer's own files (the scripts, units, config.sh and the marketplace file), a
// project's (its project file, a global.json pinning 10.0.400 and a web app pinning Playwright 1.63.0), or both, and the
// Node pin in .node-version.
export const triphammerFiles = {
  ...Object.fromEntries(scripts.map(name => [`bin/${name}`, '#!/bin/sh\n'])),
  ...Object.fromEntries(units.map(name => [`systemd/${name}`, '[Unit]\n'])),
  'bin/config.sh': readFileSync(join(here, 'config.sh'), 'utf8'),
  'status/server.mjs': '#!/usr/bin/env node\n',
  'systemd/triphammer-status.service': '[Unit]\n',
  '.claude-plugin/marketplace.json': readFileSync(join(here, '../.claude-plugin/marketplace.json'), 'utf8'),
  '.node-version': '24.19.0\n',
};
export const projectFiles = name => ({
  '.triphammer/project.json': JSON.stringify({name}),
  'global.json': JSON.stringify({sdk: {version: '10.0.400', rollForward: 'latestPatch'}}),
  'web/package.json': JSON.stringify({devDependencies: {'@playwright/test': '1.63.0'}}),
  '.node-version': '24.19.0\n',
});

export const readdir = path => run('ls', ['-A', path]).split('\n').filter(Boolean);

// A fresh Ubuntu machine in a temporary directory: the fakes of `machineCommands` first on PATH, an os-release, the
// repositories under `origins/` (repository -> files), and the downloads the scripts fetch (Docker's and the GitHub
// CLI's keys, Docker's release file unless `dockerRepo` is false, a Node tarball whose npx and npm are fakes, the
// dotnet-install and Claude Code installers, which install fakes, and GitHub's GET /app, whose slug is example-agents).
// With `privateOrigins`, a fake git clones only when git's credential helpers give github.com credentials, and GitHub's
// App API answers github-app-token for the installation on `example`. `provision` and `project` run the branch's
// bin/provision and bin/provision-project on it (`projectFrom` from a working directory given; the fake npx records its
// own in npx-cwds); `placeApp` puts App files with a fresh key in the user's ~/.config/github-app, each mode 600.
export function machine(t, origins, {dockerRepo = true, ghRepo = true, privateOrigins = false} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'provision-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const state = join(root, 'machine');
  const bin = join(root, 'bin');
  const sys = join(root, 'sys');
  const home = join(root, 'home/triphammer');
  for (const dir of [state, bin, join(sys, 'etc'), join(sys, 'tmp'), join(state, 'shims'), join(state, 'claude'), join(state, 'codex'),
    join(root, 'downloads')]) mkdirSync(dir, {recursive: true});
  writeFileSync(join(sys, 'etc/os-release'), `NAME="Ubuntu"\nID=ubuntu\nVERSION_CODENAME=${codename}\n`);
  for (const name of machineCommands) fakeCommand(bin, name, join(state, name), 'machine');
  fakeCommand(join(state, 'shims'), 'claude', join(state, 'claude'));
  fakeCommand(join(state, 'shims'), 'codex', join(state, 'codex'));

  for (const [repo, files] of Object.entries(origins)) {
    const work = join(root, 'work', repo);
    mkdirSync(work, {recursive: true});
    git(work, 'init', '-q', '-b', 'main');
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(work, path, '..'), {recursive: true});
      writeFileSync(join(work, path), content);
    }
    git(work, 'add', '.');
    git(work, 'commit', '-q', '-m', 'first');
    git(root, 'clone', '-q', '--bare', work, join(root, 'origins', `${repo}.git`));
  }

  const download = (name, content, mode = 0o644) => {
    const path = join(root, 'downloads', name);
    writeFileSync(path, content, {mode});
    return path;
  };
  // The fake browsers start once libnss3 is installed, as Chromium does once its libraries are.
  download('chrome', `#!/bin/sh\n[ "$(dpkg-query -W -f='\${db:Status-Status}' libnss3)" = installed ] || exit 1\necho '<html><head></head><body></body></html>'\n`, 0o755);
  const node = join(root, 'node/node-v24.19.0-linux-x64/bin');
  mkdirSync(node, {recursive: true});
  writeFileSync(join(node, 'node'), '#!/bin/sh\n[ "$1" = --version ] && echo v24.19.0\n', {mode: 0o755});
  writeFileSync(join(node, 'npx'), `#!/bin/sh
echo "$*" >> '${state}/npx-calls'
echo "$(pwd) $*" >> '${state}/npx-cwds'
b="$HOME/.cache/ms-playwright"
case "$*" in
  *"install --dry-run chromium") printf '  Install location:    %s\\n' "$b/chromium-1243" "$b/chromium_headless_shell-1243" ;;
  *"install chromium")
    mkdir -p "$b/chromium-1243/chrome-linux64" "$b/chromium_headless_shell-1243/chrome-headless-shell-linux64"
    cp '${root}/downloads/chrome' "$b/chromium-1243/chrome-linux64/chrome"
    cp '${root}/downloads/chrome' "$b/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell"
    touch "$b/chromium-1243/INSTALLATION_COMPLETE" "$b/chromium_headless_shell-1243/INSTALLATION_COMPLETE" ;;
  *"install-deps chromium") [ -e '${state}/deps-unsupported' ] && exit 1; apt-get install -y libnss3 ;;
esac
`, {mode: 0o755});
  writeFileSync(join(node, 'npm'), `#!/bin/sh
echo "$*" >> '${state}/npm-calls'
while [ $# -gt 0 ]; do [ "$1" = --prefix ] && p="$2"; shift; done
mkdir -p "$p/bin" && cp '${state}/shims/codex' "$p/bin/codex"
`, {mode: 0o755});
  const tarball = join(root, 'downloads/node-v24.19.0-linux-x64.tar.xz');
  run('tar', ['-cJf', tarball, '-C', join(root, 'node'), 'node-v24.19.0-linux-x64']);
  const sum = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  const dotnetInstall = download('dotnet-install.sh', `#!/bin/sh
echo "$*" >> '${state}/dotnet-install-calls'
while [ $# -gt 0 ]; do case "$1" in --version) v="$2" ;; --install-dir) d="$2" ;; esac; shift; done
mkdir -p "$d" && printf '#!/bin/sh\\n[ "$1" = --list-sdks ] && echo "%s [%s/sdk]"\\n' "$v" "$d" > "$d/dotnet" && chmod +x "$d/dotnet"
`);
  const claudeInstall = download('claude-install.sh', `#!/bin/sh
echo installed >> '${state}/claude-install-calls'
mkdir -p "$HOME/.local/bin" && cp '${state}/shims/claude' "$HOME/.local/bin/claude"
`);
  const downloads = {
    'https://download.docker.com/linux/ubuntu/gpg': download('docker.asc', 'docker key\n'),
    'https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-x64.tar.xz': tarball,
    'https://nodejs.org/dist/v24.19.0/SHASUMS256.txt': download('SHASUMS256.txt', `${'0'.repeat(64)}  node-v24.19.0-linux-arm64.tar.xz\n${sum}  node-v24.19.0-linux-x64.tar.xz\n`),
    'https://dot.net/v1/dotnet-install.sh': dotnetInstall,
    'https://claude.ai/install.sh': claudeInstall,
    'https://api.github.com/app': download('app.json', JSON.stringify({id: 12345, slug: 'example-agents'})),
  };
  if (dockerRepo) downloads[dockerRelease] = download('Release', 'Origin: Docker\n');
  if (ghRepo) downloads[ghKey] = download('gh.gpg', 'gh key\n');
  if (privateOrigins) {
    fakeCommand(bin, 'git', join(state, 'git'), 'machine');
    downloads['https://api.github.com/app/installations'] = download('installations.json',
      JSON.stringify([{id: 41, account: {login: 'example'}}]));
    downloads['https://api.github.com/app/installations/41/access_tokens'] = download('access-token.json',
      JSON.stringify({token: 'ghs_fake', expires_at: new Date(Date.now() + 3600_000).toISOString().replace(/\.\d+Z$/, 'Z')}));
  }
  writeFileSync(join(state, 'machine.json'), JSON.stringify({bin, downloads, git: realCommand('git')}));

  const env = {...toolingEnv, PATH: `${bin}:${process.env.PATH}`, TRIPHAMMER_PROVISION_ROOT: sys,
    TRIPHAMMER_PROVISION_GIT_BASE: `file://${root}/origins/`};
  const calls = () => lines(join(state, 'calls')).map(line => JSON.parse(line));
  const script = (name, cwd) => (...args) => {
    const before = calls().length;
    const result = spawnSync(join(here, name), args, {env, cwd, encoding: 'utf8'});
    return {status: result.status, stdout: result.stdout, stderr: result.stderr, output: result.stdout + result.stderr,
      calls: calls().slice(before)};
  };
  return {
    root, sys, home, state, calls, env,
    machine: () => JSON.parse(readFileSync(join(state, 'machine.json'), 'utf8')),
    provision: script('provision'),
    project: script('provision-project'),
    projectFrom: (cwd, ...args) => script('provision-project', cwd)(...args),
    placeApp() {
      const app = join(home, '.config/github-app');
      mkdirSync(app, {recursive: true, mode: 0o700});
      writeFileSync(join(app, 'app-id'), '12345\n', {mode: 0o600});
      writeFileSync(join(app, 'owner'), 'example\n', {mode: 0o600});
      run('openssl', ['genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048', '-out', join(app, 'agents.pem')]);
      chmodSync(join(app, 'agents.pem'), 0o600);
    },
  };
}

// The calls of a run that change the machine: any package, account, unit or AppArmor change, a download, and every
// command run as the user that writes (sh -c, npm, an installer through bash -c, git clone, npx install).
export function changingCalls(calls) {
  return calls.filter(([command, ...args]) => {
    if (['dpkg-query', 'dpkg', 'getent', 'id', 'bwrap', 'git'].includes(command)) return false;
    if (command === 'loginctl') return args[0] !== 'show-user';
    if (command === 'systemctl') return !args.includes('is-enabled');
    if (command === 'curl') return !args.includes('-fsSIL') && args.at(-1) !== 'https://api.github.com/app';
    if (command !== 'runuser') return true;
    const inner = args.slice(args.indexOf('--') + 1).filter(arg => !arg.includes('=') || arg.startsWith('-')).slice(2);
    const [name, ...rest] = inner;
    if (name === 'sh' || name === 'npm') return true;
    if (name === 'bash') return rest.join(' ').includes('curl');
    if (name === 'git') return rest.includes('clone') || (rest[0] === 'config' && !rest.includes('--get') && !rest.includes('--get-all'));
    if (name === 'npx') return !rest.includes('--dry-run');
    if (name === 'claude') return !rest.includes('list') && !rest.includes('--version');
    return false;
  });
}
