# 方案：可见性 · 模型探针 · 降级（advisor 0.2.9+）

> 状态：**定稿待实施**（方案讨论阶段，尚未动代码；已经一轮对抗性复审并落实全部阻断项）
> 来源：2026-10-02 两轮顾问审查（本质追问者 / 反驳者 / 后端对抗者 / 逻辑对抗者 / 前端对抗者 / 产品对抗者 / 无情行者，全部真实派发）+ 一轮定稿复审（逻辑对抗者）
> 触发背景：hy4-preview-f 空响应故障后，作者（用户）提出「状态可见 / 模型测试 / 自动降级」三项诉求

---

## 0. 一句话结论

系统的根本缺口不是「缺功能」，而是**只有一条通道**——意见与告警都走 `additionalContext`（注入给**主模型**），**没有面向用户的第二条通道**。本方案的主线是补这条通道，并在此之上安全地加探针与降级。

---

## 0.1 定稿复审记录（2026-10-02）

定稿经「逻辑对抗者」复审，发现 6 项阻断级问题，**已全部落实修订**：

| # | 阻断项 | 修订位置 |
| --- | --- | --- |
| 1 | M1 的 P0「指示器失效被误读为正常」未真正关闭（单一 ts 无法区分「没跑」与「跑了没结果」；N 未定义） | §3 M1：双时间戳 + 状态机 + N 定义 + 单点边界如实声明 |
| 2 | M4 预算算术在 sync 下错误（primary 实际只剩 0.5T）；`reviewTurn` 双调用点未声明 | §3 M4②：模式限定 async-only + 模式守卫 + 重试绑定 primaryDeadline |
| 3 | fallback 的 120s 对慢思考模型失效，且 reserve 无依据 | §3 M4②：约束 fallbackModel 为快模型 + reserve 可配 |
| 4 | 多会话指示器语义无解（「UI 只表达当前会话」无实现机制） | §3 M1：改按会话分文件 + 标注来源 sessionId，不假装知道当前会话 |
| 5 | M3 遗留缺陷（面板/安装器 Ping 仍误报）未如实声明 | §3 M3 + §5 风险表：显式声明为 P1 遗留 |
| 6 | M1 状态机未定义；degraded 在 M1 阶段不可达未声明 | §3 M1 状态机表 + §4 优先级说明 |

另落实建议改进项：N 的统计依据（§3 M3）、M0 的依赖程度修正与环境注入步骤（§3 M0）、信标路径尊重 `ZCODE_ADVISOR_STATE_DIR`（§3 M1）、M3 判据 5/6 的实现方式（§3 M3）、M2 排除 `delivered` 与跨会话（§3 M2）、M4 的循环依赖兜底（§3 M4③）、证据快照固化（§5.1）。

**复审确认成立的结论**（未被击穿）：M4 的 deadline 不变量（async）、M3 的统计推理、M4① 的排除清单、M4④ 的凭据边界、M3「不做持久标记」的四点理由、§1.2 全部 file:line 引用。

---

## 1. 背景与关键事实

### 1.1 真实故障（2026-10-02）

- 思考型模型 `hy4-preview-f` 在 `maxTokens=4096` 下把输出预算全烧在 reasoning → `finish_reason=length`、`content` 为空 → 判 `llm_empty_response`，连续失败。
- 实测对比（同一份 6930 字符输入，直接 POST 端点）：
  - `hy4-preview-f` + 4096：finish=length、reasoning=4096、content 空 → 零产出
  - `glm-5.3-flash` + 4096：4/4 成功，finish=stop、reasoning 仅 98~187
- 用户于 17:55 换 `glm-5.3-flash` 后恢复。

### 1.2 已核实事实（决定方案走向）

| 事实 | 证据 |
| --- | --- |
| 意见与告警**共用一条通道**：`additionalContext`（注入给主模型） | `hooks/advisor-hook.js:367-387` |
| 告警**只在 UserPromptSubmit 触发**（用户必须先发消息） | `advisor-hook.js:344-360` |
| **告警从未真正触发过**：全部 10 个会话 `healthAlertCount=0`、`healthNotifiedAt=""` | state 文件实测 |
| 但意见**确实投递过**（`queued` + `delivered count=1`） | `~/.zcode/advisor-history.jsonl` |
| 意见/告警在 ZCode UI 的**可见性从未验证** | README 未声明，用户反馈「我并没有看到」 |
| companion（controller + CDP 注入）已存在，但 **controller 未运行** | `pgrep` 无结果 |
| controller **不读会话 state**，只读 `advisor-history.jsonl` | `tools/companion/controller.cjs:36-49` |
| history **不记录 `llm_*` 失败**（仅 delivered/queued/queue_overflow） | `advisor-hook.js:374/631/806` |
| badge **零轮询**，仅打开面板时刷新 | `tools/companion/inject.js:302/640` |
| CDP 注入依赖非公开接口，**大版本更新可能失效** | `README.md:151` |

### 1.3 必须记录的纠错

> **首轮结论「告警已响，只是文案错」是纯代码路径推演，已被证伪。**
> 实测 `healthAlertCount` 全为 0 —— 告警从未触发过。用户「没看到」不是「没注意」，是「它压根没发生」。
> 教训：**凡「用户能否看到」类结论，必须实证，不得由代码路径推演。**

