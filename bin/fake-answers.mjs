// A command Triphammer tests put first on PATH that only needs canned answers (the doctor's dotnet, node, systemctl):
// `node fake-answers.mjs <dir> <arguments>`, installed by fixture.mjs's fakeCommand with this fake's name. It
// appends its arguments to <dir>/calls as a JSON array, then answers with the response in <dir>/answers.json whose key
// is the longest prefix of the space-joined arguments (the key '' matches every call): it prints `stdout` and `stderr`
// and exits with `exit` (default 0). A call no key matches fails with exit 127, as a missing command does.
import {appendFileSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

const [dir, ...args] = process.argv.slice(2);
appendFileSync(join(dir, 'calls'), `${JSON.stringify(args)}\n`);
const joined = args.join(' ');
const answers = JSON.parse(readFileSync(join(dir, 'answers.json'), 'utf8'));
const key = Object.keys(answers).filter(prefix => joined.startsWith(prefix)).sort((a, b) => b.length - a.length)[0];
const {stdout = '', stderr = '', exit = 0} = key === undefined ? {exit: 127} : answers[key];
process.stdout.write(stdout);
process.stderr.write(stderr);
process.exit(exit);
