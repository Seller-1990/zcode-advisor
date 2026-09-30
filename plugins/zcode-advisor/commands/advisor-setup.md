---
description: 交互式配置 advisor 的 API key 与审查模型（写入用户级配置，跨升级保留）
argument-hint: "[<api-key>] [model:<model-id>]"
---

帮用户完成 zcode-advisor 的 API key 填写与审查模型选择。参数（可空）：$ARGUMENTS

## 步骤

1. **定位脚本**：在当前上下文中查找以 `[advisor]` 开头的注册行，取出"脚本"后的绝对路径。若找不到注册行，告知用户需先安装并启用插件、新开会话后再运行本命令；不要猜测路径。
2. **收集信息**（参数为空时逐项询问用户，一次问完）：
   - **API key**（必填）：智谱 BigModel/Z.ai 的 API key。提醒用户：key 将明文写入用户主目录下的 `~/.zcode/advisor.config.json`（Windows 即 `%USERPROFILE%\.zcode\advisor.config.json`），该文件不在任何 git 仓库内。
   - **审查模型**（可选，默认 `glm-5.3-flash`）：向用户说明——审查模型建议比主对话模型更强或至少不同；若用户的主对话就是 flash 级，推荐尝试 `glm-5.3` 等更强模型（以用户套餐实际可用为准）。用户不确定时可先跳过，稍后用 Ping 逐个试。
   - **端点**（可选，默认 `https://open.bigmodel.cn/api/paas/v4/chat/completions`）：仅当用户明确使用兼容网关时才修改；非官方端点会触发配置警告。
3. **写入用户级配置**：先用 Bash 运行 `node -e "console.log(require('os').homedir())"` 拿到用户主目录；若 `~/.zcode/advisor.config.json` 已存在，先 Read 出现有内容并**合并**（保留用户已设置的其他字段），再用 Write 写入。内容形如：

   ```json
   {
     "apiKey": "<用户提供的 key>",
     "model": "<选定模型>",
     "baseUrl": "<端点，未变则省略此字段>"
   }
   ```

   注意：不要把 key 写进插件安装目录的 advisor.config.json（那是会被升级覆盖的缓存副本），也不要写入会话 Transcript 或让 key 出现在最终回复里。
4. **验证**：运行

   ```
   node "<脚本绝对路径>" ctl doctor --ping
   ```

   向用户如实报告输出：门禁是否满足、Ping 是否 OK、耗时。若 Ping 失败：
   - `llm_http_401/403` → key 无效或无权限；
   - `llm_http_404/400` → 模型 id 或端点路径不对，建议换模型再用 `ctl doctor --ping --model <id>` 逐个验证；
   - `llm_timeout`/`llm_error` → 网络或端点问题。
5. **收尾**：告知用户配置已写入用户级配置文件（给出实际路径），对新会话与既有会话的下一轮审查立即生效；会话级临时换模型用 `/advisor-model set <id>`；之后可用 `/advisor-status` 观察审查次数与 Token 累计。
