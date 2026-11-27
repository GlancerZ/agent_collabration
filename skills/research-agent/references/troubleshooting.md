# 实践经验与排错

盘点结果看起来像失败、shell 脚本报奇怪的变量错误、要中途给 Codex 改指令，或后台派工后不确定是否启动时读本文件。配置核实见 [routing.md](routing.md)，MFA、SSH 和 GPU 相关经验见 [compute.md](compute.md)。

- **盘点时别把分段续跑误判为失败。** Slurm 显示 FAILED，可能只是外层脚本在训练未跑完时以退出码 1 结束，以便下一段续跑。先看日志里的训练返回码（如 `train_rc=0`、`done=false`、“checkpoint saved”），再下结论。
- **macOS 的 bash 3.2 和中文路径。** 变量后面直接接中文时（如 `"$WD/收到的派工单.md"`），bash 可能把中文字节也当成变量名，报 `WD�: unbound variable`。启动脚本里的变量一律写成 `${WD}`，写完用 `bash -n` 检查。zsh 里，把命令放进变量再执行（`P="python3 x.py"; $P …`）会把整串当成一个命令名，改用函数：`P() { python3 x.py "$@"; }`。
- **中途改指令。** `codex exec` 运行时收不到新消息。先确认集群上没有在途作业，再停掉进程，然后用 `codex exec resume <会话ID> "<补充指令>"` 接着原会话继续，保留它已有的上下文。resume 不接受 `--sandbox`，要用 `-c sandbox_mode=workspace-write -c sandbox_workspace_write.network_access=true`，型号用 `-m`，推理强度用 `-c model_reasoning_effort=…`。若补充指令改变已登记的输入、代码或配置，先新开尝试，按新输入重新核对放行条件。补充派工单存进主控目录，写明替代原派工单的哪部分、为什么替代。恢复会话的用量用 `--since` 只计新增（[context-and-usage.md](context-and-usage.md)）。
- **后台运行后要确认真的启动了。** 用后台任务派工后，过十几秒检查工作目录里是否出现日志，进度页上的状态是否已变成 running。任务失败时，先查明 Codex 是否启动、是否已提交作业，再修复并重新派发，并在事件栏记录。
