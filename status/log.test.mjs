import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {outcomeLabel, pairRuns, parseLogLine} from './log.mjs';

const lines = fs.readFileSync(new URL('./test-fixtures/sample-runner-log.txt', import.meta.url), 'utf8').split('\n').filter(Boolean);

test('parses start and end lines, and every other line, stamped or not, as other', () => {
  assert.deepEqual(
    lines.map(line => parseLogLine(line).event),
    ['start', 'start', 'finished', 'other', 'start', 'no-progress', 'start', 'rate-limit', 'other', 'other', 'start']);
  const repair = parseLogLine(lines[4]);
  assert.equal(repair.kind, 'repair');
  assert.equal(repair.number, 12);
  assert.equal(repair.reason, 'failing-checks');
  assert.equal(repair.attempt, 2);
  assert.equal(repair.transcript, '/state/runs/20260102T105000Z-repair-12.jsonl');
  assert.equal(parseLogLine(lines[5]).exit, 1);
});

test('pairs each end with the latest open start of the same run, leaving a killed run without an end', () => {
  const runs = pairRuns(lines);
  const label = (/** @type {string} */ name) => outcomeLabel(runs.get(name), false);
  assert.equal(label('20260102T100000Z-ticket-7.jsonl'), 'no end recorded');
  assert.equal(label('20260102T100500Z-ticket-7.jsonl'), 'finished (exit 0)');
  assert.equal(label('20260102T105000Z-repair-12.jsonl'), 'no progress (exit 1)');
  assert.equal(label('20260102T111000Z-ticket-8.jsonl'), 'rate limited');
  assert.equal(label('20260102T130000Z-ticket-9.jsonl'), 'no end recorded');
  assert.equal(outcomeLabel(undefined, false), 'not in log');
  assert.equal(outcomeLabel(runs.get('20260102T130000Z-ticket-9.jsonl'), true), 'running');
});
