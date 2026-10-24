import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createPublicKey, createVerify} from 'node:crypto';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fakeCommand, here, lines, run, toolingEnv} from './fixture.mjs';

const api = 'https://api.github.com/app';
const installationsUrl = `GET ${api}/installations`;
const tokensUrl = `POST ${api}/installations/41/access_tokens`;
const iso = seconds => new Date(Date.now() + seconds * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
const installations = [{id: 40, account: {login: 'someone-else'}}, {id: 41, account: {login: 'test-owner'}}];
const minted = (token = 'ghs_minted', expiresAt = iso(3600)) => ({stdout: JSON.stringify({token, expires_at: expiresAt, permissions: {}})});

// A temporary home with the App's files (app-id, owner and a key openssl generates for the test) in its own config
// directory, an empty cache directory, and a fake curl (fake-curl.mjs) first on PATH answering from `routes`.
// GITHUB_APP_CONFIG_DIR, XDG_CACHE_HOME and HOME all point into the temporary directory.
function appSetup(t, routes = {[installationsUrl]: {stdout: JSON.stringify(installations)}, [tokensUrl]: minted()}) {
  const root = mkdtempSync(join(tmpdir(), 'github-app-token-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const config = join(root, 'config');
  const cacheHome = join(root, 'cache');
  const bin = join(root, 'bin');
  const curlDir = join(root, 'curl');
  for (const dir of [config, cacheHome, bin, curlDir]) mkdirSync(dir);
  writeFileSync(join(config, 'app-id'), '12345\n');
  writeFileSync(join(config, 'owner'), 'test-owner\n');
  const key = join(config, 'agents.pem');
  run('openssl', ['genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048', '-out', key]);
  chmodSync(key, 0o600);
  fakeCommand(bin, 'curl', curlDir);
  const respond = more => writeFileSync(join(curlDir, 'routes.json'), JSON.stringify({...routes, ...more}));
  respond({});
  const env = {...toolingEnv, HOME: root, GITHUB_APP_CONFIG_DIR: config, XDG_CACHE_HOME: cacheHome, PATH: `${bin}:${toolingEnv.PATH}`};
  const cacheOf = account => join(cacheHome, 'github-app', `token-${account}.json`);
  const cache = cacheOf('test-owner');
  return {
    root, config, key, bin, env, cache, cacheOf, respond,
    calls: () => lines(join(curlDir, 'calls')).map(line => JSON.parse(line)),
    token: (args = [], input = '', more = {}) =>
      spawnSync(join(here, 'github-app-token'), args, {env: {...env, ...more}, input, encoding: 'utf8'}),
    writeCache: (record, file = cache) => {
      mkdirSync(join(cacheHome, 'github-app'), {recursive: true, mode: 0o700});
      writeFileSync(file, typeof record === 'string' ? record : JSON.stringify(record), {mode: 0o600});
    },
    // The base64 lines of the key, which must never leave the key file.
    keyLines: () => readFileSync(key, 'utf8').split('\n').filter(line => line && !line.startsWith('-----')),
  };
}

// Asserts the run failed closed: exit 1, no token on stdout, `message` on stderr, and the cache as `cacheBefore`.
function failedClosed(r, result, message, cacheBefore = undefined) {
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, message);
  if (cacheBefore === undefined) assert.equal(existsSync(r.cache), false);
  else assert.equal(readFileSync(r.cache, 'utf8'), cacheBefore);
  assert.deepEqual(existsSync(join(r.cache, '..')) ? readdirSync(join(r.cache, '..')).filter(name => !/^token-[a-z0-9-]+\.json$/.test(name)) : [], [],
    'no temporary cache file is left behind');
}

test('mints a token for the installation on the owner, prints it and caches it with mode 600 in a 700 directory', t => {
  const r = appSetup(t);
  const result = r.token();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'ghs_minted\n');
  assert.deepEqual(r.calls().map(call => `${call.method} ${call.url}`), [installationsUrl, tokensUrl]);
  const cached = JSON.parse(readFileSync(r.cache, 'utf8'));
  assert.deepEqual(Object.keys(cached).sort(), ['expires_at', 'token']);
  assert.equal(cached.token, 'ghs_minted');
  assert.equal(statSync(r.cache).mode & 0o777, 0o600);
  assert.equal(statSync(join(r.cache, '..')).mode & 0o777, 0o700);
});

test("signs a JWT the test key's public key verifies, issued by the app-id, and keeps it out of curl's arguments", t => {
  const r = appSetup(t);
  assert.equal(r.token().status, 0);
  const publicKey = createPublicKey(readFileSync(r.key));
  for (const call of r.calls()) {
    assert.ok(call.headers.includes('Accept: application/vnd.github+json'));
    const auth = call.headers.find(header => header.startsWith('Authorization: Bearer '));
    assert.ok(auth, `${call.url} has no bearer token`);
    assert.ok(!call.args.some(arg => arg.includes('Bearer')), 'the JWT is not in curl\'s arguments, which ps shows');
    const [header, payload, signature] = auth.slice('Authorization: Bearer '.length).split('.');
    const verify = createVerify('RSA-SHA256');
    verify.update(`${header}.${payload}`);
    assert.ok(verify.verify(publicKey, Buffer.from(signature, 'base64url')), 'the JWT signature verifies');
    assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), {alg: 'RS256', typ: 'JWT'});
    const claims = JSON.parse(Buffer.from(payload, 'base64url'));
    assert.equal(claims.iss, '12345');
    const now = Math.floor(Date.now() / 1000);
    assert.ok(claims.iat <= now && claims.iat >= now - 120, `iat ${claims.iat} is just before now`);
    assert.equal(claims.exp - claims.iat, 600);
  }
});

