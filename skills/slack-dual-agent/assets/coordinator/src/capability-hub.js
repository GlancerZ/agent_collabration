import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, realpathSync, existsSync } from 'node:fs';
import { resolve, relative, isAbsolute, join, basename } from 'node:path';
import { capabilities } from './capability-config.js';
import { childEnv, redact } from './config.js';
import { SshAccess, sshRun, sshOptions, shellQuote, allowedHost } from './ssh-access.js';
import {NativeDesktop}from './worker-desktop.js';
const exec=promisify(execFile);
const str=(description,extra={})=>({type:'string',description,...extra});
const obj=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const descriptor=(name,description,inputSchema,readOnly=true)=>({name,description,inputSchema,
  annotations:{readOnlyHint:readOnly,destructiveHint:false,openWorldHint:true}});
export function safePath(root,path,{mustExist=false}={}) {
  const base=realpathSync(root),target=resolve(base,path);
  const lexical=relative(base,target);if(lexical==='..'||lexical.startsWith('../')||isAbsolute(lexical))throw Error('Path is outside this worker workspace');
  let parent=target;while(!existsSync(parent)){const next=resolve(parent,'..');if(next===parent)break;parent=next;}
  const actual=realpathSync(parent),r=relative(base,actual);if(r==='..'||r.startsWith('../')||isAbsolute(r))throw Error('Symlink escapes the worker workspace');
  if(mustExist&&!existsSync(target))throw Error('File does not exist');
  if(lexical.split(/[\\/]/).some(s=>['.ssh','.aws','.git','.env','.codex','.claude','.npmrc','.netrc','.pypirc'].includes(s)||s.startsWith('.env.')))throw Error('Private configuration is not exposed by capability tools');
  return target;
}
const textResult=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
export class CapabilityHub {
  constructor(config) {this.config=config;this.contexts=new Map();this.ssh=new SshAccess(config);this.browser=null;this.desktop=new NativeDesktop(config);this.audit=[];this.cleanups=new Set();}
  register(input) {
    const token=randomBytes(32).toString('hex'),ctx={...input,root:realpathSync(input.cwd),controller:new AbortController()};
    this.contexts.set(token,ctx);const tools=this.tools(ctx);
    return {gateway:`http://127.0.0.1:${this.config.port}/internal/capabilities/${token}`,tools:tools.map(t=>t.name),release:()=>{ctx.controller.abort();this.contexts.delete(token);const p=this.desktop.dispose(ctx).catch(()=>{});this.cleanups.add(p);p.finally(()=>this.cleanups.delete(p));}};
  }
  tools(ctx) {
    const c=capabilities(this.config),tools=[];
    if(c.desktop.enabled)tools.push(...this.desktop.tools(ctx));
    if(c.dependencyCommands&&!ctx.readOnly) tools.push(descriptor('project_install','Install registry packages into THIS worker project only. npm uses the current workspace; Python uses its .venv. No global installation. Default npm lifecycle scripts are disabled.',obj({manager:{type:'string',enum:['npm','python']},packages:{type:'array',items:str('Registry package with optional version'),minItems:1,maxItems:30},runScripts:{type:'boolean',default:false}},['manager','packages']),false));
    if(c.ssh.enabled) {
      tools.push(descriptor('ssh_status','Check an enabled SSH alias using existing identities and connection reuse. Never prompts for passwords/MFA; if login is needed, open the local access page.',obj({host:str('Enabled SSH alias',{enum:c.ssh.hosts})},['host'])));
      tools.push(descriptor('ssh_read_file','Read a bounded portion of a real remote task file without modifying it. Reports total size, modification time and hash of the returned bytes; credential directories are excluded. Available during review.',obj({host:str('Enabled SSH alias',{enum:c.ssh.hosts}),path:str('Remote task file path'),offset:{type:'integer',minimum:0},maxBytes:{type:'integer',minimum:1,maximum:32000}},['host','path'])));
      if(!ctx.readOnly) {
        tools.push(descriptor('ssh_exec','Execute a shell command on an enabled server. Use only task-authorized paths and resources. The default remote directory is separate for each worker; specify cwd when the user designated an existing project. Credentials stay in the existing SSH client.',obj({host:str('Enabled SSH alias',{enum:c.ssh.hosts}),command:str('Task command',{maxLength:30000}),cwd:str('Optional approved absolute remote project directory'),timeoutSec:{type:'integer',minimum:1,maximum:300}},['host','command']),false));
        for(const direction of ['upload','download'])tools.push(descriptor('ssh_'+direction,`Transfer one task file ${direction==='upload'?'to':'from'} an enabled SSH alias. Local paths are confined to this worker workspace; do not transfer credentials.`,obj({host:str('Enabled SSH alias',{enum:c.ssh.hosts}),localPath:str('Path inside your own workspace'),remotePath:str('Task-authorized remote file path')},['host','localPath','remotePath']),false));
      }
    }
    if(c.browser.enabled) {
      tools.push(descriptor('browser_navigate','Open an http(s) page in your own browser. No access to the management page. Browser sessions persist across your task stages.',obj({url:str('Page URL')},['url']),false));
      tools.push(descriptor('browser_open_file','Open a real HTML file from your own or the provided peer workspace through an isolated local preview server.',obj({path:str('Actual HTML path')},['path'])));
      tools.push(descriptor('browser_snapshot','Read the current page title, URL, visible text and interactive element references.',obj({})));
      tools.push(descriptor('browser_screenshot','Inspect the current page as an image. In execution you may also save a PNG inside your own workspace.',obj({filename:str('Optional relative .png filename')})));
      tools.push(descriptor('browser_click','Click a current element reference from browser_snapshot. External submissions and sensitive controls require human handoff. Does not execute arbitrary JavaScript.',obj({ref:str('Element reference from the latest snapshot')},['ref']),false));
      tools.push(descriptor('browser_fill','Fill a text field from browser_snapshot. Password, payment, credential and other sensitive inputs require direct human entry.',obj({ref:str('Element reference'),text:str('Text to enter',{maxLength:20000})},['ref','text']),false));
      tools.push(descriptor('browser_wait','Wait for visible text to appear, then read the page.',obj({text:str('Expected visible text'),timeoutSec:{type:'integer',minimum:1,maximum:30}},['text'])));
      tools.push(descriptor('browser_console','Read console errors and page errors captured in your browser.',obj({})));
    }
    return tools;
  }
  lookup(token) {const c=this.contexts.get(token);if(!c)throw Error('Worker capability session expired');return c;}
  async handle(token,name,args) {
    const ctx=this.lookup(token),event={at:new Date().toISOString(),role:ctx.role,tool:name,readOnly:ctx.readOnly};
    this.audit.push(event);this.audit=this.audit.slice(-500);
    try {const result=await this.perform(token,name,args);event.completed=true;event.isError=!!result.isError;try{const body=JSON.parse(result.content?.find(c=>c.type==='text')?.text);event.operationSucceeded=body.ok!==false&&!body.needsHuman;}catch{}return result;}
    catch(e){event.completed=true;event.isError=true;event.error=redact(e.message);throw e;}
  }
  async perform(token,name,args) {
    const ctx=this.lookup(token);if(!this.tools(ctx).some(t=>t.name===name))throw Error('Tool is not available in this worker stage');
    if(!args||typeof args!=='object'||Array.isArray(args))throw Error('Invalid tool arguments');
    if(name.startsWith('desktop_'))return this.desktop.call(ctx,name,args,safePath);
    if(name==='project_install')return textResult(await this.install(ctx,args));
    if(name==='ssh_status')return textResult(this.loginResult(await this.ssh.check(args.host)));
    if(name==='ssh_read_file') {
      if(typeof args.path!=='string'||!args.path||/[\r\n\0]/.test(args.path))throw Error('Invalid remote file path');
      const code='import os,json,hashlib,base64,sys\np=os.path.realpath(os.path.expanduser(sys.argv[1]))\nparts=p.split(os.sep)\nif any(x in [".ssh",".aws",".env",".codex",".claude",".npmrc",".netrc",".pypirc"] or x.startswith(".env.") for x in parts): raise ValueError("Credential configuration is excluded")\ns=os.stat(p)\no=int(sys.argv[2]);n=int(sys.argv[3])\nwith open(p,"rb") as f:\n f.seek(o);b=f.read(n)\ntry: text=b.decode("utf-8");encoding="utf-8"\nexcept UnicodeDecodeError: text=base64.b64encode(b).decode();encoding="base64"\nprint(json.dumps({"path":p,"totalBytes":s.st_size,"mtimeNs":s.st_mtime_ns,"offset":o,"returnedBytes":len(b),"sha256OfReturnedBytes":hashlib.sha256(b).hexdigest(),"encoding":encoding,"content":text,"truncated":o+len(b)<s.st_size}))';
      const offset=Number.isInteger(args.offset)&&args.offset>=0?args.offset:0,max=Number.isInteger(args.maxBytes)?Math.min(32000,Math.max(1,args.maxBytes)):16000;
      const r=await sshRun(this.config,args.host,'python3 -c '+shellQuote(code)+' '+shellQuote(args.path)+' '+offset+' '+max,{timeout:20000,signal:ctx.controller.signal});
      return textResult(r.ok?{ok:true,...JSON.parse(r.stdout)}:this.loginResult(r));
    }
    if(name==='ssh_exec') {
      if(typeof args.command!=='string'||!args.command.trim()||args.command.length>30000)throw Error('Invalid remote command');
      if(args.cwd&&(!args.cwd.startsWith('/')||/[\r\n\0]/.test(args.cwd)))throw Error('Remote cwd must be an approved absolute path');
      const id=basename(resolve(ctx.root,'..')).replace(/[^a-zA-Z0-9_-]/g,'_'),role=ctx.role;
      const directory=args.cwd?shellQuote(args.cwd):'"$HOME"/agent-room/tasks/'+shellQuote(id+'/'+role);
      const script=(args.cwd?'':'mkdir -p -- '+directory+'\n')+'cd -- '+directory+'\n'+args.command;
      return textResult(this.loginResult(await sshRun(this.config,args.host,script,{timeout:Math.min(300,Math.max(1,args.timeoutSec||60))*1000,signal:ctx.controller.signal})));
    }
    if(name==='ssh_upload'||name==='ssh_download')return textResult(await this.transfer(ctx,name,args));
    if(name.startsWith('browser_')) {
      this.browserReady ||= import('./worker-browser.js').then(m=>{this.browser=new m.WorkerBrowsers(this.config);return this.browser;});
      await this.browserReady;
      return this.browser.call(ctx,name,args);
    }
    throw Error('Unknown worker tool');
  }
  loginResult(r) {return r.ok?r:{...r,recoveryUrl:`http://127.0.0.1:${this.config.port}/#access`,instruction:r.needsLogin?'需要交互认证。请在本机“服务器与浏览器”页登录此别名，完成后在原任务讨论串发送 resume；不要把密码或 OTP 发到 Slack。':'此请求失败，请按实际错误排查，不自动重试 MFA。'};}
  async install(ctx,args) {
    const c=capabilities(this.config);
    if(args.runScripts!==undefined&&typeof args.runScripts!=='boolean')throw Error('runScripts must be a boolean');
    if(!['npm','python'].includes(args.manager)||!Array.isArray(args.packages)||!args.packages.length||args.packages.length>30||args.packages.some(p=>typeof p!=='string'||p.startsWith('-')||!/^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+(?:[@<>=!~^][A-Za-z0-9_.<>=!~^*+,-]+)?$/.test(p)))throw Error('Use registry package names with optional versions');
    const env={...childEnv(),npm_config_cache:join(ctx.root,'.cache/npm'),PIP_CACHE_DIR:join(ctx.root,'.cache/pip'),UV_CACHE_DIR:join(ctx.root,'.cache/uv')};
    for(const k of ['PIP_TARGET','PIP_PREFIX','PIP_USER','PYTHONUSERBASE','npm_config_global','NPM_CONFIG_GLOBAL'])delete env[k];
    safePath(ctx.root,args.manager==='npm'?'node_modules':'.venv');safePath(ctx.root,'.cache');
    let executable,argv;
    if(args.manager==='npm') {executable=resolve(process.execPath,'../npm');argv=['install','--global=false','--prefix',ctx.root,'--no-audit','--no-fund',...(!args.runScripts?['--ignore-scripts']:[]),...args.packages];}
    else {
      if(!c.pythonBin)throw Error('No Python runtime configured');
      const venv=safePath(ctx.root,'.venv');
      if(!existsSync(join(venv,'bin/python')))await exec(c.pythonBin,['-m','venv',venv],{cwd:ctx.root,env,timeout:60000,signal:ctx.controller.signal,maxBuffer:100000});
      executable=join(venv,'bin/python');argv=['-m','pip','install','--disable-pip-version-check',...args.packages];
    }
    try {const r=await exec(executable,argv,{cwd:ctx.root,env,timeout:240000,signal:ctx.controller.signal,maxBuffer:200000});return {ok:true,manager:args.manager,packages:args.packages,project:ctx.root,stdout:redact(r.stdout).slice(-16000),stderr:redact(r.stderr).slice(-4000)};}
    catch(e){return {ok:false,manager:args.manager,exitCode:e.code,stdout:redact(e.stdout||'').slice(-8000),stderr:redact(e.stderr||e.message).slice(-8000)};}
  }
  async transfer(ctx,name,args) {
    const host=allowedHost(this.config,args.host);
    if(typeof args.remotePath!=='string'||!args.remotePath||/[\r\n\0]/.test(args.remotePath)||/(^|\/)\.(ssh|aws|env)(\/|$)/.test(args.remotePath))throw Error('Invalid remote task file path');
    const upload=name==='ssh_upload',local=safePath(ctx.root,args.localPath,{mustExist:upload});
    if(!upload)mkdirSync(resolve(local,'..'),{recursive:true});
    const remote=host+':'+args.remotePath;
    try {const r=await exec('/usr/bin/scp',[...await sshOptions(host),'-o','BatchMode=yes',...(upload?[local,remote]:[remote,local])],{env:childEnv(),timeout:120000,signal:ctx.controller.signal,maxBuffer:100000});return {ok:true,host,localPath:local,remotePath:args.remotePath,stdout:redact(r.stdout)};}
    catch(e){return this.loginResult({ok:false,exitCode:e.code,needsLogin:e.code===255,stderr:redact(e.stderr||e.message).slice(-4000)});}
  }
  async close() {for(const c of this.contexts.values())c.controller.abort();this.contexts.clear();this.ssh.close();await this.browser?.close();await this.desktop.close();await Promise.allSettled([...this.cleanups]);}
}
