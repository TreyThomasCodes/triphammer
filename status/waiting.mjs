// The "Waiting on you" list: everything the pipeline cannot move without the owner, built from the same cached `gh`
// answers as the queue. Whether a pull request waits for the owner's approval is what the risk-tier workflow posted as
// the head commit's owner-approval status, never a tier worked out again here; "armed" and "clean" mean what they mean to
// bin/merge-when-ready (a bash script, so its rules are matched here, not imported), except that an unarmed pull
// request behind its base counts as green when every check on its head passed.

/**
 * @typedef {string | {href: string, text: string}} NotePart text, or a link to a page on github.com
 * @typedef {string | NotePart[]} Note
 * @typedef {{type: 'brake' | 'issue' | 'pr', number: number | null, title: string | null, notes: Note[], since: number | null}} WaitingRow
 * @typedef {Map<number, Map<string, number>>} LabelTimes when each open issue or pull request last got each label
 * @typedef {Map<number, {state: string, description: string, targetUrl: string | null}>} OwnerApprovals the
 *          owner-approval status on each open pull request's head commit, for those that have one; targetUrl is the
 *          risk-tier run it links to
 */

const decisionMarker = '**Decision for the owner:**';
const decisionLength = 300;

/**
 * The first sentence after `**Decision for the owner:**`, whitespace collapsed, or null when the body has none.
 * @param {unknown} body
 */
export function decisionText(body) {
  const text = String(body ?? '');
  const at = text.indexOf(decisionMarker);
  if (at < 0) return null;
  // The decision ends at the first sentence end or at a blank line, whichever comes first.
  const rest = text.slice(at + decisionMarker.length).split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim();
  const sentence = /^.*?[.?!](?=\s|$)/.exec(rest)?.[0] ?? rest;
  if (!sentence) return null;
  return sentence.length > decisionLength ? `${sentence.slice(0, decisionLength)}…` : sentence;
}

/**
 * The value when it is an http(s) URL on github.com, else null: only such a link is put on the page.
 * @param {unknown} value
 */
function githubUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname === 'github.com' && !url.username && !url.password ? value : null;
  } catch {
    return null;
  }
}

/** @param {unknown} value */
function time(value) {
  const ms = Date.parse(String(value ?? ''));
  // GitHub reports an unfinished check's completedAt as 0001-01-01.
  return Number.isNaN(ms) || ms <= 0 ? null : ms;
}

/** @param {any} item */
export const labelNames = item => (Array.isArray(item?.labels) ? item.labels.map((/** @type {any} */ label) => String(label?.name ?? '')) : []);

/**
 * The item's label names in lower case, for comparing: GitHub matches label names in any case, and so does the runner.
 * @param {any} item
 */
const lowerLabelNames = item => labelNames(item).map(name => name.toLowerCase());

/**
 * When the item got the label, from the label events; when they are unknown, when the item was created.
 * @param {any} item
 * @param {string} label
 * @param {LabelTimes | null} labelTimes
 */
function labelledSince(item, label, labelTimes) {
  return labelTimes?.get(Number(item.number))?.get(label) ?? time(item.createdAt);
}

/**
 * When the head's checks last finished or reported: how long a green pull request has been sitting.
 * @param {any} pr
 */
function checksSettled(pr) {
  const times = (Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [])
    .map((/** @type {any} */ check) => time(check?.completedAt) ?? time(check?.startedAt))
    .filter((/** @type {number | null} */ ms) => ms !== null);
  return times.length ? Math.max(...times) : time(pr.createdAt);
}

/**
 * Whether every check on the head passed, judged as merge-when-ready judges a pull request it would update: only the
 * latest run of each check counts, a check passes on SUCCESS, NEUTRAL or SKIPPED and a status on SUCCESS, and a pending
 * or failed one (the owner-approval status of an escalated head among them) does not. `gh pr list` does not say which
 * checks are required, so every check counts; a head with no checks has not passed.
 * @param {any} pr
 */
function checksPassed(pr) {
  const checks = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
  /** @type {Map<string, {at: number, passed: boolean}>} */
  const latest = new Map();
  for (const check of checks) {
    const name = String(check?.name ?? check?.context ?? '');
    const passed = check?.__typename === 'StatusContext'
      ? check?.state === 'SUCCESS'
      : check?.status === 'COMPLETED' && ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(check?.conclusion);
    // A check that has not passed and has no start time counts as the newest, as a pending one does in merge-when-ready.
    const at = time(check?.startedAt) ?? (passed ? -Infinity : Infinity);
    const seen = latest.get(name);
    if (!seen || at >= seen.at) latest.set(name, {at, passed});
  }
  return latest.size > 0 && [...latest.values()].every(check => check.passed);
}

