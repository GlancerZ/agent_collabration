const node = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
const names = { codex: 'Codex', claude: 'Claude' };
export function renderDeliverables(container, job, files, discussion) {
  container.replaceChildren();
  if(discussion){
    const a=discussion.answer,card=node('section',undefined,'delivery-card final-delivery');
    container.append(node('h2','讨论结论'));
    card.append(node('h3',discussion.agreed?'双方共同结论':'当前提案 · 尚未一致'),node('p',a.conclusion,'delivery-summary'));
    if(discussion.historicalBasis)card.append(node('p',discussion.historicalBasis,'muted'));
    for(const [key,label]of [['reasons','主要理由'],['conditions','适用条件与下一步'],['uncertainties','仍不确定'],['disagreements','尚未解决的分歧']])if(a[key]?.length){card.append(node('h4',label));for(const text of a[key])card.append(node('p',text));}
    if(!discussion.agreed&&discussion.review?.agreement?.reason)card.append(node('p','另一方意见：'+discussion.review.agreement.reason));
    container.append(card);
    if(job.mode==='independent'&&job.discussionOriginals){const originals=node('div',undefined,'independent-originals');for(const role of ['codex','claude']){const original=node('section',undefined,'delivery-card');original.append(node('h3',names[role]+' 最初独立判断'),node('p',job.discussionOriginals[role].summary,'delivery-summary'));originals.append(original);}container.append(originals);}
    return;
  }
  if (!job.results && !job.sourceVersions) return;
  const results = job.results || {};
  if (job.providerAudit?.claude?.model) container.append(node('p', `历史模型核对：这次记录中的 Claude Code 实际使用 ${job.providerAudit.claude.model}（${job.providerAudit.claude.provider}），不能作为 Claude 模型的对照结果。原始成果保留供追溯。`, 'provider-audit'));
  const makeCard = (title, report, artifacts, cls = '') => {
    const card = node('section', undefined, 'delivery-card ' + cls); card.append(node('h3', title));
    if (report?.summary) card.append(node('p', report.summary, 'delivery-summary'));
    const page = artifacts.find(f => ['.html', '.htm'].includes(f.extension));
    if (page) {
      const preview = node('div', undefined, 'delivery-preview'), frame = node('iframe'); frame.src = page.url; frame.title = title; frame.loading = 'lazy'; frame.setAttribute('sandbox', 'allow-scripts'); preview.append(frame); card.append(preview);
      // The same viewport makes the two independent designs directly comparable.
      const observer = new ResizeObserver(entries => {
        if (!preview.isConnected) { observer.disconnect(); return; }
        const scale = entries[0].contentRect.width / 1000;
        frame.style.transform = `scale(${scale})`; preview.style.height = `${720 * scale}px`;
      }); observer.observe(preview);
    }
    const links = node('div', undefined, 'delivery-links');
    for (const f of artifacts.slice(0, 6)) {
      const p = node('p'), link = node('a', f.name + (f.extension === '.html' ? ' · 打开完整预览' : ' · 查看'));
      link.href = f.url; link.target = '_blank'; link.rel = 'noopener';
      const download = node('a', '下载'); download.href = f.downloadUrl; p.append(link, document.createTextNode(' · '), download); links.append(p);
    }
    card.append(links); return card;
  };
  container.append(node('h2', '成果展示'));
  if (job.mode === 'independent' && job.sourceVersions) container.append(node('p', '先看最终整合版，再对照双方各自独立完成的初稿与比较建议。', 'muted'));
  const finals = files.filter(f => f.kind === 'final');
  const finalRole = job.finalRole || job.integrator;
  if (finalRole && results[finalRole]) container.append(makeCard(job.finalRole ? '最终整合版' : '现有成果', results[finalRole], finals, 'final-delivery'));
  else if (job.sourceVersions) container.append(makeCard('最终整合版 · 正在制作', { summary: '双方独立成果已保留，正在比较取长并完成最终整合与复查。' }, [], 'final-delivery'));
  if (job.sourceVersions) {
    const originals = node('div', undefined, 'independent-originals');
    for (const role of ['codex', 'claude']) originals.append(makeCard(names[role] + ' 独立完成版' + (role === 'claude' && job.providerAudit?.claude?.model ? `（${job.providerAudit.claude.provider} 旧配置）` : ''), job.sourceVersions.original?.[role]?.report, files.filter(f => f.kind === 'original' && f.role === role)));
    container.append(originals);
    const comparison = node('section', undefined, 'delivery-card'); comparison.append(node('h3', '比较与取舍'));
    for (const role of ['codex', 'claude']) if (job.comparisons?.[role]) comparison.append(node('h4', names[role] + ' 的比较建议'), node('p', job.comparisons[role].summary, 'delivery-summary'));
    if (results[finalRole]?.summary) comparison.append(node('h4', '整合后的采用说明'), node('p', results[finalRole].summary, 'delivery-summary'));
    container.append(comparison);
    const candidates = node('details'); candidates.append(node('summary', '查看互评修订后的候选版本'));
    for (const role of ['codex', 'claude']) candidates.append(makeCard(names[role] + ' 修订候选版', job.sourceVersions.candidates?.[role]?.report, files.filter(f => f.kind === 'candidates' && f.role === role)));
    container.append(candidates);
  } else if (job.mode === 'independent' && !job.finalRole) {
    const remaining = files.filter(f => f.role !== finalRole);
    if (remaining.length) container.append(makeCard('Claude 独立完成版', results.claude, remaining));
  }
}
