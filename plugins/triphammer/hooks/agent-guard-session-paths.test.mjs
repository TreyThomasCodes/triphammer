// agent-guard.py: Deadlines, globs, links and write targets in a Triphammer session.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, linkSync, mkdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  guard, python, inTriphammerSession, run, decide, fileInputs, decideFile, repo, fileTools, triphammerSession,
  assertOutsideDenied, assertRuleDenied, outsidePlaces, shellWriters,
} from './agent-guard-fixture.mjs';

// A command whose brace expansions alone take the hook far past its 10-second timeout without a deadline.
const slowCommand = `touch ${'src/{1..4999} '.repeat(80)}`;

test('in a Triphammer session a command the hook cannot finish judging in time is refused, naming the override', t => {
  const s = triphammerSession(t);
  if (!s) return;
  const env = {...s.env, TRIPHAMMER_GUARD_PARSE_SECONDS: '0.3'};
  const started = Date.now();
  const reason = decide(slowCommand, s.worktree, {env});
  assert.ok(Date.now() - started < 3000, 'the hook stops at its deadline');
  assert.ok(reason, 'expected a deny');
  assert.match(reason, /ran out of time \(0\.3 seconds\)/);
  assert.match(reason, /# guard-override: <reason>/);
  assert.equal(decide(`${slowCommand} # guard-override: the owner asked for it`, s.worktree, {env}), null);
  assert.equal(decide('touch src/{a,b}', s.worktree, {env: {...s.env, TRIPHAMMER_GUARD_PARSE_SECONDS: 'x'}}), null,
    'a malformed value keeps the default deadline');
});

// A name and a glob that a backtracking matcher takes minutes over: each * may stop at any of the 200 places.
const longName = 'a'.repeat(200);
const manyStars = `${'*a'.repeat(12)}*b`;

test('a glob with many * over a long name is judged at once', t => {
  const s = triphammerSession(t);
  if (!s) return;
  writeFileSync(join(s.elsewhere, longName), '');
  writeFileSync(join(s.worktree, 'src', longName), '');
  const started = Date.now();
  const reason = decide(`touch ~/.p1 ${s.elsewhere}/${manyStars}`, s.worktree, {env: s.env});
  assertOutsideDenied(reason, 'a write to ~/.p1 beside a slow glob');
  assert.match(reason, /\.p1/);
  assert.doesNotMatch(reason, /ran out of time/);
  assert.equal(decide(`touch src/${manyStars} src/${'*a'.repeat(12)}`, s.worktree, {env: s.env}), null);
  assert.ok(Date.now() - started < 2000, 'the globs are matched without backtracking');
  if (!inTriphammerSession) {
    const {TRIPHAMMER_SESSION: _, ...env} = s.env;
    assert.equal(decide(`touch ~/.p1 ${s.elsewhere}/${manyStars}`, s.worktree, {env}), null);
  }
});

test('in a Triphammer session the hook refuses at its deadline even on a slow path the parse does not check', t => {
  // The project file is a FIFO nobody writes, so reading it for the shell-edit rule blocks; the watchdog, not the
  // parse's own deadline checks, has to stop it. If that read ever stops blocking, pick another slow path.
  const {dir} = repo(t);
  rmSync(join(dir, '.triphammer/project.json'));
  const fifo = spawnSync('mkfifo', [join(dir, '.triphammer/project.json')]);
  if (fifo.status !== 0) {
    t.skip('mkfifo is not available');
    return;
  }
  const env = {...process.env, TRIPHAMMER_SESSION: dir, TRIPHAMMER_GUARD_PARSE_SECONDS: '0.3'};
  const started = Date.now();
  const reason = decide(`sed -i s/X/Z/ ${join(dir, 'src/x.cs')}`, dir, {env});
  assert.ok(Date.now() - started < 3000, 'the hook stops at its deadline');
  assert.ok(reason, 'expected a deny');
  assert.match(reason, /ran out of time \(0\.3 seconds\)/);
  assert.match(reason, /# guard-override: <reason>/);
});

// Writes whose target the hook cannot work out before the command runs, each aimed at ~/.bashrc when it runs.
const unresolvedWrites = s => ['d=~; echo x >> $d/.bashrc', 'echo x >> $(echo ~)/.bashrc', 'touch `echo ~`/.bashrc',
  `d=${s.home}; cd $d && echo x >> .bashrc`, 'd=$HOME; cd $d && echo x >> .bashrc', 'cp src/x.cs $(echo ~)/.bashrc',
  'echo x > "$(echo ~)/.bashrc"', 'TMPDIR=~; echo x > $TMPDIR/.bashrc', 'echo x > ${TMPDIR:=~}/.bashrc',
  'export PWD=~; echo x > "$PWD/.bashrc"', 'read -r TMPDIR; echo x > $TMPDIR/.bashrc',
  'for f in ~/.bashrc; do echo x >> $f; done',
  'cd ~ && pushd /tmp && popd && echo x >> .bashrc', 'dd if=src/x.cs of=$f', 'f=~/.bashrc; sed -i s/a/b/ $f',
  'cd && echo x >> .bashrc', 'cd - && echo x >> .bashrc'];

test('in a Triphammer session a write target the hook cannot work out is refused, naming the override', t => {
  const s = triphammerSession(t);
  if (!s) return;
  for (const command of unresolvedWrites(s)) {
    const reason = decide(command, join(s.worktree, 'src'), {env: s.env});
    assertOutsideDenied(reason, command);
    assert.match(reason, /cannot work out|outside the places/, command);
  }
});

test('in a Triphammer session a target under $HOME, $TMPDIR or $PWD the command does not set is worked out', t => {
  const s = triphammerSession(t);
  if (!s) return;
  for (const command of ['echo x > "$TMPDIR/x"', 'echo x > ${TMPDIR}/x', 'echo x > $PWD/y.cs',
    'cd /tmp && echo x > "$PWD/agent-guard-pwd"', 'echo $(date) > log.txt', 'x=$(cat a); echo "$x" > out.txt',
    'rm -rf "$TMPDIR/run"', 'cp x.cs "${TMPDIR}/b"', 'cd .. && echo x > src/y.cs', 'echo "$HOME" > home.txt']) {
    assert.equal(decide(command, join(s.worktree, 'src'), {env: s.env}), null, command);
  }
  assertOutsideDenied(decide('echo x >> "$HOME/.bashrc"', s.worktree, {env: s.env}), '$HOME is outside');
});

test('in a Triphammer session an append to $TRIPHAMMER_PROPOSALS is worked out, and allowed only in a temporary directory', t => {
  const s = triphammerSession(t);
  if (!s) return;
  const appends = ['echo \'{"title": "x"}\' >> "$TRIPHAMMER_PROPOSALS"', 'printf "%s\\n" x >> ${TRIPHAMMER_PROPOSALS}',
    'echo x | tee -a "$TRIPHAMMER_PROPOSALS"'];
  const inTemp = {...s.env, TRIPHAMMER_PROPOSALS: join(s.temp, 'run/proposals.jsonl')};
  mkdirSync(join(s.temp, 'run'));
  for (const command of appends) assert.equal(decide(command, s.worktree, {env: inTemp}), null, command);
  const elsewhere = {...s.env, TRIPHAMMER_PROPOSALS: join(s.home, '.bashrc')};
  for (const command of appends) assertOutsideDenied(decide(command, s.worktree, {env: elsewhere}), command);
  for (const command of ['TRIPHAMMER_PROPOSALS=~/.bashrc; echo x >> "$TRIPHAMMER_PROPOSALS"',
    'export TRIPHAMMER_PROPOSALS=~/.bashrc; echo x >> $TRIPHAMMER_PROPOSALS']) {
    assertOutsideDenied(decide(command, s.worktree, {env: inTemp}), command);
  }
  assertOutsideDenied(decide(appends[0], s.worktree, {env: s.env}), 'without the variable');
});

test('in a Triphammer session a hard link to a file outside its worktree and temporary directories is refused', t => {
  const s = triphammerSession(t);
  if (!s) return;
  const rc = join(s.home, '.bashrc');
  for (const command of [`ln ${rc} src/rc`, `ln -f ${rc} src/rc`, `ln -t src ${rc}`, `cd src && ln ${rc}`,
    `ln -L ${rc} src/rc`, `cp -l ${rc} src/rc`, `cp --link ${rc} src/rc`, `cp -al ${s.home} src/home`,
    `link ${rc} src/rc`, `rsync -a --link-dest=${s.home} src/ ${join(s.temp, 'copy')}/`]) {
    const reason = decide(command, s.worktree, {env: s.env});
    assertOutsideDenied(reason, command);
    assert.match(reason, /hard link/, command);
  }
  for (const command of ['ln src/x.cs src/y.cs', 'cp -l src/x.cs src/y.cs', 'ln -s x.cs src/rc',
    `cp ${rc} src/rc`, 'link src/x.cs src/z.cs']) {
    assert.equal(decide(command, s.worktree, {env: s.env}), null, command);
  }
});

test('in a Triphammer session a write to a file with another hard link is refused; removing that name is not', t => {
  const s = triphammerSession(t);
  if (!s) return;
  const linked = join(s.worktree, 'src/rc');
  linkSync(join(s.home, '.bashrc'), linked);
  for (const tool of fileTools) {
    const reason = decideFile(tool, linked, s.worktree, {env: s.env});
    assertOutsideDenied(reason, tool, {file: true});
    assert.match(reason, /more than one hard link/, tool);
  }
  for (const command of ['echo x >> src/rc', 'echo x | tee src/rc', 'chmod +x src/rc', 'cp src/x.cs src/rc',
    'truncate -s 0 src/rc', `sed -i 's/a/b/' src/rc`, 'touch src/rc']) {
    const reason = decide(command, s.worktree, {env: s.env});
    assertOutsideDenied(reason, command);
    assert.match(reason, /more than one hard link/, command);
  }
  for (const command of ['cat src/rc', 'rm src/rc', 'rm -rf src', 'mv src/rc src/rc.old', 'echo x >> src/x.cs']) {
    assert.equal(decide(command, s.worktree, {env: s.env}), null, command);
  }
  assert.equal(decideFile('Write', join(s.worktree, 'src/x.cs'), s.worktree, {env: s.env}), null);
});

test('in a Triphammer session crontab other than -l, at and batch are refused', t => {
  const s = triphammerSession(t);
  if (!s) return;
  for (const command of ['crontab -e', 'crontab -r', 'crontab src/x.cs', 'echo "* * * * * x" | crontab -',
    'at now + 1 minute <<< "x"', 'echo x | batch', 'systemd-run --user --on-calendar=hourly x']) {
    assertRuleDenied(decide(command, s.worktree, {env: s.env}), 'scheduler', command);
  }
  assert.equal(decide('crontab -l', s.worktree, {env: s.env}), null);
});

test('in a Triphammer session brace expansion, extglob and globs are judged by every path they may reach', t => {
  const s = triphammerSession(t);
  if (!s) return;
  symlinkSync(s.home, join(s.temp, 'linked'));
  for (const command of [`touch {src/a,${s.elsewhere}/brace}`, `echo x | tee ${s.temp}/{a,../elsewhere/b}`,
    'touch {src/a,$HOME/.bashrc}', `mkdir -p src/{a,../../../../elsewhere/b}`, `cp {src/x.cs,${s.home}/.bashrc}`,
    `cp src/x.cs {src/y.cs,${s.home}/}`, `chown {me,${s.home}/.bashrc} src/x.cs`, 'sed -i {s/a/b/,~/.bashrc}',
    `touch -d {now,${s.home}/.bashrc} src/x.cs`, `rm -rf @(${s.home})`, `touch ${s.temp}/l*/new`,
    `touch ${s.temp}/l*/../x`, `cp src/x.cs ${s.temp}/l*`, 'chmod -R +x src/**', `cd ${s.temp}/l* && touch x`,
    `cd {${s.home},} && touch .bashrc`]) {
    assertOutsideDenied(decide(command, s.worktree, {env: s.env}), command);
  }
  for (const command of ['mkdir -p src/{a,b}/c', `touch ${s.temp}/{a,b{1..3}}`, 'rm -rf src/*', 'rm -f src/*.cs',
    `cp src/*.cs ${s.temp}/`, `touch '{a,b}'`, `echo x > ${s.temp}/{a}`, `ls ${s.home}/{a,b}`, 'touch src/[xy].cs']) {
    assert.equal(decide(command, s.worktree, {env: s.env}), null, command);
  }
});

test('in a Triphammer session a symbolic link to a place outside its worktree and temporary directories is refused', t => {
  const s = triphammerSession(t);
  if (!s) return;
  symlinkSync('/', join(s.elsewhere, 'root'));
  for (const command of [`ln -s ${s.elsewhere} ${s.temp}/s2 && echo x > ${s.temp}/s2/viasym`,
    'ln -s ~/.ssh src/k && echo x > src/k/authorized_keys', `ln -sf ${s.home} src/h`, 'ln -s ../../.. src/up',
    `ln -s -t src ${s.home}`, 'cd src && ln -s ~', `cp -s ${s.home}/.bashrc src/rc`,
    `ln -sr ${s.home}/.bashrc src/rc`, 'ln -s $HOME src/h', `ln --symbolic ${s.home} ${s.temp}/h`]) {
    const reason = decide(command, s.worktree, {env: s.env});
    assertOutsideDenied(reason, command);
    assert.match(reason, /target of a symbolic link/, command);
  }
  // A symlink the command copies or moves (cp -a, -P or -R, mv, rsync -a) lands where it cannot be seen yet.
  for (const command of [`cp -P ${s.elsewhere}/root ${s.temp}/r && echo x >> ${s.temp}/r${s.home}/.bashrc`,
    `cp -a ${s.elsewhere} ${s.temp}/copy && cd ${s.temp}/copy/root${s.home} && touch .bashrc`,
    `rsync -a ${s.elsewhere}/ ${s.temp}/c/ && touch ${s.temp}/c/root/x`,
    `mv ${s.temp}/a ${s.temp}/b && echo x > ${s.temp}/b/root/x`]) {
    const reason = decide(command, s.worktree, {env: s.env});
    assertOutsideDenied(reason, command);
    assert.match(reason, /copies or moves/, command);
  }
  for (const command of ['ln -s ../src/x.cs src/rc-link', 'ln -s x.cs src/rc', `ln -s ${s.temp}/a ${s.temp}/b`,
    `ln -sf src/x.cs ${s.temp}/out`, `cp -r src ${s.temp}/copy`, `mkdir -p ${s.temp}/n && echo x > ${s.temp}/n/f`,
    `cp src/x.cs ${s.temp}/a.cs && sed -i s/a/b/ ${s.temp}/a.cs`, 'ln -s /dev/null src/null']) {
    assert.equal(decide(command, s.worktree, {env: s.env}), null, command);
  }
});

test('in a Triphammer session a `..` after a symlink, and a cd, are judged where the kernel and bash take them', t => {
  const s = triphammerSession(t);
  if (!s) return;
  symlinkSync(s.elsewhere, join(s.temp, 'l'));
  mkdirSync(join(s.elsewhere, 'only-elsewhere'));
  mkdirSync(join(s.temp, 'sub'));
  writeFileSync(join(s.temp, 'cd.sh'), `cd ${s.home}\n`);
  for (const tool of fileTools) {
    assertOutsideDenied(decideFile(tool, `${s.temp}/l/../dotdot`, s.worktree, {env: s.env}), tool,
      {file: true});
  }
  for (const command of [`echo x > ${s.temp}/l/../dotdot`, `cd -P ${s.temp}/l/.. && touch zz`,
    `cd ${s.temp}/l/../only-elsewhere && touch zz`, `cd ${s.temp}/l && touch ../x`,
    `mkdir -p ${s.temp}/new && echo x > ${s.temp}/new/../x`, `CDPATH=${s.base} cd elsewhere && touch z`,
    `export CDPATH=${s.base}; cd elsewhere; touch z`, `. ${s.temp}/cd.sh && touch .bashrc`,
    `cd ~; env cd ${s.temp}; touch .bashrc`, `cd ~; cd ${s.temp} & touch .bashrc`,
    `f() { cd ~; }; cd ${s.temp}; f; touch .bashrc`, `cd ~ && cd ${s.temp} && touch ~-/.bashrc`,
    `cd ~; x=\`cd ${s.temp}\`; touch .bashrc`, `cd ~; true | cd ${s.temp}; touch .bashrc`,
    `trap 'cd ~' DEBUG; touch .bashrc`, `cd ~; pushd -n ${s.temp}; touch .bashrc`]) {
    assertOutsideDenied(decide(command, s.worktree, {env: s.env}), command);
  }
  assertOutsideDenied(decide('cd src && touch z', s.worktree, {env: {...s.env, CDPATH: s.base}}), '$CDPATH');
  for (const command of ['cd src && touch z', `echo x > ${s.temp}/sub/../x`, `cd -P ${s.temp} && touch zz`,
    `cd ${s.temp}/sub/.. && touch zz`, 'cd src/.. && touch z', `(cd ${s.temp} && touch a) & touch src/b`]) {
    assert.equal(decide(command, s.worktree, {env: s.env}), null, command);
  }
  assert.equal(decide('cd ./src && touch z', s.worktree, {env: {...s.env, CDPATH: s.base}}), null);
});

test('in a Triphammer session a cd behind a wrapper or script runner leaves the directory unknown', t => {
  const s = triphammerSession(t);
  if (!s) return;
  for (const command of [`cd ~; runuser -u someone cd ${s.temp}; touch .bashrc`,
    `cd ~; runuser -u someone -- cd ${s.temp}; touch .bashrc`,
    `cd ~; runuser -u someone pushd ${s.temp}; touch .bashrc`,
    `cd ~; runuser -u someone eval 'cd ${s.temp}'; touch .bashrc`, `cd ~; setsid eval 'cd ${s.temp}'; touch .bashrc`,
    `cd ~; flock ${s.temp}/lock eval 'cd ${s.temp}'; touch .bashrc`, `cd ~; ionice eval 'cd ${s.temp}'; touch .bashrc`,
    `cd ~; taskset 1 eval 'cd ${s.temp}'; touch .bashrc`, `cd ~; chrt 1 eval 'cd ${s.temp}'; touch .bashrc`,
    `cd ~; busybox eval 'cd ${s.temp}'; touch .bashrc`, `cd ~; nohup eval 'cd ${s.temp}'; touch .bashrc`]) {
    assertOutsideDenied(decide(command, s.worktree, {env: s.env}), command);
  }
  // A cd or eval in this shell, or after an assignment or `command`, still moves the directory the hook tracks.
  for (const command of [`cd ${s.temp}; touch x`, `cd ~; eval 'cd ${s.temp}'; touch .bashrc`,
    `cd ~; command cd ${s.temp}; touch .bashrc`, `cd ~; X=1 eval 'cd ${s.temp}'; touch .bashrc`]) {
    assert.equal(decide(command, s.worktree, {env: s.env}), null, command);
  }
});

test('every triphammer-session refusal is allowed with the override token appended', t => {
  const s = triphammerSession(t);
  if (!s) return;
  for (const command of ['echo x > ~/.bashrc', 'git config core.hooksPath /x', 'crontab -e',
    'd=~; echo x >> $d/.bashrc', `ln ${join(s.home, '.bashrc')} src/rc`, 'git config interactive.diffFilter x']) {
    assert.ok(decide(command, s.worktree, {env: s.env}), command);
    assert.equal(decide(`${command}  # guard-override: the owner asked for it`, s.worktree, {env: s.env}), null);
  }
});

test('outside a Triphammer session the same writes, git settings and schedules keep today\'s rules', t => {
  if (inTriphammerSession) {
    t.skip('this test runs inside a Triphammer session, which every hook it starts inherits');
    return;
  }
  const s = triphammerSession(t);
  if (!s) return;
  const env = {...s.env};
  delete env.TRIPHAMMER_SESSION;
  for (const tool of fileTools) {
    for (const path of outsidePlaces(s)) {
      assert.equal(decideFile(tool, path, s.worktree, {env}), null, `${tool} ${path}`);
    }
  }
  linkSync(join(s.home, '.bashrc'), join(s.worktree, 'src/rc'));
  for (const tool of fileTools) {
    assert.equal(decideFile(tool, join(s.worktree, 'src/rc'), s.worktree, {env}), null, `${tool} hard link`);
  }
  for (const command of [...shellWriters(join(s.home, '.bashrc')), 'git config core.hooksPath /x',
    'git -c core.pager=x log', 'crontab -e', 'echo x | at now', ...unresolvedWrites(s),
    `ln ${join(s.home, '.bashrc')} src/rc2`, `cp -l ${join(s.home, '.bashrc')} src/rc3`, 'echo x >> src/rc',
    'git config interactive.diffFilter x', 'git config submodule.lib.update "!x"',
    `touch {a,${s.elsewhere}/brace}`, `ln -s ${s.home} h`, `CDPATH=${s.base} cd elsewhere && touch z`,
    `cd ~; env cd ${s.temp}; touch .bashrc`, `ln -s ${s.elsewhere} ${s.temp}/s && echo x > ${s.temp}/s/x`,
    'git remote add evil x', 'git config protocol.allow always', 'git config url.x.insteadOf y', 'env -C ~ touch .p1',
    'git -C ~ config -f .gitconfig user.name x', slowCommand]) {
    assert.equal(decide(command, join(s.worktree, 'src'), {env}), null, command);
  }
  assert.equal(decide('git config core.hooksPath /x', s.worktree, {env: {...env, TRIPHAMMER_SESSION: ''}}), null);
});

test('a Triphammer session cannot widen its places by changing the marker or $TMPDIR the hook sees', t => {
  const s = triphammerSession(t);
  if (!s) return;
  if (!existsSync('/proc/self/environ')) {
    t.skip('no /proc to read the environment the session started with');
    return;
  }
  // A shell that started with the session's marker runs the hook with a wider one, as a settings file's env would.
  const input = JSON.stringify({tool_name: 'Write', tool_input: fileInputs.Write(join(s.home, '.bashrc')),
    cwd: s.worktree});
  for (const [marker, temp] of [['/', s.temp], ['', s.temp], [s.worktree, s.home]]) {
    const result = spawnSync('/bin/sh', ['-c', `TRIPHAMMER_SESSION="$1" TMPDIR="$2" "$3" -I "$4"; exit $?`, 'sh',
      marker, temp, python, guard], {input, encoding: 'utf8', env: s.env});
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout, `expected a deny with marker ${marker} and TMPDIR ${temp}`);
    assertOutsideDenied(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason, marker, {file: true});
  }
});

test('a Triphammer session whose marker names no directory may write only the temporary directories', t => {
  const s = triphammerSession(t);
  if (!s) return;
  const env = {...s.env, TRIPHAMMER_SESSION: '1'};
  assertOutsideDenied(decideFile('Write', join(s.worktree, 'src/x.cs'), s.worktree, {env}), 'worktree', {file: true});
  assert.equal(decideFile('Write', join(s.temp, 'x'), s.worktree, {env}), null);
  assert.equal(run('not json', {env}), null, 'malformed input stays allowed');
});
