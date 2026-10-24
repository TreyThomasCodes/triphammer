import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmodSync, copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {lines} from './fixture.mjs';

// publish-demos copied into a throwaway shared directory next to a fake demo-publish that records its arguments (one JSON
// array per call) and exits with `publishExit`; `demos` (folder -> demo.json text, or null for none) are left in a
// throwaway worktree.
function publishDemos(t, demos, {publishExit = 0} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'publish-demos-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const bin = join(root, 'bin');
  const worktree = join(root, 'worktree');
  const calls = join(root, 'calls');
  mkdirSync(bin);
  mkdirSync(worktree);
  copyFileSync(join(import.meta.dirname, 'publish-demos'), join(bin, 'publish-demos'));
  writeFileSync(join(bin, 'demo-publish'), `#!/usr/bin/env node
require('node:fs').appendFileSync('${calls}', JSON.stringify(process.argv.slice(2)) + '\\n');
if (${publishExit}) { console.error('ffmpeg: conversion failed'); process.exit(${publishExit}); }
console.log('published');
`, {mode: 0o755});
  chmodSync(join(bin, 'publish-demos'), 0o755);
  const results = join(worktree, 'artifacts/web-demo/results');
  for (const [folder, demo] of Object.entries(demos ?? {})) {
    mkdirSync(join(results, folder), {recursive: true});
    writeFileSync(join(results, folder, 'video.webm'), 'video');
    if (demo !== null) writeFileSync(join(results, folder, 'demo.json'), demo);
  }
  const result = spawnSync(join(bin, 'publish-demos'), [worktree], {encoding: 'utf8'});
  const published = lines(calls).map(line => JSON.parse(line));
  return {...result, published, results};
}

test('a demo folder with demo.json is published with its pull request number and summary', t => {
  const r = publishDemos(t, {'risk-journey': JSON.stringify({pr: 77, summary: 'The risk panel shows the new greeks'})});
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.published, [['77', '--summary', 'The risk panel shows the new greeks', join(r.results, 'risk-journey')]]);
  assert.equal(r.stdout, 'demo risk-journey: published\n');
});

test('a worktree without demo results publishes nothing', t => {
  const r = publishDemos(t, null);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.published, []);
  assert.equal(r.stdout, '');
});

test('a folder without demo.json is skipped and the others are still published', t => {
  const r = publishDemos(t, {'a-stray': null, 'b-demo': '{"pr": 5, "summary": "One line"}'});
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.published.map(call => call[0]), ['5']);
  assert.match(r.stdout, /^demo a-stray: no demo.json; not published$/m);
});

test('a malformed demo.json is reported and not published', t => {
  const r = publishDemos(t, {
    'not-json': '{pr: 5',
    'no-pr': '{"summary": "x"}',
    'text-pr': '{"pr": "5", "summary": "x"}',
    'two-lines': '{"pr": 5, "summary": "one\\ntwo"}',
    'empty-summary': '{"pr": 5, "summary": " "}',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.published, []);
  assert.match(r.stdout, /^demo not-json: unreadable demo.json .*; not published$/m);
  assert.match(r.stdout, /^demo no-pr: demo.json needs "pr": a pull request number; not published$/m);
  assert.match(r.stdout, /^demo text-pr: demo.json needs "pr"/m);
  assert.match(r.stdout, /^demo two-lines: demo.json needs "summary": one line of text; not published$/m);
  assert.match(r.stdout, /^demo empty-summary: demo.json needs "summary"/m);
});

test('a failed publish is reported without failing', t => {
  const r = publishDemos(t, {'risk-journey': '{"pr": 77, "summary": "x"}'}, {publishExit: 1});
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.published.length, 1);
  assert.match(r.stdout, /^demo risk-journey: ffmpeg: conversion failed$/m);
  assert.match(r.stdout, /^demo risk-journey: demo-publish for PR #77 failed \(exit 1\)$/m);
});
