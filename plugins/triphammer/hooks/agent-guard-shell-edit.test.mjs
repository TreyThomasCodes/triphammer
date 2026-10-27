// agent-guard.py: Shell edits of tracked files under the project's shell-edit roots.
import test from 'node:test';
import assert from 'node:assert/strict';
import {tmpdir} from 'node:os';
import {join, resolve, relative} from 'node:path';
import {python, decide, repo, pyEdit, editsOf, assertShellEditDenied} from './agent-guard-fixture.mjs';

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

test('a <<WORD inside quotes, a comment or $(( )) does not hide the command after it', t => {
  const {dir} = repo(t);
  const edit = `sed -i 's/X/Z/' src/x.cs`;
  for (const command of [
    `git commit -m "Read <<EOF\nbodies" && ${edit}`,
    `gh pr create -t 'Adds x' -b 'Reads <<EOF heredocs\n\nCloses #1'\n${edit}`,
    `git commit -m "Read $(echo '<<EOF')\nbodies"; ${edit}`,
    `# reads <<EOF\n${edit}`,
    `echo $((1<<X))\n${edit}`,
  ]) {
    assertShellEditDenied(decide(command, dir), 'src/x.cs');
  }
  // the body starts after the newline that closes the quote, so the line in it is text
  const after = `git commit -F - <<EOF; echo "a\nb"\n${edit}\nEOF`;
  assert.equal(decide(after, dir), null);
  assertShellEditDenied(decide(`${after}\n${edit}`, dir), 'src/x.cs');
});

test('a real heredoc body is text and the lines after its terminator are commands', t => {
  const {dir} = repo(t);
  const edit = `sed -i 's/X/Z/' src/x.cs`;
  for (const heredoc of [
    `cat <<EOF\n${edit}\nEOF`,
    `cat <<'EOF'\n${edit}\nEOF`,
    `cat <<"EOF"\n${edit}\nEOF`,
    `cat <<-EOF\n\t${edit}\n\tEOF`,
    `cat <<A <<'B'\n${edit}\nA\n${edit}\nB`,
  ]) {
    assert.equal(decide(heredoc, dir), null, heredoc);
    assertShellEditDenied(decide(`${heredoc}\n${edit}`, dir), 'src/x.cs');
  }
});

test('reading a tracked src/ file through the shell is allowed', t => {
  const {dir} = repo(t);
  for (const command of [`sed -n '1,5p' src/x.cs`, 'cat src/x.cs > /dev/null 2>&1', 'cp src/x.cs /tmp/copy.cs',
    `grep ">" src/x.cs`, `python3 - <<'PY'\nprint(open("src/x.cs").read())\nPY`]) {
    assert.equal(decide(command, dir), null, command);
  }
});
