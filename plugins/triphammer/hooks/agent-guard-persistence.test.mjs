// agent-guard.py: Shell commands that change Triphammer's persistence, the override, and the hook's own failures.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  guard, python, inTriphammerSession, run, decide, repo, machineHome, configuredSetup, validConf,
  assertNoOverrideHint, assertNotLifted,
} from './agent-guard-fixture.mjs';

function assertPersistenceDenied(reason, command) {
  assert.ok(reason, `expected a deny: ${command}`);
  assert.match(reason, /persistence rule/);
  assert.match(reason, /the owner does that/);
  assert.match(reason, /Leave the change to the owner and report it/);
  assertNoOverrideHint(reason, command);
}

// README install text whose heredoc ends at an EOF line inside it, so bash runs the rest, apostrophe and all.
const earlyEof = rest => `cat > README.md <<EOF\n## Install\n\nEOF\n${rest}\nIt's the owner's step.\nEOF`;

const persistenceRefused = [
  'systemctl --user disable --now ticket-runner.timer',
  'systemctl --user daemon-reload',
  'systemctl --user enable --now ticket-runner@example-project.timer merge-when-ready@example-project.timer',
  'systemctl --user link /opt/checkout/systemd/ticket-runner@.timer',
  'systemctl --user stop ticket-runner@example-project.service',
  'systemctl --user restart triphammer-status',
  'sudo -u someone systemctl --now --user disable merge-when-ready.timer',
  earlyEof('systemctl --user disable --now ticket-runner.timer'),
  earlyEof('ln -sfn x ~/.local/bin/ticket-runner'),
  'ln -sfn x ~/.local/bin/ticket-runner',
  'ln -s /opt/checkout/bin/land-pr ~/.local/bin/land-pr',
  'rm -f ~/.config/systemd/user/ticket-runner.timer',
  'rm -rf ~/.config',
  'echo stop > ~/.local/state/ticket-runner/stop',
  'echo stop > "$HOME/.local/state/triphammer/stop"',
  'printf x | tee ${HOME}/.config/triphammer/example-project.conf',
  "sed -i 's/a/b/' ~/.config/triphammer/example-project.conf",
  'cp /opt/checkout/bin/ticket-runner ~/.local/bin/',
  'cp -t ~/.local/bin /opt/checkout/bin/ticket-runner',
  'mv ~/.local/bin/land-pr /tmp/land-pr',
  'timeout 5 rm ~/.local/bin/ticket-runner',
  'env FOO=1 nohup rm ~/.local/bin/ticket-runner',
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
    assertPersistenceDenied(decide(`echo x > ${join(elsewhere, 'state', 'triphammer', 'stop')}`, xdg.cwd, {env: xdg.env}));
    assertPersistenceDenied(decide(`rm ${join(elsewhere, 'config', 'systemd', 'user', 'x.timer')}`, xdg.cwd, {env: xdg.env}));
    assertPersistenceDenied(decide('echo x > ~/.config/triphammer/p.conf', xdg.cwd, {env: xdg.env}));
  });

test('a line bash runs before an unbalanced quote is judged', t => {
  const {env, cwd} = machineHome(t);
  assertPersistenceDenied(decide(`rm ~/.local/bin/ticket-runner\necho "unclosed`, cwd, {env}));
  assert.equal(decide(`echo "unclosed\nrm ~/.local/bin/ticket-runner`, cwd, {env}), null);
});

test('reads of Triphammer, its read-only systemctl verbs, computed paths and prose that mentions changes are allowed', t => {
  const {env, cwd} = machineHome(t);
  const prose = 'systemctl --user disable --now ticket-runner.timer\nln -sfn x ~/.local/bin/ticket-runner\n' +
    'systemctl --user daemon-reload\nEOF\nrm -f ~/.config/systemd/user/ticket-runner.timer';
  for (const command of [
    `cat > notes.md <<'README_END'\n${prose}\nREADME_END`,
    `gh pr create --title "Guard" --body-file - <<'BODY'\n${prose}\nBODY`,
    `gh issue comment 1 --body "Run systemctl --user daemon-reload; ln -sfn x ~/.local/bin/ticket-runner"`,
    'systemctl --user status ticket-runner.timer',
    "systemctl --user list-timers 'ticket-runner@*' 'merge-when-ready@*'",
    'systemctl --user is-enabled ticket-runner.timer',
    'systemctl --user show -p ActiveState ticket-runner.timer',
    'systemctl --user cat ticket-runner@.service',
    'systemctl --user show-environment',
    'systemctl --user stop some-other.service',
    'systemctl --user restart "$unit"',
    'journalctl --user -u ticket-runner.service -n 50',
    'ls -la ~/.local/bin ~/.config/systemd/user',
    'cat ~/.config/triphammer/example-project.conf ~/.local/state/ticket-runner/current',
    'cp ~/.local/bin/ticket-runner /tmp/ticket-runner.copy',
    'ln -s ~/.local/bin/ticket-runner /tmp/runner-link',
    'echo x > ~/.local/binder',
    'rm ~/.local/state/other/x',
    // Computed paths are left to the write limit; a Triphammer session refuses "$dir/stop" nowhere either.
    'echo x > "$dir/stop"',
    'rm "$(echo ~/.local/bin)/ticket-runner"',
  ]) {
    assert.equal(decide(command, cwd, {env}), null, command);
  }
});

// The user service manager runs the ticket runner, the merge queue and the status page.
for (const verb of ['daemon-reexec', 'exit', 'isolate default.target', 'set-environment FOO=1',
  'import-environment PATH']) {
  const command = `systemctl --user ${verb}`;
  test(`a systemctl --user verb that acts on the whole manager is refused: ${command}`, t => {
    const {env, cwd} = machineHome(t);
    assertPersistenceDenied(decide(command, cwd, {env}), command);
  });
}

