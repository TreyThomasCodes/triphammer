// agent-guard.py: Shell commands that change Triphammer's persistence, the override, and the hook's own failures.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, relative} from 'node:path';
import {
  inTriphammerSession, run, decide, repo, pyEdit, machineHome, configuredSetup, validConf,
} from './agent-guard-fixture.mjs';

function assertPersistenceDenied(reason, command) {
  assert.ok(reason, `expected a deny: ${command}`);
  assert.match(reason, /persistence rule/);
  assert.match(reason, /the owner does that/);
  assert.match(reason, /# guard-override: <reason>/);
}

// README install text whose heredoc ends at an EOF line inside it, so bash runs the rest, apostrophe and all.
const earlyEof = rest => `cat > README.md <<EOF\n## Install\n\nEOF\n${rest}\nIt's the owner's step.\nEOF`;

const persistenceRefused = [
  'systemctl --user disable --now ticket-runner.timer',
  'ln -sfn x ~/.local/bin/ticket-runner',
  earlyEof('systemctl --user disable --now ticket-runner.timer'),
  earlyEof('ln -sfn "$checkout/bin/$script" ~/.local/bin/"$script"'),
  earlyEof('ln -sfn x ~/.local/bin/ticket-runner'),
  'systemctl --user daemon-reload',
  'systemctl --user daemon-reexec',
  'systemctl --user enable --now "ticket-runner@$project.timer" "merge-when-ready@$project.timer"',
  'systemctl --user link /opt/checkout/systemd/ticket-runner@.timer',
  'systemctl --user stop ticket-runner@example-project.service',
  'systemctl --user restart triphammer-status',
  "systemctl --user mask 'merge-when-ready*'",
  'sudo -u someone systemctl --now --user disable merge-when-ready.timer',
  'rm -f ~/.config/systemd/user/ticket-runner.timer',
  'rm -rf ~/.config',
  'echo stop > ~/.local/state/ticket-runner/stop',
  'echo stop > "$HOME/.local/state/triphammer/stop"',
  'printf x | tee ${HOME}/.config/triphammer/example-project.conf',
  "sed -i 's/a/b/' ~/.config/triphammer/example-project.conf",
  'ln -s /opt/checkout/bin/land-pr ~/.local/bin/land-pr',
  'cp /opt/checkout/bin/ticket-runner ~/.local/bin/',
  'mv ~/.local/bin/land-pr /tmp/land-pr',
  'mkdir -p ~/.config/systemd/user',
  'touch ~/.local/state/ticket-runner/stop',
  'chmod +x ~/.local/bin/ticket-runner',
  'cd ~/.local/bin && unlink merge-when-ready',
  'cd "$HOME/.config/systemd/user" && rm ticket-runner.timer',
  `bash -c 'rm ~/.local/bin/ticket-runner'`,
  'setsid rm ~/.local/bin/ticket-runner',
  'flock /tmp/l rm ~/.local/bin/ticket-runner',
  `flock /tmp/l -c 'rm ~/.local/bin/ticket-runner'`,
  'flock ~/.local/state/ticket-runner/stop true',
  'ionice -c3 rm ~/.local/bin/ticket-runner',
  'taskset -c 0-3 rm ~/.local/bin/ticket-runner',
  'chrt -o 0 rm ~/.local/bin/ticket-runner',
  'busybox rm ~/.local/bin/ticket-runner',
  `script -qc 'rm ~/.local/bin/ticket-runner' /dev/null`,
  'script -q -c true ~/.local/state/ticket-runner/stop',
  `su -c 'rm ~/.local/bin/ticket-runner'`,
  `sudo su - someone --command='rm ~/.local/bin/ticket-runner'`,
  'echo x | xargs rm ~/.local/bin/ticket-runner',
];

for (const command of persistenceRefused) {
  test(`a change to Triphammer's persistence is refused: ${command.split('\n').at(-3) ?? command}`, t => {
    const {env, cwd} = machineHome(t);
    assertPersistenceDenied(decide(command, cwd, {env}), command);
  });
}

test('the refusal names the unit or the path it changes', t => {
  const {home, env, cwd} = machineHome(t);
  assert.match(decide('systemctl --user disable --now ticket-runner.timer', cwd, {env}),
    /systemctl --user disable ticket-runner\.timer/);
  const runner = join(home, '.local/bin/ticket-runner');
  assert.ok(decide('ln -sfn x ~/.local/bin/ticket-runner', cwd, {env}).includes(runner));
  const script = `python3 -c 'open("${runner}", "w").write("")'`;
  assert.ok(decide(script, cwd, {env}).includes(runner), script);
});

test('the shared directory is $TRIPHAMMER_SHARED_DIR, else under $XDG_STATE_HOME, and the config also under $XDG_CONFIG_HOME',
  t => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'agent-guard-xdg-'));
    t.after(() => rmSync(elsewhere, {recursive: true, force: true}));
    const sharedDir = machineHome(t, {TRIPHAMMER_SHARED_DIR: join(elsewhere, 'shared')});
    assertPersistenceDenied(decide(`echo x > ${join(elsewhere, 'shared', 'stop')}`, sharedDir.cwd, {env: sharedDir.env}));
    assertPersistenceDenied(decide('echo x > "$TRIPHAMMER_SHARED_DIR/stop"', sharedDir.cwd, {env: sharedDir.env}));
    assert.equal(decide('echo x > ~/.local/state/triphammer/stop', sharedDir.cwd, {env: sharedDir.env}), null);
    const xdg = machineHome(t, {XDG_STATE_HOME: join(elsewhere, 'state'), XDG_CONFIG_HOME: join(elsewhere, 'config')});
    assertPersistenceDenied(decide(`touch ${join(elsewhere, 'state', 'triphammer', 'stop')}`, xdg.cwd, {env: xdg.env}));
    assertPersistenceDenied(decide(`rm ${join(elsewhere, 'config', 'systemd', 'user', 'x.timer')}`, xdg.cwd, {env: xdg.env}));
    assertPersistenceDenied(decide('echo x > ~/.config/triphammer/p.conf', xdg.cwd, {env: xdg.env}));
  });

