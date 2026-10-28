// HTML for the status page and the transcript view. Every value that comes from the state directory, a transcript or a
// command passes through `escape`: transcripts hold arbitrary tool output.
import {outcomeLabel} from './log.mjs';
import {truncate} from './transcript.mjs';

const brakeLabels = new Set(['hold', 'needs-owner', 'stop-agents']);
const refreshSeconds = 15;
const resultLength = 4000;
const rawLength = 2000;

/** @param {unknown} value */
export function escape(value) {
  return String(value).replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
}

/** @param {number | string} time */
export function formatTime(time) {
  const date = new Date(time);
  return Number.isNaN(date.getTime()) ? String(time) : `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

/** @param {number} ms */
export function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

/**
 * How long something has waited: "3 d", "5 h" or "12 min".
 * @param {number} ms
 */
export function formatAge(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes >= 24 * 60) return `${Math.floor(minutes / (24 * 60))} d`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)} h`;
  return `${minutes} min`;
}

const style = `
body{font:15px/1.45 system-ui,sans-serif;margin:0 auto;padding:12px;max-width:900px;color:#1d1d1f;background:#fafafa}
h1{font-size:1.25em;margin:.2em 0}h2{font-size:1.1em;margin:1.2em 0 .4em;border-bottom:1px solid #ddd}
h2.project{font-size:1.2em;margin-top:1.6em;border-bottom:2px solid #999}h3{font-size:1.05em;margin:1em 0 .4em}
.project{font-weight:600}
a{color:#0b57d0}ul{padding-left:0;list-style:none;margin:0}li{padding:4px 0;border-bottom:1px solid #eee}
pre,code,.mono{font-family:ui-monospace,Menlo,monospace;font-size:13px}
pre{white-space:pre-wrap;word-break:break-word;margin:4px 0;background:#f0f0f0;padding:6px;border-radius:4px}
.muted{color:#666;font-size:.9em}.bad{color:#b3261e;font-weight:600}.good{color:#146c2e;font-weight:600}
.label{display:inline-block;padding:0 6px;margin:0 2px;border-radius:8px;background:#e8e8e8;font-size:.85em}
.label.brake{background:#b3261e;color:#fff}
.entry{margin:8px 0;padding:6px 8px;border-left:3px solid #ccc;background:#fff;word-break:break-word}
.entry.assistant{border-color:#0b57d0}.entry.tool{border-color:#8a5cf6}.entry.result{border-color:#999}
.entry.final{border-color:#146c2e}.entry.raw{border-color:#e0a800}.entry.sub{margin-left:14px}
.entry.error{border-color:#b3261e}summary{cursor:pointer}
`;

/**
 * @param {string} title
 * @param {string} body
 * @param {boolean} refresh
 */
function page(title, body, refresh) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh ? `<meta http-equiv="refresh" content="${refreshSeconds}">` : ''}
<title>${escape(title)}</title><style>${style}</style></head>
<body>${body}</body></html>
`;
}

/** @param {string[]} labels */
function labelBadges(labels) {
  return labels.map(label => `<span class="label${brakeLabels.has(label.toLowerCase()) ? ' brake' : ''}">${escape(label)}</span>`).join('');
}

/**
 * A transcript's link, relative to the status page; server.mjs resolves it within that project's state directory.
 * @param {string} project
 * @param {string} name
 */
const runLink = (project, name) => `run/${encodeURIComponent(project)}/${encodeURIComponent(name)}`;

/**
 * @typedef {Awaited<ReturnType<typeof import('./state.mjs').readAll>>} AllState
 * @typedef {AllState['projects'][number]} ProjectState
 */

/**
 * @param {AllState} all
 * @param {number} nowMs
 */
export function statusPage(all, nowMs) {
  const running = all.projects.some(project => project.state?.now.running);
  return page('Triphammer status', `
<h1>Triphammer status</h1><div class="muted">${escape(formatTime(nowMs))}${running ? ` · refreshes every ${refreshSeconds} s` : ''}</div>
<h2>Waiting on you${all.waiting.length ? ` (${all.waiting.length})` : ''}</h2>${waitingSection(all, nowMs)}
${all.projects.map(project => projectSection(project, nowMs)).join('\n')}
`, running);
}

/**
 * One project's section: its error, or its current run, log, runs and queue.
 * @param {ProjectState} project
 * @param {number} nowMs
 */
function projectSection(project, nowMs) {
  const heading = `<h2 class="project">${escape(project.name)}</h2>`;
  if (!project.state) return `${heading}<p class="bad">This project cannot be shown:</p><pre>${escape(project.error)}</pre>`;
  const {now, log, runs, queue, plan} = project.state;
  return `${heading}
<h3>Now</h3>${nowSection(project.name, now, nowMs)}
<h3>Log</h3>${log.length ? `<pre>${log.map(escape).join('\n')}</pre>` : '<p class="muted">The log is empty or missing.</p>'}
<h3>Runs</h3>${runsSection(project.name, runs)}
<h3>Queue</h3>${queueSection(queue, plan, nowMs)}`;
}

/**
 * @param {string} project
 * @param {any} now
 * @param {number} nowMs
 */
function nowSection(project, now, nowMs) {
  const parts = [];
  if (now.active) {
    const start = now.active.start;
    parts.push(`<p><span class="good">Running</span> ${escape(start.kind)} #${escape(start.number)}${start.reason ? ` (${escape(start.reason)})` : ''},
