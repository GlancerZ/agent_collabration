import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { capabilities, validateCapabilities, CAPABILITY_DEFAULTS } from './capability-config.js';
import {ROOT,DATA} from './paths.js';
export {ROOT,DATA} from './paths.js';

export const defaults = {
  port: 7417, rounds: 2, turnTimeoutSec: 1200, integrator: 'codex',
  agents: { codex: { bin: 'codex', model: '' }, claude: { bin: 'claude', model: '', authPolicy: 'claude-login' } },
  capabilities: structuredClone(CAPABILITY_DEFAULTS),
  projects: { scratch: { path: '', ref: 'HEAD', verify: [] } },
  slack: { enabled: false, appToken: '', codexToken: '', claudeToken: '', channelIds: [], userIds: [] }
};
export function privateDir(path) { mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); }
export function loadConfig() {
  privateDir(DATA);
  let saved = {};
  try { saved = JSON.parse(readFileSync(resolve(DATA, 'config.json'), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  return { ...structuredClone(defaults), ...saved, capabilities:capabilities(saved), agents: { ...defaults.agents, ...saved.agents }, slack: { ...defaults.slack, ...saved.slack } };
}
export function validateConfig(c) {
  validateCapabilities(c);
  if (!Number.isInteger(c.port) || c.port < 1024 || c.port > 65535) throw Error('Invalid port');
  if (!Number.isInteger(c.rounds) || c.rounds < 1 || c.rounds > 5) throw Error('rounds must be 1–5');
  if (!Number.isInteger(c.turnTimeoutSec) || c.turnTimeoutSec < 30 || c.turnTimeoutSec > 7200) throw Error('Invalid turn timeout');
  if (!['codex', 'claude'].includes(c.integrator)) throw Error('Invalid integrator');
  for (const role of ['codex', 'claude']) {
    if (typeof c.agents[role]?.bin !== 'string' || !c.agents[role].bin.trim() || /[\n\r\0]/.test(c.agents[role].bin)) throw Error('Invalid CLI path');
    if (c.agents[role].model && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,150}$/.test(c.agents[role].model)) throw Error('Invalid model');
  }
  if (c.agents.claude.authPolicy && !['claude-login', 'inherit'].includes(c.agents.claude.authPolicy)) throw Error('Invalid Claude authentication policy');
  if (!c.projects || !Object.keys(c.projects).length) throw Error('At least one project is required');
  for (const [name, p] of Object.entries(c.projects)) {
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(name) || typeof p.path !== 'string' || (p.path && !p.path.startsWith('/'))) throw Error('Projects require a simple name and absolute path');
    if (typeof p.ref !== 'string' || !p.ref || p.ref.startsWith('-') || /[\n\r\0]/.test(p.ref)) throw Error('Invalid git ref');
    if (!Array.isArray(p.verify) || p.verify.some(a => !Array.isArray(a) || !a.length || a.some(s => typeof s !== 'string' || s.includes('\0')))) throw Error('verify must be arrays of command arguments');
  }
  for (const field of ['channelIds', 'userIds']) if (!Array.isArray(c.slack[field])) throw Error('Slack allowlists must be arrays');
  if (c.slack.channelIds.some(x => !/^[CG][A-Z0-9]+$/.test(x)) || c.slack.userIds.some(x => !/^[UW][A-Z0-9]+$/.test(x))) throw Error('Invalid Slack IDs');
  if (c.slack.enabled) {
    if (!c.slack.channelIds.length || !c.slack.userIds.length) throw Error('Choose at least one allowed channel and user');
    if (!c.slack.appToken.startsWith('xapp-') || !c.slack.codexToken.startsWith('xoxb-') || !c.slack.claudeToken.startsWith('xoxb-')) throw Error('Missing Slack app/bot tokens');
    if (c.slack.codexToken === c.slack.claudeToken) throw Error('Two distinct bot tokens are required');
  }
  return c;
}
export function saveConfig(c) {
  validateConfig(c); privateDir(DATA);
  const file = resolve(DATA, 'config.json');
  writeFileSync(file, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 }); chmodSync(file, 0o600);
}
export function publicConfig(c) {
  const copy = structuredClone(c);
  for (const key of ['appToken', 'codexToken', 'claudeToken']) copy.slack[key] = c.slack[key] ? 'configured' : '';
  return copy;
}
export function redact(value) {
  return String(value).replace(/xox[baprs]-[A-Za-z0-9-]+/g, '[SLACK_TOKEN]').replace(/xapp-[A-Za-z0-9-]+/g, '[SLACK_APP_TOKEN]').replace(/sk-[A-Za-z0-9_-]{12,}/g, '[API_KEY]').replace(/\/internal\/capabilities\/[a-f0-9]{64}/g,'/internal/capabilities/[SCOPED_TOKEN]').replace(/(https?:\/\/)[^/\s:@]+:[^@\s]+@/g,'$1[REDACTED]@');
}
export function childEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/^(SLACK_|DUO_|ORCH_|MYSQL_)/.test(k) && k !== 'DATABASE_URL'));
}