/** @param {(number | null)[]} times */
const earliest = times => {
  const known = /** @type {number[]} */ (times.filter(ms => ms !== null && Number.isFinite(ms)));
  return known.length ? Math.min(...known) : null;
};

/**
 * One row per open pull request that waits on the owner, or null.
 * @param {any} pr
 * @param {LabelTimes | null} labelTimes
 * @param {OwnerApprovals | null} ownerApprovals
 * @param {string | null} defaultBranch
 * @returns {WaitingRow | null}
 */
function prRow(pr, labelTimes, ownerApprovals, defaultBranch) {
  const number = Number(pr.number);
  const labels = lowerLabelNames(pr);
  const notes = [];
  /** @type {(number | null)[]} */
  const since = [];
  for (const label of ['hold', 'needs-owner'].filter(name => labels.includes(name))) {
    notes.push(`labelled ${label}`);
    since.push(labelledSince(pr, label, labelTimes));
  }
  // merge-when-ready only takes pull requests into the default branch; drafts can be neither approved to land nor armed.
  const landable = pr.isDraft !== true && (defaultBranch === null || pr.baseRefName === defaultBranch);
  // The risk-tier workflow leaves owner-approval pending with an "Escalate:" description only once it has classified
  // the head as escalate and found no approval that covers it (.github/workflows/risk-tier.yml). Any other description
  // (still classifying, held, auto, blocked) or no status yet is not a request for the owner's approval.
  const approval = ownerApprovals?.get(number);
  if (landable && approval?.state === 'PENDING' && approval.description.startsWith('Escalate:')) {
    // The tier's reasons are only in the risk-tier run's step summary, which the status links to.
    const reasons = 'reasons in the risk-tier run';
    notes.push(['escalate, no owner approval: ', approval.targetUrl ? {href: approval.targetUrl, text: reasons} : reasons, ` · ${approval.description}`]);
    since.push(labels.includes('needs-owner') ? labelledSince(pr, 'needs-owner', labelTimes) : time(pr.createdAt));
  }
  // merge-when-ready: "armed" is auto-merge enabled, and it merges an armed pull request whose merge state is CLEAN.
  // A held one it skips, so a held one is not asked to be armed. It brings only armed pull requests up to date, so an
  // unarmed one goes BEHIND whenever the default branch moves; that one is green when every check on its head passed.
  const green = pr.mergeStateStatus === 'CLEAN' || (pr.mergeStateStatus === 'BEHIND' && checksPassed(pr));
  if (landable && !labels.includes('hold') && pr.autoMergeRequest == null && green) {
    notes.push(`green, not armed: arm with \`gh pr merge ${number} --auto --squash\``);
    since.push(checksSettled(pr));
  }
  if (!notes.length) return null;
  return {type: 'pr', number, title: pr.title == null ? null : String(pr.title), notes, since: earliest(since)};
}

/** @param {WaitingRow} a @param {WaitingRow} b */
export const oldestFirst = (a, b) => (a.since ?? Infinity) - (b.since ?? Infinity) || (a.number ?? 0) - (b.number ?? 0);

/**
 * The brake rows of a stop file and a backoff, Triphammer's or one project's.
 * @param {{stopFile: number | null, backoff: {until: number, since: number | null} | null}} files stopFile is the stop
 *        file's modification time when it is present; backoff only when it is in force
 * @param {'shared' | 'project'} whose
 * @returns {WaitingRow[]}
 */
