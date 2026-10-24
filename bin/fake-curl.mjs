// The `curl` the github-app-token tests put first on PATH: `node fake-curl.mjs <dir> <curl arguments>`. It appends
// {method, url, headers, args} to <dir>/calls as a JSON line, the headers taken from -H arguments and from a `-K -`
// config on stdin (`header = "..."` lines), then answers with the response in <dir>/routes.json keyed by `<method> <url>`: it
// prints `stdout` and `stderr` and exits with `exit` (default 0). A call no key matches fails as a 404 does under -f.
import {appendFileSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

const [dir, ...args] = process.argv.slice(2);
const headers = [];
let method = 'GET';
let url;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '-H') headers.push(args[++i]);
  else if (arg === '-X') method = args[++i];
  else if (arg === '-K') {
    const source = args[++i];
    const config = readFileSync(source === '-' ? 0 : source, 'utf8');
    for (const match of config.matchAll(/^header = "(.*)"$/gm)) headers.push(match[1]);
  } else if (!arg.startsWith('-')) url = arg;
}
appendFileSync(join(dir, 'calls'), `${JSON.stringify({method, url, headers, args})}\n`);

const routes = JSON.parse(readFileSync(join(dir, 'routes.json'), 'utf8'));
const notFound = {stderr: 'curl: (22) The requested URL returned error: 404\n', exit: 22};
const {stdout = '', stderr = '', exit = 0} = routes[`${method} ${url}`] ?? notFound;
process.stdout.write(stdout);
process.stderr.write(stderr);
process.exit(exit);
