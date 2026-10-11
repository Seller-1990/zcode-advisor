# 批次六报告 —— R24：写锁陈旧判定只看 mtime，崩溃残留锁造成约 10s 的「静默丢写」窗口

> 本批起因是追查批次五未定位的 M2（macos-15 runner 上 e2e 偶发 20s 超时），
> 在写锁协议里发现并证明了一个**产品代码**缺陷 R24。批次五是纯测试修复，本批是产品修复。
> 推送前按顾问提示补做 **R24c**（存活判定的 errno 完备性，见 §三 R24c）——
> 本批推送的核心验证对象正是 `process.kill(pid, 0)` 的三平台真机语义。
> 冻结报告 `.audit-evidence/audit-report.md` 未改动：sha256 实测仍为
> `8ccedbf346350c5c1f8480d06366df04dd76b99123b2115238077f2b133067e0`。

## 一、范围与纪律

- 起点：批次五把 CI 三平台跑绿（run 38123718881），但 M2 的根因仍未定位 —— 首跑 macos-15 上
  `test/e2e.test.js:369`「审查在飞时 /advisor-off 不被 worker 旧快照回滚」等满 20358ms 判红，
  第二跑同机 6163ms 通过。为定位它，重新实读了 worker 的落盘路径
  （`hooks/advisor-hook.js:1062`）与其底下的跨进程写锁协议（`hooks/lib/state.js`）。
- 读到的第一件事就是：**所有状态写都走 `mutateStateExclusive` → `withExclusiveLock`**，
  而该协议的陈旧判定只看 mtime。顺着这条线做出 R24。
- 纪律照旧：探针实证机制 → 落红用例 → 修 → 转绿 → 关联回归 → 镜像同步 → 全量回归。

## 二、结论摘要表

