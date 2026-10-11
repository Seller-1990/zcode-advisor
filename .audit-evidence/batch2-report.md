# 批次二报告：R01–R03 残余项修复（附批次内新发现 R20）

- 对象：`.audit-evidence/audit-report.md`（冻结版）残余清单中的 **R01 / R02 / R03**，以及本批次窗口内新发现的 **R20**。
- 本报告**不修改冻结版报告**：冻结版仍是用户拍板的那份（671 行，SHA256 `8ccedbf346350c5c1f8480d06366df04dd76b99123b2115238077f2b133067e0`），本批次证据独立编号、独立落盘。
- 纪律：每一项都先拿到**可归因的红灯**（失败原因必须是该项本身，而不是环境/前置问题），再修，再转绿；证据按「完整文件名（含扩展名）+ 实测标记数」记录，标记数由 `grep -c` 实测（`node:test` 的 TAP 父子节点会重复计数，故标记数 ≥ 去重后的用例数）。
- 环境：macOS，Node v24.17.0，本地日期 2026-10-11。**未在 Windows / Linux 上执行**（局限见第 7 节）。

## 1. 结论摘要

| 项 | 缺陷（一句话） | 修复机制 | 红灯 | 绿灯 | 状态 |
|---|---|---|---|---|---|
| R01 | 控制器单实例锁「读→rename→回读」非原子，并发启动时两台都能自认持锁 | 改为 `link` 排他创建 + 陈旧锁先原子隔离再创建 | 5 ✖ / 0 ✔ | 0 ✖ / 2 ✔ | 已修 |
| R02 | 单飞租约 TTL 5min < 单次启用最坏 9min；释放不认主，会删掉接管者的锁 | 步骤边界续租 + 释放前校验属主 | 5 ✖ / 0 ✔ | 0 ✖ / 2 ✔ | 已修 |
| R03 | `ensureState` 的「先 existsSync 再写」窗口会把对手刚写入的 `enabled=false`/笔记覆盖掉 | 改为排他创建，EEXIST 即让位并采纳对手状态 | 3 ✖ / 0 ✔ | 0 ✖ / 1 ✔ | 已修 |
| **R20** | **干净机器上尚无 `~/.zcode` 时，单飞锁取锁失败被误报成「已有实例在运行」，自动启用永久静默失效（假成功）** | 取锁前先补父目录（锁目录仍保持排他 mkdir） | 3 ✖ / 0 ✔ | 0 ✖ / 1 ✔ | 已修（新发现） |
| R01–R03 之外 | 冻结报告 R04–R19 未动 | — | — | — | 未动 |

全量回归：`npm test` **666 tests / 665 pass / 0 fail / 1 skip**，exit 0，`duration_ms 43231.10076`（`.audit-evidence/batch2-final.log`）。基线：660 / 659 / 0 / 1，exit 0，`duration_ms 39965.116386ms`（`.audit-evidence/batch2-baseline.log`）。新增 6 条用例 = R01 2 + R02 2 + R03 1 + R20 1，与差值一致。

## 2. R01 — 控制器单实例锁原子化

**机制**（`tools/companion/controller.cjs`）：原 `writeLock()` 写唯一临时文件后 `fs.renameSync(tmp, lockFile)`，再回读确认 `pid === process.pid`。`rename` 会**静默覆盖**已存在的目标，因此并发启动时 A、B 各自覆盖、各自回读到自己，双双判定「我拿到锁了」——正是「读→rename→回读」这个窗口，不是 TTL 问题。

**修复**：
- 新增 `createLockExclusive(lockFile, cdpPort)`（`tools/companion/controller.cjs:334`）：写 tmp → `fs.linkSync(tmp, lockFile)`，目标已存在即 `EEXIST`（绝不覆盖）；不支持硬链接的文件系统退回 `fs.openSync(lockFile,'wx')`；`finally` 删除 tmp。
- `acquireLock()`（`tools/companion/controller.cjs:377`）重写为最多 3 轮：本进程已持有 → 续租后 true（保留重入语义）；异构 pid 且不陈旧 → 记日志并 false；陈旧 → 先把锁 `rename` 到隔离名（`ENOENT` = 对手已先接管 → 下一轮），隔离前若发现隔离件 pid 已不是原持锁者则把锁放回、继续下一轮；再排他创建；3 轮用尽 → false。异常一律走原有「失败开放」路径。
- 头部注释 ③ 同步改写，写明「不能用 rename：rename 会静默覆盖目标 → 并发启动时两台都能通过回读」。

