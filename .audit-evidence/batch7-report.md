# 批次七报告 —— M2 用例前提竞态修复（红 → 绿 → 全量绿）

> 本文件是批次七的独立证据与说明。冻结版 `.audit-evidence/audit-report.md` 不动（sha256 `8ccedbf346350c5c1f8480d06366df04dd76b99123b2115238077f2b133067e0`），本批证据按惯例另立文件。

## 一、范围与纪律

- **对象**：CI run `38135048979`（headSha `5851112`）在 `ubuntu-latest` 上**唯一**的失败用例 —— `test/e2e.test.js:369`「P0 回归：审查在飞时 /advisor-off 不被 worker 旧快照回滚」。
- **授权边界**：用户此前授权的是「提交批次六并第三次推送」（已完成）；本批是 CI 暴露问题的**本地修复**，**第四次推送未获授权**，故本批不含提交与推送。
- **纪律**：红 → 绿 → 关联回归 → 全量回归；**产品代码零改动**（红灯所用的临时注入已复原并校验 sha256）；不改冻结报告；新证据一律落 `.audit-evidence/`。

## 二、结论摘要表

| 编号 | 性质 | 结论 | 红灯证据 | 绿灯证据 |
| --- | --- | --- | --- | --- |
| **M2** | 用例前提竞态（**非产品缺陷**） | 已修 | `.audit-evidence/m2-red.log` `tests 1 / pass 0 / fail 1`（60371.86ms，断言与 CI 逐字一致） | `.audit-evidence/m2-green-slowed.log` `1 / 1 / 0`（同一注入下 11471.97ms）；`.audit-evidence/m2-green-repeats.log` 3/3；`.audit-evidence/m2-e2e-file-green.log` 整文件 `42 / 42 / 0` |
| **ECONNRESET** | 修复自身引入的测试侧 uncaughtException | 已修 | 全量首跑 `.audit-evidence/batch7-final.log`（已被覆盖，原文见 §3.4） | `.audit-evidence/batch7-final.log`（覆盖后）`tests 719 / pass 718 / fail 0 / skipped 1`，async/ECONNRESET 计数 0 |

## 三、机制 · 修复 · 证据

### 3.1 现象与定性

CI 原始失败（`.audit-evidence/r24c-ci-ubuntu.log`）：

```
not ok 158 - P0 回归：审查在飞时 /advisor-off 不被 worker 旧快照回滚
  duration_ms: 60177.451105
  error: 'worker 应在审查超时后落盘：dropped={} enabled=false lock=false
          stateDir=[".mock-allowed","advisor-health-s11.json","sess-s11.json","snapshots","zcode-v2.json"]
          stop.stderr="" off.stderr=""'
  failureType: 'testCodeFailure'
```

三平台对照：`ubuntu-latest` `719 / 711 / 1 / 7`（唯一失败即本条）、`macos-15` `719 / 717 / 0 / 2`、`windows-2022` `719 / 669 / 0 / 50`。

**定性：这是用例前提竞态，不是产品缺陷。** 代码路径（`hooks/advisor-hook.js` `handleReviewWorker`）：

- `:973` `fs.writeFileSync(lockPathFor(file), myPid, 'utf8')` 认领会话锁（非排他，失败即 return）
- `:979` `const state = loadState(file);` → `:980 if (!state) return;`
- **`:984 if (!state.enabled) return;` ← 静默早退：不记 drop、不留痕**（`finally` 在 `:1130` 用 `clearLockIfOwner(file, myPid)` 清锁）

负载高的 runner 上，worker 的 node 冷启动时间可以超过「`runHook(['stop'])` 返回」到「`runHook(['ctl','off'])` 写入 `enabled=false`」之间的间隔 ⇒ worker 在 off **之后**才读状态 ⇒ 走 `:984` 静默早退 ⇒ `dropped={}`、不留锁、永远不会有落盘 ⇒ 用例白等满 60s 预算判红。CI 诊断签名（`dropped={}` + `lock=false` + `stop.stderr=""`）与静默早退**完全一致**；产品行为本身正确——用户已经停用，就不该再出审查。

### 3.2 红灯取得（确定性夹具）

