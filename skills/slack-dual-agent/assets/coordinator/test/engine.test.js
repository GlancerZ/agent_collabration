import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { defaults } from '../src/config.js';

const ok = (summary = 'checked') => ({ status: 'done', summary, evidence: ['read the current artifact'], issues: [], artifacts: [] });
const stage = o => o.prompt.match(/Stage: ([^\n]+)/)[1];
function setup(t, handler = () => ok(), extra = {}) {
  const data = mkdtempSync(resolve(tmpdir(), 'agent-room-test-'));
  const store = new Store(resolve(data, 'db.sqlite'));
  const calls = [];
  const runtime = { run: async o => { calls.push(o); o.onSession(`${o.role}-session`); return handler(o); } };
  const config = structuredClone(defaults); config.rounds = 1;
  const engine = new Engine({ store, runtime, config, data, workspaceFactory: async j => {
    const paths = Object.fromEntries(['codex', 'claude'].map(r => [r, resolve(data, j.id, r)]));
    for (const p of Object.values(paths)) mkdirSync(p, { recursive: true }); return paths;
  }, ...extra });
  t.after(async () => { await engine.shutdown(); store.close(); rmSync(data, { recursive: true, force: true }); });
  return { store, engine, calls, config };
}

test('independent drafts have no peer answers; both complete before review', async t => {
  const { store, engine, calls } = setup(t, o => ok(o.role + '-private-answer'));
  const j = engine.start({ mode: 'independent', prompt: 'test' }); await engine.idle();
  assert.equal(store.get(j.id).status, 'completed'); assert.equal(calls.length, 8);
  assert.deepEqual(calls.slice(0, 2).map(stage), ['independent-draft', 'independent-draft']);
  for (const o of calls.slice(0, 2)) assert.ok(!o.prompt.includes('-private-answer'));
  for (const o of calls.filter(o => /review|compare/.test(stage(o)))) { assert.equal(o.readOnly, true); assert.equal(o.session, o.role + '-session'); assert.ok(o.prompt.includes((o.role === 'codex' ? 'claude' : 'codex') + '-private-answer')); }
  const stages = calls.map(stage);
  assert.ok(stages.indexOf('independent-synthesize') > stages.lastIndexOf('independent-compare'));
  assert.ok(stages.indexOf('independent-integration-review-1') > stages.indexOf('independent-synthesize'));
});

test('changed final independent versions always receive a new review', async t => {
  const { store, engine, calls } = setup(t, o => stage(o) === 'independent-review-1' ? { ...ok(o.role + '-critique'), status: 'needs_work', issues: ['fix current artifact'] } : ok());
  const j = engine.start({ mode: 'independent', prompt: 'test' }); await engine.idle();
  assert.equal(store.get(j.id).status, 'completed');
  assert.equal(calls.filter(o => stage(o) === 'independent-final-review-1').length, 2);
  for (const o of calls.filter(o => stage(o) === 'independent-revise-1')) assert.ok(o.prompt.includes((o.role === 'codex' ? 'claude' : 'codex') + '-critique'));
});

test('collaboration plans, builds, integrates, revises and reviews final version', async t => {
  const { store, engine, calls } = setup(t, o => stage(o) === 'collaborative-review-1' ? { ...ok(), status: 'needs_work', issues: ['integration mismatch'] } : ok());
  const j = engine.start({ mode: 'collaborate', prompt: 'test' }); await engine.idle();
  const stages = calls.map(stage);
  assert.ok(stages.indexOf('collaborative-integrate') > stages.lastIndexOf('collaborative-build'));
  assert.ok(stages.indexOf('collaborative-final-review-1') > stages.indexOf('collaborative-revise-1'));
  assert.equal(store.get(j.id).status, 'completed');
});

test('unresolved review is awaiting_user; round limit never means success', async t => {
  const { store, engine } = setup(t, o => /review/.test(stage(o)) ? { ...ok(), status: 'needs_work', issues: ['unresolved'] } : ok());
  const j = engine.start({ mode: 'independent', prompt: 'test' }); await engine.idle();
  assert.equal(store.get(j.id).status, 'awaiting_user');
  engine.control(j.id, 'resume'); await engine.idle(); assert.equal(store.get(j.id).epoch, 1);
});