---

## 2. 方案总览（分层）

```
┌──────────────────────────────────────────────────────────────┐
│ 通道①（现有）模型可见：additionalContext → 主模型             │
├──────────────────────────────────────────────────────────────┤
│ 通道②（本方案）用户可见：health beacon → controller → badge   │  ← 主线
│    · 顶部三色态（绿/黄/红/灰）                                 │
│    · 意见浮窗（新意见/故障时短暂浮现）                          │
└──────────────────────────────────────────────────────────────┘
         ▲                                    ▲
         │ 写入                                │ 读取
    ┌────┴─────┐                    ┌─────────┴──────────┐
    │ hook 进程 │                    │ controller + badge  │
    │（知会话） │                    │（不知会话，靠 beacon）│
    └──────────┘                    └────────────────────┘
```

**设计原则**：真相源（hook，知道会话与健康）与展示层（badge）解耦，通过**独立信标文件**传递；**信标陈旧时显示「未知」，绝不显示绿**。

---

## 3. 模块设计

### M0. 受控验证（前置，必须先做）

**目的**：终结「additionalContext 在 ZCode UI 到底可不可见」的争论。这条结论决定 M2 的**形态侧重**（补通道 vs 改醒目度），并影响 M1 三色态的必要性。

> **范围修正（复审建议项 2）**：M0 只决定 M2 的**形态**，不决定 M2 做不做。即使用户能看到 additionalContext，「不知道它什么时候返回了意见」的诉求仍成立。原文档称其为 M2 的「决定性影响」属程度夸大。

**做法**：注入一条带 `[TEST]` 前缀的 mock 意见（顾问 nit 采纳），记录注入时间戳。

```
note: "[TEST] 可见性验证 $(date +%s) —— 若你能看到本行，说明 additionalContext 对用户可见"
```

**实现步骤（复审建议项 2——补环境变量注入方式）**：
1. 在 `resolveStateDir` 结果目录放置 `.mock-allowed` 标记文件（`mockAllowed()` 的判据，见 `advisor-hook.js` 中 `mockAllowed(stateDir)` 调用点）。
2. 以 `ZCODE_ADVISOR_MOCK=1` 启动一次 hook 的 stop 事件（或直接构造 pendingNotes 注入）。
3. 用户下一条消息时肉眼确认。

**验收**：用户肉眼确认 UI 中是否出现该 `[TEST]` 行。

**✅ 实测结论（2026-10-02，已完成）**：**通道「模型可见、用户不可见」**。
- 注入方式：经真实代码路径 `enqueueNote` 写入会话 `pendingNotes`（时间戳 `2026-10-02T14:45:21.538Z`）。
- 投递佐证：`advisor-history.jsonl` 记录 `14:47:53 event:delivered count:2`（`[TEST]` 与顾问 concern 一并被 UPS 消费）。
- 模型侧：`[TEST]` 行**确实出现在主模型上下文**（下一轮 UPS 注入的 additionalContext）。
- 用户侧：用户明确反馈「输入框上方/上下文都没有显示这一行」。

**结论**：`additionalContext` 是**单向喂给主模型**的通道，**对用户不可见**。这证实 §0 的核心假设，也解释了用户「太静默」的根因——所有 `[advisor]` 输出（含健康告警）从设计上就不是给用户看的。

**对下游模块的影响**：
- **M2（意见浮窗）经用户决定：砍掉**。用户明确「具体的顾问返回的消息其实可以不显示」，只关心健康态。省去整套浮窗 UI。
- M1（健康信标）成为**唯一**用户可见路径，重要性上升。

---

### M1. 健康信标 + 顶部三色态

**目标**：满足「知道顾问在正常运行」「出问题要知道」「顶部 tab 变色一目了然」。

**为什么不直接让 badge 读会话 state**（前端对抗者致命项）：
- state 是**每会话**的（`sess-<id>.json`），badge 是**全局单例**——粒度不匹配，多会话并存时必然「薛定谔的红灯」。
- controller **定位不到 state 目录**（`resolveStateDir` 依赖宿主注入的 env，controller 是用户态进程，`advisor-hook.js:87-94`）。
- 按 mtime 猜会话是**仓库明令禁止**的做法（`advisor-hook.js:849-853`）。

**设计**：

1. **信标文件**：路径**尊重 `ZCODE_ADVISOR_STATE_DIR`**（与 `hooks/lib/history.js:28-33` 同约定，避免测试/多 profile 污染真实目录），默认 `~/.zcode/advisor-health.json`，权限 0600。**按会话分文件**：`advisor-health-<sessionId>.json`（解决多会话覆盖，见下）。

2. **两个时间戳，分两处写**（复审必须修改项 1——关闭 P0）：

```json
{
  "sessionId": "sess_xxx",
  "lastAttemptAt": "2026-10-02T14:02:38.198Z",   // Stop 父进程在 spawn 前写
  "lastSuccessAt": "2026-10-02T14:02:30.000Z",   // worker 审查完成时写
  "model": "glm-5.3-flash",
  "effectiveModel": "glm-5.3-flash",
  "state": "ok | degraded | down",
  "reason": "unparsed",
  "reviews": 28
}
```

