// agent-guard.py: git settings, remotes and upstreams in a Triphammer session.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {join, relative} from 'node:path';
import {
  inTriphammerSession, run, decide, runGit, repo, triphammerSession, assertOutsideDenied, assertRuleDenied,
} from './agent-guard-fixture.mjs';

const gitCommandKeys = ['core.hooksPath', 'core.fsmonitor', 'core.sshCommand', 'core.editor', 'core.pager',
  'credential.helper', 'credential.https://github.com.helper', 'include.path', 'includeIf.gitdir:/x/.path',
  'filter.lfs.clean', 'filter.lfs.smudge', 'filter.lfs.process', 'diff.external', 'diff.pdf.textconv',
  'merge.ours.driver', 'gpg.program', 'CORE.HOOKSPATH', 'gpg.ssh.defaultKeyCommand', 'gpg.ssh.program',
  'interactive.diffFilter', 'trailer.sign.cmd', 'trailer.sign.command', 'sendemail.toCmd', 'sendemail.ccCmd',
  'sendemail.headerCmd', 'sendemail.sendmailCmd', 'sendemail.smtpServer', 'sendemail.work.toCmd',
  'gc.recentObjectsHook', 'imap.tunnel', 'instaweb.httpd', 'difftool.x.path', 'mergetool.x.path', 'browser.x.cmd',
  'browser.x.path', 'man.x.cmd', 'man.x.path', 'guitool.x.cmd'];

test('in a Triphammer session git config and git -c that set a key making git run a command are refused in any scope', t => {
  const s = triphammerSession(t);
  if (!s) return;
  const commands = [];
  for (const key of gitCommandKeys) {
    for (const scope of ['', '--global ', '--system ', '--local ', '--worktree ', '-f .gitconfig ', '--add ',
      '--replace-all ']) {
      commands.push(`git config ${scope}${key} /x/run`);
    }
    commands.push(`git config set ${key} /x/run`, `git -c ${key}=/x/run status`, `git -C . -c ${key}=x log`,
      `git --config-env=${key}=EVIL status`, `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=${key} GIT_CONFIG_VALUE_0=x git status`,
      `export GIT_CONFIG_KEY_0=${key}`);
  }
  commands.push(`git config submodule.lib.update '!sh -c x'`, `git -c 'submodule.lib.update=!x' submodule update`,
    'git config submodule.lib.update "$how"');
  commands.push(`git config alias.st '!sh -c x'`, `git config --global alias.x "! rm -rf ~"`,
    `git -c 'alias.x=!echo hi' x`, 'git config "$key" /x/run', 'git config --edit', 'git config --global -e',
    'git config --rename-section x core', `GIT_CONFIG_PARAMETERS="'core.hooksPath'='/x'" git status`);
  for (const command of commands) {
    assertRuleDenied(decide(command, s.worktree, {env: s.env}), 'git-command', command);
  }
});

test('in a Triphammer session every git config write and every git remote write is refused, whatever the key', t => {
  const s = triphammerSession(t);
  if (!s) return;
  for (const command of ['git config http.proxy http://evil:8080', 'git config http.sslVerify false',
    'git config http.sslCAInfo /tmp/ca.pem', 'git config remote.origin.proxy http://evil:8080',
    'git config http.https://github.com/.proxy http://evil:8080', 'git config --global http.proxy http://evil:8080',
    'git config user.name "Agent"', 'git config --global user.email a@b.c', 'git config alias.st status',
    'git config submodule.lib.update rebase', 'git config gpg.format ssh', 'git config trailer.sign.key Signed-off-by',
    'git config sendemail.from a@b.c', 'git config init.defaultBranch main', 'git config branch.main.description x',
    'git config --add http.extraHeader x', 'git config --replace-all http.proxy x', 'git config --unset core.pager',
    'git config --unset-all http.proxy', 'git config --unset-al http.proxy', 'git config --rename-section old new',
    'git config --remove-section http', 'git config -e', 'git config --edit', 'git config --ed', 'git config -le',
    'git config --file local.cfg http.proxy x', 'git config --file=cfg user.name x', 'git config -fcfg user.name x',
    'git config set http.proxy x', 'git config set --global http.proxy x', 'git config --global set http.proxy x',
    'git config unset http.proxy', 'git config unset --all http.proxy', 'git config rename-section old new',
    'git config remove-section http', 'git config edit', 'git config edit --global', 'git config "$key"',
    'git config $op http.proxy', 'git config "$sub" http.proxy x', 'git -C src config http.proxy x',
    'git remote add evil https://x', 'git remote rename origin old', 'git remote remove origin',
    'git remote rm origin', 'git remote set-head origin evil', 'git remote set-head origin -a',
    'git remote set-branches origin x', 'git remote set-url origin x', 'git remote -v rename origin x']) {
    assertRuleDenied(decide(command, s.worktree, {env: s.env}), 'git-command', command);
  }
});

