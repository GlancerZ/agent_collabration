import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { SCHEMA, parseReport } from './runtime.js';
import { availableArtifacts } from './artifacts.js';

const strings={type:'array',items:{type:'string'}};
export const ANSWER_SCHEMA={type:'object',additionalProperties:false,properties:{conclusion:{type:'string'},reasons:strings,conditions:strings,uncertainties:strings,disagreements:strings},required:['conclusion','reasons','conditions','uncertainties','disagreements']};
export const PROPOSAL_SCHEMA={...SCHEMA,properties:{...SCHEMA.properties,answer:ANSWER_SCHEMA},required:[...SCHEMA.required,'answer']};
export const CONSENT_SCHEMA={...SCHEMA,properties:{...SCHEMA.properties,agreement:{type:'object',additionalProperties:false,properties:{verdict:{type:'string',enum:['agree','disagree']},proposalId:{type:'string'},reason:{type:'string'}},required:['verdict','proposalId','reason']}},required:[...SCHEMA.required,'agreement']};
export function parseAnswer(a) {
  if(typeof a?.conclusion!=='string'||!a.conclusion.trim()||['reasons','conditions','uncertainties','disagreements'].some(k=>!Array.isArray(a[k])||a[k].some(x=>typeof x!=='string')))throw Error('Missing substantive final answer');
  return Object.fromEntries(ANSWER_SCHEMA.required.map(k=>[k,a[k]]));
}
export function parseProposal(value){const r=parseReport(value);return {...r,answer:parseAnswer(r.answer)};}
export function parseConsent(value){const r=parseReport(value),a=r.agreement;if(!['agree','disagree'].includes(a?.verdict)||typeof a.proposalId!=='string'||typeof a.reason!=='string')throw Error('Missing explicit peer consent');return r;}
export const proposalId=answer=>createHash('sha256').update(JSON.stringify(parseAnswer(answer))).digest('hex');
export function confirmed(proposal,review){return proposal.status==='done'&&!proposal.issues.length&&proposal.evidence.some(x=>x.trim())&&review.status==='done'&&!review.issues.length&&review.evidence.some(x=>x.trim())&&review.agreement?.verdict==='agree'&&!!review.agreement.reason.trim()&&review.agreement.proposalId===proposalId(proposal.answer);}
export function settledAnswer(proposal,agreed){return {...proposal.answer,disagreements:agreed?[]:proposal.answer.disagreements};}
const safe=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
export function answerText(answer,{agreed=false,historicalBasis='',review}={}) {
  const lines=[historicalBasis&&`资料范围：${safe(historicalBasis)}`,`${agreed?'双方共同结论':'当前结论提案'}：${safe(answer.conclusion)}`];
  for(const [key,label]of [['reasons','主要理由'],['conditions','适用条件与下一步'],['uncertainties','仍不确定'],['disagreements','尚未解决的分歧']])if(answer[key]?.length)lines.push(`${label}：\n${answer[key].map(x=>'• '+safe(x)).join('\n')}`);
  if(!agreed)lines.push('尚未取得双方对同一结论的明确认可。'+(review?.agreement?.reason?'\n另一方意见：'+safe(review.agreement.reason):''));
  return lines.filter(Boolean).join('\n');
}
export function jobAnswer(job){
  if(job.finalAnswer)return {answer:parseAnswer(job.finalAnswer),agreed:job.consensus?.agreed===true,review:job.critics?.[job.consensus?.reviewer]};
  // Compatibility with the original analysis pipeline. Only explicitly reported,
  // workspace-contained artifacts are considered; no arbitrary file discovery.
  for(const f of availableArtifacts(job).filter(f=>f.kind==='final'&&f.name==='final_delivery.json'&&f.bytes<=256000))try{
    const d=JSON.parse(readFileSync(f.path,'utf8')),a=d.answer_zh;
    if(typeof a?.lead!=='string')continue;
    return {answer:parseAnswer({conclusion:a.lead,reasons:[a.main_caution,a.concentration,a.averaging_example].filter(Boolean),conditions:[a.assumptions,a.action].filter(Boolean),uncertainties:d.limitations||[],disagreements:[]}),agreed:job.status==='completed'&&Object.values(job.critics||{}).length>0&&Object.values(job.critics).every(r=>r.status==='done'&&!r.issues.length),historicalBasis:`原任务记录截至 ${d.research_cutoff_toronto||d.research_cutoff_utc||job.updated||job.created}，此处未刷新资料；最终评审曾认可该版本。`};
  }catch{}
  return null;
}
