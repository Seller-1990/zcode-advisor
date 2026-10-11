# 批次三报告：R05 / R06 / R07 / R08 / R09 / R13 残余项修复（附批次内新发现「R21 候选」）

- 对象：`.audit-evidence/audit-report.md`（冻结版）残余清单中的 **R05 / R06 / R07 / R08 / R09 / R13**。
- 本报告**不修改冻结版报告**：冻结版仍是用户拍板的那份（671 行，SHA256 `8ccedbf346350c5c1f8480d06366df04dd76b99123b2115238077f2b133067e0`），本批次证据独立编号、独立落盘（批次二做法沿用）。
- 纪律：每项**先红灯**（失败原因必须就是该项自身的机制，不能是环境噪声）→ 最小修复 → 转绿 → 关联回归；六项全部完成后再做一次全量回归。

---

## 1. 结论摘要

| 项 | 机制（一句话） | 红灯 | 绿灯 | 关联回归 |
|---|---|---|---|---|
| R05 | `trimIfNeeded` 读全量后整段重写，覆盖并发 append | 1/0/1 | 8/8 | `history.test.js`（含在内）|
| R06 | `runAttempt` 重试与降级路径丢弃已消耗 usage | 5/3/2 | 5/5 | 131/131 |
| R07 | `extractJsonObjects` 失配回退 O(n²)（48K=2.5s） | 14/13/1 | 14/14 | 54/54 |
| R08 | OCR 锁清理只看 `LOCK_ACQUIRED`，删掉接管者的锁 | 32/30/2 | 32/32 | —（含在内）|
| R09 | `plugins list` 解析只认正斜杠 → Windows 上失效 | 5/2/3 | 34/34 | auto-enable 全系列（含在内）|
| R13 | `enable.sh` 不检查子命令退出码 → 假成功 | 2/0/2 | 3/3 | `enable.test.js`（含在内）|

红灯/绿灯列格式为 `tests/pass/fail`。

---

## 2. 逐项：机制 · 修复 · 红→绿证据 · 复现命令

### R05 · history 裁剪丢失并发追加

- **机制**：`hooks/lib/history.js` `trimIfNeeded()` 先读全量（:58），再把 `lines.slice(-250).join('\n')` **整段 writeFileSync**（:61）。读→写之间别的进程 `appendHistory` 追加的行被覆盖抹掉。
- **红灯**：`test/history-trim-race.test.js`（用 `Module._load` 让 `hooks/lib/history.js` 在写盘那一刻看到一次真实并发追加）→ `.audit-evidence/r05-red.log` exit=1、`tests 1 / pass 0 / fail 1`、mark 3✖/0✔，断言原文：`裁剪开始后并发追加的记录被整段覆盖丢失（R05）——现有 250 行里找不到它`。
- **修复**：裁剪结果写到 `${HISTORY_FILE}.trim-${pid}-${Date.now()}`，以 `Buffer.byteLength(raw,'utf8')` 为起点偏移，循环 3 轮 `statSync/openSync/readSync/appendFileSync` 把并发追加的尾巴搬进临时文件，`chmod 0600` 后 `renameSync` **原子替换**；`finally` 清理临时文件。裁剪语义（保留最近 250 行）不变。
- **绿灯**：`.audit-evidence/r05-green.log` `8/8`（含既有 `test/history.test.js`）。
- **复现**：`node --test test/history.test.js test/history-trim-race.test.js`

### R06 · usage（Token 计数）在失败/空/重试场景漏计

- **机制**：`hooks/advisor-hook.js` `reviewTurn` 只把**最后一次**物理调用的 usage 返回上层——`runAttempt` 内空响应重试（最多 2 次）覆盖 `res`；主模型失败改走备用模型时 `attempt = fbAttempt` 把主模型那次**已消耗**的 usage 整段丢掉；`const usage = attempt.res && attempt.res.usage`。
- **红灯**：`test/advisor-hook-usage.test.js`（用可注入调用器 `o.callReviewer`，不打网络）→ `.audit-evidence/r06-red.log` exit=1、`tests 5 / pass 3 / fail 2`、mark 5✖/3✔，断言原文：`重试中被丢弃的那一笔 usage 必须计入选（否则 Token 累计系统性偏低）`、`降级后只保留备用模型的 usage 会让主模型那次真实消耗凭空消失`。
- **修复**：`reviewTurn` 内新增 `usageTotals` + `addUsage(res)`（每次 `call(...)` 之后调用，重试与备用模型两条路径都覆盖）+ `totalUsage()`；`const usage = totalUsage()`。一笔都拿不到时保持旧行为（`undefined`，不凭空造 0/0）。
- **绿灯**：`.audit-evidence/r06-green.log` `5/5`。
- **关联回归**：`.audit-evidence/r06-regression.log` `131/131`（`fallback` / `log-review` / `reviewer-frame` / `user-note` / `health`）。
- **复现**：`node --test test/advisor-hook-usage.test.js`

