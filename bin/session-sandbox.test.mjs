import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {delimiter, dirname, join} from 'node:path';
import {fakeAnswers, fakeDocker, git, gitEnv, here} from './fixture.mjs';

// The real bwrap, which needs unprivileged user namespaces (bin/README.md, The write limit).
const userns = spawnSync('bwrap', ['--unshare-user', '--ro-bind', '/', '/', 'true']).status === 0;
const skip = userns ? false : 'bwrap is missing or cannot create a user namespace here';

// A rig outside /tmp, which the limit leaves writable: in the repository, which this test may write in a session too.
// It holds a bare origin, a main checkout cloned from it with a worktree `.worktrees/issue-1` on ticket/1, a separate
// Triphammer checkout holding this branch's session-sandbox, and a home directory with a Claude Code directory whose
// settings.json and skills are there, a Codex directory with its config.toml and rules, local-audit's
// codex-settings, and NuGet's NuGet.Config. `inside` runs a shell command under the limit in the worktree, as the
// runner does, with `env` added to its environment, and returns its exit status and output.
function sandboxRig(t) {
  const root = mkdtempSync(join(here, '..', '.session-sandbox-test-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const origin = join(root, 'origin.git');
  const main = join(root, 'main');
  const triphammer = join(root, 'triphammer');
  const home = join(root, 'home');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, main);
  writeFileSync(join(main, 'tracked.txt'), 'main\n');
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'first');
  git(main, 'push', '-q', 'origin', 'HEAD:main');
  const worktree = join(main, '.worktrees/issue-1');
  git(main, 'worktree', 'add', '-q', '-b', 'ticket/1', worktree);
  mkdirSync(join(triphammer, 'bin'), {recursive: true});
  copyFileSync(join(here, 'session-sandbox'), join(triphammer, 'bin/session-sandbox'));
  git(triphammer, 'init', '-q', '-b', 'main');
  git(triphammer, 'add', '.');
  git(triphammer, 'commit', '-q', '-m', 'first');
  mkdirSync(join(home, '.claude/skills'), {recursive: true});
  writeFileSync(join(home, '.claude/settings.json'), '{}\n');
  mkdirSync(join(home, '.codex/rules'), {recursive: true});
  writeFileSync(join(home, '.codex/config.toml'), '');
  mkdirSync(join(home, '.local/state/local-audit'), {recursive: true});
  writeFileSync(join(home, '.local/state/local-audit/codex-settings'), 'weekly_cap=1\n');
  mkdirSync(join(home, '.nuget/NuGet'), {recursive: true});
  writeFileSync(join(home, '.nuget/NuGet/NuGet.Config'), '<configuration />\n');
  const {TMPDIR, XDG_STATE_HOME, XDG_DATA_HOME, CLAUDE_CONFIG_DIR, CODEX_HOME, TRIPHAMMER_HUMANIZER_STATE,
    NUGET_PACKAGES, NUGET_HTTP_CACHE_PATH, NUGET_PLUGINS_CACHE_PATH, DOCKER_CONFIG, DOTNET_CLI_HOME, ...env} = gitEnv;
  const inside = (command, extra = {}) => {
    const result = spawnSync(join(triphammer, 'bin/session-sandbox'), [worktree, 'sh', '-c', command],
      {cwd: worktree, env: {...env, HOME: home, ...extra}, encoding: 'utf8'});
    return {status: result.status, output: result.stdout + result.stderr};
  };
  return {root, main, triphammer, home, worktree, inside};
}

// Asserts that writing each of `paths` under the limit, with `extra` in the environment, is refused and leaves it as
// it was.
function assertReadOnly(r, paths, extra) {
  for (const path of paths) {
    const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
    const {status, output} = r.inside(`echo planted > '${path}'`, extra);
    assert.notEqual(status, 0, `${path} was written`);
    assert.match(output, /Read-only file system/, path);
    assert.equal(existsSync(path) ? readFileSync(path, 'utf8') : null, before, `${path} changed`);
  }
}

const pythonWrite = path => `python3 -c "open('${path}', 'w').write('planted')"`;