test('reuses a cached token that expires more than ten minutes from now, without calling curl', t => {
  const r = appSetup(t);
  r.writeCache({token: 'ghs_cached', expires_at: iso(1800)});
  const result = r.token();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'ghs_cached\n');
  assert.deepEqual(r.calls(), []);
});

test('re-mints a cached token that is expired or within ten minutes of expiry', t => {
  for (const seconds of [-60, 540]) {
    const r = appSetup(t);
    r.writeCache({token: 'ghs_old', expires_at: iso(seconds)});
    const result = r.token();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'ghs_minted\n');
    assert.equal(JSON.parse(readFileSync(r.cache, 'utf8')).token, 'ghs_minted');
  }
});

test('treats a corrupt cache as expired and re-mints', t => {
  for (const record of ['not json', '{"token":null,"expires_at":null}', JSON.stringify({token: '', expires_at: iso(3600)}),
    JSON.stringify({token: 'ghs_x', expires_at: 'not a date'}), JSON.stringify({token: 'two\nlines', expires_at: iso(3600)})]) {
    const r = appSetup(t);
    r.writeCache(record);
    const result = r.token();
    assert.equal(result.status, 0, `${record}: ${result.stderr}`);
    assert.equal(result.stdout, 'ghs_minted\n', record);
  }
});

test('answers git credential get, and does nothing for store, erase or any other action', t => {
  const r = appSetup(t);
  for (const args of [['git-credential'], ['git-credential', 'get']]) {
    const result = r.token(args, 'protocol=https\nhost=github.com\n\n');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'username=x-access-token\npassword=ghs_minted\n');
  }
  rmSync(r.cache);
  const before = r.calls().length;
  for (const action of ['store', 'erase', 'something-new']) {
    const result = r.token(['git-credential', action], 'protocol=https\nhost=github.com\nusername=x\npassword=y\n\n');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
  assert.equal(r.calls().length, before, 'store and erase never mint');
  assert.equal(existsSync(r.cache), false);
});

test('refuses an argument it does not know, printing no token', t => {
  const r = appSetup(t);
  const result = r.token(['--help']);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /usage: github-app-token/);
  assert.deepEqual(r.calls(), []);
});

