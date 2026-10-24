// The `gh` Triphammer tests put first on PATH (see fakeGh in fixture.mjs): `node fake-gh.mjs <dir> <gh arguments>`.
// It appends its arguments to <dir>/calls as a JSON array, then answers with the response in <dir>/routes.json whose key
// is the longest prefix of the space-joined arguments. A response prints `stdout` and `stderr` and exits with `exit`
// (default 0); or it prints `file` from <dir>, through `jq -r` when the call passes `--jq` as gh would, and fails
// when the file is missing. In a file name, `{repo}` is the -R/--repo value with `/` as `_`, and `{key}` is the value
// of a `key=value` argument; either is empty when the call has none. A call no key matches succeeds silently.
import {spawnSync} from 'node:child_process';
import {appendFileSync, existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

const [dir, ...args] = process.argv.slice(2);
appendFileSync(join(dir, 'calls'), `${JSON.stringify(args)}\n`);

const joined = args.join(' ');
const routes = JSON.parse(readFileSync(join(dir, 'routes.json'), 'utf8'));
const key = Object.keys(routes).filter(prefix => joined.startsWith(prefix)).sort((a, b) => b.length - a.length)[0];
const {stdout = '', stderr = '', exit = 0, file} = key === undefined ? {} : routes[key];
process.stdout.write(stdout);
process.stderr.write(stderr);
if (file === undefined) process.exit(exit);

const valueAfter = (...flags) => {
  const at = args.findIndex(arg => flags.includes(arg));
  return at < 0 ? undefined : args[at + 1];
};
const fields = {repo: valueAfter('-R', '--repo')?.replace('/', '_')};
for (const arg of args.filter(arg => /^\w+=/.test(arg))) fields[arg.slice(0, arg.indexOf('='))] = arg.slice(arg.indexOf('=') + 1);
const path = join(dir, file.replace(/\{(\w+)\}/g, (_, name) => fields[name] ?? ''));
if (!existsSync(path)) {
  console.error(`fake gh: no ${path} for ${joined}`);
  process.exit(1);
}
const jq = valueAfter('--jq');
if (jq === undefined) process.stdout.write(readFileSync(path, 'utf8'));
else process.exit(spawnSync('jq', ['-r', jq, path], {stdio: 'inherit'}).status ?? 1);
