# Companion / 本地配置链路专项审查与授权修复交接

## 范围与结论边界

本次先读架构约束，审查指定 companion、bridge、setup 及对应测试。起初只读；主会话随后明确授权边界修复、四项 UI 修复、测试隔离、服务商连接元组合并和 setup 端口推进。源码在最后的端口修复后冻结，未改生成镜像、构建/CI/发行脚本，未提交。

全部网络探针仅到本机临时 HTTP 服务；执行测试时隔离 HOME/USERPROFILE/TMPDIR/TMP/TEMP 及用户配置、服务商、状态、历史、日志路径。未启动/安装 ZCode，未访问外部模型 API。既有 zcode-path 测试只检查本机应用文件路径，没有运行宿主。UI 证据是执行真实注入脚本的内存 DOM 桩，不是实机 ZCode、真实浏览器布局或视觉验收。

**状态：授权修复已完成定向红绿验证，仍须主会话整合集成与独立审查。** 顾问 API 调用因公开参数模式校验失败未形成复核结论；主会话已指示停止重复调用并统一执行 native review。不能把下列定向绿测称作全套通过或发布通过。

## 原始证据

- [边界红测](companion-boundaries-red.log)：六项均失败，涵盖配置破坏、HTTP 假成功、非法保存输入、Host/Origin 绕过、网络错误归一化、响应体超时。
- [边界绿测](companion-boundaries-green.log)：25 pass / 0 fail；覆盖新增边界及两个已隔离的锁测试文件。
- [UI 红测](companion-ui-red.log)与 [UI 绿测](companion-ui-green.log)：四个真实脚本/内存 DOM 回归从失败转为通过。
- [服务商元组红测](companion-providers-red.log)：原实现保留 primary.invalid，而完整可用元组应来自 secondary.invalid。
- [定向合集绿测](companion-targeted-green.log#L227-L234)：13 个测试文件，222 tests / 222 pass / 0 fail / 0 skip，12685.084159 ms；这是端口修复前的快照。
- [端口红测](companion-ports-red.log)与 [端口绿测](companion-ports-green.log)：真实两端口占用及候选耗尽，2 fail → 2 pass；绿测总时长 603.020312 ms。
- [可重放残余探针](companion-residual-probes.cjs)与[输出](companion-residual-probes.log)：纯内存锁交错、setup 候选推进、纯函数平台输出解析。不启动宿主/CLI、不访问真实锁。

不存在“平均提速”结论。唯一明确的等待改善是原 stalled-body 用例 13506.315257 ms 看门狗到期仍未结束，修复后 12004.078389 ms 返回 models_timeout；这是完成时限保证，而非平均吞吐或延迟基准。

## 已确认并完成授权修复

以下工时为同类最小修复及回归的估计，不是本轮实际计时。所有“已修”均限于当前源码及所列定向证据。

### C01 — confirmed / 中：损坏配置被覆盖或保存失败却报成功

- 位置：[controller.cjs:779–790](../tools/companion/controller.cjs#L779-L790) `saveUserConfig`；[config-bridge.js:170–204](../tools/config-bridge.js#L170-L204) `writeUserConfig`；[setup-server.js:289–306](../tools/setup-server.js#L289-L306) 保存路由。
- 链路：磁盘用户配置是截断 JSON/数组/null → controller 旧实现读取失败降为 `{}` → 保存正常字段会覆盖原文件；bridge 拒绝损坏文件，但 setup 忽略 `r.error`，仍以 HTTP 200 `{ok:true}` 告知成功。null 还曾被 bridge 当作首次配置。
- 复现：临时文件写入截断 JSON，调用 controller 保存；修复前原文被改成只含新字段的配置。对同样损坏文件 POST setup 保存，修复前 200/ok:true 但文件未变。新增测试逐一检查坏 JSON/null/数组/原始值和文件内容。
- 最小修复：锁内读取，只有 ENOENT 才视为新文件；拒绝不可读/损坏/非对象配置；两个 HTTP 保存入口传递错误为 400，不删除原文。保留白名单、0600、原子替换及旧密钥迁移。
- 回归：[companion-boundaries.test.js:59–79](../test/companion-boundaries.test.js#L59-L79)。工时：1–2 小时。

### C02 — confirmed / 中：非法 JSON 保存请求可退化为成功或实际写入

- 位置：[controller.cjs:1554–1570](../tools/companion/controller.cjs#L1554-L1570) `readBody`；[setup-server.js:289–301](../tools/setup-server.js#L289-L301)。
- 链路：持令牌客户端发截断 JSON，旧 controller 吞解析错误为 `{}`；保存可触发遗留字段清理，其他状态路由也可能按缺省值执行。setup 旧路径也没有统一对象类型拒绝。
- 复现：POST malformed/null/[]，检查响应及配置字节；红测失败，修复后 400 且不写盘。
- 最小修复：解析失败和非普通 JSON 对象在边界拒绝，处理 request error/aborted，外层保留 400 状态。
- 回归：[companion-boundaries.test.js:81–91](../test/companion-boundaries.test.js#L81-L91)。工时：0.5–1 小时。

### C03 — confirmed / 中：setup 私有 GET 缺 Host/Origin 检查

- 位置：[setup-server.js:265–285](../tools/setup-server.js#L265-L285) `isLocalRequest` 与路由前置门禁。
- 链路：旧保护仅在部分 POST；GET 根页面与 `/api/history` 可用任意 Host/Origin 读取。攻击网页若完成 DNS rebinding 到本地端口，有条件读取配置展示和意见历史。普通跨源 fetch 仍受浏览器 CORS 限制，因此不是无条件远程读取漏洞。
- 复现：本机 fixture history 写 PRIVATE_FIXTURE_NOTE；raw HTTP 带 Host: attacker.invalid、Origin: http://attacker.invalid 请求 history，修复前 200 且包含该内容。此探针证明服务端门禁缺失，未宣称完成实浏览器 DNS rebinding 利用。
- 最小修复：所有路由共用前置 Host/Origin 检查，删除重复的局部检查。保留合法 localhost/127.0.0.1/IPv6 本机来源语义。
- 回归：[companion-boundaries.test.js:93–104](../test/companion-boundaries.test.js#L93-L104)，包含根页面、带 query 根页面与 history。工时：0.5–1 小时。

### C04 — confirmed / 中：模型清单超时只覆盖响应头，不覆盖响应体

- 位置：[controller.cjs:1485–1534](../tools/companion/controller.cjs#L1485-L1534) `fetchModels`。
- 链路：服务商先返回 HTTP 200 headers，再永久停住 JSON body → 原 timer 已清除 → `r.json()` 无限等待。fetch 在 headers 前拒绝又位于专用 catch 之外，API 得到通用 500 而非 models_error/models_timeout。
- 复现：本地服务器 flushHeaders 后不结束 body；原 13.5 秒看门狗观察仍 pending，修复后约 12 秒正常返回 models_timeout。另以 fetch rejection 桩验证结构化失败。
- 最小修复：fetch 和 JSON body 解析使用同一 AbortController/try/finally；finally 最后清 timer，非成功响应取消 body；统一网络错误。
- 回归：[companion-boundaries.test.js:129–159](../test/companion-boundaries.test.js#L129-L159)。工时：0.5–1 小时。

### C05 — confirmed / 高（配置条件触发）：合并服务商会拆拼 endpoint/key

- 位置：[controller.cjs:902–943](../tools/companion/controller.cjs#L902-L943) `readZcodeProviders`。
- 链路：同 id 的主来源有 endpoint 但缺 key，次来源有完整可用连接元组 → 原实现单字段补齐，形成主 endpoint + 次 key，可能把凭据发往与其不对应的端点。不是“官方通道”兜底问题，官方/协议过滤仍需保留。
- 复现：纯 fixture 设置 primary.invalid（不完整）及 secondary.invalid（完整）同 id；红测实际 primary.invalid，期望 secondary.invalid。另覆盖完整主元组优先、两个不完整不得拼成可用、unsupported 主来源、主文件损坏后次来源仍可用。
- 最小修复：主来源完整可用则保留；否则只用次来源完整可用元组整体替换 baseURL/apiKey/kind/protocol/eligible/source。保留 models 联集、名称/id/official 等非连接字段。
- 回归：[companion-boundaries.test.js:106–127](../test/companion-boundaries.test.js#L106-L127)。主会话负责 hooks 侧对应实现与整合。工时：1–2 小时（不含跨模块集成）。

### C06 — confirmed / 中：旧注入代际的请求覆盖新 UI

- 位置：[inject.js:29–32](../tools/companion/inject.js#L29-L32)、[inject.js:407–446](../tools/companion/inject.js#L407-L446) `paintHealth/pollHealth`、[inject.js:551–605](../tools/companion/inject.js#L551-L605) `refreshStatus`。
- 复现：旧 token health 请求悬置 → 新 token 注入且新 health=ok → 放行旧 bad_token 响应；原新 badge 退为 unknown。真实脚本/内存 DOM 红测确认。
- 最小修复：为每次注入保存 generation 身份，对全局 DOM 写入及跨 await 的 providers/status/history 更新检查当前代际；历史失败文案改 textContent，避免错误文本进 innerHTML。
- 回归：[inject.test.js:1201–1210](../test/inject.test.js#L1201-L1210)。仍未引入通用取消框架，不声称所有同代并发请求已串行化。工时：1–2 小时。

### C07 — confirmed / 中：宿主重建 badge 后产生重复 panel/id

- 位置：[inject.js:809–845](../tools/companion/inject.js#L809-L845) `buildBadge`。
- 复现：点击首次 badge 建立 body panel；只删除 composer 内 badge；触发 MutationObserver 重建；点击新 badge。原函数闭包 `panel=null`，忽略 body 已存在面板，产生两个 `zca-panel`；getElementById/事件随之可能指向旧隐藏面板。
- 最小修复：每次 toggle 先复用 document 中现有 panel，无则创建。
- 回归：[inject.test.js:1211–1219](../test/inject.test.js#L1211-L1219)，原 2，现 1。工时：0.5 小时。

### C08 — confirmed / 中：已保存手填模型被静默替换

- 位置：[panel.cjs:126–170](../tools/companion/panel.cjs#L126-L170) `loadProviders/fillModels`。
- 复现：配置 A/custom，服务商登记模型仅 A-listed；打开完整面板再读取保存表单。原 model=A-listed，导致修改其他设置也丢失 custom。
- 最小修复：仅初次/配置刷新回填时把不在清单中的已保存模型恢复到手填框；用户主动切换选项仍清手填，避免旧手填覆盖新选择。
- 回归：[inject.test.js:1237–1243](../test/inject.test.js#L1237-L1243)。工时：0.5–1 小时。

### C09 — confirmed / 中：模型清单旧响应跨服务商写入

- 位置：[panel.cjs:175–186](../tools/companion/panel.cjs#L175-L186) `fetchZcodeModels`；[panel.cjs:204–208](../tools/companion/panel.cjs#L204-L208) `clearManualIfPicked`。
- 复现：A 拉取未完成时改为 B，然后放行 A 响应；原 formValues 变成 B/A-live。新增回归还覆盖 A→B→A，不能只比较 provider id。
- 最小修复：modelEpoch 在加载/拉取/主动选择时递增，旧成功与旧失败均不写当前 UI。
- 回归：[inject.test.js:1245–1254](../test/inject.test.js#L1245-L1254)。工时：0.5–1 小时。

### C10 — confirmed / 中：锁测试默认破坏真实用户/运行中锁

- 位置：[auto-enable-lock.test.js](../test/auto-enable-lock.test.js)、[companion-lock.test.js](../test/companion-lock.test.js)。
- 原因：前者直接按 os.homedir() 递归删除 `.zcode/advisor-auto-enable.lock`；后者备份/覆盖/删除固定 os.tmpdir() controller 锁。常规测试命令未统一隔离 HOME/TMPDIR，即使还原内容也会扰动运行中进程及其心跳。
- 复现方式/证据：检查 import 前常量捕获与 reset/withLock 控制流；未对真实锁做破坏性复现。隔离后全部相应锁测试通过。
- 最小修复：require 被测模块前创建各自 fixture，设置 HOME/USERPROFILE/TMPDIR/TMP/TEMP；auto-enable 子进程继承隔离值；after 仅清理校验后的 fixture 根。
- 回归：既有锁语义测试及 [边界绿测](companion-boundaries-green.log)。工时：0.5–1 小时。

### C11 — confirmed / 中：setup 第二端口冲突后无限原地重试

- 位置：[setup-server.js:380–392](../tools/setup-server.js#L380-L392) error/listen 分支。
- 原因：每次 `const next = PORT + 1`，`next <= PORT + 10` 恒真；第二端口也被占用时重复同一地址并刷日志，没有退出上限。
- 复现：真实保留连续前两本机端口，原 2.5 秒内无 listening；保留全部 11 个候选，原同样不退出。内存原探针序列为 `[18765,18766,18766,18766]`。
- 最小修复：持久 candidatePort 逐次递增，最多初始端口加十且不超过 65535，耗尽落原错误退出路径；移除无用 `__RETRY__` 写入。
- 回归：[setup-port.test.js:42–67](../test/setup-port.test.js#L42-L67)；现第三端口实际 HTTP 200，耗尽 exit 1；冻结后内存序列 `[18765,18766,18767,18768]`。工时：0.5–1 小时。

## 未修问题与具体待验证条件

主会话明确要求本轮不扩修 controller/auto-enable 租约协议。下面不计入“已修复”，也不以定向绿测代替其验收。

### R01 — confirmed / 中：controller 单例锁不是互斥 CAS

- 位置：[controller.cjs:316–365](../tools/companion/controller.cjs#L316-L365) `writeLock/acquireLock/startLockHeartbeat`；启动空窗 [controller.cjs:1728–1747](../tools/companion/controller.cjs#L1728-L1747)。
- 实测：纯内存 VFS 调度 A 读旧 lease → B 完整 acquire/write/readback 成功 → A 根据已读旧 lease 再 write/readback 成功。日志为 `A:true,B:true,finalOwner:101`。这是合法进程交错，不依赖操作系统 rename 非原子。
- 影响：两实例都继续 CDP 注入/API，token 可互相轮换。旧持有者 heartbeat 发现丢锁仅停止续租，不停止服务。另 auto-enable 同步调用可 150 秒，而 lease TTL 60 秒、心跳在调用结束及 ensureCdp 后才启动，启动期间容易被判断陈旧。
- 最小修复方向：用真正排他的获取/接管协议与唯一 owner token；释放/续租都核对身份；失去所有权停止注入/API；避免同步启动操作跨越未续租 lease。只改 rename 为另一种写法不够。
- 回归：多进程 barrier 同时启动至少一百轮，始终只有一个成功；暂停旧持有者跨 TTL 后接管，旧者恢复不可删新锁/继续注入；慢 auto-enable 启动不允许双主。
- 工时：1–2 天（需要协议设计与故障注入，不能冒充几行小修）。

### R02 — suspected / 中：auto-enable 过期接管后旧持有者删除新锁

- 位置：[auto-enable.cjs:154–205](../tools/companion/auto-enable.cjs#L154-L205) `tryTakeOver/acquireSingleFlight/main`；[auto-enable.cjs:338–413](../tools/companion/auto-enable.cjs#L338-L413)。
- 静态依据：同样 tmp→rename→readback 不能保证排他；releaseFlight 无身份检查递归删除整个锁目录且 finally/exit 都调用。TTL 5 分钟，而 list 60 秒+四步骤各 120 秒的最坏预算超过 TTL。
- 条件与验证：需要旧流程运行超过 TTL、后继接管、旧流程再退出。未实际运行任何 CLI/长安装，所以保留 suspected；用假时钟与 execFileSync 桩即可低成本验证 A 完成清掉 B lease 的交错。
- 最小修复/回归：共享 R01 的 owner token/安全接管原则，单次幂等释放；可续租或明确期限内失败退出；模拟晚完成和 double-release。
- 工时：0.5–1 天，与 R01 一起设计。

### R03 — suspected / 中：auto-enable 输出解析未绑定同一插件记录/平台路径

- 位置：[auto-enable.cjs:301–335](../tools/companion/auto-enable.cjs#L301-L335) `parseInstallPath/isReadyFromList`。
- 已证明的纯函数行为：Windows `C:\Users\fixture\zcode-advisor\0.2.22`、enabled 输出被判未就绪；“先 disabled 9.0.0，再 enabled 0.2.1”且包 0.2.22 被判就绪。原因是 version 正则只认 `/`，且 enabled 正则与第一个版本匹配没有记录关联。
- 未证明部分：本机未运行 Windows CLI，也未验证真实宿主允许同名插件多市场记录及原生输出是否使用反斜杠。因此生产影响是 suspected，而非声称 Windows 已失效。
- 最小修复/回归：统一解析指定 enabled 条目的结构化记录，路径匹配兼容两种分隔符；加入真实脱敏的 Windows、多市场 CLI 输出 fixture；保留“不降级”和同版本指纹逻辑。
- 工时：2–4 小时，加真实输出采样。

### R04 — suspected / 低至中：auto-enable 与 controller 的 ZCode 路径发现不一致

- 位置：[auto-enable.cjs:59–93](../tools/companion/auto-enable.cjs#L59-L93) `findZcodeCli`；[controller.cjs:369–386](../tools/companion/controller.cjs#L369-L386) `findZcodePath`。
- 依据：auto-enable 向 detectZcodePath 传 `config:{}` 且不传 Spotlight 查询；controller 会读 companion 配置并提供查找。因此只配置非标准路径、未设置环境变量的用户可能能启动 host 却无法自动启用插件。
- 验证条件：构造只有 companion 配置指定路径存在、所有标准候选不存在的 fixture；分别调用两个查找分支比较。未实际启动宿主；不把所有非标准安装都说成失败（标准 fallback/env 可规避）。
- 最小修复/回归：复用同一显式路径输入，或由 controller 向 auto-enable 传已解析路径；测试配置优先级与不误用非宿主可执行文件。
- 工时：1–2 小时。

### R05 — suspected / 中：旧 setup HTML 仍有模型陈旧响应/手填模型丢失同类路径

- 位置：[setup-server.js:119–141](../tools/setup-server.js#L119-L141)、[setup-server.js:183–201](../tools/setup-server.js#L183-L201) 页面模板与 change handler。
- 依据：change handler await 模型结果后无 epoch，仍可把 A 结果放入已选 B；初始 option 只来自清单，已保存 custom 无匹配时选首项。已授权并运行回归的修复在 companion 完整面板，不等于旧 setup 页面也被修复。
- 验证：执行 setup 返回的真实 HTML script，延迟 A 请求后切 B；用未登记 custom 配置打开并保存其他字段。当前只作静态链路检查，未补真实页面运行，保留 suspected。
- 最小修复/回归：对 setup 的 provider/model 选择应用相同局部 epoch 和自定义值回填；不需要重写整页或引入 UI 框架。
- 工时：1–2 小时。

### R06 — suspected / 中：CDP 发现可能把令牌注入其他调试实例的任意网页

- 位置：[controller.cjs:413–420](../tools/companion/controller.cjs#L413-L420) `isCdp`；[controller.cjs:454–546](../tools/companion/controller.cjs#L454-L546) `attachTarget/rescan`。
- 条件：9333–9350 扫描段已由另一个 Chrome/CDP 程序监听且有不可信 page target。当前 Browser 字段即可通过，全部 page 被注入；页面脚本若能读取注入令牌，可调用本机已授权 API。
- 边界：普通网页不能自行打开本机监听端口；用户已开启其他 CDP 是前置条件。未运行真实浏览器验证，不能定为无条件远程鉴权绕过。`CORS:*` 自身不是漏洞，随机 token 仍是必要防线。
- 最小修复/回归：校验实际宿主身份或只注入已验证 ZCode 目标；fixture 含其他 Browser、host 页面和普通网页，确保后者不得获 token；本地同用户进程仍不能作为隔离安全边界。
- 工时：0.5–1 天，需真实可区分宿主标识。

### R07 — suspected / 低：Ping 只看 headers，未消费或取消响应体

- 位置：[controller.cjs:1451–1474](../tools/companion/controller.cjs#L1451-L1474) `ping`。
- 依据：timer 在 fetch 收到 headers 后清除，所有 HTTP 结果的 body 均未 consume/cancel。长期未结束 body 的 provider 下反复 Ping 可能占住连接；200 HTML 也会显示 OK，不过 Ping 的既定目的仅是连通性，不能据此要求它验证完整顾问 JSON 帧。
- 验证：本地服务器返回成功 headers 但保留 body，重复调用后观察活动连接，需与取消后对照；本轮未采样连接/内存曲线，不能声称已造成泄漏。
- 最小修复/回归：无需解析完整 LLM 帧，仅在确认 status 后取消 body，并证明调用终止后连接可释放。
- 工时：0.5–1 小时。

### R08 — suspected / 中：会话展示与写入之间没有 expected-session 校验

- 位置：[controller.cjs:1024–1164](../tools/companion/controller.cjs#L1024-L1164) 最近活动信标及 `toggleSessionEnabled/setSessionTarget`，另 `enqueueUserNote`；[inject.js](../tools/companion/inject.js) 会话操作载荷。
- 条件：面板展示 session A 后，另一窗口 B 变成最近活动，再点击“本会话”开关/模型/意见。写入端会重新选择最近信标，载荷没有 expected session id，可能作用 B。
- 边界：项目明确选择“最近活动会话”为当前识别策略；不能仅凭此设计判 bug。待主会话确认面板标签承诺是否要求点击绑定所展示会话，再用双信标 fixture 验证 TOCTOU。
- 最小修复/回归：若需要绑定，则发送展示时的 expectedSessionId，变化时 409 并刷新/让用户确认，保留现有 session-id 路径清理与写锁。
- 工时：2–4 小时（需先确认产品语义）。

## 安全边界、性能与过度设计判断

保留并认可：loopback 绑定；随机 per-start token；API 不回传 key；支持自定义协议的 token+CORS 设计；文本转义/textContent；配置白名单/0600/原子写；文件写锁；平台 EPERM/ESRCH 区分；spawn/execFile 参数数组；launchd 真实 plist 路径约束；禁止降级与同版本指纹检查。这些不是因为“代码长”就应删除的防御。

局部重复已安全减少：setup 的 Host/Origin 路由检查集中一次；端口分支删无用环境标记。不建议本轮把 hook/controller 独立打包加载边界强行合并。端点归一化的刻意重复有对应一致性测试，重构前须验证打包依赖。

尚无可靠性能基准证明 history 全文件读取、health 对全部文件 stat、MutationObserver 扫描或 eager 指纹计算是实测瓶颈；仅列未来采样方向，不标高风险，不宣称平均提速。最有价值的已做性能/可靠性改善是 bounded models 请求和 bounded 端口重试。

## 完整检查清单与覆盖说明

### 指定生产文件：九个，逐函数静态检查

- [controller.cjs](../tools/companion/controller.cjs)：历史/健康、锁、路径/主进程探测、CDP 扫描/attach/重注入/清理、配置写入、服务商合并与选择、信标/session 修改、意见队列、端点归一化、Ping/models、全部 HTTP 路由、main/退出。
- [inject.js](../tools/companion/inject.js)：代际清理、API、状态/历史、意见事件、转义、模型选择、会话控制、panel/badge 构建、定位/观察器、轮询/boot；CSS 只作代码检查，没有截图视觉验收。
- [panel.cjs](../tools/companion/panel.cjs)：页面标记及脚本所有函数、provider/model 手填/回填、异步刷新、保存、Ping、history、交互事件。
- [lib.cjs](../tools/companion/lib.cjs)：modelsUrl/parseModels（它不是 HTTP server，无独立鉴权路由）。
- [zcode-path.cjs](../tools/companion/zcode-path.cjs)：plist 解析、bundle/可执行文件解析、三平台候选、优先级/诊断。
- [launchd.cjs](../tools/companion/launchd.cjs)：XML、运行时候选、plist 路径、安全操作限制、安装/加载/变更重载、卸载/状态/CLI。
- [auto-enable.cjs](../tools/companion/auto-enable.cjs)：payload/CLI 发现、lease、版本/指纹、CLI 输出解析、幂等/升级步骤、初次配置/main。
- [config-bridge.js](../tools/config-bridge.js)：GUI 配置读取/合并、锁/原子写、删除字段、MCP stdin/out、错误报告。
- [setup-server.js](../tools/setup-server.js)：页面和浏览器脚本、配置读写、服务商/Ping/models、Host/Origin、全部路由、端口错误与浏览器启动。

### 对应测试：十四个，全文检查；除新增端口文件外已包含于 222 定向合集

[companion.test.cjs](../test/companion.test.cjs)、[companion-zcode.test.js](../test/companion-zcode.test.js)、[companion-lock.test.js](../test/companion-lock.test.js)、[auto-enable-lock.test.js](../test/auto-enable-lock.test.js)、[auto-enable-version.test.js](../test/auto-enable-version.test.js)、[launchd.test.js](../test/launchd.test.js)、[zcode-path.test.js](../test/zcode-path.test.js)、[remove-and-conflicts.test.js](../test/remove-and-conflicts.test.js)、[panel.test.js](../test/panel.test.js)、[session-api.test.js](../test/session-api.test.js)、[bridge-stderr.test.js](../test/bridge-stderr.test.js)、[inject.test.js](../test/inject.test.js)、[companion-boundaries.test.js](../test/companion-boundaries.test.js)、[setup-port.test.js](../test/setup-port.test.js)。

支持性读取：[ARCHITECTURE.md](../ARCHITECTURE.md)、[package.json](../package.json)。未把其他测试的搜索命中算作全文审查，未把测试中对构建脚本的字符串断言算作构建/发行审查。

### 具体未覆盖面

- 未建立 Istanbul/V8 分支覆盖报告；“逐函数检查”不是声称 100% 动态函数/分支覆盖。
- 未启动真实 CDP/ZCode，未检验当前宿主 DOM 选择器/CSP、真实 WebSocket 生命周期/多窗口交错。
- Windows/Linux 真实安装、launchctl 操作及升级流程未执行；平台测试使用 fixture/桩，macOS 应用路径测试只有文件解析。
- 未对真实会话状态/历史/用户目录执行写入或破坏性锁测试。
- 主会话负责核心 hook、构建/CI/发行、生成镜像同步、最终全套 integration/native review；本报告不替代这些验收。
