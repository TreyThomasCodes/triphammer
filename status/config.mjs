// Triphammer's settings (bin/README.md, "Configuration" and "Several projects"), read by bin/config.sh,
// the one reader of the Triphammer config, from the checkout this file lives in.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const reader = path.join(import.meta.dirname, '..', 'bin', 'config.sh');
const checkout = path.join(import.meta.dirname, '..');
const keys = ['REPO', 'CHECKOUT', 'APP_AUTHOR', 'STATE_DIR', 'PROJECT', 'STATUS_HOST', 'STATUS_PORT', 'STATUS_ALLOWED_HOSTS'];

/**
 * The settings by name, and the project's name; a listen setting the config leaves out is empty. Throws config.sh's message, which names the file and the setting,
 * when the config is missing, unreadable or malformed, a setting is missing or invalid, or the project file is.
 * @param {NodeJS.ProcessEnv} env
 * @returns {{REPO: string, CHECKOUT: string, APP_AUTHOR: string, STATE_DIR: string, PROJECT: string} & Listen}
 */
export function readTriphammerConfig(env) {
  const result = spawnSync('bash', [reader, '--print', 'triphammer-status', checkout, ...keys], {encoding: 'utf8', env});
  const values = result.status === 0 ? result.stdout.split('\0') : [];
  if (values.length !== keys.length + 1) {
    const message = result.error?.message ?? (result.stderr.trim().replace(/^triphammer-status: /, '') || `${reader} failed`);
    throw new Error(message);
  }
  const [REPO, CHECKOUT, APP_AUTHOR, STATE_DIR, PROJECT, STATUS_HOST, STATUS_PORT, STATUS_ALLOWED_HOSTS] = values;
  return {REPO, CHECKOUT, APP_AUTHOR, STATE_DIR, PROJECT, STATUS_HOST, STATUS_PORT, STATUS_ALLOWED_HOSTS};
}

/**
 * @typedef {{STATUS_HOST: string, STATUS_PORT: string, STATUS_ALLOWED_HOSTS: string}} Listen
 *          where the page listens, as one Triphammer config gives it; a setting it leaves out is empty
 */

/** @type {(keyof Listen)[]} */
const listenKeys = ['STATUS_HOST', 'STATUS_PORT', 'STATUS_ALLOWED_HOSTS'];

/**
 * The listen settings the readable projects' configs give, each the value the configs that set it agree on, or empty
 * when none sets it. Throws, naming the projects, when two configs set one to different values, so the page never
 * picks one of them.
 * @param {Project[]} projects
 * @returns {Listen}
 */
export function listenSettings(projects) {
  /** @type {Listen} */
  const listen = {STATUS_HOST: '', STATUS_PORT: '', STATUS_ALLOWED_HOSTS: ''};
  for (const key of listenKeys) {
    const setting = projects.flatMap(project => (project.ok && project.listen[key] ? [[project.name, project.listen[key]]] : []));
    const values = [...new Set(setting.map(([, value]) => value))];
    if (values.length > 1) {
      throw new Error(`the project configs set ${key} to different values (${setting.map(([name, value]) => `${name}: ${value}`).join(', ')}); set it the same in each, or in one only`);
    }
    listen[key] = values[0] ?? '';
  }
  return listen;
}

/**
 * The directory of the projects' config files, as config.sh names it: ${XDG_CONFIG_HOME:-~/.config}/triphammer.
 * @param {NodeJS.ProcessEnv} env
 */
const configDir = env => path.join(env.XDG_CONFIG_HOME || `${env.HOME ?? ''}/.config`, 'triphammer');

/**
 * The directory every project shares, as config.sh names it: $TRIPHAMMER_SHARED_DIR, else
 * ${XDG_STATE_HOME:-~/.local/state}/triphammer.
 * @param {NodeJS.ProcessEnv} env
 */
export const sharedDir = env => env.TRIPHAMMER_SHARED_DIR || path.join(env.XDG_STATE_HOME || `${env.HOME ?? ''}/.local/state`, 'triphammer');

/**
 * @typedef {{name: string, ok: true, repo: string, stateDir: string, env: NodeJS.ProcessEnv, listen: Listen}
 *         | {name: string, ok: false, error: string}} Project
 *          a project the page shows: its settings, the environment its runner is started with and the listen settings
 *          its config gives, or why its config cannot be read
 */

/**
 * The projects the page shows. With $TRIPHAMMER_CONFIG or $TRIPHAMMER_PROJECT set, only the project they select, as
 * the runner selects it, and a bad config throws. Otherwise every `<name>.conf` in the config directory, each read as
 * `TRIPHAMMER_PROJECT=<name>` reads it, so one bad config is that project's error and never hides the others; throws
 * when the directory cannot be listed or holds no config.
 * @param {NodeJS.ProcessEnv} env
 * @returns {Project[]}
 */
export function readProjects(env) {
  if (env.TRIPHAMMER_CONFIG || env.TRIPHAMMER_PROJECT) {
    const settings = readTriphammerConfig(env);
    return [{name: settings.PROJECT, ok: true, repo: settings.REPO, stateDir: settings.STATE_DIR, env, listen: listenOf(settings)}];
  }
  const dir = configDir(env);
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch (error) {
    throw new Error(`cannot list the project configs in ${dir}: ${error instanceof Error ? error.message : error}`);
  }
  const names = files.filter(file => file.endsWith('.conf')).map(file => file.slice(0, -'.conf'.length)).sort();
  if (!names.length) {
    throw new Error(`${dir} holds no Triphammer config; create <project>.conf with REPO, CHECKOUT, APP_AUTHOR and STATE_DIR (bin/README.md)`);
  }
  return names.map(name => {
    const projectEnv = {...env, TRIPHAMMER_PROJECT: name};
    try {
      const settings = readTriphammerConfig(projectEnv);
      return {name, ok: /** @type {const} */ (true), repo: settings.REPO, stateDir: settings.STATE_DIR, env: projectEnv, listen: listenOf(settings)};
    } catch (error) {
      return {name, ok: /** @type {const} */ (false), error: error instanceof Error ? error.message : String(error)};
    }
  });
}

/**
 * @param {Listen} settings
 * @returns {Listen}
 */
const listenOf = ({STATUS_HOST, STATUS_PORT, STATUS_ALLOWED_HOSTS}) => ({STATUS_HOST, STATUS_PORT, STATUS_ALLOWED_HOSTS});
