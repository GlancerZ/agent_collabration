import { resolve } from 'node:path';
import { ROOT } from './paths.js';

export const CAPABILITY_DEFAULTS = Object.freeze({
  shellNetwork: false, dependencyCommands: false,
  ssh: { enabled: false, hosts: [] },
  browser: { enabled: false, mode: 'playwright', headless: false },
  desktop: { enabled: false, backend: 'codex-native', paused: false },
  pythonBin: ''
});
export function capabilities(config) {
  const c = config.capabilities || {};
  return { ...CAPABILITY_DEFAULTS, ...c, ssh: { ...CAPABILITY_DEFAULTS.ssh, ...c.ssh }, browser: { ...CAPABILITY_DEFAULTS.browser, ...c.browser }, desktop:{...CAPABILITY_DEFAULTS.desktop,...c.desktop} };
}
export function validateCapabilities(config) {
  const c = capabilities(config);
  for (const key of ['shellNetwork', 'dependencyCommands']) if (typeof c[key] !== 'boolean') throw Error('Invalid capability: ' + key);
  if (typeof c.ssh.enabled !== 'boolean' || !Array.isArray(c.ssh.hosts) || (c.ssh.enabled&&!c.ssh.hosts.length) || c.ssh.hosts.some(h => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(h))) throw Error('SSH requires explicit simple host aliases');
  if (typeof c.browser.enabled !== 'boolean' || c.browser.mode !== 'playwright' || typeof c.browser.headless !== 'boolean') throw Error('Invalid browser capability');
  if(typeof c.desktop.enabled!=='boolean'||c.desktop.backend!=='codex-native'||typeof c.desktop.paused!=='boolean')throw Error('Invalid desktop capability');
  if (typeof c.pythonBin !== 'string' || /[\n\r\0]/.test(c.pythonBin) || (c.pythonBin && !c.pythonBin.startsWith('/'))) throw Error('Python must use an absolute executable path');
  return c;
}
export function toolServer(gateway) {
  return { command: process.execPath, args: [resolve(ROOT, 'src/worker-tools.js')],
    env: { AGENT_ROOM_GATEWAY_URL: gateway }, startup_timeout_sec: 30, tool_timeout_sec: 300,
    default_tools_approval_mode: 'approve' };
}
export function inlineToml(value) {
  if (Array.isArray(value)) return '[' + value.map(inlineToml).join(', ') + ']';
  if (value && typeof value === 'object') return '{ ' + Object.entries(value).map(([k,v]) => JSON.stringify(k) + ' = ' + inlineToml(v)).join(', ') + ' }';
  return JSON.stringify(value);
}
