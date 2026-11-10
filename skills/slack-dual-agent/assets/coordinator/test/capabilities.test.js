import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {defaults,validateConfig} from '../src/config.js';
import {command} from '../src/runtime.js';
import {CapabilityHub,safePath} from '../src/capability-hub.js';
import {SshAccess,shellQuote,allowedHost} from '../src/ssh-access.js';
import {buildServer} from '../src/server.js';
import {safeBrowserUrl,browserActionNeedsHuman} from '../src/worker-browser.js';
const enabled=()=>({...structuredClone(defaults),capabilities:{shellNetwork:true,dependencyCommands:true,ssh:{enabled:true,hosts:['example-server']},browser:{enabled:false,mode:'playwright',headless:true},pythonBin:''}});

test('capability registration confines tools to one worker stage and expires the gateway',async t=>{
  const root=mkdtempSync(resolve(tmpdir(),'room-capability-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const c=enabled(),hub=new CapabilityHub(c),session=hub.register({cwd:root,role:'claude',readOnly:true});
  const token=session.gateway.split('/').at(-1);
  assert.deepEqual(hub.tools(hub.lookup(token)).map(t=>t.name),['ssh_status','ssh_read_file']);
  await assert.rejects(hub.handle(token,'project_install',{manager:'npm',packages:['is-number']}),/not available/);
  await assert.rejects(hub.handle(token,'ssh_exec',{host:'example-server',command:'hostname'}),/not available/);
  session.release();assert.throws(()=>hub.lookup(token),/expired/);await hub.close();
});
test('project paths reject traversal, credential directories and symlink escapes',t=>{
  const dir=mkdtempSync(resolve(tmpdir(),'room-cap-path-')),root=resolve(dir,'root');mkdirSync(root);writeFileSync(resolve(dir,'secret'),'private');symlinkSync(dir,resolve(root,'escape'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  assert.equal(safePath(root,'node_modules/package.json'),resolve(realpathSync(root),'node_modules/package.json'));
  for(const path of ['../secret','escape/secret','.ssh/id_ed25519','.env','.env.local'])assert.throws(()=>safePath(root,path));
});

test('worker browser destinations exclude coordinator and local credential files',()=>{
  assert.equal(safeBrowserUrl('https://example.com/',7417),'https://example.com/');
  for(const u of ['file:///Users/test/.ssh/key','http://127.0.0.1:7417/api/state','http://localhost:7417/#access','https://user:password@example.com/'])assert.throws(()=>safeBrowserUrl(u,7417));
});
test('browser routine controls remain usable while credentials, external submissions and transactions hand off',()=>{
  assert.equal(browserActionNeedsHuman({label:'Increment',type:'button'},'http://127.0.0.1:9999/',7417),'');
  assert.equal(browserActionNeedsHuman({label:'Next page',type:'button'},'https://example.com/',7417),'');
  assert.ok(browserActionNeedsHuman({type:'password',label:'Password'},'https://example.com/',7417,{fill:true}));
  assert.ok(browserActionNeedsHuman({submit:true,label:'Submit'},'https://example.com/',7417));
  assert.ok(browserActionNeedsHuman({label:'Pay'},'https://example.com/',7417));
});
test('package and SSH arguments reject command injection before execution',async t=>{
  const root=mkdtempSync(resolve(tmpdir(),'room-cap-input-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const c=enabled(),hub=new CapabilityHub(c),s=hub.register({cwd:root,role:'codex',readOnly:false}),token=s.gateway.split('/').at(-1);
  for(const packages of [['--global'],['x; touch /tmp/escape'],['https://example.com/script']])await assert.rejects(hub.handle(token,'project_install',{manager:'npm',packages}),/registry/);
  assert.throws(()=>allowedHost(c,'someone@another-server'),/not enabled/);
  assert.throws(()=>validateConfig({...c,capabilities:{...c.capabilities,ssh:{enabled:true,hosts:['-oProxyCommand=evil']}}}));
  assert.equal(shellQuote("one'two"),"'one'\\''two'");s.release();await hub.close();
});
test('native CLI grants stay scoped to execution and the named local tool server',()=>{
  const c=enabled(),capabilitySession={gateway:'http://127.0.0.1:7417/internal/capabilities/'+'a'.repeat(64),tools:['project_install','ssh_status']};
  const run=command('codex',c,{readOnly:false,schemaFile:'/tmp/schema',capabilitySession});
  assert.ok(run.args.includes('sandbox_workspace_write.network_access=true'));assert.ok(run.args.some(a=>a.startsWith('mcp_servers.agent_room=')));
  for(const opts of [{readOnly:true},{readOnly:false,isolated:true}]){const x=command('codex',c,{...opts,schemaFile:'/tmp/schema'});assert.ok(!x.args.includes('sandbox_workspace_write.network_access=true'));}
  const a=command('claude',c,{readOnly:false,capabilitySession});
  const allowed=a.args[a.args.indexOf('--allowedTools')+1];assert.ok(allowed.includes('Bash(npm *)'));assert.ok(!allowed.split(',').includes('Bash'));
  assert.ok(allowed.includes('mcp__agent_room__project_install'));
  const mcp=JSON.parse(a.args[a.args.indexOf('--mcp-config')+1]);assert.deepEqual(Object.keys(mcp.mcpServers),['agent_room']);assert.ok(a.args.includes('--strict-mcp-config'));
  const review=command('claude',c,{readOnly:true,capabilitySession:{...capabilitySession,tools:['ssh_status']}});assert.ok(!review.args[review.args.indexOf('--allowedTools')+1].includes('Bash('));
});
test('MFA input is sent only to the live PTY and omitted from public session state',()=>{
  const access=new SshAccess(enabled());let received='';access.sessions.set('test',{id:'test',host:'example-server',status:'running',output:'Password:',process:{stdin:{write:s=>{received=s;}}}});
  access.input('test','private-test-password');assert.equal(received,'private-test-password\n');assert.ok(!JSON.stringify(access.publicState()).includes('private-test-password'));
});
test('capability HTTP gateway requires a current unguessable context and access controls retain CSRF',async t=>{
  const root=mkdtempSync(resolve(tmpdir(),'room-cap-http-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const c=enabled(),hub=new CapabilityHub(c),server=buildServer({config:c,capabilities:hub,store:{list:()=>[]},engine:{},bridge:{state:'disconnected'},doctor:async()=>({})});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));c.port=server.address().port;
  t.after(async()=>{await new Promise(r=>server.close(r));await hub.close();});
  const s=hub.register({cwd:root,role:'codex',readOnly:true});const tools=await(await fetch(s.gateway)).json();assert.deepEqual(tools.tools.map(t=>t.name),['ssh_status','ssh_read_file']);
  assert.equal((await fetch(`http://127.0.0.1:${c.port}/api/access/login`,{method:'POST',headers:{'content-type':'application/json'},body:'{"host":"example-server"}'})).status,403);
  s.release();assert.notEqual((await fetch(s.gateway)).status,200);
});