test('resuming an unresolved review without new requirements keeps artifacts and skips rebuilding', async t => {
  let unresolved = true;
  const { store, engine, calls } = setup(t, o => /review/.test(stage(o)) && unresolved ? { ...ok(), status: 'needs_work', issues: ['check again'] } : ok());
  const j = engine.start({ mode: 'collaborate', prompt: 'test' }); await engine.idle();
  assert.equal(store.get(j.id).status, 'awaiting_user'); const before = calls.length;
  unresolved = false; engine.control(j.id, 'resume'); await engine.idle();
  assert.equal(store.get(j.id).status, 'completed'); assert.deepEqual(calls.slice(before).map(stage), ['collaborative-review-1']);
});

test('failed fixed verification command blocks delivery', async t => {
  const { store, engine } = setup(t, () => ok(), { verify: async () => [{ ok: false, command: ['test'], output: 'failed' }] });
  const j = engine.start({ mode: 'collaborate', prompt: 'test' }); await engine.idle();
  assert.equal(store.get(j.id).status, 'awaiting_user');
});

test('one failed sibling does not leave another writer running on resume', async t => {
  let finished = false;
  const { store, engine } = setup(t, async o => {
    if (o.role === 'codex') throw Error('broken');
    await new Promise(r => setTimeout(r, 40)); finished = true; return ok();
  });
  const j = engine.start({ mode: 'independent', prompt: 'test' }); await engine.idle();
  assert.equal(finished, true); assert.equal(store.get(j.id).status, 'failed'); assert.equal(engine.active, null);
});

test('missing authentication fails before launching either worker and retains checkpoints', async t => {
  const { store, engine, calls } = setup(t, () => ok(), { preflight: async () => { throw Error('Claude CLI not authenticated'); } });
  const j = engine.start({ mode: 'collaborate', prompt: 'test' }); await engine.idle();
  assert.equal(store.get(j.id).status, 'failed'); assert.equal(calls.length, 0); assert.ok(store.get(j.id).note.includes('not authenticated'));
});

test('a login-blocked stage pauses once and resumes the same stage without caching the blocker',async t=>{
  let blocked=true;
  const {store,engine,calls}=setup(t,o=>o.role==='claude'&&stage(o)==='collaborative-plan'&&blocked?{...ok('SSH login required'),status:'blocked',issues:['Complete MFA locally']}:ok());
  const j=engine.start({mode:'collaborate',prompt:'test'});await engine.idle();
  assert.equal(store.get(j.id).status,'paused');assert.equal(store.step(j.id,0,'collaborative-plan:claude'),null);
  assert.ok(!calls.some(o=>stage(o)==='collaborative-build'));
  blocked=false;engine.control(j.id,'resume');await engine.idle();
  assert.equal(store.get(j.id).status,'completed');assert.equal(store.get(j.id).epoch,0);
  assert.equal(calls.filter(o=>o.role==='claude'&&stage(o)==='collaborative-plan').length,2);
});

test('pause/resume uses successful checkpoints and resumes the exact sessions', async t => {
  let waiting, first = true;
  const ready = new Promise(r => { waiting = r; });
  const { store, engine, calls } = setup(t, async o => {
    if (o.role === 'claude' && stage(o) === 'independent-draft' && first) {
      first = false; waiting(); await new Promise(r => o.signal.addEventListener('abort', r, { once: true })); throw Error('stopped');
    }
    return ok();
  });
  const j = engine.start({ mode: 'independent', prompt: 'test' }); await ready;
  await new Promise(r => setTimeout(r, 5)); engine.control(j.id, 'pause'); await engine.idle();
  assert.equal(store.get(j.id).status, 'paused');
  engine.control(j.id, 'resume'); await engine.idle();
  assert.equal(store.get(j.id).status, 'completed');
  assert.equal(calls.filter(o => o.role === 'codex' && stage(o) === 'independent-draft').length, 1);
  assert.equal(calls.filter(o => o.role === 'claude' && stage(o) === 'independent-draft')[1].session, 'claude-session');
});

test('jobs run sequentially while each job permits two workers', async t => {
  const { engine, store, calls } = setup(t, async () => { await new Promise(r => setTimeout(r, 2)); return ok(); });
  const a = engine.start({ mode: 'independent', prompt: 'first' }), b = engine.start({ mode: 'independent', prompt: 'second' });
  await engine.idle(); assert.equal(store.get(a.id).status, 'completed'); assert.equal(store.get(b.id).status, 'completed');
  assert.ok(calls.slice(0, 4).every(o => o.prompt.includes('任务：first')));
});

