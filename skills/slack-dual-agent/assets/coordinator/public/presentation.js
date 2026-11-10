import { renderDeliverables } from './deliverables.js';
const id = location.pathname.split('/').pop();
try {
  const response = await fetch('/api/jobs/' + id), data = await response.json();
  if (!response.ok || !data.job) throw Error('没有找到这个任务');
  const title = data.job.prompt.split('\n')[0].slice(0, 140);
  document.title = title + (data.answer?' · 讨论结论':' · 成果对照');
  document.getElementById('presentation-title').textContent = title;
  document.getElementById('presentation-status').textContent = data.answer?(data.answer.agreed?'双方已形成共同结论':'双方仍有分歧'):(data.job.mode === 'independent' ? '独立完成 → 比较取长 → 最终整合' : '协作完成 → 最终整合') + (data.job.status === 'completed' ? ' · 已完成' : ' · 当前成果，任务尚未标记完成');
  renderDeliverables(document.getElementById('deliverables'), data.job, data.artifacts,data.answer);
  document.getElementById('back-to-task').href = '/?job=' + id;
} catch (e) { document.getElementById('presentation-title').textContent = e.message; }