test('under the limit, the main checkout, Triphammer\'s checkout and the home directory are read-only', {skip}, t => {
  const r = sandboxRig(t);
  const targets = {
    "a tracked file of the main checkout": join(r.main, 'tracked.txt'),
    "a new file in the main checkout": join(r.main, 'new.txt'),
    "a tracked file of Triphammer's checkout": join(r.triphammer, 'bin/session-sandbox'),
    'a file in the home directory': join(r.home, 'outside'),
    "Claude Code's settings.json": join(r.home, '.claude/settings.json'),
    "a file in Claude Code's skills": join(r.home, '.claude/skills/planted.md'),
    "Codex's config.toml": join(r.home, '.codex/config.toml'),
    "a file in Codex's rules": join(r.home, '.codex/rules/planted.rules'),
    "local-audit's codex-settings": join(r.home, '.local/state/local-audit/codex-settings'),
    "NuGet's NuGet.Config": join(r.home, '.nuget/NuGet/NuGet.Config'),
  };
  for (const [what, path] of Object.entries(targets)) {
    const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
    for (const [how, command] of [['python', pythonWrite(path)], ['a shell redirect', `echo planted > '${path}'`]]) {
      const {status, output} = r.inside(command);
      assert.notEqual(status, 0, `${what} was written with ${how}`);
      assert.match(output, /Read-only file system/, `${what} with ${how}: ${output}`);
      assert.equal(existsSync(path) ? readFileSync(path, 'utf8') : null, before, `${what} changed with ${how}`);
    }
  }
  assert.equal(git(r.main, 'status', '--porcelain', '--untracked-files=no'), '');
});

test("under the limit, Triphammer's checkout's .git is read-only, so no config or hook there reaches the next tick", {skip}, t => {
  const r = sandboxRig(t);
  const config = join(r.triphammer, '.git/config');
  const before = readFileSync(config, 'utf8');
  const fsmonitor = r.inside(`git -C '${r.triphammer}' config core.fsmonitor 'echo planted > tracked; false'`);
  assert.notEqual(fsmonitor.status, 0, 'core.fsmonitor was set');
  assert.match(fsmonitor.output, /Read-only file system|could not lock config file/, fsmonitor.output);
  assert.equal(readFileSync(config, 'utf8'), before);
  assertReadOnly(r, [config, join(r.triphammer, '.git/hooks/post-merge')]);
});

test('under the limit, the worktree, its commits, /tmp and what Claude Code, Codex, local-audit and the hooks write are writable', {skip}, t => {
  const r = sandboxRig(t);
  const scratch = mkdtempSync('/tmp/session-sandbox-test-');
  t.after(() => rmSync(scratch, {recursive: true, force: true}));
  const {status, output} = r.inside(`set -e
echo work > work.txt
${pythonWrite(join(r.worktree, 'script.txt'))}
git add work.txt script.txt && git commit -q -m work
echo tmp > '${scratch}/file'
mkdir -p '${r.home}/.claude/projects/p' && echo session > '${r.home}/.claude/projects/p/session.jsonl'
echo cache > '${r.home}/.cache/file'
echo ran > '${r.home}/.local/state/triphammer/humanizer/marker'
echo override >> '${r.home}/.local/state/triphammer/guard-overrides.log'
echo 1 > '${r.home}/.local/state/local-audit/codex-runs.new'
mv '${r.home}/.local/state/local-audit/codex-runs.new' '${r.home}/.local/state/local-audit/codex-runs'
echo state > '${r.home}/.codex/state_5.sqlite'
mkdir -p '${r.home}/.codex/sessions' && echo session > '${r.home}/.codex/sessions/s.jsonl'
mkdir -p '${r.home}/.nuget/packages/p' && echo package > '${r.home}/.nuget/packages/p/p.nupkg'
mkdir -p '${r.home}/.local/share/NuGet/http-cache' && echo index > '${r.home}/.local/share/NuGet/http-cache/vuln_index.dat-new'`);
  assert.equal(status, 0, output);
  assert.equal(readFileSync(join(r.home, '.local/share/NuGet/http-cache/vuln_index.dat-new'), 'utf8'), 'index\n');
  assert.equal(git(r.worktree, 'log', '-1', '--format=%s'), 'work');
  assert.equal(git(r.main, 'rev-parse', 'ticket/1'), git(r.worktree, 'rev-parse', 'HEAD'), "the commit is in the main checkout's .git");
  assert.equal(readFileSync(join(scratch, 'file'), 'utf8'), 'tmp\n');
  assert.equal(readFileSync(join(r.home, '.claude/projects/p/session.jsonl'), 'utf8'), 'session\n');
  assert.equal(readFileSync(join(r.home, '.local/state/triphammer/guard-overrides.log'), 'utf8'), 'override\n');
  assert.equal(readFileSync(join(r.home, '.local/state/local-audit/codex-runs'), 'utf8'), '1\n');
  assert.equal(readFileSync(join(r.home, '.codex/state_5.sqlite'), 'utf8'), 'state\n');
  assert.equal(readFileSync(join(r.home, '.codex/sessions/s.jsonl'), 'utf8'), 'session\n');
});

