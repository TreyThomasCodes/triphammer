import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {exampleProject, fakeGh, here, installTriphammerFiles, lines, projectJson, toolingEnv, withUmask, writeConfig} from './fixture.mjs';

const url = 'http://demos.example.invalid:8888/';

// This branch's demo-publish (or the copy `script`) run with `args`, against a fake `gh` in `root` that knows PR #999,
// and a Triphammer config (root/triphammer.conf, written unless it exists) naming acme/widgets with the demo module on, its
// gallery in `root/data/demos` and served at `url`, with `env` over it.
function runIn(root, args, env = {}, script = join(here, 'demo-publish')) {
  const gh = fakeGh(join(root, 'gh'), {
    'pr view 999': {stdout: JSON.stringify({title: 'Demo', url: 'https://example.invalid/999', state: 'OPEN', labels: [], mergedAt: null})},
  });
  const config = join(root, 'triphammer.conf');
  if (!existsSync(config)) {
    writeConfig(config, {REPO: 'acme/widgets', CHECKOUT: root, APP_AUTHOR: 'app/widget-bot', STATE_DIR: root, MODULES: 'demo',
      DEMO_GALLERY_DIR: join(root, 'data', 'demos'), DEMO_URL: url});
  }
  return spawnSync(script, args, {
    encoding: 'utf8',
    env: {...toolingEnv, PATH: `${gh.bin}:${process.env.PATH}`, TRIPHAMMER_CONFIG: config, ...env},
  });
}

// This branch's demo-publish run against a demo folder `results` (path -> content, {link: target} for a symlink,
// or {hardlink: target} for a hard link) built in a throwaway directory next to `outside/secret.txt`, with a fake `gh`
// that knows PR #999 and the gallery in the throwaway directory. `linkAs` passes a symlink of that name to `results`
// instead of `results` itself. `first` names files (name -> content) in a folder `first` published to the same gallery
// before the run.
function demoPublish(t, results, {linkAs, first} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'demo-publish-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const outside = join(root, 'outside');
  mkdirSync(join(outside, 'media'), {recursive: true});
  writeFileSync(join(outside, 'secret.txt'), 'the service user can read this');
  writeFileSync(join(outside, 'media', 'shot.png'), 'png outside');
  const folder = join(root, 'results');
  mkdirSync(folder);
  for (const [path, content] of Object.entries(results)) {
    mkdirSync(join(folder, path, '..'), {recursive: true});
    if (typeof content === 'string') writeFileSync(join(folder, path), content);
    else if (content.hardlink) linkSync(content.hardlink.replace('{outside}', outside), join(folder, path));
    else symlinkSync(content.link.replace('{outside}', outside), join(folder, path));
  }
  if (linkAs) symlinkSync(folder, join(root, linkAs));
  const run = path => runIn(root, ['999', '--summary', 'Shows the demo', path]);
  if (first) {
    mkdirSync(join(root, 'first'));
    for (const [name, content] of Object.entries(first)) writeFileSync(join(root, 'first', name), content);
    assert.equal(run(join(root, 'first')).status, 0);
  }
  const result = run(join(root, linkAs ?? 'results'));
  const gallery = join(root, 'data', 'demos', 'pr-999');
  const published = existsSync(gallery) ? readdirSync(gallery).filter(name => name !== 'meta.json').sort() : [];
  const read = name => readFileSync(join(gallery, name), 'utf8');
  return {...result, folder, published, read};
}

// demo-publish run with `args` built from paths in a throwaway directory holding folders `one` and `two` (each with a
// screenshot) and a screenshot file `shot.png`.
function demoPublishWith(t, args) {
  const root = mkdtempSync(join(tmpdir(), 'demo-publish-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  for (const name of ['one', 'two']) {
    mkdirSync(join(root, name));
    writeFileSync(join(root, name, 'shot.png'), 'png bytes');
  }
  writeFileSync(join(root, 'shot.png'), 'png bytes');
  const result = runIn(root, args(name => join(root, name)));
  return {...result, published: existsSync(join(root, 'data', 'demos', 'pr-999'))};
}

test('a real screenshot in the folder is published', t => {
  const r = demoPublish(t, {'shot.png': 'png bytes'});
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.published, ['00-results-shot.png']);
  assert.equal(r.read('00-results-shot.png'), 'png bytes');
  assert.equal(r.stdout, `published PR #999 to ${url}: 0 video(s), 1 screenshot(s)\n`);
});

