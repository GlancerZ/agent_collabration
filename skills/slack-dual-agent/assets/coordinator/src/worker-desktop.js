import {execFile}from 'node:child_process';
import {promisify}from 'node:util';
import {randomBytes}from 'node:crypto';
import {writeFileSync,mkdirSync,mkdtempSync,rmSync}from 'node:fs';
import {dirname}from 'node:path';
import {tmpdir}from 'node:os';
import {Client}from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport}from '@modelcontextprotocol/sdk/client/stdio.js';
import {ElicitRequestSchema}from '@modelcontextprotocol/sdk/types.js';
import {capabilities}from './capability-config.js';
import {childEnv,redact}from './config.js';
const exec=promisify(execFile),json=x=>({content:[{type:'text',text:JSON.stringify(x)}]});
const strings=(description,extra={})=>({type:'string',description,...extra}),num={type:'number'},index={type:'integer',minimum:0};
const point={type:'array',items:num,minItems:2,maxItems:2};
const tool=(name,description,properties={},required=[],readOnly=true)=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false},annotations:{readOnlyHint:readOnly,destructiveHint:false,openWorldHint:true}});
export const DESKTOP_TOOLS=[
 tool('desktop_status','Read the shared Mac desktop controller state. Uses the existing official Codex Computer Use MCP; each agent keeps its own model and CLI.'),
 tool('desktop_inventory','Read available native Mac apps with official Computer Use. Does not open or activate an app.'),
 tool('desktop_acquire','Reserve desktop access before operating a task-authorized native Mac app. Requests queue; one worker owns the desktop at a time. Acquiring an app may open it. Release promptly before reasoning or unrelated work. Native app approval prompts remain in force.',{app:strings('Exact application name, bundle ID, or application path'),waitSec:{type:'integer',minimum:0,maximum:40}},['app'],false),
 tool('desktop_release','Release the shared desktop so another worker can proceed.'),
 tool('desktop_snapshot','Read a fresh accessibility tree of the reserved app. Element numbers come only from this exact current tree.'),
 tool('desktop_screenshot','Inspect the reserved native app as an image. Optionally save PNG or JPEG inside your own workspace during execution; native JPEG responses are converted when PNG is requested.',{filename:strings('Optional project-relative .png or .jpg filename')}),
 tool('desktop_click','Click a current accessibility element index or app-relative documented screenshot coordinate; returns updated accessibility state. Requires the current snapshot token.',{snapshot:strings('Current snapshot token'),element:index,point},['snapshot'],false),
 tool('desktop_type','Type literal non-sensitive text in the reserved app, optionally clicking a current text field first. Returns fresh state. Passwords, OTPs and other secrets require human entry.',{snapshot:strings('Current snapshot token'),text:strings('Literal text',{maxLength:20000}),element:index},['snapshot','text'],false),
 tool('desktop_set_value','Set a current accessibility control value and read back state. Use only non-sensitive task fields.',{snapshot:strings('Current snapshot token'),element:index,value:strings('Literal value',{maxLength:20000})},['snapshot','element','value'],false),
 tool('desktop_key','Press a key/chord using the documented native app API (for example Return, Escape, or super+a), then read state. External sends, payments, agreements and security approvals require human action.',{snapshot:strings('Current snapshot token'),key:strings('Key or chord',{maxLength:100})},['snapshot','key'],false),
 tool('desktop_scroll','Scroll a current element or point in the reserved app and read state.',{snapshot:strings('Current snapshot token'),element:index,point,direction:{type:'string',enum:['up','down','left','right']},pages:{type:'integer',minimum:1,maximum:5}},['snapshot','direction'],false),
 tool('desktop_drag','Drag between two points in the reserved app and read fresh state. Do not use to grant permissions, submit external actions or move/delete unrelated files.',{snapshot:strings('Current snapshot token'),from:point,to:point},['snapshot','from','to'],false)
];
const mutations=new Set(DESKTOP_TOOLS.filter(t=>!t.annotations.readOnlyHint).map(t=>t.name));
export function desktopAppAllowed(app){return typeof app==='string'&&app.trim()&&app.length<600&&!/[\r\n\0]/.test(app)&&!/(?:^|\/)(?:Terminal|iTerm2?|Warp|ChatGPT|Codex|System Settings|System Preferences|Keychain Access|Passwords)(?:\.app)?$/i.test(app)&&!/^com\.(?:openai\.|apple\.(?:Terminal|systempreferences|keychainaccess|Passwords))/i.test(app);}
const sensitive=/(password|passcode|one.time|otp|security code|api.?key|secret|验证码|密码|口令|私钥|助记词)/i;
export function desktopNeedsHuman({app='',label='',key='',text='',drag=false}){
 if(sensitive.test(label)||sensitive.test(text))return '需要你亲自输入凭据或验证码。';
 if(/send|publish|submit|checkout|purchase|pay\b|buy\b|sell\b|transfer|accept.*terms|allow.*access|grant.*permission|delete permanently|empty trash|发送|发布|提交|付款|支付|买入|卖出|转账|接受.*条款|允许.*访问|授权|永久删除|清空废纸篓/i.test(label))return '此操作需要你确认或亲自完成。';
 if(/(?:mail|outlook|slack|messages|teams|discord|wechat|telegram)/i.test(app)&&/return|enter/i.test(key))return '通讯应用中的发送操作需要你确认；请在窗口中亲自完成。';
 if(/(?:super|cmd|command)\+.*(?:delete|backspace)|(?:alt|option).*super.*escape/i.test(key))return '删除或强制退出操作请由你确认。';
 return '';
}
function inventoryFrom(result){for(const c of result.content||[])if(c.type==='text')try{const x=JSON.parse(c.text);if(Array.isArray(x.apps))return x.apps;}catch{}return null;}
export async function officialDesktopTransport(config){
 const r=await exec(config.agents.codex.bin,['mcp','list','--json'],{env:childEnv(),timeout:20000,maxBuffer:1000000});
 const entry=JSON.parse(r.stdout).find(x=>x.name==='cua_repl'&&x.enabled)?.transport;
 if(entry?.type!=='stdio'||!entry.command||!Array.isArray(entry.args))throw Error('官方 Codex Computer Use MCP 尚未启用。请在 Codex 的 Computer Use 插件中检查配置。');
 const env={...childEnv(),...entry.env};for(const k of entry.env_vars||[])if(process.env[k])env[k]=process.env[k];
 return {command:entry.command,args:entry.args,env,...entry.cwd?{cwd:entry.cwd}:{},stderr:'pipe'};
}
export class NativeDesktop {
 constructor(config,{clientFactory}={}){this.config=config;this.clientFactory=clientFactory;this.sessions=new Map();this.owner=null;this.queue=[];this.approvals=new Map();this.paused=capabilities(config).desktop.paused;this.uncertain=false;this.tail=Promise.resolve();this.inflight=new Set();this.closed=false;this.lastError='';}
 tools(ctx){return DESKTOP_TOOLS.filter(t=>!ctx.readOnly||!mutations.has(t.name)||t.name==='desktop_acquire');}
 state(){return {backend:'codex-native',enabled:capabilities(this.config).desktop.enabled,paused:this.paused,uncertain:this.uncertain,owner:this.owner?{role:this.owner.role,jobId:this.owner.jobId,stage:this.owner.stage,app:this.owner.app}:null,queued:this.queue.map(x=>({role:x.ctx.role,jobId:x.ctx.jobId,app:x.app})),approvals:[...this.approvals.values()].map(({id,role,jobId,app,message,schema,expires})=>({id,role,jobId,app,message,schema,expires})),sessions:this.sessions.size,lastError:this.lastError};}
 async client(ctx){
  if(this.sessions.has(ctx))return this.sessions.get(ctx);
  const promise=(async()=>{let client;if(this.clientFactory)client=await this.clientFactory(ctx);else{const transport=new StdioClientTransport(await officialDesktopTransport(this.config));transport.stderr?.on('data',()=>{});client=new Client({name:'slack-agent-room-'+ctx.role,version:'0.3.0'},{capabilities:{elicitation:{form:{}}}});client.setRequestHandler(ElicitRequestSchema,request=>this.elicit(ctx,request.params));await client.connect(transport,{timeout:30000});}return {client,app:null,snapshot:null,text:'',hasApp:false};})();
  this.sessions.set(ctx,promise);try{return await promise;}catch(e){this.sessions.delete(ctx);this.lastError=redact(e.message);throw e;}
 }
 async js(ctx,code,title){const operation=(async()=>{const s=await this.client(ctx);this.ready();const r=await s.client.callTool({name:'js',arguments:{code,title,timeout_ms:150000}},undefined,{timeout:180000});if(ctx.controller.signal.aborted)throw Error('Desktop session ended');return r;})();this.inflight.add(operation);try{return await operation;}finally{this.inflight.delete(operation);}}
 elicit(ctx,params){
  if(params.mode==='url'||!params.requestedSchema)return Promise.resolve({action:'cancel'});
  const schema=params.requestedSchema;if(Object.entries(schema.properties||{}).some(([k,v])=>sensitive.test(k+' '+(v.title||''))||!['string','boolean','integer','number'].includes(v.type)))return Promise.resolve({action:'cancel'});
  const id=randomBytes(16).toString('hex');
  return new Promise(resolve=>{const a={id,ctx,role:ctx.role,jobId:ctx.jobId,app:this.owner?.ctx===ctx?this.owner.app:'',message:params.message,schema,expires:Date.now()+120000};
   a.finish=result=>{clearTimeout(a.timer);ctx.controller.signal.removeEventListener('abort',a.abort);this.approvals.delete(id);resolve(result);};a.abort=()=>a.finish({action:'cancel'});a.timer=setTimeout(a.abort,120000);ctx.controller.signal.addEventListener('abort',a.abort,{once:true});this.approvals.set(id,a);this.onApproval?.({role:a.role,jobId:a.jobId,app:a.app,message:a.message});
  });
 }
 resolveApproval(id,action,content={}){const a=this.approvals.get(id);if(!a||a.ctx.controller.signal.aborted||Date.now()>a.expires)throw Error('原生授权请求已过期，请重新发起操作。');if(!['accept','decline','cancel'].includes(action))throw Error('Invalid approval action');if(action==='accept'){
   const props=a.schema.properties||{};if(!content||typeof content!=='object'||Array.isArray(content)||Object.keys(content).some(k=>!Object.hasOwn(props,k)))throw Error('Invalid approval fields');
   for(const [k,p]of Object.entries(props)){const v=content[k];if(v===undefined){if(a.schema.required?.includes(k))throw Error('请完成必填授权选项。');continue;}if(p.type==='boolean'?typeof v!=='boolean':p.type==='string'?typeof v!=='string':p.type==='integer'?!Number.isInteger(v):typeof v!=='number'||!Number.isFinite(v))throw Error('Invalid approval value');if(p.enum&&!p.enum.includes(v))throw Error('Invalid approval choice');}
  }a.finish(action==='accept'?{action,content}:{action});return {ok:true};}
 ready(){if(!capabilities(this.config).desktop.enabled)throw Error('Desktop control is disabled');if(this.closed||this.paused||this.uncertain)throw Error('桌面操作已暂停，请在本机管理页检查并继续。');}
 async acquire(ctx,app,waitSec=20){
  this.ready();if(!desktopAppAllowed(app))throw Error('此应用由原生 Computer Use 策略保留给用户操作；不能用桌面控制绕过终端、Codex 或系统权限限制。');
  if(ctx.readOnly){const s=await this.client(ctx);if(!s.inventory?.some(x=>x.isRunning&&(x.id===app||x.displayName===app)))throw Error('Read-only stages must first use desktop_inventory, then select an exact already-running app by its bundle ID or display name.');}
  if(this.owner?.ctx===ctx){await this.tail;this.owner.app=app;return true;}
  return new Promise((resolve,reject)=>{const q={ctx,app,resolve,reject};q.timer=setTimeout(()=>{this.queue=this.queue.filter(x=>x!==q);resolve(false);},Math.min(40,Math.max(0,waitSec))*1000);q.abort=()=>{clearTimeout(q.timer);this.queue=this.queue.filter(x=>x!==q);reject(Error('Desktop request cancelled'));};ctx.controller.signal.addEventListener('abort',q.abort,{once:true});this.queue.push(q);this.grant();});
 }
 grant(){if(this.owner||this.paused||this.closed||this.uncertain)return;while(this.queue.length){const q=this.queue.shift();clearTimeout(q.timer);q.ctx.controller.signal.removeEventListener('abort',q.abort);if(q.ctx.controller.signal.aborted){q.reject(Error('Desktop request cancelled'));continue;}this.owner={ctx:q.ctx,role:q.ctx.role,jobId:q.ctx.jobId,stage:q.ctx.stage,app:q.app};q.resolve(true);return;}}
 async release(ctx){if(this.owner?.ctx===ctx){await this.tail;await Promise.allSettled([...this.inflight]);this.owner=null;const p=this.sessions.get(ctx);if(p){const s=await p.catch(()=>null);if(s)s.snapshot=null;}this.grant();}}
 async dispose(ctx){await this.release(ctx);const p=this.sessions.get(ctx);this.sessions.delete(ctx);if(p){const s=await p.catch(()=>null);await s?.client.close();}}
 async setPaused(value){this.paused=!!value;if(this.paused){for(const a of [...this.approvals.values()])a.finish({action:'cancel'});for(const q of this.queue){clearTimeout(q.timer);q.ctx.controller.signal.removeEventListener('abort',q.abort);q.reject(Error('Desktop control paused by user'));}this.queue=[];await this.tail;await Promise.allSettled([...this.inflight]);this.owner=null;for(const p of this.sessions.values()){const s=await p.catch(()=>null);if(s)s.snapshot=null;}}else{this.uncertain=false;this.lastError='';this.grant();}return this.state();}
 async call(ctx,name,args,safePath){
  if(name==='desktop_status')return json(this.state());
  if(name==='desktop_release'){await this.release(ctx);return json({ok:true,...this.state()});}
  this.ready();if(ctx.controller.signal.aborted)throw Error('Desktop session ended');
  if(name==='desktop_inventory'){const r=await this.js(ctx,'await cua.getState();','查看原生 Mac 应用清单');(await this.client(ctx)).inventory=inventoryFrom(r);return r;}
  if(name==='desktop_acquire'){
   const got=await this.acquire(ctx,args.app,args.waitSec);if(!got)return json({ok:false,busy:true,owner:this.state().owner,instruction:'桌面正由另一位 agent 使用。先继续无需桌面的工作，稍后再申请，不要绕过排队。'});
   try{const s=await this.client(ctx);const r=await this.js(ctx,`${s.hasApp?'roomApp =':'let roomApp ='} await cua.getApp(${JSON.stringify(args.app)});`,'连接任务所需的 Mac 应用');s.hasApp=true;s.app=args.app;if(r.isError){await this.release(ctx);return r;}return this.observed(s,r);}catch(e){await this.dispose(ctx);throw e;}
  }
  if(this.owner?.ctx!==ctx)throw Error('先调用 desktop_acquire 取得桌面使用权；不能操作另一位 agent 的应用。');
  const s=await this.client(ctx);
  if(mutations.has(name)&&ctx.readOnly)throw Error('Desktop mutation is unavailable in a read-only stage');
  if(name==='desktop_snapshot')return this.observed(s,await this.js(ctx,'await roomApp.getAXState({disableDiffing:true});','读取当前应用界面'));
  if(name==='desktop_screenshot'){
   if(args.filename&&ctx.readOnly)throw Error('Read-only stages cannot save screenshots');
   const r=await this.js(ctx,'await roomApp.getScreenshot();','查看当前应用截图');
   if(r.isError)return r;
   if(args.filename){if(!/\.(png|jpe?g)$/i.test(args.filename))throw Error('Screenshot filename must end in .png or .jpg');const p=safePath(ctx.root,args.filename);const image=r.content?.find(c=>c.type==='image'&&['image/png','image/jpeg'].includes(c.mimeType));if(!image)throw Error('Native Computer Use returned no supported image');mkdirSync(dirname(p),{recursive:true});const format=/\.png$/i.test(p)?'png':'jpeg',sourceFormat=image.mimeType==='image/png'?'png':'jpeg';if(format===sourceFormat)writeFileSync(p,Buffer.from(image.data,'base64'));else{const temp=mkdtempSync(tmpdir()+'/agent-room-desktop-image-');try{const input=temp+'/capture.'+(sourceFormat==='jpeg'?'jpg':'png');writeFileSync(input,Buffer.from(image.data,'base64'),{mode:0o600});await exec('/usr/bin/sips',['--setProperty','format',format,input,'--out',p],{timeout:15000,maxBuffer:100000});}finally{rmSync(temp,{recursive:true,force:true});}}r.content.push({type:'text',text:JSON.stringify({savedFile:p,mimeType:'image/'+format,sourceMimeType:image.mimeType})});}
   return r;
  }
  if(!s.snapshot||args.snapshot!==s.snapshot)throw Error('Snapshot token is stale. Call desktop_snapshot before deciding the next action.');
  const target=args.element!==undefined?args.element:args.point;
  const validPoint=p=>Array.isArray(p)&&p.length===2&&p.every(x=>Number.isFinite(x)&&x>=0&&x<30000);
  if(args.element!==undefined&&(!Number.isInteger(args.element)||args.element<0))throw Error('Invalid element index');
  if(args.point!==undefined&&!validPoint(args.point))throw Error('Invalid screenshot point');
  const label=args.element!==undefined?s.text.split('\n').find(l=>new RegExp('^\\s*'+args.element+'\\s').test(l))||'':'';
  const human=desktopNeedsHuman({app:s.app,label,key:args.key||'',text:args.text||args.value||''});if(human)return json({ok:false,needsHuman:true,instruction:human,recoveryUrl:`http://127.0.0.1:${this.config.port}/#access`});
  let code;
  if(name==='desktop_click'){if(target===undefined)throw Error('Provide an element or point');code=`await roomApp.click(${JSON.stringify(target)});`;}
  else if(name==='desktop_type'){if(typeof args.text!=='string'||args.text.length>20000)throw Error('Invalid text');code=(args.element!==undefined?`await roomApp.click(${args.element});`:'')+`await roomApp.typeText(${JSON.stringify(args.text)});`;}
  else if(name==='desktop_set_value'){if(!Number.isInteger(args.element)||typeof args.value!=='string'||args.value.length>20000)throw Error('Invalid value');code=`await roomApp.setValue(${args.element},${JSON.stringify(args.value)});`;}
  else if(name==='desktop_key'){if(typeof args.key!=='string'||!args.key||args.key.length>100)throw Error('Invalid key');code=`await roomApp.pressKey(${JSON.stringify(args.key)});`;}
  else if(name==='desktop_scroll'){if(target===undefined||!['up','down','left','right'].includes(args.direction))throw Error('Provide current scroll target and direction');code=`await roomApp.scroll(${JSON.stringify(target)},${JSON.stringify(args.direction)},${Math.min(5,Math.max(1,args.pages||1))});`;}
  else if(name==='desktop_drag'){if(!validPoint(args.from)||!validPoint(args.to))throw Error('Invalid drag points');code=`await roomApp.drag(${JSON.stringify(args.from)},${JSON.stringify(args.to)});`;}
  else throw Error('Unknown desktop action');
  const operation=this.tail.then(async()=>{this.ready();if(this.owner?.ctx!==ctx)throw Error('Desktop ownership changed');s.snapshot=null;try{const r=await this.js(ctx,code+' await roomApp.getAXState({disableDiffing:true});','执行桌面步骤并核对结果');if(r.isError){this.uncertain=true;this.paused=true;this.lastError='桌面步骤返回错误，需核对实际界面；不要自动重复操作。';}return this.observed(s,r);}catch(e){this.uncertain=true;this.paused=true;this.lastError='桌面操作结果尚不确定，请先查看界面，不要自动重试。';throw e;}});
  this.tail=operation.catch(()=>{});return operation;
 }
 observed(s,result){if(result.isError){s.snapshot=null;return result;}s.text=result.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n')||'';s.snapshot=randomBytes(12).toString('hex');result.content.push({type:'text',text:JSON.stringify({desktopSnapshot:s.snapshot,app:s.app,instruction:'根据上述实际界面决定下一步。此 token 只用于当前应用的下一次操作。'})});return result;}
 async close(){this.closed=true;await this.setPaused(true);for(const ctx of [...this.sessions.keys()])await this.dispose(ctx);}
}
