import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,statSync,mkdirSync,symlinkSync,cpSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {materialize} from '../skills/slack-dual-agent/scripts/materialize.mjs';
import {skillRoot,checkPackage,verifyBundle} from '../skills/slack-dual-agent/scripts/check-package.mjs';

function temp(t){const dir=mkdtempSync(resolve(tmpdir(),'dual-agent-package-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}

test('fresh materialization preserves every published file and starts without external access',t=>{
  const dir=temp(t),destination=resolve(dir,'room with spaces');
  const result=materialize(destination,{codexBin:'/example/codex',claudeBin:'/example/claude',port:17417});
  const manifest=verifyBundle();
  for(const file of manifest.files){const bytes=readFileSync(resolve(destination,file.path));assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256);}
  const c=JSON.parse(readFileSync(resolve(destination,'.local/config.json'),'utf8'));
  assert.equal(result.filesCopied,manifest.files.length);assert.equal(c.port,17417);
  assert.equal(c.agents.codex.bin,'/example/codex');assert.equal(c.agents.claude.bin,'/example/claude');
  assert.equal(c.slack.enabled,false);assert.equal(c.slack.appToken,'');assert.equal(c.slack.codexToken,'');assert.equal(c.slack.claudeToken,'');
  assert.deepEqual(c.slack.channelIds,[]);assert.deepEqual(c.slack.userIds,[]);
  assert.equal(c.capabilities.shellNetwork,false);assert.equal(c.capabilities.dependencyCommands,false);
  assert.equal(c.capabilities.ssh.enabled,false);assert.equal(c.capabilities.browser.enabled,false);assert.equal(c.capabilities.desktop.enabled,false);
  assert.equal(statSync(resolve(destination,'.local')).mode&0o777,0o700);
  assert.equal(statSync(resolve(destination,'.local/config.json')).mode&0o777,0o600);
  assert.deepEqual(c.projects,{scratch:{path:'',ref:'HEAD',verify:[]}});
});

test('existing instance and symlink targets are rejected without changing their contents',t=>{
  const dir=temp(t),existing=resolve(dir,'existing');mkdirSync(existing);writeFileSync(resolve(existing,'marker'),'KEEP');
  assert.throws(()=>materialize(existing),/overwrite/);assert.equal(readFileSync(resolve(existing,'marker'),'utf8'),'KEEP');
  const link=resolve(dir,'link');symlinkSync(existing,link);assert.throws(()=>materialize(link),/symlink/);
  assert.throws(()=>materialize('relative-directory'),/absolute/);
});

test('package verification refuses tampered, extra, private or linked bundle files',t=>{
  assert.equal(checkPackage().ok,true);
  const dir=temp(t),copy=resolve(dir,'skill');cpSync(skillRoot,copy,{recursive:true});
  const file=resolve(copy,'assets/coordinator/src/main.js'),original=readFileSync(file);
  writeFileSync(file,'// tampered\n');assert.throws(()=>verifyBundle(copy),/integrity mismatch/);writeFileSync(file,original);
  const extra=resolve(copy,'assets/coordinator/extra.txt');writeFileSync(extra,'unlisted');assert.throws(()=>verifyBundle(copy),/unlisted/);rmSync(extra);
  const hidden=resolve(copy,'.local');mkdirSync(hidden);writeFileSync(resolve(hidden,'config.json'),'{}');assert.throws(()=>checkPackage(copy),/private/);rmSync(hidden,{recursive:true});
  symlinkSync(file,resolve(copy,'linked-source'));assert.throws(()=>checkPackage(copy),/symlink/);
});