test('a symlink to a file outside the folder is skipped, named, and nothing is copied', t => {
  const r = demoPublish(t, {'leak.png': {link: '{outside}/secret.txt'}});
  assert.notEqual(r.status, 0);
  assert.deepEqual(r.published, []);
  assert.match(r.stdout, new RegExp(`^skipped ${join(r.folder, 'leak.png')}: a symlink, not followed$`, 'm'));
  assert.match(r.stderr, /no \.png, \.webm or \.mp4 files found/);
});

test('a hard link to a file outside the folder is skipped, named, and nothing is copied', t => {
  const r = demoPublish(t, {'a-real.png': 'real', 'hard.png': {hardlink: '{outside}/secret.txt'}});
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.published, ['00-results-a-real.png']);
  assert.match(r.stdout, new RegExp(`^skipped ${join(r.folder, 'hard.png')}: has other hard links$`, 'm'));
});

test('a folder holding only a hard link fails and leaves the earlier publish intact', t => {
  const r = demoPublish(t, {'hard.png': {hardlink: '{outside}/secret.txt'}}, {first: {'a.png': 'first png'}});
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /^skipped .*\/hard\.png: has other hard links$/m);
  assert.match(r.stderr, /no \.png, \.webm or \.mp4 files found/);
  assert.deepEqual(r.published, ['00-first-a.png']);
  assert.equal(r.read('00-first-a.png'), 'first png');
});

test('symlinks are skipped next to real files, even one pointing inside the folder', t => {
  const r = demoPublish(t, {
    'a-real.png': 'real',
    'b-leak.png': {link: '{outside}/secret.txt'},
    'c-alias.png': {link: 'a-real.png'},
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.published, ['00-results-a-real.png']);
  assert.match(r.stdout, /^skipped .*\/b-leak\.png: a symlink, not followed$/m);
  assert.match(r.stdout, /^skipped .*\/c-alias\.png: a symlink, not followed$/m);
  assert.match(r.stdout, /^published PR #999 to http:\/\/demos\.example\.invalid:8888\/: 0 video\(s\), 1 screenshot\(s\)$/m);
});

test('a symlinked directory is not walked, at any depth', t => {
  const r = demoPublish(t, {'nested/real.png': 'real', 'nested/linked': {link: '{outside}/media'}});
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.published, ['00-nested-real.png']);
  assert.match(r.stdout, /^skipped .*\/nested\/linked: a symlink, not followed$/m);
  assert.doesNotMatch(r.stdout, /shot\.png/);
});

test('a symlinked folder passed as the source is not walked', t => {
  const r = demoPublish(t, {'shot.png': 'real'}, {linkAs: 'linked-results'});
  assert.notEqual(r.status, 0);
  assert.deepEqual(r.published, []);
  assert.match(r.stdout, /^skipped .*\/linked-results: a symlink, not followed$/m);
});

test('the gallery stays readable by a server running as another user when the runner publishes under umask 077', t => {
  withUmask(t, 0o077);
  const r = demoPublish(t, {'shot.png': 'png bytes'});
  assert.equal(r.status, 0, r.stderr);
  const gallery = join(r.folder, '../data/demos');
  for (const path of [gallery, join(gallery, 'index.html'), join(gallery, 'pr-999'), join(gallery, 'pr-999/00-results-shot.png'),
    join(gallery, 'pr-999/meta.json')]) {
    assert.equal(statSync(path).mode & 0o004, 0o004, path);
  }
});

test('the summary is stored with the published demo', t => {
  const r = demoPublish(t, {'shot.png': 'png bytes'});
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.read('meta.json')).summary, 'Shows the demo');
});

for (const [name, args] of [
  ['a call without --summary', at => ['999', at('one')]],
  ['an empty summary', at => ['999', '--summary', ' ', at('one')]],
  ['two folders', at => ['999', '--summary', 'Shows the demo', at('one'), at('two')]],
  ['a file as the source', at => ['999', '--summary', 'Shows the demo', at('shot.png')]],
  ['a missing source', at => ['999', '--summary', 'Shows the demo', at('missing')]],
  ['no source', () => ['999', '--summary', 'Shows the demo']],
  ['--summary after the folder', at => ['999', at('one'), '--summary', 'Shows the demo']],
]) {
  test(`${name} is refused with the usage text and publishes nothing`, t => {
    const r = demoPublishWith(t, args);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /demo-publish <pr> --summary <line> <folder>/);
    assert.equal(r.published, false);
  });
}

