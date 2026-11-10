# 身份与运行环境

## 分四层核对

| 层次 | 证据 | 不能据此推断 |
| --- | --- | --- |
| 可执行文件 | 路径、版本、必要时官方签名/来源 | 登录账户或真实模型 |
| 登录 | Codex `login status`；Claude `auth status` | 没有 provider 重定向 |
| 路由/配置 | model/endpoint 及会话覆盖的脱敏摘要 | 调用已经成功 |
| 真实调用 | 成功事件、session、actual model/provider、工具结果 | Slack 或全部能力通过验收 |

账户标识向本机用户私下核对，不写入通用 skill 或公开仓库。不打印完整环境、登录文件或配置。

## 原生调用与兼容性

`src/runtime.js` 启动两个进程，解析流事件并保存各自 session：

- Codex：`exec` / `exec resume`，JSON 事件和输出 schema；写阶段 `workspace-write`，规划/评审只读，网页研究 `web_search="live"`。
- Claude：`-p --output-format stream-json --verbose --json-schema`，`--resume` 延续会话，`--strict-mcp-config` 只接本实例 `agent_room`，不自动加载 Slack MCP。
- 临时协调分类器：隔离只读，不复用 worker session，不接执行能力。

部署时检查所安装 CLI 的帮助及官方文档，再做小的真实调用。未知参数应定位适配，不退回全权限或换 provider。依赖用包锁，升级在副本验证。

## Claude 官方登录

安装 Claude Code 不代表真实 Claude：全局 base URL、token、apiKeyHelper、模型别名或其他云 provider 可能重定向请求。

`src/claude-auth.js` 在单次进程应用默认 `claude-login`：清除重定向环境，指定官方 endpoint，清空 helper/模型别名，选择已有 Claude 登录；不改全局设置，不复制凭据。真实流模型需可核验为 `claude-` 前缀，未知或非 Claude 就拒绝当作成功。`inherit` 只供用户明确选择其他既有路由，不能偷偷用于绕过核对。

Codex 同样检查既有 provider；第三方配置需如实告知并遵从用户选择，不能只凭可执行文件名宣称 OpenAI。沿用用户已有模型配置，不擅自锁定“最新”模型。

## 401、授权卡住、工具被拒绝

先确定哪个 worker、哪个 CLI 和错误层：缺登录、第三方 key 失效、登录过期、模型权限或工具权限，只报告脱敏错误。需要用户在本机登录时保留任务/检查点，完成后重查并在原串 `resume`。不重复 MFA、不借另一账户 token、不全局删配置或改 API key。

重装只在用户要求或证据支持时进行，并保留配置可恢复性。`doctor` 是安装/登录预检，不能代替真实模型或能力验收。
