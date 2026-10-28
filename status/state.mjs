// Reads the shared directory and each project's state directory on each request, plus the two slow read-only commands the
// page shows per project (`gh` for titles and fresh labels, `ticket-runner --plan` for the next action), each behind a
// short cache.
import {execFile} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {pairRuns} from './log.mjs';
import {lockState} from './locks.mjs';
import {listRuns} from './runs.mjs';
import {fileBrakes, labelEventsQuery, labelNames, oldestFirst, parseLabelEvents, waitingRows} from './waiting.mjs';

/**
 * @typedef {{name: string, stateDir: string, runner: string, gh: string, repo: string, env?: NodeJS.ProcessEnv, procRoot?: string}} Config
 *          one project's: the runner is started with env, or the server's environment without it
 * @typedef {{sharedDir: string, runner: string, gh: string, procRoot?: string, projects: import('./config.mjs').Project[]}} AllConfig
 * @typedef {{titles: () => Promise<{value: Titles, at: number}>, plan: () => Promise<{value: CommandResult, at: number}>}} Commands
 * @typedef {{ok: true, stdout: string} | {ok: false, error: string}} CommandResult
 * @typedef {{type: 'issue' | 'pr', number: number, title: string | null, labels: string[], draft: boolean, attempts: number | null}} QueueItem
 * @typedef {{issues: CommandResult, prs: CommandResult, labelEvents?: CommandResult}} Titles
 */

/**
 * Runs a read-only command and never rejects.
 * @param {string} command
 * @param {string[]} args
 * @param {number} timeoutMs
 * @param {NodeJS.ProcessEnv} [env] the server's environment when not given
 * @returns {Promise<CommandResult>}
 */
export function run(command, args, timeoutMs, env) {
  return new Promise(resolve => {
    execFile(command, args, {timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env}, (error, stdout, stderr) => {
      if (error) {
        const reason = error.killed ? `timed out after ${timeoutMs / 1000} s` : error.message.split('\n')[0];
        resolve({ok: false, error: [reason, String(stderr).trim()].filter(Boolean).join('\n')});
      } else {
        resolve({ok: true, stdout: String(stdout)});
      }
    });
  });
}

/**
 * Caches an async load for `ttlMs`. After it expires the old value is still served while one refresh runs in the
 * background, so a slow command delays only the very first page.
 * @template T
 * @param {number} ttlMs
 * @param {() => Promise<T>} load must not reject
 * @param {() => number} [now]
 * @returns {() => Promise<{value: T, at: number}>}
 */
export function cached(ttlMs, load, now = Date.now) {
  /** @type {{value: T, at: number} | null} */
  let current = null;
  /** @type {Promise<{value: T, at: number}> | null} */
  let pending = null;
  return async () => {
    let refresh = pending;
    if (!refresh && (!current || now() - current.at >= ttlMs)) {
      refresh = pending = load().then(value => (current = {value, at: now()})).finally(() => { pending = null; });
    }
    return current ?? /** @type {Promise<{value: T, at: number}>} */ (refresh);
  };
}

/** @param {string} file */
function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The file's whole content as a non-negative integer, or null when it is missing or anything else.
 * @param {string} file
 */
function readCount(file) {
  const text = readText(file)?.trim();
  return text && /^\d+$/.test(text) ? Number(text) : null;
}

/** @param {string} file */
function readJson(file) {
  const text = readText(file);
  if (text === null) return null;
  try {
    return {value: JSON.parse(text), modified: fs.statSync(file).mtimeMs};
  } catch {
    return null;
  }
}

/** Log lines carry whole seconds, so a start line can read up to a second before the process that wrote it began. */
const startSlackMs = 2_000;
/** The runner stops a session after 6 h (`timeout 6h claude`), so an older start with no end was killed. */
const runLimitMs = 6 * 60 * 60 * 1000;

/**
 * Whether the latest start line with no end is the run in progress. A killed run leaves such a line too, and the runner
 * takes its lock on every timer start before it logs anything, so a held lock alone does not make that line current:
 * it must be no older than the process holding the lock. When that process's start time is unknown, or the lock table
 * is unreadable, only a start within the runner's 6 h limit counts.
 * @param {import('./log.mjs').LoggedRun | null} unended
 * @param {{held: boolean | null, holderStartMs: number | null}} lock
 * @param {number} nowMs
 */
function isCurrent(unended, lock, nowMs) {
  if (!unended || lock.held === false) return false;
  const started = Date.parse(unended.start.time ?? '');
  if (lock.holderStartMs !== null) return started >= lock.holderStartMs - startSlackMs;
  return nowMs - started <= runLimitMs;
}

/**
 * The log, whether a run is in progress, and every run with its outcome from the log. Cheap: files only.
 * @param {{stateDir: string, procRoot?: string}} config
 * @param {number} [nowMs]
 */
