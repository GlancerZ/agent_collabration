import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Store } from '../src/store.js';
import { SlackBridge } from '../src/slack.js';

function setup(t) {
  const dir = mkdtempSync(resolve(tmpdir(), 'agent-room-notice-')), file = resolve(dir, 'db.sqlite');
  // Start with the pre-notification schema and a real pending message.
  const old = new DatabaseSync(file);
  old.exec("CREATE TABLE deliveries(seq INTEGER PRIMARY KEY, channel TEXT, thread TEXT, role TEXT, body TEXT, sent INTEGER DEFAULT 0); INSERT INTO deliveries VALUES(100,'C123','123.456','claude','old message',0)"); old.close();
  const store = new Store(file);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const j = store.create({ mode: 'collaborate', integrator: 'codex', prompt: 'draw <@U999> & test', channel: 'C123', thread: '123.456', owner: 'U123' });
  return { store, j };
}
const result = { status: 'completed', results: { codex: { summary: 'Created HTML and inspected it.' } } };

test('migration retains pending messages; final state and notice roll back together on enqueue failure', t => {
  const { store, j } = setup(t);
  assert.equal(store.pending()[0].body, 'old message'); assert.equal(store.pending()[0].broadcast, 0);
  store.db.exec("CREATE TRIGGER fail_notice BEFORE INSERT ON deliveries WHEN NEW.broadcast=1 BEGIN SELECT RAISE(ABORT,'simulate queue failure'); END");
  assert.throws(() => store.finish(j.id, result, 'delivery details'), /queue failure/);
  assert.equal(store.get(j.id).status, 'queued'); assert.equal(store.messages(j.id).length, 0);
  store.db.exec('DROP TRIGGER fail_notice');
  store.finish(j.id, result, 'delivery details');
  const seq = store.notifyCompletion(j.id);
  assert.equal(store.pending().filter(d => d.broadcast).length, 1);
  assert.equal(store.pending().find(d => d.broadcast).seq, seq);
  assert.ok(store.pending().find(d => d.broadcast).body.includes('&lt;@U999&gt; &amp; test'));
});

test('Codex broadcasts into the original thread, links it, and retries failed sends with the same message id', async t => {
  const { store, j } = setup(t); store.finish(j.id, result, 'delivery details');
  // Isolate the completion send; routine messages are already handled by existing delivery tests.
  for (const d of store.pending().filter(d => !d.broadcast)) store.delivered(d.seq);
  const requests = [], links = []; let fail = true;
  const codex = { chat: {
    getPermalink: async args => { links.push(args); return { permalink: 'https://example.slack.com/archives/C123/p123456' }; },
    postMessage: async args => { requests.push(args); if (fail) throw Error('temporary outage'); return { ok: true }; }
  } };
  const bridge = new SlackBridge({ store }); bridge.clients = { codex };
  await bridge.flush(); assert.equal(store.pending().length, 1);
  fail = false; await bridge.flush();
  assert.equal(store.pending().length, 0); assert.equal(requests.length, 2);
  assert.equal(requests[0].client_msg_id, requests[1].client_msg_id);
  assert.equal(requests[1].reply_broadcast, true); assert.equal(requests[1].thread_ts, j.thread);
  assert.deepEqual(links[0], { channel: j.channel, message_ts: j.thread });
  assert.ok(requests[1].text.includes('<https://example.slack.com/archives/C123/p123456|查看成果与原任务讨论串>'));
  store.notifyCompletion(j.id); assert.equal(store.pending().length, 0);
});