**红→绿**：
- 红（修复前）：`.audit-evidence/r01-red.log`，exit=1，**5 ✖ / 0 ✔**，断言原文 `第 1 轮：应恰好 1 个实例取得锁，实际 6`、`第 1 轮：陈旧锁接管应恰好 1 个赢家，实际 5` → 6/6 子进程全部自认持锁，窗口完全敞开。
- 绿：`.audit-evidence/r01-green.log`，exit=0，**0 ✖ / 2 ✔**。
- 回归：`test/companion-lock.test.js` + `test/companion-lock-race.test.js` → `tests 12 / pass 12 / fail 0 / skipped 0`。
- 新增用例 `test/companion-singleton-race.test.js`（95 行）：6 个子进程 + `ZCA_SYNC_AT` 绝对时刻对齐起跑线，隔离 `HOME/USERPROFILE/TMPDIR/TMP/TEMP`，3 轮断言「恰好 1 个赢家」；第二条覆盖「陈旧锁并发接管」。赢家额外存活 400ms，让落败方能读到「持锁者存活」。

## 3. R02 — 自动启用单飞租约续期与认主释放

**机制**（`tools/companion/auto-enable.cjs`）：`LOCK_TTL_MS = 5 * 60 * 1000`，但单次启用最坏 `alreadyEnabled` 60s + 4 步 × 120s = 540s ≈ 9min，远超 TTL；且 `releaseFlight`（含 `process.on('exit')`）无条件删除锁目录，被接管后退出会删掉接管者的锁。

**约束**（决定了不能图省事调大 TTL）：`test/auto-enable-lock.test.js:84-91` 已存在用例要求「存活 pid 但 `started` 超过 TTL → 判陈旧并接管」，其正当性来自 pid 复用必须可解；直接把 TTL 调到 12min 会打红该用例，并让 pid 复用永久阻塞。**正解是持锁者续租**：真实持锁者永不进入陈旧窗口，没人续租的锁仍会超时被接管——两条语义同时成立。

**修复**：
- 新增 `renewFlight(lockDir)`（`tools/companion/auto-enable.cjs:199`）：先校验 `readLockInfo(info).pid === process.pid`，被接管即停止续租（与 controller 心跳同一纪律），否则把 `started` 刷成现在。
- `runEnable(lockDir)`（`tools/companion/auto-enable.cjs:413`）在每一步 CLI 之前续租 → 未续租间隔上界 = 单步超时 120s < TTL 300s。
- `main()` 的 `releaseFlight`（`tools/companion/auto-enable.cjs:225`）改为认主释放：属主不是自己就不删；是自己则先删 `info` 再 `rmdirSync(lockDir)`（目录非空 = 新主已写入租约 → `ENOTEMPTY` 被吞，不会误删新主的锁）。
- TTL 注释更正：原注释「TTL 远大于单次启用耗时」实测不成立，改为写明「单步最长 2 分钟，超时必属异常」。

**红→绿**：
- 红：`.audit-evidence/r02-red.log`，exit=1，**5 ✖ / 0 ✔**，断言原文 `持锁期间 started 必须被续租刷新（实际只观测到 1 个不同的 started：1791690462876）`、`接管者的锁不该被「失去所有权」的进程删掉`。
- 绿：`.audit-evidence/r02-green.log`，exit=0，**0 ✖ / 2 ✔**。
- 新增用例 `test/auto-enable-lease.test.js`（145 行）：真起 `auto-enable.cjs` 子进程、真读锁文件，不 mock；假 ZCode 按真机 macOS 布局放在 `fixture/zcodebin/ZCode` + `fixture/Resources/glm/zcode.cjs`。
- 回归：`test/auto-enable-lock.test.js` + `test/auto-enable-lease.test.js` + `test/auto-enable-clean-home.test.js` → `tests 10 / pass 10 / fail 0`。