test('under the limit, the NuGet caches that XDG_DATA_HOME and the NUGET_* variables name are created and writable', {skip}, t => {
  const r = sandboxRig(t);
  const paths = {
    XDG_DATA_HOME: join(r.root, 'data'),
    NUGET_PACKAGES: join(r.root, 'nuget/packages'),
    NUGET_HTTP_CACHE_PATH: join(r.root, 'nuget/http-cache'),
    NUGET_PLUGINS_CACHE_PATH: join(r.root, 'nuget/plugins-cache'),
  };
  const files = [join(paths.XDG_DATA_HOME, 'NuGet/v3-cache'), paths.NUGET_PACKAGES, paths.NUGET_HTTP_CACHE_PATH,
    paths.NUGET_PLUGINS_CACHE_PATH].map(dir => join(dir, 'file'));
  const {status, output} = r.inside(files.map(file => `mkdir -p '${dirname(file)}' && echo nuget > '${file}'`).join('\n'),
    paths);
  assert.equal(status, 0, output);
  for (const file of files) assert.equal(readFileSync(file, 'utf8'), 'nuget\n', file);
  const {status: elsewhere, output: why} = r.inside(`echo planted > '${join(r.root, 'nuget/outside')}'`, paths);
  assert.notEqual(elsewhere, 0, 'the directory around the NuGet caches was written');
  assert.match(why, /Read-only file system/);
});

test('a Codex directory without a config.toml gets an empty one, read-only under the limit', {skip}, t => {
  const r = sandboxRig(t);
  const config = join(r.home, '.codex/config.toml');
  rmSync(config);
  const {status, output} = r.inside(`echo 'notify = ["planted"]' > '${config}'`);
  assert.notEqual(status, 0, 'config.toml was written');
  assert.match(output, /Read-only file system/);
  assert.equal(readFileSync(config, 'utf8'), '');
});

test("under the limit, buildx's state in Docker's config directory is writable and the rest of it read-only", {skip}, t => {
  const r = sandboxRig(t);
  const docker = join(r.home, '.docker');
  mkdirSync(join(docker, 'cli-plugins'), {recursive: true});
  writeFileSync(join(docker, 'config.json'), '{}\n');
  const {status, output} = r.inside(`mkdir -p '${docker}/buildx/refs' && echo ref > '${docker}/buildx/refs/r' && : > '${docker}/buildx/.lock'`);
  assert.equal(status, 0, output);
  assert.equal(readFileSync(join(docker, 'buildx/refs/r'), 'utf8'), 'ref\n');
  assertReadOnly(r, [join(docker, 'config.json'), join(docker, 'cli-plugins/docker-planted'), join(docker, 'contexts')]);
  const config = join(r.root, 'docker-config');
  mkdirSync(config);
  const {status: elsewhere, output: why} = r.inside(`echo built > '${config}/buildx/current'`, {DOCKER_CONFIG: config});
  assert.equal(elsewhere, 0, why);
  assertReadOnly(r, [join(config, 'config.json')], {DOCKER_CONFIG: config});
});

test('with docker installed and no Docker config directory, it gets one with buildx writable and no config.json can be planted', {skip}, t => {
  const r = sandboxRig(t);
  const bin = join(r.root, 'bin');
  mkdirSync(bin);
  fakeDocker(join(r.root, 'docker'), bin);
  const path = {PATH: `${bin}${delimiter}${gitEnv.PATH}`};
  const docker = join(r.home, '.docker');
  const {status, output} = r.inside(`echo built > '${docker}/buildx/current'`, path);
  assert.equal(status, 0, output);
  assertReadOnly(r, [join(docker, 'config.json')], path);
});