- **`lastAttemptAt`**：在 **Stop 父进程**（`advisor-hook.js:439-442` 附近，spawn 之前）同步写。父进程一定会执行到这一步。
- **`lastSuccessAt` / `state` / `reason`**：在 worker 完成落盘处（`advisor-hook.js:762-813`）写。

> **为什么必须两个时间戳**：worker 被 SIGKILL/OOM/机器休眠时 `finally` 不执行（`advisor-hook.js:822-824`），信标只更新 `lastAttemptAt` 不更新 `lastSuccessAt`。仅靠单一 `ts` 无法区分「审查没跑」与「跑了没结果」，会出现「停摆期间持续显示绿」的假绿。

3. **状态机**（复审必须修改项 6）：

| 条件 | state | 颜色 |
| --- | --- | --- |
| `lastSuccessAt` 在 STALE 内 且 无 `primaryFailStreak` 达阈值 | `ok` | 绿 |
| `primaryFailStreak` 达阈值 且 `fallbackUsed` 增长（M4 启用时） | `degraded` | 黄 |
| `lastAttemptAt` 在 STALE 内，但 `lastSuccessAt` 超过 STALE（有尝试无成功） | `down` | 红 |
| **无 `lastAttemptAt`**（会话未在跑审查）或 `lastAttemptAt` 超过 STALE | **未知** | **灰/问号** |

**STALE 阈值的定义（复审必须修改项 1）**：`STALE = max(10 分钟, 2 × reviewBudgetMs)`。理由：async 默认 B=480s，worker 最坏生命周期 = B；2×B 确保「一个正在正常运行的慢审查」不会被误判为陈旧。T=240s 时 STALE=16 分钟。

> **符号约定**：本文档中 **STALE** 专指 M1 的信标陈旧阈值；**N** 专指 M3 的探针采样次数。二者无关，勿混。

4. **controller 新增 `GET /api/health`**（自动继承 `X-Advisor-Token` 鉴权，`controller.cjs:613`），读信标文件 + 返回陈旧度。**多会话处理**：controller 读目录下全部 `advisor-health-*.json`，返回「最近 `lastAttemptAt` 的那一个」并附 `sessionId`；badge 显示 `sessionId` 前 8 位，明确标注这是「最近活动的会话」（复审必须修改项 4——不再承诺「只表达当前会话」，因 controller 无从得知用户在哪个会话）。

5. **badge 轮询** `/api/health`（5s 间隔，loopback，开销可忽略）。

**关键纪律（前端对抗者致命项）**：
- **信标陈旧/缺失必须显示「未知」，绝不显示绿**。
- 「正常」的判据是**最近一次审查成功**，不是「进程存活」（进程活着但 `reviews=0` 是假绿）。

**已知边界（如实声明，复审必须修改项 1）**：可见性层是**单点**——角标本身经 CDP 注入，若 ZCode 大版本更新致注入失效（`README.md:151`），则**没有指示器可显示「未知」**，用户回到静默。此时 `/advisor-status` 是唯一出口。**本方案不解决此单点**（无法在无注入通道时凭空造 UI），但如实声明，不假装已缓解。

**改动点**：`hooks/advisor-hook.js`（Stop 写 attempt + worker 写 result）、`tools/companion/controller.cjs`（`/api/health`）、`tools/companion/inject.js`（轮询 + 着色 + 未知态）。

---

### M2. 意见可见性（浮窗）—— ❌ 已砍（用户决定）

**裁决（2026-10-02）**：**不做**。M0 结论（通道用户不可见）原本指向「浮窗是必要通道」，但用户明确表示「具体的顾问返回的消息其实可以不显示」，只关心**健康态**。故 M2 整体砍掉，省去浮窗组件与 history 差分轮询。

**保留的次要项**：`llm_*` 失败写入 history（原 M2 的副作用需求）仍并入 M1——它让 badge 历史面板能反映失败，成本极小。

> 原设计留档（不再实施）：badge 轮询 `/api/history`，发现新 `queued` 条目 → 顶部浮现小窗。需排除 `delivered` 空条目、带 sessionId 标注。

---

### M3. 模型能力探针

**目标**：让用户知道「某模型能否**按时按标准**返回建议」。

**核心裁决**（本质追问者 + 逻辑对抗者一致）：**做探针，不做持久「可用」标记**。

**为什么「持久标记」不成立**：
1. 可用性是**概率/分布属性**，不是布尔。n=3 全过时，95% 置信下失败率上界约 **63%**（p=0.8 时 3 次全过概率 51%）。要证「失败率<20%」需 n≈14。
2. 模型会漂移 → 持久标记 = **虚假确定性**（比没标记更坏）。
3. 只记 `model` 会**双向误判**（hy4 在 4096 坏、8192 可能好；端点/key 变了标记失效）。
4. **无明确消费者**：给人看 = `/advisor-status` 的过期副本；给代码看 = fallback 的马甲。

