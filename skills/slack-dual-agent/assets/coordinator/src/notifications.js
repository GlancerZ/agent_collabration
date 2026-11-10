import { availableArtifacts } from './artifacts.js';
import { jobAnswer, answerText } from './answers.js';

const plain = (value, limit) => String(value || '').replace(/\s+/g, ' ').slice(0, limit)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function completionBody(job) {
  const discussion=jobAnswer(job);
  if(discussion)return `✅ <@${job.owner}>，${discussion.agreed?'讨论已形成共同结论':'本轮讨论已结束'}${job.epoch?`（第 ${job.epoch+1} 轮）`:''}。\n任务：${plain(job.prompt,180)}\n${answerText(discussion.answer,discussion)}\n${job.mode==='independent'?'双方最初的独立判断和交叉讨论保留在上方，供你对照。\n':''}可以在原讨论串继续问“为什么这样判断”“什么条件会改变结论”，或补充新情况，无须重新 @。查看、解释会直接答复；要求双方重新评估时再安排讨论。`;
  const roles = job.finalRole ? [job.finalRole] : job.mode === 'independent' ? ['codex', 'claude'] : [job.integrator];
  return `✅ <@${job.owner}>，任务已完成${job.epoch ? `（第 ${job.epoch + 1} 轮）` : ''}。\n`
    + `任务：${plain(job.prompt, 180)}\n`
    + (job.mode === 'independent' && job.finalRole ? '已比较双方独立方案，吸收优点并完成最终整合与复查；初稿和修订候选版保留供对照。\n' : '')
    + roles.map(role => `${role === 'codex' ? 'Codex' : 'Claude'}：${plain(job.results?.[role]?.summary, 350)}`).join('\n')
    + presentationLinks(job)
    + '\n成果位置、评审和验证记录见本讨论串。\n'
    + '在原任务讨论串直接说“展示结果”“解释一下”或具体修改要求即可，无须重新 @ 或重发任务。协调者会先判断：查看或提问直接答复，需要修改才继续执行与复查，完成后再次通知你。\n'
    + '例如：“把背景改成蓝色，并增加动画。”\n'
    + '全新任务请在频道新发：@Codex independent 任务，或 @Codex collaborate 任务。';
}


export function presentationLinks(job) {
  if (!job.sourceVersions) return '';
  const port = job.deliveryPort || 7417, files = availableArtifacts(job, port);
  const main = list => list.find(f => ['.html', '.htm'].includes(f.extension)) || list[0];
  const entries = [['最终整合版', main(files.filter(f => f.kind === 'final'))], ...['codex', 'claude'].map(role => [role === 'codex' ? 'Codex 独立完成版' : 'Claude 独立完成版', main(files.filter(f => f.kind === 'original' && f.role === role))])];
  return '\n' + entries.filter(([, file]) => file).map(([label, file]) => `• <${file.url}|${label}> · <${file.downloadUrl}|下载>`).join('\n')
    + `\n<http://127.0.0.1:${port}/presentation/${job.id}|打开三份成果与比较说明>（请在本机打开）`;
}
