import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { chmodSync, writeFileSync } from 'node:fs';
import { loadConfig, saveConfig, DATA, ROOT, childEnv, privateDir } from './config.js';
import { Store } from './store.js';
import { CliRuntime, MockRuntime } from './runtime.js';
import { Engine } from './engine.js';
import { SlackBridge } from './slack.js';
import { buildServer } from './server.js';
import { acquireLock } from './lock.js';
import { claudeAuthArgs, claudeAuthEnv } from './claude-auth.js';
import { CapabilityHub } from './capability-hub.js';
import { capabilities } from './capability-config.js';
import { classifyGoal } from './task-goal.js';
const exec = promisify(execFile);

export async function doctor(config) {
  const result = {};
  for (const role of ['codex', 'claude']) {
    const bin = config.agents[role].bin;
    try {
      const v = await exec(bin, ['--version'], { env: childEnv(), timeout: 15000 });
      result[role] = { installed: true, version: v.stdout.trim() };
      try {
        const auth = await exec(bin, role === 'codex' ? ['login', 'status'] : [...claudeAuthArgs(config), 'auth', 'status'], { env: role === 'claude' ? claudeAuthEnv(config, childEnv()) : childEnv(), timeout: 15000 });
        let loggedIn = true;
        if (role === 'claude') { try { loggedIn = JSON.parse(auth.stdout).loggedIn === true; } catch { loggedIn = !/not logged|logged out/i.test(auth.stdout); } }
        result[role].authenticated = loggedIn;
      } catch { result[role].authenticated = false; }
    } catch { result[role] = { installed: false, authenticated: false }; }
  }
  result.slackConfigured = !!(config.slack.appToken && config.slack.codexToken && config.slack.claudeToken && config.slack.channelIds.length && config.slack.userIds.length);
  result.capabilities=capabilities(config);
  return result;
}

async function main() {
  const config = loadConfig();
  if (process.argv[2] === 'doctor') { console.log(JSON.stringify(await doctor(config), null, 2)); return; }
  const mock = process.argv[2] === 'demo';
  const data = mock ? resolve(DATA, 'demo') : DATA; privateDir(data);
  const unlock = mock ? () => {} : acquireLock(resolve(data, 'service.pid'));
  process.once('exit', unlock);
  const dbFile = resolve(data, 'room.sqlite');
  const store = new Store(dbFile); chmodSync(dbFile, 0o600);
  const hub=mock?undefined:new CapabilityHub(config);
  const engine = new Engine({ store, config, runtime: mock ? new MockRuntime() : new CliRuntime({capabilities:hub}), data,
    classifyGoal: mock?undefined:input=>classifyGoal({...input,config,data,runtime:new CliRuntime()}),preflight: mock ? undefined : async () => {
    const status = await doctor(config);
    if (!status.codex.authenticated) throw Error('Codex CLI 尚未完成登录，请在本机确认 Codex 账户。');
    if (!status.claude.authenticated) throw Error('Claude Code CLI 尚未完成官方 Claude 账户登录。请先在本机完成 Claude CLI 登录，再发送 resume；任务与检查点已保留。');
  } });
  if(hub)hub.desktop.onApproval=approval=>{if(store.get(approval.jobId))store.message(approval.jobId,'codex','需要应用授权',`${approval.role==='codex'?'Codex':'Claude'} 正在等待官方 Computer Use 的应用授权：${approval.message}\n请在这台 Mac 打开 http://127.0.0.1:${config.port}/#access ，在“Mac 桌面控制”中确认或拒绝。确认后当前步骤会继续；不要在 Slack 发送密码或验证码。`);};
  if (mock) {
    for (const mode of ['independent', 'collaborate']) engine.start({ mode, project: 'scratch', prompt: '演示双 agent 流程，不调用真实模型。' });
    await engine.idle();
    writeFileSync(resolve(ROOT, 'demo-transcript.json'), JSON.stringify(store.list().map(j => ({ job: j, messages: store.messages(j.id) })), null, 2));
    console.log('Simulation completed. See demo-transcript.json; no real models or Slack messages were used.'); store.close(); return;
  }
  saveConfig(config);
  const bridge = new SlackBridge({ store, engine, config });
  const server = buildServer({ store, engine, bridge, config, doctor: () => doctor(config), capabilities:hub });
  await new Promise((ok, no) => { server.once('error', no); server.listen(config.port, '127.0.0.1', ok); });
  console.log(`Agent Room ready at http://127.0.0.1:${config.port}`);
  if (config.slack.enabled) { try { await bridge.connect(); } catch (e) { console.error('Slack connection needs attention; see local setup page.'); bridge.state = 'connection failed'; } }
  let exiting = false;
  const shutdown = async () => {
    if (exiting) return; exiting = true;
    await bridge.coordinator.shutdown(); await engine.shutdown(); await hub?.close(); await bridge.disconnect(); server.close(); store.close(); unlock(); process.exit(0);
  };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(ROOT, 'src/main.js')) main().catch(e => { console.error(e.message); process.exitCode = 1; });
