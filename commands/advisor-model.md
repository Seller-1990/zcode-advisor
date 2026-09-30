---
description: 查看/固定/重置本会话的 advisor 审查模型
argument-hint: "[set <model-id> | reset]"
---

帮助用户管理当前会话的 advisor 审查模型。参数：$ARGUMENTS

1. 在当前上下文中查找以 `[advisor]` 开头的注册行（含"脚本"与"状态文件"两个绝对路径）。若找不到，回复："advisor 未在本会话挂载，无法管理模型。" 不要猜测路径。
2. 从注册行取出两个路径，按参数选择子命令（Bash）：
   - 参数为空：`node "<脚本绝对路径>" ctl model --state "<状态文件绝对路径>"`
   - 参数以 `set ` 开头：`node "<脚本绝对路径>" ctl model set <model-id> --state "<状态文件绝对路径>"`
   - 参数为 `reset`：`node "<脚本绝对路径>" ctl model reset --state "<状态文件绝对路径>"`
3. 如实报告输出。说明：`set` 只覆盖当前会话、自下一轮审查起生效（不校验模型存在性，无效模型会在 status 的 Dropped:llm_http_4xx 中暴露）；全局默认模型在插件安装目录的 advisor.config.json 中修改（注意：运行时读取的是安装缓存里的副本，改源码目录不生效）。
