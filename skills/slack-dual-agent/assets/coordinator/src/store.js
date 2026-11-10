import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { redact } from './config.js';
import { completionBody } from './notifications.js';

export class Store {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS steps(job TEXT, epoch INTEGER, key TEXT, data TEXT, PRIMARY KEY(job,epoch,key));
      CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT, job TEXT, role TEXT, stage TEXT, body TEXT, at TEXT);
      CREATE TABLE IF NOT EXISTS deliveries(seq INTEGER PRIMARY KEY, channel TEXT, thread TEXT, role TEXT, body TEXT, sent INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS seen(id TEXT PRIMARY KEY, at TEXT);
      CREATE TABLE IF NOT EXISTS completion_notices(job TEXT, epoch INTEGER, seq INTEGER, PRIMARY KEY(job,epoch));
      CREATE TABLE IF NOT EXISTS coordination(seq INTEGER PRIMARY KEY AUTOINCREMENT,job TEXT,request TEXT,decision TEXT,at TEXT);`);
    if (!this.db.prepare('PRAGMA table_info(deliveries)').all().some(c => c.name === 'broadcast')) this.db.exec('ALTER TABLE deliveries ADD COLUMN broadcast INTEGER NOT NULL DEFAULT 0');
    for (const j of this.list()) if (['running', 'queued'].includes(j.status)) this.update(j.id, { status: 'paused', note: 'Service restarted; resume from saved checkpoints.' });
  }
  create(data) {
    const j = { id: randomUUID(), epoch: 0, status: 'queued', sessions: {}, workspaces: {}, created: new Date().toISOString(), ...data };
    this.db.prepare('INSERT INTO jobs VALUES(?,?)').run(j.id, JSON.stringify(j)); return j;
  }
  get(id) { const row = this.db.prepare('SELECT data FROM jobs WHERE id=?').get(id); return row ? JSON.parse(row.data) : null; }
  list() { return this.db.prepare('SELECT data FROM jobs ORDER BY rowid DESC LIMIT 100').all().map(r => JSON.parse(r.data)); }
  update(id, patch) { const j = this.get(id); if (!j) throw Error('Job not found'); Object.assign(j, patch, { updated: new Date().toISOString() }); this.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(j), id); return j; }
  step(id, epoch, key) { const r = this.db.prepare('SELECT data FROM steps WHERE job=? AND epoch=? AND key=?').get(id, epoch, key); return r ? JSON.parse(r.data) : null; }
  saveStep(id, epoch, key, result) { this.db.prepare('INSERT OR REPLACE INTO steps VALUES(?,?,?,?)').run(id, epoch, key, JSON.stringify(result)); }
  appendMessage(id, role, stage, body, broadcast = false) {
    body = redact(body); const at = new Date().toISOString();
    const r = this.db.prepare('INSERT INTO messages(job,role,stage,body,at) VALUES(?,?,?,?,?)').run(id, role, stage, body, at);
    const j = this.get(id);
    if (j?.channel && j?.thread) this.db.prepare('INSERT INTO deliveries(seq,channel,thread,role,body,broadcast) VALUES(?,?,?,?,?,?)').run(r.lastInsertRowid, j.channel, j.thread, role, `[${stage}]\n${body}`, Number(broadcast));
    return Number(r.lastInsertRowid);
  }
  message(id, role, stage, body) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const seq = this.appendMessage(id, role, stage, body);
      this.db.exec('COMMIT'); return seq;
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  appendCompletion(id) {
    const j = this.get(id);
    if (j?.status !== 'completed' || !j.channel || !j.thread || !/^[UW][A-Z0-9]+$/.test(j.owner || '')) return null;
    const existing = this.db.prepare('SELECT seq FROM completion_notices WHERE job=? AND epoch=?').get(id, j.epoch);
    if (existing) return existing.seq;
    const seq = this.appendMessage(id, 'codex', '任务已完成', completionBody(j), true);
    this.db.prepare('INSERT INTO completion_notices VALUES(?,?,?)').run(id, j.epoch, seq);
    return seq;
  }
  notifyCompletion(id) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const seq = this.appendCompletion(id); this.db.exec('COMMIT'); return seq; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  finish(id, patch, body) {
    // Commit the final state and durable notification together, even across a crash.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.update(id, patch);
      this.appendMessage(id, 'system', patch.taskType==='discussion'?(patch.status==='completed'?'讨论已收敛':'讨论仍有分歧'):patch.status === 'completed' ? '已交付' : '需要你的决定', body);
      this.appendCompletion(id);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  messages(id) { return this.db.prepare('SELECT * FROM messages WHERE job=? ORDER BY seq').all(id); }
  pending() { return this.db.prepare('SELECT * FROM deliveries WHERE sent=0 ORDER BY seq LIMIT 20').all(); }
  delivered(seq) { this.db.prepare('UPDATE deliveries SET sent=1 WHERE seq=?').run(seq); }
  recordDecision(id, request, decision) { this.db.prepare('INSERT INTO coordination(job,request,decision,at) VALUES(?,?,?,?)').run(id, redact(request), redact(JSON.stringify(decision)), new Date().toISOString()); }
  decisions(id) { return this.db.prepare('SELECT request,decision FROM coordination WHERE job=? ORDER BY seq DESC LIMIT 6').all(id).reverse().map(r => ({ request: r.request, ...JSON.parse(r.decision) })); }
  claimEvent(id) {
    const r = this.db.prepare('INSERT OR IGNORE INTO seen VALUES(?,?)').run(id, new Date().toISOString());
    return Number(r.changes) === 1;
  }
  findThread(channel, thread) { return this.list().find(j => j.channel === channel && j.thread === thread); }
  close() { this.db.close(); }
}
