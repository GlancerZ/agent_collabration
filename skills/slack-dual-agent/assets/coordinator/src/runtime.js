import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { childEnv, redact } from './config.js';
import { claudeAuthArgs, claudeAuthEnv, usesClaudeLogin } from './claude-auth.js';
import { capabilities, toolServer, inlineToml } from './capability-config.js';

export const SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { status: { type: 'string', enum: ['done', 'needs_work', 'blocked'] }, summary: { type: 'string', description: 'Concise stage outcome; place routine next-stage handoffs here.' }, evidence: { type: 'array', items: { type: 'string' } }, issues: { type: 'array', description: 'Only unresolved defects, missing requirements or real blockers. Scheduled review, integration or peer handoff is not an issue.', items: { type: 'string' } }, artifacts: { type: 'array', items: { type: 'string' } } },
  required: ['status', 'summary', 'evidence', 'issues', 'artifacts']
};
export function parseReport(value) {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { throw Error('Agent did not return a valid JSON report'); } }
  if (!value || !['done', 'needs_work', 'blocked'].includes(value.status) || typeof value.summary !== 'string' || !value.summary.trim() || ['evidence', 'issues', 'artifacts'].some(k => !Array.isArray(value[k]) || value[k].some(v => typeof v !== 'string'))) throw Error('Agent report has an invalid shape');
  if (JSON.stringify(value).length > 120000) throw Error('Agent report exceeds 120 KB');
  return value;
}
export function command(role, config, { session, schemaFile, schema = SCHEMA, readOnly, peerDirs = [], ephemeral = false, isolated = false, capabilitySession }) {
  const a = config.agents[role];
  const caps=capabilities(config);
  if (role === 'codex') {
    const args = ['exec', ...(session ? ['resume'] : []), '--json', '--skip-git-repo-check', '--output-schema', schemaFile,
      '-c', 'approval_policy="never"', '-c', `sandbox_mode="${readOnly ? 'read-only' : 'workspace-write'}"`,
      '-c', `web_search="${isolated ? 'disabled' : 'live'}"`];
    if (!readOnly && !isolated && caps.shellNetwork) args.push('-c','sandbox_workspace_write.network_access=true');
    if(caps.desktop.enabled&&!isolated)for(const name of ['cua_repl','computer-use'])args.push('-c','mcp_servers.'+name+'='+inlineToml({command:process.execPath,args:[],enabled:false}));
    if (capabilitySession && !isolated) args.push('-c','mcp_servers.agent_room='+inlineToml(toolServer(capabilitySession.gateway)));
    if (ephemeral) args.push('--ephemeral');
    if (isolated) args.push('--ignore-user-config');
    if (a.model) args.push('-m', a.model);
    if (session) args.push(session);
    args.push('-'); return { bin: a.bin, args };
  }
  const ownTools=capabilitySession&&!isolated?Object.fromEntries([['agent_room',toolServer(capabilitySession.gateway)]].map(([k,v])=>[k,{command:v.command,args:v.args,env:v.env}])):{};
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(schema), '--strict-mcp-config', '--mcp-config', JSON.stringify({mcpServers:ownTools}), '--no-chrome'];
  args.push(...claudeAuthArgs(config));
  const mcpTools=capabilitySession?.tools.map(n=>'mcp__agent_room__'+n)||[];
  const packageCommands=!readOnly&&caps.dependencyCommands?['npm','npx','pnpm','yarn','uv','pip','pip3','python','python3','node','curl','wget'].map(n=>'Bash('+n+' *)'):[];
  if (readOnly) args.push('--permission-mode', 'dontAsk', '--tools', 'Read,Grep,Glob,WebSearch,WebFetch', '--allowedTools', ['Read,Grep,Glob,WebSearch,WebFetch',...mcpTools].join(','));
  else args.push('--permission-mode', 'acceptEdits', '--tools', 'default', '--allowedTools', ['Read,Write,Edit,Glob,Grep,WebSearch,WebFetch',...packageCommands,...mcpTools].join(','));
  for (const dir of peerDirs) args.push('--add-dir', dir);
  if (a.model) args.push('--model', a.model);
  if (session) args.push('--resume', session);
  return { bin: a.bin, args };
}