test('successful Slack tasks announce once per epoch; follow-up replies preserve context and notify again', async t => {
  const { store, engine, config, calls } = setup(t);
  const { SlackBridge } = await import('../src/slack.js');
  const { Coordinator } = await import('../src/coordinator.js');
  config.slack.userIds = ['U123']; config.slack.channelIds = ['C123'];
  const j = engine.start({ mode: 'collaborate', prompt: 'make an HTML drawing' }, { owner: 'U123', channel: 'C123', thread: '123.456' });
  await engine.idle();
  let notices = store.db.prepare('SELECT * FROM deliveries WHERE sent=0 AND broadcast=1').all();
  assert.equal(notices.length, 1, JSON.stringify(store.get(j.id))); assert.equal(notices[0].role, 'codex');
  assert.ok(notices[0].body.includes('<@U123>，任务已完成'));
  assert.ok(notices[0].body.includes('无须重新 @'));
  store.notifyCompletion(j.id); assert.equal(store.db.prepare('SELECT * FROM deliveries WHERE sent=0 AND broadcast=1').all().length, 1);
  while (store.pending().length) for (const delivery of store.pending()) store.delivered(delivery.seq);
  const originalSessions = store.get(j.id).sessions;
  const before = calls.length;
  const coordinator = new Coordinator({ store, engine, config, decide: async () => ({ intent: 'revise', reply: '', reason: 'Explicit change request' }) });
  const bridge = new SlackBridge({ store, engine, config, coordinator });
  await bridge.handle({ type: 'message', user: 'U123', channel: 'C123', thread_ts: '123.456', ts: '124.1', text: '把背景改成蓝色，并增加动画。' });
  await engine.idle();
  const updated = store.get(j.id);
  assert.equal(updated.status, 'completed'); assert.equal(updated.epoch, 1);
  assert.deepEqual(updated.sessions, originalSessions);
  assert.deepEqual(updated.amendments, ['把背景改成蓝色，并增加动画。']);
  notices = store.db.prepare('SELECT * FROM deliveries WHERE broadcast=1 AND sent=0').all();
  assert.equal(notices.length, 1); assert.ok(notices[0].body.includes('第 2 轮'));
  assert.equal(store.messages(j.id).filter(m => m.stage === '任务已完成').length, 2);
  assert.deepEqual(calls.slice(before).map(stage), ['followup-revise', 'collaborative-review-1']);
});

test('unresolved Slack tasks never announce successful completion', async t => {
  const { store, engine } = setup(t, o => /review/.test(stage(o)) ? { ...ok(), status: 'needs_work', issues: ['broken artifact'] } : ok());
  const j = engine.start({ mode: 'independent', prompt: 'task' }, { owner: 'U123', channel: 'C123', thread: '123.456' });
  await engine.idle(); assert.equal(store.get(j.id).status, 'awaiting_user');
  assert.equal(store.notifyCompletion(j.id), null);
  assert.equal(store.pending().filter(d => d.broadcast).length, 0);
});

test('explicit fresh planning request retains the full collaborative workflow', async t => {
  const { store, engine, calls } = setup(t);
  const j = engine.start({ mode: 'collaborate', prompt: 'test' }); await engine.idle();
  const before = calls.length;
  engine.control(j.id, 'note', '从头重新设计，先让双方讨论新方案。');
  engine.control(j.id, 'resume', '', { restart: true }); await engine.idle();
  assert.equal(store.get(j.id).status, 'completed');
  assert.deepEqual(calls.slice(before, before + 2).map(stage), ['collaborative-plan', 'collaborative-plan']);
  assert.ok(calls.slice(before).some(o => stage(o) === 'collaborative-integrate'));
});

test('independent follow-up revises the integrated final version and skips the original dual workflow', async t => {
  const { store, engine, calls } = setup(t);
  const j = engine.start({ mode: 'independent', prompt: 'test' }); await engine.idle();
  const before = calls.length;
  engine.control(j.id, 'note', '把背景改成蓝色'); engine.control(j.id, 'resume'); await engine.idle();
  assert.equal(store.get(j.id).status, 'completed');
  assert.deepEqual(calls.slice(before).map(stage), ['followup-revise', 'independent-integration-review-1']);
});

