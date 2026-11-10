import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { childEnv, redact, ROOT } from './config.js';
const exec = promisify(execFile);
export const shellQuote = s => "'" + String(s).replaceAll("'", "'\\''") + "'";
export function allowedHost(config, host) {
  if (!config.capabilities?.ssh?.enabled || !config.capabilities.ssh.hosts.includes(host)) throw Error('SSH alias is not enabled for this service');
  return host;
}
export async function sshOptions(host) {
  const r = await exec('/usr/bin/ssh', ['-G', host], { timeout:5000, maxBuffer:100000 });
  const values = Object.fromEntries(r.stdout.split('\n').filter(Boolean).map(l=>{const i=l.indexOf(' ');return [l.slice(0,i),l.slice(i+1)];}));
  const common = ['-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10','-o','ConnectionAttempts=1'];
  if (values.controlmaster === 'false' || !values.controlpath || values.controlpath === 'none') {
    // OpenSSH adds a random suffix while creating a master. macOS has a short
    // Unix-socket limit, so do not use its much longer per-user TMPDIR here.
    const folder=resolve('/private/tmp', 'ar-' + process.getuid() + '-' + createHash('sha256').update(ROOT).digest('hex').slice(0,8));
    mkdirSync(folder,{recursive:true,mode:0o700});
    const info=lstatSync(folder);if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid())throw Error('Untrusted SSH socket directory');
    chmodSync(folder,0o700);
    common.push('-o','ControlMaster=auto','-o','ControlPersist=30m','-o','ControlPath='+resolve(folder,createHash('sha256').update(host).digest('hex').slice(0,16)));
  }
  return common;
}
export async function sshRun(config, host, command, { timeout=60000,signal } = {}) {
  allowedHost(config, host);
  const args=[...await sshOptions(host),'-o','BatchMode=yes',host,'bash -s'];
  return new Promise(resolve => {
    const p=spawn('/usr/bin/ssh',args,{env:childEnv(),stdio:['pipe','pipe','pipe']});
    const abort=()=>p.kill('SIGTERM');signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    let stdout='',stderr='',done=false;
    const timer=setTimeout(()=>{p.kill('SIGTERM');},timeout);
    const force=setTimeout(()=>p.kill('SIGKILL'),timeout+3000);
    p.stdout.on('data',b=>{stdout=(stdout+b).slice(-100000);});p.stderr.on('data',b=>{stderr=(stderr+b).slice(-16000);});
    p.stdin.on('error',()=>{});p.stdin.end(command+'\n');
    const finish=(code,error)=>{if(done)return;done=true;clearTimeout(timer);clearTimeout(force);signal?.removeEventListener('abort',abort);const detail=error||stderr;resolve({ok:code===0,exitCode:code,stdout:redact(stdout),stderr:redact(detail),...(code===255?{needsLogin:/Permission denied.*(?:password|keyboard-interactive)|authentication.*required/i.test(detail),hostKeyFailure:/HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(detail)}: {})});};
    p.once('error',e=>finish(null,e.message));p.once('close',code=>finish(code));
  });
}
export class SshAccess {
  constructor(config) { this.config=config;this.sessions=new Map();this.checks=new Map(); }
  async check(host) {
    const r=await sshRun(this.config,host,"printf '\\nAGENT_ROOM_IDENTITY\\n'; hostname; whoami; uname -m; pwd",{timeout:15000});
    const data={host,...r,at:new Date().toISOString()};this.checks.set(host,data);return data;
  }
  publicState() {
    return {hosts:this.config.capabilities?.ssh?.hosts || [],checks:[...this.checks.values()].map(({host,ok,at,stderr})=>({host,ok,at,error:stderr.slice(-600)})),
      sessions:[...this.sessions.values()].map(({id,host,status,output,at})=>({id,host,status,output,at}))};
  }
  async login(host) {
    allowedHost(this.config,host);
    const existing=[...this.sessions.values()].find(s=>s.host===host&&s.status==='running');if(existing)return {id:existing.id,host};
    if(!this.config.capabilities?.pythonBin)throw Error('Interactive SSH needs the configured Python terminal runtime');
    const id=randomUUID(),opts=await sshOptions(host);
    const p=spawn(this.config.capabilities.pythonBin,[resolve(ROOT,'src/pty-bridge.py'),'/usr/bin/ssh',...opts,host,"printf '\\nAGENT_ROOM_LOGIN_OK\\n'; hostname; whoami"],{env:childEnv(),stdio:['pipe','pipe','pipe']});
    const s={id,host,status:'running',output:'',at:new Date().toISOString(),process:p};this.sessions.set(id,s);
    const timer=setTimeout(()=>p.kill('SIGTERM'),300000),force=setTimeout(()=>p.kill('SIGKILL'),303000);timer.unref();force.unref();
    const capture=b=>{s.output=redact((s.output+b.toString()).replace(/\x1b\[[0-9;]*[A-Za-z]/g,'')).slice(-18000);};p.stdout.on('data',capture);p.stderr.on('data',capture);
    p.once('error',e=>{s.output+='\n'+redact(e.message);s.status='failed';});
    p.once('close',code=>{clearTimeout(timer);clearTimeout(force);s.status=code===0&&s.output.includes('AGENT_ROOM_LOGIN_OK')?'connected':'failed';s.process=null;setTimeout(()=>this.sessions.delete(id),600000).unref();});
    p.stdin.on('error',()=>{});
    return {id,host};
  }
  input(id,text) {
    const s=this.sessions.get(id);if(!s?.process||s.status!=='running')throw Error('No interactive login is waiting');
    if(typeof text!=='string'||text.length>4096)throw Error('Invalid terminal input');
    // Input is written directly to the PTY. It is never logged or persisted.
    s.process.stdin.write(text+'\n');
  }
  cancel(id) { const s=this.sessions.get(id);if(s?.process){const p=s.process;p.kill('SIGTERM');setTimeout(()=>{if(s.process===p)p.kill('SIGKILL');},3000).unref();} }
  close() { for(const s of this.sessions.values())this.cancel(s.id); }
}