test("the callers' form publishes the folder", t => {
  const r = demoPublishWith(t, at => ['999', '--summary', 'Shows the demo', at('one')]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.published, true);
});

test("the pull request is read from the Triphammer config's REPO", t => {
  const root = mkdtempSync(join(tmpdir(), 'demo-publish-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  mkdirSync(join(root, 'results'));
  writeFileSync(join(root, 'results', 'shot.png'), 'png');
  const result = runIn(root, ['999', '--summary', 'Shows the demo', join(root, 'results')]);
  assert.equal(result.status, 0, result.stderr);
  const views = lines(join(root, 'gh', 'calls')).map(line => JSON.parse(line)).filter(call => call[1] === 'view');
  assert.deepEqual(views.map(call => call.slice(0, 5)), [['pr', 'view', '999', '-R', 'acme/widgets']]);
});

test('a missing or malformed Triphammer config stops it before any gh call or gallery write; a wrong form still prints the usage', t => {
  const root = mkdtempSync(join(tmpdir(), 'demo-publish-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const missing = join(root, 'nowhere.conf');
  for (const [env, message] of [
    [{TRIPHAMMER_CONFIG: missing}, `demo-publish: the Triphammer config ${missing} is missing or unreadable`],
    [{TRIPHAMMER_CONFIG: join(root, 'bad.conf')}, `demo-publish: ${join(root, 'bad.conf')} does not set STATE_DIR`],
  ]) {
    writeConfig(join(root, 'bad.conf'), {REPO: 'acme/widgets', CHECKOUT: root, APP_AUTHOR: 'app/widget-bot'});
    const result = runIn(root, ['--reindex'], env);
    assert.equal(result.status, 2, message);
    assert.ok(result.stderr.includes(message), result.stderr);
    assert.equal(existsSync(join(root, 'gh', 'calls')), false);
    assert.equal(existsSync(join(root, 'data')), false);
  }
  const usage = runIn(root, ['--other'], {TRIPHAMMER_CONFIG: missing});
  assert.notEqual(usage.status, 0);
  assert.match(usage.stderr, /demo-publish <pr> --summary <line> <folder>/);
});

test("without TRIPHAMMER_CONFIG the Triphammer config is <name>.conf under XDG_CONFIG_HOME, <name> from its checkout's project file", t => {
  const root = mkdtempSync(join(tmpdir(), 'demo-publish-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  // A checkout of this branch's demo-publish and config.sh that holds the example project's project file.
  const checkout = join(root, 'checkout');
  installTriphammerFiles(checkout, 'demo-publish', 'config.sh');
  cpSync(join(exampleProject, '.triphammer'), join(checkout, '.triphammer'), {recursive: true});
  const name = JSON.parse(projectJson).name;
  mkdirSync(join(root, 'xdg/triphammer'), {recursive: true});
  writeConfig(join(root, 'xdg/triphammer', `${name}.conf`), {REPO: 'acme/widgets', CHECKOUT: root, APP_AUTHOR: 'app/widget-bot', STATE_DIR: root,
    MODULES: 'demo', DEMO_GALLERY_DIR: join(root, 'data', 'demos'), DEMO_URL: url});
  const script = join(checkout, 'bin/demo-publish');
  const found = runIn(root, ['--reindex'], {TRIPHAMMER_CONFIG: '', XDG_CONFIG_HOME: join(root, 'xdg')}, script);
  assert.equal(found.status, 0, found.stderr);
  const missing = runIn(root, ['--reindex'], {TRIPHAMMER_CONFIG: '', XDG_CONFIG_HOME: join(root, 'other')}, script);
  assert.equal(missing.status, 2);
  assert.ok(missing.stderr.includes(`demo-publish: the Triphammer config ${join(root, 'other/triphammer', `${name}.conf`)} is missing`), missing.stderr);
});

test('the gallery is the Triphammer config\'s DEMO_GALLERY_DIR, wherever that is', t => {
  const root = mkdtempSync(join(tmpdir(), 'demo-publish-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  mkdirSync(join(root, 'results'));
  writeFileSync(join(root, 'results', 'shot.png'), 'png');
  const gallery = join(root, 'served', 'gallery');
  writeConfig(join(root, 'triphammer.conf'), {REPO: 'acme/widgets', CHECKOUT: root, APP_AUTHOR: 'app/widget-bot', STATE_DIR: root,
    MODULES: 'codex,demo', DEMO_GALLERY_DIR: gallery, DEMO_URL: 'https://gallery.example.invalid/'});
  const result = runIn(root, ['999', '--summary', 'Shows the demo', join(root, 'results')]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'published PR #999 to https://gallery.example.invalid/: 0 video(s), 1 screenshot(s)\n');
  assert.ok(existsSync(join(gallery, 'pr-999', 'meta.json')));
  assert.ok(existsSync(join(gallery, 'index.html')));
  assert.equal(existsSync(join(root, 'data')), false);
});

test('with the demo module off, or without its gallery or URL, it exits 2 naming the setting and writes nothing', t => {
  const root = mkdtempSync(join(tmpdir(), 'demo-publish-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const config = join(root, 'triphammer.conf');
  const base = {REPO: 'acme/widgets', CHECKOUT: root, APP_AUTHOR: 'app/widget-bot', STATE_DIR: root,
    DEMO_GALLERY_DIR: join(root, 'data', 'demos'), DEMO_URL: url};
  for (const [settings, message] of [
    [{}, `demo-publish: the demo module is off; add it to MODULES in ${config} (bin/README.md)`],
    [{MODULES: 'qwen-audit,codex'}, `demo-publish: the demo module is off; add it to MODULES in ${config} (bin/README.md)`],
    [{MODULES: 'demo', DEMO_GALLERY_DIR: null}, `demo-publish: ${config}: the demo module needs DEMO_GALLERY_DIR`],
    [{MODULES: 'demo', DEMO_URL: ''}, `demo-publish: ${config}: the demo module needs DEMO_URL`],
  ]) {
    writeConfig(config, {...base, ...settings});
    const result = runIn(root, ['--reindex']);
    assert.equal(result.status, 2, message);
    assert.equal(result.stderr.trim(), message);
    assert.equal(existsSync(join(root, 'gh', 'calls')), false);
    assert.equal(existsSync(join(root, 'data')), false);
  }
});

test('a video ffmpeg cannot convert fails in one line and leaves the earlier publish as it was, with no half-built folder', t => {
  const root = mkdtempSync(join(tmpdir(), 'demo-publish-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  // A fake ffmpeg that copies its input to its output, and fails as the real one does when the input is not a video.
  const bin = join(root, 'ffmpeg-bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'ffmpeg'), `#!/bin/sh
for arg; do [ "$prev" = -i ] && in=$arg; prev=$arg; done
cat "$in" > "$prev"
if grep -q 'not a video' "$prev"; then echo "$in: Invalid data found when processing input" >&2; exit 1; fi
`, {mode: 0o755});
  const env = {PATH: `${bin}:${join(root, 'gh', 'bin')}:${process.env.PATH}`};
  mkdirSync(join(root, 'first'));
  writeFileSync(join(root, 'first', 'a.png'), 'first png');
  const first = runIn(root, ['999', '--summary', 'Shows the demo', join(root, 'first')], env);
  assert.equal(first.status, 0, first.stderr);
  const demos = join(root, 'data', 'demos');
  const meta = readFileSync(join(demos, 'pr-999', 'meta.json'), 'utf8');
  mkdirSync(join(root, 'second'));
  writeFileSync(join(root, 'second', 'b.png'), 'second png');
  writeFileSync(join(root, 'second', 'v.webm'), 'not a video');
  const r = runIn(root, ['999', '--summary', 'Shows another demo', join(root, 'second')], env);
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stderr, /Traceback/);
  assert.equal(r.stderr.trimEnd().split('\n').length, 1, r.stderr);
  assert.match(r.stderr, /^demo-publish: ffmpeg could not convert .*\/second\/v\.webm: .*Invalid data found when processing input; /);
  assert.deepEqual(readdirSync(join(demos, 'pr-999')).sort(), ['00-first-a.png', 'meta.json']);
  assert.equal(readFileSync(join(demos, 'pr-999', '00-first-a.png'), 'utf8'), 'first png');
  assert.equal(readFileSync(join(demos, 'pr-999', 'meta.json'), 'utf8'), meta);
  assert.deepEqual(readdirSync(demos).sort(), ['index.html', 'pr-999']);
});

test('publishing again replaces the earlier entry and leaves no staging folder in the gallery', t => {
  const r = demoPublish(t, {'b.png': 'second png'}, {first: {'a.png': 'first png'}});
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.published, ['00-results-b.png']);
  assert.deepEqual(readdirSync(join(r.folder, '../data/demos')).sort(), ['index.html', 'pr-999']);
});