test('in a Triphammer session xargs running git config, git remote or git without a subcommand is refused, since its input can make a read a write',
  t => {
    const s = triphammerSession(t);
    if (!s) return;
    for (const command of ['echo /tmp/h | xargs git config core.hooksPath',
      'echo /tmp/h | xargs git config --global core.hooksPath', 'echo "core.hooksPath /tmp/h" | xargs git config',
      'echo x | xargs -I{} git config core.hooksPath {}', 'echo x | xargs sudo git -C src config core.pager',
      'echo "add evil https://x" | xargs git remote', 'echo "config core.hooksPath /tmp/h" | xargs git',
      'echo "core.hooksPath=/tmp/h status" | xargs git -c']) {
      assertRuleDenied(decide(command, s.worktree, {env: s.env}), 'git-command', command);
    }
    for (const command of ['git branch --merged | xargs git branch -d', 'echo src/x.cs | xargs git log --']) {
      assert.equal(decide(command, s.worktree, {env: s.env}), null, command);
    }
  });

test('in a Triphammer session xargs with -I standing for git\'s subcommand, a -c value or an assignment before git is refused',
  t => {
    const s = triphammerSession(t);
    if (!s) return;
    for (const command of ['echo config | xargs -I{} git {} core.hooksPath /tmp/h',
      'echo remote | xargs -I{} git {} add x https://x', 'echo core.fsmonitor=/tmp/evil | xargs -I{} git -c {} status',
      `echo "'core.fsmonitor=/tmp/evil'" | xargs -I{} env GIT_CONFIG_PARAMETERS={} git status`,
      'echo config | xargs -i git {} core.hooksPath /tmp/h', 'echo config | xargs --replace=@ git @ core.pager x']) {
      assertRuleDenied(decide(command, s.worktree, {env: s.env}), 'git-command', command);
    }
    for (const command of ['echo src/x.cs | xargs -I{} git log -- {}', 'echo HEAD | xargs -I{} git -C src show {}']) {
      assert.equal(decide(command, s.worktree, {env: s.env}), null, command);
    }
  });

