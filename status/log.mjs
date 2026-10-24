// Reads the ticket runner's log (`<state>/log`). Each line is `<UTC ISO time> <message>`; the messages come from
// ticket-runner's `log` calls. Runs are matched to their outcome here so the page can show an exit status per transcript.
import path from 'node:path';

const linePattern = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) (.*)$/;
const runPattern = /^(ticket|repair) #(\d+)(?: \(([^)]*)\))?: (.*)$/;

/**
 * @typedef {{event: string, time?: string, kind?: string, number?: number, reason?: string | null,
 *   attempt?: number, attempts?: number, exit?: number, transcript?: string}} LogEntry
 * @typedef {{start: LogEntry, end: LogEntry | null}} LoggedRun
 */

/**
 * Parses one log line into an event. Unknown messages and lines without a timestamp become `{event: 'other'}`.
 * @param {string} line
 * @returns {LogEntry}
 */
export function parseLogLine(line) {
  const stamped = linePattern.exec(line);
  const run = stamped && runPattern.exec(stamped[2]);
  if (!run) return {event: 'other'};
  const [, kind, number, reason, rest] = run;
  const base = {time: stamped[1], kind, number: Number(number), reason: reason ?? null};
  let match;
  if ((match = /^run (\d+) of (\d+) starting; transcript (.+)$/.exec(rest))) {
    return {...base, event: 'start', attempt: Number(match[1]), attempts: Number(match[2]), transcript: match[3]};
  }
  if ((match = /^run (\d+) finished \(exit (\d+)\)$/.exec(rest))) {
    return {...base, event: 'finished', attempt: Number(match[1]), exit: Number(match[2])};
  }
  if ((match = /^run (\d+) ended without progress \(exit (\d+)\)$/.exec(rest))) {
    return {...base, event: 'no-progress', attempt: Number(match[1]), exit: Number(match[2])};
  }
  if (rest.startsWith('stopped by a usage or rate limit')) return {...base, event: 'rate-limit'};
  return {...base, event: 'other'};
}

/**
 * Pairs every `starting` line with the end line that follows it for the same kind, number and attempt (a rate-limit
 * end carries no attempt, so it closes the latest open start of that kind and number). A start the runner never ended,
 * such as a killed run, keeps `end: null`. Returns runs keyed by transcript file name.
 * @param {string[]} lines
 * @returns {Map<string, LoggedRun>}
 */
export function pairRuns(lines) {
  /** @type {Map<string, LoggedRun>} */
  const runs = new Map();
  /** @type {LoggedRun[]} */
  const open = [];
  for (const line of lines) {
    const entry = parseLogLine(line);
    if (entry.event === 'start') {
      /** @type {LoggedRun} */
      const run = {start: entry, end: null};
      runs.set(path.basename(entry.transcript ?? ''), run);
      open.push(run);
    } else if (entry.event === 'finished' || entry.event === 'no-progress' || entry.event === 'rate-limit') {
      for (let i = open.length - 1; i >= 0; i--) {
        const start = open[i].start;
        if (start.kind === entry.kind && start.number === entry.number
            && (entry.event === 'rate-limit' || start.attempt === entry.attempt)) {
          open[i].end = entry;
          open.splice(i, 1);
          break;
        }
      }
    }
  }
  return runs;
}

/**
 * A short human label for a run's outcome.
 * @param {LoggedRun | undefined} run
 * @param {boolean} active
 */
export function outcomeLabel(run, active) {
  if (active) return 'running';
  if (!run) return 'not in log';
  if (!run.end) return 'no end recorded';
  switch (run.end.event) {
    case 'finished': return `finished (exit ${run.end.exit})`;
    case 'no-progress': return `no progress (exit ${run.end.exit})`;
    default: return 'rate limited';
  }
}