export function fileBrakes(files, whose) {
  /** @type {WaitingRow[]} */
  const brakes = [];
  if (files.stopFile !== null) {
    const note = whose === 'shared'
      ? 'Triphammer\'s stop file is present: every project\'s runner and merge-when-ready are paused'
      : 'the stop file is present: the runner and merge-when-ready are paused';
    brakes.push({type: 'brake', number: null, title: null, notes: [note], since: files.stopFile});
  }
  if (files.backoff) {
    const until = `backoff until ${new Date(files.backoff.until).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    brakes.push({type: 'brake', number: null, title: null, notes: [whose === 'shared' ? `${until}: every project is paused` : until], since: files.backoff.since});
  }
  return brakes;
}

/**
 * One project's rows: its brakes (its stop file, its backoff in force and each open stop-agents issue) and the rest,
 * each oldest waiting first; a row whose waiting time is unknown goes last.
 * @param {{issues: any[], prs: any[], labelTimes: LabelTimes | null, ownerApprovals: OwnerApprovals | null,
 *          defaultBranch: string | null, stopFile: number | null, backoff: {until: number, since: number | null} | null}} input
 * @returns {{brakes: WaitingRow[], rows: WaitingRow[]}}
 */
export function waitingRows(input) {
  const brakes = fileBrakes(input, 'project');
  /** @type {WaitingRow[]} */
  const rows = [];
  for (const issue of input.issues) {
    const labels = lowerLabelNames(issue);
    const number = Number(issue.number);
    const title = issue.title == null ? null : String(issue.title);
    if (labels.includes('stop-agents')) {
      brakes.push({type: 'issue', number, title, notes: ['labelled stop-agents: the agents are paused'], since: labelledSince(issue, 'stop-agents', input.labelTimes)});
    } else if (labels.includes('needs-owner')) {
      rows.push({type: 'issue', number, title, notes: [decisionText(issue.body) ?? title ?? ''], since: labelledSince(issue, 'needs-owner', input.labelTimes)});
    }
  }
  for (const pr of input.prs) {
    const row = prRow(pr, input.labelTimes, input.ownerApprovals, input.defaultBranch);
    if (row) rows.push(row);
  }
  return {brakes: brakes.sort(oldestFirst), rows: rows.sort(oldestFirst)};
}

/**
 * Parses the label-event query's answer (see commandsFor in state.mjs) into when each item last got each label, the
 * owner-approval status on each open pull request's head, and the default branch. Null for anything unreadable.
 * @param {{ok: true, stdout: string} | {ok: false, error: string} | undefined} result
 * @returns {{labelTimes: LabelTimes | null, ownerApprovals: OwnerApprovals | null, defaultBranch: string | null}}
 */
export function parseLabelEvents(result) {
  const unknown = {labelTimes: null, ownerApprovals: null, defaultBranch: null};
  if (!result?.ok) return unknown;
  let repository;
  try {
    repository = JSON.parse(result.stdout)?.data?.repository;
  } catch {
    return unknown;
  }
  if (!repository) return unknown;
  /** @type {LabelTimes} */
  const labelTimes = new Map();
  for (const node of [...(repository.issues?.nodes ?? []), ...(repository.pullRequests?.nodes ?? [])]) {
    /** @type {Map<string, number>} */
    const times = new Map();
    for (const event of node?.timelineItems?.nodes ?? []) {
      const at = time(event?.createdAt);
      const name = typeof event?.label?.name === 'string' ? event.label.name.toLowerCase() : null;
      if (at !== null && name !== null && at > (times.get(name) ?? 0)) times.set(name, at);
    }
    labelTimes.set(Number(node?.number), times);
  }
  /** @type {OwnerApprovals | null} */
  const ownerApprovals = Array.isArray(repository.approvals?.nodes) ? new Map() : null;
  for (const node of repository.approvals?.nodes ?? []) {
    const status = node?.commits?.nodes?.[0]?.commit?.status?.context;
    if (typeof status?.state === 'string') {
      ownerApprovals?.set(Number(node?.number), {state: status.state, description: String(status.description ?? ''), targetUrl: githubUrl(status.targetUrl)});
    }
  }
  const defaultBranch = typeof repository.defaultBranchRef?.name === 'string' ? repository.defaultBranchRef.name : null;
  return {labelTimes, ownerApprovals, defaultBranch};
}

/**
 * The GraphQL query for label events (open issues and pull requests carrying a label the list shows by its time) and
 * for the owner-approval status the risk-tier workflow posted on each open pull request's head commit, with its
 * description and the run it links to, which `gh pr list` leaves out.
 */
export const labelEventsQuery = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    issues(states: OPEN, labels: ["needs-owner", "stop-agents"], first: 100) {
      nodes { number timelineItems(itemTypes: [LABELED_EVENT], last: 100) { nodes { ... on LabeledEvent { createdAt label { name } } } } }
    }
    pullRequests(states: OPEN, labels: ["hold", "needs-owner"], first: 100) {
      nodes { number timelineItems(itemTypes: [LABELED_EVENT], last: 100) { nodes { ... on LabeledEvent { createdAt label { name } } } } }
    }
    approvals: pullRequests(states: OPEN, first: 100) {
      nodes { number commits(last: 1) { nodes { commit { status { context(name: "owner-approval") { state description targetUrl } } } } } }
    }
  }
}`;