**探针设计**：
- 用**生产参数**：真实 `cfg.maxTokens` + `DEFAULT_SYSTEM_PROMPT` + 代表性 delta（非 `'ping'`）。
- **默认 N=5**，可配。**N 的诚实说明（复审必须修改项 1）**：N 取小**只为省时，不为下判决**。按文档自己的统计，N=5 全过时失败率上界仍约 **45%**（`1-0.05^(1/5)`），要证「失败率<20%」需 n≈14。因此**探针的输出必须是分布与通过率，而非「可用/不可用」判决**——N 只决定采样成本，不决定结论强度。若要下强判决，用户须显式加 `--n 15`。
- **判定「按标准」的最小充分集**（全有代码依据）：
  1. text 非空
  2. `parseFrame(text) !== null`
  3. `severity ∈ {none,nit,concern,blocker}`
  4. `severity !== 'none'` 时 note 非空
  5. note 未被截断（截断 = 模型失控信号）
  6. **帧来自 JSON 而非 `proseFallback`**（`salvageProse` 一律返回 nit，`reviewer.js:122` → 永远走救回 = 永不产出 concern/blocker，是隐性降级）
- **输出**：`N 次通过 M/N，耗时 min/median/p90，失败分类`。**绝不输出「可用」**。

**判据 5/6 的实现方式（复审建议项 4）**：`parseFrame` 当前**不暴露来源**（只返回 `{severity, note}`），无法区分「真帧 nit」与「救回 nit」；截断检测若靠「以 `…` 结尾」会误伤合法 note。实现时需让探针**不走 `parseFrame` 的高层封装**，直接调 `JSON.parse` + `normalizeFrame` 判定来源，或给 `parseFrame` 加可选 `provenance` 返回。这是实现期的一个明确小改造，不是「现成可用」。

**范围界定（顾问 nit 采纳——表述对齐）**：

现有 ping 有**三处独立实现**，本方案**不全部统一**：

| 位置 | 现状 | 本方案处置 |
| --- | --- | --- |
| `ctl doctor --ping`（`hooks/advisor-hook.js:1072-1082`） | maxTokens=1，空响应判 OK | **改造为 `--probe`**（MVP 唯一改动点） |
| `tools/setup-server.js:292-294` | 同上 | **后续**（复用探针逻辑），本方案不改 |
| `tools/companion/controller.cjs:545` | 只看 HTTP 状态 | **后续**，本方案不改 |

> 即：**MVP 改动集中在 `ctlDoctor`**；「三处统一」是**后续项**，不在本期范围。二者是两件事，先前表述有歧义，此处对齐。

**⚠️ 已知遗留缺陷（复审必须修改项 5，如实声明）**：`setup-server` 与 `controller` 的 ping **本期不修，仍会对思考型模型烧预算故障误报 OK**。用户从**配置面板**点 Ping 仍会被骗（而面板 Ping 恰恰是最常用的入口，`commands/advisor-setup.md:31` 就引导用户用它验证候选模型）。**本方案的 `--probe` 是 CLI 入口，对面板用户零收益**。此缺陷已列入 §5 风险表。

**为什么探针值得做**：它同时修掉现有 ping 的**误报**——现 ping 对思考型模型烧预算故障会判 OK（`!res.error || res.error==='llm_empty_response'`），正是本次故障的误报源。

**改动点**：`hooks/advisor-hook.js`（`ctlDoctor` 增 `--probe`）、`test/`（新增探针用例，stub fetch 覆盖「空 content → 失败」）。

---

### M4. 降级（fallback）——四件套

**目标**：满足「主 model 出问题时也能临时用其他模型让顾问继续生效」。

**用户诉求合理，但朴素实现会掩盖故障**（fallback 成功会清零 `failStreak`，`advisor-hook.js:778` → 告警永不触发）。必须同时满足四条硬约束：

**① 白名单触发**（只对「换模型能治」的错切换）

| 错误码 | 触发 | 理由 |
| --- | --- | --- |
| `llm_empty_response` | ✅ | 模型烧预算，换模型可治 |
| `unparsed` | ✅ | 格式不稳，换模型可治 |
| `llm_http_404` | ✅ | model id 无效 |
| `llm_http_401/403` | ❌ | key 问题，换模型无效 |
| `llm_http_429` | ❌ | 限流，换模型加剧 |
| `llm_http_5xx` | ❌ | 端点故障 |
| `llm_timeout` | ❌ | 端点慢 |
| `llm_error` / `no_transcript` / `parse_empty` / busy 家族 | ❌ | 与模型无关 |

**② 共享 deadline + 预留子预算**（后端对抗者致命项）

- 若 fallback 重起计时：最坏 4T > 锁 `staleMs`(2T+60s) → **击穿不变量、双开 worker、状态互相覆盖**（`advisor-hook.js:214-215`）。
- 若纯共享：主模型烧满预算后 fallback 拿不到剩余（`reviewer.js:266`）→ **最需要它时失效**。
- 解：总预算 B 切为 `primaryDeadline = now + (B - reserve)`、`overallDeadline = now + B`。

**⚠️ 模式限定（复审必须修改项 2，原文档算术有误）**：`reviewTurn` 同时被 **sync**（`advisor-hook.js:574`）与 **async**（`:758`）调用，而 `reviewBudgetMs` = sync 下 `T`、async 下 `2T`（`:216-218`）。所以：