export function readRuns(config, nowMs = Date.now()) {
  const logLines = (readText(path.join(config.stateDir, 'log')) ?? '').split('\n').filter(line => line !== '');
  const lock = lockState(path.join(config.stateDir, 'lock'), config.procRoot);
  const held = lock.held;
  const outcomes = pairRuns(logLines);
  // The latest started run with no end line is only a candidate: a killed run also leaves a start with no end.
  const latest = [...outcomes.values()].at(-1);
  const unended = latest && !latest.end ? latest : null;
  const active = isCurrent(unended, lock, nowMs) ? unended : null;
  const activeName = active ? path.basename(active.start.transcript ?? '').replace(/\.jsonl$/, '') : null;
  const runs = listRuns(path.join(config.stateDir, 'runs'))
    .map(run => ({...run, log: outcomes.get(`${run.name}.jsonl`), active: run.name === activeName}));
  return {logLines, held, active, activeName, runs};
}

/**
 * A directory's stop file and backoff, Triphammer's or one project's.
 * @param {string} dir
 * @param {number} nowMs
 */
function readFileBrakes(dir, nowMs) {
  const stopFile = modified(path.join(dir, 'stop'));
  const backoffSeconds = readCount(path.join(dir, 'backoff'));
  const backoffUntil = backoffSeconds === null ? null : backoffSeconds * 1000;
  const backoffActive = backoffUntil !== null && backoffUntil > nowMs;
  const backoff = backoffActive ? {until: backoffUntil, since: modified(path.join(dir, 'backoff'))} : null;
  return {stopFile, backoffUntil, backoffActive, backoff, paused: stopFile !== null || backoffActive};
}

/**
 * Builds the read-only view of one project's state directory. Commands are passed in so tests and the server share
 * this code. Throws when the state directory cannot be read.
 * @param {Config} config
 * @param {Commands} commands
 * @param {number} [nowMs]
 * @param {boolean} [allPaused] whether the shared stop file or backoff pauses every project
 */
async function readState(config, commands, nowMs = Date.now(), allPaused = false) {
  try {
    fs.readdirSync(config.stateDir);
  } catch (error) {
    throw new Error(`cannot read the state directory ${config.stateDir}: ${error instanceof Error ? error.message : error}`);
  }
  const {logLines, held, active, activeName, runs} = readRuns(config, nowMs);
  const files = readFileBrakes(config.stateDir, nowMs);
  const {backoffUntil, backoffActive} = files;
  const {queue, gh} = await readQueue(config, commands);
  const stopFile = files.stopFile !== null;
  const stopAgents = queue.items.filter(item => item.type === 'issue' && item.labels.some(label => label.toLowerCase() === 'stop-agents')).map(item => item.number);
  const paused = allPaused || files.paused || stopAgents.length > 0;
  // A run counts as in progress, here and on the page, when the lock is held, or the lock table is unreadable and the
  // log has a start with no end.
  const running = held === true || active !== null;
  // The plan is not asked for while paused (the runner logs "paused" every time it starts while stop-agents is set) nor
  // while running: it would only name the running ticket, and --plan rewrites issues.json and prs.json and fetches the
  // main checkout, which can collide with the run.
  /** @type {'paused' | 'running' | Awaited<ReturnType<typeof commands.plan>>} */
  const plan = paused ? 'paused' : running ? 'running' : await commands.plan();
  // Without gh, only the local brakes are known: the runner's files can predate any label, so nothing else is listed.
  const labelEvents = parseLabelEvents(gh?.labelEvents);
  const {brakes, rows} = waitingRows({issues: gh?.issues ?? [], prs: gh?.prs ?? [], ...labelEvents, stopFile: files.stopFile, backoff: files.backoff});

  return {
    now: {held, active, activeName, running, allPaused, stopFile, backoffUntil, backoffActive, stopAgents, stopAgentsKnown: queue.source === 'gh'},
    waiting: {brakes, rows, known: gh !== null, labelTimesKnown: labelEvents.labelTimes !== null},
    log: logLines.slice(-50).reverse(),
    runs,
    queue,
    plan,
  };
}

/**
 * Builds the read-only view of every project: its own brakes, one "Waiting on you" list across the projects, and each
 * project's state, or the error that keeps it from being read, which never hides the others.
 * @param {AllConfig} config
 * @param {Map<string, Commands>} commands by project name
 * @param {number} [nowMs]
 */
