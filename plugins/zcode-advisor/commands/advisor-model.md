---
description: 查看/固定/重置本会话的 advisor 审查服务商与模型
argument-hint: "[set <model-id> [provider:<id|名称>] | provider <id|名称> | reset]"
---

帮助用户管理**当前会话**的 advisor 审查服务商与模型（全局配置不变，其他会话不受影响）。参数：$ARGUMENTS

1. 在当前上下文中查找以 `[advisor]` 开头的注册行（含"脚本"与"状态文件"两个绝对路径）。若找不到，回复："advisor 未在本会话挂载，无法管理模型。" 不要猜测路径。
2. 从注册行取出两个路径，按参数选择子命令（Bash）：
   - 参数为空：`node "<脚本绝对路径>" ctl model --state "<状态文件绝对路径>"`
   - 参数以 `set ` 开头：`node "<脚本绝对路径>" ctl model set <model-id> [provider:<服务商id或名称>] --state "<状态文件绝对路径>"`
   - 参数以 `provider ` 开头：`node "<脚本绝对路径>" ctl model provider <服务商id或名称> --state "<状态文件绝对路径>"`
   - 参数为 `reset`：`node "<脚本绝对路径>" ctl model reset --state "<状态文件绝对路径>"`
3. 如实报告输出。向用户说明：
   - **端点与 key 不在本命令范围**——它们永远由选中的 ZCode 第三方服务商解析得到，本命令不接受也不存储任何端点/key（状态文件里也没有明文 key）。
   - `set` 只覆盖当前会话、自下一轮审查起生效；`provider <id>` 只换服务商，会把本会话模型清空回落该服务商清单（旧模型多半不属于新服务商）。
   - 优先级为**本会话覆盖 > 全局 > 该服务商登记清单首项**；服务商必须是**非官方内置**（`builtin:` 的 BigModel/Z.ai 通道被排除）且协议受支持（OpenAI 兼容或 Anthropic）并已配端点与 key。
   - 无效模型/服务商会在 `/advisor-status` 的 `Dropped:llm_http_4xx` 与状态行中暴露。
4. 全局默认的改法：🛡️ 角标 →「完整配置」面板（或本地配置面板 `127.0.0.1:8789`）选服务商 + 模型 → 保存；也可直接编辑 `~/.zcode/advisor.config.json` 的 `zcodeProvider` / `model`。
