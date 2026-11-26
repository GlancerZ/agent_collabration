## 验收结论：通过，无阻断交付项

**逐项判定**

1. **从零选来源写入 skill**：通过。第零步要求先问来源和型号，分别记录，不沿用上次选择。本次已口头指定的整组只需复述后采用。
2. **空白运行先选来源**：通过。`test_cold_start.py` 断言来源提示先于型号提示；无 TTY 且未给选择时退出码为 2，且不建文件。
3. **三方路由**：通过。桩测试得到 5 组 CLI/型号，依次为 claude、agy、claude、codex、claude，型号与参数一致。
4. **不跨源回退**：通过。Claude 失败后只记录 1 次调用，随即停止。
5. **离线预览与模拟/实测区分**：通过。`--show-routing` 在调用 `which` 和任何服务之前返回。

**证据不足（不阻断）**

- Claude 的 `modelUsage` 和 agy 实测只出现在派工标准里，测试记录没有原始回报。
- Codex 没有真实调用记录。
- Antigravity-Claude 路线只验证了预览，没有桩调用。

**可选改进**

- 交互时直接回车，Claude 会记为 `default`，不一定是 Opus 5.5。建议在本项目的 `--show-routing` 示例中写明 `--claude-model claude-opus-5-5`。
- agy 的提示词经 argv 传递，长文本可能超出系统限制。
- skill 名仍是 spatial，与"通用科研"不符。