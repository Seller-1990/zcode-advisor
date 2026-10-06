# 架构速览（ARCHITECTURE）

> 面向 AI 协作者与新维护者：**先读这一份**，再动代码。
> 目的：让审查者/开发者一次建立全貌，避免"只看片段就下判断"——
> 本项目的审查副模型曾因缺少全局认知，多次把设计取舍误判为缺陷。

## 一句话定位

ZCode（z.ai 桌面版）插件：**每轮对话结束时，由一个独立配置的审查模型审查转录增量**，
产出 `nit` / `concern` / `blocker` 三级建议并注回会话。

**核心纪律（不得违反）**：
- **advisory-only**：只建议、绝不代行、绝不冒充主模型；每条意见带 `[advisor:*]` 前缀
- **故障有界**：任何错误只计 `Dropped` 并安静退出（exit 0、无输出），绝不拖垮主会话

## 三个交付形态（职责边界）

```
┌─────────────────────────────────────────────────────────────────┐
│ ① 插件本体（hooks/ + commands/）  ← 审查逻辑，ZCode 插件系统加载   │
│    入口：hooks/advisor-hook.js（三个 host 事件）                  │
│    UI ：无（纯 CLI/事件）                                        │
├─────────────────────────────────────────────────────────────────┤
│ ② 角标外挂（tools/companion/）    ← CDP 注入 ZCode 页面           │
│    入口：controller.cjs（本机进程）；UI：inject.js（顶栏图标+面板）│
│    职责：设置面板、模型列表、Ping、顾问意见记录展示                │
├─────────────────────────────────────────────────────────────────┤
│ ③ 发行包（build-installer.cjs）   ← 打包 ①+② 为免安装 Node 的形态 │
│    产物：win setup.exe / macos dmg / 双平台 zip/tar.gz            │
│    含：内嵌官方 Node + 插件 payload + auto-enable.cjs（自动启用）  │
└─────────────────────────────────────────────────────────────────┘
```

**三者关系**：① 是功能主体；② 是设置与可见性界面（可选）；③ 是分发载体。
**②③ 缺失不影响 ① 工作**（审查照跑，只是没有图形设置入口）。

## 事件生命周期（宿主 → 插件）

```
ZCode 会话创建
  └─ SessionStart ─→ 建/复状态文件（幂等）；注入 [advisor] 注册行（下条消息送达）
       ← 注册行含：模型、模式、脚本路径、状态文件路径、门禁提示

用户发消息
  └─ UserPromptSubmit ─→ ① 送达积压意见（additionalContext）
                         ② 或送达注册行
                         ③ 门禁未满足时给配置提示（命令通道不失联）

本轮结束
  └─ Stop ─→ async 模式（默认）：同步快照转录 → 派 detached review-worker → 立即返回
             sync  模式：内联审查（超时钳制到 300s）
```

### async 与 sync 的关键差异

| | async（默认） | sync |
| --- | --- | --- |
| Stop 返回 | 立即（亚秒级） | 等审查完成 |
| 意见送达时机 | **下一条用户消息**（顺延队列） | concern/blocker 当轮 `decision:block` 打断 |
| nit | 顺延 | 顺延 |
| 失败代价 | 意见延迟一轮 | 每轮收尾等待（超时被钳制） |

## 数据流与状态归属

```
转录（宿主提供）
  │  ⚠️ ZCode 的 transcript_path 是**每轮临时快照**（/var/folders/.../T/zcode-*-hook-*/）
  │     Stop 返回即被清理 —— worker 延后读取必然 no_transcript（实测踩过）
  ▼
Stop 侧：同步 copyFileSync → state/snapshots/<sessionId>.jsonl（0o600，保留最近 N 个）
  ▼
review-worker（detached）
  ├─ readDelta(snapshot, offset, {backfillLimitBytes})
  ├─ renderDelta(entries) → 文本增量
  ├─ callReviewer（OpenAI 兼容 /chat/completions 或 Anthropic /v1/messages）
  └─ parseFrame（JSON 帧优先 → 散文救回三条守门）
       ▼
     route：decideAction / decideActionAsync → nit 队列 | concern/blocker block
       ▼
     mutateStateExclusive（跨进程临界区写：锁 + 重读 + 原子写回）
```

### 状态文件（`state/sess-<session>.json`，schema: 1）

| 字段 | 含义 |
| --- | --- |
| `byteOffset` / `lastHeadHash` | 增量读指针（**快照模式下不使用**——每轮快照独立全量审） |
| `reviews` / `steers` / `deferred` | 审查次数 / 打断次数 / 顺延次数 |
| `pendingNotes` | 顺延队列（下条消息送达） |
| `dropped` / `droppedAt` | 各类丢弃计数 + **最近一次时间**（KD-I3 可见性） |
| `tokensIn` / `tokensOut` | token 累计 |
| `pendingRegistration` / `enabled` | 注册行待送达 / 会话启用状态 |

**写纪律**：所有状态写路径一律走 `mutateStateExclusive`（跨进程短临界区 + 重读最新 + 原子写回），
消除多写者 read-modify-write 丢更新。

## 配置分层（优先级从低到高）

