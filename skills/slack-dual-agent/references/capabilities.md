# 能力模块

只启用任务和用户授权需要的模块，默认全部关闭。它们不改变两位的模型、账户或 session。

## 网页、联网与依赖

Codex 网页搜索、Claude `WebSearch/WebFetch` 在规划/执行/评审可用，分类器关闭搜索。当前事实实际读来源并报时点；终端下载失败不能当成网页研究不可用。

按需设置 `shellNetwork=true`、`dependencyCommands=true`。Codex 开工作区网络，Claude 只增常用包管理器、Python/Node、下载命令前缀，保留拒绝规则，不全局允许 Bash。`project_install` 用各自目录、缓存和 Python `.venv`，默认不跑 npm 生命周期脚本，不全局安装。拒绝时报告所需权限，不自动解除。

## SSH

设置 `ssh.enabled=true`、`ssh.hosts=["my-server"]`，替换成用户获准的精确 alias。沿用已有密钥、主机验证和复用。登记不等于认证，先查身份、主机和目录。

执行：`ssh_exec/upload/download`；评审只读：`ssh_status/read_file`。传输本机路径限自己的工作区，默认远端目录按任务/角色分开，用户指定项目时按原路径。远端目录约定不是硬隔离。

密码/MFA只在本机管理页发起一次 PTY 交互，由用户完成；输入不进数据库、Slack、持久日志。后台检查不弹 MFA。不关闭主机验证。Mac 长 socket 使用短私有路径。

验收实际 hostname、whoami、目录及小文件上传/读回/下载哈希。SSH 成功不证明远端 GUI、app-server 或计算环境就绪。

## 独立 Playwright 浏览器

在运行目录安装匹配浏览器：

```sh
PLAYWRIGHT_BROWSERS_PATH="$PWD/.local/browser-runtime" node node_modules/playwright/cli.js install --no-shell chromium
```

设置 `browser.enabled=true`、`mode="playwright"`；通常 `headless=false` 便于接管。每 job/role 各自 browser/context，跨阶段保留页面，服务重启关闭。不同 worker 不共用登录，不接个人 Chrome。

支持打开网页/工作区 HTML、普通点击/填写、截图、控制台检查；不提供任意页面 JS。不让 worker 打开协调管理/授权页。执行可保存截图，评审只看不写。真实验收分别访问网页、点击本机计数按钮、输入角色标记并截图，协调者直接核对页面状态及不同 context。

登录、验证码、需要用户确认的外部提交保留页面并交接用户。

## 官方 Mac Computer Use

这是**已有本机官方入口的适配**，不是独立分发的 OpenAI 桌面服务。需要受支持的 Mac 桌面环境、已启用官方 Computer Use、CLI 可枚举的 stdio `cua_repl` 配置，以及启动进程当时有效的原生访问上下文。普通 CLI、SSH 或开机 daemon 不保证可用。

`officialDesktopTransport` 读已有 `codex mcp list --json`，内存中原样使用官方配置，不复制插件二进制、访问凭据或旧管道。验证后才 `desktop.enabled=true`。缺条件时说明，不换其他控制器后宣称复用成功。

双方都经 `agent_room.desktop_*` 调同一入口，推理与 CLI 独立。只在 Slack Codex worker 单次调用关闭原始 CUA 来维护队列，不改普通 Codex 全局配置。

- inventory → acquire 独占租约 → 新快照定位 → 操作 → 完整 AX 读回 → release；每步换 token，不复用旧索引。
- 所有任务/角色共用物理桌面队列。轮次结束、取消、暂停释放；输入结果不确定时暂停，不自动重放。
- 评审只附着 inventory 中已运行 app，不开新 app、不点击/输入、不保存截图绕过只读。
- 原生 form elicitation 显示在管理页，包含原文/app/角色；仅收到用户明确选择后返回，不自动接受。未答/过期/取消返回取消。一次 Calculator 测试许可不扩展到其他 app 或永久授权。
- 原生 app 审批与 macOS 录屏/辅助功能分别处理，系统授权由用户完成。不能操作 Codex/ChatGPT、终端、系统安全或凭据提示，也不能换入口绕过。
- 用完整 AX 避免 diff 隐去“发送/授权”等控件。按实际 MIME 处理 JPEG/PNG，必要时转换并验证，不能把 JPEG 字节伪称 PNG。

具体获准 app 上分别核对两位的实际 UI 和截图。列出 app 不等于能输入点击；历史截图不证明新机器可用，原生授权可能再次请求。

## 网关

`CapabilityHub` 按 job/role/stage、目录和只读状态签发短期随机网关，CLI turn 结束失效；仅暴露阶段工具，Claude 严格接入 `agent_room`，分类器无网关。worker 与宿主仍可能同 OS 用户，不能描述成容器级隔离。保留原生拒绝和人类接管。
