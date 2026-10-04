---
description: 查看 advisor 审查副模型的会话状态
---

帮助用户查看 zcode-advisor（审查副模型）的当前状态：

1. 在当前上下文中查找以 `[advisor]` 开头的注册行（advisor 挂载时由首条消息/SessionStart 注入，含"脚本"与"状态文件"两个绝对路径）。若找不到，回复："advisor 未在本会话挂载（插件未启用，或会话早于插件安装开始；新开会话即可挂载）。" 不要猜测路径。
2. 从注册行取出"脚本"与"状态文件"两个路径，运行（Bash）：

   ```
   node "<脚本绝对路径>" ctl status --state "<状态文件绝对路径>"
   ```

3. 把命令输出原样呈现给用户，并用一句话总结：是否启用、门禁是否满足、服务商与模型及来源、会话覆盖（服务商/模型是否被本会话单独固定）、Token 累计、顺延队列、Dropped 计数是否非零。**不要**从输出里提取或复述任何 key（输出只会给掩码；明文 key 永不出现在状态输出中）。Dropped 类别含义：`llm_empty_response`（模型思考耗尽输出预算，建议 maxTokens 提到 4096）、`unparsed`（回复无合法 JSON 帧且散文救回未开启或守门拒绝）、`llm_timeout`（审查超时）、`llm_http_*`（端点/认证/限流错误）、`llm_error`（网络层失败）、`no_transcript`（转录文件缺失）、`parse_empty`（转录有完整行但全部无法解析——转录格式与预期不符，需反馈排查）、`busy`（同会话上一轮审查仍在后台进行）、`global_busy`（全局在飞 worker 达上限）、`queue_overflow`（顺延队列满）、`spawn_failed`（后台审查进程派生失败）、`worker_error`（后台审查进程内部异常）。注意：`config_invalid`/`config_out_of_range`/`zcode_provider_*` 不是 Dropped 类别，它们出现在输出的"配置问题"行——`zcode_provider_*` 表示 ZCode 里没有可用的第三方服务商（官方内置通道不用于审查），需去 ZCode 设置里修。
