// The package and account tools the provision tests put first on PATH, acting out one machine:
// `node fake-machine.mjs <machine>/<command> <arguments>`, installed by fixture.mjs's fakeCommand with
// fakeCommand(bin, <command>, join(<machine>, <command>), 'machine'), so the directory's last part names the command.
// Every call appends [command, ...arguments] to <machine>/calls as a JSON line. The machine's state is
// <machine>/machine.json: {packages, unavailable, users: {name: {home, groups, uid}}, linger, enabled, loaded,
// downloads: {url: file}, acls: {path: [entry]}, bin, sys}, which the calls read and change:
// - apt-get update; apt-get install ... <packages> adds them, or fails like apt-get when one is `unavailable`;
//   dpkg-query -W -f=... <package> prints `installed` for an installed one; dpkg --print-architecture prints amd64;
// - useradd --home-dir <home> ... <name> creates the user (and its home), usermod -aG <group> <name> adds a group,
//   gpasswd -d <name> <group> removes one, usermod --add-subuids|--add-subgids <first>-<last> <name> appends
//   <name>:<first>:<count> to <sys>/etc/subuid or subgid, getent passwd <name> and id -u [<name>] / id -nG <name> report
//   them (id -u alone is root's 0; a user's uid is its `uid`, by default the caller's own, so the files the tests write
//   are the user's);
// - setfacl -m <entry>[,<entry>...] [--] <path> adds the entries (as getfacl writes them) to `acls[path]`, and
//   getfacl ... <path> prints them, one per line;
// - loginctl enable-linger <name> and loginctl show-user <name> --property=Linger --value;
// - systemctl --machine=<name>@ --user link <path> links the unit into the user's ~/.config/systemd/user, enable
//   [--now] <unit...> adds the units to `enabled`, is-enabled [--quiet] [--] <unit> succeeds for one in it, and any
//   other systemctl call only records;
// - curl [-I] [-o <file>] <url> serves `downloads[url]` (a file's path) to the file or standard output, or fails as a
//   404 does under -f;
// - apparmor_parser -r <path> loads the profile named by the file; bwrap --unshare-user succeeds once `bwrap` is loaded;
// - runuser -u <name> -- <command...> runs the command as the caller, `bin` first on the PATH its env -i sets;
// - git [-c <key=value>]... clone ..., installed only for a machine whose origins are private, first asks git's
//   credential helpers for github.com credentials with the same -c options (`git credential fill`) and fails as an
//   authentication failure does unless they give a password; then it, and every other git call, runs the real git at
//   `git`;
// - chown only records.
import {spawnSync} from 'node:child_process';
import {appendFileSync, copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync} from 'node:fs';
import {basename, dirname, join} from 'node:path';

const [dir, ...args] = process.argv.slice(2);
const command = basename(dir);
const machine = dirname(dir);
appendFileSync(join(machine, 'calls'), `${JSON.stringify([command, ...args])}\n`);
const file = join(machine, 'machine.json');
const state = {packages: [], unavailable: [], users: {}, linger: [], enabled: [], loaded: [], downloads: {}, acls: {}, git: 'git', ...JSON.parse(readFileSync(file, 'utf8'))};
const save = () => writeFileSync(file, JSON.stringify(state, null, 2));
const done = (stdout = '', exit = 0, stderr = '') => {
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exit(exit);
};
const option = name => args[args.indexOf(name) + 1];

