---
description: 查看/设置/重置本会话的 advisor 端点与 API key（会话级覆盖，不影响全局）
argument-hint: "[set <baseUrl|-> <apiKey|-> [model:<model-id>] [fallback:<model-id>] | show | reset]"
---

帮助用户为**当前会话**单独设置 advisor 的 API 端点与 key（全局配置不变，其他会话不受影响）。参数：$ARGUMENTS

1. 在当前上下文中查找以 `[advisor]` 开头的注册行（含"脚本"与"状态文件"两个绝对路径）。若找不到，回复："advisor 未在本会话挂载，无法管理会话级 API。" 不要猜测路径。
2. 从注册行取出两个路径，按参数选择子命令（Bash）：
   - 参数为空或 `show`：`node "<脚本绝对路径>" ctl api show --state "<状态文件绝对路径>"`
   - 参数以 `set ` 开头：`node "<脚本绝对路径>" ctl api set <baseUrl|-> <apiKey|-> [model:<model-id>] [fallback:<model-id>] --state "<状态文件绝对路径>"`
   - 参数为 `reset`：`node "<脚本绝对路径>" ctl api reset --state "<状态文件绝对路径>"`
3. `set` 参数规则（向用户说明）：
   - 位置参数依次为 端点、key；不想改的一项写 `-`（保留现状）。`model:<id>` 与 `fallback:<id>` 是可选的具名前缀参数（可单独使用：只改模型 / 只设本会话的降级备用模型）。**备用模型仅 async 模式生效**，且在主模型遇 `llm_empty_response`/`unparsed`/`llm_http_404` 时才会被启用（其余错误不切换）。
   - 端点填 OpenAI 兼容地址（`https://…/v1` 基地址或完整 `…/chat/completions` 均可，会自动补全路径）。
   - key 将**明文写入本会话的状态文件**（仅当前用户可读，0600）；状态查看只回显掩码。
   - 覆盖自**下一轮审查**起生效；只影响本会话，全局配置与其他会话不变。
4. `reset` 清除本会话的端点/key 覆盖（恢复跟随全局；模型覆盖需用 `/advisor-model reset` 单独清除；本会话的备用模型覆盖需重新 `api set fallback:<id>` 或直接改状态文件）。
5. 如实报告输出。设置后建议运行 `/advisor-status` 确认：会话覆盖行、生效端点与 key 掩码、门禁是否满足。