test('writes and removals under the STATE_DIR a Triphammer config sets are refused, and the default stays protected',
  t => {
    const {env, cwd, state} = configuredSetup(t, validConf);
    for (const command of [`echo 42 > ${state}/current`, `ln -sfn x ${state}/lock`, `rm -rf ${state}`,
      `rm -rf ${join(state, '..')}`, 'echo x > ~/.local/state/ticket-runner/stop']) {
      assertPersistenceDenied(decide(command, cwd, {env}), command);
    }
    assert.equal(decide(`cat ${state}/current && ls ${state}`, cwd, {env}), null);
  });

test('a missing or malformed Triphammer config leaves the default protection and allows other paths', t => {
  for (const conf of [null, () => 'not a config\n', () => 'STATE_DIR=relative/state\n', () => '\0\xff\n']) {
    const {env, cwd, state} = configuredSetup(t, conf);
    assertPersistenceDenied(decide('echo x > ~/.local/state/ticket-runner/stop', cwd, {env}));
    assert.equal(decide(`echo x > ${state}/stop`, cwd, {env}), null, String(conf));
  }
  const {env, cwd} = machineHome(t, {XDG_CONFIG_HOME: join(tmpdir(), 'agent-guard-missing-config')});
  assertPersistenceDenied(decide('echo x > ~/.local/state/ticket-runner/stop', cwd, {env}));
});

// The override.

const shellEdits = [
  `sed -i 's/X/Z/' src/x.cs`,
  `cat > tests/App.Tests/X.cs <<EOF\nclass Z {}\nEOF`,
  'cp -f /tmp/x src/x.cs',
];

function readLog(shared) {
  return readFileSync(join(shared, 'guard-overrides.log'), 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
}

for (const [where, session] of [['outside a Triphammer session', false], ['in a Triphammer session', true]]) {
  test(`${where} the override token lifts the shell-edit rule, and the hook logs it`, t => {
    const {dir} = repo(t);
    const {env, home} = machineHome(t, session ? {TRIPHAMMER_SESSION: dir} : {});
    if (!session) delete env.TRIPHAMMER_SESSION;
    const shared = join(home, 'shared', 'triphammer');
    const withShared = {...env, TRIPHAMMER_SHARED_DIR: shared};
    for (const command of shellEdits) {
      assert.match(decide(command, dir, {env: withShared}) ?? '', /shell-edit rule/, command);
      assert.equal(decide(`${command}  # guard-override: regenerating a fixture`, dir, {env: withShared}), null,
        command);
    }
    const entries = readLog(shared);
    assert.equal(entries.length, shellEdits.length);
    shellEdits.forEach((command, i) => {
      const entry = entries[i];
      assert.match(entry.time, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      assert.deepEqual(entry.session, {session_id: 's1', TRIPHAMMER_SESSION: session ? dir : null});
      assert.equal(entry.rule, 'shell-edit');
      assert.equal(entry.reason, 'regenerating a fixture');
      assert.equal(entry.command, `${command}  # guard-override: regenerating a fixture`);
    });
    const xdg = join(home, 'xdg-state');
    const viaXdg = {...env, XDG_STATE_HOME: xdg};
    assert.equal(decide(`sed -i 's/X/Z/' src/x.cs # guard-override: via XDG`, dir, {env: viaXdg}), null);
    assert.equal(readLog(join(xdg, 'triphammer'))[0].reason, 'via XDG');
    assert.equal(decide('ls  # guard-override: nothing to lift', dir, {env: viaXdg}), null);
    assert.equal(readLog(join(xdg, 'triphammer')).length, 1, 'a token that lifts nothing is not logged');
  });
}

test('a failure to write the override log is reported on stderr and still allows the command', t => {
  const {dir} = repo(t);
  const {env, home} = machineHome(t);
  writeFileSync(join(home, 'blocker'), 'a file, not a directory\n');
  const input = JSON.stringify({session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: {command: `sed -i 's/X/Z/' src/x.cs  # guard-override: fixture`}, cwd: dir});
  const result = spawnSync(python, ['-I', guard], {input, encoding: 'utf8', timeout: 15000,
    env: {...env, TRIPHAMMER_SHARED_DIR: join(home, 'blocker', 'triphammer')}});
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^agent-guard: could not log the override to .*guard-overrides\.log: .+\n$/);
});

test('the override token does not lift the persistence rule, even with a shell edit in the same command', t => {
  const {env, cwd} = machineHome(t);
  for (const command of ['systemctl --user disable --now ticket-runner.timer', 'ln -sfn x ~/.local/bin/ticket-runner',
    earlyEof('systemctl --user daemon-reload'), 'systemctl --user exit', 'echo x > ~/.local/state/triphammer/stop',
    'echo forged >> ~/.local/state/triphammer/guard-overrides.log']) {
    assertNotLifted(command, 'persistence', cwd, {env});
  }
  const {dir} = repo(t);
  assertNotLifted(`sed -i 's/X/Z/' src/x.cs && systemctl --user daemon-reload`, 'persistence', dir, {env});
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

test('outside a Triphammer session no worktree-only, scheduler or needs-owner rule applies', t => {
  if (inTriphammerSession) {
    t.skip('the hook reads $TRIPHAMMER_SESSION from its parents too, which run inside a Triphammer session');
    return;
  }
  const {env, cwd} = machineHome(t);
  delete env.TRIPHAMMER_SESSION;
  for (const command of ['echo x > ~/.bashrc', 'crontab -e', 'gh issue edit 7 --remove-label needs-owner']) {
    assert.equal(decide(command, cwd, {env}), null, command);
  }
});
