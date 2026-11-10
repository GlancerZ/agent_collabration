import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { loadConfig, privateDir, DATA, ROOT } from './src/config.js';
import { Store } from './src/store.js';
import { CliRuntime } from './src/runtime.js';
import { Engine } from './src/engine.js';
const config = loadConfig(); config.turnTimeoutSec = 600; config.rounds = 1;
const data = resolve(DATA, 'smoke'); privateDir(data);
const store = new Store(resolve(data, 'smoke.sqlite'));
const engine = new Engine({ store, config, runtime: new CliRuntime(), data });
const collaborative = process.argv.includes('--collaborate');
const resumeId = process.argv.find(x => x.startsWith('--resume='))?.slice(9);
const job = resumeId ? store.get(resumeId) : engine.start({ mode: collaborative ? 'collaborate' : 'independent', project: 'scratch', prompt: collaborative
  ? '这是协作整合接入测试。Codex 负责在自己的目录创建 codex-part.txt，内容为 CODEX_PART 加换行；Claude 负责在自己的目录创建 claude-part.txt，内容为 CLAUDE_PART 加换行。整合阶段由 Codex 读取两个部分，在 Codex 自己的目录创建 final.txt，内容必须恰好是 CODEX_PART\\nCLAUDE_PART\\n（真实换行）。计划和讨论阶段不要写文件。最终由 Claude 只读核对 final.txt 的真实内容与两部分是否一致，报告实际看到的证据。不需要搜索网页、外部插件或额外 agent。'
  : '这是系统接入冒烟测试。只在自己的当前工作目录创建 room-check.txt，文件内容必须恰好是 AGENT_ROOM_OK 加一个换行，然后读取文件核对。不需要搜索网页，不要调用任何外部插件或额外 agent。交付报告列出这个文件和你实际读到的内容。评审阶段只读取对方同名文件检查内容是否完全符合要求，不修改文件。' });
if (resumeId) engine.control(resumeId, 'resume');
let last = resumeId ? store.messages(job.id).at(-1)?.seq || 0 : 0;
const timer = setInterval(() => { for (const m of store.messages(job.id).filter(m => m.seq > last)) { console.log(m.role, m.stage, m.body.slice(0, 600)); last = m.seq; } }, 1000);
await engine.idle(); clearInterval(timer);
const result = { job: store.get(job.id), messages: store.messages(job.id), simulated: false };
writeFileSync(resolve(ROOT, collaborative ? 'smoke-collaboration-report.json' : 'smoke-report.json'), JSON.stringify(result, null, 2));
console.log('RESULT', result.job.status, result.job.note || ''); store.close();
process.exitCode = result.job.status === 'completed' ? 0 : 1;