| 模式 | B | reserve | primary 保留 | 结论 |
| --- | --- | --- | --- | --- |
| async | 2T=480s | 120s | 1.5T=360s | ✅ 可接受 |
| sync | T=240s | 120s | **0.5T=120s** | ❌ primary 被砍半，不可接受 |

**决策：M4 降级仅支持 async 模式**（sync 下 `reviewMode==='sync'` 时禁用 fallback 并记 `fallback_skipped:sync_mode`）。理由：sync 单轮受 Stop 硬超时 320s 约束（`config.js:9`），再切预算会复活「强杀→指针不推进→每轮重审」停滞循环（`config.js:298-303` 已记录该教训）。

**reserve 的取值依据（复审必须修改项 3）**：`reserve = min(T, max(30s, T/2))` 中 T/2 原为拍脑袋。修正为：**reserve 必须 ≥ fallbackModel 的实测 p90 延迟**。实测数据：`glm-5.3-flash` 单次 6~12s（够），但思考型模型可达 95s+。因此：
- **约束：`fallbackModel` 应为快模型/非思考型**，并在配置文档中明确写出。若用户配了思考型 fallback，120s 预算下它可能来不及返回（95s 仅剩 25s 余量，且 `callReviewer` 的 429/5xx 重试会耗尽剩余 → `llm_timeout`）。
- 或：允许 `reserve` 可配（默认 T/2），让用户在「慢 fallback」场景下自行加大。

**改造点（复审必须修改项 2）**：`reviewTurn` 内的 `deadline` 当前是**单变量**，同时喂给首调用与空响应重试循环（`advisor-hook.js:228-263`）。双 deadline 改造后，**primary 的空响应重试必须共享 `primaryDeadline`**（而非 `overallDeadline`），否则重试会吃掉 fallback 的预留。

**③ 双 streak 分离**（不得掩盖故障）
- 新增 `primaryFailStreak`：只记「触发 fallback 的主模型失败」。
- fallback 成功：清 `failStreak`（系统可用），**不清 `primaryFailStreak`**；记 `fallbackUsed++`。
- 降级告警走**独立阶梯**（`degradeNotifiedAt` / `degradeAlertCount`），并**禁止**在 `primaryFailStreak` 达阈值时输出「已恢复」。

> **⚠️ 循环依赖（复审必须修改项 5）**：降级告警的可见性依赖 M0（additionalContext 是否可见）与 M1（黄灯，依赖 CDP）。若两者都失效，fallback 成功即**完全静默地掩盖主模型劣化**。**兜底**：降级事件必须**同时写 `advisor-history.jsonl`**（`event:'degraded'`, `primaryModel`, `fallbackModel`），使 `/advisor-status` 与 badge 历史面板可回看——这是唯一不依赖「实时推送通道」的持久记录。**此项为 M4 的必做项，不是可选。**

**M3 的「持久」与 M4 的「持久」不是一回事（复审澄清）**：M3 拒绝的是**对模型可用性的布尔判决**（易变属性的持久化）；M4 持久化的是**用户偏好 `fallbackModel`**（用户显式设置，不随模型漂移失效）。两者不矛盾。

**④ 凭据继承硬边界**
- **MVP 只换 model id**，端点/key 沿用同一 effective pair（防密钥交叉，`config.js:137-143` 既有纪律）。
- 会话级 `/advisor-api` 覆盖了 baseUrl 且无 `sessionFallbackModel` 时 → **跳过 fallback** 并记 `fallback_skipped:session_endpoint`。

**新增 state 字段**：`primaryFailStreak`、`fallbackUsed`、`fallbackLastAt`、`fallbackLastModel`、`degradeNotifiedAt`、`degradeAlertCount`、`sessionFallbackModel`。

**配置**：`fallbackModel: ''`（默认空 = 关闭）加进 `DEFAULTS`；**不新增 config 写路径**（会话级写 state，全局走面板/手改）。

**改动点**：`hooks/lib/config.js`、`hooks/lib/state.js`、`hooks/advisor-hook.js`（`reviewTurn` 双 deadline + 两个调用点 + 双 streak + UPS 降级告警 + status）、`commands/advisor-model.md`、`test/`。约 250 行（含测试）。

---

## 4. 优先级与依赖

| 顺序 | 模块 | 依赖 | 理由 |
| --- | --- | --- | --- |
| **1** | **M0 受控验证** | 无 | 10 分钟，决定 M2 形态；**不验证就做等于重蹈首轮覆辙** |
| 2 | **M1 健康信标 + 三色态** | 无 | 直接满足诉求 1、3；**且是 M4 安全的前提**（看得见降级，fallback 才不掩盖） |
| 3 | **M3 能力探针** | 无 | 修掉 CLI ping 误报；独立、低风险 |
| 4 | **M2 意见浮窗** | M0 结论（定形态） | 依赖可见性事实 |
| 5 | **M4 降级四件套** | M1（可见性）+ 仅 async | 最贵、风险最高，且必须在可见性之后才安全 |

**关键联动**：**可见性（M1）是降级（M4）安全的前提**。若你能可靠看到「现在是备用模型在干活」（黄灯 + history 记录），fallback 就不会变成掩盖。