### R07 · extractJsonObjects 二次复杂度

- **测量（修复前，输入 `'{'.repeat(N)` 全失衡）**：16K=284.8ms、32K=1097.3ms、48K=2451.9ms（平方增长）。
- **红灯**：`test/reviewer-json-perf.test.js`（1 条性能 + 13 条语义等价锁，期望值取自修复前实测）→ `.audit-evidence/r07-red.log` exit=1、`tests 14 / pass 13 / fail 1`，断言原文：`解析 48000 个失衡花括号耗时 2536.4ms，超过 400ms 上限（失配回退仍是 O(n²)）`。
- **修复**：`hooks/lib/reviewer.js` 加一次线性预处理（`Int32Array match` + 栈），为每个 `'{'` 预先算出配对的 `'}'`；外层 while 的候选/解析/推进逻辑逐字不变，只是失配回退从「重扫到结尾」变成 O(1) 查表 → 整体 O(n)。
- **故意的语义收紧（已写进代码注释并单列）**：旧实现每个候选 `'{'` 都从全新状态起扫，会把**字符串字面量内部**的 `'{'` 当候选、可能从字符串中间切出「合法 JSON」（`{bad "k":"x{ "a":1 }"` 旧→`[{a:1}]`，新→`[]`）。新实现遵循该函数既有口径「忽略字符串内的花括号」。13 条既有语义用例期望值未变。
- **绿灯**：`.audit-evidence/r07-green.log` `14/14`（整文件 205.7ms 跑完）；回归 `.audit-evidence/r07-regression.log` `54/54`。
- **复现**：`node --test test/reviewer-frame.test.js test/reviewer-json-perf.test.js`

### R08 · OCR stale-lock 竞态（清理删掉接管者的锁）

- **机制**：`scripts/ocr-review.sh` 加锁段两处 `trap 'rm -rf "$LOCK_DIR"' EXIT INT TERM`，`cleanup` 只判 `[ -n "$LOCK_ACQUIRED" ]` 而不校验锁现在属于谁 → A 被接管（陈旧锁路径）后退出时，把 B 正在用的锁删掉 → 第三个进程立刻取锁成功，**两个评审并行**。
- **红灯**：`test/ocr-review.test.js:745` 新增行为用例（`writeFakeOcr` 在评审中把 `$LOCK_DIR/info` 改写成 `pid=${process.pid}`）→ `.audit-evidence/r08-red.log` `tests 32 / pass 30 / fail 2`、mark 5✖/30✔，本项断言原文：`原持锁者退出时把接管者的锁删了 —— 第三个进程会立刻取锁成功，两个评审并行`（另一条失败是既有的负载敏感偶发用例，见第 5 节）。
- **修复**：新增 `release_lock()`（`[ -n "$LOCK_ACQUIRED" ] || return 0`；读 info 里的 pid；仅当 pid 为空或 `= $$` 时才 `rm -rf "$LOCK_DIR"`），两处早期 trap 与 `cleanup` 全部改为调用它；结构性用例同步改为锁住 `release_lock` 定义+调用（不再允许裸 `trap 'rm -rf "$LOCK_DIR"'`）。
- **绿灯**：`.audit-evidence/r08-green.log` `32/32`（mark 0✖/32✔，**单独前台运行**）。
- **复现**：`node --test test/ocr-review.test.js`

### R09 · Windows 反斜杠版本解析