```
内置默认（hooks/lib/config.js DEFAULTS）
  ← 插件目录 advisor.config.json（gitignore，兜底）
  ← 用户级 ~/.zcode/advisor.config.json   ← ①设置表单 ②角标面板 ③网页面板 ④/advisor-setup 都写这里
  ← 环境变量（ZCODE_ADVISOR_*）
```

**hook 每轮重读配置** → 保存后无需重启会话即生效。

### 门禁（gate）

```js
if (!cfg.baseUrl) reasons.push('missing:baseUrl');
if (!cfg.model)   reasons.push('missing:model');
if (!apiKeyInfo.key) reasons.push('missing:apiKey');
```
三项缺任一 → **审查绝不发起**（但注册行与命令通道照常可达，用户能自救）。

## 安全边界

| 面 | 措施 |
| --- | --- |
| 配置文件（含 API key） | 仅 `~/.zcode/`，`advisor.config.json` 在 .gitignore |
| 转录快照 | 目录 `0o700`、文件 `0o600`；文件名经 `sanitizeSessionId`（防路径穿越）；保留窗口 ≥ 并发上限 |
| 意见历史 | 目录 `0o700`、文件 `0o600` |
| 角标面板 API | 仅 127.0.0.1 + 共享令牌（`X-Advisor-Token`，每次启动随机生成） |
| CDP 注入 | 仅监听 127.0.0.1；不改 ZCode 安装目录、不破坏签名 |
| 面板渲染 | 模型产出用 `textContent` 填充，**不当 HTML 注入** |
| 密钥入日志 | 不打印；status 里脱敏显示（`sk-3…9996`） |

## 部署链路（关键：三层缓存）

```
源仓库（仓库根 = 插件本体）
  │  ① node tools/sync-plugin-dir.cjs   ← 同步到市场布局副本
  ▼
plugins/zcode-advisor/                  ← 市场 source 指向它
  │  ② zcode plugins marketplace update  ← 宿主把市场**快照到自己的缓存**
  ▼
~/.zcode/cli/plugins/marketplaces/zcode-advisor-local/   ← 宿主市场缓存副本
  │  ③ zcode plugins install             ← 从市场缓存拷贝
  ▼
~/.zcode/cli/plugins/cache/zcode-advisor-local/zcode-advisor/<ver>/  ← 运行时实际加载
```

**三层任何一层不刷新，都装出旧代码**（实测三次踩过）。
`enable.sh` 与 `auto-enable.cjs` 已按 ①②③ 顺序自动化；`test/plugin-dir.test.js` 守卫 ① 的一致性。

## 测试结构（191 项）

| 文件 | 覆盖 |
| --- | --- |
| `e2e.test.js` | 真实 hook 子进程：三事件契约、快照契约、并发回归、门禁 |
| `inject.test.js` | 页面注入行为（自建 DOM 桩）：样式注入、令牌版本、模型下拉、开关、历史 |
| `archive/packagers/install-templates` | 自研 ZIP/TAR 字节结构、NSIS/DMG 脚本生成、图标编码（经系统工具交叉校验） |
| `config/state/transcript/reviewer-frame/route` | 内核纯函数与临界区 |
| `history/plugin-dir` | 意见历史读写与隔离、插件目录一致性 |

**已知测试局限**：`inject.test.js` 用自建 DOM 桩，类名选择器靠 Map 模拟——
**无法暴露类名写错**（真实 DOM 才能）。因此 UI 改动后必须真机验证（见 docs/INSTALL-CHECK 实验 0）。

## 明确的局限（不是缺陷）

1. **依赖 ZCode 非公开接口**（CDP 注入）——大版本更新可能失效，hook 审查不受影响
2. **transcript 是每轮快照**——因此快照模式为"每轮全量审"而非上游的"只审增量"，多耗 token
3. **Windows 产物未真机安装测试**（CI 只验证编译与产物存在）
4. **`userConfig` 表单**在 ZCode 官方规范中未定义，实测不渲染——设置以角标面板/配置文件为主
5. **并发 worker 上限**（`maxGlobalWorkers`）超限计 `busy` 丢弃，属有界失败设计

## 改动前必读

- **改 hook 逻辑** → 跑 `npm test`（e2e 覆盖三事件契约）
- **改 UI（inject.js）** → 跑测试 + **真机验证**（DOM 桩有覆盖盲区）
- **改插件构成**（增删目录/文件）→ **同步 `sync-plugin-dir.cjs` 的 ITEMS**，否则副本漏文件
- **改版本号** → `node tools/companion/bump-version.cjs 0.2.21`（**不要手改**）。
  版本号散落四处（根 `package.json`、根 `.zcode-plugin/plugin.json`、以及
  `plugins/zcode-advisor/` 下的同名两份），必须同值：宿主只认版本号来决定「要不要重装」，
  只提其中两份会装出**「版本号新、内容旧」**的插件，此后 auto-enable 的版本比较
  永远判「已装 == 包内 → 就绪」，新代码再也进不了宿主 cache（用户现象：「修了没生效」）。
  `test/plugin-dir.test.js` 有守卫，四处不一致时 `npm test` 直接失败。
  （构建期读版本的单一来源仍是根 `.zcode-plugin/plugin.json`——那只是构建脚本的入口，
  不等于「只需改它」。）
- **改配置键** → 同步 `advisor.config.example.json` 与 README 配置表
