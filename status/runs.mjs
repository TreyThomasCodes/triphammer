// Run transcripts live in `<state>/runs/<UTC yyyymmddThhmmssZ>-<kind>-<number>.jsonl`. A run's name is that file name
// without `.jsonl`; it is the only part of a transcript URL, so it is validated strictly before touching the disk.
import fs from 'node:fs';

const namePattern = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-(ticket|repair)-(\d+)$/;

/**
 * Parses a run name, or returns null when it is not exactly the runner's pattern.
 * @param {string} name
 */
export function parseRunName(name) {
  const match = namePattern.exec(name);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, kind, number] = match;
  return {name, kind, number: Number(number), started: `${year}-${month}-${day}T${hour}:${minute}:${second}Z`};
}

/**
 * Every run in the runs directory, newest first. A missing directory is an empty list.
 * @param {string} runsDir
 */
export function listRuns(runsDir) {
  let files;
  try {
    files = fs.readdirSync(runsDir);
  } catch {
    return [];
  }
  return files
    .filter(file => file.endsWith('.jsonl'))
    .map(file => parseRunName(file.slice(0, -'.jsonl'.length)))
    .filter(run => run !== null)
    .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
}
