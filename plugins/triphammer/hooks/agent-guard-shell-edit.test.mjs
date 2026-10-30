// agent-guard.py: Shell edits of tracked files under the project's shell-edit roots.
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {decide, repo, editsOf, assertShellEditDenied} from './agent-guard-fixture.mjs';

// Refused shell edits.

test('sed -i on a tracked src/ file is refused with the rule, the fix and the override token', t => {
  const {dir} = repo(t);
  assertShellEditDenied(decide(`sed -i 's/X/Z/' src/x.cs`, dir), 'src/x.cs');
});

test('cat > a tracked tests/ file from a heredoc is refused', t => {
  const {dir} = repo(t);
  assertShellEditDenied(decide(`cat > tests/App.Tests/X.cs <<EOF\nclass Z {}\nEOF`, dir), 'tests/App.Tests/X.cs');
});

for (const [name, command, file] of [
  ['an append redirect', 'echo "// x" >> src/x.cs', 'src/x.cs'],
  ['a stderr redirect', 'echo x 2> src/x.cs', 'src/x.cs'],
  ['tee', 'echo hi | tee -a src/x.cs', 'src/x.cs'],
  ['sed -i with a backup suffix', `sed -i.bak 's/X/Z/' src/x.cs`, 'src/x.cs'],
  ['sed -i -e', `sed -i -e 's/X/Z/' tests/App.Tests/X.cs`, 'tests/App.Tests/X.cs'],
  ['cp onto the file', 'cp /etc/hostname src/App/Y.cs', 'src/App/Y.cs'],
  ['cp into its directory', 'cp /elsewhere/Y.cs src/App/', 'src/App/Y.cs'],
  ['cp -t', 'cp -t src/App /tmp/Y.cs', 'src/App/Y.cs'],
  ['mv', 'mv /tmp/x src/x.cs', 'src/x.cs'],
  ['mv into its directory', 'mv -f /tmp/Y.cs src/App', 'src/App/Y.cs'],
  ['sudo', 'sudo -u someone sed -i s/a/b/ src/x.cs', 'src/x.cs'],
  ['env', 'env -u HOME FOO=1 sed -i s/a/b/ src/x.cs', 'src/x.cs'],
  ['timeout', 'timeout -s KILL 5 sed -i s/a/b/ src/x.cs', 'src/x.cs'],
  ['time', 'time sed -i s/a/b/ src/x.cs', 'src/x.cs'],
  ['a reserved word', `if true; then sed -i 's/a/b/' src/x.cs; fi`, 'src/x.cs'],
  ['a subshell', `(sed -i 's/a/b/' src/x.cs)`, 'src/x.cs'],
]) {
  test(`a shell edit through ${name} is refused`, t => {
    const {dir} = repo(t);
    assertShellEditDenied(decide(command, dir), file);
  });
}

test('an absolute path to a tracked file is refused', t => {
  const {dir} = repo(t);
  assertShellEditDenied(decide(`sed -i 's/X/Z/' ${join(dir, 'src/x.cs')}`, dir), 'src/x.cs');
});

test('a relative path resolves against cwd, and one after a cd is not judged', t => {
  const {dir} = repo(t);
  assertShellEditDenied(decide(`sed -i 's/X/Z/' App/Y.cs`, join(dir, 'src')), 'src/App/Y.cs');
  assert.equal(decide(`cd src/App && sed -i 's/X/Z/' Y.cs`, dir), null);
});

// The shell-edit roots come from the repository's project contract.

test('the shell-edit roots are the shellEditRoots of the project file', t => {
  const {dir} = repo(t, {contract: {name: 'sample', shellEditRoots: ['docs']}});
  assertShellEditDenied(decide(`sed -i 's/X/Z/' docs/notes.md`, dir), 'docs/notes.md');
  assert.equal(decide(`sed -i 's/X/Z/' src/x.cs`, dir), null);
  assert.equal(decide(`cat > tests/App.Tests/X.cs <<EOF\nclass Z {}\nEOF`, dir), null);
});

test('a nested shell-edit root covers only its own tree', t => {
  const {dir} = repo(t, {contract: {name: 'sample', shellEditRoots: ['src/App/']}});
  assertShellEditDenied(decide(`sed -i 's/X/Z/' src/App/Y.cs`, dir), 'src/App/Y.cs');
  assert.equal(decide(`sed -i 's/X/Z/' src/x.cs`, dir), null);
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

test('the same writers aimed elsewhere, reading a tracked file, removing it or onto an untracked file are allowed', t => {
  const {dir} = repo(t);
  for (const command of [
    'mv /tmp/a /tmp/b',
    'cp -t /tmp src/x.cs',
    'cp src/x.cs /tmp/copy.cs 2>/dev/null',
    'ln -s src/x.cs /tmp/link',
    'rm src/x.cs',
    'mv src/x.cs src/moved.cs',
    'mv /tmp/x src/untracked.cs',
    `sed -n '1,5p' src/x.cs`,
    'cat src/x.cs > /dev/null 2>&1',
    `grep ">" src/x.cs`,
    'ls src 2>&1 | head',
  ]) {
    assert.equal(decide(command, dir), null, command);
  }
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

// Heredoc bodies and quoted arguments are text.

test('a heredoc pull request body that mentions sed -i src/x.cs is allowed', t => {
  const {dir} = repo(t);
  const body = `Refuses \`sed -i 's/X/Z/' src/x.cs\` and \`cat > src/x.cs\`.`;
  assert.equal(decide(`gh pr create --title "Guard" --body "$(cat <<'EOF'\n${body}\nEOF\n)"`, dir), null);
  assert.equal(decide(`gh pr create --title "Guard" --body-file - <<'EOF'\n${body}\nEOF`, dir), null);
  assert.equal(decide(`git commit -m "Refuse sed -i src/x.cs > src/x.cs"`, dir), null);
  assert.equal(decide(`echo 'sed -i s/a/b/ src/x.cs' | grep sed`, dir), null);
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