## 4. R03 — `ensureState` 的创建窗口不再覆盖对手状态

**机制**（`hooks/lib/state.js`）：`ensureState` 先 `fs.existsSync(file)`，不存在才 `freshState()` + `saveState()`（`saveState` 用 rename，**会覆盖**）。窗口内对手（并发会话 / ctl / Stop / worker）创建并写入自己的状态后，本进程继续落盘，把对手的 `enabled=false` 复活成 `true`、并把待处理笔记清零。

**修复**：
- 新增 `createStateExclusive(file, state)`（`hooks/lib/state.js:173`）：写 tmp → `fs.linkSync(tmp, file)`，`EEXIST` 返回 false；不支持硬链接则退回 `'wx'` 独占打开（同样不覆盖；半写文件不留盘，避免读取方当损坏留尸）；写失败不吞异常。
- `ensureState`（`hooks/lib/state.js:71`）：`!existsSync` 时先排他创建，成功才 `created:true`；落到这里 = 对手先创建 → 继续往下读并**采纳对手状态**（`created:false`），不再写自己的 freshState。读取分支的三种状态（ok/corrupt/error）语义不变。
- 无连带改动：`freshState` 等导出未变，`ensureState` 的 4 个调用点（`hooks/advisor-hook.js:499/517/644/763`）只依赖 `file`/`state`，语义兼容。

**红→绿**：
- 红：`.audit-evidence/r03-red.log`，exit=1，**3 ✖ / 0 ✔**，断言原文 `窗口内对手已创建 → 本次不得自认 created`（当时返回 `created:true`，且盘上对手状态被覆盖）。
- 绿：`.audit-evidence/r03-green.log`，exit=0，**0 ✖ / 1 ✔**。
- 回归：`test/state.test.js` + `test/state-ensure-race.test.js` → `tests 18 / pass 18 / fail 0`。
- 新增用例 `test/state-ensure-race.test.js`（66 行）：**确定性复现，不需要真并发**——用 `Module._load` 只让 `hooks/lib/state.js` 拿到的 `fs` 在那一刻对目标文件谎报一次 `existsSync=false`，盘上文件确实已由「对手」写好，断言不得覆盖且须采纳对手状态（`enabled` 与 `pendingNotes` 都不丢）。

## 5. R20 — 批次内新发现：干净机器上单飞锁假成功（不在冻结清单内）

**这是本批次窗口内新发现的问题，不在冻结报告 R01–R19 之内，特此单独明示**，以免被误读成「R01–R03 之外的既有结论」。

**机制**（`tools/companion/auto-enable.cjs`）：取锁目录 `~/.zcode/advisor-auto-enable.lock`，而 `fs.mkdirSync(lockDir, { recursive: false })` 要求父目录 `~/.zcode` 已存在。仓库中**没有任何代码**在取锁之前创建 `~/.zcode`（唯一相关的 `mkdirSync(..., {recursive:true})` 是 `runEnable` 里写用户配置，发生在取锁之后）。干净机器上：mkdir → `ENOENT` → 落进 catch → `readLockInfo` 读到「无锁」却被 `isStale` 判为陈旧 → `tryTakeOver` 往同一个不存在的父目录写也 `ENOENT` → 返回 `{acquired:false, holder:''}` → `main()` 打出

```
[auto-enable] 已有自动启用实例在运行（pid 未知），本次跳过以免并发踩踏
```

并 `return 0`。后果：**自动启用在干净机器上永久静默失效（假成功），日志还把责任推给一个不存在的实例**。本机 `~/.zcode` 已存在，所以该缺陷一直没暴露。

**实测探测**：`fs.mkdirSync('/tmp/…/lock', {recursive:false})` → `ENOENT`；`{recursive:true}` 能创建，但**第二次调用也成功 → 无排他性**，所以不能直接把 `recursive` 改成 true，否则单飞锁形同虚设。

**修复**：只递归补父目录，锁目录本身仍用排他 mkdir（`tools/companion/auto-enable.cjs:175` 起两行，注释写明原因）。

