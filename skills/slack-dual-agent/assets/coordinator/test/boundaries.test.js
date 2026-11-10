import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Store } from '../src/store.js';
import { defaults, publicConfig, childEnv, validateConfig, redact } from '../src/config.js';
import { parseCommand, allowedEvent, SlackBridge } from '../src/slack.js';
import { command, parseReport } from '../src/runtime.js';
import { validateTask } from '../src/engine.js';
import { claudeAuthEnv } from '../src/claude-auth.js';

test('only allowlisted human messages enter the system', () => {
  const c = structuredClone(defaults); c.slack.channelIds = ['C123']; c.slack.userIds = ['U123'];
  const e = { user: 'U123', channel: 'C123' };
  assert.equal(allowedEvent(e, c), true);
  for (const patch of [{ user: 'U999' }, { channel: 'C999' }, { bot_id: 'B123' }, { subtype: 'message_changed' }]) assert.equal(allowedEvent({ ...e, ...patch }, c), false);
});
test('Slack modes, project selection and control commands parse', () => {
  assert.deepEqual(parseCommand('<@U123> 独立 project=repo 修复问题'), { action: 'start', mode: 'independent', project: 'repo', prompt: '修复问题' });
  assert.equal(parseCommand('collaborate research this').mode, 'collaborate');
  assert.equal(parseCommand('暂停').action, 'pause'); assert.equal(parseCommand('new context').action, 'note');
});
test('config secrets are masked and orchestration credentials never reach CLI env', () => {
  const c = structuredClone(defaults); c.slack.codexToken = 'xoxb-test-token';
  assert.equal(publicConfig(c).slack.codexToken, 'configured');
  assert.deepEqual(childEnv({ SLACK_BOT_TOKEN: 'secret', DUO_ADMIN: 'secret', PATH: '/bin', ANTHROPIC_API_KEY: 'keep-existing-auth' }), { PATH: '/bin', ANTHROPIC_API_KEY: 'keep-existing-auth' });
  assert.ok(!redact('token=xoxb-test-token').includes('xoxb-'));
});
test('configuration and task boundaries reject arbitrary Slack paths', () => {
  assert.throws(() => validateTask({ mode: 'independent', project: '/tmp/arbitrary', prompt: 'test' }, defaults));
  const c = structuredClone(defaults); c.slack.enabled = true; assert.throws(() => validateConfig(c));
  assert.throws(() => parseReport({ status: 'done', summary: 'claimed' }));
});
test('CLI argv uses stdin and exact session IDs without bypass flags', () => {
  const c = structuredClone(defaults);
  const x = command('codex', c, { session: 'my-session', schemaFile: '/tmp/schema.json', readOnly: true });
  assert.deepEqual(x.args.slice(-2), ['my-session', '-']); assert.ok(x.args.includes('sandbox_mode="read-only"'));
  const a = command('claude', c, { session: 'my-session', readOnly: true, peerDirs: [] });
  assert.ok(a.args.includes('--resume')); assert.ok(a.args.includes('Read,Grep,Glob,WebSearch,WebFetch'));
  assert.ok(![...x.args, ...a.args].some(s => /dangerously|bypassPermissions|--bare/.test(s)));
});

test('workers can research live web sources in planning, execution and review without enabling shell networking or messaging', () => {
  const c = structuredClone(defaults);
  for (const readOnly of [true, false]) {
    const codex = command('codex', c, { schemaFile: '/tmp/schema.json', readOnly });
    assert.ok(codex.args.includes('web_search="live"'));
    assert.ok(!codex.args.some(a => /network_access\s*=\s*true|danger-full-access/.test(a)));
    const claude = command('claude', c, { readOnly });
    const allowed = claude.args[claude.args.indexOf('--allowedTools') + 1].split(',');
    assert.ok(allowed.includes('WebSearch')); assert.ok(allowed.includes('WebFetch'));
    assert.ok(!allowed.includes('Bash'));
    assert.ok(claude.args.includes('--strict-mcp-config')); assert.ok(claude.args.includes('--no-chrome'));
    if (readOnly) {
      const available = claude.args[claude.args.indexOf('--tools') + 1].split(',');
      assert.deepEqual(available, ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch']);
      assert.ok(!allowed.includes('Edit')); assert.ok(!allowed.includes('Write'));
      assert.ok(claude.args.includes('dontAsk'));
    }
  }
  const router = command('codex', c, { schemaFile:'/tmp/schema.json', readOnly:true, isolated:true });
  assert.ok(router.args.includes('web_search="disabled"'));
});

test('Claude CLI uses a credential-free session overlay and keeps existing permission settings', () => {
  const c = structuredClone(defaults), a = command('claude', c, { readOnly: true });
  const overlay = JSON.parse(a.args[a.args.indexOf('--settings') + 1]);
  assert.equal(overlay.env.ANTHROPIC_AUTH_TOKEN, ''); assert.equal(overlay.env.ANTHROPIC_API_KEY, '');
  assert.equal(overlay.env.ANTHROPIC_MODEL, ''); assert.equal(overlay.env.ANTHROPIC_DEFAULT_OPUS_MODEL, '');
  assert.equal(overlay.env.ANTHROPIC_BASE_URL, 'https://api.anthropic.com'); assert.equal(overlay.forceLoginMethod, 'claudeai');
  assert.ok(!a.args.includes('--setting-sources')); assert.equal(overlay.permissions, undefined);
  assert.deepEqual(claudeAuthEnv(c, { ANTHROPIC_AUTH_TOKEN: 'test', ANTHROPIC_BASE_URL: 'https://elsewhere.example', ANTHROPIC_MODEL: 'deepseek', PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'existing-login' }), { PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'existing-login' });
});
test('store restart pauses unfinished jobs; events and outbox persist', t => {
  const dir = mkdtempSync(resolve(tmpdir(), 'agent-room-store-')), file = resolve(dir, 'db.sqlite');
  let s = new Store(file); const j = s.create({ prompt: 'test', channel: 'C1', thread: '1' });
  s.update(j.id, { status: 'running' }); s.message(j.id, 'claude', 'review', 'hello'); assert.equal(s.claimEvent('event'), true); s.close();
  s = new Store(file); assert.equal(s.get(j.id).status, 'paused'); assert.equal(s.pending().length, 1); assert.equal(s.claimEvent('event'), false);
  s.delivered(s.pending()[0].seq); assert.equal(s.pending().length, 0); s.close(); rmSync(dir, { recursive: true, force: true });
});
test('two event subscriptions create a task only once and bot replies never spawn tasks', async () => {
  const c = structuredClone(defaults); c.slack.userIds = ['U123']; c.slack.channelIds = ['C123'];
  let starts = 0; const seen = new Set();
  const bridge = new SlackBridge({ config: c, store: { findThread: () => null, claimEvent: k => { if (seen.has(k)) return false; seen.add(k); return true; } }, engine: { start: () => starts++ } });
  const e = { user: 'U123', channel: 'C123', ts: '1', text: '<@U456> independent task' };
  await bridge.handle({ ...e, type: 'message' }); await bridge.handle({ ...e, type: 'app_mention' }); await bridge.handle({ ...e, type: 'app_mention' });
  await bridge.handle({ ...e, type: 'app_mention', ts: '2', bot_id: 'B123' }); assert.equal(starts, 1);
});
