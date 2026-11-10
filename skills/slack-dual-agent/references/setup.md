# 搭建与 Slack 接入

## 选择实例，避免覆盖

新机器需要 Node.js 24+、Git、两个已安装的 CLI，以及可用的 Slack workspace。Python 3 用于 SSH 本机交互 PTY；Playwright 与 Mac 桌面是可选模块。

维护时复用原实例。迁移时复制代码到新目录，显式迁移私有配置，停妥旧实例后再连接同一频道，不从发布包带入另一台机器的凭据或数据库。

附带代码在 `assets/coordinator/`。在 skill 所在目录运行：

```sh
node scripts/materialize.mjs --destination /absolute/path/agent-room
```

目标必须尚不存在或为空；脚本拒绝覆盖已有实例，不安装依赖、不启动服务、不登录 Slack。它检测 Codex、Claude、Python 路径，创建 `.local/config.json`（0600）和私有目录（0700）。找不到 CLI 时保留命令名并说明；发现可执行文件不等于登录成功。

在运行目录执行：

```sh
npm ci --ignore-scripts --no-audit --no-fund
node src/main.js doctor
node src/manage.js start
node src/manage.js status
```

打开 `http://127.0.0.1:7417`。本版本无开机自启登记；当前登录期间运行，休眠、断网会中断实时执行。重启时未完成任务暂停并保留检查点，不自动重跑。

## 两个 Slack app

从运行目录的 manifest 分别创建 **Codex** 与 **Claude**，公开频道默认权限：

| app | Bot scopes | Events / 额外 token |
| --- | --- | --- |
| Codex | `app_mentions:read`, `chat:write`, `channels:history`, `channels:read` | `app_mention`, `message.channels`；Socket Mode；App Token 仅 `connections:write` |
| Claude | `chat:write`, `channels:read` | 不接收频道事件，无需 App Token |

两个 bot 安装到同一 workspace，邀请进入指定频道。取得两个不同的 Bot Token 和一个 Codex App Token，用户在本机管理页私密填写；不在聊天中索取 token。填写允许的频道 ID 和发起者 Member ID，保存并连接。连接程序核对同一 workspace、不同 bot、双方都是频道成员。

安装、OAuth scope 和服务条款遵从用户实际授权；已有授权不重复请求，新范围或授权页面新增约束需单独处理。不得将一台机器、一个 app 的审批写成永久许可。

## 第一次发任务

在 Slack 提及菜单中选中真正的 Codex bot，再输入：

```text
@Codex independent 设计一个简洁的番茄钟网页
@Codex collaborate project=myrepo 修复首页加载问题
@Codex collaborate 讨论两个备选方案，给出你们共同认可的建议，不需要文件
```

验收要求可省略。两位自动参与，无须再次 @Claude。需要固定验收命令时在本机项目配置中设置。

每个新的顶层任务对应独立讨论串。多个任务可以连续提交并分别跟踪；**当前附带版本一次执行一个任务，其他排队，同一任务两位 worker 可以并行**。不要宣传为多任务同时执行。

## 项目配置

```json
{
  "scratch": {"path": "", "ref": "HEAD", "verify": []},
  "myrepo": {
    "path": "/absolute/path/to/clean/repository",
    "ref": "HEAD",
    "verify": [["npm", "test"]]
  }
}
```

Git 项目必须干净，启动时固定到同一提交，生成两个 detached worktree；不直接改原 checkout，不自动 push、merge 或部署。非 Git 任务用两个空目录。验收参数数组通过 `execFile` 执行；管道封装进自己的检查脚本，不拼接 Slack 提供的 shell。项目目录和命令只能由本机配置决定。

## 私有配置与可选能力

常规设置在管理页修改；能力配置可局部编辑 `.local/config.json`。先确认无运行任务，断开 Slack或停妥服务，保留既有字段，不打印完整配置。更改能力后重启并验证，避免旧运行对象仍引用旧配置。

初始 `capabilities`：

```json
{
  "shellNetwork": false,
  "dependencyCommands": false,
  "ssh": {"enabled": false, "hosts": []},
  "browser": {"enabled": false, "mode": "playwright", "headless": false},
  "desktop": {"enabled": false, "backend": "codex-native", "paused": false},
  "pythonBin": ""
}
```

放在配置顶层的 `capabilities` 中。按 [capabilities.md](capabilities.md) 启用和验收。