attempt ${escape(start.attempt)} of ${escape(start.attempts)}, for ${escape(formatDuration(nowMs - Date.parse(start.time)))}
(since ${escape(formatTime(start.time))}). <a href="${runLink(project, now.activeName)}">Transcript</a></p>`);
  } else if (now.held === true) {
    parts.push('<p><span class="good">Busy</span>: the runner holds its lock and has not started a session yet.</p>');
  } else {
    parts.push('<p>Idle: no run in progress.</p>');
  }
  if (now.held === null) parts.push('<p class="muted">The lock table is unreadable, so this comes from the log alone; a run killed in the last 6 h can look like it is still going.</p>');
  const brakes = [];
  if (now.allPaused) brakes.push('every project is paused (see Waiting on you)');
  if (now.stopFile) brakes.push('the stop file is present');
  if (now.backoffActive) brakes.push(`backing off until ${escape(formatTime(now.backoffUntil))}`);
  if (now.stopAgents.length) brakes.push(`stop-agents on ${now.stopAgents.map((/** @type {number} */ n) => `#${escape(n)}`).join(', ')}`);
  if (brakes.length) {
    parts.push(`<p class="bad">Paused: ${brakes.join('; ')}.</p>`);
  } else if (now.stopAgentsKnown) {
    parts.push('<p class="muted">No brakes: no stop file, backoff or stop-agents label.</p>');
  } else {
    parts.push('<p class="muted">No stop file or backoff; stop-agents unknown: gh failed, and the runner\'s files can predate the label.</p>');
  }
  return parts.join('\n');
}

/**
 * @param {any} queue
 * @param {any} plan
 * @param {number} nowMs
 */
function queueSection(queue, plan, nowMs) {
  const parts = [];
  if (plan === 'paused') {
    parts.push('<p>Next action: none while paused.</p>');
  } else if (plan === 'running') {
    parts.push('<p>Next action: decided after the current run.</p>');
  } else if (plan.value.ok) {
    parts.push(`<p>Next action (<code>ticket-runner --plan</code>, ${escape(formatDuration(nowMs - plan.at))} ago): <code>${escape(plan.value.stdout.trim() || '(no output)')}</code></p>`);
  } else {
    parts.push(`<p>Next action unavailable: <code>ticket-runner --plan</code> failed.</p><pre>${escape(truncate(plan.value.error, 600))}</pre>`);
  }
  const source = queue.source === 'gh'
    ? 'from gh'
    : `from the runner's files, because gh failed${queue.filesModified ? `, written ${escape(formatDuration(nowMs - queue.filesModified))} ago` : ''}`;
  parts.push(`<p class="muted">Open issues and pull requests ${source}.</p>`);
  for (const error of queue.errors) parts.push(`<p class="muted">gh failed, so titles may be missing: ${escape(truncate(error, 300))}</p>`);
  if (!queue.items.length) parts.push('<p class="muted">Nothing open.</p>');
  else {
    parts.push(`<ul>${queue.items.map((/** @type {import('./state.mjs').QueueItem} */ item) => `<li>${item.type === 'pr' ? 'PR' : 'Issue'} #${escape(item.number)}
${item.title ? escape(item.title) : ''} ${labelBadges(item.labels)}${item.draft ? ' <span class="label">draft</span>' : ''}${item.attempts ? ` <span class="muted">${escape(item.attempts)} attempt(s)</span>` : ''}</li>`).join('\n')}</ul>`);
  }
  return parts.join('\n');
}

/**
 * Escapes text and shows its `backtick` spans as code.
 * @param {string} text
 */