**红→绿**：
- 红：`.audit-evidence/r20-red.log`，exit=1，**3 ✖ / 0 ✔**，断言原文 `父目录缺失被误报成「已有实例在运行」（假成功，自动启用静默失效）`，日志中即上文那行「pid 未知」。
- 绿：`.audit-evidence/r20-green.log`，exit=0，**0 ✖ / 1 ✔**（取锁后继续走到真实决策点「未找到插件市场目录 / 未找到 ZCode CLI」）。
- 新增用例 `test/auto-enable-clean-home.test.js`（64 行）：fixture 的 HOME 内**没有** `.zcode`，假 ZCode 无同级 `zcode.cjs`，断言日志既不含「已有自动启用实例在运行」，又确实走到了取锁之后的真实决策点。

**与 R02 的归因隔离**：R02 的用例只针对「续期 / 认主释放」，其 fixture 显式先建好父目录并注明「父目录缺失是另一条独立缺陷（R20），由 `test/auto-enable-clean-home.test.js` 覆盖」。R02 的红/绿都在同一 fixture 前提下跑，避免 R20 的失败混进 R02 的归因。

## 6. 红→绿证据索引（唯一来源）

| 文件 | ✖ | ✔ | 对应项 | 含义 |
|---|---|---|---|---|
| `.audit-evidence/r01-red.log` | 5 | 0 | R01 | 修复前：6/6 并发全部自认持锁 |
| `.audit-evidence/r01-green.log` | 0 | 2 | R01 | 修复后：恰好 1 个赢家 |
| `.audit-evidence/r02-red.log` | 5 | 0 | R02 | 修复前：不续租 + 退出删掉接管者的锁 |
| `.audit-evidence/r02-green.log` | 0 | 2 | R02 | 修复后：续租生效 + 认主释放 |
| `.audit-evidence/r03-red.log` | 3 | 0 | R03 | 修复前：覆盖对手 `enabled=false`/笔记 |
| `.audit-evidence/r03-green.log` | 0 | 1 | R03 | 修复后：采纳对手状态，不覆盖 |
| `.audit-evidence/r20-red.log` | 3 | 0 | R20 | 修复前：父目录缺失 → 误报「已有实例」 |
| `.audit-evidence/r20-green.log` | 0 | 1 | R20 | 修复后：正常取锁并继续 |
| `.audit-evidence/batch2-baseline.log` | 0 | 659 | 基线 | 660 tests / 659 pass / 0 fail / 1 skip |
| `.audit-evidence/batch2-final.log` | 0 | 665 | 全量 | 666 tests / 665 pass / 0 fail / 1 skip |

说明：✖ / ✔ 为 `grep -c` 实测的 TAP 标记数，嵌套用例的父子节点会重复计数，故标记数 ≥ 去重用例数（如 R01 红灯 5 个 ✖ 对应 2 条去重用例）。红灯日志是原始 `node:test` 输出，无汇总行，计数由标记实测得到。

## 7. 红灯如何取得（可复现性与一处已披露的缺口）

| 项 | 修复前版本来源 | 复现命令 |
|---|---|---|
| R01 | 当时工作区外唯一可用的 pre-fix 快照：`plugins/zcode-advisor/tools/companion/controller.cjs`（批次一修完后同步的镜像，含批次一修复、尚无 R01 修复） | `ZCA_CONTROLLER_PATH="$PWD/plugins/zcode-advisor/tools/companion/controller.cjs" node --test test/companion-singleton-race.test.js` |
| R02 | 反向补丁重建：`.audit-evidence/r02-prefix-build.cjs` 把工作树文件按 6 对「修复后 → 修复前」文本还原为 `tools/companion/.tmp-prefix-auto-enable.cjs`（脚本自带「每对必须命中且只命中 1 次」断言，并校验还原后不含 `renewFlight`/`rmdirSync`） | `node .audit-evidence/r02-prefix-build.cjs && ZCA_AUTO_ENABLE_PATH="$PWD/tools/companion/.tmp-prefix-auto-enable.cjs" node --test test/auto-enable-lease.test.js` |
| R03 | 直接在工作树上先跑（当时 `state.js` 尚未修） | `node --test test/state-ensure-race.test.js` |
| R20 | 直接在工作树上先跑（当时只应用了 R02 修复，未应用 R20 修复） | `node --test test/auto-enable-clean-home.test.js` |