test('in a Triphammer session reading git config and git -c with other keys stay allowed', t => {
  const s = triphammerSession(t);
  if (!s) return;
  for (const command of ['git config core.hooksPath', 'git config --get core.editor', 'git config -l',
    'git config --list --show-origin', 'git config --get-regexp alias', 'git config --get-all http.proxy',
    'git config --show-origin --get http.proxy', 'git config --show-scope -l', 'git config --global --list',
    'git config --file .gitmodules --get-regexp url', 'git config -f cfg -l', 'git config --get "$key"',
    'git config --get-urlmatch http.proxy https://github.com/', 'git config --type=bool --get http.sslVerify',
    'git config get core.editor', 'git config get --all http.proxy', 'git config list', 'git config list --global',
    'git config list --show-origin', 'git remote', 'git remote -v', 'git remote show origin',
    'git remote get-url origin', 'git remote prune origin', 'git remote -v show',
    'git -c user.name=x -c user.email=y commit -m m', 'git -c advice.detachedHead=false checkout -q main',
    'git -c "user.name=$NAME" commit -m m', 'git -c http.proxy=http://localhost:3128 fetch',
    'git log --format=%B -1', 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=x git commit -m m']) {
    assert.equal(decide(command, s.worktree, {env: s.env}), null, command);
  }
});

test('in a Triphammer session a git setting or remote that lets a URL run a command or moves fetch and push is refused', t => {
  const s = triphammerSession(t);
  if (!s) return;
  for (const command of [`git config remote.origin.url 'ext::sh -c touch% /tmp/x'`,
    'git config --global remote.evil.pushurl x', 'git config --add remote.origin.url x', 'git config set remote.origin.url x',
    'git -c remote.origin.url=ext::x fetch', 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.url GIT_CONFIG_VALUE_0=x git fetch',
    `git remote add evil 'ext::sh -c x'`, 'git remote -v add evil x', 'git remote set-url origin x',
    'git remote set-url --push origin x', 'git remote "$sub" origin x', 'git config protocol.allow always',
    'git config --global protocol.ext.allow always', 'git -c protocol.ext.allow=always fetch',
    'git --config-env=protocol.allow=EVIL fetch', 'git config protocol.version 2', 'git config init.templateDir /x',
    'git -c init.templatedir=/x init', 'git config url.ext::sh.insteadOf https://github.com/',
    'git config --global url.x.pushInsteadOf y', 'git config --rename-section x remote.origin',
    `git config remote.origin.fetch '+refs/heads/ticket/7:refs/remotes/origin/main'`,
    'git config --add remote.origin.fetch +refs/heads/x:refs/remotes/origin/main', 'git config --global remote.origin.push x',
    'git config remote.origin.mirror true', 'git config remote.pushDefault evil', 'git config remote.pushdefault evil',
    'git config branch.main.merge refs/heads/ticket/7', 'git config --global branch.main.remote evil',
    'git config branch.feature/x.pushRemote evil', 'git config set branch.main.merge x',
    'git -c remote.origin.fetch=+refs/heads/x:refs/remotes/origin/main fetch', 'git -c branch.main.merge=x pull',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.fetch GIT_CONFIG_VALUE_0=x git fetch',
    `GIT_CONFIG_PARAMETERS="'branch.main.merge'='x'" git pull`, 'git --config-env=remote.origin.fetch=EVIL fetch',
    'git remote set-branches origin ticket/7', 'git remote set-branches --add origin x',
    'git config --rename-section x branch.main']) {
    assertRuleDenied(decide(command, s.worktree, {env: s.env}), 'git-command', command);
  }
  for (const command of ['git config remote.origin.url', 'git config --get remote.origin.url', 'git remote -v',
    'git remote', 'git remote get-url origin', 'git remote show origin', 'git remote prune origin', 'git fetch origin',
    'git config --get-urlmatch http.proxy https://x', 'git config --get remote.origin.fetch',
    'git config --get-all branch.main.merge']) {
    assert.equal(decide(command, s.worktree, {env: s.env}), null, command);
  }
});

test('in a Triphammer session env -C, sudo -D and git -C move the directory relative write targets are judged against', t => {
  const s = triphammerSession(t);
  if (!s) return;
  for (const command of ['env -C ~ touch .p1', `env --chdir=${s.home} touch .p1`, 'env --chdir ~ touch .p1',
    'env --ch ~ touch .p1', 'env -iC ~ touch .p1', `env -C${s.home} touch .p1`, 'sudo -D ~ touch .p1',
    `sudo --chdir=${s.home} touch .p1`, 'env -C src -C ../.. touch x', 'env -C src touch ../../../x',
    `env -S"-C ${s.home} touch .p1"`, `env -C ~ bash -c 'touch .p1'`, 'git -C ~ config -f .gitconfig user.name x',
    'git -C src -C ../.. config --file cfg user.name x', 'git -C ~ config --file=.gitconfig user.name x']) {
    assertOutsideDenied(decide(command, s.worktree, {env: s.env}), command);
  }
  // A directory the hook cannot work out leaves relative targets after it unresolved.
  for (const command of ['env -C "$d" touch x', 'env -C $(echo ~) touch x', 'env -C src* touch x',
    'sudo -D "$d" touch x', 'git -C "$d" config -f cfg user.name x']) {
    const reason = decide(command, s.worktree, {env: s.env});
    assertOutsideDenied(reason, command);
    assert.match(reason, /cannot work out/, command);
  }
  for (const command of ['env -C src touch x', `env -C ${s.worktree}/src touch x`, 'env --chdir=src touch y.cs',
    'sudo -D src touch x', 'env -C src -u FOO touch x', 'git -C src config -f local.cfg --get user.name',
    'env -C ~ touch /tmp/agent-guard-x', 'env -C ~ cat .bashrc > out.txt', 'env -C "$TMPDIR" touch x',
    'git -C ~ status', 'git -C "$d" status', 'env -C "$d" touch /tmp/agent-guard-x']) {
    assert.equal(decide(command, s.worktree, {env: s.env}), null, command);
  }
});

// A Triphammer session whose worktree is a real git worktree on ticket/7 of a checkout on main, with a src/ directory, and
// another repository on main beside them.
function gitTriphammerSession(t) {
  const s = triphammerSession(t);
  if (!s) return null;
  const main = join(s.base, 'main');
  const worktree = join(main, '.worktrees', 'issue-7');
  const other = join(s.base, 'other');
  for (const repo of [main, other]) {
    runGit('init', '-q', '-b', 'main', repo);
    runGit('-C', repo, '-c', 'user.name=x', '-c', 'user.email=x@example.com', 'commit', '-q', '--allow-empty', '-m',
      'x');
  }
  runGit('-C', main, 'worktree', 'add', '-q', '-b', 'ticket/7', worktree);
  mkdirSync(join(worktree, 'src'));
  return {...s, main, worktree, other, env: {...s.env, TRIPHAMMER_SESSION: worktree}};
}

test('in a Triphammer session git sets an upstream only for the branch checked out', t => {
  const s = gitTriphammerSession(t);
  if (!s) return;
  const dir = s.worktree;
  for (const command of ['git branch -u origin/x main', 'git branch --set-upstream-to=origin/x main',
    'git branch --set-up origin/x main', 'git branch -uorigin/x main', 'git branch -u origin/x "$b"',
    'git branch -f --track main origin/x', 'git branch -ft main origin/x', 'git push -u origin main',
    'git push -u origin main:ticket/7', 'git push --set-upstream origin +main', 'git push --set-up origin main',
    'git push -fu origin main', 'git push -u --all origin', 'git push -u --mirror origin', 'git push -u origin "$b"',
    'git -C .. push -u origin ticket/7', 'git checkout -B main --track origin/x', 'git switch -C main --track origin/x',
    'git switch --force-create main -t origin/x', 'git checkout --ignore-other-worktrees main',
    'git -C .. fetch --set-upstream origin evil', 'git -C .. pull --set-upstream origin evil']) {
    assertRuleDenied(decide(command, dir, {env: s.env}), 'git-command', command);
  }
  for (const command of ['git branch -u origin/x', 'git branch --set-upstream-to=origin/x ticket/7',
    'git branch -u origin/x HEAD', 'git branch --unset-upstream', 'git branch --track x origin/x',
    'git branch -f x HEAD', 'git push -u', 'git push -u origin', 'git push -u origin HEAD',
    'git push -u origin ticket/7', 'git push --set-upstream origin HEAD:ticket/7', 'git push origin main:x',
    'git push -o ci.skip -u origin HEAD', 'git checkout -b x --track origin/x', 'git switch -c x --track origin/x',
    'git checkout -B x origin/x', 'git checkout main', 'git -C src branch -u origin/x', 'cd src && git push -u',
    `git -C ${s.worktree} push -u origin ticket/7`, 'git -C .worktrees/issue-7 branch -u origin/x',
    'git fetch --set-upstream origin ticket/7', 'git pull --set-upstream origin ticket/7', 'git fetch -u origin',
    'cd src && git pull --set-up origin x', 'git fetch origin main', 'git pull origin main']) {
    assert.equal(decide(command, command.includes('.worktrees/') ? s.main : dir, {env: s.env}), null, command);
  }
  // Elsewhere, the session's own branch name, HEAD and the branch checked out there all count as another branch.
  for (const command of [`git -C ${s.main} branch -u origin/evil`, `git -C ${s.main} branch -u origin/evil main`,
    `git -C ${s.main} branch --set-upstream-to=origin/evil ticket/7`, `cd ${s.main} && git branch -u origin/evil`,
    `cd ${s.main} && git branch --set-upstream-to=origin/evil HEAD`, `git -C ${s.main} push -u origin main:evil`,
    `git -C ${s.main} push -u origin HEAD`, `git -C ${s.main} push -u`, `cd ${s.main}; git push -u origin`,
    `git -C ${s.other} branch -u origin/evil`, `cd ${s.other} && git push -u origin HEAD`, 'git -C .. branch -u origin/x',
    `git -C ${s.main} checkout -b x --track origin/x`, `cd ${s.main} && git switch -c x -t origin/x`,
    'git -C "$d" branch -u origin/x', 'cd "$d" && git branch -u origin/x', `git --git-dir=${s.main}/.git branch -u origin/x`,
    `git --work-tree ${s.main} branch -u origin/x`, `GIT_DIR=${s.main}/.git git branch -u origin/x`,
    `export GIT_DIR=${s.main}/.git; git push -u origin HEAD`, `env GIT_WORK_TREE=${s.main} git branch -u origin/x`,
    `git -C ${s.main} fetch --set-upstream origin evil`, `git -C ${s.main} pull --set-upstream origin evil`,
    `cd ${s.main} && git fetch --set-upstream origin evil`, `git -C ${s.main} fetch -j 2 --set-up origin evil`,
    `git -C ${s.other} pull --set-upstream origin evil`]) {
    const reason = decide(command, dir, {env: s.env});
    assert.ok(reason, `expected a deny: ${command}`);
    assert.match(reason, /git-command rule/, command);
    assert.match(reason, /cannot place in the session's worktree/, command);
  }
  for (const command of [`git -C ${s.main} branch -u origin/x`, 'git branch -u origin/x', 'git push -u origin HEAD']) {
    const reason = decide(command, s.main, {env: s.env});
    assert.ok(reason, `expected a deny from the main checkout: ${command}`);
    assert.match(reason, /cannot place in the session's worktree/, command);
  }
  // Outside a Triphammer session these stay allowed.
  if (!inTriphammerSession) {
    const {TRIPHAMMER_SESSION: _, ...env} = s.env;
    for (const command of ['git branch -u origin/x main', 'git push -u origin main:x', 'git config branch.main.merge x',
      'git remote set-branches origin x', `git -C ${s.main} fetch --set-upstream origin evil`,
      'git config http.proxy http://evil:8080', 'git remote rename origin x']) {
      assert.equal(decide(command, dir, {env}), null, command);
    }
  }
});
