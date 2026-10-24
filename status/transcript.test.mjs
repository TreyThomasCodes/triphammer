import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseTranscript, toolSummary} from './transcript.mjs';
import {transcriptPage} from './render.mjs';

const text = fs.readFileSync(new URL('./test-fixtures/sample-transcript.jsonl', import.meta.url), 'utf8');
const run = {name: '20260102T100000Z-ticket-7', kind: 'ticket', number: 7, started: '2026-01-02T10:00:00Z', log: undefined, active: false};

test('turns stream-json events into a conversation and keeps unparsable lines raw', () => {
  const entries = parseTranscript(text);
  assert.deepEqual(entries.map(entry => entry.kind),
    ['init', 'text', 'tool', 'result', 'tool', 'subagent', 'tool', 'result', 'subagent', 'raw', 'final', 'raw']);
  assert.deepEqual(entries[2], {kind: 'tool', name: 'Bash', summary: 'Read the issue', sub: false});
  assert.deepEqual(entries[6], {kind: 'tool', name: 'Read', summary: '/work/issue-7/README.md', sub: true});
  assert.deepEqual(entries[7], {kind: 'result', text: 'line one\n[image]', isError: true, sub: true});
  assert.deepEqual(entries[10], {kind: 'final', isError: false, costUsd: 1.2345, durationMs: 125000, turns: 9, text: 'Opened the pull request.'});
  assert.equal(entries[9].kind === 'raw' && entries[9].line, 'error: something on stderr');
});

test('summarises unknown tools as compact, truncated JSON', () => {
  assert.equal(toolSummary('Mystery', {a: 1}), '{"a":1}');
  assert.equal(toolSummary('Mystery', {a: 'x'.repeat(500)}).length, 160);
  assert.equal(toolSummary('Bash', {command: 'ls -la'}), 'ls -la');
});

test('never throws on junk lines', () => {
  assert.deepEqual(parseTranscript('null\n[1]\n"text"\n{"type":"assistant"}\n').map(entry => entry.kind), ['raw', 'raw', 'raw']);
});

test('renders escaped content, collapsed results, the final line, and refreshes only for the active run', () => {
  const entries = parseTranscript(text);
  const html = transcriptPage('demo', run, entries);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&#60;script&#62;alert(1)&#60;/script&#62;'));
  assert.ok(html.includes('Reading the issue &#60;now&#62;.'));
  assert.match(html, /<details class="entry result">/);
  assert.match(html, /\$1\.23 · 2m 05s · 9 turns/);
  assert.ok(!html.includes('http-equiv="refresh"'));
  assert.ok(transcriptPage('demo', {...run, active: true}, entries).includes('http-equiv="refresh"'));
});

test('truncates long tool results', () => {
  const long = JSON.stringify({type: 'user', message: {content: [{type: 'tool_result', tool_use_id: 't', content: 'y'.repeat(10_000)}]}});
  const html = transcriptPage('demo', run, parseTranscript(long));
  assert.ok(html.includes('6000 more characters'));
  assert.ok(!html.includes('y'.repeat(4001)));
});