switch (command) {
  case 'apt-get': {
    if (args[0] === 'update') done();
    const packages = args.slice(1).filter(arg => !arg.startsWith('-'));
    const missing = packages.filter(name => state.unavailable.includes(name));
    if (missing.length) done('', 100, `E: Unable to locate package ${missing[0]}\n`);
    state.packages.push(...packages.filter(name => !state.packages.includes(name)));
    save();
    done();
  }
  case 'dpkg-query':
    done(state.packages.includes(args.at(-1)) ? 'installed' : '', state.packages.includes(args.at(-1)) ? 0 : 1);
  case 'dpkg':
    done('amd64\n');
  case 'useradd': {
    const name = args.at(-1);
    const home = option('--home-dir');
    mkdirSync(home, {recursive: true});
    state.users[name] = {home, groups: [name]};
    save();
    done();
  }
  case 'usermod':
    for (const kind of ['uid', 'gid']) {
      if (!args.includes(`--add-sub${kind}s`)) continue;
      const [first, last] = option(`--add-sub${kind}s`).split('-').map(Number);
      appendFileSync(join(state.sys, `etc/sub${kind}`), `${args.at(-1)}:${first}:${last - first + 1}\n`);
    }
    if (args.includes('-aG')) state.users[args.at(-1)].groups.push(option('-aG'));
    save();
    done();
  case 'gpasswd': {
    const user = state.users[option('-d')];
    user.groups = user.groups.filter(group => group !== args.at(-1));
    save();
    done(`Removing user ${option('-d')} from group ${args.at(-1)}\n`);
  }
  case 'setfacl': {
    const entries = state.acls[args.at(-1)] ??= [];
    entries.push(...option('-m').split(',').filter(entry => !entries.includes(entry)));
    save();
    done();
  }
  case 'getfacl':
    done((state.acls[args.at(-1)] ?? []).map(entry => `${entry}\n`).join(''));
  case 'getent': {
    const user = state.users[args[1]];
    done(user ? `${args[1]}:x:1001:1001::${user.home}:/bin/bash\n` : '', user ? 0 : 2);
  }
  case 'id': {
    if (args.length === 1) done('0\n');
    const user = state.users[args[1]];
    if (!user) done('', 1, `id: '${args[1]}': no such user\n`);
    done(args[0] === '-nG' ? `${user.groups.join(' ')}\n` : `${user.uid ?? process.getuid()}\n`);
  }
  case 'loginctl':
    if (args[0] === 'enable-linger') {
      state.linger.push(args[1]);
      save();
      done();
    }
    if (state.linger.includes(args[1])) done('yes\n');
    done('', 1, `Failed to get user: User ID 1001 is not logged in or lingering\n`);
  case 'systemctl': {
    const at = args.indexOf('link');
    if (at >= 0) {
      const name = args.find(arg => arg.startsWith('--machine=')).slice('--machine='.length, -1);
      const units = join(state.users[name].home, '.config/systemd/user');
      mkdirSync(units, {recursive: true});
      symlinkSync(args[at + 1], join(units, basename(args[at + 1])));
    }
    const units = args.filter(arg => !arg.startsWith('-')).slice(1);
    if (args.includes('enable')) {
      state.enabled.push(...units.filter(unit => !state.enabled.includes(unit)));
      save();
    }
    if (args.includes('is-enabled')) done('', state.enabled.includes(units[0]) ? 0 : 1);
    done();
  }
  case 'curl': {
    // A config on standard input (github-app-token's header) is read, as curl reads it, before answering.
    if (args.includes('-K') && option('-K') === '-') readFileSync(0);
    const url = args.at(-1);
    const source = state.downloads[url];
    if (!source) done('', 22, 'curl: (22) The requested URL returned error: 404\n');
    if (args.includes('-fsSIL')) done();
    if (args.includes('-o')) {
      copyFileSync(source, option('-o'));
      done();
    }
    done(readFileSync(source, 'utf8'));
  }
  case 'apparmor_parser':
    state.loaded.push(basename(option('-r')));
    save();
    done();
  case 'bwrap':
    if (args[0] === '--version') done('bubblewrap 0.11.0\n');
    done('', state.loaded.includes('bwrap') ? 0 : 1, state.loaded.includes('bwrap') ? '' : 'bwrap: setting up uid map: Permission denied\n');
  case 'runuser': {
    const rest = args.slice(args.indexOf('--') + 1).map(arg => arg.startsWith('PATH=') ? `PATH=${state.bin}:${arg.slice(5)}` : arg);
    const result = spawnSync(rest[0], rest.slice(1), {stdio: 'inherit'});
    process.exit(result.status ?? 1);
  }
  case 'git': {
    const at = args.indexOf('clone');
    const options = args.slice(0, Math.max(at, 0));
    if (at >= 0 && options.every((arg, i) => i % 2 ? options[i - 1] === '-c' : arg === '-c')) {
      const fill = spawnSync(state.git, [...options, 'credential', 'fill'], {input: 'protocol=https\nhost=github.com\n\n',
        encoding: 'utf8', env: {...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: ''}});
      if (fill.status !== 0 || !/^password=./m.test(fill.stdout)) {
        done('', 128, `${fill.stderr}fatal: Authentication failed for 'https://github.com/'\n`);
      }
    }
    const result = spawnSync(state.git, args, {stdio: 'inherit'});
    process.exit(result.status ?? 1);
  }
  default:
    done();
}
