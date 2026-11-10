import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Store } from '../src/store.js';
import { defaults } from '../src/config.js';
import { buildServer } from '../src/server.js';

test('local HTTP API blocks cross-origin writes and never exposes configured tokens', async t => {
  const dir = mkdtempSync(resolve(tmpdir(), 'agent-room-http-'));
  const store = new Store(resolve(dir, 'db.sqlite')), config = structuredClone(defaults);
  config.slack.codexToken = 'xoxb-private-test-token';
  let starts = 0;
  const server = buildServer({ store, config, engine: { start: () => { starts++; return { id: 'created' }; } }, bridge: { state: 'disconnected' }, doctor: async () => ({ ready: true }) });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); config.port = server.address().port;
  t.after(async () => { await new Promise(r => server.close(r)); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${config.port}`;
  const response = await fetch(base + '/api/state'), state = await response.json();
  assert.equal(state.config.slack.codexToken, 'configured'); assert.ok(!JSON.stringify(state).includes('xoxb-'));
  assert.ok(response.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  for (const headers of [{}, { Origin: 'https://elsewhere.test', 'X-Agent-Room-CSRF': state.csrf }, { Origin: base, 'X-Agent-Room-CSRF': 'bad' }]) {
    const r = await fetch(base + '/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' }); assert.equal(r.status, 403);
  }
  assert.equal(starts, 0);
  const good = await fetch(base + '/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, 'X-Agent-Room-CSRF': state.csrf }, body: '{}' });
  assert.equal(good.status, 201); assert.equal(starts, 1);
});

test('artifact preview serves only reported in-workspace files and isolates HTML from management APIs', async t => {
  const dir = mkdtempSync(resolve(tmpdir(), 'agent-room-preview-')), workspace = resolve(dir, 'codex'); mkdirSync(workspace);
  const page = resolve(workspace, 'pelican.html'), unreported = resolve(workspace, 'private.txt'), secret = resolve(dir, 'config.json');
  writeFileSync(page, '<!doctype html><h1>Existing pelican</h1>'); writeFileSync(unreported, 'not reported'); writeFileSync(secret, 'private config'); symlinkSync(secret, resolve(workspace, 'escape.html'));
  const store = new Store(resolve(dir, 'db.sqlite')), config = structuredClone(defaults);
  const j = store.create({ mode: 'collaborate', integrator: 'codex', workspaces: { codex: workspace }, results: { codex: { artifacts: [page, secret, resolve(workspace, 'escape.html')] } } });
  const server = buildServer({ store, config, engine: {}, bridge: {}, doctor: async () => ({}) });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); config.port = server.address().port;
  t.after(async () => { await new Promise(r => server.close(r)); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${config.port}`, detail = await (await fetch(base + '/api/jobs/' + j.id)).json();
  const presentation = await fetch(base + '/presentation/' + j.id);
  assert.equal(presentation.status, 200); assert.ok((await presentation.text()).includes('/presentation.js'));
  assert.equal(detail.artifacts.length, 1); assert.equal(detail.artifacts[0].name, 'pelican.html');
  const preview = await fetch(detail.artifacts[0].url);
  assert.equal(preview.status, 200); assert.match(preview.headers.get('content-type'), /^text\/html/);
  assert.ok(preview.headers.get('content-security-policy').includes('sandbox allow-scripts;'));
  assert.ok(!preview.headers.get('content-security-policy').includes('allow-same-origin'));
  assert.ok(preview.headers.get('content-security-policy').includes("connect-src 'none'"));
  assert.ok((await preview.text()).includes('Existing pelican'));
  const download = await fetch(detail.artifacts[0].downloadUrl);
  assert.ok(download.headers.get('content-disposition').startsWith('attachment'));
  for (const forbidden of [secret, unreported]) {
    const id = createHash('sha256').update(forbidden).digest('hex').slice(0, 24);
    assert.equal((await fetch(`${base}/artifacts/${j.id}/codex/${id}`)).status, 404);
  }
});
