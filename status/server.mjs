#!/usr/bin/env node
// Read-only status page for the ticket runner of every project on the machine: what waits on the owner across them, and
// per project the current run, the log, the run list with readable transcripts, and the queue. No authentication by
// design; bind to 127.0.0.1 and front it with Tailscale or nginx (README.md). Requests addressed to any other Host get
// 421, so a page that rebinds its own name to this address cannot read transcripts.
// Usage: node server.mjs [--host H] [--port P] [--allowed-hosts NAMES] [--runner PATH] [--gh PATH]
// The projects, each with its repository and state directory, are the project configs, read by ../bin/config.sh
// (config.mjs); the address, port and allowed names, when no flag or environment variable gives them, come from
// their STATUS_HOST, STATUS_PORT and STATUS_ALLOWED_HOSTS.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {listenSettings, readProjects, sharedDir} from './config.mjs';
import {errorPage, statusPage, transcriptPage} from './render.mjs';
import {commandsFor, readAll, readRuns} from './state.mjs';
import {parseTranscript} from './transcript.mjs';

const options = {
  host: {env: 'STATUS_HOST', fallback: '127.0.0.1'},
  port: {env: 'STATUS_PORT', fallback: '8787'},
  'allowed-hosts': {env: 'STATUS_ALLOWED_HOSTS', fallback: ''},
  runner: {env: 'STATUS_RUNNER', fallback: 'ticket-runner'},
  gh: {env: 'STATUS_GH', fallback: 'gh'},
};

/**
 * Flags win over environment variables, which win over the project configs' listen settings (listenSettings), which win
 * over defaults; the projects and the shared directory come from the project configs (readProjects). Throws on an unknown
 * flag, a bad port, when no project can be listed, or when two configs set a listen setting to different values.
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 */
export function parseConfig(argv, env) {
  /** @type {Record<string, string>} */
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!match || !(match[1] in options)) throw new Error(`unknown argument ${argv[i]}`);
    const value = match[2] ?? argv[++i];
    if (value === undefined) throw new Error(`--${match[1]} needs a value`);
    flags[match[1]] = value;
  }
  const projects = readProjects(env);
  /** @type {Record<string, string>} */
  const listen = listenSettings(projects);
  /** @param {keyof typeof options} name */
  const get = name => flags[name] ?? (env[options[name].env] || listen[options[name].env] || options[name].fallback);
  const port = Number(get('port'));
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`bad port ${get('port')}`);
  const allowedHosts = get('allowed-hosts').split(',').map(name => name.trim().toLowerCase()).filter(Boolean);
  return {host: get('host'), port, allowedHosts, runner: get('runner'), gh: get('gh'), sharedDir: sharedDir(env), projects};
}

const loopbackNames = ['localhost', '127.0.0.1', '[::1]'];

/**
 * Splits a Host header value into a lower-case name (IPv6 kept in brackets) and its port, or null when it has none.
 * @param {string} value
 */
function splitHost(value) {
  const match = /^(\[[^\]]*\]|[^:]*)(?::(\d*))?$/.exec(value.trim().toLowerCase());
  return match ? {name: match[1], port: match[2] || null} : null;
}

/**
 * Whether a request's Host header names this server: the listen address with its port, the loopback names with the
 * port when listening on loopback or on all interfaces, or an allowed name. An allowed name without a port matches on
 * any port; with a port, only on that port. A missing or malformed Host never matches.
 * @param {string | undefined} header
 * @param {{host: string, port: number, allowedHosts: string[]}} config
 */
export function isAllowedHost(header, config) {
  const host = header === undefined ? null : splitHost(header);
  if (!host || !host.name) return false;
  const listen = config.host.toLowerCase();
  const listenName = listen.includes(':') && !listen.startsWith('[') ? `[${listen}]` : listen;
  const wildcard = ['', '0.0.0.0', '[::]'].includes(listenName);
  const loopback = loopbackNames.includes(listenName) || /^127\./.test(listenName);
  const ownNames = [...(wildcard ? [] : [listenName]), ...(wildcard || loopback ? loopbackNames : [])];
  if (host.port === String(config.port) && ownNames.includes(host.name)) return true;
  return config.allowedHosts.some(entry => {
    const allowed = splitHost(entry);
    return allowed !== null && allowed.name === host.name && (allowed.port === null || allowed.port === host.port);
  });
}

/**
 * The request handler. GET and HEAD only; nothing here changes state.
 * @param {{host: string, port: number, allowedHosts: string[]} & import('./state.mjs').AllConfig} config
 * @param {Map<string, import('./state.mjs').Commands>} commands by project name
 * @returns {http.RequestListener}
 */
export function handler(config, commands) {
  return async (request, response) => {
    /**
     * @param {number} status
     * @param {string} html
     */
    const send = (status, html) => {
      response.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html),
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      response.end(request.method === 'HEAD' ? undefined : html);
    };
    try {
      if (!isAllowedHost(request.headers.host, config)) {
        send(421, errorPage('This server does not answer for that host name.', 421));
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, {Allow: 'GET, HEAD'});
        response.end();
        return;
      }
      const url = new URL(request.url ?? '/', 'http://localhost');
      const nowMs = Date.now();
      if (url.pathname === '/') {
        send(200, statusPage(await readAll(config, commands, nowMs), nowMs));
        return;
      }
      // The project and the run name, as they stand in the path, are compared against the readable projects and the
      // listing of that project's valid run names, never decoded or joined into a path first.
      const runPath = /^\/run\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      const project = runPath ? config.projects.find(candidate => candidate.ok && encodeURIComponent(candidate.name) === runPath[1]) : undefined;
      const run = project?.ok
        ? readRuns({...project, procRoot: config.procRoot}).runs.find(candidate => encodeURIComponent(candidate.name) === runPath?.[2])
        : undefined;
      if (!project?.ok || !run) {
        send(404, errorPage('No such page or run.'));
        return;
      }
      const text = fs.readFileSync(path.join(project.stateDir, 'runs', `${run.name}.jsonl`), 'utf8');
      send(200, transcriptPage(project.name, run, parseTranscript(text)));
    } catch (error) {
      console.error(error);
      if (!response.headersSent) send(500, errorPage('The status page failed; see the server log.', 500));
    }
  };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let config;
  try {
    config = parseConfig(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(`triphammer-status: ${error instanceof Error ? error.message : error}`);
    process.exit(2);
  }
  const {runner, gh} = config;
  const commands = new Map(config.projects.flatMap(project => (project.ok ? [[project.name, commandsFor({...project, runner, gh})]] : [])));
  for (const project of config.projects) {
    if (!project.ok) console.error(`triphammer-status: ${project.name}: ${project.error}`);
  }
  const server = http.createServer(handler(config, commands));
  server.listen(config.port, config.host, () => {
    const names = config.projects.map(project => project.name).join(', ');
    console.log(`triphammer-status: http://${config.host}:${config.port}/ showing ${names}, shared directory ${config.sharedDir}`);
  });
}