- **尝试 ①（作废）**：`NODE_OPTIONS="--require /tmp/m2-slow-worker.cjs"` 想只延迟 worker 进程 —— 本机 node 是 Electron 版，输出 `Node.js environment variables are disabled because this process is invoked by other apps.`，NODE_OPTIONS 被剥离，worker 未被延迟，用例 6472ms 通过。**教训：此环境不能拿 NODE_OPTIONS 当延迟杠杆。**
- **尝试 ②（成功）**：临时在 `hooks/advisor-hook.js` 的 `handleReviewWorker` 内、`if (!file) return;`（`:960`）之后插入受 `process.env.M2_SLOW_WORKER_MS` 控制的 busy-wait，模拟 runner 上 worker 冷启动被拖慢。注入版 sha256 `1cb289cdb24f31e7f0bf2ccdb8ca1320d5c1ded4532ab041fd919699c80f1f22`；原版备份 `/tmp/advisor-hook.orig.js`，sha256 `0b5a4b75be91280c40edcdf3537a82613044108860a973de8c82b8ca1cadaef5`。
- 红灯命令与结果：

  ```
  M2_SLOW_WORKER_MS=5000 node --test --test-name-pattern="审查在飞时" test/e2e.test.js
  ```

  `.audit-evidence/m2-red.log`：exit=1、`tests 1 / pass 0 / fail 1`、60371.86ms，断言原文与 CI **逐字一致**（`dropped={} enabled=false lock=false …`）。
- **复原**：`cp /tmp/advisor-hook.orig.js hooks/advisor-hook.js` → sha256 回到 `0b5a4b75be91280c40edcdf3537a82613044108860a973de8c82b8ca1cadaef5`，`grep -c 'M2 红灯临时注入\|M2_SLOW_WORKER_MS'` = 0，`node --check` OK，`git diff --quiet -- hooks/advisor-hook.js` = 是 ⇒ **产品代码零改动**。

### 3.3 修复内容（`test/e2e.test.js`）

1. `:378` `let sawReviewRequest = false;`，并在 `net.createServer` 的连接回调（`:379-386`）里置 true —— worker **只有越过 `:984` 的 enabled 门禁才会发起 HTTP 请求**，所以「收到连接」才是「审查真的在飞」的可靠信号。
2. `:409-420` 在 `runHook(['ctl','off',…])` **之前**等待该信号（预算 60s），失败时显式判红：`worker 未在预算内发起审查请求：无法确认「审查在飞」，本用例前提不成立（stateDir=… stop.stderr=…）`。前提不成立就不再往下走，杜绝「白等满预算再判红」这种只有结论没有证据的红。
3. **实现教训（已写进代码注释 `:407-408`）**：第一版用文件里既有的 `waitUntil` 做这个等待 → 60.33s 后仍报「worker 未在预算内发起审查请求」。原因：`waitUntil`（`test/e2e.test.js:79`）内部是 `Atomics.wait` **同步阻塞主线程**，TCP 连接回调永远没机会跑，标志位恒为 false。**凡等待事件循环驱动的信号，本文件必须用异步等待**（`await new Promise` + `setInterval 25ms`）。

### 3.4 修复自身引入的 ECONNRESET 与处置

首次全量（`.audit-evidence/batch7-final.log`，**已被后续绿跑覆盖**）：

```
ℹ tests 720 / pass 718 / fail 1 / skipped 1
ℹ Error: Test "P0 回归：审查在飞时 /advisor-off 不被 worker 旧快照回滚" at test/e2e.test.js:369:1
  generated asynchronous activity after the test ended. This activity created the error
  "Error: read ECONNRESET" and would have caused the test to fail, but instead triggered
  an uncaughtException event.
✖ test/e2e.test.js (44623.710011ms)
```

M2 用例本身**通过**（6424.54ms），红来自文件级 uncaughtException。对照历史：baseline / `batch2-final` / `batch4-final2` / `batch6-final` / `batch6-local` 及三份 CI 原始日志里该串均为 **0 次**。

- **归因实验（决定性）**：用 node 脚本从当前 `test/e2e.test.js` 生成去掉新等待块的变体 `test/tmp-e2e-old.test.js`（少 750 字节）→ `node --test test/tmp-e2e-old.test.js` 整个文件 **42/42 通过、0 async / 0 ECONNRESET** ⇒ 该 RST 的**可见性**由新等待改变了事件循环调度所致，**不是产品行为变化**。实验后已 `rm` 掉临时变体。
- **修复**：mock 服务端连接回调里加 `sock.on('error', () => {});`（`:384`，注释 `:381-383`）——审查 3s 超时后 worker 会直接 RST 掉这个「故意不回包」的连接，服务端 ECONNRESET 是本用例**预期行为**，不是被测缺陷；不挂 error 监听就会变成 uncaughtException。

### 3.5 验证

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 红灯 | `M2_SLOW_WORKER_MS=5000 node --test --test-name-pattern="审查在飞时" test/e2e.test.js` | `.audit-evidence/m2-red.log` `1 / 0 / 1` |
| 绿灯（同一注入） | 同上 + 修复后用例 | `.audit-evidence/m2-green-slowed.log` `1 / 1 / 0`（11471.97ms） |
| 重复（无注入） | 同上，跑 3 次 | `.audit-evidence/m2-green-repeats.log` 3/3（6520.94 / 6456.81 / 6346.41 ms） |
| 整文件 | `node --test test/e2e.test.js` | `.audit-evidence/m2-e2e-file-green.log` `42 / 42 / 0`，0 async |
| 全量 | `npm test` | `.audit-evidence/batch7-final.log` exit=0、`tests 719 / pass 718 / fail 0 / skipped 1 / duration 45387.117138ms`，async/ECONNRESET 计数 0 |

