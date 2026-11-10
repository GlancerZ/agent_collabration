# Slack Dual Agent Skill

可复用的 Codex skill：在一个 Slack 频道中，使用现有 **Codex CLI + Claude Code** 执行任务、交换意见并给出明确结果。包含中文操作协议、可运行的本机协调程序、Slack manifests、管理界面和回归测试。

## 功能

- **独立模式**：分别完成并展示原始成果，互评修订、比较优点，最后整合为更好的结果并独立复查。
- **协作模式**：交换计划、分工执行、整合与复查。
- **讨论决策**：直接形成明确共同结论，保留理由、条件和分歧，不强制文件。
- **自然追问**：看结果/问状态直接答复，真正修改才继续必要阶段。
- **完成通知**：Codex 在原讨论串通知并广播 @发起者，说明如何继续需求。
- **可选能力**：依赖安装、已有 SSH alias、独立 Playwright 浏览器、目标 Mac 已支持的官方 Computer Use 适配。

两位保留各自账户、session和目录。默认一次执行一个任务，其余排队，任务内两位可并行。无需 Docker 或新的模型 API Key，调用仍使用现有 CLI 计划/额度。

## 安装 skill

克隆后复制技能目录（已有同名目录时先检查差异）：

```sh
git clone https://github.com/GlancerZ/agent_collabration.git
cd agent_collabration
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
cp -R skills/slack-dual-agent "${CODEX_HOME:-$HOME/.codex}/skills/"
```

在支持本机 skill 的 Codex 调用：

```text
使用 $slack-dual-agent 在本机搭建 Slack 双 agent 系统。
使用现有 Codex CLI 和 Claude Code，先核对账户与模型来源。
```

入口：[SKILL.md](skills/slack-dual-agent/SKILL.md)，也可按文档手动搭建。

## 准备运行目录

需要 Node.js 24+、Git 和两个已登录的 CLI。以下仅创建新目录和本机初始配置，默认不启用 Slack 或附加能力：

```sh
node skills/slack-dual-agent/scripts/check-package.mjs
node skills/slack-dual-agent/scripts/materialize.mjs --destination /absolute/path/agent-room
cd /absolute/path/agent-room
npm ci --ignore-scripts --no-audit --no-fund
node src/main.js doctor
node src/manage.js start
```

打开 `http://127.0.0.1:7417`，按 [搭建指南](skills/slack-dual-agent/references/setup.md) 安装两个 Slack app，在本机填凭据与允许列表，邀请 bot 到指定公开频道，再连接。

```text
@Codex independent 设计一个番茄钟网页
@Codex collaborate 讨论两个方案，给出共同认可的建议，不需要文件
```

只 @Codex 一次。新任务频道另发；查看、解释、修改和 `pause/resume/cancel/status` 在原串继续。验收要求可选。

## 目录

```text
skills/slack-dual-agent/
  SKILL.md                    技能入口
  agents/openai.yaml          展示元数据
  references/                 接入、协议、身份、能力、维护
  scripts/                    校验与无覆盖材料化脚本
  assets/coordinator/         协调程序、网页、manifests、测试、锁文件
  assets/coordinator-manifest.json  文件清单与 SHA-256
```

运行目录 `npm test` 做回归，`npm run demo` 不调用模型/Slack，`node smoke.js` 用 CLI 额度做真实小任务。模拟测试不能证明实际连接。

系统在本机运行，成果链接默认仅本机可访问，未发布公网。Mac 桌面适配依赖当地官方 Computer Use、访问上下文和原生审批，普通 CLI 不保证可用。仓库排除运行配置、凭据、SSH 信息、用户任务和历史截图。

架构借鉴 [Triglav](https://github.com/adam-drag/triglav)，附带代码独立实现，没有复制其源码或资源。依赖遵循各自许可证；不打包 CLI、浏览器或官方桌面插件二进制。
