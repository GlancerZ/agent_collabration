export function initAccess({post,action,getState}) {
  const make=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
  const tab=make('button','服务器、浏览器与桌面');tab.dataset.tab='access';document.querySelector('nav').append(tab);
  const section=make('section');section.id='access';section.hidden=true;
  const intro=make('article');intro.append(make('h2','任务执行能力'),make('p','两个 agent 可以在各自项目中安装依赖、连接已启用的服务器。需要交互登录时，在这里完成后回原任务讨论串发送 resume。'));
  const summary=make('p');intro.append(summary);
  const hosts=make('div');intro.append(make('h2','服务器连接'),hosts);
  const terminal=make('article');terminal.append(make('h2','交互登录'));
  const sessionSelect=make('select');sessionSelect.setAttribute('aria-label','登录会话');
  const output=make('pre');output.className='login-output';output.setAttribute('aria-live','polite');
  const form=make('form'),input=make('input');input.type='password';input.autocomplete='off';input.maxLength=4096;input.placeholder='在终端提示后输入，内容不会保存';input.setAttribute('aria-label','登录终端输入');
  const send=make('button','发送到登录终端');send.type='submit';const cancel=make('button','停止此登录');cancel.type='button';
  form.append(input,send,cancel);terminal.append(make('p','只有你在此页面主动发起登录，才会创建交互连接。输入直接送到 SSH 终端，不进入任务、消息或持久日志。遇到 Duo 菜单时按实际提示选择；手机批准后等待这里显示登录成功。'),sessionSelect,output,form);
  const browser=make('article'),browserIntro=make('p');browser.append(make('h2','浏览器'),browserIntro);
  const browserState=make('div');browser.append(browserState);
  const desktop=make('article'),desktopSummary=make('p'),desktopState=make('p'),desktopError=make('p'),desktopActions=make('div');desktopActions.className='actions';
  const desktopApprovals=make('div');desktop.append(make('h2','Mac 桌面控制'),desktopSummary,desktopState,desktopError,desktopActions,desktopApprovals);let renderedApprovals='';
  const pauseDesktop=make('button','暂停桌面操作'),resumeDesktop=make('button','继续桌面操作');pauseDesktop.onclick=()=>action(()=>post('/api/access/desktop-control',{action:'pause'}));resumeDesktop.onclick=()=>action(()=>post('/api/access/desktop-control',{action:'resume'}));desktopActions.append(pauseDesktop,resumeDesktop);
  section.append(intro,terminal,browser,desktop);document.querySelector('main').append(section);
  let data;
  function showSession(){const s=data?.ssh.sessions.find(s=>s.id===sessionSelect.value);output.textContent=s?`${s.host} · ${s.status}\n${s.output}`:'尚未发起交互登录。';send.disabled=cancel.disabled=!s||s.status!=='running';}
  sessionSelect.onchange=showSession;
  form.onsubmit=e=>{e.preventDefault();const text=input.value;input.value='';action(()=>post('/api/access/input',{id:sessionSelect.value,text}));};
  cancel.onclick=()=>action(()=>post('/api/access/cancel',{id:sessionSelect.value}));
  async function refresh(){
    const config=getState()?.config?.capabilities;if(!config)return;
    summary.textContent=`项目依赖：${config.dependencyCommands?'已启用':'未启用'} · 终端联网：${config.shellNetwork?'已启用':'未启用'} · 浏览器：${config.browser?.enabled?'已启用':'待配置'} · Mac 桌面：${config.desktop?.enabled?'已启用':'待配置'}`;
    browserIntro.textContent=config.browser?.enabled?'任务需要浏览器时，两位 agent 各自打开独立窗口。遇到登录、验证码或需要你确认的提交时，在相应窗口亲自完成，然后回原讨论串继续。':'浏览器尚未启用，正在等待确认使用独立浏览器还是现有 Chrome 登录状态。';
    const r=await fetch('/api/access');if(!r.ok)return;data=await r.json();
    const ds=data.desktop;desktopSummary.textContent=config.desktop?.enabled?'两位通过官方 Codex Computer Use 操作 Mac 应用，保留各自的模型和会话。桌面按顺序使用；官方应用授权请求会显示在下方，由你确认。':'正在配置官方 Codex Computer Use 共享入口。';
    desktopState.textContent=ds?.paused?'桌面操作已暂停'+(ds.uncertain?'；请先查看实际界面，避免重复执行。':'。'):ds?.owner?`当前使用：${ds.owner.role==='codex'?'Codex':'Claude'} · ${ds.owner.app}；排队 ${ds.queued.length} 个。`:'桌面空闲，需要时自动申请使用。';desktopError.textContent=ds?.lastError||'';pauseDesktop.disabled=!config.desktop?.enabled||ds?.paused;resumeDesktop.disabled=!config.desktop?.enabled||!ds?.paused;
    const approvalKey=(ds?.approvals||[]).map(a=>a.id).join(',');if(approvalKey!==renderedApprovals){renderedApprovals=approvalKey;desktopApprovals.replaceChildren(...(ds?.approvals||[]).map(a=>{const card=make('article');card.append(make('h3',`${a.role==='codex'?'Codex':'Claude'} 的原生应用授权`),make('p',a.message));const inputs={};for(const [key,p]of Object.entries(a.schema.properties||{})){const label=make('label',p.title||p.description||key);let input;if(p.enum){input=make('select');for(const value of p.enum){const option=make('option',String(value));option.value=String(value);input.append(option);}}else{input=make('input');input.type=p.type==='boolean'?'checkbox':p.type==='string'?'text':'number';}input.setAttribute('aria-label',p.title||key);inputs[key]={input,type:p.type};label.append(input);card.append(label);}const buttons=make('div');buttons.className='actions';for(const [name,response]of [['允许此请求','accept'],['拒绝','decline']]){const b=make('button',name);b.onclick=()=>action(async()=>{const content=Object.fromEntries(Object.entries(inputs).map(([k,{input,type}])=>[k,type==='boolean'?input.checked:type==='number'||type==='integer'?Number(input.value):input.value]));await post('/api/access/desktop-approval',{id:a.id,action:response,content});await refresh();});buttons.append(b);}card.append(buttons);return card;}));}
    hosts.replaceChildren(...data.ssh.hosts.map(host=>{const row=make('div');row.className='actions';const check=data.ssh.checks.find(c=>c.host===host),error=check?.error?.trim().split('\n').filter(Boolean).at(-1),status=make('span',check?(check.ok?'已连接':error||'尚未连接'):'未检查');status.className='connection-status';row.append(make('strong',host),status);
      const test=make('button','检查连接');test.onclick=()=>action(async()=>{await post('/api/access/check',{host});await refresh();});
      const login=make('button','登录 / MFA');login.onclick=()=>action(async()=>{const s=await post('/api/access/login',{host});await refresh();sessionSelect.value=s.id;showSession();});row.append(test,login);return row;}));
    const prior=sessionSelect.value;sessionSelect.replaceChildren(...data.ssh.sessions.map(s=>{const o=make('option',`${s.host} · ${s.status}`);o.value=s.id;return o;}));if(data.ssh.sessions.some(s=>s.id===prior))sessionSelect.value=prior;showSession();
    browserState.replaceChildren(...(data.browser.length?data.browser.map(s=>{const row=make('div');row.className='actions';const label=make('span',`${s.role==='codex'?'Codex':'Claude'} · ${s.url||'等待打开页面'}`);label.className='connection-status';const focus=make('button','显示窗口');focus.onclick=()=>action(()=>post('/api/access/browser-focus',{id:s.id}));row.append(label,focus);return row;}):[make('p','尚无任务浏览器窗口；需要时会自动打开。')]));
  }
  return {refresh};
}
