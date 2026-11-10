import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { defaults } from '../src/config.js';
import { CliRuntime } from '../src/runtime.js';

function fake(t, source) {
  const root = mkdtempSync(resolve(tmpdir(), 'agent-room-runtime-')), cwd = resolve(root, 'worker'); mkdirSync(cwd);
  const bin = resolve(root, 'fake-cli'); writeFileSync(bin, '#!' + process.execPath + '\n' + source, { mode: 0o755 });
  const config = structuredClone(defaults); config.agents.claude.bin = bin; config.agents.codex.bin = bin; config.turnTimeoutSec = 10;
  t.after(() => rmSync(root, { recursive: true, force: true })); return { cwd, config };
}
const report = { status: 'done', summary: 'created and read using file tools', evidence: ['Read saw expected bytes'], issues: [], artifacts: ['file.txt'] };
test('successful alternative tool path preserves denials without falsely failing the task', async t => {
  const x = fake(t, `process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'system',subtype:'init',model:'claude-test',session_id:'12345678-1234-4123-8123-123456789abc'}));console.log(JSON.stringify({type:'result',subtype:'success',session_id:'12345678-1234-4123-8123-123456789abc',structured_output:${JSON.stringify(report)},permission_denials:[{tool_name:'Bash'}]}));});`);
  let sid; const r = await new CliRuntime().run({ ...x, role: 'claude', prompt: 'test', signal: new AbortController().signal, onSession: s => sid = s });
  assert.equal(r.status, 'done'); assert.deepEqual(r.permissionDenials, ['Bash']); assert.equal(r.session, sid);
  assert.equal(r.runtime.model, 'claude-test'); assert.equal(r.runtime.provider, 'Anthropic');
});
test('CLI process exit without a terminal success event never counts as success', async t => {
  const x = fake(t, `process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'thread.started',thread_id:'12345678-1234-4123-8123-123456789abc'})));`);
  await assert.rejects(() => new CliRuntime().run({ ...x, role: 'codex', prompt: 'test', signal: new AbortController().signal }), /exited 0/);
});
test('transient Claude API error exits the call instead of waiting for full timeout', async t => {
  const x = fake(t, `process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'API Error: connection closed'}]}}));setInterval(()=>{},1000);});`);
  await assert.rejects(() => new CliRuntime().run({ ...x, role: 'claude', prompt: 'test', signal: new AbortController().signal }), /API Error: connection closed/);
});

test('official Claude profile refuses a non-Claude model even if the CLI reports success', async t => {
  const x = fake(t, `process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'system',subtype:'init',model:'deepseek-v4-pro',session_id:'12345678-1234-4123-8123-123456789abc'}));console.log(JSON.stringify({type:'result',subtype:'success',session_id:'12345678-1234-4123-8123-123456789abc',structured_output:${JSON.stringify(report)}}));setInterval(()=>{},1000);});`);
  await assert.rejects(() => new CliRuntime().run({ ...x, role: 'claude', prompt: 'test', signal: new AbortController().signal }), /Claude Code CLI: Authentication routing mismatch/);
});

test('official Claude profile requires native model evidence rather than trusting an answer claim', async t => {
  const x = fake(t, `process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'result',subtype:'success',session_id:'12345678-1234-4123-8123-123456789abc',structured_output:${JSON.stringify(report)}})));`);
  await assert.rejects(() => new CliRuntime().run({ ...x, role: 'claude', prompt: 'test', signal: new AbortController().signal }), /no verifiable Claude model identity/);
});