- **定位更正（对冻结卡的两点修正，须以本报告为准）**：
  1. 卡片写「影响文件 controller.cjs」，实际站点是 **`tools/companion/auto-enable.cjs`**（`parseInstallPath` 与 `isReadyFromList`）；`controller.cjs` 内没有同类解析（仓库内再无第二处解析 `plugins list` 的代码）。
  2. 卡片的建议「路径操作统一使用 `path.join`/`path.normalize`」在此**不适用**：这里解析的是**第三方 CLI 的输出**，分隔符由宿主平台决定，不能用构建机平台的 `path` 去规范化；正确做法是同时接受 `\` 与 `/`。
- **机制**：`isReadyFromList` 用 `/zcode-advisor\/(\d+\.\d+\.\d+)/` 取已装版本、用 `out.includes('zcode-advisor/'+ver)` 做精确匹配；`parseInstallPath` 用 `/cache\/…/` 取 cache 目录。Windows 上输出是 `cache\zcode-advisor-local: C:\…\zcode-advisor\0.2.20` → 版本解析为空 → **恒判「未就绪」→ 每次启动都重装插件**，且「不降级」「同版本内容漂移」两条判据双双失效、指纹漂移检测静默失效。
- **红灯**：`test/auto-enable-winpath.test.js`（合成 Windows 形态输出，含相邻插件防越界）→ `.audit-evidence/r09-red.log` exit=1、`tests 5 / pass 2 / fail 3`、mark 7✖/2✔，断言原文：`反斜杠形态解析不出目录 → 内容指纹漂移检测在 Windows 上静默失效`、`已装版本解析不出 → 幂等快路径失效，每次启动都重装插件`、`不降级判据在 Windows 上必须同样生效，否则旧包会覆盖用户新装的版本`。
- **修复**：`cache[\\/]`、`zcode-advisor[\\/](\d+\.\d+\.\d+)`，并抽出 `hasVersionInList(out, ver)`（同时匹配 `/` 与 `\`）替换原来 3 处 `out.includes('zcode-advisor/'+ver)`。
- **绿灯**：`.audit-evidence/r09-green.log` `34/34`（5 条新用例 + 既有 auto-enable 系列全部）。
- **证据边界**：输入是**合成的 Windows 输出**、在 **macOS** 上执行 → 属**模拟验证**，不等于 Windows 真机验证。真机缺口见第 8 节。
- **复现**：`node --test test/auto-enable-winpath.test.js test/auto-enable-version.test.js`

### R13 · enable.sh 假成功

- **定位更正**：卡片写「影响文件 `scripts/enable.sh`」，实际文件在**仓库根目录 `enable.sh`**（`scripts/` 下无此文件）。
- **机制**：同步步骤、`plugins marketplace update`、`plugins enable` 的退出码未参与判定；任一步失败仍走到末尾打印「完成」并 `exit 0`。
- **红灯**：`test/enable-failure.test.js`（按既有切法取脚本主体，用 `run_cli` 替身让指定子命令返回 8）→ `.audit-evidence/r13-red.log` exit=1、`tests 2 / pass 0 / fail 2`、mark 5✖/0✔，断言原文：`「marketplace update」返回非零时脚本仍 exit 0（假成功）`、`「plugins enable」返回非零时脚本仍 exit 0（假成功）`。
- **修复**：引入 `FAIL=0` + `fail_step()`；同步步骤包成 `if ! … | sed 's/^/  /'; then fail_step …; fi`；`UPDATE_RC` / `ENABLE_RC` 非零 → `fail_step`；末尾 `FAIL -ne 0` → **stderr** 打印「失败：上述步骤存在未成功的项，插件未完成启用（不要以「完成」为准）」并 `exit 1`。
  - `plugins marketplace add` 维持**只告警不硬失败**（理由写进注释）：重复注册可能返回非零，且空输出会让 `grep` 返回 1，无法与真失败区分；真正决定「装的是不是当前代码」的是随后的 `update`。
- **绿灯**：`.audit-evidence/r13-green.log` `3/3`（2 条新失败路径 + 既有成功路径 `test/enable.test.js`）。
- **复现**：`node --test test/enable-failure.test.js test/enable.test.js`

---

## 3. 批次内新发现：OCR 全量套件「后台并行时卡死」（候选 R21，**不在冻结清单内**）

- **现象**：两次把 `test/ocr-review.test.js` 作为**后台任务**、并在同时跑其它 node 用例时，套件卡死 **>6 分钟**不返回。
- **现场取证**：`ps` 显示 sandbox 内 `bash …/scripts/ocr-review.sh HEAD~1 HEAD`；`sample` 实证阻塞在 `__wait4`；待等子进程是 watcher 子 shell（`( … ) &`，argv 与父相同，PGID 未另立）+ `sleep 900`（HOP_LIMIT 默认）；sandbox 内 `ocr-deadline.*` 为 0 字节（**未过期**）、`ocr-attempt-*` 仍在 → 卡在某一跳的 `run_with_deadline`（`scripts/ocr-review.sh:419-427`：`kill "$watcher_pid"` 之后 `wait "$watcher_pid"`，**wait 无上限**）。手工 `kill -TERM <watcher>` 后全线立即退出 → watcher 的 TERM 处理本身可用。
- **归因实验**：用 sed 生成行为等价的 pre-R08 版（旧 trap/cleanup，`bash -n` 通过，sha 事后复原）→ **单独前台**跑完整文件**不卡**（`32 tests / 31 pass / 1 fail`，仅 R08 用例红）；换回修复版单独前台 → `32/32` 绿；再起 6 个 busy-loop 造 CPU 压力后跑 → 仍 `32/32` 绿。
- **结论（如实）**：无法归因于 R08 改动（FORCE=1 路径下 `release_lock` 是 no-op，卡点在 hop 内、cleanup 之前）；纯 CPU 负载也不能复现。证据只支持「父进程 `wait` 无上限 + watcher 偶发未响应 TERM」这一**兜底缺口**：**2/2 次后台并行运行时复现；单独运行与纯 CPU 负载不复现；根因未定位**。故列为候选 R21，建议编号 R21 并保留本节证据，不并入本批修复。

---

## 4. 红→绿证据索引（唯一表）

mark 计数由 `grep -c "✖"` / `grep -c "✔"` 实测 **TAP 标记**，父子套件会重复计数，因此**大于** `ℹ pass/fail` 的去重用例数；两列都保留以便交叉核对。

| 项 | 红灯日志 | 红灯 tests/pass/fail | 红灯 mark ✖/✔ | 绿灯日志 | 绿灯 tests/pass/fail | 绿灯 mark ✖/✔ |
|---|---|---|---|---|---|---|
| R05 | `.audit-evidence/r05-red.log` | 1/0/1 | 3/0 | `.audit-evidence/r05-green.log` | 8/8/0 | 0/8 |
| R06 | `.audit-evidence/r06-red.log` | 5/3/2 | 5/3 | `.audit-evidence/r06-green.log` | 5/5/0 | 0/5 |
| R07 | `.audit-evidence/r07-red.log` | 14/13/1 | 3/13 | `.audit-evidence/r07-green.log` | 14/14/0 | 0/14 |
| R08 | `.audit-evidence/r08-red.log` | 32/30/2 | 5/30 | `.audit-evidence/r08-green.log` | 32/32/0 | 0/32 |
| R09 | `.audit-evidence/r09-red.log` | 5/2/3 | 7/2 | `.audit-evidence/r09-green.log` | 34/34/0 | 0/34 |
| R13 | `.audit-evidence/r13-red.log` | 2/0/2 | 5/0 | `.audit-evidence/r13-green.log` | 3/3/0 | 0/3 |

关联回归：`.audit-evidence/r06-regression.log`（131/131）、`.audit-evidence/r07-regression.log`（54/54）、`.audit-evidence/r08-fallback-probe.log`（1/1，单独运行偶发用例通过）。

全量回归：

| 阶段 | 日志 | 字节 | tests/pass/fail/skipped | duration |
|---|---|---|---|---|
| 本批开工前基线 | `.audit-evidence/batch3-baseline.log` | 64703 | 666/665/0/1 | 44889.159104ms |
| 本批结束后 | `.audit-evidence/batch3-final.log` | 67381 | **694/693/0/1** | 39798.149195ms |

用例增量 +28 = R05(1) + R06(5) + R07(14) + R09(5) + R13(2) + R08(1)。镜像同步：`node tools/sync-plugin-dir.cjs` → `[sync-plugin] 已同步 plugins/zcode-advisor/`（`test/plugin-dir.test.js` 无漂移）。

---

## 5. 红灯取得方式与已披露缺口

1. **R08 红灯混入一条既有偶发**：`test/ocr-review.test.js` 内既有的 `run_with_deadline：fallback 在 leader 先退出后仍 KILL 忽略 TERM 的孙进程` 在机器有其他负载时失败（`.audit-evidence/r08-red.log:66` `TERM-ignoring child remains alive: 66558 ?E`），单独运行通过（`.audit-evidence/r08-fallback-probe.log` 1/1 pass，3.2s），空载全量基线 0 fail。**不是本批改动引入**，本批绿灯（32/32）在单独前台运行下取得。
2. **R05 的残余微窗口**：修复后「最后一次补读」与 `renameSync` 之间仍有极窄窗口，本轮**未消除**（只是从「整段覆盖」缩小到「微窗口」）。报告不宣称已消除竞态。
3. **R07 的一处故意语义收紧**：字符串字面量内的 `{` 不再作为候选（旧实现可从字符串中间切出 JSON）。这是遵循该函数既有口径的收紧，已在代码注释与本报告单列；13 条既有语义用例期望值未变。
4. **R09 是模拟验证**：合成 Windows 输出 + macOS 执行；**Windows 真机未验证**。
5. **R09 / R13 的卡片定位与建议已更正**（见第 2 节各项），冻结版报告未改，故此处留档差异。

---

## 6. 变更文件

| 文件 | 本批改动 |
|---|---|
| `hooks/lib/history.js` | `trimIfNeeded` 改为 tmp + 补读并发行 + 原子 rename |
| `hooks/advisor-hook.js` | `reviewTurn` 新增 `usageTotals` / `addUsage` / `totalUsage`，覆盖重试与降级路径 |
| `hooks/lib/reviewer.js` | `extractJsonObjects` 增加线性配对预处理（O(n²)→O(n)） |
| `scripts/ocr-review.sh` | 新增 `release_lock()` 校验锁归属；两处 trap 与 cleanup 改调它 |
| `tools/companion/auto-enable.cjs` | `cache[\\/]`、`zcode-advisor[\\/]`、新增 `hasVersionInList()` |
| `enable.sh`（仓库根） | `FAIL` / `fail_step()` / 末尾失败判定并 `exit 1` |
| 新增测试 | `test/history-trim-race.test.js`、`test/advisor-hook-usage.test.js`、`test/reviewer-json-perf.test.js`、`test/auto-enable-winpath.test.js`、`test/enable-failure.test.js` |
| 修改测试 | `test/ocr-review.test.js`（R08 行为用例 + 结构性断言更新） |
| 镜像 | `plugins/zcode-advisor/**`（同步产物） |

**关于行数**：本批及批次一/二**均未提交**（无本地 commit），`git diff --stat` 的 per-file 行数**混合三批**（全仓当前 57 文件 +1919/−518），因此本批归因以「机制 + 行号」为准，不用行数。

---

## 7. 与冻结版报告的关系

1. 冻结版**未改动**（671 行，SHA256 `8ccedbf346350c5c1f8480d06366df04dd76b99123b2115238077f2b133067e0`）。
2. R 编号沿用冻结清单；批次二新发现记为 **R20**、本批新发现记为 **R21 候选**，均明示「不在冻结清单内」。
3. 本批是把冻结清单残余项按红→绿纪律逐项落实，不是新的审计结论。

---

## 8. 局限

1. **仅 macOS + Node v24.17.0 实测**；R09 为模拟验证（第 5.4 条），Windows/macOS 的跨平台结论仍是「配置就绪、真机未跑」。
2. `.github/workflows/build-installers.yml` 的三平台测试矩阵（ubuntu / macos-15 / windows-2022）**从未远端真跑**；本地也无提交/推送授权，故「Windows 兼容性」在本次交付中仍属未实测项。
3. R21 卡死根因未定位（第 3 节）。
4. R05 残余微窗口、R07 语义收紧已如实披露（第 5 节）。

---

## 9. 下一步（剩余残余项）

冻结清单剩余：**R04**（globalWorkers TOCTOU）、**R10**（OCR 输出元素校验）、**R11**（sync 类型冲突）、**R12**（bump 部分写入）、**R14**（setup-port TOCTOU）、**R15**（install-templates 提示）、**R16**（archive 校验和/截断）、**R17**（install-templates 首装时序）、**R18**（marker-skip 脆弱）、**R19**（CI 未远程验证）。按风险分 1–2 批继续，仍逐项红→绿；R19 需要一次提交 + 推送授权才能真跑。
