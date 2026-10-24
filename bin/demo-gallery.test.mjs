import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import http from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {freePort, here, toolingEnv, writeConfig} from './fixture.mjs';

const script = join(here, 'demo-gallery');

// A throwaway directory holding a gallery (root/gallery) next to a secret it must never serve (root/outside), and a
// Triphammer config (root/triphammer.conf) with the demo module on and `config` over it (name -> value; null leaves one out).
function gallery(t, config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'demo-gallery-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const dir = join(root, 'gallery');
  mkdirSync(join(dir, 'pr-7'), {recursive: true});
  mkdirSync(join(dir, 'empty'));
  mkdirSync(join(root, 'outside'));
  writeFileSync(join(root, 'outside', 'secret.txt'), 'the service user can read this');
  writeFileSync(join(dir, 'index.html'), '<h1>Demos</h1>');
  writeFileSync(join(dir, 'pr-7', 'index.html'), '<h1>PR 7</h1>');
  writeFileSync(join(dir, 'pr-7', 'shot.png'), 'png bytes');
  writeFileSync(join(dir, 'pr-7', 'walk.mp4'), '0123456789');
  writeFileSync(join(dir, 'pr-7', 'notes.vtt'), 'WEBVTT');
  writeFileSync(join(dir, 'pr-7', 'data.bin'), 'raw');
  symlinkSync(join(root, 'outside', 'secret.txt'), join(dir, 'leak.txt'));
  symlinkSync(join(root, 'outside'), join(dir, 'leakdir'));
  symlinkSync(join(dir, 'pr-7', 'shot.png'), join(dir, 'same.png'));
  const file = join(root, 'triphammer.conf');
  writeConfig(file, {REPO: 'acme/widgets', CHECKOUT: root, APP_AUTHOR: 'app/widget-bot', STATE_DIR: root, MODULES: 'demo',
    DEMO_GALLERY_DIR: dir, DEMO_URL: 'http://demos.example.invalid/', ...config});
  return {root, dir, env: {...toolingEnv, TRIPHAMMER_CONFIG: file}};
}

// Starts demo-gallery with `env` and resolves with its first output line once it says where it listens, or with its
// exit status and output when it stops first.
function start(t, env) {
  const child = spawn(process.execPath, [script], {env, stdio: ['ignore', 'pipe', 'pipe']});
  t.after(() => child.kill());
  let stdout = '', stderr = '';
  return new Promise(done => {
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.includes('\n')) done({listening: stdout.trim(), stderr});
    });
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('exit', status => done({status, stdout, stderr}));
  });
}

// One request to the gallery at `port`, resolved with its status, headers and body.
function request(port, pathname, {method = 'GET', headers = {}} = {}) {
  return new Promise((done, fail) => {
    // The path is written to the request line verbatim, so `..` and encoded forms reach the server as given.
    const req = http.request({host: '127.0.0.1', port, method, path: pathname, headers}, response => {
      let body = '';
      response.setEncoding('utf8').on('data', chunk => (body += chunk)).on('end', () => done({status: response.statusCode, headers: response.headers, body}));
    });
    req.on('error', fail).end();
  });
}

async function serving(t, config = {}) {
  const port = await freePort();
  const g = gallery(t, {DEMO_GALLERY_PORT: String(port), ...config});
  const started = await start(t, g.env);
  assert.ok(started.listening, started.stderr);
  return {...g, port, started};
}

test('serves the gallery\'s files with their content type, and a directory\'s index.html', async t => {
  const {port, dir, started} = await serving(t);
  assert.equal(started.listening, `demo-gallery: serving ${dir} at http://127.0.0.1:${port}/`);
  for (const [pathname, type, body] of [
    ['/', 'text/html; charset=utf-8', '<h1>Demos</h1>'],
    ['/index.html', 'text/html; charset=utf-8', '<h1>Demos</h1>'],
    ['/pr-7/', 'text/html; charset=utf-8', '<h1>PR 7</h1>'],
    ['/pr-7/shot.png?v=1', 'image/png', 'png bytes'],
    ['/pr-7/walk.mp4', 'video/mp4', '0123456789'],
    ['/pr-7/notes.vtt', 'text/vtt; charset=utf-8', 'WEBVTT'],
    ['/pr-7/data.bin', 'application/octet-stream', 'raw'],
    ['/%70r-7/shot.png', 'image/png', 'png bytes'],
    ['/same.png', 'image/png', 'png bytes'],
  ]) {
    const response = await request(port, pathname);
    assert.deepEqual([response.status, response.headers['content-type'], response.body], [200, type, body], pathname);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
  }
  const head = await request(port, '/pr-7/shot.png', {method: 'HEAD'});
  assert.deepEqual([head.status, head.headers['content-length'], head.body], [200, '9', '']);
  const redirect = await request(port, '/pr-7');
  assert.deepEqual([redirect.status, redirect.headers.location], [301, '/pr-7/']);
  const doubled = await request(port, '//pr-7');
  assert.deepEqual([doubled.status, doubled.headers.location], [301, '/pr-7/']);
});