**M1 阶段黄灯不可达（复审必须修改项 6，如实声明）**：`degraded`（黄）语义依赖 M4 的 `fallbackUsed`，而 M4 最后做且默认关闭。因此 **M1 上线后黄灯是预留态（死代码），实际只有绿/红/灰三态**，直到 M4 落地。

---

## 5. 风险清单

| 风险 | 分级 | 缓解 |
| --- | --- | --- |
| 指示器自身失效（CDP 随 ZCode 更新挂掉）→ 无指示器可显示「未知」 | P0 | **如实声明为单点未解**（§3 M1 已知边界）；信标陈旧显示「未知」；`/advisor-status` 兜底 |
| worker 崩溃/审查未跑成 → 信标停在最后一次绿 | P0 | **双时间戳**（`lastAttemptAt` 由 Stop 父进程写 + `lastSuccessAt` 由 worker 写）+ 状态机（§3 M1） |
| fallback 成功清零 failStreak → 主模型劣化永久静默 | P0 | 双 streak 分离（M4③）+ **降级事件写 history**（兜底，不依赖实时通道） |
| fallback 重起 deadline → 双开 worker | P0 | 共享 deadline + 子预算（M4②），仅 async |
| 降级告警的可见性依赖未验证通道（M0/M1） | P1 | history 持久记录兜底（M4③）；`/advisor-status` 可回看 |
| **面板 Ping / 安装器 Ping 仍会误报 OK**（用户从面板点 Ping 仍被骗） | P1 | **本期不修，如实声明**（§3 M3）；`--probe` 仅 CLI 入口；后续统一三处 |
| 探针「测过就没问题」的虚假信心 | P1 | 输出 N/中位数/p90/失败分类，绝不写「可用」；N=5 的统计局限已声明 |
| fallback 配了思考型模型 → 120s 预算不够 | P1 | 约束 fallbackModel 应为快模型（M4②）；reserve 可配 |
| 红灯粒度与多会话不匹配 | P1 | 信标按会话分文件；UI 标注来源 sessionId，**不假装知道「当前会话」** |
| 全局 fallbackModel × 会话端点覆盖 = 凭据交叉 | P1 | model-only + 跳过规则（M4④） |
| `llm_*` 失败不进 history → 面板看不到 | P2 | 补 `appendHistory`（并入 M1） |
| 告警文案硬编码「检查 key/端点」误导 | P2 | 改 reason 驱动（复用 `advisor-hook.js:899-905` 映射） |
| 三套展示口径（注入/面板/浮窗）漂移 | P2 | 统一以 history 为数据源 |

---

## 5.1 证据快照（复审建议项 7——防证据随时间不可复核）

> 以下为 2026-10-02 实测快照，随 `pruneStates`（7 天/50 个）与 history 裁剪会失效，故固化于此。

**告警从未触发**（`~/.zcode/cli/plugins/data/zcode-advisor@zcode-advisor-local/state/sess-*.json`，11 个会话，实测于 2026-10-02 22:0x）：

```
sess_111976c6 alertCount=0 notifiedAt=""
sess_27b1d512 alertCount=0 notifiedAt=""
sess_34e02de3 alertCount=0 notifiedAt=""
sess_3b44ddcd alertCount=0 notifiedAt=""
sess_793e6f9a alertCount=0 notifiedAt=""
sess_8721f3fe alertCount=0 notifiedAt=""
sess_94b943ec alertCount=0 notifiedAt=""
sess_9d9f8d70 alertCount=0 notifiedAt=""
sess_b49b3eb4 alertCount=0 notifiedAt=""
sess_c499bd2f alertCount=0 notifiedAt=""
sess_cb5c07f8 alertCount=0 notifiedAt=""
```

**意见确实投递过**（`~/.zcode/advisor-history.jsonl`，77 行）：

```json
{"ts":"2026-10-02T09:58:09.790Z","event":"queued","severity":"nit","note":"56.7s 与 39.4s 的耗时对比仅单次样本…","sessionId":"sess_3b44ddcd-…","mode":"async"}
{"ts":"2026-10-02T10:00:12.218Z","event":"delivered","count":1,"sessionId":"sess_3b44ddcd-…","mode":"async"}
```

**failStreak 轨迹**（`~/.zcode/advisor-healthcheck/history.jsonl`，sess_793e6f9a）：

```
2026-10-02T08:42Z failStreak={reason:unparsed,count:1}
2026-10-02T09:42Z failStreak={reason:unparsed,count:2}
2026-10-02T10:00Z failStreak={reason:unparsed,count:3}   ← 达阈值，但 alertCount 仍为 0
2026-10-02T10:22Z failStreak=null                         ← 换模型后恢复
```

**模型探针实测**（2026-10-02，glm-5.3-flash，maxTokens=4096，6930 字符输入）：

```
#1: 11596ms OK/blocker | #2: 10736ms OK/blocker | #3: 6489ms OK/blocker
```

---

## 6. 验收标准

