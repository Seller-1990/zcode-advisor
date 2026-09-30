# 安装后真机自检清单（宿主契约验证）

> 以下实验验证的是 mock 测试无法覆盖的宿主契约。**任何一项失败都请把现象与
> `/advisor-status` 的完整输出反馈回来**，对应机制将按真机行为重构。
>
> 部分项已在开发机（macOS x86_64）实测通过并标注结论；未标注的仍需在你的机器上确认。

## 实验 0：发行包与角标（原生部署链路）

**构建**（macOS 与 Windows 均可；受限网络需令 nodejs.org 走代理）：

```bash
export https_proxy=http://127.0.0.1:7897   # 视网络环境
NODE_USE_ENV_PROXY=1 npm run build -- --mac-arch=x64
```

✅ 通过标准：`dist/` 出现 zip / tar.gz（macOS 上还会出现 .dmg；Windows 上还会出现 setup.exe，前提是 makensis 可用）；
构建日志显示「内嵌 Node：是」，且每个产物都出现对应的一行「校验通过」，三种形态的串为：

- 绿色包：`校验通过（依赖闭包 + 系统工具 + require 冒烟）：…`
- 安装器：`校验通过（PE 头 + 体积合理性）：…`
- DMG：`校验通过（hdiutil verify + .app 结构与依赖闭包）：…`

若显示「内嵌 Node：否」，需按提示配代理或换 `NODE_DIST_MIRROR`。

**macOS 安装**（归档是**平铺**的，没有顶层目录，解压后直接执行 `install.sh`）：

```bash
mkdir -p zca && tar -xzf dist/ZCodeAdvisor-<v>-macos-x64.tar.gz -C zca
cd zca && ./install.sh
```

或直接使用 DMG：打开 `ZCodeAdvisor-<v>-macos-x64.dmg`，把 `ZCode Advisor.app` 拖入 Applications。

✅ 通过标准：`~/Applications/ZCode Advisor.app` 存在；启动台可见；`Contents/MacOS/ZCodeAdvisor` 可执行。

**角标注入**（本项已在开发机实测通过）：

```bash
node tools/companion/controller.cjs     # 控制台保持开启
```

- ✅ 通过标准（已在开发机验证）：日志出现「ZCode 可执行文件：…（来源：自动探测…）」→
  「发现已运行的调试实例（端口 9333），直接附着」或「CDP 通道就绪」→「已附着页面」；
  ZCode 输入框右下角出现 🛡️ 角标。
- 点击角标 → 设置面板可打开（已实测页面内 `__zcodeAdvisorInjected=true`、`zca-badge` 元素存在）。
- 面板内完成「填端点 + key → 拉取模型 → Ping → 保存」，`~/.zcode/advisor.config.json` 被写入。
- 刷新页面或新开窗口后角标应自动恢复（`addScriptToEvaluateOnNewDocument` 通道）。
- ⚠️ **破坏性验证需用户自行执行**：若要验证「由本脚本冷启动 ZCode」，须先完全退出 ZCode
  并停掉 zcode-plus 的 controller（避免调试端口争抢）；执行前请确认 ZCode 内无未保存工作。

---

## 实验 1：注册行可达（覆盖：插件市场识别、`${CLAUDE_PLUGIN_ROOT}` 展开、UserPromptSubmit additionalContext 契约）

1. ZCode → 设置 → 插件管理 → 添加插件市场 → 选择本项目目录 → 安装 `zcode-advisor` → 保持启用。
   列表应显示「ZCode 顾问 / ZCode Advisor」（展示元数据来自 marketplace.json）。
2. **新开会话**，发送任意一条消息（如"你好"）。
   ⚠️ 注意：斜杠命令与注册行都在**会话创建时**注册——安装前就打开的旧会话里没有它们，新建会话即可，不是故障。
3. ✅ 通过标准：该消息前出现以 `[advisor]` 开头的注册行（含"脚本"与"状态文件"两个绝对路径；未配 key 时还会有一行"门禁未满足：missing:apiKey"——这本身也是被验证的行为）。
4. 顺带验证命令链：运行 `/advisor-status`，应能执行并输出状态块（而不是"未挂载"）。
5. 顺带验证插件设置表单（⚠️ 预期**不渲染**）：
   ZCode 官方插件规范（plugin-creator 的 `plugin-json-spec.md`）未定义 `userConfig`；
   ZCode 3.14.4 的 `app.asar` 中亦未检索到插件系统处理该字段的逻辑。
   **若详情页未出现配置表单，这属预期行为**——请改用 🛡️ 角标或双击 `配置面板.cmd`。
   若你的版本确实渲染了表单，请在反馈中注明版本号（这会更新上述结论）。

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
| 0 发行包与角标 | 构建 + 路径探测 + 角标注入已在开发机通过（macOS x64） | 2026-09-30 |
| 1 注册行 | | |
| 2 后台审查 | | |
| 3 解析产率 | | |