test("under the limit, the dotnet CLI's state is writable for the session alone and the SDK beside it read-only", {skip}, t => {
  const r = sandboxRig(t);
  const dotnet = join(r.home, '.dotnet');
  for (const dir of ['sdk/9.9.9', 'shared', 'host', 'packs', 'templates', 'tools', 'toolResolverCache']) {
    mkdirSync(join(dotnet, dir), {recursive: true});
  }
  writeFileSync(join(dotnet, 'dotnet'), 'host\n', {mode: 0o755});
  writeFileSync(join(dotnet, 'sdk/9.9.9/dotnet.dll'), 'sdk\n');
  writeFileSync(join(dotnet, 'toolResolverCache/old'), 'old\n');
  const {status, output} = r.inside(`set -e
cat '${dotnet}/sdk/9.9.9/dotnet.dll'
: > '${dotnet}/9.9.9.dotnetFirstUseSentinel'
test ! -e '${dotnet}/toolResolverCache/old'
mkdir -p '${dotnet}/toolResolverCache/1' '${dotnet}/TelemetryStorageService' '${r.home}/.templateengine/dotnetcli/9.9.9'
echo cache > '${dotnet}/toolResolverCache/1/tool'
echo cache > '${r.home}/.templateengine/dotnetcli/9.9.9/templatecache.json'`);
  assert.equal(status, 0, output);
  assert.match(output, /^sdk$/m);
  assert.ok(!existsSync(join(dotnet, '9.9.9.dotnetFirstUseSentinel')), 'the sentinel outlived the session');
  assert.ok(!existsSync(join(dotnet, 'toolResolverCache/1')), "the session's toolResolverCache outlived it");
  assert.ok(!existsSync(join(r.home, '.templateengine/dotnetcli')), "the session's template cache outlived it");
  assert.equal(readFileSync(join(dotnet, 'toolResolverCache/old'), 'utf8'), 'old\n');
  assertReadOnly(r, ['dotnet', 'sdk/9.9.9/dotnet.dll', 'sdk/9.9.9/planted', 'shared/planted', 'host/planted',
    'packs/planted', 'templates/planted', 'tools/planted'].map(path => join(dotnet, path)));
});

test('with dotnet installed, the CLI home that DOTNET_CLI_HOME names gets writable state for the session', {skip}, t => {
  const r = sandboxRig(t);
  const cliHome = join(r.root, 'cli-home');
  mkdirSync(cliHome);
  const bin = join(r.root, 'bin');
  mkdirSync(bin);
  fakeAnswers(bin, 'dotnet', join(r.root, 'dotnet'), {});
  const extra = {DOTNET_CLI_HOME: cliHome, PATH: `${bin}${delimiter}${gitEnv.PATH}`};
  const {status, output} = r.inside(
    `: > '${cliHome}/.dotnet/9.9.9.dotnetFirstUseSentinel' && : > '${cliHome}/.templateengine/cache'`, extra);
  assert.equal(status, 0, output);
  assertReadOnly(r, [join(cliHome, 'planted')], extra);
});

test('without docker or dotnet, the home directory gets neither directory', {skip}, t => {
  const r = sandboxRig(t);
  const bin = join(r.root, 'bin');
  mkdirSync(bin);
  for (const name of ['bash', 'env', 'sh', 'git', 'bwrap', 'readlink', 'dirname', 'mkdir']) {
    symlinkSync(spawnSync('sh', ['-c', `command -v ${name}`], {encoding: 'utf8'}).stdout.trim(), join(bin, name));
  }
  const {status, output} = r.inside('true', {PATH: bin});
  assert.equal(status, 0, output);
  for (const name of ['.docker', '.dotnet', '.templateengine']) {
    assert.ok(!existsSync(join(r.home, name)), `${name} was created`);
  }
});

test('under the limit, the command cannot see or signal the processes outside', {skip}, t => {
  const r = sandboxRig(t);
  const {status, output} = r.inside(`kill -0 ${process.pid} 2>/dev/null && echo signalled; ls /proc | grep -cx '[0-9]*'`);
  assert.equal(status, 0, output);
  assert.doesNotMatch(output, /signalled/);
  assert.ok(Number(output.trim()) < 10, `the command sees ${output.trim()} processes`);
});

test('a run directory outside any git checkout runs nothing', {skip}, t => {
  const r = sandboxRig(t);
  const outside = join(r.root, 'plain');
  mkdirSync(outside);
  const result = spawnSync(join(r.triphammer, 'bin/session-sandbox'), [outside, 'sh', '-c', 'echo ran'],
    {env: {...gitEnv, HOME: r.home, GIT_CEILING_DIRECTORIES: r.root}, encoding: 'utf8'});
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /is not in a git checkout/);
});
