// Turns a Claude Code `--output-format stream-json --verbose` transcript into a flat list of entries to render.
// The runner mixes the session's stderr into the same file and a running session can leave a partial last line, so
// anything that is not a recognised JSON event becomes a `raw` entry instead of an error.

const summaryLength = 160;

/**
 * @typedef {{kind: 'init', model: string, cwd: string, sub: boolean}
 *   | {kind: 'text', role: 'assistant' | 'user', text: string, sub: boolean}
 *   | {kind: 'tool', name: string, summary: string, sub: boolean}
 *   | {kind: 'result', text: string, isError: boolean, sub: boolean}
 *   | {kind: 'subagent', event: string, text: string}
 *   | {kind: 'final', isError: boolean, costUsd: number | null, durationMs: number | null, turns: number | null, text: string}
 *   | {kind: 'raw', line: string}} Entry
 */

/**
 * @param {string} text the whole transcript file
 * @returns {Entry[]}
 */
export function parseTranscript(text) {
  /** @type {Entry[]} */
  const entries = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let event = null;
    try {
      event = JSON.parse(line);
    } catch {}
    if (event && typeof event === 'object' && !Array.isArray(event)) entries.push(...eventEntries(event, line));
    else entries.push({kind: 'raw', line});
  }
  return entries;
}

/**
 * @param {any} event
 * @param {string} line
 * @returns {Entry[]}
 */
function eventEntries(event, line) {
  const sub = typeof event.parent_tool_use_id === 'string';
  switch (event.type) {
    case 'system':
      if (event.subtype === 'init') return [{kind: 'init', model: String(event.model ?? ''), cwd: String(event.cwd ?? ''), sub}];
      if (event.subtype === 'task_started') {
        return [{kind: 'subagent', event: 'started', text: [event.subagent_type, event.description].filter(Boolean).join(': ')}];
      }
      if (event.subtype === 'task_notification') {
        return [{kind: 'subagent', event: String(event.status ?? 'ended'), text: String(event.summary ?? '')}];
      }
      return [];
    case 'assistant':
    case 'user':
      return messageEntries(event.type, event.message?.content, sub);
    case 'result':
      return [{
        kind: 'final',
        isError: event.is_error === true,
        costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : null,
        durationMs: typeof event.duration_ms === 'number' ? event.duration_ms : null,
        turns: typeof event.num_turns === 'number' ? event.num_turns : null,
        text: typeof event.result === 'string' ? event.result : '',
      }];
    case 'rate_limit_event':
    case 'tool_progress':
    case 'stream_event':
      return [];
    default:
      return [{kind: 'raw', line}];
  }
}

/**
 * @param {'assistant' | 'user'} role
 * @param {unknown} content
 * @param {boolean} sub
 * @returns {Entry[]}
 */
function messageEntries(role, content, sub) {
  if (typeof content === 'string') return content.trim() ? [{kind: 'text', role, text: content, sub}] : [];
  if (!Array.isArray(content)) return [];
  /** @type {Entry[]} */
  const entries = [];
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      entries.push({kind: 'text', role, text: block.text, sub});
    } else if (block?.type === 'tool_use') {
      entries.push({kind: 'tool', name: String(block.name ?? '?'), summary: toolSummary(block.name, block.input), sub});
    } else if (block?.type === 'tool_result') {
      entries.push({kind: 'result', text: resultText(block.content), isError: block.is_error === true, sub});
    }
  }
  return entries;
}

/**
 * A one-line summary of a tool call's input: the field a reader recognises for common tools, else compact JSON.
 * @param {unknown} name
 * @param {any} input
 */
export function toolSummary(name, input) {
  if (!input || typeof input !== 'object') return '';
  const pick = (/** @type {string[]} */ ...keys) => keys.map(key => input[key]).filter(value => typeof value === 'string' && value).join(' · ');
  let summary;
  switch (name) {
    case 'Bash': summary = pick('description') || pick('command'); break;
    case 'Read': case 'Write': case 'Edit': case 'NotebookEdit': summary = pick('file_path', 'notebook_path'); break;
    case 'Grep': case 'Glob': summary = pick('pattern', 'path'); break;
    case 'Agent': case 'Task': summary = pick('subagent_type', 'description'); break;
    case 'Skill': summary = pick('skill', 'args'); break;
    case 'WebFetch': summary = pick('url'); break;
    case 'WebSearch': summary = pick('query'); break;
    default: summary = '';
  }
  return truncate(summary || JSON.stringify(input), summaryLength);
}

/** @param {unknown} content */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  return content.map(block => block?.type === 'text' ? String(block.text ?? '') : `[${block?.type ?? 'block'}]`).join('\n');
}

/**
 * @param {string} text
 * @param {number} length
 */
export function truncate(text, length) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}
