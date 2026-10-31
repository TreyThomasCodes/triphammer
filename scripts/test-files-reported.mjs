// A node:test reporter for `npm run test:node` that fails the run when a test file it ran reported no summary of its
// own: one with no tests, or whose process ended before its report reached the runner (`process.exit` in a test, or
// output lost on the way). The runner counts such a file as one passing test, so without this a cut-short report would
// pass with a lower total. It writes nothing when every file reported, and otherwise names the files and sets exit 1.
import {relative, resolve} from 'node:path';

export default async function* testFilesReported(source) {
  const ran = new Set();
  const reported = new Set();
  for await (const {type, data} of source) {
    if (!data?.file) continue;
    const file = resolve(data.file);
    ran.add(file);
    if (type === 'test:summary') reported.add(file);
  }
  const missing = [...ran].filter(file => !reported.has(file)).sort();
  if (missing.length === 0) return;
  process.exitCode = 1;
  yield `These test files reported no summary of their own (no tests, or their report was cut short):\n${
    missing.map(file => `  ${relative(process.cwd(), file)}\n`).join('')}`;
}