| 模块 | 验收 |
| --- | --- |
| M0 | ✅ 已完成：`[TEST]` 行对**主模型可见、用户 UI 不可见**（结论见 §3 M0）——这是「顾问太静默」的根因 |
| M1 | ✅ 已实现并通过测试（详见下方「M1 落地记录」）；真机目视验收待用户在装好插件后确认 |
| M2 | ❌ 已砍（用户决定：只关心健康态，意见内容可不显示） |
| M3 | ✅ 已实现并通过测试（详见下方「M3 落地记录」）；对真实端点的 `--probe` 只在探针联调里验证过（返回 401 分类正确） |
| M4 | ✅ 已实现并通过测试（详见下方「M4 落地记录」）；sync 禁用、白名单、双 streak、history 事件、UPS 降级告警均已覆盖 |
| 全局 | ✅ `npm test` 350 项全绿；现有 `test/e2e.test.js` 的 doctor / worker 用例无回归 |

### M1 落地记录（2026-10-02）

**改动的文件**：

| 文件 | 改动 |
| --- | --- |
| `hooks/lib/health.js`（新增） | 信标写读：`writeAttempt`（Stop 父进程）/ `writeResult`（worker/sync）；`mergeBeacon` 读-合并-写（tmp+rename 原子，0600）；`deriveHealth` 四态派生；`staleThresholdMs`；`resolveHealthDir` 尊重 `HEALTH_DIR > STATE_DIR > ~/.zcode` |
| `hooks/advisor-hook.js` | Stop async 侧 spawn 前写 attempt；worker 收尾的 `mutateStateExclusive` 内在 error/success 分支写 result；sync 路径审查前写 attempt、finish 回调内写 result |
| `tools/companion/controller.cjs` | **内联**一份 health 读取 + 派生（发行包不含 `hooks/`，不能 require，同 `readHistory` 先例）；新增 `GET /api/health` |
| `tools/companion/inject.js` | 角标加 `.zca-hdot` 状态灯；`pollHealth()` 首拉 + 每 5s 轮询；四态着色；重建后恢复上次已知态 |
| `test/health.test.js`（新增） | 18 例：路径解析、双时间戳合并、多会话排序、坏文件容错、四态派生、STALE 边界、STATE_DIR 隔离、**controller 与 hooks 行为逐一比对**、HTTP 端到端（403/200/形状） |
| `test/inject.test.js` | 补 7 例健康着色；**修桩**：注入脚本新增 `setInterval`，测试桩未提供导致真实定时器吊住 `node --test` 不退——已在 `new Function` 注入参数里补 `setInterval`/`clearInterval` 桩 |

**核心不变量（测试锁死）**：**只有明确 `state==='ok'` 且 `lastSuccessAt` 新鲜才显绿**；无数据/陈旧/worker 被强杀一律 `unknown` 或 `down`，**代码里不存在「取不到数据即健康」的分支**。

**实测四场景**（`/tmp` 脚本，真实走 hook 入口）：
- A. async worker 被强杀（只写 attempt）→ `down`（attempt 有、success 无）✅
- B. async 全链路成功 → `ok`（reviews=1）✅
- C. sync 模式成功 → `ok`（attempt/success 同进程写）✅
- D. 陈旧信标（3 小时前）→ `unknown` ✅

**坑（已修）**：worker 作用域内写信标误用了 `sessionId`（该作用域只有 `state.sessionId`），导致 async 路径 `ReferenceError: sessionId is not defined`，被 `bumpDrop(worker_error)` 吞掉、e2e 表现为 `byteOffset` 不推进。已改用 `s.sessionId`。

**测试桩坑（已修）**：`inject.js` 新增 `setInterval` 轮询后，`test/inject.test.js` 的 `new Function` 沙箱未提供该全局，真实定时器吊住 `node --test` 不退出。已在注入参数里补 `setInterval`/`clearInterval` 桩。

### M3 落地记录（2026-10-02）

| 文件 | 改动 |
| --- | --- |
| `hooks/lib/reviewer.js` | `parseFrameDetailed`（暴露帧来源 json-direct/json-embedded/prose + 是否截断；`parseFrame` 委托它，行为不变）；`classifyProbeResult`（六条判据）；`probeModel`（生产参数 ×N，输出通过率与 min/median/p90/max + 失败分类）；`renderProbeReport`（按实际 N 算失败率上界，不写死 5）；`PROBE_DELTA`（代表性 delta 而非 `ping`） |
| `hooks/advisor-hook.js` | `ctlDoctor` 接 `--probe [--n N] [--timeout ms]`（`--ping` 保留） |
| `commands/advisor-setup.md`、`README.md` | 配置验证首选 `--probe`；提醒不要替用户下「可用」判决 |

**关键**：探针修掉了旧 ping 的误报——旧 ping 用 `max_tokens=1`，思考型模型把预算全烧在 reasoning 上（content 空、`finish_reason=length`），旧 ping 把 `llm_empty_response` 当正常 → 对烧预算故障判 OK。探针用生产参数，把空响应判为失败。

**测试**：`test/probe.test.js` 15 例；另在 `test/health.test.js` 补 3 条**写读往返**测试（hooks 写的信标 controller 必须读得到、目录解析一致、多会话排序一致）——落实 M1 的 advisor nit（内联重复）。经变异验证（改 beacon 前缀 → 5 例失败）。

### M4 落地记录（2026-10-02）

