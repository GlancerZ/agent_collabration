import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { publicConfig, saveConfig, validateConfig, ROOT, redact } from './config.js';
import { availableArtifacts } from './artifacts.js';
import { jobAnswer } from './answers.js';

export function buildServer({ store, engine, bridge, config, doctor, coordinator = bridge.coordinator, capabilities:hub }) {
  const csrf = randomBytes(32).toString('hex');
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'");
    const json = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    try {
      const origin = `http://127.0.0.1:${config.port}`;
      if (req.headers.host !== `127.0.0.1:${config.port}`) return json(403, { error: 'Use the loopback address 127.0.0.1' });
      const url = new URL(req.url, origin), path = url.pathname;
      const capabilityRoute=path.match(/^\/internal\/capabilities\/([a-f0-9]{64})$/);
      if(capabilityRoute&&hub) {
        const ctx=hub.lookup(capabilityRoute[1]);
        if(req.method==='GET')return json(200,{tools:hub.tools(ctx)});
        if(req.method==='POST') {
          const parts=[];let bytes=0;for await(const b of req){bytes+=b.length;if(bytes>100000)return json(413,{error:'Too large'});parts.push(b);}
          const body=JSON.parse(Buffer.concat(parts).toString());
          try {return json(200,await hub.handle(capabilityRoute[1],body.tool,body.args));}
          catch(e){return json(200,{isError:true,content:[{type:'text',text:redact(e.message)}]});}
        }
        return json(405,{error:'Unsupported method'});
      }
      if (req.method === 'GET' && (['/', '/app.js', '/access.js', '/style.css', '/deliverables.js', '/presentation.js'].includes(path) || /^\/presentation\/[a-f0-9-]+$/.test(path))) {
        const file = path.startsWith('/presentation/') ? ['presentation.html', 'text/html'] : { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/access.js': ['access.js', 'text/javascript'], '/deliverables.js': ['deliverables.js', 'text/javascript'], '/presentation.js': ['presentation.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] }[path];
        res.writeHead(200, { 'Content-Type': file[1] + '; charset=utf-8' }); return res.end(readFileSync(resolve(ROOT, 'public', file[0])));
      }
      if (req.method === 'GET' && path === '/api/state') return json(200, { config: publicConfig(config), jobs: store.list(), slack: bridge.state, csrf });
      if (req.method === 'GET' && path === '/api/doctor') return json(200, await doctor());
      if (req.method === 'GET' && path === '/api/access'&&hub) return json(200,{ssh:hub.ssh.publicState(),browser:hub.browser?.state()||[],desktop:hub.desktop.state()});
      if (req.method === 'GET' && /^\/api\/jobs\/[a-f0-9-]+$/.test(path)) {
        const id = path.split('/').pop(), job = store.get(id);
        return json(200, { job, answer:job?jobAnswer(job):null,messages: store.messages(id), artifacts: job ? availableArtifacts(job, config.port).map(({ id, role, kind, versionLabel, name, bytes, extension, url, downloadUrl }) => ({ id, role, kind, versionLabel, name, bytes, extension, url, downloadUrl })) : [] });
      }
      const artifactRoute = path.match(/^\/artifacts\/([a-f0-9-]+)\/(codex|claude)\/([a-f0-9]{24})$/);
      if (req.method === 'GET' && artifactRoute) {
        const job = store.get(artifactRoute[1]);
        const file = job && availableArtifacts(job, config.port).find(f => f.role === artifactRoute[2] && f.id === artifactRoute[3]);
        if (!file) return json(404, { error: 'Artifact not available' });
        const html = ['.html', '.htm'].includes(file.extension) && !url.searchParams.has('download');
        // Render user artifacts in an opaque sandbox, isolated from local management APIs.
        res.setHeader('Content-Security-Policy', "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-ancestors 'self'; form-action 'none'");
        res.setHeader('Content-Disposition', `${url.searchParams.has('download') ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
        res.writeHead(200, { 'Content-Type': html ? 'text/html; charset=utf-8' : url.searchParams.has('download') ? 'application/octet-stream' : 'text/plain; charset=utf-8' });
        return res.end(readFileSync(file.path));
      }
      if (req.method !== 'POST') return json(404, { error: 'Not found' });
      const token = String(req.headers['x-agent-room-csrf'] || '');
      if (req.headers.origin !== origin || token.length !== csrf.length || !timingSafeEqual(Buffer.from(token), Buffer.from(csrf)) || !String(req.headers['content-type']).startsWith('application/json')) return json(403, { error: 'Same-origin JSON request required' });
      const parts = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 100000) return json(413, { error: 'Request too large' }); parts.push(chunk); }
      const body = JSON.parse(Buffer.concat(parts).toString() || '{}');
      if(path==='/api/access/check'&&hub)return json(200,await hub.ssh.check(body.host));
      if(path==='/api/access/login'&&hub)return json(200,await hub.ssh.login(body.host));
      if(path==='/api/access/input'&&hub){hub.ssh.input(body.id,body.text);return json(200,{ok:true});}
      if(path==='/api/access/cancel'&&hub){hub.ssh.cancel(body.id);return json(200,{ok:true});}
      if(path==='/api/access/browser-focus'&&hub){if(!hub.browser)throw Error('No browser window is open');return json(200,await hub.browser.focus(body.id));}
      if(path==='/api/access/desktop-control'&&hub){if(!['pause','resume'].includes(body.action))throw Error('Invalid desktop control');if(!config.capabilities.desktop?.enabled)throw Error('Desktop control is not enabled');const state=await hub.desktop.setPaused(body.action==='pause');config.capabilities.desktop.paused=state.paused;saveConfig(config);return json(200,state);}
      if(path==='/api/access/desktop-approval'&&hub)return json(200,hub.desktop.resolveApproval(body.id,body.action,body.content));
      if (path === '/api/config') {
        if (engine.active || bridge.app) throw Error('Pause tasks and disconnect Slack before editing settings');
        const next = structuredClone(body);
        for (const key of ['appToken', 'codexToken', 'claudeToken']) if (next.slack[key] === 'configured' || !next.slack[key]) next.slack[key] = config.slack[key];
        if (next.port !== config.port) throw Error('Change the port in the local config file, then restart');
        validateConfig(next); saveConfig(next); Object.assign(config, next); return json(200, { ok: true });
      }
      if (path === '/api/slack/connect') { validateConfig(config); if (!config.slack.enabled) throw Error('Enable Slack in settings first'); await bridge.connect(); return json(200, { ok: true }); }
      if (path === '/api/slack/disconnect') { await bridge.disconnect(); return json(200, { ok: true }); }
      if (path === '/api/jobs') return json(201, engine.start(body));
      if (path === '/api/followup') return json(200, await coordinator.handle(body.id, body.text));
      if (path === '/api/control') { engine.control(body.id, body.action, body.note); return json(200, { ok: true }); }
      return json(404, { error: 'Not found' });
    } catch (e) { json(400, { error: redact(e.message) }); }
  });
}
