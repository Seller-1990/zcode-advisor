---
description: 在当前会话启用 advisor 审查副模型
---

帮助用户在当前会话启用 zcode-advisor：

1. 在当前上下文中查找以 `[advisor]` 开头的注册行（含"脚本"与"状态文件"两个绝对路径）。若找不到，回复："advisor 未在本会话挂载，无法用命令启用。请先确认插件已在 设置 → 插件 中安装并启用，然后新开会话。" 不要猜测路径。
2. 从注册行取出两个路径，运行（Bash）：

   ```
   node "<脚本绝对路径>" ctl on --state "<状态文件绝对路径>"
   ```

3. 如实报告输出。若提示门禁未满足（缺 apiKey/model/baseUrl），告诉用户：编辑本插件安装目录下的 advisor.config.json 填入 apiKey，或在 Windows 用 `setx ZCODE_ADVISOR_API_KEY <key>` 设置后**重启 ZCode**（GUI 启动的进程读不到 shell 里临时 export 的变量）。此开关只影响当前会话。
