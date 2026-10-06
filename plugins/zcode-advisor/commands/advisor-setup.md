---
description: 交互式配置 advisor 的审查服务商与模型（写入用户级配置，跨升级保留）
argument-hint: "[model:<model-id>] [provider:<id|名称>]"
---

帮用户完成 zcode-advisor 的审查服务商与模型选择。参数（可空）：$ARGUMENTS

> **0.2.17 起本插件不再维护端点与 API key**：审查通道的唯一来源是 ZCode 里已维护的
> **第三方**服务商（`~/.zcode/v2/config.json` 的 `provider.*`，排除 `builtin:` 官方内置通道）。
> 本命令**不收集、不写入任何 key**——用户想换 key 请改 ZCode 设置里的服务商。

## 步骤

1. **定位脚本**：在当前上下文中查找以 `[advisor]` 开头的注册行，取出"脚本"后的绝对路径。若找不到注册行，告知用户需先安装并启用插件、新开会话后再运行本命令；不要猜测路径。
2. **列出可用服务商**：运行

   ```
   node "<脚本绝对路径>" ctl providers
   ```

   把输出如实呈现给用户（只有**非官方内置 + 协议受支持（OpenAI 兼容或 Anthropic）+ 端点/key 齐备**的才会列出；要含被排除项与原因可加 `--all`）。若一个都没有，告知用户：请先在 ZCode 设置 → 模型服务商里添加一个 OpenAI 兼容（或 Anthropic 协议）的第三方服务商（含端点与 key），再回来运行本命令。
3. **收集信息**（参数为空时逐项询问用户，一次问完）：
   - **审查服务商**（可选）：从第 2 步的列表里选；留空 = 自动选择（优先含所填模型的可用服务商）。
   - **审查模型**（可选）：向用户说明——建议与主对话模型形成能力差（主模型是 flash 级时优先试更强的）；以该服务商实际登记/可用的为准，不确定时可先跳过，稍后用 `ctl doctor --probe --model <id>` 逐个试。留空 = 取该服务商登记清单首项。
4. **写入用户级配置**：先用 Bash 运行 `node -e "console.log(require('os').homedir())"` 拿到用户主目录；若 `~/.zcode/advisor.config.json` 已存在，先 Read 出现有内容并**合并**（保留用户已设置的其他字段），再用 Write 写入。内容形如：

   ```json
   {
     "zcodeProvider": "<服务商 id>",
     "model": "<选定模型>"
   }
   ```

   注意：**不要写 `apiKey`/`baseUrl`/`apiSource`/`zcodeModel`**——这些旧键已失效，写入时会被清除；也不要把任何 key 写进插件安装目录的 `advisor.config.json`（会被升级覆盖的缓存副本）。
5. **验证**：优先用能力探针（比 ping 准——ping 用 max_tokens=1，思考型模型会把预算全烧在推理上而误报 OK）：

   ```
   node "<脚本绝对路径>" ctl doctor --probe
   ```

   如实报告输出的**通过率与耗时分布**（如「5 次通过 4/5，median 8s，失败分类 llm_empty_response×1」）。**不要**替用户下「模型可用」的判决——探针输出的是样本分布，N=5 全过时失败率上界仍有约 45%；要更强的判断可建议加 `--n 15`。

   若只想快速看端点/认证是否连通（不测能力），可用 `node "<脚本绝对路径>" ctl doctor --ping`。

   若探针/ping 失败：
   - `llm_http_401/403` → 该服务商的 key 无效或无权限（去 ZCode 设置里改）；
   - `llm_http_404/400` → 模型 id 或端点路径不对，建议换模型再用 `ctl doctor --probe --model <id>` 逐个验证；
   - `llm_empty_response` → 思考型模型烧预算（探针会带 reasoning 提示），调大 maxTokens（建议 ≥4096）；
   - `llm_timeout`/`llm_error` → 网络或端点问题；
   - 门禁提示 `zcode_provider_*` → 服务商不满足条件（官方内置/协议不兼容/缺端点或 key/找不到），按提示去 ZCode 设置里修。
6. **收尾**：告知用户配置已写入用户级配置文件（给出实际路径），对新会话与既有会话的下一轮审查立即生效；会话级临时换服务商/模型用角标面板的「本会话的审查模型」块或 `/advisor-model set <id> [provider:<id>]`；之后可用 `/advisor-status` 观察审查次数与 Token 累计。