test('a line bash runs before an unbalanced quote is judged', t => {
  const {env, cwd} = machineHome(t);
  assertPersistenceDenied(decide(`rm ~/.local/bin/ticket-runner\necho "unclosed`, cwd, {env}));
  assert.equal(decide(`echo "unclosed\nrm ~/.local/bin/ticket-runner`, cwd, {env}), null);
});

test('reads of Triphammer, its read-only systemctl verbs and prose that mentions changes are allowed', t => {
  const {env, cwd} = machineHome(t);
  const prose = 'systemctl --user disable --now ticket-runner.timer\nln -sfn x ~/.local/bin/ticket-runner\n' +
    'systemctl --user daemon-reload\nEOF\nrm -f ~/.config/systemd/user/ticket-runner.timer';
  for (const command of [
    `cat > notes.md <<'README_END'\n${prose}\nREADME_END`,
    `gh pr create --title "Guard" --body-file - <<'BODY'\n${prose}\nBODY`,
    `gh issue comment 1 --body "Run systemctl --user daemon-reload; ln -sfn x ~/.local/bin/ticket-runner"`,
    'systemctl --user status ticket-runner.timer',
    "systemctl --user list-timers 'ticket-runner@*' 'merge-when-ready@*'",
    'systemctl --user list-units --all',
    'systemctl --user is-enabled ticket-runner.timer',
    'systemctl --user is-active ticket-runner@example-project.service',
    'systemctl --user show -p ActiveState ticket-runner.timer',
    'systemctl --user cat ticket-runner@.service',
    'systemctl --user stop some-other.service',
    'systemctl --user restart "$unit"',
    'journalctl --user -u ticket-runner.service -n 50',
    'ls -la ~/.local/bin ~/.config/systemd/user',
    'cat ~/.config/triphammer/example-project.conf ~/.local/state/ticket-runner/current',
    'readlink -f ~/.local/bin/ticket-runner',
    'cp ~/.local/bin/ticket-runner /tmp/ticket-runner.copy',
    'ln -s ~/.local/bin/ticket-runner /tmp/runner-link',
    'mkdir -p ~/.local/state/other && echo x > ~/.local/binder',
    // A Triphammer session refuses a target computed at run time (worktree-only rule).
    ...inTriphammerSession ? [] : ['echo x > "$dir/stop"'],
  ]) {
    assert.equal(decide(command, cwd, {env}), null, command);
  }
});

// eval runs its arguments as a command, so they are judged as one.
for (const command of [
  `eval 'systemctl --user stop ticket-runner.timer'`,
  'eval "ln -sfn x ~/.local/bin/ticket-runner"',
  'builtin eval -- rm ~/.local/bin/ticket-runner',
  `bash -c "eval 'systemctl --user daemon-reload'"`,
  'eval "cd ~/.local/bin" && rm ticket-runner',
]) {
  test(`a change to Triphammer's persistence through eval is refused: ${command}`, t => {
    const {env, cwd} = machineHome(t);
    assertPersistenceDenied(decide(command, cwd, {env}), command);
  });
}