export class CliRuntime {
  constructor({capabilities:hub}={}) {this.hub=hub;}
  async run({ role, config, cwd, prompt, session, signal, onSession, readOnly = false, peerDirs = [], schema = SCHEMA, parse = parseReport, ephemeral = false, isolated = false, timeoutSec = config.turnTimeoutSec, jobId, stage }) {
    const schemaFile = resolve(cwd, '..', `${role}-schema.json`);
    writeFileSync(schemaFile, JSON.stringify(schema), { mode: 0o600 });
    if (signal.aborted) throw signal.reason || Error('Stopped');
    const cap=capabilities(config),needsHub=cap.dependencyCommands||cap.ssh.enabled||cap.browser.enabled||cap.desktop.enabled;
    const capabilitySession=!isolated&&needsHub&&this.hub?this.hub.register({role,cwd,readOnly,peerDirs,jobId,stage}):undefined;
    const { bin, args } = command(role, config, { session, schemaFile, schema, readOnly, peerDirs, ephemeral, isolated, capabilitySession });
    if (signal.aborted) throw signal.reason || Error('Stopped');
    const taskEnv={...childEnv(),npm_config_cache:resolve(cwd,'.cache/npm'),PIP_CACHE_DIR:resolve(cwd,'.cache/pip'),UV_CACHE_DIR:resolve(cwd,'.cache/uv')};
    const env = role === 'claude' ? claudeAuthEnv(config, taskEnv) : taskEnv;
    const child = spawn(bin, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '', candidate, finalSeen = false, failed = '', sid = session, total = 0, permissionDenials = [], actualModel;
    const stop = () => { try { process.kill(-child.pid, 'SIGINT'); } catch {} };
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutSec * 1000);
    const killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, timeoutSec * 1000 + 5000);
    let forced;
    const abort = () => { stop(); forced = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000); };
    signal.addEventListener('abort', abort, { once: true });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      total += line.length;
      if (total > 12_000_000) { failed = 'CLI event output exceeded 12 MB'; stop(); return; }
      let e; try { e = JSON.parse(line); } catch { return; }
      const nextSid = role === 'codex' ? e.thread_id : e.session_id;
      if (nextSid && nextSid !== sid) { sid = nextSid; onSession?.(sid); }
      if (role === 'claude') {
        const model = e.type === 'system' && e.subtype === 'init' ? e.model : e.type === 'assistant' ? e.message?.model : undefined;
        if (model && model !== '<synthetic>') {
          actualModel = model;
          if (usesClaudeLogin(config) && !/^claude-/i.test(model)) { failed = 'Authentication routing mismatch: Claude Code selected a non-Claude model (' + model + ')'; stop(); }
        }
      }
      if (role === 'codex') {
        if (e.type === 'item.completed' && e.item?.type === 'agent_message') candidate = e.item.text;
        if (e.type === 'turn.completed') finalSeen = true;
        if (e.type === 'turn.failed' || e.type === 'error') failed = e.error?.message || e.message || e.type;
      } else if (e.type === 'result') {
        finalSeen = !e.is_error && e.subtype === 'success';
        candidate = e.structured_output || e.result;
        if (!finalSeen) failed = e.result || e.errors?.join('; ') || e.subtype;
        permissionDenials = (e.permission_denials || []).map(d => d.tool_name).filter(Boolean);
      } else if (role === 'claude' && e.type === 'assistant') {
        const errorText = e.message?.content?.find?.(b => b.type === 'text' && /^API Error:/.test(b.text))?.text;
        if (errorText) { failed = errorText; stop(); }
      }
    });
    child.stderr.on('data', b => { stderr = (stderr + b.toString()).slice(-4000); });
    child.stdin.on('error', () => {}); child.stdin.end(prompt);
    try {
      const code = await new Promise((ok, no) => { child.once('error', no); child.once('close', ok); });
      if (signal.aborted) throw Error('Stopped by user');
      if (timedOut) throw Error(`${role} exceeded the turn timeout; checkpoint retained`);
      if (code !== 0 || !finalSeen || failed) throw Error(redact(failed || `${role} exited ${code}; ${stderr}`));
      if (!sid) throw Error('CLI returned no session ID');
      if (role === 'claude' && usesClaudeLogin(config) && !/^claude-/i.test(actualModel || '')) throw Error('Claude CLI returned no verifiable Claude model identity');
      return { ...parse(candidate), session: sid, permissionDenials, ...(actualModel ? { runtime: { cli: role === 'claude' ? 'Claude Code CLI' : 'Codex CLI', model: actualModel, provider: usesClaudeLogin(config) ? 'Anthropic' : 'inherited' } } : {}) };
    } catch (e) {
      throw Error(`${role === 'claude' ? 'Claude Code CLI' : 'Codex CLI'}: ${redact(e.message)}`);
    } finally {
      capabilitySession?.release();
      clearTimeout(timer); clearTimeout(killTimer); clearTimeout(forced); signal.removeEventListener('abort', abort); lines.close();
    }
  }
}

export class MockRuntime {
  constructor() { this.calls = []; }
  async run(o) {
    this.calls.push(o); o.onSession?.(`${o.role}-demo-session`);
    if (o.signal.aborted) throw Error('Stopped');
    return { status: 'done', summary: `${o.role}: simulated ${o.prompt.match(/Stage: ([^\n]+)/)?.[1] || 'turn'}`, evidence: ['SIMULATION: no model or real task executed'], issues: [], artifacts: [], session: `${o.role}-demo-session` };
  }
}