const withCode = text => escape(text).replace(/`([^`]+)`/g, '<code>$1</code>');

/**
 * A note's HTML: its text parts as `withCode`, its links escaped. waiting.mjs only makes links to github.com.
 * @param {import('./waiting.mjs').Note} note
 */
const noteHtml = note => (typeof note === 'string' ? [note] : note)
  .map(part => (typeof part === 'string' ? withCode(part) : `<a href="${escape(part.href)}">${escape(part.text)}</a>`))
  .join('');

/**
 * The one list across the projects, each row naming its project, after what is unknown about each project.
 * @param {AllState} all
 * @param {number} nowMs
 */
function waitingSection(all, nowMs) {
  const parts = [];
  let allKnown = true;
  for (const project of all.projects) {
    const name = `<span class="project">${escape(project.name)}</span>`;
    if (!project.state) {
      allKnown = false;
      parts.push(`<p class="muted">${name}: it cannot be read, so what waits on you there is unknown; see its section.</p>`);
    } else if (!project.state.waiting.known) {
      allKnown = false;
      parts.push(`<p class="muted">${name}: gh failed, so issues and pull requests waiting on you are unknown; only local brakes are listed.</p>`);
    } else if (!project.state.waiting.labelTimesKnown) {
      parts.push(`<p class="muted">${name}: label times are unavailable, so labelled items count from when they were opened, and pull requests waiting for the owner's approval are not listed.</p>`);
    }
  }
  if (!all.waiting.length) {
    if (allKnown) parts.push('<p>Nothing is waiting on you</p>');
    return parts.join('\n');
  }
  const rows = all.waiting.map(row => {
    const where = `<span class="project">${row.project === null ? 'all projects' : escape(row.project)}</span>`;
    const what = row.number === null
      ? '<span class="bad">Brake</span>'
      : `<a href="https://github.com/${escape(row.repo)}/${row.type === 'pr' ? 'pull' : 'issues'}/${escape(row.number)}">${row.type === 'pr' ? 'PR' : 'Issue'} #${escape(row.number)}</a>${row.title ? ` ${escape(row.title)}` : ''}`;
    const age = row.since === null ? 'age unknown' : formatAge(nowMs - row.since);
    return `<li>${where} ${what} <span class="muted">· ${escape(age)}</span><br>${row.notes.map(noteHtml).join('<br>')}</li>`;
  });
  parts.push(`<ul>${rows.join('\n')}</ul>`);
  return parts.join('\n');
}

/**
 * @param {string} project
 * @param {any[]} runs
 */
function runsSection(project, runs) {
  if (!runs.length) return '<p class="muted">No transcripts yet.</p>';
  return `<ul>${runs.map(run => `<li><a href="${runLink(project, run.name)}">${escape(run.kind)} #${escape(run.number)}</a>
<span class="muted">${escape(formatTime(run.started))}</span> · ${escape(outcomeLabel(run.log, run.active))}</li>`).join('\n')}</ul>`;
}

/**
 * @param {string} project
 * @param {ReturnType<typeof import('./state.mjs').readRuns>['runs'][number]} run
 * @param {import('./transcript.mjs').Entry[]} entries
 */
export function transcriptPage(project, run, entries) {
  const active = run.active;
  const body = entries.map(entryHtml).join('\n');
  return page(`${project} ${run.kind} #${run.number} transcript`, `
<p><a href="../../">&larr; Triphammer status</a></p>
<h1>${escape(project)}: ${escape(run.kind)} #${escape(run.number)}</h1>
<div class="muted">Started ${escape(formatTime(run.started))} · ${escape(outcomeLabel(run.log, active))}${active ? ` · refreshes every ${refreshSeconds} s` : ''}</div>
${body || '<p class="muted">The transcript is empty.</p>'}
`, active);
}

/** @param {import('./transcript.mjs').Entry} entry */
function entryHtml(entry) {
  const sub = 'sub' in entry && entry.sub ? ' sub' : '';
  switch (entry.kind) {
    case 'init':
      return `<div class="entry muted${sub}">Session start · model ${escape(entry.model)} · ${escape(entry.cwd)}</div>`;
    case 'text':
      return `<div class="entry ${entry.role === 'assistant' ? 'assistant' : 'result'}${sub}"><div class="muted">${entry.role === 'assistant' ? (sub ? 'Subagent' : 'Assistant') : 'Prompt'}</div><pre>${escape(entry.text)}</pre></div>`;
    case 'tool':
      return `<div class="entry tool${sub}"><span class="mono">${escape(entry.name)}</span> <span class="muted">${escape(entry.summary)}</span></div>`;
    case 'result': {
      const shown = entry.text.length > resultLength ? `${entry.text.slice(0, resultLength)}\n… ${entry.text.length - resultLength} more characters` : entry.text;
      return `<details class="entry result${entry.isError ? ' error' : ''}${sub}"><summary class="muted">${entry.isError ? 'Error result' : 'Result'} (${escape(entry.text.length)} characters)</summary><pre>${escape(shown)}</pre></details>`;
    }
    case 'subagent':
      return `<div class="entry muted">Subagent ${escape(entry.event)}: ${escape(truncate(entry.text, 200))}</div>`;
    case 'final': {
      const facts = [
        entry.costUsd !== null ? `$${entry.costUsd.toFixed(2)}` : null,
        entry.durationMs !== null ? formatDuration(entry.durationMs) : null,
        entry.turns !== null ? `${entry.turns} turns` : null,
      ].filter(Boolean).join(' · ');
      return `<div class="entry final${entry.isError ? ' error' : ''}"><div class="${entry.isError ? 'bad' : 'good'}">Result${entry.isError ? ' (error)' : ''}${facts ? ` · ${escape(facts)}` : ''}</div>${entry.text ? `<pre>${escape(entry.text)}</pre>` : ''}</div>`;
    }
    case 'raw': {
      const line = entry.line.length > rawLength ? `${entry.line.slice(0, rawLength)}… (${entry.line.length} characters)` : entry.line;
      return `<div class="entry raw"><pre>${escape(line)}</pre></div>`;
    }
  }
}

/**
 * @param {string} message
 * @param {number} [status]
 */
export function errorPage(message, status = 404) {
  return page(String(status), `<h1>${escape(status)}</h1><p>${escape(message)}</p>`, false);
}