test('independent synthesis preserves original files, uses both candidates and publishes a distinct final version', async t => {
  let store;
  const x = setup(t, o => {
    const file = resolve(o.cwd, 'answer.txt');
    if (stage(o) === 'independent-draft') writeFileSync(file, o.role === 'codex' ? 'efficient\n' : 'robust\n');
    if (stage(o) === 'independent-synthesize') {
      const j = store.list()[0], sources = j.sourceVersions.candidates;
      assert.ok(o.prompt.includes('采用了双方哪些优点'));
      writeFileSync(file, readFileSync(sources.codex.files[0].path, 'utf8') + readFileSync(sources.claude.files[0].path, 'utf8'));
    }
    return { ...ok(), artifacts: [file] };
  }); store = x.store;
  const j = x.engine.start({ mode: 'independent', prompt: 'combine the best aspects' }); await x.engine.idle();
  const done = store.get(j.id); assert.equal(done.status, 'completed'); assert.equal(done.finalRole, 'codex');
  assert.equal(readFileSync(resolve(done.workspaces.codex, 'answer.txt'), 'utf8'), 'efficient\nrobust\n');
  for (const versions of Object.values(done.sourceVersions)) {
    assert.equal(readFileSync(versions.codex.files[0].path, 'utf8'), 'efficient\n');
    assert.equal(readFileSync(versions.claude.files[0].path, 'utf8'), 'robust\n');
  }
  const { availableArtifacts } = await import('../src/artifacts.js');
  const files = availableArtifacts(done); assert.equal(files.filter(f => f.kind === 'final').length, 1);
  assert.equal(files.filter(f => f.kind === 'original').length, 2);
  assert.equal(new Set(files.map(f => f.url)).size, files.length);
  const { Coordinator } = await import('../src/coordinator.js');
  const coordinator = new Coordinator({ config: x.config });
  const reply = coordinator.resultReply(done);
  assert.ok(reply.includes(files.find(f => f.kind === 'final').url));
  assert.ok(reply.includes(files.find(f => f.kind === 'original').url));
  assert.ok(reply.includes('打开三份成果与比较说明'));
  assert.ok(coordinator.resultReply(done, '展示双方独立初稿').includes(files.find(f => f.kind === 'original').url));
  const { completionBody } = await import('../src/notifications.js');
  const notification = completionBody({ ...done, owner: 'U123' });
  for (const label of ['最终整合版', 'Codex 独立完成版', 'Claude 独立完成版', '打开三份成果与比较说明']) assert.ok(notification.includes(label));
});

test('passing source reviews never bypass a failing review of the synthesized final version', async t => {
  const { store, engine } = setup(t, o => /independent-integration-.*review/.test(stage(o)) || stage(o) === 'independent-integration-review-1' ? { ...ok(), status: 'needs_work', issues: ['final integration is broken'] } : ok());
  const j = engine.start({ mode: 'independent', prompt: 'test' }); await engine.idle();
  assert.equal(store.get(j.id).status, 'awaiting_user');
  assert.equal(store.get(j.id).candidateCritics.codex.status, 'done');
  assert.equal(store.get(j.id).critics.claude.status, 'needs_work');
});

test('unadopted candidate defects remain recorded without blocking a validated final version', async t => {
  const { store, engine } = setup(t, o => /^independent-(?:final-)?review/.test(stage(o)) ? { ...ok(), status: 'needs_work', issues: ['candidate defect not adopted'] } : ok());
  const j = engine.start({ mode: 'independent', prompt: 'test' }); await engine.idle();
  const done = store.get(j.id); assert.equal(done.status, 'completed');
  assert.equal(done.candidateCritics.codex.status, 'needs_work'); assert.equal(done.critics.claude.status, 'done');
});

test('pause in synthesis keeps frozen sources and resumes without rerunning drafts or comparison', async t => {
  let first = true, ready;
  const started = new Promise(r => ready = r);
  const { store, engine, calls } = setup(t, async o => {
    if (stage(o) === 'independent-draft') writeFileSync(resolve(o.cwd, 'answer.txt'), o.role);
    if (stage(o) === 'independent-synthesize' && first) {
      first = false; writeFileSync(resolve(o.cwd, 'answer.txt'), 'partial integration'); ready();
      await new Promise(r => o.signal.addEventListener('abort', r, { once: true })); throw Error('stopped');
    }
    return { ...ok(), artifacts: [resolve(o.cwd, 'answer.txt')] };
  });
  const j = engine.start({ mode: 'independent', prompt: 'test' }); await started;
  engine.control(j.id, 'pause'); await engine.idle();
  const preserved = store.get(j.id).sourceVersions.candidates.codex.files[0].path;
  assert.equal(readFileSync(preserved, 'utf8'), 'codex');
  engine.control(j.id, 'resume'); await engine.idle();
  assert.equal(store.get(j.id).status, 'completed'); assert.equal(readFileSync(preserved, 'utf8'), 'codex');
  assert.equal(calls.filter(o => stage(o) === 'independent-draft').length, 2);
  assert.equal(calls.filter(o => stage(o) === 'independent-compare').length, 2);
});