| 项 | 机制 | 探针实测（修复前） | 修复 | 证据 |
| --- | --- | --- | --- | --- |
| **R24** | `withExclusiveLock` 的陈旧判定只有「mtime 超 `staleMs`(默认 10000)」，而重试预算只有 `retries(40) × 25ms ≈ 1s` ⇒ 崩溃/被 KILL 的持锁者残留的 `${file}.wrlock` 会把随后约 10s 内**所有**状态写挡成 `null` | 属主已死（真子进程刚退出）+ mtime 年龄 0ms → **1140ms 后返回 null、状态文件未变（写入丢失）、锁残留** | 陈旧判定加「**属主进程已死**」（`process.kill(pid,0)`）；只回收「别人的、已死的」锁；删前重读属主；空/非数字内容不参与存活判定 | 红 `.audit-evidence/r24-red.log`（4 / pass 3 / fail 1）→ 绿 `.audit-evidence/r24-green.log`（4 / 4）；探针 `.audit-evidence/r24-probe.log` → `r24-probe-post.log`（1140ms 丢写 → **26ms** 回收并写入） |
| **R24c** | 上面的存活判定「只认 `EPERM` 算活」：libuv 在 Windows 把 access denied 映射成 **`EACCES`**，只认 EPERM 会把「活着但无权 signal」的属主判成**已死** ⇒ 回收活锁 ⇒ 双写者（正是 R24 要防的方向）。同一写法另有三份拷贝：`tools/config-bridge.js:132`、`tools/companion/controller.cjs:311`（`isStale`）与 `:864`（`withConfigLock`）、`tools/companion/auto-enable.cjs:153` | 注入 errno 实测：`EPERM` → 活（对）；`EACCES` / `EINVAL` / 未知 → **判死（错）**。本机 macOS 无法自然产生 `EACCES`（pid 1 给的是 `EPERM`），所以只能注入验证 | 五处统一改为「**只有 `ESRCH` 算已死，其余 errno 一律算活**」（判活最多多等一次 mtime 兜底；判死才是不可逆方向） | 红 `.audit-evidence/r24c-red.log`（20 / pass 18 / fail 2：`errno=EACCES 必须保守判为「活着」`、`hooks/lib/state.js 的存活判定必须「只有 ESRCH 算已死」）→ 绿 `.audit-evidence/r24c-green.log`（20 / 20）；关联回归 `.audit-evidence/r24c-regression.log`（123 / 123） |

## 三、逐项机制 · 修复 · 证据

### R24 · 写锁：1s 重试预算 vs 10s 陈旧判定

修复前的判定（`hooks/lib/state.js` `withExclusiveLock`）：

```js
} catch (_) {
  try {
    const st = fs.statSync(lockFile);
    if (Date.now() - st.mtimeMs > staleMs) {      // 只看 mtime，staleMs 默认 10000
      try { fs.unlinkSync(lockFile); } catch (_) {}
    }
  } catch (_) {}
  sleepSync(25);                                   // 重试预算 retries(40) × 25ms ≈ 1s
}
```

两条规则的**量级不匹配**就是缺陷本体：陈旧判定要 10s，重试预算只有 1s。于是任何持锁者
崩溃/被 KILL（Ctrl-C、编辑器杀进程、`taskkill`、`pkill node`、OOM）留下的锁文件，
在随后约 10 秒内会让**每一次**状态写都以 `null` 返回 —— 而不是短暂竞争。

探针 `.audit-evidence/r24-probe.cjs`（三场景，实测输出见 `.audit-evidence/r24-probe.log`）：

| 场景 | 锁内容 / mtime | 修复前 | 修复后（`r24-probe-post.log`） |
| --- | --- | --- | --- |
| A 属主已死 | 真子进程刚退出（pid 96853，alive=false）/ mtime 年龄 0ms | **1140ms → null，`lastAction` 仍是 `initial`（写入丢失），锁残留** | **26ms → state，写入成功，锁已释放** |
| B 活属主 | 自己 pid / mtime 新鲜 | null，锁未被删（正确：不得抢活属主） | null，锁未被删（不变） |
| C 陈旧 | 自己 pid / mtime 拨老 30s | 29ms → 回收并写入成功（正确） | 26ms → 回收并写入成功（不变） |

**为什么后果不是「小概率」而是「必然丢」**：`withExclusiveLock` 的注释写明「拿不到锁返回 null，
由调用方降级」，而 worker 的最终落盘 `hooks/advisor-hook.js:1062` **忽略返回值**：

```js
mutateStateExclusive(file, (s) => {
  ...
  s.reviews = (s.reviews || 0) + 1;
  applyReviewOutcome(s, result, eff, cfg);   // ← 含 bumpDrop(s, result.error)
  ...
  if (result.error) { beaconPayload = { ... reason: result.error ... }; return; }   // 信标载荷在临界区内赋值
});
```

锁没拿到 ⇒ `fn` 不执行 ⇒ `beaconPayload` 恒为 `null` ⇒ 末尾 `if (beaconPayload)`（`:1110`）
也不写健康信标。也就是说：**一次已经花掉模型调用、已经跑完的审查，其结果与健康信标一起消失**，
而代码在 `applyReviewOutcome` 上方自称这段是「M4『不得静默掩盖』的核心不变量所在」。
同一条协议还承载：丢写计数（`dropped.*`）、`disabledReason`、`pendingNotes` 队列推进、
`reviews` 计数、`lastActivity` —— 崩溃残留锁期间这些全部不落盘。

修复（`hooks/lib/state.js`）：

- 新增 `lockOwnerAlive(pid)`（:210）：`process.kill(pid, 0)` 不抛 ⇒ 活着；抛 `EPERM` ⇒ 进程存在
  但不属于我们 ⇒ 也算活着；`ESRCH`/非法 ⇒ 已死。
- 新增 `readLockOwner(lockFile)`（:217）：只认**纯数字**内容。`fs.writeFileSync(lock, pid, {flag:'wx'})`
  是「先 O_CREAT 再写内容」，中间存在极短的空内容窗口 —— 此刻若按「无属主=已死」回收，
  会把活持有者刚建的锁删掉，双写者复活。空/非数字一律返回 `null`，交给 mtime 规则。
- `withExclusiveLock`（:231）的陈旧判定改为「mtime 超 `staleMs` **或** 属主已死」，且只回收
  「**别人的、已死的**」锁（`owner !== process.pid`，避免与重入调用打架）；删除前重读一次属主并比对，
  防止把刚接管者的新锁删掉。属主存活时不抢 —— 「慢持有者按 mtime 被抢后靠 `ownLock()` 放弃写入」
  的原语义完整保留（C 场景不变）。

**与 M2 的关系（如实）**：R24 是 M2 的**候选机制** —— worker 跑完审查后落盘被残留锁挡住，
`dropped.llm_timeout` 永不落盘，e2e 的 `waitUntil(dropped.llm_timeout === 1, 20000)` 就会等满 20s
（首跑 20358ms 正好是 20s 预算耗尽）。但本批**没有证明**这条因果：需要一次复现时由批次五埋好的
现场诊断（`dropped=… / lock=… / stateDir=[…] / stop.stderr=…`）来确认。因此 M2 仍登记为未定位偶发。

**附带收益（已对闸门路径单独实测，非推断）**：`admitGlobalWorker`（:318）的 stateDir 级准入闸门
`.global-workers.lock` 走的是**同一个** `withExclusiveLock`，而该函数创建锁时恒写属主 pid
（`hooks/lib/state.js:238` `fs.writeFileSync(lockFile, myPid, { flag: 'wx' })`，不存在「只抢建、不写内容」的分支），
所以死属主回收对它同样成立。实测（`.audit-evidence/r24b-gate-probe.cjs` → `.audit-evidence/r24b-gate-probe.log`）：
子进程持锁时 `process.exit(0)`（`process.exit` 不展开栈，`finally` 不执行）留下的残留闸门，
内容 = `"6577"`（纯数字 pid ✓）；pre-fix 快照（`.audit-evidence/r24-snapshot/state.js`，取自 git HEAD，
sha256 `6fdde640c9e00108379c505bbebed45fa5a2e4fcc8f11ffbe4008bb8bb187f80`）对它是
**返回 null / 1196ms / 锁仍在**；post-fix 是 **返回 `"ok"` / 32ms / 锁已释放**；
真实路径 `admitGlobalWorker(limit=1)` **返回 `"ok"` / 31ms**。

措辞精确化（避免夸大）：收益**不是**「闸门返回 ok 更快」—— 兜底分支同样返回 ok；而是
「这约 10s 内闸门真正生效」。pre-fix 时闸门取不到 ⇒ `admitGlobalWorker` 退回「先数后取」兜底路径
（即 R04 修掉的那条不安全路径）**静默复活约 10s**；post-fix 时闸门在 32ms 内回收，兜底分支不再被触发。
其兜底分支本身不变（真·并发竞争时仍会走它）。

### R24c · 存活判定的 errno 完备性（推送前补强）

R24 引入的 `lockOwnerAlive` 第一版是「只认 `EPERM` 算活」：

```js
function lockOwnerAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return Boolean(err) && err.code === 'EPERM'; }
}
```

macOS 上这没问题（本机实测：已退出的 pid → `ESRCH`；root 的 pid 1 → `EPERM`）。但 libuv 在
Windows 上把 access denied 映射为 **`EACCES`**，于是「活着但无权 signal」的属主会被判成已死
⇒ 回收活锁 ⇒ 双写者（正是 R24 要防的方向）。同一个「只认 EPERM」的写法在仓库里另有三份拷贝
（`tools/config-bridge.js`、`tools/companion/controller.cjs` 两处、`tools/companion/auto-enable.cjs`），
它们同样站在「判错不可逆」的那一侧（`if (!alive || stale) unlink(lock)` / `isStale → 接管`）。

判定方向的不对称性决定取舍：判「活」错了最多多等一次 mtime 兜底（`staleMs` 10s）；
判「死」错了会删掉活持有者的锁。故五处统一为「**只有 `ESRCH` 算已死**」：

```js
// 只有 ESRCH 算已死；EPERM/EACCES/EINVAL/未知一律算活
catch (err) { return Boolean(err) && err.code !== 'ESRCH'; }
```

改动点：`hooks/lib/state.js:209-214`（`lockOwnerAlive`）、`tools/config-bridge.js:134`、
`tools/companion/controller.cjs:312`（`isStale`）与 `:867`（`withConfigLock`）、
`tools/companion/auto-enable.cjs:154`（`isStale`，其原注释还写着「errno 语义（实测）」，
只覆盖了 macOS 的 EPERM，已更正）。另把 `lockOwnerAlive` / `readLockOwner` 加入
`hooks/lib/state.js` 的 `module.exports`，让用例能直接钉死规则。

证据与本地观测（`.audit-evidence/r24c-*.log`）：

- 红灯 `.audit-evidence/r24c-red.log` → `tests 20 / pass 18 / fail 2`，两条断言原文：
  `errno=EACCES 必须保守判为「活着」（判成死会删掉活持有者的锁 → 双写者）`、
  `hooks/lib/state.js 的存活判定必须「只有 ESRCH 算已死」`。
- 绿灯 `.audit-evidence/r24c-green.log` → `tests 20 / pass 20 / fail 0`。
- 本机观测行（会原样进入 CI 日志，作为三平台真机证据）：
  `[R24c 观测] darwin 已退出 pid=47119 kill(pid,0) errno=ESRCH`、
  `[R24c 观测] darwin pid=1（无权 open）kill(pid,0) errno=EPERM`。
- 关联回归 `.audit-evidence/r24c-regression.log` → `tests 123 / pass 123 / fail 0`
  （auto-enable×5、companion-boundaries、companion-lock、config、lock-alive-errno、state、
  state-ensure-race、state-wrlock-stale、static-guards）。
- 新增用例 `test/lock-alive-errno.test.js`（96 行，3 条）：注入 errno 钉死规则；真·活子进程必须判活、
  真·已退出 pid 按**实测** errno 处理（若不是 `ESRCH`，打印披露行而不是硬断言）；**无权 signal 的活进程
  （POSIX pid 1 / Windows pid 4）必须判活，且它持有的新鲜写锁不得被回收、状态文件不得被改动**。
- 新增静态门禁（`test/static-guards.test.js`）：上述四处文件必须含 `!== 'ESRCH'`、且不得退回
  `code === 'EPERM'`（拦住「只改一处」与日后回退）。

Windows 真机行为待 CI 确认（见 §六 局限 4）：本机只能证明规则本身与 macOS 观测，
`EACCES` 分支靠注入用例覆盖。

## 四、红 → 绿证据索引（全文唯一来源）

| 项 | 红灯（失败） | 绿灯（通过） |
| --- | --- | --- |
| R24 | `.audit-evidence/r24-red.log` exit=1、`tests 4 / pass 3 / fail 1`，断言原文 `属主 pid 97276 已死的残留写锁必须被回收并完成写入，实际返回 null（本次写入被静默丢弃）`；机制级红灯 `.audit-evidence/r24-probe.log`（1140ms 后返回 null、状态文件未变） | `.audit-evidence/r24-green.log` exit=0、`tests 4 / pass 4 / fail 0`（死属主用例 195.5ms 完成）；机制级绿灯 `.audit-evidence/r24-probe-post.log`（26ms 回收 + 写入成功 + 锁释放） |
| R24c | `.audit-evidence/r24c-red.log` exit=1、`tests 20 / pass 18 / fail 2`，断言原文 `errno=EACCES 必须保守判为「活着」（判成死会删掉活持有者的锁 → 双写者）`、`hooks/lib/state.js 的存活判定必须「只有 ESRCH 算已死」` | `.audit-evidence/r24c-green.log` exit=0、`tests 20 / pass 20 / fail 0 / duration 1573.15ms`；本机观测行 `[R24c 观测] darwin 已退出 pid=47119 kill(pid,0) errno=ESRCH`、`[R24c 观测] darwin pid=1（无权 open）kill(pid,0) errno=EPERM` |

关联回归：`.audit-evidence/r24-regression.log` → `tests 81 / pass 81 / fail 0`
（state、state-ensure-race、state-wrlock-stale、hook-global-workers、user-note、user-note-e2e、
static-guards、log-review、session-toggle）。
R24c 关联回归：`.audit-evidence/r24c-regression.log` → `tests 123 / pass 123 / fail 0`（范围见 §三 R24c）。

全量回归：先 `.audit-evidence/batch6-local.log` → exit=0、`tests 715 / pass 714 / fail 0 / skipped 1 /
duration 40963.0ms`（批次五为 711 / 710 / 0 / 1，+4 = 本批新增 4 条用例）；R24c 之后镜像同步再跑
`.audit-evidence/batch6-final.log` → exit=0、`tests 719 / pass 718 / fail 0 / skipped 1 /
duration 43982.76ms`（+4 = `test/lock-alive-errno.test.js` 3 条 + 静态门禁 1 条）。

## 五、红灯取得方式与已披露缺口

- 死属主用**真子进程**（`spawnSync(process.execPath, ['-e','console.log(process.pid)'])` 后它已退出）
  取得的 pid，不是魔数；活属主用真 `setInterval` 子进程并等到 `process.kill(pid,0)` 成功。
- **必须同时改一处既有夹具**：`test/state.test.js:56`「拿不到锁返回 null，状态不被破坏」原来用
  魔数 pid `'999'` + 新鲜 mtime 冒充「有人持锁」。R24 之后死属主的锁会被**合法**回收，该夹具不再成立
  ⇒ 改为 `String(process.pid)`（所有平台都活着）。这**不是放宽断言**：该用例断言的是「新鲜锁 + 活属主
  ⇒ 拒绝写入、状态不被破坏」，语义不变；「**别人的**活进程持锁不得被抢」由新用例第 2 条（真子进程）覆盖。
- 另两处「持锁者已死」夹具（`test/user-note.test.js:267`、`test/session-toggle.test.js:161`）用死 pid
  **且**把 mtime 拨老 20s，仍走 mtime 规则 ⇒ 无需改动，实测仍绿。
- R24c 的红灯取得方式：`EACCES` 在 macOS 上**无法自然产生**（本机实测 pid 1 给的是 `EPERM`），
  所以第 1 条用例是**注入** errno（临时替换 `process.kill` 抛指定 `code` 的 Error）来钉死规则；
  真实进程只用于覆盖「活着 → 正常返回」「已退出 → 按实测 errno 处理」两侧。这就是红灯里
  `errno=EACCES` 一条的来源，它不是伪造的失败，而是把 Windows 的映射语义在本地复现出来。
- 未做 Windows 真机验证（见局限 4）。

## 六、局限

1. **R24 与 M2 的因果关系未证明**：R24 是候选机制，M2 仍是未定位偶发。
2. **未修的相邻缺陷（建议 R25）**：调用方忽略 `mutateStateExclusive` 的 `null`。R24 消除了「崩溃残留
   ⇒ 必然丢写」这一档，但真·活属主竞争超过 1s（杀毒/索引器拖慢 IO）时，worker 的结果仍会连同信标
   一起静默消失（`hooks/advisor-hook.js:1062` + `:1110`）。建议：worker 最终落盘改用更大重试预算
   （如 `{retries: 200}` ≈ 5s），仍失败则写一条 history 事件 + stderr，让「丢」可见。本批不改 ——
   不想在审查热路径上做没有红用例的改动。
3. **pid 复用**：若死属主的 pid 已被无关进程复用，存活判定会返回「活着」⇒ 退回 mtime 规则
   （安全但保守：最多仍等 10s）。反过来「活属主被误判已死」在本机可见的 errno 里不会发生；
   Windows 的 `EACCES` 分支按「非 ESRCH 一律算活」处理，但**只有注入用例覆盖**（局限 4）。
4. **Windows 未真机验证**：`process.kill(pid, 0)` 在 Windows 上「活进程正常返回 / 别人的进程
   access denied / 已死 ESRCH」的语义已按「只有 ESRCH 算已死」处理，但本机只有 macOS
   （实测：已退出 → `ESRCH`；root 的 pid 1 → `EPERM`，拿不到 `EACCES`）。本批**第三次推送**后
   由 CI 三平台真跑确认：`test/lock-alive-errno.test.js` 会在 windows-2022 runner 上打印它自己的
   `[R24c 观测]` 行（含该平台 pid 4 的实测 errno），那些行是这一条的证据。
5. **`.audit-evidence/*.log` 不入库**：仓库 `.gitignore` 第 2 行 `*.log` 把红灯/绿灯原始日志全部排除
   —— 152 个证据文件里只有 22 个进 git（报告 .md、探针 .cjs、pre-fix 快照、run-id .txt）。
   本报告与冻结报告里引用的 `.log` 路径是**本机工作树位置**，不是仓库内容；要复现需按报告里的命令重跑。

## 七、变更文件

| 文件 | 变更 |
| --- | --- |
| `hooks/lib/state.js` | R24：新增 `lockOwnerAlive`(:209)、`readLockOwner`(:217)；`withExclusiveLock`(:231) 陈旧判定加「属主已死」并加删除前属主复核。R24c：存活判定改为「只有 ESRCH 算已死」；`module.exports` 追加 `lockOwnerAlive, readLockOwner`（+40 / −2） |
| `tools/config-bridge.js` | R24c：`withConfigLock` 的存活判定改为「只有 ESRCH 算已死」（+4 / −1） |
| `tools/companion/controller.cjs` | R24c：`isStale`(:312) 与 `withConfigLock`(:867) 两处同步（+9 / −4） |
| `tools/companion/auto-enable.cjs` | R24c：`isStale`(:154) 同步，并更正原来只覆盖 macOS 的「实测」注释（+11 / −7） |
| `test/state-wrlock-stale.test.js` | 新增：死属主锁必须立即回收 / 活属主不得被抢 / 空内容锁不得被当死属主 / mtime 陈旧仍按原规则回收（4 条） |
| `test/lock-alive-errno.test.js` | 新增：注入 errno 钉死「只有 ESRCH 算已死」/ 真进程两侧 / 无权 signal 的活进程持有的新鲜写锁不得被回收（96 行，3 条） |
| `test/static-guards.test.js` | 新增门禁：四处文件必须含 `!== 'ESRCH'`、不得退回 `code === 'EPERM'`（+20 / −1） |
| `test/state.test.js` | 夹具魔数 pid `'999'` → `String(process.pid)`，注释写明为何必须是活 pid（+3 / −2） |
| `plugins/zcode-advisor/**` | 镜像同步（`node tools/sync-plugin-dir.cjs`）：`hooks/lib/state.js`、`tools/config-bridge.js`、`tools/companion/controller.cjs`、`tools/companion/auto-enable.cjs` |
| `.audit-evidence/*` | 新增 `r24-probe.cjs`、`r24b-gate-probe.cjs`、`r24-snapshot/state.js`（pre-fix 快照，取自 git HEAD）、`r19b-ci-run-id.txt`、`batch5-report.md`、`batch6-report.md`；日志（`r24-*`、`r24b-*`、`r24c-*`、`batch6-local/final`）因 `.gitignore` 的 `*.log` 不入库 |

## 八、与冻结版关系

- 冻结报告 `.audit-evidence/audit-report.md` 未改动（sha256 实测同上）。
- 冻结报告的残留编号到 R19；R20–R23 是批次四/五的轮外发现；**R24 是本批新发现**，按纪律不写回冻结版，
  只在本批报告登记。批次五报告 `.audit-evidence/batch5-report.md` 记录的是 CI 暴露的三项测试缺陷。
- 本批已按用户授权**提交并第三次推送** main（提交信息 `test: 批次六 —— R24 写锁静默丢写 +
  R24c 存活判定 errno 完备性`；推送前 HEAD 为批次五的 `0e4c979`）。推送目的：让
  `process.kill(pid, 0)` 的存活判定在**真 Windows runner** 上首次被检验（局限 4）。
- 三平台 CI 结果与原始日志落在推送后新建的 `.audit-evidence/batch6-ci.txt`（run id、三平台
  用例数、`[R24c 观测]` 行原文），本报告不事后改写数字。
