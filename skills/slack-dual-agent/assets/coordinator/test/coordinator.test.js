import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { Coordinator, quickIntent } from '../src/coordinator.js';
import { SlackBridge } from '../src/slack.js';
import { defaults } from '../src/config.js';

function setup(t, decide = async () => { throw Error('Unexpected model call'); }) {
  const data = mkdtempSync(resolve(tmpdir(), 'agent-room-coordinate-'));
  const store = new Store(resolve(data, 'db.sqlite')), config = structuredClone(defaults);
  config.slack.channelIds = ['C123']; config.slack.userIds = ['U123'];
  const workspaces = { codex: resolve(data, 'codex'), claude: resolve(data, 'claude') };
  for (const p of Object.values(workspaces)) mkdirSync(p);
  const path = resolve(workspaces.codex, 'drawing.html'); writeFileSync(path, '<h1>Existing output</h1>');
  const j = store.create({ prompt: '画一个鹈鹕骑自行车的 HTML', mode: 'collaborate', integrator: 'codex', status: 'completed', epoch: 4,
    owner: 'U123', channel: 'C123', thread: '123.456', amendments: [], workspaces,
    results: { codex: { status: 'done', summary: 'Created existing drawing', evidence: ['Read HTML'], issues: [], artifacts: [path] } } });
  const controls = [], engine = { control: (...args) => controls.push(args) };
  let modelCalls = 0;
  const coordinator = new Coordinator({ store, engine, config, data, decide: async input => { modelCalls++; return decide(input); } });
  const bridge = new SlackBridge({ store, engine, config, coordinator });
  t.after(() => { store.close(); rmSync(data, { recursive: true, force: true }); });
  return { store, j, controls, coordinator, bridge, config, modelCalls: () => modelCalls };
}

test('result questions including the reported regression never amend, resume or call either worker', async t => {
  const x = setup(t);
  for (const text of ['所以最后的结果在哪里呢', '展示一下结果', '展示一下', '不用修改，展示结果', '给我看看成果']) {
    const result = await x.coordinator.handle(x.j.id, text);
    assert.equal(result.intent, 'result'); assert.ok(result.reply.includes('/artifacts/'));
    assert.ok(result.reply.includes('drawing.html'));
  }
  assert.equal(x.modelCalls(), 0); assert.deepEqual(x.controls, []);
  const after = x.store.get(x.j.id);
  assert.equal(after.status, 'completed'); assert.equal(after.epoch, 4); assert.deepEqual(after.amendments, []);
  assert.equal(x.store.decisions(x.j.id).length, 5);
});

test('status, acknowledgement and explanations answer without scheduling execution', async t => {
  const x = setup(t, async () => ({ intent: 'answer', reply: '当前文件使用 SVG 绘图。', reason: 'Explanation of existing output' }));
  x.store.update(x.j.id, { status: 'awaiting_user', results: { ...x.j.results, codex: { ...x.j.results.codex, issues: ['Browser check remains unverified'] } } });
  assert.equal((await x.coordinator.handle(x.j.id, '完成了吗？')).intent, 'status');
  assert.ok((await x.coordinator.handle(x.j.id, '展示结果')).reply.includes('Browser check remains unverified'));
  assert.equal((await x.coordinator.handle(x.j.id, '谢谢')).intent, 'ack');
  assert.equal((await x.coordinator.handle(x.j.id, '为什么选择这个方案？')).reply, '当前文件使用 SVG 绘图。');
  assert.equal(x.modelCalls(), 1); assert.deepEqual(x.controls, []);
});

test('mixed requests use semantic judgement; an actual change resumes with targeted revision', async t => {
  const x = setup(t, async ({ text }) => ({ intent: /从头/.test(text) ? 'replan' : 'revise', reply: '', reason: 'Explicit requested change' }));
  assert.equal(quickIntent('展示结果，并把背景改成蓝色'), null);
  await x.coordinator.handle(x.j.id, '展示结果，并把背景改成蓝色');
  assert.deepEqual(x.controls, [[x.j.id, 'note', '展示结果，并把背景改成蓝色'], [x.j.id, 'resume', '', { restart: false }]]);
  x.controls.length = 0;
  await x.coordinator.handle(x.j.id, '从头重新设计，先讨论方案');
  assert.deepEqual(x.controls.at(-1), [x.j.id, 'resume', '', { restart: true }]);
});

test('ambiguous questions or an unavailable classifier never trigger changes', async t => {
  const x = setup(t, async () => { throw Error('Coordinator offline'); });
  const result = await x.coordinator.handle(x.j.id, '这个可以再好一点吗');
  assert.equal(result.intent, 'clarify'); assert.ok(result.reply.includes('查看或解释'));
  assert.deepEqual(x.controls, []); assert.deepEqual(x.store.get(x.j.id).amendments, []);
});

test('Slack inquiry is routed once across subscriptions and only the task owner can use it', async t => {
  const x = setup(t);
  const e = { type: 'message', channel: 'C123', user: 'U123', thread_ts: '123.456', ts: '124.1', text: '所以最后的结果在哪里呢' };
  await x.bridge.handle(e); await x.bridge.handle({ ...e, type: 'app_mention' });
  await x.bridge.handle({ ...e, ts: '124.2', user: 'U999' });
  assert.equal(x.store.decisions(x.j.id).length, 1); assert.deepEqual(x.controls, []);
  assert.equal(x.store.messages(x.j.id).filter(m => m.stage === '答复').length, 1);
});