用例总数与批次六相同（719）——本批**只改用例、未加用例**。

## 四、红→绿证据索引（唯一表）

| 证据文件 | ✖ | ✔ | 说明 |
| --- | --- | --- | --- |
| `.audit-evidence/m2-red.log` | 1 | 0 | 注入 5s 慢启动 + **未修**用例；断言与 CI 逐字一致 |
| `.audit-evidence/m2-green-slowed.log` | 0 | 1 | 同一注入 + **已修**用例；11471.97ms |
| `.audit-evidence/m2-green-repeats.log` | 0 | 3 | 无注入连跑 3 次全绿 |
| `.audit-evidence/m2-e2e-file-green.log` | 0 | 42 | 整文件（含 ECONNRESET 处置）全绿、0 async |
| `.audit-evidence/batch7-final.log` | 0 | 718 | 全量 719 用例 / 718 通过 / 0 失败 / 1 跳过 |

## 五、红灯取得方式与已披露缺口

1. **红灯依赖临时产品代码注入**：该注入（`M2_SLOW_WORKER_MS` busy-wait）**不在仓库里**，故本红灯**无法原样重跑**。复原证据：注入前后 sha256（`1cb289cd…` → `0b5a4b75…`）、`grep -c` = 0、`node --check` OK、`git diff --quiet -- hooks/advisor-hook.js` = 是。
2. **首跑全量日志已被覆盖**：`.audit-evidence/batch7-final.log` 现为绿跑；ECONNRESET 那段红的原文只在本报告 §3.4 与 `.audit-evidence/m2-e2e-file-green.log` 的对照说明中留证。
3. **本机未复现 CI 上真实失败**：本机 macOS 12 核空载下该用例 6.4s 通过（连跑 3 次、另加 36 个 busy loop 的 CPU 饥饿实验 3/3 通过，7.4s 上限）。红灯靠注入模拟「worker 读状态之前 off 已经落盘」的同一种交错，**不等于**在 ubuntu runner 上真机复现过。
4. **前提断言无法区分原因**：`worker 未在预算内发起审查请求` 这条红，既可能是「产品没发起」，也可能是「环境太慢没到 60s」；60s 预算下二者不可区分，属已知取舍（宁可红得明确，也不要白等满预算）。

## 六、局限

1. **第四次推送未授权** ⇒ 本修复在三平台是否真绿**尚未验证**；CI 上该用例的历史行为是「macos-15 上曾 20358ms 判红、ubuntu 上 60177ms 判红」，修复针对的是前提而非耗时，耗时本身仍受 runner 负载影响。
2. 本批**只动用例**，故不涉及镜像同步（`tools/sync-plugin-dir.cjs` 只同步 `hooks/`、`commands/`、`.zcode-plugin/`、`tools/`）。
3. `.gitignore:2` 是 `*.log` ⇒ `.audit-evidence/*.log` **不入库**，本批全部原始日志只在本机。
4. 冻结报告 `.audit-evidence/audit-report.md` 的 R 清单未收录 M2（它不在冻结清单里，是 CI 第三次真跑才暴露的用例问题）；如需并账，应在后续批次报告中以「轮外发现」形式登记。

## 七、变更文件

| 文件 | 变更 | 说明 |
| --- | --- | --- |
| `test/e2e.test.js` | +31 / −1 | 纯测试：`sawReviewRequest` 信号（`:378-386`）、异步前提等待与显式断言（`:409-420`）、ECONNRESET 处置（`:384`） |

产品代码零改动（`hooks/advisor-hook.js` 与 HEAD 一致）。

## 八、与冻结版 / 批次六的关系

- 冻结版 `.audit-evidence/audit-report.md` sha256 未变：`8ccedbf346350c5c1f8480d06366df04dd76b99123b2115238077f2b133067e0`。
- 批次六（`.audit-evidence/batch6-report.md`）已提交并推送（commit `5851112`，CI run `38135048979`）；本批是其 CI 结果的**后续处置**，不修改批次六的任何结论。
- 批次六的 `[R24c 观测]` 结论已按真机数据修正：真 Windows runner 上无权进程报 **EPERM 而非 EACCES**，EACCES 分支仍只由注入用例覆盖（详见 `.audit-evidence/batch6-ci.txt`）。