export async function readAll(config, commands, nowMs = Date.now()) {
  const shared = readFileBrakes(config.sharedDir, nowMs);
  const projects = await Promise.all(config.projects.map(async project => {
    if (!project.ok) return {name: project.name, error: project.error};
    const projectConfig = {...project, runner: config.runner, gh: config.gh, procRoot: config.procRoot};
    try {
      const state = await readState(projectConfig, /** @type {Commands} */ (commands.get(project.name)), nowMs, shared.paused);
      return {name: project.name, repo: project.repo, state};
    } catch (error) {
      return {name: project.name, error: error instanceof Error ? error.message : String(error)};
    }
  }));
  /** @typedef {import('./waiting.mjs').WaitingRow & {project: string | null, repo: string | null}} WaitingEntry */
  /** @type {WaitingEntry[]} */
  const brakes = [];
  /** @type {WaitingEntry[]} */
  const rows = [];
  for (const project of projects) {
    if (!project.state) continue;
    const label = {project: project.name, repo: project.repo};
    brakes.push(...project.state.waiting.brakes.map(row => ({...row, ...label})));
    rows.push(...project.state.waiting.rows.map(row => ({...row, ...label})));
  }
  const sharedBrakes = fileBrakes(shared, 'shared').map(row => ({...row, project: null, repo: null}));
  return {
    // Triphammer's brakes come first and once, then every project's brakes, then the rest, each oldest waiting first.
    waiting: [...sharedBrakes, ...brakes.sort(oldestFirst), ...rows.sort(oldestFirst)],
    projects,
  };
}

/** @param {string} file */
function modified(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Open issues and pull requests, with their titles and labels, from `gh`; from the runner's issues.json and prs.json
 * only when `gh` fails. The files cannot be trusted for brakes even when fresh: the runner exits on `stop-agents`
 * before rewriting them, so they keep the labels from before the brake.
 * @param {Config} config
 * @param {{titles: () => Promise<{value: Titles, at: number}>}} commands
 */
async function readQueue(config, commands) {
  const issuesFile = readJson(path.join(config.stateDir, 'issues.json'));
  const prsFile = readJson(path.join(config.stateDir, 'prs.json'));
  const titles = await commands.titles();
  const ghIssues = parseList(titles.value.issues);
  const ghPrs = parseList(titles.value.prs);
  const filesModified = Math.min(issuesFile?.modified ?? 0, prsFile?.modified ?? 0);
  const useGh = ghIssues !== null && ghPrs !== null;

  /** @type {Map<number, string>} */
  const titleOf = new Map();
  for (const item of [...(ghIssues ?? []), ...(ghPrs ?? [])]) titleOf.set(Number(item.number), String(item.title ?? ''));

  const issues = (useGh ? ghIssues : (issuesFile?.value ?? []).filter((/** @type {any} */ issue) => issue?.state === 'OPEN')) ?? [];
  const prs = (useGh ? ghPrs : prsFile?.value) ?? [];
  /** @type {QueueItem[]} */
  const items = [
    ...issues.map((/** @type {any} */ issue) => item('issue', issue, titleOf, config.stateDir, 'ticket')),
    ...prs.map((/** @type {any} */ pr) => item('pr', pr, titleOf, config.stateDir, 'repair')),
  ].sort((a, b) => a.number - b.number);

  const errors = [titles.value.issues, titles.value.prs].flatMap(result => (result.ok ? [] : [result.error]));
  return {
    queue: {
      items,
      source: useGh ? 'gh' : 'files',
      filesModified: filesModified || null,
      errors,
    },
    gh: useGh ? {issues: ghIssues, prs: ghPrs, labelEvents: titles.value.labelEvents} : null,
  };
}

/** @param {CommandResult} result */
function parseList(result) {
  if (!result.ok) return null;
  try {
    const list = JSON.parse(result.stdout);
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

/**
 * @param {'issue' | 'pr'} type
 * @param {any} raw
 * @param {Map<number, string>} titleOf
 * @param {string} stateDir
 * @param {string} attemptKind
 * @returns {QueueItem}
 */
function item(type, raw, titleOf, stateDir, attemptKind) {
  const number = Number(raw?.number);
  return {
    type,
    number,
    title: titleOf.get(number) ?? null,
    labels: labelNames(raw),
    draft: raw?.isDraft === true,
    attempts: readCount(path.join(stateDir, 'attempts', `${attemptKind}-${number}`)),
  };
}

/**
 * One project's cached commands: titles every 60 s, the plan every 120 s. The titles load also brings what the
 * "Waiting on you" list needs: issue bodies, each pull request's checks and auto-merge, label event times and owner-approval statuses.
 * @param {Config} config
 * @returns {Commands}
 */
export function commandsFor(config) {
  const [owner, name] = config.repo.split('/');
  return {
    titles: cached(60_000, async () => {
      const prFields = 'number,title,labels,isDraft,createdAt,baseRefName,autoMergeRequest,mergeStateStatus,statusCheckRollup';
      const [issues, prs, labelEvents] = await Promise.all([
        run(config.gh, ['issue', 'list', '-R', config.repo, '--state', 'open', '--limit', '300', '--json', 'number,title,labels,body,createdAt'], 20_000),
        run(config.gh, ['pr', 'list', '-R', config.repo, '--state', 'open', '--limit', '50', '--json', prFields], 20_000),
        run(config.gh, ['api', 'graphql', '-f', `query=${labelEventsQuery}`, '-f', `owner=${owner}`, '-f', `name=${name}`], 20_000),
      ]);
      return {issues, prs, labelEvents};
    }),
    plan: cached(120_000, () => run(config.runner, ['--plan'], 90_000, config.env)),
  };
}
