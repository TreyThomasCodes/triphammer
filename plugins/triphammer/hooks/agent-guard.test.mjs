import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Feeds agent-guard.py the PreToolUse JSON Claude Code sends for a Bash call (or a Write, Edit or NotebookEdit) and
// returns its decision: the deny reason, or null when it lets the call through.
const guard = join(import.meta.dirname, 'agent-guard.py');
const python = spawnSync('python3', ['-I', '-c', 'import sys; print(sys.executable)'], {encoding: 'utf8'})
  .stdout.trim();
// Whether these tests run inside a Triphammer session, whose $TRIPHAMMER_SESSION every hook they start inherits.
const inTriphammerSession = Boolean(process.env.TRIPHAMMER_SESSION);

function run(input, {env = process.env} = {}) {
  const started = Date.now();
  const result = spawnSync(python, ['-I', guard], {input, encoding: 'utf8', env, timeout: 15000});
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.equal(result.stderr, '');
  assert.ok(Date.now() - started < 5000, 'the hook must finish well inside its 10-second timeout');
  if (result.stdout === '') return null;
  const output = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(output.hookEventName, 'PreToolUse');
  assert.equal(output.permissionDecision, 'deny');
  return output.permissionDecisionReason;
}

const decide = (command, cwd, options) =>
  run(JSON.stringify({session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: {command, description: 'test'}, cwd}), options);

// The tool_input each file tool sends for a path.
const fileInputs = {
  Write: path => ({file_path: path, content: 'x\n'}),
  Edit: path => ({file_path: path, old_string: 'a', new_string: 'b'}),
  NotebookEdit: path => ({notebook_path: path, new_source: 'x', cell_id: 'c1'}),
};
const decideFile = (tool, path, cwd, options) =>
  run(JSON.stringify({session_id: 's1', hook_event_name: 'PreToolUse', tool_name: tool,
    tool_input: fileInputs[tool](path), cwd}), options);

