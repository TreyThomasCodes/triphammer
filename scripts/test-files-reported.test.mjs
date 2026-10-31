import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {toolingEnv} from './test-git-repo.mjs';

const reporter = join(import.meta.dirname, 'test-files-reported.mjs');
// The runner marks its own test processes with NODE_TEST_CONTEXT; a nested run without it acts as a runner again.
const {NODE_TEST_CONTEXT, ...env} = toolingEnv;
const passing = `import test from 'node:test';\ntest('one', () => {});\ntest('two', () => {});\n`;

// Writes `files` (name -> content) to a temporary directory and runs `node --test` there on them, with `flags`, the
// spec reporter on stdout and test-files-reported on stderr, as `npm run test:node` does.
function runTests(t, files, flags = []) {
  const dir = mkdtempSync(join(tmpdir(), 'test-files-reported-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return spawnSync(process.execPath, ['--test', ...flags, '--test-reporter=spec', '--test-reporter-destination=stdout',
    `--test-reporter=${reporter}`, '--test-reporter-destination=stderr', ...Object.keys(files)],
  {cwd: dir, env, encoding: 'utf8'});
}

test('a run whose every file reports passes and the reporter writes nothing', t => {
  const {status, stdout, stderr} = runTests(t, {'a.test.mjs': passing, 'b.test.mjs': passing});
  assert.equal(status, 0, stdout + stderr);
  assert.equal(stderr, '');
});

test('a file whose process ends mid-run and a file with no tests fail the run, by name', t => {
  const {status, stdout, stderr} = runTests(t, {
    'a.test.mjs': passing,
    'cut.test.mjs': `import test from 'node:test';\ntest('one', () => {});\ntest('ends', () => process.exit(0));\ntest('three', () => {});\n`,
    'empty.test.mjs': '',
  });
  assert.equal(status, 1, stdout + stderr);
  assert.match(stderr, /reported no summary[^\n]*\n {2}cut\.test\.mjs\n {2}empty\.test\.mjs\n$/);
});

test('with --test-shard, only the files in the shard must report', t => {
  const files = {'a.test.mjs': passing, 'b.test.mjs': ''};
  const first = runTests(t, files, ['--test-shard=1/2']);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const second = runTests(t, files, ['--test-shard=2/2']);
  assert.equal(second.status, 1, second.stdout + second.stderr);
  assert.match(second.stderr, /\n {2}b\.test\.mjs\n$/);
});
