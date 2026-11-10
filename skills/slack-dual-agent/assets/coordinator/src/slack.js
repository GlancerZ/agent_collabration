import { createHash } from 'node:crypto';
import { redact } from './config.js';
import { Coordinator } from './coordinator.js';

export function parseCommand(text) {
  const clean = text.replace(/<@[A-Z0-9]+>/g, '').trim();
  const m = clean.match(/^(independent|collaborate|独立|协作)(?:\s+project=([\w-]+))?\s+([\s\S]+)$/i);
  if (m) return { action: 'start', mode: ['independent', '独立'].includes(m[1].toLowerCase()) ? 'independent' : 'collaborate', project: m[2] || 'scratch', prompt: m[3] };
  const c = clean.match(/^(pause|resume|cancel|status|暂停|继续|取消|状态)$/i);
  if (c) return { action: ({ 暂停: 'pause', 继续: 'resume', 取消: 'cancel', 状态: 'status' })[c[1]] || c[1].toLowerCase() };
  return { action: 'note', note: clean };
}
export function allowedEvent(event, config) {
  return !!event.user && !event.bot_id && !event.bot_profile && !event.subtype &&
    config.slack.channelIds.includes(event.channel) && config.slack.userIds.includes(event.user);
}
export const HELP = '发起任务：\n@Codex independent 任务（验收要求可选）\n@Codex collaborate 任务（验收要求可选）\n完成后 Codex 会在频道 @你通知。在原任务讨论串里可直接查看结果、询问进度、解释或提出修改，无须重新 @。协调者会先判断需求，再安排执行。也可发送 pause / resume / cancel / status。';

export class SlackBridge {
  constructor({ store, engine, config, coordinator }) { Object.assign(this, { store, engine, config }); this.coordinator = coordinator || new Coordinator({ store, engine, config }); this.state = 'disconnected'; this.flushing = false; }
  async connect() {
    if (this.app) throw Error('Slack is already connected');
    const { App } = await import('@slack/bolt');
    const c = this.config.slack;
    const app = new App({ token: c.codexToken, appToken: c.appToken, socketMode: true });
    const { WebClient } = await import('@slack/web-api');
    const claude = new WebClient(c.claudeToken);
    const [a, b] = await Promise.all([app.client.auth.test(), claude.auth.test()]);
    if (a.team_id !== b.team_id || a.user_id === b.user_id) throw Error('Bot tokens must belong to two different bots in the same workspace');
    for (const channel of c.channelIds) {
      for (const client of [app.client, claude]) {
        const result = await client.conversations.info({ channel });
        if (!result.channel?.is_member) throw Error('Invite both bots to every allowed channel first');
      }
    }
    this.clients = { codex: app.client, claude, system: app.client, user: app.client };
    app.event('app_mention', async ({ event }) => this.handle(event));
    app.event('message', async ({ event }) => this.handle(event));
    app.error(async e => { this.state = 'error: ' + redact(e.code || e.message).slice(0, 200); });
    await app.start(); this.app = app; this.state = 'connected';
    this.timer = setInterval(() => void this.flush(), 1500); await this.flush();
  }
  async handle(event) {
    if (!allowedEvent(event, this.config)) return;
    const thread = event.thread_ts || event.ts;
    const existing = this.store.findThread(event.channel, thread);
    // Normal channel chat is not a task; a start must explicitly mention the receiver bot.
    if (!existing && event.type !== 'app_mention') return;
    if (!this.store.claimEvent(`${event.channel}:${event.ts}`)) return;
    try {
      const cmd = parseCommand(event.text || '');
      if (existing) {
        if (event.user !== existing.owner) return;
        if (cmd.action === 'status') this.store.message(existing.id, 'codex', '状态', this.coordinator.statusReply(this.store.get(existing.id)));
        else if (['pause', 'resume', 'cancel'].includes(cmd.action)) this.engine.control(existing.id, cmd.action);
        else if (cmd.action === 'start') throw Error('Start a new task in a new channel message.');
        else if (cmd.note) await this.coordinator.handle(existing.id, cmd.note);
      } else if (cmd.action === 'start') this.engine.start(cmd, { channel: event.channel, thread, owner: event.user });
      else await this.clients.codex.chat.postMessage({ channel: event.channel, thread_ts: thread, text: HELP, unfurl_links: false, unfurl_media: false });
    } catch (e) {
      if (existing) this.store.message(existing.id, 'system', '请求未执行', redact(e.message));
      else await this.clients.codex.chat.postMessage({ channel: event.channel, thread_ts: thread, text: redact(e.message), unfurl_links: false, unfurl_media: false });
    }
  }
  async flush() {
    if (this.flushing || !this.clients) return; this.flushing = true;
    try {
      for (const item of this.store.pending()) {
        const client = this.clients[item.role] || this.clients.codex;
        let body = redact(item.body);
        if (item.broadcast) {
          // A broadcast remains a reply to the original task, so follow-ups keep their context.
          try {
            const { permalink } = await client.chat.getPermalink({ channel: item.channel, message_ts: item.thread });
            if (/^https:\/\/[a-z0-9.-]+\.slack\.com\//i.test(permalink)) body += `\n<${permalink}|查看成果与原任务讨论串>`;
          } catch { body += '\n点击本条消息的“查看讨论串”即可继续。'; }
        }
        const chunks = body.match(/[\s\S]{1,3000}/g) || [''];
        for (let i = 0; i < chunks.length; i++) {
          // A stable message id limits duplicate delivery on reconnect; delivery is at least once.
          const hex = createHash('sha256').update(`${item.seq}:${i}`).digest('hex').slice(0, 32);
          const msgId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
          await client.chat.postMessage({ channel: item.channel, thread_ts: item.thread, ...(item.broadcast && i === 0 ? { reply_broadcast: true } : {}), text: chunks[i], client_msg_id: msgId, unfurl_links: false, unfurl_media: false });
        }
        this.store.delivered(item.seq);
      }
    } catch (e) { this.state = 'delivery pending: ' + redact(e.data?.error || e.code || e.message).slice(0, 200); }
    finally { this.flushing = false; }
  }
  async disconnect() { clearInterval(this.timer); if (this.app) await this.app.stop(); this.app = null; this.clients = null; this.state = 'disconnected'; }
}
