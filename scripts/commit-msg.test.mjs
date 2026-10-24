import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {gitRepo} from './test-git-repo.mjs';

const hooks = join(import.meta.dirname, 'git-hooks');
const trailer = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';

// A throwaway repository whose commits run this branch's hooks, with an editor (git runs it in the repository) that
// writes the text in .git/typed above what git put in the file (its comments, and the diff of -v).
function repo(t) {
  const {dir, git, commit} = gitRepo(t, 'commit-msg', {GIT_EDITOR: '.git/editor'});
  git('config', 'core.hooksPath', hooks);
  writeFileSync(join(dir, '.git', 'editor'), '#!/bin/sh\ncat .git/typed "$1" > "$1.new" && mv "$1.new" "$1"\n', {mode: 0o755});
  return {
    dir, git,
    commit: (file, ...args) => commit({[file]: `${file}\n`}, ...args),
    type: text => writeFileSync(join(dir, '.git', 'typed'), text),
    message: (rev = 'HEAD') => git('log', '-1', '--format=%B', rev),
  };
}

test('a message without the trailer gets it, in its own trailer block', t => {
  const r = repo(t);
  r.commit('a', '-m', 'Add a', '-m', 'Because a was missing.');
  assert.equal(r.message(), `Add a\n\nBecause a was missing.\n\n${trailer}`);
});

test('the trailer joins an existing trailer block', t => {
  const r = repo(t);
  r.commit('a', '-m', 'Add a', '-m', 'Signed-off-by: hook test <hook@example.invalid>');
  assert.equal(r.message(), `Add a\n\nSigned-off-by: hook test <hook@example.invalid>\n${trailer}`);
});

test('a message that already has the trailer is not given a second one', t => {
  const r = repo(t);
  r.commit('a', '-m', 'Add a', '-m', trailer);
  assert.equal(r.message(), `Add a\n\n${trailer}`);
});

test('a trailer with another model name or letter case counts as present', t => {
  const r = repo(t);
  r.commit('a', '-m', 'Add a', '-m', 'co-authored-by: Claude Sonnet 4 <NoReply@Anthropic.com>');
  assert.equal(r.message(), 'Add a\n\nco-authored-by: Claude Sonnet 4 <NoReply@Anthropic.com>');
});

test('comment lines and a verbose diff are not part of the message', t => {
  const r = repo(t);
  r.type(`Add a\n\n# ${trailer}\n`);
  r.commit('a', '-v');
  assert.equal(r.message(), `Add a\n\n${trailer}`);
});

test('an empty message is still refused', t => {
  const r = repo(t);
  assert.throws(() => r.commit('a', '-m', ''), /empty commit message/);
  r.type('# only a comment\n');
  assert.throws(() => r.commit('a', '-v'), /empty commit message/);
});

test('a merge commit is left alone', t => {
  const r = repo(t);
  r.commit('a', '-m', 'first');
  r.git('checkout', '-q', '-b', 'side');
  r.commit('b', '-m', 'side');
  r.git('checkout', '-q', 'main');
  r.commit('c', '-m', 'main');
  r.git('merge', '-q', '--no-ff', '-m', 'Merge side', 'side');
  assert.equal(r.git('rev-list', '--count', '--merges', 'HEAD'), '1');
  assert.equal(r.message(), 'Merge side');
  // A merge that stopped on a conflict and is committed by hand is still a merge.
  r.git('checkout', '-q', '-b', 'other', 'HEAD~1');
  writeFileSync(join(r.dir, 'c'), 'other\n');
  r.git('commit', '-q', '-am', 'other');
  r.git('checkout', '-q', 'main');
  writeFileSync(join(r.dir, 'c'), 'main again\n');
  r.git('commit', '-q', '-am', 'main again');
  assert.throws(() => r.git('merge', '-q', 'other'));
  writeFileSync(join(r.dir, 'c'), 'resolved\n');
  r.git('commit', '-q', '-am', 'Merge other');
  assert.equal(r.message(), 'Merge other');
});
