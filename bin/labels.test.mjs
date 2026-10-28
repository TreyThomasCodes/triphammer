import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {runnerSetup} from './fixture.mjs';

const repo = 'Example-Owner/example-project';
// The labels bin/labels.sh defines, with the color and description each is created with.
const labels = {
  'hold': ['D93F0B', 'The owner\'s brake: Triphammer skips this issue or pull request and stops a run on it'],
  'needs-owner': ['5319E7', 'Waits for the owner: Triphammer neither runs nor merges it while this label is on'],
  'stop-agents': ['B60205', 'An open issue with this label pauses Triphammer in this repository'],
  'next': ['0E8A16', 'Triphammer takes this ready issue before the other ready issues'],
  'agent-working': ['FBCA04', 'Triphammer is working on this; don\'t update or push to it'],
  'light': ['C2E0C6', 'Triphammer\'s first run on this issue uses the Sonnet builder; later runs use Opus'],
};
const create = name => ['label', 'create', name, '-R', repo, '--color', labels[name][0], '--description', labels[name][1]];
const list = ['label', 'list', '-R', repo, '--limit', '1000', '--json', 'name', '--jq', '.[].name'];

// `ticket-runner --labels` on a machine whose repository has the labels `existing` (gh label list's output).
function labelsRun(t, existing, routes = {}) {
  const r = runnerSetup(t, {gh: {'label list': {stdout: existing}, ...routes}});
  const result = spawnSync(join(r.checkout, 'bin/ticket-runner'), ['--labels'], {env: r.env, encoding: 'utf8'});
  return {r, result, labelCalls: r.gh.calls().filter(call => call[0] === 'label')};
}

test('--labels creates each label Triphammer uses that the repository lacks, with its color and description', t => {
  const {r, result, labelCalls} = labelsRun(t, 'bug\nNEXT\nhold\n');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(labelCalls, [list, create('needs-owner'), create('stop-agents'), create('agent-working'),
    create('light')]);
  assert.match(result.stdout, /^created the label needs-owner in Example-Owner\/example-project$/m);
  assert.equal(existsSync(join(r.root, 'state/ticket-runner')), false, '--labels started a tick');
  for (const [, description] of Object.values(labels)) assert.ok(description.length <= 100, description);
});

test('--labels leaves a repository that has every label as it is', t => {
  const {result, labelCalls} = labelsRun(t, `${Object.keys(labels).join('\n')}\n`);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(labelCalls, [list]);
});

test('--labels fails when the labels cannot be listed, creating none, and tries every label when one fails', t => {
  const unlisted = labelsRun(t, '', {'label list': {exit: 1, stderr: 'HTTP 404\n'}});
  assert.equal(unlisted.result.status, 1);
  assert.deepEqual(unlisted.labelCalls, [list]);
  assert.match(unlisted.result.stderr, /could not list the labels of Example-Owner\/example-project/);
  const refused = labelsRun(t, '', {'label create hold': {exit: 1, stderr: 'HTTP 403\n'}});
  assert.equal(refused.result.status, 1);
  assert.deepEqual(refused.labelCalls, [list, ...Object.keys(labels).map(create)]);
  assert.match(refused.result.stderr, /could not create the label hold in Example-Owner\/example-project/);
});