function runGit(...args) {
  const result = spawnSync('git', args, {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
}

// A throwaway repository with tracked files under src/, tests/ and docs/, an untracked src/ file and a scratch
// directory outside it that also has a src/. Its .triphammer/project.json is `contract` (by default one whose
// shell-edit roots are src and tests), or there is none when `contract` is null.
function repo(t, {contract = {name: 'sample', shellEditRoots: ['src', 'tests']}} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agent-guard-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const dir = join(root, 'repo');
  for (const path of ['src/App', 'tests/App.Tests', 'docs', '.triphammer', join('..', 'scratch', 'src')]) {
    mkdirSync(join(dir, path), {recursive: true});
  }
  if (contract !== null) {
    writeFileSync(join(dir, '.triphammer/project.json'),
      typeof contract === 'string' ? contract : JSON.stringify(contract));
  }
  writeFileSync(join(dir, 'src/x.cs'), 'class X {}\n');
  writeFileSync(join(dir, 'src/App/Y.cs'), 'class Y {}\n');
  writeFileSync(join(dir, 'tests/App.Tests/X.cs'), 'class XTests {}\n');
  writeFileSync(join(dir, 'docs/notes.md'), 'notes\n');
  runGit('-C', dir, 'init', '-q');
  runGit('-C', dir, 'add', '.');
  writeFileSync(join(dir, 'src/untracked.cs'), 'class U {}\n');
  writeFileSync(join(root, 'scratch', 'src', 'x.cs'), 'class S {}\n');
  return {dir, scratch: join(root, 'scratch')};
}

const pyEdit = path => `python3 - <<'PY'
from pathlib import Path
p = Path("${path}")
p.write_text(p.read_text().replace("X", "Z"))
PY`;
const editsOf = path => [
  `sed -i 's/X/Z/' ${path}`,
  `cat > ${path} <<EOF\nclass Z {}\nEOF`,
  pyEdit(path),
];

function assertShellEditDenied(reason, file) {
  assert.ok(reason, 'expected a deny');
  assert.match(reason, /shell-edit rule/);
  assert.ok(reason.includes(file), reason);
  assert.match(reason, /Edit \(or Write/);
  assert.match(reason, /diagnostics/);
  assert.match(reason, /# guard-override: <reason>/);
}

// Refused shell edits.

test('sed -i on a tracked src/ file is refused with the rule, the fix and the override token', t => {
  const {dir} = repo(t);
  assertShellEditDenied(decide(`sed -i 's/X/Z/' src/x.cs`, dir), 'src/x.cs');
});

test('cat > a tracked tests/ file from a heredoc is refused', t => {
  const {dir} = repo(t);
  assertShellEditDenied(decide(`cat > tests/App.Tests/X.cs <<EOF\nclass Z {}\nEOF`, dir), 'tests/App.Tests/X.cs');
});

test('a python3 heredoc that write_texts a tracked src/ file is refused', t => {
  const {dir} = repo(t);
  assertShellEditDenied(decide(pyEdit('src/App/Y.cs'), dir), 'src/App/Y.cs');
});

for (const [name, command, file] of [
  ['an append redirect', 'echo "// x" >> src/x.cs', 'src/x.cs'],
  ['tee', 'echo hi | tee -a src/x.cs', 'src/x.cs'],
  ['perl -pi', `perl -pi -e 's/X/Z/' tests/App.Tests/X.cs`, 'tests/App.Tests/X.cs'],
  ['cp onto the file', 'cp /etc/hostname src/App/Y.cs', 'src/App/Y.cs'],
  ['cp into its directory', 'cp /elsewhere/Y.cs src/App/', 'src/App/Y.cs'],
  ['a glob', `sed -i.bak 's/X/Z/' src/App/*.cs`, 'src/App/Y.cs'],
  ['python3 -c', `python3 -c "open('src/x.cs', 'w').write('')"`, 'src/x.cs'],
  ['node -e', `node -e "require('fs').writeFileSync('src/x.cs', '')"`, 'src/x.cs'],
  ['cat piped into python3', `cat <<'PY' | python3 -\nimport pathlib\npathlib.Path('src/x.cs').write_text('')\nPY`,
    'src/x.cs'],
  ['bash -c', `bash -c "sed -i s/X/Z/ src/x.cs"`, 'src/x.cs'],
]) {
  test(`a shell edit through ${name} is refused`, t => {
    const {dir} = repo(t);
    assertShellEditDenied(decide(command, dir), file);
  });
}

// Other commands that write a file named among their operands.
const writerForms = [
  ['install', 'install -m 0644 /tmp/x src/x.cs', 'src/x.cs'],
  ['install with the mode attached', 'install -m0644 -o someone -g staff /tmp/x src/x.cs', 'src/x.cs'],
  ['install into its directory', 'install -D -m 0644 /tmp/x.cs src/', 'src/x.cs'],
  ['install -t', 'install -t src/App /tmp/Y.cs', 'src/App/Y.cs'],
  ['install --target-directory=', 'install --mode=0644 --target-directory=src/App /tmp/Y.cs', 'src/App/Y.cs'],
  ['mv', 'mv /tmp/x src/x.cs', 'src/x.cs'],
  ['mv -f into its directory', 'mv -f /tmp/Y.cs src/App', 'src/App/Y.cs'],
  ['mv -t', 'mv -t src/App /tmp/Y.cs', 'src/App/Y.cs'],
  ['mv --target-directory', 'mv --target-directory src/App /tmp/Y.cs', 'src/App/Y.cs'],
  ['mv -S with a suffix', 'mv -b -S .orig /tmp/x src/x.cs', 'src/x.cs'],
  ['dd of=', 'dd of=src/x.cs', 'src/x.cs'],
  ['dd if= of=', 'dd if=/tmp/x of=tests/App.Tests/X.cs bs=1M conv=notrunc', 'tests/App.Tests/X.cs'],
  ['ln -f', 'ln -f /tmp/x src/x.cs', 'src/x.cs'],
  ['ln -sf', 'ln -sf /tmp/x src/x.cs', 'src/x.cs'],
  ['ln -fs into its directory', 'ln -fs /tmp/Y.cs src/App/', 'src/App/Y.cs'],
  ['ln --force --symbolic', 'ln --force --symbolic /tmp/x src/x.cs', 'src/x.cs'],
  ['ln -sf -t', 'ln -sf -t src/App /tmp/Y.cs', 'src/App/Y.cs'],
  ['ln -b', 'ln -b /tmp/x src/x.cs', 'src/x.cs'],
  ['ln -sb', 'ln -sb /tmp/x src/x.cs', 'src/x.cs'],
  ['ln --backup=numbered -s', 'ln --backup=numbered -s /tmp/x src/x.cs', 'src/x.cs'],
  ['ln -S suffix', 'ln -S .bak /tmp/x src/x.cs', 'src/x.cs'],
  ['ln -sf with only the target, in the cwd', 'cd src && ln -sf /tmp/x.cs', 'src/x.cs'],
  ['rsync', 'rsync -a /tmp/x src/x.cs', 'src/x.cs'],
  ['rsync into its directory', 'rsync -av --exclude bin /tmp/Y.cs src/App/', 'src/App/Y.cs'],
  ['rsync -e', `rsync -e 'ssh -p 22' /tmp/x src/x.cs`, 'src/x.cs'],
  ['rsync of the contents of a directory', 'rsync -a /tmp/dir/ src/', 'src/x.cs'],
  ['rsync of dir/. into a subdirectory', 'rsync -a /tmp/dir/. src/App', 'src/App/Y.cs'],
  ['rsync of the contents of a directory into the repository', 'rsync -a /tmp/dir/ .', 'tests/App.Tests/X.cs'],
  ['cp -r of dir/.', 'cp -r /tmp/dir/. src/', 'src/x.cs'],
  ['cp -a of dir/. into tests', 'cp -a /tmp/dir/. tests/', 'tests/App.Tests/X.cs'],
  ['cp -rt of dir/.', 'cp -rt src /tmp/dir/.', 'src/App/Y.cs'],
  ['truncate -s 0', 'truncate -s 0 src/x.cs', 'src/x.cs'],
  ['truncate --size=', 'truncate --size=0 /tmp/x src/x.cs', 'src/x.cs'],
  ['truncate -r', 'truncate -r /tmp/x tests/App.Tests/X.cs', 'tests/App.Tests/X.cs'],
  ['truncate -cs 0', 'truncate -cs 0 src/x.cs', 'src/x.cs'],
  ['cp -f', 'cp -f /tmp/x src/x.cs', 'src/x.cs'],
  ['cp -t', 'cp -t src/App /tmp/Y.cs', 'src/App/Y.cs'],
  ['cp -ft with the directory attached', 'cp -ftsrc/App /tmp/Y.cs', 'src/App/Y.cs'],
  ['cp --target-directory=', 'cp --target-directory=src/App /tmp/Y.cs', 'src/App/Y.cs'],
  ['cp -T', 'cp -T /tmp/x src/x.cs', 'src/x.cs'],
  ['cp --no-target-directory', 'cp --no-target-directory /tmp/x src/x.cs', 'src/x.cs'],
  ['cp -S with a suffix', 'cp --backup -S .orig /tmp/x src/x.cs', 'src/x.cs'],
  ['cp --sparse with its value', 'cp --sparse always /tmp/x src/x.cs', 'src/x.cs'],
  ['cp after --', 'cp -- /tmp/x src/x.cs', 'src/x.cs'],
  ['sudo install', 'sudo install -m 0644 /tmp/x src/x.cs', 'src/x.cs'],
  ['env mv', 'env FOO=1 mv /tmp/x src/x.cs', 'src/x.cs'],
  ['command dd', 'command dd of=src/x.cs', 'src/x.cs'],
  ['mv after a cd', 'cd src/App && mv /tmp/x Y.cs', 'src/App/Y.cs'],
  ['bash -c mv', `bash -c 'mv /tmp/x src/x.cs'`, 'src/x.cs'],
];

for (const [name, command, file] of writerForms) {
  test(`a shell edit through ${name} is refused`, t => {
    const {dir} = repo(t);
    assertShellEditDenied(decide(command, dir), file);
  });
}

// A directory copied as itself replaces the tracked files under the name it lands at.
for (const [name, command, file] of [
  ['cp -r of a directory into the repository', scratch => `cp -r ${scratch}/src .`, 'src/x.cs'],
  ['cp -a of a directory with a trailing slash', scratch => `cp -a ${scratch}/src/ .`, 'src/x.cs'],
  ['rsync -a of a directory into the repository', scratch => `rsync -a ${scratch}/src .`, 'src/x.cs'],
  ['rsync -a of a directory into ./', scratch => `rsync -a ${scratch}/src ./`, 'src/x.cs'],
  ['cp -rT of a directory onto src', scratch => `cp -rT ${scratch}/src src`, 'src/x.cs'],
  ['mv of a directory into the repository', scratch => `mv ${scratch}/src .`, 'src/x.cs'],
]) {
  test(`a shell edit through ${name} is refused`, t => {
    const {dir, scratch} = repo(t);
    assertShellEditDenied(decide(command(scratch), dir), file);
  });
}

test('a directory copied to where no tracked file lies is allowed', t => {
  const {dir, scratch} = repo(t);
  for (const command of [`cp -r ${scratch}/src docs/`, `cp -rT ${scratch}/src src/New`,
    `rsync -a ${scratch}/src src/App/`, `cp -r src ${scratch}/backup`]) {
    assert.equal(decide(command, dir), null, command);
  }
});

// The shell-edit roots come from the repository's project contract.

test('the shell-edit roots are the shellEditRoots of the project file', t => {
  const {dir} = repo(t, {contract: {name: 'sample', shellEditRoots: ['docs']}});
  assertShellEditDenied(decide(`sed -i 's/X/Z/' docs/notes.md`, dir), 'docs/notes.md');
  assert.equal(decide(`sed -i 's/X/Z/' src/x.cs`, dir), null);
  assert.equal(decide(`cat > tests/App.Tests/X.cs <<EOF\nclass Z {}\nEOF`, dir), null);
});

test('a nested shell-edit root covers only its own tree, and a tree edit of its parent reaches it', t => {
  const {dir, scratch} = repo(t, {contract: {name: 'sample', shellEditRoots: ['src/App/']}});
  assertShellEditDenied(decide(`sed -i 's/X/Z/' src/App/Y.cs`, dir), 'src/App/Y.cs');
  assert.equal(decide(`sed -i 's/X/Z/' src/x.cs`, dir), null);
  assertShellEditDenied(decide(`cp -r ${scratch}/src .`, dir), 'src/App/Y.cs');
});

test('each repository the command runs in brings its own roots, including after a cd into another one', t => {
  const docs = repo(t, {contract: {name: 'sample', shellEditRoots: ['docs']}}).dir;
  const src = repo(t).dir;
  assert.equal(decide(`sed -i 's/X/Z/' src/x.cs`, docs), null);
  assertShellEditDenied(decide(`sed -i 's/X/Z/' src/x.cs`, src), 'src/x.cs');
  assertShellEditDenied(decide(`cd ${src} && sed -i 's/X/Z/' src/x.cs`, docs), 'src/x.cs');
  assert.equal(decide(`cd ${docs} && sed -i 's/X/Z/' src/x.cs`, src), null);
});

test('a project file without shellEditRoots, or none at all, gets no shell-edit rule', t => {
  for (const contract of [null, {name: 'sample'}, {name: 'sample', shellEditRoots: []}]) {
    const {dir} = repo(t, {contract});
    assert.equal(decide(`sed -i 's/X/Z/' src/x.cs`, dir), null, JSON.stringify(contract));
    assert.equal(decide(`cp /tmp/x tests/App.Tests/X.cs`, dir), null, JSON.stringify(contract));
  }
});

test('malformed shellEditRoots or an unreadable project file allow the command', t => {
  for (const contract of ['{not json', '[]', {name: 'sample', shellEditRoots: 'src'},
    {name: 'sample', shellEditRoots: ['src', 7]}, {name: 'sample', shellEditRoots: ['src', '../outside']},
    {name: 'sample', shellEditRoots: ['/abs/src']}, {name: 'sample', shellEditRoots: ['.']},
    {name: 'sample', shellEditRoots: ['src//App']}, {name: 'sample', shellEditRoots: ['src', '']}]) {
    const {dir} = repo(t, {contract});
    assert.equal(decide(`sed -i 's/X/Z/' src/x.cs`, dir), null, JSON.stringify(contract));
  }
});

test('the same writers aimed elsewhere, reading a tracked file, or onto an untracked file are allowed', t => {
  const {dir} = repo(t);
  for (const command of [
    'mv /tmp/a /tmp/b',
    'install -m 0644 /tmp/x /tmp/y',
    'install -d src/App/New',
    'dd if=src/x.cs of=/tmp/x',
    'rsync src/ /tmp/backup/',
    'rsync -a /tmp/a/ /tmp/b/',
    'rsync -a /tmp/dir/ docs/',
    'rsync -a /tmp/dir/ src/New/',
    'cp -r /tmp/dir/. docs/',
    'cp -r src/. /tmp/backup/',
    'rsync -a src/x.cs /tmp/x.cs',
    'rsync -n /tmp/x src/x.cs',
    'rsync /tmp/x host:src/x.cs',
    'truncate -s 0 /tmp/x',
    'truncate -r src/x.cs /tmp/x',
    'ln -s src/x.cs /tmp/link',
    'ln /tmp/x src/x.cs',
    'cp -t /tmp src/x.cs',
    'mv /tmp/x src/untracked.cs',
    'install /tmp/x src/untracked.cs',
    'dd of=src/untracked.cs',
    'truncate -s 0 src/untracked.cs',
  ]) {
    assert.equal(decide(command, dir), null, command);
  }
});

// Combined flag groups and wrapper option values.
const combinedForms = [
  ['bash -lc', `bash -lc 'sed -i s/a/b/ src/x.cs'`],
  ['bash -ec', `bash -ec 'sed -i s/a/b/ src/x.cs'`],
  ['python3 -Ic', `python3 -Ic "open('src/x.cs','w').write('x')"`],
  ['python3 -c with the script attached', `python3 -c"open('src/x.cs','w').write('x')"`],
  ['sudo -u someone', 'sudo -u someone sed -i s/a/b/ src/x.cs'],
  ['nice -n 10', 'nice -n 10 sed -i s/a/b/ src/x.cs'],
];

for (const [name, command] of combinedForms) {
  test(`a shell edit through ${name} is refused`, t => {
    const {dir} = repo(t);
    assertShellEditDenied(decide(command, dir), 'src/x.cs');
  });
}

// Scripts a shell or interpreter reads from a here-string, a piped echo or printf, env -S, or after later flags.
const hiddenScripts = [
  ['a python3 here-string', script => `python3 <<< "${script.python}"`],
  ['a bash here-string', script => `bash <<< '${script.shell}'`],
  ['an echo piped into bash', script => `echo '${script.shell}' | bash`],
  ['a printf piped into sh', script => `printf '%s\\n' '${script.shell}' | sh`],
  ['an echo piped into python3', script => `echo "${script.python}" | python3 -`],
  ['env -S', script => `env -S '${script.shell}'`],
  ['env --split-string=', script => `env --split-string='${script.shell}'`],
  ['env -S with the command line attached', script => `env -S'${script.shell}'`],
  ['env -S with -i in the split string', script => `env -S '-i ${script.shell}'`],
  ['env -S with -u NAME in the attached string', script => `env -S'-u HOME ${script.shell}'`],
  ['env -S with -- in the split string', script => `env -S '-- ${script.shell}'`],
  ['env -S with a further -S in the split string', script => `env -S '-S ${script.shell}'`],
  ['bash -c -l', script => `bash -c -l '${script.shell}'`],
  ['bash -c -o pipefail', script => `bash -c -o pipefail '${script.shell}'`],
  ['bash -c -eo pipefail', script => `bash -c -eo pipefail '${script.shell}'`],
  ['bash -co pipefail', script => `bash -co pipefail '${script.shell}'`],
];

for (const [name, form] of hiddenScripts) {
  test(`a shell edit through ${name} is refused`, t => {
    const {dir} = repo(t);
    const command = form({shell: 'sed -i s/a/b/ src/x.cs', python: "open('src/x.cs','w').write('x')"});
    assertShellEditDenied(decide(command, dir), 'src/x.cs');
  });
}

for (const [name, form] of hiddenScripts.filter(([name]) => !name.includes('python3'))) {
  test(`pkill -f through ${name} is refused`, () => {
    const command = form({shell: 'pkill -f web-e2e'});
    assert.match(decide(command, tmpdir()) ?? '', /self-kill rule/, command);
  });
}

test('text piped or fed into a command that is not a shell or interpreter stays prose', t => {
  const {dir} = repo(t);
  for (const command of [`echo 'sed -i s/a/b/ src/x.cs' | grep sed`, `grep sed <<< 'sed -i s/a/b/ src/x.cs'`,
    `echo 'pkill -f web-e2e' | wc -l`, `bash -c 'echo ok' 'sed -i s/a/b/ src/x.cs'`]) {
    assert.equal(decide(command, dir), null, command);
  }
});

test('a shell edit behind a wrapper option that takes a value is refused', t => {
  const {dir} = repo(t);
  for (const command of [
    'sudo --user someone sed -i s/a/b/ src/x.cs',
    'sudo -Eu someone sed -i s/a/b/ src/x.cs',
    'sudo -g staff -- sed -i s/a/b/ src/x.cs',
    'env -u HOME sed -i s/a/b/ src/x.cs',
    'env -C . sed -i s/a/b/ src/x.cs',
    'stdbuf -o L sed -i s/a/b/ src/x.cs',
    'timeout -s KILL 5 sed -i s/a/b/ src/x.cs',
    'timeout --kill-after 2 5 sed -i s/a/b/ src/x.cs',
    'sudo -u someone nice -n 10 sed -i s/a/b/ src/x.cs',
    'env - sed -i s/a/b/ src/x.cs',
    'env -- - sed -i s/a/b/ src/x.cs',
    'env - FOO=1 sed -i s/a/b/ src/x.cs',
    'env -S sed -i s/a/b/ src/x.cs',
    'env --split-string sed -i s/a/b/ src/x.cs',
    'sudo -h sed -i s/a/b/ src/x.cs',
  ]) {
    assertShellEditDenied(decide(command, dir), 'src/x.cs');
  }
});

test('a shell edit behind a wrapper option with an attached value stays refused', t => {
  const {dir} = repo(t);
  for (const command of ['nice -n10 sed -i s/a/b/ src/x.cs', 'sudo --user=someone sed -i s/a/b/ src/x.cs',
    'sudo -usomeone sed -i s/a/b/ src/x.cs', 'stdbuf -oL sed -i s/a/b/ src/x.cs', 'nice -10 sed -i s/a/b/ src/x.cs',
    'timeout 5 sed -i s/a/b/ src/x.cs']) {
    assertShellEditDenied(decide(command, dir), 'src/x.cs');
  }
});

test('a shell flag group without c does not read its argument as a script', t => {
  const {dir} = repo(t);
  assert.equal(decide('bash -l script.sh', dir), null);
  assert.equal(decide(`bash -l 'sed -i s/a/b/ src/x.cs'`, dir), null);
  assert.equal(decide(`python3 -I "open('src/x.cs','w').write('x')"`, dir), null);
});

test('a shell edit after a reserved word, inside a group or behind ! is refused', t => {
  const {dir} = repo(t);
  for (const command of [
    `if true; then sed -i 's/a/b/' src/x.cs; fi`,
    `if false; then :; elif true; then sed -i 's/a/b/' src/x.cs; else :; fi`,
    `for i in 1 2; do sed -i 's/a/b/' src/x.cs; done`,
    `until true; do sed -i 's/a/b/' src/x.cs; done`,
    `{ sed -i 's/a/b/' src/x.cs; }`,
    `(sed -i 's/a/b/' src/x.cs)`,
    `! sed -i 's/a/b/' src/x.cs`,
    `time sed -i 's/a/b/' src/x.cs`,
    `while false; do python3 -c "open('src/x.cs','w').write('')"; done`,
  ]) {
    assertShellEditDenied(decide(command, dir), 'src/x.cs');
  }
});

test('a file-descriptor redirect neither hides the operand nor its own target', t => {
  const {dir} = repo(t);
  for (const command of ['cp /tmp/a.cs src/x.cs 2>/dev/null', 'cp /tmp/a.cs src/x.cs 2>&1',
    `sed -i 's/a/b/' src/x.cs 2>/dev/null`, 'echo hi | tee src/x.cs 2>&1 1>/dev/null', 'echo x 2> src/x.cs',
    'echo x 2>>src/x.cs', 'echo x &> src/x.cs']) {
    assertShellEditDenied(decide(command, dir), 'src/x.cs');
  }
  assert.equal(decide('cp src/x.cs /tmp/copy.cs 2>/dev/null', dir), null);
  assert.equal(decide('ls src 2>&1 | head', dir), null);
});

test('a script that writes a tracked file through a variable or a copy is refused', t => {
  const {dir} = repo(t);
  for (const command of [
    `python3 - <<'PY'\nfrom pathlib import Path\ntarget = Path('src/x.cs')\ntarget.write_text('class Z {}')\nPY`,
    `python3 - <<'PY'\np = "src/x.cs"\nwith open(p, "w") as f:\n    f.write("")\nPY`,
    `python3 -c "with open('src/x.cs', 'r+') as f: f.write('x')"`,
    `python3 -c "open('src/x.cs', mode='a').write('x')"`,
    `python3 -c "import shutil; shutil.copy('/tmp/a.cs', 'src/x.cs')"`,
    `python3 -c "import os; os.replace('/tmp/a.cs', 'src/x.cs')"`,
    `node -e "const p = 'src/x.cs'; require('fs').appendFileSync(p, 'x')"`,
    `node -e "require('fs').copyFileSync('/tmp/a.cs', 'src/x.cs')"`,
  ]) {
    assertShellEditDenied(decide(command, dir), 'src/x.cs');
  }
});

test('a script that reads a tracked file and writes somewhere else is allowed', t => {
  const {dir} = repo(t);
  for (const command of [
    `python3 - <<'PY'\nfrom pathlib import Path\ntext = Path('src/x.cs').read_text()\nPath('/tmp/report.txt').write_text(text)\nPY`,
    `python3 - <<'PY'\np = 'src/x.cs'\nprint(open(p).read())\nopen('/tmp/report.txt', 'w').write('')\nPY`,
    `python3 -c "print(open('src/x.cs', 'r').read()); open('/tmp/report.txt', 'w')"`,
    `node -e "const fs = require('fs'); fs.writeFileSync('/tmp/r.txt', fs.readFileSync('src/x.cs'))"`,
  ]) {
    assert.equal(decide(command, dir), null, command);
  }
});

test('relative paths resolve against cwd, a cd earlier in the command, or nothing for an absolute path', t => {
  const {dir, scratch} = repo(t);
  assertShellEditDenied(decide(`sed -i 's/X/Z/' App/Y.cs`, join(dir, 'src')), 'src/App/Y.cs');
  assertShellEditDenied(decide(`cd src/App && sed -i 's/X/Z/' Y.cs`, dir), 'src/App/Y.cs');
  assertShellEditDenied(decide(`sed -i 's/X/Z/' ${join(dir, 'src/x.cs')}`, dir), 'src/x.cs');
  assertShellEditDenied(decide(`cd ${dir} && sed -i 's/X/Z/' src/x.cs`, scratch), 'src/x.cs');
});

// Allowed shell edits.

for (const command of editsOf('docs/notes.md')) {
  test(`the same edit on a tracked docs/ file is allowed: ${command.split('\n')[0]}`, t => {
    assert.equal(decide(command, repo(t).dir), null);
  });
}

for (const command of editsOf('src/untracked.cs')) {
  test(`the same edit on an untracked src/ file is allowed: ${command.split('\n')[0]}`, t => {
    assert.equal(decide(command, repo(t).dir), null);
  });
}

test('the same edits on a scratchpad path outside the repository are allowed', t => {
  const {dir, scratch} = repo(t);
  for (const command of editsOf(join(scratch, 'src', 'x.cs'))) assert.equal(decide(command, dir), null, command);
  for (const command of editsOf('src/x.cs')) assert.equal(decide(command, scratch), null, command);
});

test('a heredoc pull request body that mentions sed -i src/x.cs is allowed', t => {
  const {dir} = repo(t);
  const body = `Refuses \`sed -i 's/X/Z/' src/x.cs\`, \`cat > src/x.cs\` and python3 write_text("src/x.cs").`;
  assert.equal(decide(`gh pr create --title "Guard" --body "$(cat <<'EOF'\n${body}\nEOF\n)"`, dir), null);
  assert.equal(decide(`gh pr create --title "Guard" --body-file - <<'EOF'\n${body}\nEOF`, dir), null);
  assert.equal(decide(`git commit -m "Refuse sed -i src/x.cs > src/x.cs"`, dir), null);
});

test('reading a tracked src/ file through the shell is allowed', t => {
  const {dir} = repo(t);
  for (const command of [`sed -n '1,5p' src/x.cs`, 'cat src/x.cs > /dev/null 2>&1', 'cp src/x.cs /tmp/copy.cs',
    `grep ">" src/x.cs`, `python3 - <<'PY'\nprint(open("src/x.cs").read())\nPY`]) {
    assert.equal(decide(command, dir), null, command);
  }
});

// The self-kill rule.

test('pkill -f with a plain pattern is refused with the rule, the bracket form, a saved PID and kill %1', () => {
  const reason = decide('pkill -f web-e2e', tmpdir());
  assert.ok(reason, 'expected a deny');
  assert.match(reason, /self-kill rule/);
  assert.ok(reason.includes(`pkill -f '[w]eb-e2e'`), reason);
  assert.match(reason, /kill "\$pid"/);
  assert.match(reason, /kill %1/);
  assert.match(reason, /# guard-override: <reason>/);
});

test('pgrep -f with a quoted plain pattern is refused', () => {
  const reason = decide('pgrep -f "dotnet test"', tmpdir());
  assert.ok(reason, 'expected a deny');
  assert.match(reason, /self-kill rule/);
  assert.ok(reason.includes(`pgrep -f '[d]otnet test'`), reason);
});

test('pkill -9f, a signal and -f in one group, is refused', () => {
  const reason = decide('pkill -9f dotnet', tmpdir());
  assert.ok(reason, 'expected a deny');
  assert.match(reason, /self-kill rule/);
  assert.ok(reason.includes(`pkill -f '[d]otnet'`), reason);
  assert.match(reason, /# guard-override: <reason>/);
});

test('pkill -f inside a longer command is refused', () => {
  assert.match(decide('scripts/web-e2e.sh & sleep 5; sudo pkill -9 -f "dotnet run" || true', tmpdir()) ?? '',
    /self-kill rule/);
});

test('pkill -f or pgrep -f after a reserved word is refused', () => {
  for (const command of ['if true; then pkill -f web-e2e; fi', 'while pgrep -f web-e2e; do sleep 1; done',
    '{ pkill -f web-e2e; }', 'until ! pgrep -f web-e2e; do sleep 1; done']) {
    assert.match(decide(command, tmpdir()) ?? '', /self-kill rule/, command);
  }
});

test('pkill -f with a bracket pattern, and pkill without -f, are allowed', () => {
  assert.equal(decide(`pkill -f '[w]eb-e2e'`, tmpdir()), null);
  assert.equal(decide(`pgrep -af "[d]otnet test"`, tmpdir()), null);
  assert.equal(decide('pkill dotnet', tmpdir()), null);
  assert.equal(decide('pkill -9 dotnet', tmpdir()), null);
  assert.equal(decide(`git commit -m "Stop using pkill -f web-e2e"`, tmpdir()), null);
});

// kill of the shell, the session or one of its parents. The hook's parent here is this test process.
const selfKills = [
  ['kill "$PPID"', /Claude Code session/],
  ['kill $PPID', /Claude Code session/],
  ['kill -9 ${PPID}', /Claude Code session/],
  ['kill $$', /shell running the command/],
  ['kill -TERM "${$}"', /shell running the command/],
  ['kill -s KILL $PPID', /Claude Code session/],
  ['kill -n 9 $PPID', /Claude Code session/],
  ['kill --signal TERM $$', /shell running the command/],
  ['kill -- -$$', /shell running the command/],
  ['sudo kill -9 $PPID', /Claude Code session/],
  [`kill ${process.pid}`, new RegExp(`process ${process.pid}, the Claude Code session or one of its parents`)],
  [`kill -9 ${process.ppid}`, new RegExp(`process ${process.ppid}`)],
  [`bash -c 'kill -HUP ${process.pid}'`, new RegExp(`process ${process.pid}`)],
];

for (const [command, process_] of selfKills) {
  test(`${command} is refused with the rule, a saved PID, kill %1 and the override token`, () => {
    const reason = decide(command, tmpdir());
    assert.ok(reason, 'expected a deny');
    assert.match(reason, /self-kill rule/);
    assert.match(reason, process_);
    assert.match(reason, /kill "\$pid"/);
    assert.match(reason, /kill %1/);
    assert.match(reason, /# guard-override: <reason>/);
  });
}

test('kill of a PID outside the session, a job or a saved PID is allowed', () => {
  const other = spawnSync('true').pid;  // exited, and never a parent of the hook
  for (const command of [`kill ${other}`, `kill -9 ${other}`, 'kill %1', 'kill "$pid"', 'kill -l', `kill '$PPID'`,
    `git commit -m "Refuse kill $PPID"`]) {
    assert.equal(decide(command, tmpdir()), null, command);
  }
});

// Changes to Triphammer's persistence. Each test runs the hook with a throwaway HOME and none of the variables that move
// Triphammer's directories, so nothing depends on the real home directory; machineHome sets those it is given.
function machineHome(t, vars = {}) {
  const home = mkdtempSync(join(tmpdir(), 'agent-guard-home-'));
  t.after(() => rmSync(home, {recursive: true, force: true}));
  const env = {...process.env, HOME: home};
  for (const name of ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'TRIPHAMMER_SHARED_DIR']) delete env[name];
  Object.assign(env, vars);
  return {home, env, cwd: home};
}

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

// A Triphammer config may move the ticket runner's state directory anywhere.
function configuredSetup(t, conf) {
  const elsewhere = mkdtempSync(join(tmpdir(), 'agent-guard-conf-'));
  t.after(() => rmSync(elsewhere, {recursive: true, force: true}));
  const config = join(elsewhere, 'config');
  mkdirSync(join(config, 'triphammer'), {recursive: true});
  const state = join(elsewhere, 'state', 'ticket-runner');
  if (conf !== null) writeFileSync(join(config, 'triphammer', 'p.conf'), conf(state));
  return {...machineHome(t, {XDG_CONFIG_HOME: config}), state};
}

const validConf = state =>
  `# example-project\nREPO=owner/name\nCHECKOUT=/opt/checkout\nAPP_AUTHOR=app/agents\nSTATE_DIR=${state}\n`;

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

// The file tools under the persistence rule.

function assertFilePersistenceDenied(reason, path) {
  assert.ok(reason, `expected a deny: ${path}`);
  assert.match(reason, /persistence rule/);
  assert.match(reason, /the owner does that/);
  assert.match(reason, /# guard-override: <reason>/);
  assert.match(reason, /only to Bash commands/);
}

const fileTools = Object.keys(fileInputs);

test('a Write, Edit or NotebookEdit under each persistence directory is refused, without an override', t => {
  const {home, env, cwd, state} = configuredSetup(t, validConf);
  const elsewhere = mkdtempSync(join(tmpdir(), 'agent-guard-shared-'));
  t.after(() => rmSync(elsewhere, {recursive: true, force: true}));
  const config = env.XDG_CONFIG_HOME;
  const paths = [
    join(home, '.local/bin/triphammer-write-probe'),
    join(home, '.config/systemd/user/ticket-runner@p.timer'),
    join(home, '.config/triphammer/p.conf'),
    join(config, 'systemd/user/x.service'),
    join(config, 'triphammer/other.conf'),
    join(home, '.local/state/ticket-runner/write-probe'),
    join(home, '.local/state/triphammer/stop'),
    join(state, 'security-reviewed'),
    join(state, 'attempts', 'new', 'n.ipynb'),
    state,
  ];
  for (const tool of fileTools) {
    for (const path of paths) assertFilePersistenceDenied(decideFile(tool, path, cwd, {env}), `${tool} ${path}`);
    assertFilePersistenceDenied(decideFile(tool, '.local/bin/relative', home, {env}), `${tool} relative`);
    const sharedDir = {...env, TRIPHAMMER_SHARED_DIR: join(elsewhere, 'shared')};
    assertFilePersistenceDenied(decideFile(tool, join(elsewhere, 'shared', 'stop'), cwd, {env: sharedDir}), `${tool} shared dir`);
  }
});

// A machine installed the way bin/README.md says: ~/.local/bin/ticket-runner links to the main checkout's script.
function linkedSetup(t) {
  const machine = machineHome(t);
  const main = join(machine.home, 'main');
  const worktree = join(machine.home, 'main', '.worktrees', 'issue-1');
  for (const dir of [join(main, 'bin'), join(worktree, 'bin'), join(machine.home, '.local/bin'),
    join(machine.home, '.local/state/ticket-runner')]) {
    mkdirSync(dir, {recursive: true});
  }
  writeFileSync(join(main, 'bin/ticket-runner'), '#!/bin/sh\n');
  writeFileSync(join(main, 'bin/config.sh'), '');
  writeFileSync(join(worktree, 'bin/ticket-runner'), '#!/bin/sh\n');
  symlinkSync(join(main, 'bin/ticket-runner'), join(machine.home, '.local/bin/ticket-runner'));
  return {...machine, main, worktree};
}

test('a file tool writing through a Triphammer symlink, or to the file it points to, is refused; another worktree is not',
  t => {
    const {home, env, main, worktree} = linkedSetup(t);
    for (const tool of fileTools) {
      assertFilePersistenceDenied(decideFile(tool, join(home, '.local/bin/ticket-runner'), worktree, {env}), tool);
      assertFilePersistenceDenied(decideFile(tool, join(main, 'bin/ticket-runner'), main, {env}), tool);
      assertFilePersistenceDenied(decideFile(tool, 'bin/ticket-runner', main, {env}), tool);
      assert.equal(decideFile(tool, join(worktree, 'bin/ticket-runner'), worktree, {env}), null, tool);
    }
  });

// The ticket runner also sources, runs, links or loads the other files of Triphammer's checkout (its scripts, units,
// status page, commit hooks and plugin), so its bin, systemd, status, scripts and plugins/triphammer are protected
// whether a Triphammer config's CHECKOUT or a ~/.local/bin link names it.
function checkoutSetups(t) {
  const linked = linkedSetup(t);
  const configured = machineHome(t);
  const main = join(configured.home, 'checkout');
  const worktree = join(main, '.worktrees', 'issue-1');
  mkdirSync(join(worktree, 'src'), {recursive: true});
  mkdirSync(join(main, 'bin'), {recursive: true});
  writeFileSync(join(main, 'bin/config.sh'), '');
  mkdirSync(join(configured.home, '.config/triphammer'), {recursive: true});
  writeFileSync(join(configured.home, '.config/triphammer/p.conf'),
    `REPO=owner/name\nCHECKOUT=${main}\nAPP_AUTHOR=app/agents\nSTATE_DIR=${join(configured.home, 'state')}\n`);
  return [linked, {...configured, main, worktree}];
}

test('a file tool writing the files of Triphammer\'s main checkout is refused; a worktree and other files are not',
  t => {
    for (const {env, main, worktree} of checkoutSetups(t)) {
      for (const tool of fileTools) {
        for (const file of ['bin/config.sh', 'bin/update-checkout', 'systemd/ticket-runner@.service',
          'status/server.mjs', 'scripts/git-hooks/commit-msg', 'scripts/land-pr.sh',
          'plugins/triphammer/hooks/hooks.json', 'plugins/triphammer/hooks/agent-guard.py']) {
          assertFilePersistenceDenied(decideFile(tool, join(main, file), worktree, {env}), `${tool} ${main} ${file}`);
          assertFilePersistenceDenied(decideFile(tool, file, main, {env}), `${tool} ${main} relative ${file}`);
          assert.equal(decideFile(tool, join(worktree, file), worktree, {env}), null, `${tool} ${worktree} ${file}`);
          assert.equal(decideFile(tool, file, worktree, {env}), null, `${tool} ${worktree} relative ${file}`);
        }
        for (const file of ['src/x.cs', 'bins/x', 'systemdx/x', 'plugins/other/x', 'README.md']) {
          assert.equal(decideFile(tool, join(main, file), main, {env}), null, `${tool} ${main} ${file}`);
        }
      }
    }
  });

test('a CHECKOUT that is not Triphammer\'s checkout, such as a project\'s, protects none of its files', t => {
  const {home, env, cwd} = machineHome(t);
  const project = join(home, 'project');
  mkdirSync(join(project, 'scripts'), {recursive: true});
  mkdirSync(join(home, '.config/triphammer'), {recursive: true});
  writeFileSync(join(home, '.config/triphammer/p.conf'), `CHECKOUT=${project}\n`);
  for (const file of ['bin/x', 'systemd/x.service', 'status/x', 'scripts/x.sh', 'plugins/triphammer/x']) {
    assert.equal(decideFile('Write', join(project, file), cwd, {env}), null, file);
  }
});

test('a ~/.local/bin link into a systemd or status directory protects that checkout only when it is Triphammer\'s', t => {
  const {home, env, cwd} = machineHome(t);
  const triphammer = join(home, 'triphammer');
  const other = join(home, 'other');
  for (const dir of [join(triphammer, 'bin'), join(triphammer, 'status'), join(other, 'status'), join(home, '.local/bin')]) {
    mkdirSync(dir, {recursive: true});
  }
  writeFileSync(join(triphammer, 'bin/config.sh'), '');
  writeFileSync(join(triphammer, 'status/server.mjs'), '');
  writeFileSync(join(other, 'status/server.mjs'), '');
  symlinkSync(join(triphammer, 'status/server.mjs'), join(home, '.local/bin/triphammer-status'));
  symlinkSync(join(other, 'status/server.mjs'), join(home, '.local/bin/other-status'));
  for (const file of ['bin/ticket-runner', 'systemd/ticket-runner@.timer', 'scripts/land-pr.sh']) {
    assertFilePersistenceDenied(decideFile('Write', join(triphammer, file), cwd, {env}), file);
    assert.equal(decideFile('Write', join(other, file), cwd, {env}), null, `other ${file}`);
  }
});

test('a Triphammer config\'s relative CHECKOUT protects no checkout', t => {
  const {home, env, cwd} = machineHome(t);
  mkdirSync(join(home, '.config/triphammer'), {recursive: true});
  writeFileSync(join(home, '.config/triphammer/p.conf'), 'CHECKOUT=checkout\n');
  assert.equal(decideFile('Write', join(home, 'checkout/bin/config.sh'), cwd, {env}), null);
});

test('a file tool path that reaches a persistence directory through a symlinked directory is refused', t => {
  const {home, env, worktree} = linkedSetup(t);
  symlinkSync(join(home, '.local/state/ticket-runner'), join(worktree, 'state'));
  symlinkSync(join(home, '.local'), join(worktree, 'local'));
  for (const tool of fileTools) {
    for (const path of [join(worktree, 'state', 'stop'), join(worktree, 'state', 'not', 'yet', 'there'),
      join(worktree, 'local', 'bin', 'new-script'), 'local/state/ticket-runner/current']) {
      assertFilePersistenceDenied(decideFile(tool, path, worktree, {env}), `${tool} ${path}`);
    }
  }
});

test('a file tool writing in the working directory, scratch locations or beside Triphammer is allowed', t => {
  const {home, env, worktree} = linkedSetup(t);
  const scratch = mkdtempSync(join(tmpdir(), 'agent-guard-scratch-'));
  t.after(() => rmSync(scratch, {recursive: true, force: true}));
  for (const tool of fileTools) {
    for (const path of [join(worktree, 'notes.md'), 'src/new/File.cs', join(scratch, 'x.ipynb'), '/tmp/agent-guard-x',
      join(home, '.local/binder'), join(home, '.local/state/other/x'), join(home, '.config/other/x')]) {
      assert.equal(decideFile(tool, path, worktree, {env}), null, `${tool} ${path}`);
    }
  }
});

// Sessions Triphammer started ($TRIPHAMMER_SESSION names the run's worktree) write only inside that worktree and
// the temporary directories. The temporary directories are always allowed, so each fixture lives under the
// repository's ignored artifacts/ instead: a main checkout with the run's worktree in .worktrees, a HOME, a $TMPDIR
// and a directory elsewhere. A repository that itself lies under a temporary directory cannot hold one.
const sandboxRoot = join(import.meta.dirname, '..', '..', '..', 'artifacts');
const sandboxInTemp = ['/tmp', '/var/tmp', tmpdir()].some(dir => {
  const real = realpathSync(dir);
  const root = realpathSync(join(import.meta.dirname, '..', '..', '..'));
  return root === real || root.startsWith(`${real}/`);
});

function triphammerSession(t, marker) {
  if (sandboxInTemp) {
    t.skip('the repository lies under a temporary directory, which a Triphammer session may always write');
    return null;
  }
  mkdirSync(sandboxRoot, {recursive: true});
  const base = realpathSync(mkdtempSync(join(sandboxRoot, 'agent-guard-')));
  t.after(() => rmSync(base, {recursive: true, force: true}));
  const checkout = join(base, 'checkout');
  const worktree = join(checkout, '.worktrees', 'issue-7');
  const home = join(base, 'home');
  const temp = join(base, 'tmp');
  const elsewhere = join(base, 'elsewhere');
  for (const dir of [join(worktree, 'src'), join(checkout, '.git', 'worktrees', 'issue-7'), join(checkout, 'bin'),
    join(home, '.ssh'), join(home, '.claude'), temp, elsewhere]) {
    mkdirSync(dir, {recursive: true});
  }
  writeFileSync(join(worktree, '.git'), `gitdir: ${join(checkout, '.git', 'worktrees', 'issue-7')}\n`);
  writeFileSync(join(worktree, 'src/x.cs'), 'class X {}\n');
  writeFileSync(join(home, '.bashrc'), '# bashrc\n');
  const env = {...process.env, HOME: home, TMPDIR: temp, TRIPHAMMER_SESSION: marker ?? worktree};
  for (const name of ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'TRIPHAMMER_SHARED_DIR']) delete env[name];
  return {base, checkout, worktree, home, temp, elsewhere, env};
}

function assertOutsideDenied(reason, what, {file = false} = {}) {
  assert.ok(reason, `expected a deny: ${what}`);
  assert.match(reason, /worktree-only rule/, what);
  assert.match(reason, /\$TMPDIR, \/tmp and \/var\/tmp/, what);
  if (file) assert.match(reason, /a file tool has no override/, what);
  else assert.match(reason, /# guard-override: <reason>/, what);
}

// A deny by the named rule that a command's `# guard-override:` lets through.
function assertRuleDenied(reason, rule, what) {
  assert.ok(reason, `expected a deny: ${what}`);
  assert.match(reason, new RegExp(`${rule} rule`), what);
  assert.match(reason, /# guard-override: <reason>/, what);
}

// Places outside the session's worktree and temporary directories, relative to a triphammerSession.
const outsidePlaces = s => [
  join(s.home, '.bashrc'), join(s.home, '.profile'), join(s.home, '.claude/settings.json'),
  join(s.home, '.ssh/authorized_keys'), join(s.home, '.config/autostart/x.desktop'), join(s.checkout, 'README.md'),
  join(s.checkout, 'bin/new-script'), join(s.checkout, '.git/config'),
  join(s.checkout, '.git/worktrees/issue-7/config'), join(s.worktree, '.git'), join(s.elsewhere, 'x', 'y'),
  join(s.worktree, '..', 'issue-8', 'x'),
];

test('in a Triphammer session a file tool writing outside its worktree and temporary directories is refused', t => {
  const s = triphammerSession(t);
  if (!s) return;
  for (const tool of fileTools) {
    for (const path of outsidePlaces(s)) {
      assertOutsideDenied(decideFile(tool, path, s.worktree, {env: s.env}), `${tool} ${path}`, {file: true});
    }
    assertOutsideDenied(decideFile(tool, '../../README.md', s.worktree, {env: s.env}), `${tool} relative`,
      {file: true});
  }
});

test('in a Triphammer session a file tool writes inside its worktree, $TMPDIR, /tmp and /var/tmp', t => {
  const s = triphammerSession(t);
  if (!s) return;
  for (const tool of fileTools) {
    for (const path of [join(s.worktree, 'src/x.cs'), join(s.worktree, 'src/new/dir/File.cs'), 'docs/notes.md',
      join(s.temp, 'scratch.md'), '/tmp/agent-guard-x/y', '/var/tmp/agent-guard-x', s.worktree]) {
      assert.equal(decideFile(tool, path, s.worktree, {env: s.env}), null, `${tool} ${path}`);
    }
  }
});

test('in a Triphammer session a path inside the worktree that a symlink leads outside is refused', t => {
  const s = triphammerSession(t);
  if (!s) return;
  symlinkSync(s.home, join(s.worktree, 'home'));
  symlinkSync(join(s.home, '.bashrc'), join(s.worktree, 'rc'));
  symlinkSync(join(s.home, '.bashrc'), join(s.temp, 'rc'));
  const linked = [join(s.worktree, 'home/.bashrc'), join(s.worktree, 'home/new/file'), join(s.worktree, 'rc'),
    join(s.temp, 'rc')];
  for (const tool of fileTools) {
    for (const path of linked) {
      assertOutsideDenied(decideFile(tool, path, s.worktree, {env: s.env}), `${tool} ${path}`, {file: true});
    }
  }
  for (const command of ['echo x > home/.bashrc', 'echo x >> rc', 'cp a.txt home/.profile', 'touch home/.ssh/x',
    `sed -i 's/a/b/' rc`, `echo x | tee ${join(s.temp, 'rc')}`]) {
    assertOutsideDenied(decide(command, s.worktree, {env: s.env}), command);
  }
});

// Each shell writer, aimed at a target (outside or inside); the targets it names are the ones checked.
const shellWriters = target => [
  `echo x > ${target}`, `echo x >> ${target}`, `echo x &> ${target}`, `echo x | tee -a ${target}`,
  `cp src/x.cs ${target}`, `mv src/x.cs ${target}`, `ln -s src/x.cs ${target}`, `ln -sf src/x.cs ${target}`,
  `install -m 755 src/x.cs ${target}`, `rm -f ${target}`, `rm -rf ${target}`, `chmod +x ${target}`,
  `chown "$USER" ${target}`, `touch ${target}`, `mkdir -p ${target}`, `sed -i 's/a/b/' ${target}`,
  `sed -i -e 's/a/b/' ${target}`, `truncate -s 0 ${target}`,
];

test('in a Triphammer session a shell write outside its worktree and temporary directories is refused, naming the override',
  t => {
    const s = triphammerSession(t);
    if (!s) return;
    for (const target of outsidePlaces(s)) {
      for (const command of shellWriters(target)) {
        assertOutsideDenied(decide(command, s.worktree, {env: s.env}), command);
      }
    }
    for (const command of ['echo x > ~/.bashrc', 'echo x >> "$HOME/.profile"', 'mv ~/.ssh/config src/',
      'mv src/x.cs ../../elsewhere.cs', 'rm -rf ../../tools', 'cd .. && touch issue-8/x', 'cp -t ~ src/x.cs']) {
      assertOutsideDenied(decide(command, s.worktree, {env: s.env}), command);
    }
  });

test('in a Triphammer session a shell write inside its worktree, $TMPDIR, /tmp, /var/tmp or a device is allowed', t => {
  const s = triphammerSession(t);
  if (!s) return;
  for (const target of ['src/y.cs', join(s.worktree, 'artifacts/run/log.txt'), join(s.temp, 'out'),
    '/tmp/agent-guard-out', '/var/tmp/agent-guard-out']) {
    for (const command of shellWriters(target)) {
      assert.equal(decide(command, s.worktree, {env: s.env}), null, command);
    }
  }
  for (const command of ['dotnet build Example.slnx 2>&1 | tail -5', 'npm ci > /dev/null', 'npx playwright test',
    'git commit -q -m "Fix the thing" 2>/dev/null', 'git fetch origin', 'git worktree add ../issue-8 origin/main',
    `cp ${join(s.home, '.bashrc')} src/`, 'cat ~/.bashrc', 'echo x >&2', 'echo x | tee /dev/stderr',
    `sed -i '/^class/d' src/x.cs`, 'cd /tmp && echo x > agent-guard-relative', 'ln -s ../src/x.cs src/rc-link',
    'rm -rf src/new && mkdir -p src/new']) {
    assert.equal(decide(command, s.worktree, {env: s.env}), null, command);
  }
});

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