**已披露缺口**：R01 使用的那个镜像快照（批次一修完 / R01 未修）在批次二末次 `node tools/sync-plugin-dir.cjs` 之后**已被覆盖**，因此 R01 红灯现在不能原样重跑；`.audit-evidence/r01-red.log` 保留了当时的原始实测输出，若要再复现需按 R02 同样的反向补丁手法从当前文件复原（R01 改动集中在 `createLockExclusive` + `acquireLock` 两处）。为什么不改用 `git`：本批所有改动都未提交，`git checkout` 会连批次一的修复一起退掉。R02 的临时重建文件在取证后已删除，重建脚本保留以便随时再生成。

## 8. 局限与未覆盖

1. **仅 macOS / Node v24.17.0 实测**。R01/R02/R03/R20 的用例都用了平台无关 API（`link`、`mkdir`、`rename`、`rmdir`），Windows 上语义相同但**未实际执行**：`.github/workflows/build-installers.yml` 已配置 ubuntu / macos-15 / windows-2022 三平台测试矩阵，但该工作流**从未在远端真正跑过**。R02 的用例对 `process.platform === 'win32'` 未做分支（假 ZCode 目录用可执行文件而非 `.cmd`），Windows 首跑可能需要补齐（同批次一报告的 A3 类问题）。
2. **顾问机械复核在本会话不可达**：`consult_task`（`review_result`）始终返回 `read-tools-disabled-or-no-cwd` / `subject-path-limit`，无法读取工作区文件，因此本批证据只能是「自证 + 原始日志」，与冻结版披露的限制相同。
3. **R01 的隔离窗口语义未做跨机压力验证**：断言在单机 6 进程 × 3 轮下稳定成立，但未做长时间/多机循环（原报告的建议即为此项加测试与压测）。
4. **R20 的发现路径依赖「干净 HOME」**：本机 `~/.zcode` 已存在，故该缺陷只在隔离 fixture 中可见；真实干净安装（macOS `.pkg` 首次运行 / Windows NSIS 首次运行）仍未在真机复验。
5. **R04–R19 未动**：本批严格限定在 R01–R03（+R20），冻结清单其余项保持原状。

## 9. 变更文件

| 文件 | 变化 |
|---|---|
| `tools/companion/controller.cjs` | 新增 `createLockExclusive`（:334）；`acquireLock` 重写为 3 轮排他创建（:377）；注释 ③ 改写 |
| `tools/companion/auto-enable.cjs` | `acquireSingleFlight` 先补父目录（:175，R20）；新增 `renewFlight`（:199）；`releaseFlight` 认主释放（:225）；`runEnable(lockDir)` 步骤边界续租（:413）；TTL 注释更正 |
| `hooks/lib/state.js` | 新增 `createStateExclusive`（:173）；`ensureState` 改为排他创建 + EEXIST 采纳对手状态（:71） |
| `test/companion-singleton-race.test.js` | 新增（95 行，R01 并发/陈旧接管） |
| `test/auto-enable-lease.test.js` | 新增（145 行，R02 续租/认主释放） |
| `test/state-ensure-race.test.js` | 新增（66 行，R03 创建窗口） |
| `test/auto-enable-clean-home.test.js` | 新增（64 行，R20 干净 HOME） |
| `.audit-evidence/r02-prefix-build.cjs` | 新增（取证脚本：反向补丁重建 R02 修复前版本） |
| `plugins/zcode-advisor/` | 镜像重新同步（`node tools/sync-plugin-dir.cjs`），保证 `test/plugin-dir.test.js` 无漂移 |

## 10. 与冻结版报告的关系

- 冻结版 `.audit-evidence/audit-report.md` **未被修改**，行号与证据索引仍可引用。
- 本批次新增 4 项（R01–R03 + R20）修复，其中 **R20 是冻结清单之外的新发现**；若后续要并入正式残余清单，建议编号为 R20 并保留本报告的独立证据。
- 批次一 → 批次二的用例总数：594（审计前基线）→ 660（批次一后）→ 666（批次二后）。
