import { renderDeliverables } from './deliverables.js';
import { initAccess } from './access.js';
const $ = id => document.getElementById(id);
let state, selected = new URLSearchParams(location.search).get('job'), configLoaded = false, renderedDelivery = '';
const names = {codex:'Codex',claude:'Claude',system:'系统',user:'你'};
const statuses={queued:'排队中',running:'执行中',paused:'已暂停',completed:'已交付',awaiting_user:'待处理分歧',failed:'执行失败',cancelled:'已取消'};
function notice(s){$('notice').textContent=s;}
async function post(path,body={}){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Agent-Room-CSRF':state.csrf},body:JSON.stringify(body)});const result=await r.json();if(!r.ok)throw Error(result.error);return result;}
async function action(fn){try{await fn();await refresh();}catch(e){notice(e.message);}}
function node(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
const access=initAccess({post,action,getState:()=>state});
async function refresh(){state=await(await fetch('/api/state')).json();$('connection').textContent='Slack · '+state.slack;const projects=Object.keys(state.config.projects);const old=$('project').value;$('project').replaceChildren(...projects.map(x=>{const o=node('option',x);o.value=x;return o;}));if(projects.includes(old))$('project').value=old;
 $('jobs').replaceChildren(...state.jobs.map(j=>{const b=node('button',j.prompt.slice(0,75),'job'+(selected===j.id?' selected':''));b.append(node('small',`${statuses[j.status]||j.status} · ${j.mode} · ${j.project}`));b.onclick=()=>{selected=j.id;refresh();};return b;}));
 if(!configLoaded){fillConfig();configLoaded=true;}
 if(!$('access').hidden)await access.refresh();
 if(selected){const d=await(await fetch('/api/jobs/'+selected)).json();$('job-title').replaceChildren(node('h2',d.job.prompt),node('p',`${d.answer?(d.answer.agreed?'双方已形成共同结论':'讨论仍有分歧'):statuses[d.job.status]} · ${d.job.mode} · ${d.job.project}`,'muted'));const view=node('a',d.answer?'查看讨论结论':'打开成果对照展示');view.href='/presentation/'+selected;view.target='_blank';view.rel='noopener';$('job-title').append(view);const deliveryKey=selected+':'+d.job.updated;if(renderedDelivery!==deliveryKey){renderDeliverables($('deliverables'),d.job,d.artifacts||[],d.answer);renderedDelivery=deliveryKey;}$('controls').hidden=false;$('messages').replaceChildren(...d.messages.map(m=>{const box=node('div',undefined,'message '+m.role);box.append(node('div',`${names[m.role]||m.role} · ${m.stage} · ${new Date(m.at).toLocaleTimeString()}`,'meta'),node('div',m.body,'body'));return box;}));}
}
function fillConfig(){const c=state.config;$('slack-enabled').checked=c.slack.enabled;$('channels').value=c.slack.channelIds.join(', ');$('users').value=c.slack.userIds.join(', ');$('rounds').value=c.rounds;$('timeout').value=c.turnTimeoutSec;$('integrator').value=c.integrator;$('codex-bin').value=c.agents.codex.bin;$('claude-bin').value=c.agents.claude.bin;$('projects').value=JSON.stringify(c.projects,null,2);for(const [id,key]of[['app-token','appToken'],['codex-token','codexToken'],['claude-token','claudeToken']])$(id).placeholder=c.slack[key]?'已配置，留空保留':'尚未配置';}
function selectTab(id){for(const section of document.querySelectorAll('main > section[id]'))section.hidden=section.id!==id;document.querySelectorAll('[data-tab]').forEach(x=>x.classList.toggle('active',x.dataset.tab===id));if(id==='access'&&state)access.refresh().catch(e=>notice(e.message));}
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{selectTab(b.dataset.tab);location.hash=b.dataset.tab;});
if(location.hash==='#access')selectTab('access');
window.addEventListener('hashchange',()=>{if(['tasks','setup','access'].includes(location.hash.slice(1)))selectTab(location.hash.slice(1));});
$('task-form').onsubmit=e=>{e.preventDefault();action(async()=>{const j=await post('/api/jobs',{mode:$('mode').value,project:$('project').value,prompt:$('prompt').value});selected=j.id;notice('任务已创建。');});};
$('note-form').onsubmit=e=>{e.preventDefault();action(async()=>{await post('/api/followup',{id:selected,text:$('note').value});$('note').value='';notice('协调者已处理这条消息。');});};
document.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>action(()=>post('/api/control',{id:selected,action:b.dataset.action})));
$('config-form').onsubmit=e=>{e.preventDefault();action(async()=>{const c=structuredClone(state.config);c.slack.enabled=$('slack-enabled').checked;c.slack.appToken=$('app-token').value;c.slack.codexToken=$('codex-token').value;c.slack.claudeToken=$('claude-token').value;c.slack.channelIds=$('channels').value.split(/[,\s]+/).filter(Boolean);c.slack.userIds=$('users').value.split(/[,\s]+/).filter(Boolean);c.rounds=Number($('rounds').value);c.turnTimeoutSec=Number($('timeout').value);c.integrator=$('integrator').value;c.agents.codex.bin=$('codex-bin').value;c.agents.claude.bin=$('claude-bin').value;c.projects=JSON.parse($('projects').value);await post('/api/config',c);for(const id of ['app-token','codex-token','claude-token'])$(id).value='';configLoaded=false;notice('已保存在本机。');});};
$('connect').onclick=()=>action(()=>post('/api/slack/connect'));
$('disconnect').onclick=()=>action(()=>post('/api/slack/disconnect'));
async function doctor(){$('doctor').textContent=JSON.stringify(await(await fetch('/api/doctor')).json(),null,2);}
$('refresh-doctor').onclick=()=>action(doctor);
function manifest(role){return{display_information:{name:role==='codex'?'Codex':'Claude',description:'Local dual-agent workspace'},features:{bot_user:{display_name:role==='codex'?'Codex':'Claude',always_online:false}},oauth_config:{scopes:{bot:role==='codex'?['app_mentions:read','chat:write','channels:history','channels:read']:['chat:write','channels:read']}},settings:role==='codex'?{event_subscriptions:{bot_events:['app_mention','message.channels']},socket_mode_enabled:true,org_deploy_enabled:false,token_rotation_enabled:false}:{org_deploy_enabled:false,token_rotation_enabled:false}};}
for(const role of ['codex','claude'])$(role+'-manifest').onclick=()=>action(async()=>{await navigator.clipboard.writeText(JSON.stringify(manifest(role),null,2));notice(role+' manifest 已复制。');});
refresh().then(doctor).catch(e=>notice(e.message));setInterval(()=>refresh().catch(()=>{}),3000);