function assertUnreadableDenied(reason, command) {
  assert.ok(reason, `expected a deny: ${command}`);
  assert.match(reason, /persistence rule/);
  assert.match(reason, /cannot read/);
  assert.match(reason, /# guard-override: <reason>/);
}

for (const command of [
  'eval "$cmd"',
  'eval $cmd',
  'eval "$(cat /tmp/next-step)"',
  'eval $(cat /tmp/next-step)',
  'eval `cat /tmp/next-step`',
  `cat > /tmp/step.sh <<'EOF'\nsystemctl --user stop ticket-runner.timer\nEOF\nsource /tmp/step.sh`,
  `printf 'rm ~/.local/bin/ticket-runner' > step.sh && . ./step.sh`,
  `source <(echo 'systemctl --user stop ticket-runner.timer')`,
  'echo x > "$HOME/s.sh" && . ~/s.sh',
  'echo x > ~/s.sh && source "$HOME/s.sh"',
  'echo x > "${HOME}/s.sh" && source "$HOME/s.sh"',
  'echo x > s.sh && source "$HOME/s.sh"',
  `echo 'systemctl --user exit' > s.sh && bash s.sh`,
  `echo 'systemctl --user exit' > s.sh && sh ./s.sh`,
  `echo 'systemctl --user exit' > ~/s.sh && bash -e -o pipefail "$HOME/s.sh" arg`,
  `printf x > /tmp/s.sh; zsh -- /tmp/s.sh`,
  `cat > s.sh <<'EOF'\nsystemctl --user exit\nEOF\ndash s.sh`,
]) {
  test(`eval or source of text the hook cannot read is refused: ${command.split('\n').at(-1)}`, t => {
    const {env, cwd} = machineHome(t);
    assertUnreadableDenied(decide(command, cwd, {env}), command);
  });
}

test('eval of a command the hook can read that touches nothing protected, and source or a shell run of a file it does not write, are allowed', t => {
  const {env, cwd} = machineHome(t);
  for (const command of [`eval 'echo hello'`, 'eval "ls -la ~/.local/bin"', `eval 'systemctl --user status ticket-runner.timer'`,
    'eval "cd /tmp" && rm x', 'source ~/.bashrc', '. "$venv/bin/activate"', 'echo x > /tmp/a && source /tmp/b',
    'bash existing-script.sh', 'echo x > /tmp/a && bash /tmp/b', `echo x > s.sh && bash -c 'echo hi' s.sh`,
    'echo x > s.sh && bash -s s.sh < /tmp/other', 'echo x > ~/a.sh && source "$HOME/b.sh"',
    `git commit -m "Refuse eval \\"$cmd\\""`]) {
    assert.equal(decide(command, cwd, {env}), null, command);
  }
});

// The user service manager runs the ticket runner, the merge queue and the status page.
for (const verb of ['exit', 'isolate default.target', 'default', 'halt', 'poweroff', 'reboot', 'kexec', 'switch-root /',
  'set-environment FOO=1', 'unset-environment FOO', 'import-environment PATH']) {
  const command = `systemctl --user ${verb}`;
  test(`a systemctl --user verb that acts on the whole manager is refused: ${command}`, t => {
    const {env, cwd} = machineHome(t);
    assertPersistenceDenied(decide(command, cwd, {env}), command);
  });
}

test('read-only systemctl --user verbs stay allowed', t => {
  const {env, cwd} = machineHome(t);
  for (const command of ['systemctl --user status', 'systemctl --user list-timers', 'systemctl --user is-enabled ticket-runner.timer',
    'systemctl --user show', 'systemctl --user show-environment']) {
    assert.equal(decide(command, cwd, {env}), null, command);
  }
});

test('writes, links and removals under the STATE_DIR a Triphammer config sets are refused, and the default stays protected',
  t => {
    const {env, cwd, state} = configuredSetup(t, validConf);
    for (const command of [`touch ${state}/stop`, `echo 42 > ${state}/current`, `ln -sfn x ${state}/lock`,
      `rm -rf ${state}`, `rm -rf ${join(state, '..')}`, 'touch ~/.local/state/ticket-runner/stop']) {
      assertPersistenceDenied(decide(command, cwd, {env}), command);
    }
    assert.equal(decide(`cat ${state}/current && ls ${state}`, cwd, {env}), null);
  });

test('a missing or malformed Triphammer config leaves the default protection and allows other paths', t => {
  for (const conf of [null, () => 'not a config\n', () => 'STATE_DIR=relative/state\n', () => '\0\xff\n']) {
    const {env, cwd, state} = configuredSetup(t, conf);
    assertPersistenceDenied(decide('touch ~/.local/state/ticket-runner/stop', cwd, {env}));
    assert.equal(decide(`touch ${state}/stop`, cwd, {env}), null, String(conf));
  }
  const {env, cwd} = machineHome(t, {XDG_CONFIG_HOME: join(tmpdir(), 'agent-guard-missing-config')});
  assertPersistenceDenied(decide('touch ~/.local/state/ticket-runner/stop', cwd, {env}));
});

// The override.

// main() checks the token once on the raw command, before any parsing, so one command of each class of refusal shows
// it lets every form of that class through.
test('every class of refused command is allowed with the override token appended', t => {
  const {dir} = repo(t);
  const refused = [
    `sed -i 's/X/Z/' src/x.cs`,
    `cat > tests/App.Tests/X.cs <<EOF\nclass Z {}\nEOF`,
    pyEdit('src/App/Y.cs'),
    'cp -f /tmp/x src/x.cs',
    `bash -c 'sed -i s/a/b/ src/x.cs'`,
    'pkill -f web-e2e',
    'pgrep -f "dotnet test"',
    'kill $PPID',
    'kill $$',
  ];
  for (const command of refused) {
    assert.ok(decide(command, dir), `expected a deny without the override: ${command}`);
    assert.equal(decide(`${command}  # guard-override: regenerating a fixture`, dir), null, command);
  }
  const {env, cwd} = machineHome(t);
  for (const command of ['systemctl --user disable --now ticket-runner.timer', 'ln -sfn x ~/.local/bin/ticket-runner',
    earlyEof('systemctl --user daemon-reload'), 'eval "$cmd"', 'systemctl --user exit']) {
    assert.ok(decide(command, cwd, {env}), `expected a deny without the override: ${command}`);
    assert.equal(decide(`${command}\n# guard-override: the owner asked for this relink`, cwd, {env}), null, command);
  }
});

// The hook never blocks on its own failure.

test('malformed hook input allows the command', () => {
  for (const input of ['', 'not json', '[]', '{"tool_name": "Bash"}', '{"tool_name": "Bash", "tool_input": 3}',
    JSON.stringify({tool_name: 'Bash', tool_input: {command: 7}, cwd: '/'})]) {
    assert.equal(run(input), null, input);
  }
});

test('other tools are not judged, and a file tool is not judged as a command', t => {
  const {dir} = repo(t);
  const {home, env, cwd} = machineHome(t);
  assert.equal(run(JSON.stringify({tool_name: 'Write', tool_input: {command: 'pkill -f web-e2e'}, cwd: dir})), null);
  assert.equal(run(JSON.stringify({tool_name: 'Read', tool_input: {file_path: join(home, '.local/bin/x')}, cwd}),
    {env}), null);
});

test('a file tool call the hook cannot judge is allowed', t => {
  const {env, cwd} = machineHome(t);
  for (const input of [{tool_name: 'Write'}, {tool_name: 'Write', tool_input: 3},
    {tool_name: 'Write', tool_input: {content: 'x'}, cwd}, {tool_name: 'Edit', tool_input: {file_path: 7}, cwd},
    {tool_name: 'NotebookEdit', tool_input: {notebook_path: ['x']}, cwd},
    {tool_name: 'Write', tool_input: {file_path: '.local/bin/x'}},
    {tool_name: 'Write', tool_input: {file_path: '.local/bin/x'}, cwd: 'relative'}]) {
    assert.equal(run(JSON.stringify(input), {env}), null, JSON.stringify(input));
  }
});

test('a missing git allows a shell edit', t => {
  const {dir} = repo(t);
  const env = {...process.env, PATH: mkdtempSync(join(tmpdir(), 'agent-guard-nogit-'))};
  t.after(() => rmSync(env.PATH, {recursive: true, force: true}));
  assert.equal(decide(`sed -i 's/X/Z/' src/x.cs`, dir, {env}), null);
});

test('a cwd outside any repository, or no cwd, allows a shell edit', t => {
  const {scratch} = repo(t);
  assert.equal(decide(`sed -i 's/X/Z/' src/x.cs`, scratch), null);
  assert.equal(decide(`sed -i 's/X/Z/' src/x.cs`, undefined), null);
  assert.equal(decide(`sed -i 's/X/Z/' src/x.cs`, join(scratch, 'missing')), null);
});

test('unbalanced quotes allow the command', t => {
  assert.equal(decide(`sed -i 's/X/Z/ src/x.cs`, repo(t).dir), null);
});