test('fails closed naming the file the owner fills in when app-id, owner or agents.pem is missing', t => {
  for (const name of ['app-id', 'owner', 'agents.pem']) {
    const r = appSetup(t);
    rmSync(join(r.config, name));
    const result = r.token();
    const path = join(r.config, name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    failedClosed(r, result, new RegExp(`${path} is missing; the owner fills it in \\(bin/README\\.md, Install\\)`));
    assert.deepEqual(r.calls(), []);
  }
});

test('fails closed naming the key file when it is unreadable', {skip: process.getuid?.() === 0 && 'root reads any file'}, t => {
  const r = appSetup(t);
  chmodSync(r.key, 0o000);
  const result = r.token();
  failedClosed(r, result, /agents\.pem is not a readable file; the owner fills it in \(bin\/README\.md, Install\), mode 600/);
  assert.deepEqual(r.calls(), []);
});

test('fails closed when the key is not a private key, before any request', t => {
  const r = appSetup(t);
  writeFileSync(r.key, 'not a key\n');
  failedClosed(r, r.token(), /openssl could not sign with .*agents\.pem; it must be the App's private key in PEM form/);
  assert.deepEqual(r.calls(), []);
});

test('fails closed when app-id or owner holds something else than an id or a login', t => {
  for (const [name, content, message] of [['app-id', '12"345\n', /app-id must hold the App's numeric id/],
    ['owner', '\n', /owner must hold the login of the account the App is installed on/]]) {
    const r = appSetup(t);
    writeFileSync(join(r.config, name), content);
    failedClosed(r, r.token(), message);
  }
});

test('fails closed naming the step when the installations request fails, and keeps the old cache', t => {
  const r = appSetup(t);
  const old = JSON.stringify({token: 'ghs_old', expires_at: iso(60)});
  r.writeCache(old);
  r.respond({[installationsUrl]: {stderr: 'curl: (22) The requested URL returned error: 401\n', exit: 22}});
  const result = r.token(['git-credential', 'get']);
  failedClosed(r, result, /listing the App's installations failed \(GET https:\/\/api\.github\.com\/app\/installations\); check app-id and agents\.pem/, old);
  assert.match(result.stderr, /returned error: 401/);
});

test('fails closed when the App is not installed for the owner', t => {
  for (const body of [[{id: 40, account: {login: 'someone-else'}}], [], {message: 'Bad credentials'}, 'not json']) {
    const r = appSetup(t);
    r.respond({[installationsUrl]: {stdout: typeof body === 'string' ? body : JSON.stringify(body)}});
    failedClosed(r, r.token(), /the App is not installed for test-owner; install it on that account or correct .*\/owner/);
    assert.equal(r.calls().length, 1);
  }
});

test('fails closed naming the step when the access_tokens request fails', t => {
  const r = appSetup(t);
  r.respond({[tokensUrl]: {stderr: 'curl: (22) The requested URL returned error: 403\n', exit: 22}});
  failedClosed(r, r.token(), /minting an installation token failed \(POST https:\/\/api\.github\.com\/app\/installations\/41\/access_tokens\)/);
});

test('never caches or prints an access_tokens response without a token or expiry', t => {
  for (const response of [{stdout: '{}'}, {stdout: '{"token":null,"expires_at":null}'}, minted(''), minted('ghs_x', ''),
    minted('ghs_x', 'soon'), minted('ghs x'), {stdout: 'not json'}]) {
    const r = appSetup(t);
    const old = JSON.stringify({token: 'ghs_old', expires_at: iso(-60)});
    r.writeCache(old);
    r.respond({[tokensUrl]: response});
    failedClosed(r, r.token(), /GitHub's access_tokens response had no token or expiry; the cache is unchanged/, old);
  }
});

test("the key's contents never appear in output, the cache directory or the requests", t => {
  const r = appSetup(t);
  const outputs = [r.token(), r.token(['git-credential', 'get'])];
  writeFileSync(join(r.config, 'owner'), 'nobody\n');
  rmSync(r.cache);
  outputs.push(r.token());
  const cacheDir = join(r.cache, '..');
  const seen = [...outputs.flatMap(result => [result.stdout, result.stderr]),
    ...readdirSync(cacheDir).map(name => readFileSync(join(cacheDir, name), 'utf8')),
    JSON.stringify(r.calls())].join('\n');
  for (const line of r.keyLines()) assert.ok(!seen.includes(line), 'a line of the key leaked');
});

// The gh wrapper, linked into a bin directory as the install does, ahead of a fake gh that records its GH_TOKEN and
// arguments.
function ghSetup(t) {
  const r = appSetup(t);
  const linked = join(r.root, 'local-bin');
  const realBin = join(r.root, 'real-bin');
  mkdirSync(linked);
  mkdirSync(realBin);
  symlinkSync(join(here, 'gh'), join(linked, 'gh'));
  const log = join(r.root, 'gh-log');
  writeFileSync(join(realBin, 'gh'), `#!/bin/sh\nprintf '%s|%s\\n' "$GH_TOKEN" "$*" >> '${log}'\n`, {mode: 0o755});
  const env = {...r.env, GH_TOKEN: 'from-the-caller', PATH: `${linked}:${r.bin}:${realBin}:${toolingEnv.PATH}`};
  return {...r, gh: (args, more = {}) => spawnSync(join(linked, 'gh'), args, {env: {...env, ...more}, encoding: 'utf8'}),
    ran: () => lines(log)};
}

test('the gh wrapper runs the next gh on PATH with the App token as GH_TOKEN', t => {
  const r = ghSetup(t);
  const result = r.gh(['pr', 'list', '--json', 'number']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(r.ran(), ['ghs_minted|pr list --json number']);
});

test('the gh wrapper runs nothing when no token can be had', t => {
  const r = ghSetup(t);
  rmSync(r.key);
  const result = r.gh(['pr', 'list']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /agents\.pem is missing/);
  assert.match(result.stderr, /no GitHub App token .*nothing ran/);
  assert.deepEqual(r.ran(), []);
});

test('the gh wrapper runs nothing when the only gh on PATH is itself', t => {
  const r = appSetup(t);
  const linked = join(r.root, 'local-bin');
  mkdirSync(linked);
  symlinkSync(join(here, 'gh'), join(linked, 'gh'));
  // Only bash and the tools the wrapper itself uses are on PATH, so no real gh is.
  const tools = join(r.root, 'tools');
  mkdirSync(tools);
  for (const tool of ['bash', 'readlink', 'dirname']) symlinkSync(run('sh', ['-c', `command -v ${tool}`]).trim(), join(tools, tool));
  const result = spawnSync(join(linked, 'gh'), ['pr', 'list'], {env: {...r.env, PATH: `${linked}:${here}:${tools}`}, encoding: 'utf8'});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no gh on PATH besides this wrapper/);
  assert.deepEqual(r.calls(), []);
});

// Two installations besides someone-else's: test-owner's (41, the owner file's account) and other-org's (42), each
// minting its own token.
const otherTokensUrl = `POST ${api}/installations/42/access_tokens`;
const twoAccounts = {
  [installationsUrl]: {stdout: JSON.stringify([...installations, {id: 42, account: {login: 'Other-Org'}}])},
  [tokensUrl]: minted('ghs_test_owner'),
  [otherTokensUrl]: minted('ghs_other_org'),
};
const credential = path => `protocol=https\nhost=github.com\n${path === undefined ? '' : `path=${path}\n`}\n`;
const password = token => `username=x-access-token\npassword=${token}\n`;

test("a gh session gets the token of the installation on GITHUB_APP_OWNER's account, or on the owner file's without it", t => {
  const r = ghSetup(t);
  r.respond(twoAccounts);
  for (const [more, token] of [[{GITHUB_APP_OWNER: 'other-org'}, 'ghs_other_org'], [{GITHUB_APP_OWNER: 'test-owner'}, 'ghs_test_owner'],
    [{}, 'ghs_test_owner']]) {
    const result = r.gh(['pr', 'list'], more);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(r.ran().at(-1), `${token}|pr list`, JSON.stringify(more));
  }
});

test("the gh wrapper takes the account from a -R or --repo argument before GITHUB_APP_OWNER", t => {
  const r = ghSetup(t);
  r.respond(twoAccounts);
  for (const args of [['pr', 'list', '-R', 'other-org/repo'], ['pr', 'list', '--repo', 'other-org/repo'],
    ['pr', 'list', '--repo=other-org/repo'], ['pr', 'list', '-Rother-org/repo'], ['pr', 'list', '-R', 'github.com/other-org/repo']]) {
    const result = r.gh(args, {GITHUB_APP_OWNER: 'test-owner'});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(r.ran().at(-1), `ghs_other_org|${args.join(' ')}`);
  }
  assert.equal(r.gh(['issue', 'view', '7', '-R', 'test-owner/repo'], {GITHUB_APP_OWNER: 'other-org'}).status, 0);
  assert.equal(r.ran().at(-1), 'ghs_test_owner|issue view 7 -R test-owner/repo');
});

test('git gets the token of the installation on the account in the path it asks about, then GITHUB_APP_OWNER, then the owner file', t => {
  const r = appSetup(t, twoAccounts);
  for (const [input, more, token] of [
    [credential('other-org/repo.git'), {}, 'ghs_other_org'],
    [credential('/other-org/repo'), {GITHUB_APP_OWNER: 'test-owner'}, 'ghs_other_org'],
    [credential('test-owner/repo.git'), {GITHUB_APP_OWNER: 'other-org'}, 'ghs_test_owner'],
    [credential(), {GITHUB_APP_OWNER: 'other-org'}, 'ghs_other_org'],
    [credential(), {}, 'ghs_test_owner'],
    ['protocol=https\nhost=example.com\npath=other-org/repo.git\n\n', {}, 'ghs_test_owner'],
  ]) {
    const result = r.token(['git-credential', 'get'], input, more);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, password(token), `${JSON.stringify(input)} ${JSON.stringify(more)}`);
  }
});

test("each installation's token is cached on its own, and one account's fresh token is never handed out for another", t => {
  const r = appSetup(t, twoAccounts);
  r.writeCache({token: 'ghs_cached_test_owner', expires_at: iso(1800)});
  const other = r.token([], '', {GITHUB_APP_OWNER: 'Other-Org'});
  assert.equal(other.status, 0, other.stderr);
  assert.equal(other.stdout, 'ghs_other_org\n');
  assert.deepEqual(r.calls().map(call => `${call.method} ${call.url}`), [installationsUrl, otherTokensUrl]);
  assert.equal(JSON.parse(readFileSync(r.cacheOf('other-org'), 'utf8')).token, 'ghs_other_org');
  assert.equal(statSync(r.cacheOf('other-org')).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(r.cache, 'utf8')).token, 'ghs_cached_test_owner');

  assert.equal(r.token([], '', {GITHUB_APP_OWNER: 'test-owner'}).stdout, 'ghs_cached_test_owner\n');
  assert.equal(r.token(['git-credential', 'get'], credential('other-org/repo.git')).stdout, password('ghs_other_org'));
  assert.equal(r.calls().length, 2, 'both cached tokens were reused');
});

test('a token cached before tokens were cached per installation is not used', t => {
  const r = appSetup(t);
  r.writeCache({token: 'ghs_single_cache', expires_at: iso(1800)}, join(r.cache, '..', 'token.json'));
  const result = r.token();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'ghs_minted\n');
});

test('a request for an account the App is not installed on fails naming the account, and caches nothing', t => {
  for (const [input, more, message] of [
    ['', {GITHUB_APP_OWNER: 'nobody-here'}, /the App is not installed for nobody-here; install it on that account or correct GITHUB_APP_OWNER/],
    [credential('nobody-here/repo.git'), {}, /the App is not installed for nobody-here; install it on that account or check the repository git asked about \(path=nobody-here\/repo\.git\)/],
  ]) {
    const r = appSetup(t, twoAccounts);
    failedClosed(r, r.token(input ? ['git-credential', 'get'] : [], input, more), message);
    assert.equal(existsSync(r.cacheOf('nobody-here')), false);
    assert.deepEqual(r.calls().map(call => `${call.method} ${call.url}`), [installationsUrl]);
  }
});

test('an account that is not a login fails closed before any request', t => {
  for (const [input, more, message] of [
    ['', {GITHUB_APP_OWNER: '../x'}, /GITHUB_APP_OWNER must be the login of an account the App is installed on, not \.\.\/x/],
    [credential('a b/repo.git'), {}, /git asked about path=a b\/repo\.git, whose first segment is not an account's login/],
  ]) {
    const r = appSetup(t, twoAccounts);
    failedClosed(r, r.token(input ? ['git-credential', 'get'] : [], input, more), message);
    assert.deepEqual(r.calls(), []);
  }
});
