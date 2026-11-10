import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { Coordinator } from '../src/coordinator.js';
import { defaults } from '../src/config.js';
import { command } from '../src/runtime.js';
import { CONSENT_SCHEMA,proposalId,jobAnswer } from '../src/answers.js';
import { classifyGoal,obviousGoal } from '../src/task-goal.js';

const answer={conclusion:'把开始和暂停放在首屏；重置作为次要按钮。',reasons:['核心操作应方便使用。'],conditions:['仅供个人使用。'],uncertainties:[],disagreements:[]};
const report={status:'done',summary:'本轮检查完成。',evidence:['已核对用户要求及双方论据。'],issues:[],artifacts:[]};
function setup(t,override=()=>undefined){
 const data=mkdtempSync(resolve(tmpdir(),'agent-room-discussion-')),store=new Store(resolve(data,'db.sqlite')),config=structuredClone(defaults);config.rounds=2;
 const calls=[];let fixedChecks=0;
 const runtime={run:async o=>{calls.push(o);o.onSession?.(o.role+'-session');const custom=override(o);if(custom)return custom;if(o.stage.startsWith('discussion-confirm')){const id=o.prompt.match(/proposalId=([a-f0-9]{64})/)[1];return {...report,agreement:{verdict:'agree',proposalId:id,reason:'认可这份具体结论。'}};}if(o.schema?.properties.answer)return {...report,answer};return {...report,summary:o.role+' 的独立判断：'+answer.conclusion};}};
 const engine=new Engine({store,config,runtime,data,verify:async()=>{fixedChecks++;return [];},workspaceFactory:async j=>{const dirs=Object.fromEntries(['codex','claude'].map(r=>[r,resolve(data,j.id,r)]));for(const d of Object.values(dirs))mkdirSync(d,{recursive:true});return dirs;}});
 t.after(async()=>{await engine.shutdown();store.close();rmSync(data,{recursive:true,force:true});});
 return {store,config,engine,calls,data,fixedChecks:()=>fixedChecks};
}
test('discussion reaches explicit same-version agreement without creating deliverables or running project checks',async t=>{
 const x=setup(t);const j=x.engine.start({mode:'collaborate',taskType:'discussion',prompt:'讨论首屏按钮。'},{owner:'U123',channel:'C123',thread:'1.1'});await x.engine.idle();
 const done=x.store.get(j.id);assert.equal(done.status,'completed');assert.equal(done.consensus.agreed,true);assert.deepEqual(done.finalAnswer,answer);assert.equal(done.consensus.proposalId,proposalId(answer));
 assert.equal(x.fixedChecks(),0);assert.ok(x.calls.every(o=>o.readOnly));assert.ok(!x.calls.some(o=>/build|integrate|verification/.test(o.stage)));
 const notice=x.store.pending().find(d=>d.broadcast);assert.ok(notice.body.includes(answer.conclusion));assert.ok(!notice.body.includes('本轮检查完成'));assert.ok(!notice.body.includes('把背景改成蓝色'));
 const coordinator=new Coordinator({store:x.store,config:x.config,engine:{control:()=>assert.fail('read request scheduled work')}});assert.ok((await coordinator.handle(j.id,'所以最后结论是什么')).reply.includes(answer.conclusion));
 const before=x.calls.length;x.engine.control(j.id,'note','如果屏幕很窄呢，请重新评估。');x.engine.control(j.id,'resume');await x.engine.idle();assert.deepEqual(x.calls.slice(before).map(o=>o.stage),['discussion-followup','discussion-confirm-1']);
});
test('independent discussion preserves both original opinions and actually exchanges them',async t=>{
 const x=setup(t);const j=x.engine.start({mode:'independent',taskType:'discussion',prompt:'只要共同建议。'});await x.engine.idle();const done=x.store.get(j.id);
 assert.ok(done.discussionOriginals.codex.summary.includes('codex'));assert.ok(done.discussionOriginals.claude.summary.includes('claude'));
 for(const o of x.calls.filter(o=>o.stage==='discussion-initial'))assert.ok(!o.prompt.includes('的独立判断'));
 for(const o of x.calls.filter(o=>o.stage==='discussion-exchange'))assert.ok(o.prompt.includes('codex 的独立判断')&&o.prompt.includes('claude 的独立判断'));
});
test('round exhaustion never pretends disagreement is consensus',async t=>{
 const x=setup(t,o=>o.stage.startsWith('discussion-confirm')?{...report,agreement:{verdict:'disagree',proposalId:proposalId(answer),reason:'我仍然反对隐藏重置按钮。'}}:undefined);
 const j=x.engine.start({mode:'collaborate',taskType:'discussion',prompt:'讨论。'},{owner:'U123',channel:'C123',thread:'1.1'});await x.engine.idle();
 const done=x.store.get(j.id);assert.equal(done.status,'awaiting_user');assert.equal(done.consensus.agreed,false);assert.equal(x.store.pending().filter(d=>d.broadcast).length,0);assert.ok(x.store.messages(j.id).at(-1).body.includes('我仍然反对'));
 assert.equal(x.calls.filter(o=>o.stage.startsWith('discussion-confirm')).length,2);
});
test('consenting to a different proposal hash cannot complete a discussion',async t=>{
 const x=setup(t,o=>o.stage.startsWith('discussion-confirm')?{...report,agreement:{verdict:'agree',proposalId:'wrong-version',reason:'agreed'}}:undefined);
 const j=x.engine.start({mode:'collaborate',taskType:'discussion',prompt:'讨论。'});await x.engine.idle();assert.equal(x.store.get(j.id).status,'awaiting_user');
});
test('explicit peer agreement resolves an earlier awaiting-confirmation note and stops immediately',async t=>{
 const proposed={...answer,disagreements:['这是对方上一轮的新观点，等待明确确认。']};
 const x=setup(t,o=>o.schema?.properties.answer?{...report,answer:proposed}:undefined);
 const j=x.engine.start({mode:'collaborate',taskType:'discussion',prompt:'讨论。'});await x.engine.idle();const done=x.store.get(j.id);
 assert.equal(done.status,'completed');assert.deepEqual(done.finalAnswer.disagreements,[]);assert.equal(done.consensus.proposalId,proposalId(proposed));assert.ok(!x.calls.some(o=>o.stage.startsWith('discussion-resolve')));
});
test('legacy analysis returns the actual historical answer even when artifacts were Markdown links',async t=>{
 const x=setup(t),cwd=resolve(x.data,'legacy');mkdirSync(cwd);const file=resolve(cwd,'final_delivery.json');writeFileSync(file,JSON.stringify({answer_zh:{lead:'当时的条件性判断。',assumptions:'历史假设'},limitations:['未刷新行情'],research_cutoff_toronto:'2026-10-27 15:11 EDT'}));
 const j=x.store.create({mode:'collaborate',status:'completed',integrator:'codex',finalRole:'codex',workspaces:{codex:cwd},results:{codex:{...report,artifacts:[`[最终答复](${file})`]}},critics:{claude:report}});
 const a=jobAnswer(j);assert.equal(a.answer.conclusion,'当时的条件性判断。');assert.ok(a.historicalBasis.includes('未刷新'));assert.equal(a.agreed,true);
 const coordinator=new Coordinator({store:x.store,config:x.config});assert.ok(coordinator.resultReply(j).includes('当时的条件性判断。'));
 const outside=resolve(x.data,'outside.json');writeFileSync(outside,JSON.stringify({answer_zh:{lead:'must not read'}}));assert.equal(jobAnswer({...j,results:{codex:{...report,artifacts:[`[bad](${outside})`]}}}),null);
});
test('semantic task routing classifies advice separately from artifacts and runs without tools',async t=>{
 const x=setup(t);let invocation;
 const result=await classifyGoal({prompt:'帮我分析一下今天google能买吗，我的成本是加股的53，占到我总仓位的五分之一了',config:x.config,data:x.data,signal:new AbortController().signal,runtime:{run:async o=>{invocation=o;return {taskType:'discussion',reason:'analysis question'};}}});
 assert.equal(result.taskType,'discussion');assert.equal(invocation.isolated,true);assert.equal(invocation.readOnly,true);
 assert.equal(obviousGoal('帮我做一个支持照片批量raw转jpeg的代码').taskType,'deliverable');assert.equal(obviousGoal('只需要讨论出一致的结论，不需要交付文件').taskType,'discussion');
});
test('Claude uses the exact discussion consent schema supplied by the engine',()=>{
 const c=command('claude',defaults,{readOnly:true,schema:CONSENT_SCHEMA});assert.deepEqual(JSON.parse(c.args[c.args.indexOf('--json-schema')+1]),CONSENT_SCHEMA);
});