| 文件 | 改动 |
| --- | --- |
| `hooks/lib/config.js` | `fallbackModel: ''`（默认关闭）+ 环境变量 `ZCODE_ADVISOR_FALLBACK_MODEL` |
| `hooks/lib/state.js` | `freshState` 增 `primaryFailStreak`/`fallbackUsed`/`fallbackLastAt`/`fallbackLastModel`/`degradeNotifiedAt`/`degradeAlertCount`/`sessionFallbackModel`；新增 `bumpPrimaryFailStreak` |
| `hooks/advisor-hook.js` | `reviewTurn` 重构：`runAttempt`（把解析纳入单次尝试，使 `unparsed` 也能触发降级）+ 双 deadline（`primaryDeadline = overall - reserve`，`reserve = min(T, max(30s, T/2))`）+ 白名单触发；`fallbackEligibility`/`fallbackReserveMs`/`resolveFallbackModel`；`applyReviewOutcome`（sync/async 共用的结果落盘：双 streak + history）；`degradeAlertLine`；UPS 加独立降级告警阶梯；`ctl status` 展示备用模型与主模型连败；`ctl api set` 支持 `fallback:<id>` |
| `README.md`、`advisor.config.example.json`、`commands/advisor-api.md` | 配置项与命令说明 |

**四条硬约束的落实**：
1. **白名单触发**：`FALLBACK_TRIGGER_REASONS = {llm_empty_response, unparsed, llm_http_404}`；401/403/429/5xx/timeout/与模型无关的错误一律不切。
2. **双 deadline（仅 async）**：总预算 B 切为 primary（含预留）与 overall；备用只吃预留。sync 下 `fallbackEligibility` 直接禁用（切预算会砍半 primary，且复活停滞循环）。
3. **双 streak 分离**：fallback 成功清 `failStreak`（系统可用）但**不清 `primaryFailStreak`**——这是「不静默掩盖」的核心；降级告警走独立阶梯。
4. **凭据边界**：只换 model id；会话覆盖了 baseUrl 时跳过（`fallback_skipped:session_endpoint`）。

**必做兜底**：降级成功**同时写 `advisor-history.jsonl` 的 `degraded` 事件**（不依赖 additionalContext/角标这两个可能失效的通道）。

**测试**：`test/fallback.test.js` 23 例（资格判定、主败备成、白名单边界、双败、sync 禁用、预算预留、结果落盘的双 streak/history）；`test/e2e.test.js` 补 4 例 UPS 降级告警（含「停摆优先、不叠加」与旧 state 形状兼容）。经变异验证（去掉 primaryFailStreak 保留 → 2 例失败）。

**⚠️ e2e 网络限制（环境）**：本机沙箱里 `spawnSync` 子进程无法访问父进程起的本地 HTTP 服务（in-process fetch 正常、spawned 挂起），故 M4 的端到端改用**结果落盘（`applyReviewOutcome`）+ UPS 告警**两层直接验证，`reviewTurn` 的调用序列由注入式 caller 覆盖（真实端到端留待真机联调）。

---

## 7. 明确不做（砍掉）

- ❌ **持久「模型可用」标记**（M3 只做探针）——理由见 M3。
- ❌ **静默 fallback**（M4 必须带降级告警，不得掩盖）。
- ❌ **实时「审查中」spinner**（async 下 Stop 立即返回、worker detached 无回写通道，`advisor-hook.js:485-502`，做了也是假状态）。
- ❌ **装饰性状态动效**（与「健康时保持安静」纪律冲突）。
- ❌ **跨 provider fallback**（MVP 只换 model id）。
- ❌ **本期统一三处 ping**（MVP 只改 `ctlDoctor`，其余列后续）。
- ❌ **往用户手写的 `advisor.config.json` 塞标记**（污染配置 + 撞写锁协议）。

---

## 8. 待办清单（可执行）

1. **M0**：✅ 已完成（结论见 §3 M0）。
2. **M1**：✅ 已完成（详见「M1 落地记录」）。
3. **M3**：✅ 已完成（详见「M3 落地记录」）。
4. **M2**：❌ 已砍（用户决定）。
5. **M4**：✅ 已完成（详见「M4 落地记录」）。
6. 收尾（未做）：补 `appendHistory` 记 `llm_*` 失败；告警文案改 reason 驱动；**（后续）** 统一 setup-server / controller 的 ping 为探针。

---

## 9. 变更历史

| 日期 | 变更 |
| --- | --- |
| 2026-10-02 | 初稿：综合两轮 7 位顾问意见，覆盖 M0-M4 |
| 2026-10-02 | 定稿复审：逻辑对抗者复核，落实 6 项阻断 + 7 项改进；固化证据快照 |
| 2026-10-02 | M0 完成（additionalContext 模型可见、用户不可见）；M2 按用户决定砍掉（只保留健康态）；M1 落地并通过 305 项测试 |
| 2026-10-02 | M3 落地（`ctl doctor --probe`，15 例测试）；落实 M1 内联重复的 advisor nit（3 条写读往返一致性测试）；M4 落地（白名单 + 双 deadline[仅 async] + 双 streak + history 兜底 + 降级告警，23+4 例测试）。全量 350 项通过 |