test('one byte range is served so videos can seek, and a range past the end gets 416', async t => {
  const {port} = await serving(t);
  for (const [range, contentRange, body] of [['bytes=2-4', 'bytes 2-4/10', '234'], ['bytes=7-', 'bytes 7-9/10', '789'], ['bytes=-3', 'bytes 7-9/10', '789']]) {
    const response = await request(port, '/pr-7/walk.mp4', {headers: {range}});
    assert.deepEqual([response.status, response.headers['content-range'], response.body], [206, contentRange, body], range);
  }
  const past = await request(port, '/pr-7/walk.mp4', {headers: {range: 'bytes=10-'}});
  assert.deepEqual([past.status, past.headers['content-range']], [416, 'bytes */10']);
});

test('paths that leave the gallery, by .. or by a symlink to outside it, directories without an index and missing files get 404', async t => {
  const {port} = await serving(t);
  for (const pathname of ['/../outside/secret.txt', '/pr-7/../../outside/secret.txt', '/%2e%2e/outside/secret.txt',
    '/pr-7/%2e%2e%2f%2e%2e%2foutside%2fsecret.txt', '/leak.txt', '/leakdir/secret.txt', '/leakdir/', '/empty/', '/empty',
    '/missing.png', '/%zz', '/pr-7/shot.png%00', 'http://demos.example.invalid/../outside/secret.txt']) {
    const response = await request(port, pathname);
    assert.equal(response.status, 404, pathname);
    assert.doesNotMatch(response.body, /service user/, pathname);
  }
});

test('only GET and HEAD are answered; anything else gets 405 and writes nothing', async t => {
  const {port, dir} = await serving(t);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const response = await request(port, '/pr-7/new.png', {method});
    assert.deepEqual([response.status, response.headers.allow], [405, 'GET, HEAD'], method);
  }
  assert.equal((await request(port, '/pr-7/new.png')).status, 404);
  assert.equal(spawnSync('ls', [join(dir, 'pr-7')], {encoding: 'utf8'}).stdout.includes('new.png'), false);
});

test('the address comes from DEMO_GALLERY_HOST, and defaults to 127.0.0.1 on port 8788 when the config leaves them out', async t => {
  const port = await freePort();
  const fromConfig = await start(t, gallery(t, {DEMO_GALLERY_HOST: 'localhost', DEMO_GALLERY_PORT: String(port)}).env);
  assert.match(fromConfig.listening, new RegExp(`at http://localhost:${port}/$`));
  // The default port may already be taken on this machine; either way the server names the address it used.
  const {dir, env} = gallery(t);
  const fallback = await start(t, env);
  if (fallback.listening) assert.equal(fallback.listening, `demo-gallery: serving ${dir} at http://127.0.0.1:8788/`);
  else assert.match(fallback.stderr, /^demo-gallery: cannot listen on 127\.0\.0\.1:8788: /);
});

test('with the demo module off, or the gallery directory or the config missing, it exits 2 naming why', async t => {
  for (const [config, message] of [
    [{MODULES: null}, /^demo-gallery: the demo module is off; add it to MODULES in /],
    [{MODULES: 'codex'}, /^demo-gallery: the demo module is off/],
    [{DEMO_GALLERY_DIR: null}, /: the demo module needs DEMO_GALLERY_DIR$/m],
    [{DEMO_GALLERY_PORT: '70000'}, /: DEMO_GALLERY_PORT must be a port from 1 to 65535, not 70000$/m],
  ]) {
    const result = await start(t, gallery(t, config).env);
    assert.equal(result.status, 2, JSON.stringify(config));
    assert.match(result.stderr, message);
  }
  const missing = await start(t, {...toolingEnv, TRIPHAMMER_CONFIG: join(tmpdir(), 'demo-gallery-no-such', 'x.conf')});
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /is missing or unreadable/);
});

test('config.sh --print prints the named settings separated by NUL, an optional one left out as empty, and exits 2 on a bad call', t => {
  const reader = join(here, 'config.sh');
  const print = (env, ...args) => spawnSync('bash', [reader, '--print', 'demo-gallery', join(here, '..'), ...args], {encoding: 'utf8', env});
  const {dir, env} = gallery(t, {DEMO_GALLERY_HOST: null});
  const printed = print(env, '--module', 'demo', 'DEMO_GALLERY_DIR', '--', 'REPO', 'PROJECT', 'DEMO_GALLERY_DIR', 'DEMO_GALLERY_HOST');
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(printed.stdout, `acme/widgets\0triphammer\0${dir}\0\0`);
  const usage = 'usage: bash config.sh --print <script name> <checkout> [--module <name> [<setting>...] --] <KEY>...';
  for (const [args, message] of [
    [['NO_SUCH_KEY'], `demo-gallery: NO_SUCH_KEY is not a config setting; ${usage}`],
    [[], `demo-gallery: ${usage}`],
    [['--module', 'demo', 'DEMO_GALLERY_DIR', 'REPO'], `demo-gallery: ${usage}`],
    [['--module', 'demo', 'PROJECT', '--', 'REPO'], `demo-gallery: PROJECT is not an optional config setting; ${usage}`],
  ]) {
    const result = print(env, ...args);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `${message}\n`);
  }
  const missing = print({...env, TRIPHAMMER_CONFIG: join(tmpdir(), 'demo-gallery-no-such', 'x.conf')}, 'REPO');
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /^demo-gallery: the Triphammer config .* is missing or unreadable/);
});
