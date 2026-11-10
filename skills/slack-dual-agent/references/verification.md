# 验证、维护与分享

## 分层验证

1. **包**：skill 目录 `node scripts/check-package.mjs`，检查文件清单/哈希/路径/明显凭据；当地 skill-creator 可用时跑 `quick_validate.py`。它们不证明运行正确。
2. **回归**：运行目录 `npm test`。可设置 `AGENT_ROOM_TEST_PYTHON=/absolute/path/python3` 跑真实 PTY 用例，否则明确跳过；大部分模拟 CLI，不用模型/Slack。
3. **演示**：`npm run demo` 用 MockRuntime 和独立数据目录，不调用模型、不发 Slack，不可宣称真实 agent 验收。
4. **真实 CLI**：`node smoke.js` 和 `node smoke.js --collaborate` 用现有登录/额度，做小文件任务，使用 `.local/smoke`，不接 Slack。它们只测基础流程，不证明全部工具；能力需经配置 CapabilityHub 的路径验收。
5. **真实讨论**：低成本选择题，核对原始意见、具体结论版本、明确接受、答案未被 summary 覆盖，没有额外写文件。
6. **真实 Slack**：获准频道小任务，核对双方身份、原串、实际结果、完成广播；追问结果确认没有新轮次。没有新变化时不反复重测。
7. **可选能力**：只验此次启用模块，见 [capabilities.md](capabilities.md)。

附带回归覆盖隔离、初稿独立、最终整合/复查、讨论版本确认、追问分流、durable 通知、路径/symlink、CSRF、browser/SSH、desktop 租约/快照/暂停/审批。通过数量以本次输出为准，不写死历史数。

## 维护不干扰运行

状态优先 loopback `/api/state`、`/api/access`，只提取必需字段，不输出 CSRF 或完整响应。数据库用 SQLite read-only。**不要为了看状态实例化生产 Store**：构造器会暂停运行/排队任务。

运行中不重启、覆盖目录或换配置/浏览器。按检查点停妥再维护；`.local` 备份放本机私有位置，不进仓库。恢复先检查身份/连接，再恢复任务。

| 症状 | 检查/修复 |
| --- | --- |
| 401、模型不符 | 定位 CLI/登录/provider；保留全局配置，只修本次覆盖；身份不明暂停 |
| 看结果重开循环 | 查看分流应只读返回，不能改 epoch/要求 |
| “整合完成”却没有答案 | finalAnswer 与阶段 summary 分开，通知展示真实结论 |
| 超限仍宣称成功 | 查 unresolved、verify、双方对同版的同意 |
| reviewer 缺 Bash | 提供实际文件快照与只读工具，不提升为写权限 |
| 断线缺完成通知 | 查 outbox 与完成事务，重连继续发送 |
| 截图保存错 | 核对 MIME，JPEG/PNG转换并验 magic bytes |
| 新终端 CUA 不可用 | 查官方配置和当前上下文，不硬编码旧 pipe/env |
| alias有但SSH失败 | 查精确 alias、认证、复用，不循环触发MFA |

升级在独立副本核对 CLI 参数、锁文件和受影响真实调用；加载 skill 时不自动升级依赖/权限。分享只用代码允许清单，排除 `.local`、数据库/WAL、token/env、SSH信息、浏览器档案、session、用户任务、截图和私人指南。检查最终 Git diff 后传用户指定仓库；新仓库默认私有，明确要求才公开。

## 来源

参考 [Triglav](https://github.com/adam-drag/triglav) 的本机 CLI 调度、角色评审和有界交接思想。附带实现独立编写，没有复制其代码、资源或作为运行依赖。

部署时以所安装版本和官方资料为准：

- [Codex 非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Codex CLI 参数](https://learn.chatgpt.com/docs/cli/reference)
- [官方 Computer Use](https://learn.chatgpt.com/docs/computer-use)
- [Claude Code 编程运行](https://code.claude.com/docs/en/headless)
- [Slack Socket Mode](https://docs.slack.dev/tools/bolt-js/concepts/socket-mode/)

产品文档说明接口，共享官方 CUA 的队列适配属于本参考实现，需本机实测。
