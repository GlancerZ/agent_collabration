import { createServer } from 'node:http';
import {readFileSync,realpathSync,statSync,mkdirSync} from 'node:fs';
import {resolve,relative,extname,dirname} from 'node:path';
import {safePath} from './capability-hub.js';
import {capabilities} from './capability-config.js';
import {DATA} from './config.js';
import {createHash} from 'node:crypto';

const text=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
export function safeBrowserUrl(value,managementPort) {
  const url=new URL(value);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('Use an http(s) URL without embedded credentials');
  if(['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&Number(url.port||80)===managementPort)throw Error('Worker browsers cannot operate the coordinator or approval page');
  return url.href;
}
export function browserActionNeedsHuman(info,url,managementPort,{fill=false}={}) {
  const local=['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname);
  if(fill&&(/password|one-time|credit-card|cc-number|cc-csc/i.test(info.type+' '+info.autocomplete)||/password|密码|口令|otp|验证码|cvv|token|secret|信用卡/i.test(info.label||'')))return '敏感输入需要你在浏览器中亲自填写。';
  if(!fill&&/授权|authorize|grant access|pay\b|purchase|place order|付款|支付|买入|卖出|永久删除|delete permanently|签署|sign contract|accept terms|同意.*条款/i.test(info.label||''))return '此控件涉及授权、协议、交易或不可逆操作，需要你在浏览器中亲自完成。';
  if(!fill&&!local&&(info.submit||/^(send|publish|submit|delete|发送|发布|提交|删除)\b/i.test(info.label||'')))return '外部网站的提交或修改需要你确认并亲自完成。';
  return '';
}
export class WorkerBrowsers {
  constructor(config) {this.config=config;this.sessions=new Map();this.previews=new Map();this.starting=new Map();}
  state() {return [...this.sessions.values()].filter(s=>!s.page.isClosed()).map(s=>({id:s.id,role:s.role,jobId:s.jobId,url:this.publicUrl(s.page.url())}));}
  async focus(id) {const s=[...this.sessions.values()].find(s=>s.id===id&&!s.page.isClosed());if(!s)throw Error('Browser window is no longer available');await s.page.bringToFront();return {ok:true};}
  publicUrl(value) {try{const u=new URL(value);for(const k of [...u.searchParams.keys()])if(/token|code|state|secret|key|auth/i.test(k))u.searchParams.set(k,'[REDACTED]');return u.href;}catch{return value;}}
  async session(ctx) {
    let s=this.sessions.get(ctx.root);if(s&&!s.page.isClosed()){s.used=Date.now();return s;}
    if(this.starting.has(ctx.root))return this.starting.get(ctx.root);
    const pending=this.startSession(ctx).finally(()=>this.starting.delete(ctx.root));this.starting.set(ctx.root,pending);return pending;
  }
  async startSession(ctx) {
    process.env.PLAYWRIGHT_BROWSERS_PATH=resolve(DATA,'browser-runtime');
    const {chromium}=await import('playwright');
    const browser=await chromium.launch({headless:capabilities(this.config).browser.headless});
    if(ctx.controller.signal.aborted){await browser.close();throw Error('Worker browser request cancelled');}
    const context=await browser.newContext({viewport:{width:1280,height:800},acceptDownloads:false});
    await context.route('**/*',route=>{try{safeBrowserUrl(route.request().url(),this.config.port);return route.continue();}catch{return route.abort('blockedbyclient');}});
    const page=await context.newPage(),s={id:createHash('sha256').update(ctx.root).digest('hex').slice(0,16),jobId:ctx.jobId,browser,context,page,refs:new Map(),logs:[],role:ctx.role,used:Date.now()};
    page.on('console',m=>{if(m.type()==='error'||m.type()==='warning')s.logs.push({type:m.type(),text:m.text().slice(0,2000)});s.logs=s.logs.slice(-80);});
    page.on('pageerror',e=>{s.logs.push({type:'pageerror',text:e.message.slice(0,2000)});s.logs=s.logs.slice(-80);});
    this.sessions.set(ctx.root,s);
    if(this.sessions.size>6){const [key,old]=[...this.sessions.entries()].filter(([k])=>k!==ctx.root).sort((a,b)=>a[1].used-b[1].used)[0];await old.browser.close();this.sessions.delete(key);}
    return s;
  }
  async snapshot(s) {
    for(const h of s.refs.values())await h.dispose().catch(()=>{});s.refs.clear();
    const elements=[];
    for(const h of (await s.page.$$('a,button,input,textarea,select,[role="button"],[role="link"]')).slice(0,100)) {
      if(!await h.isVisible()){await h.dispose();continue;}
      const d=await h.evaluate(el=>({tag:el.tagName.toLowerCase(),type:el.getAttribute('type')||'',label:(el.getAttribute('aria-label')||el.textContent||el.getAttribute('placeholder')||el.getAttribute('name')||'').trim().slice(0,200),disabled:!!el.disabled}));
      const ref='e'+(elements.length+1);s.refs.set(ref,h);elements.push({ref,...d});
    }
    return {url:this.publicUrl(s.page.url()),title:await s.page.title(),text:(await s.page.locator('body').innerText().catch(()=>'' )).slice(0,14000),elements};
  }
  async preview(root) {
    const real=realpathSync(root);if(this.previews.has(real))return this.previews.get(real).url;
    const server=createServer((req,res)=>{try{
      const u=new URL(req.url,'http://127.0.0.1'),path=safePath(real,decodeURIComponent(u.pathname).replace(/^\//,'')||'index.html',{mustExist:true});
      if(!statSync(path).isFile())throw Error('Not a file');
      const mime={'.html':'text/html','.htm':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.woff2':'font/woff2','.txt':'text/plain'}[extname(path).toLowerCase()]||'application/octet-stream';
      res.writeHead(200,{'content-type':mime,'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(readFileSync(path));
    }catch{res.writeHead(404);res.end('Not available');}});
    await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok);});
    const url=`http://127.0.0.1:${server.address().port}`;this.previews.set(real,{server,url});return url;
  }
  async call(ctx,name,args) {
    const s=await this.session(ctx),p=s.page;
    if(name==='browser_navigate'){await p.goto(safeBrowserUrl(args.url,this.config.port),{waitUntil:'domcontentloaded',timeout:30000});return text(await this.snapshot(s));}
    if(name==='browser_open_file') {
      const roots=[ctx.root,...ctx.peerDirs||[]];let file,root;
      for(const candidate of roots)try{file=safePath(candidate,args.path,{mustExist:true});root=candidate;break;}catch{}
      if(!root||!['.html','.htm'].includes(extname(file).toLowerCase()))throw Error('Use an actual HTML file within an approved worker workspace');
      const base=await this.preview(root),url=base+'/'+relative(realpathSync(root),realpathSync(file)).split('/').map(encodeURIComponent).join('/');
      await p.goto(url,{waitUntil:'domcontentloaded',timeout:30000});return text(await this.snapshot(s));
    }
    if(name==='browser_snapshot')return text(await this.snapshot(s));
    if(name==='browser_console')return text(s.logs);
    if(name==='browser_wait'){await p.getByText(String(args.text),{exact:false}).first().waitFor({state:'visible',timeout:Math.min(30,Math.max(1,args.timeoutSec||10))*1000});return text(await this.snapshot(s));}
    if(name==='browser_screenshot') {
      let path;
      if(args.filename){if(ctx.readOnly)throw Error('Review can inspect screenshots but cannot save task files');if(!/\.png$/i.test(args.filename))throw Error('Screenshots use .png');path=safePath(ctx.root,args.filename);mkdirSync(dirname(path),{recursive:true});}
      const bytes=await p.screenshot({type:'png',fullPage:false,...path?{path}:{}});
      return {content:[{type:'image',mimeType:'image/png',data:bytes.toString('base64')},{type:'text',text:JSON.stringify({url:this.publicUrl(p.url()),savedFile:path||null})}]};
    }
    const h=s.refs.get(args.ref);if(!h)throw Error('Unknown or stale element reference; call browser_snapshot');
    const info=await h.evaluate(el=>({type:el.getAttribute('type')||'',autocomplete:el.getAttribute('autocomplete')||'',label:(el.getAttribute('aria-label')||el.textContent||el.getAttribute('placeholder')||el.getAttribute('name')||'').trim().slice(0,300),submit:!!el.form&&((el.tagName==='BUTTON'&&(el.getAttribute('type')||'submit')==='submit')||(el.tagName==='INPUT'&&el.type==='submit'))}));
    const handoff=browserActionNeedsHuman(info,p.url(),this.config.port,{fill:name==='browser_fill'});
    if(handoff)return text({ok:false,needsHuman:true,instruction:handoff+' 当前浏览器窗口会保留；在本机面板点击“显示窗口”，完成后在原任务讨论串发送 resume。',recoveryUrl:`http://127.0.0.1:${this.config.port}/#access`,url:this.publicUrl(p.url())});
    if(name==='browser_fill'){if(typeof args.text!=='string'||args.text.length>20000)throw Error('Invalid field text');await h.fill(args.text,{timeout:10000});}
    else if(name==='browser_click')await h.click({timeout:10000});else throw Error('Unknown browser tool');
    await p.waitForLoadState('domcontentloaded').catch(()=>{});return text(await this.snapshot(s));
  }
  async close(){await Promise.allSettled([...this.sessions.values()].map(s=>s.browser.close()));await Promise.allSettled([...this.previews.values()].map(s=>new Promise(r=>s.server.close(r))));this.sessions.clear();this.previews.clear();}
}
