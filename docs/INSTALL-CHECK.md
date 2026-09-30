# 安装后真机自检清单（第 3 条行动：宿主契约验证）

> 以下三项实验验证的是 mock 测试无法覆盖的宿主契约。**任何一项失败都请把现象与
> `/advisor-status` 的完整输出反馈回来**，对应机制将按真机行为重构。
> 全部通过后，本插件即达可交付状态。

## 实验 1：注册行可达（覆盖：插件市场识别、`${CLAUDE_PLUGIN_ROOT}` 展开、UserPromptSubmit additionalContext 契约）

1. ZCode → 设置 → 插件管理 → 添加插件市场 → 选择本项目目录 → 安装 `zcode-advisor` → 保持启用。
2. **新开会话**，发送任意一条消息（如"你好"）。
   ⚠️ 注意：斜杠命令与注册行都在**会话创建时**注册——安装前就打开的旧会话里没有它们，新建会话即可，不是故障。
3. ✅ 通过标准：该消息前出现以 `[advisor]` 开头的注册行（含"脚本"与"状态文件"两个绝对路径；未配 key 时还会有一行"门禁未满足：missing:apiKey"——这本身也是被验证的行为）。
4. 顺带验证命令链：运行 `/advisor-status`，应能执行并输出状态块（而不是"未挂载"）。
5. 顺带验证插件设置表单：设置 → 插件管理 → zcode-advisor 详情页应出现配置字段（API key/模型/端点/模式）。若你的 ZCode 版本没有渲染该表单，改用双击 `配置面板.cmd` 的本地网页面板，并在反馈中注明。

## 实验 2：后台审查链路存活（覆盖：detached worker 在 hook 退出后存活、转录文件持续性）

1. 先完成 key 配置（`/advisor-setup`，Ping OK）或临时用 mock（见下）。
2. 发起一轮会触发工具调用的任务（如"读取 README.md 并总结"），等回合结束。
3. **等 2 分钟**（worker 异步审查），然后运行 `/advisor-status`。
4. ✅ 通过标准：`审查次数 ≥ 1`；状态文件目录（注册行中有路径）下 `*.lock` 已消失；`Dropped` 无 `no_transcript`。
5. ❌ 失败形态与含义：`Dropped:no_transcript` → 宿主给 hook 的转录文件是"每轮临时快照"而非持续追加文件（byteOffset 增量与后台延后读取两个机制需重构）；`busy` 连续出现且 reviews 恒 0 → worker 被宿主进程树回收。

## 实验 3：转录格式解析产率（覆盖：与 Claude Code 同构假设）

1. 跑 2-3 轮正常对话后运行 `/advisor-status`。
2. ✅ 通过标准：`审查次数` ≈ 对话轮数；`Dropped:parse_empty` = 0（或仅有零星几条）。
3. ❌ `parse_empty` 持续增长 → 真实转录行结构与解析器假设不符，需要从真实转录文件采样适配（注册行中有状态文件路径，state 内记录了 transcriptPath 可直接取样）。

## 附加验证（可选）

- **输入框角标外挂**：双击 `启动-Advisor-ZCode.cmd`（若 ZCode 已在运行请先完全退出）→ 等控制台显示"CDP 通道就绪"与"已附着页面" → ZCode 输入框区域右下角出现 🛡️ 角标 → 点开设置面板 → 填端点与 key →「拉取模型」看是否列出模型 → 选模型 →「Ping 测试」→「保存」→ 回会话发一轮消息后 `/advisor-status` 看 Token 累计是否使用新配置。注意：`/models` 拉取取决于端点是否支持，BigModel 官方端点若不支持属预期（面板会提示手动输入）。
- **resume/compact 重发注册行**：长会话触发压缩后，下一条消息应重新出现注册行（依赖宿主 SessionStart stdin 是否带 `source` 字段——未验证项）。
- **sync 模式**：`advisor.config.json` 配 `reviewMode: "sync"`，观察 blocker 是否当轮打断、每轮收尾延迟是否可接受。
- **mock 快速自检**（不消耗 key，Git Bash）：

  ```bash
  cd "<安装缓存里的插件目录>"
  mkdir -p state && touch state/.mock-allowed
  ZCODE_ADVISOR_MOCK=1 ZCODE_ADVISOR_MOCK_FRAME='{"severity":"blocker","note":"演示"}' \
  ZCODE_ADVISOR_API_KEY=e2e-key ZCODE_ADVISOR_REVIEW_MODE=sync \
    node hooks/advisor-hook.js stop <<< '{"session_id":"demo","transcript_path":"test/fixtures/transcript-basic.jsonl","stop_hook_active":false}'
  # 期望 stdout：{"decision":"block","reason":"[advisor:blocker] 演示（以上来自审查副模型……）"}
  ```

## 结果记录

| 实验 | 结果（通过/失败+现象） | 日期 |
| --- | --- | --- |
| 1 注册行 | | |
| 2 后台审查 | | |
| 3 解析产率 | | |
