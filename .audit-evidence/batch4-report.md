# 批次四报告 · 清理档（R04 / R10–R12 / R14–R18）+ 三项轮外新发现（R21 / R22 / R23）

本文件是**批次证据**，不是冻结报告的替代；冻结报告 `.audit-evidence/audit-report.md` 本轮未做任何改动（sha256 `8ccedbf346350c5c1f8480d06366df04dd76b99123b2115238077f2b133067e0`，报告内断言经 `shasum -a 256` 复核为真）。

---

## 一、范围与纪律

- **授权**：用户「继续下一批清理档」——对象是冻结报告剩余的清理档 R04、R10、R11、R12、R14、R15、R16、R17、R18。
- **纪律**：每一项都按「先取可复现红灯（pre-fix 快照或探针）→ 最小修复 → 绿灯 → 关联回归」执行；红灯快照一律放在 `.audit-evidence/<项>-snapshot/` 并登记 sha256；绿灯、回归各自独立日志。红灯用例全部用 env 覆盖（`ZCA_*`）指向快照，避免为了取红灯而反复改工作区文件。
- **轮外项**（不在冻结清单，来源与理由单独列出，不并入冻结项的计数）：
  - **R21**（OCR 评审卡死 >6 分钟）：在做 R10 的绿灯时现场复现。
  - **R22**（R01 单实例锁残留竞态）：批次四开工前的全量基线把 R01 用例重新打红，探针证明是真双持锁，不是用例假象。
  - **R23**（既有用例双因脆弱）：全量回归里唯一残留失败，定位为**测试侧**问题。
- **未做**：**R19**（把三平台 CI 矩阵真跑一次）需要一次提交 + 推送，本会话**无提交/推送授权**，保持「纸面配置」状态。
- **已核实无需再改**：R15（提示文本）与 R17（无 runtime 时的失败提示）在批次一已修好。

## 二、结论摘要表

| 项 | 级别 | 站点 | 红灯 | 绿灯 | 结论 |
| --- | --- | --- | --- | --- | --- |
| R04 | P2 | `hooks/advisor-hook.js` `onStopAsync`（:687）+ `hooks/lib/state.js` `admitGlobalWorker`（:287） | `.audit-evidence/r04-red.log` 2/0/2 + 探针 pre-fix 3/4、4/4 超限 | `.audit-evidence/r04-green.log` 2/2/0 + 探针 post 0/4、0/3 | ✅ 已修 |
| R10 | P2 | `scripts/ocr-review.sh` `valid_output()` | `.audit-evidence/r10-red.log` 34/33/1 | `.audit-evidence/r10-green.log` 35/35/0 | ✅ 已修 |
| R11 | P2 | `tools/sync-plugin-dir.cjs` `copyIfChanged`/`walk`/`sync` | `.audit-evidence/r11-red.log` 1/0/1（EISDIR 崩） | `.audit-evidence/r11-green.log` 1/1/0 | ✅ 已修 |
| R12 | P2 | `tools/companion/bump-version.cjs` `main()` | `.audit-evidence/r12-red.log` 3/1/2 + `r12-prefix-partial.log` 部分写实证 | `.audit-evidence/r12-green.log` 3/3/0 | ✅ 已修 |
| R14 | P3 | `test/setup-port.test.js` 端口断言 | `.audit-evidence/r14-red.log`（探针：旧断言假失败） | `.audit-evidence/r14-green.log` 3/3/0 | ✅ 已修 |
| R15 | P3 | `tools/companion/install-templates.cjs` 提示 | — | — | ✅ 批次一已修，本轮核实 |
| R16 | P3 | `tools/companion/archive.cjs` `readTarGz`/`readZipEntries` | `.audit-evidence/r16-red.log` 3/0/3 | `.audit-evidence/r16-green.log` 3/3/0 | ✅ 已修 |
| R17 | P3 | `tools/companion/install-templates.cjs` 无 runtime 提示 | — | — | ✅ 批次一已修，本轮核实 |
| R18 | P3 | `test/ocr-review.test.js` 能力探测（实现细节字符串） | `.audit-evidence/r18-red.log` 3/0/3 | `.audit-evidence/r18-green.log` 3/3/0 | ✅ 已修 |
| **R21**（新） | P2 | `scripts/ocr-review.sh` `run_with_deadline` 收尾 | `.audit-evidence/r21-red.log` 1/0/1（8.1s） | `.audit-evidence/r21-green.log` 1/1/0（0.25s） | ✅ 已修 |
| **R22**（新） | P1 | `tools/companion/controller.cjs` `acquireLock` | `.audit-evidence/r22-red.log` 2/1/1（3/3 稳定复现）+ 探针 3/12 双持 | `.audit-evidence/r22-green.log` 2/2/0 + 探针 0/8、0/12 | ✅ 已修 |
| **R23**（新） | P3 | `test/ocr-review.test.js:40` 既有用例 | `.audit-evidence/batch4-final.log:756`（ENOENT）+ `r23` 单跑 `?E` | `.audit-evidence/r23-green.log` 5×（1/1/0）+ 全量 | ✅ 已修 |

## 三、逐项机制、修复与证据

### R04 · 全局并发上限是「先数后取」，不是原子准入
- **机制**：`onStopAsync` 原来先 `countLocks(stateDir, staleMs) >= (cfg.maxGlobalWorkers || 4)` 判断，再 `createLock(file, staleMs)` 建自己的锁——两步之间没有原子性：两个并发 Stop 各看到 `count = max-1`，于是都通过检查、各持一把锁，全局上限形同虚设。
- **修复**：`hooks/lib/state.js` 新增 `withExclusiveLock(lockFile, fn, opts)`（`'wx'` 排他租约 + 40×25ms 重试 + mtime 陈旧接管 + 归属校验，拿不到返回 `null`）；`mutateStateExclusive` 改为它的薄封装；新增 `admitGlobalWorker(file, stateDir, staleMs, limit)`：在 `${stateDir}/.global-workers.lock` 这把**准入锁**内完成「数 + 取」（`countLocks >= max` → `'global_busy'`；否则 `createLock` 成功 → `'ok'`、失败 → `'busy'`；准入锁都抢不到 → `null`，调用方退回先数后取）。`hooks/advisor-hook.js:687` 改为 `const admission = admitGlobalWorker(...)`，非 `'ok'` 就记 `bumpDrop(...)` 直接返回。`.global-workers.lock` 不匹配 `^sess-.*\.json(\.lock)?$`，不干扰 `countLocks`/`listStatePaths`/`pruneStates`。
- **红灯**：用例 `.audit-evidence/r04-red.log`（`test/hook-global-workers.test.js` 对 pre-fix 实现）2 tests / 0 pass / 2 fail；探针 `.audit-evidence/r04-probe.cjs` 在自然时序 `r04-probe-prefix-natural.log:6` `summary: 3/4 trials over limit (limit=1)`，放大窗口 `r04-probe-prefix.log:6` `4/4`。
- **绿灯**：`.audit-evidence/r04-green.log` 2/2/0（`✔ 全局上限=1 时并发 8 个 Stop 只能有 1 个开工 (1499ms)`、`✔ 全局上限=2 时… (1023ms)`）；探针 post-fix `r04-probe-post-natural.log:6` `0/4`、`r04-probe-post-amp.log:5` `0/3`。
- **关联回归**：`.audit-evidence/r04-regression.log` = `test/state.test.js` + `test/state-ensure-race.test.js` + `test/hook-global-workers.test.js` + `test/user-note-e2e.test.js` + `test/user-note.test.js` + `test/static-guards.test.js` + `test/log-review.test.js` → `tests 66 / pass 66 / fail 0`。
- **复现**：`node --test test/hook-global-workers.test.js`；探针 `node .audit-evidence/r04-probe.cjs`。

### R10 · OCR 输出的元素级校验缺失（假绿灯）
- **机制**：`valid_output()` 只校验「顶层是对象 + `status == complete` + `comments` 是数组」；渲染段用 `[c for c in comments if isinstance(c, dict)]` 把非对象元素**过滤掉**，于是 `comments: [null, "垃圾", "{截断"]` 会渲染成 0 条意见并打印「评审完成（…）—— 共 0 条意见 / 未发现问题。」**exit 0**。调用方（pre-push hook / CI）拿到的是绿色信号。
- **修复**：`scripts/ocr-review.sh` 的 `valid_output()` 内加 `comments = data.get("comments")`、`if not isinstance(comments, list): sys.exit(1)`、`if any(not isinstance(c, dict) for c in comments): sys.exit(1)`。
- **用例**：`test/ocr-review.test.js` 增加 `REVIEWER_SRC = process.env.ZCA_OCR_REVIEWER || scripts/ocr-review.sh`，两条新用例：元素损坏的输出必须非零退出且 stdout 不含「评审完成」；`comments: []` 的干净结论仍须通过（防止把合法空结论一起打回）。
- **红灯**：`.audit-evidence/r10-red.log`（`ZCA_OCR_REVIEWER=.audit-evidence/r10-snapshot/ocr-review.sh`，sha256 `7c7f9a88…`）`tests 34 / pass 33 / fail 1`，断言原文 `元素损坏的输出必须判本次评审无效（链耗尽后非零退出），实际 exit=0；stdout=…评审完成（fake/m1）—— 共 0 条意见 … 未发现问题。`
- **绿灯**：`.audit-evidence/r10-green.log` `tests 35 / pass 35 / fail 0`（前台单跑；见 R21/R23 关于「不要后台并行跑这个套件」的纪律）。
- **复现**：`node --test test/ocr-review.test.js`。

### R11 · sync 遇到文件/目录类型冲突整轮崩掉
- **机制**：`tools/sync-plugin-dir.cjs` 的 `copyIfChanged` 假定「同名就同类型」：源是目录而副本是文件时 `fs.mkdirSync(dest,{recursive:true})` 抛 EEXIST；源是文件而副本是目录时重试循环只对 EPERM/EACCES 重试，EISDIR 直接 rethrow（`sync-plugin-dir.cjs:128`）。更糟的是 `quarantineOrphans()` 原在复制循环**之后**调用，隔离机制根本没机会跑。
- **修复**：`sync()` 先 `const { moved, failed } = quarantineOrphans();` 再进复制循环；顶层改为 `if (srcIsDir && destIsDir) { walk(...); continue; }` → 不存在就跳过 → `if (destIsDir2 !== srcIsDir) retire(dest, item);`；`walk()` 也补了嵌套冲突分支（同名副本是目录而源是文件 → `retire`）。
- **用例**：`test/plugin-dir.test.js` 增加 `ZCA_SYNC_TOOL` 覆盖与「文件/目录类型冲突先隔离再写」，覆盖 `commands`（文件）↔ 源目录、`README.md/`（目录）↔ 源文件、嵌套 `hooks/a.js/` 三种形态，断言 exit 0、最终形态正确、`--check` 0、恰好一个 `.orphan-*` 且旧形态可回捞。
- **红灯**：`.audit-evidence/r11-red.log`（快照 `r11-snapshot/sync-plugin-dir.cjs`，sha256 `d506087d…`）`tests 1 / pass 0 / fail 1`，崩溃原文 `Error: EISDIR: illegal operation on a directory, rename '…/dest/hooks/a.js.tmp-32459' -> '…/dest/hooks/a.js'`。
- **绿灯**：`.audit-evidence/r11-green.log` 1/1/0；回归 `.audit-evidence/r11-regression.log` `tests 12 / pass 12 / fail 0`。

### R12 · bump-version 半途失败留下两个版本号
- **机制**：`main()` 原来是 `for (const f of FILES) writeVersion(f, target)`——边渲染边写。第三份 manifest 缺 `version` 字段时抛错，前两份**已经改完**、后两份没改，仓库进入「两个版本号并存」状态（宿主据此判断是否需要重装，新代码可能永远进不了 cache），而且抛的是未捕获异常栈。这个脚本存在的意义正是防止版本号不同源，结果它自己会制造不同源。
- **修复**：`ROOT` 支持 `ZCODE_ADVISOR_BUMP_ROOT`（供 fixture 注入）；`writeVersion` 拆成纯函数 `renderVersion(rel, version)`（返回 `{rel,p,before,after}`，找不到可替换字段抛 `${rel} 中未找到可替换的 version 字段`）；新增 `applyVersions(rendered)` 统一写入，失败按 `done` 逆序回滚并返回 `{err, rollbackFailed}`；`main()` 先整体渲染（失败 → `[bump-version] ✗ 未写入任何文件：…` + 「四处版本号必须同源，因此先整体校验、再统一写入」），再统一写入（失败 → `[bump-version] ✗ 写入失败：…` + 「已回滚到写入前的版本号，四处仍保持一致」）。
- **用例**：新增 `test/bump-version.test.js`（四处版本号 `0.2.20 → 0.2.30`，`ZCA_BUMP_TOOL` 覆盖）：任一份不可替换 → 逐字节不落盘；写入失败 → 回滚（`win32` 上 skip 并注明「Windows 只读位语义不同，未在真机验证」）；四处齐全 → 全部改新且 `--check` 通过。
- **红灯**：`.audit-evidence/r12-prefix-partial.log` 用 pre-fix 实测出部分写：`pre-fix exit=1`、`失败后四处版本号：0.2.30 | 0.2.30 | (无 version) | 0.2.20`；`r12-red.log`（快照 `r12-snapshot/bump-version.cjs`，sha256 `cc787238…`）`tests 3 / pass 1 / fail 2`。
- **绿灯**：`.audit-evidence/r12-green.log` 3/3/0；真实仓库 `node tools/companion/bump-version.cjs --check` → `[bump-version] 四处版本号一致：0.2.22`。

### R14 · 端口测试把「下一个端口」写死，制造假失败
- **机制**：`test/setup-port.test.js` 旧断言写死「面板应监听 `port+2`」。那个端口刚刚被 `close()`，`close → listen` 之间任何进程都可能把它抢占，于是**产品行为正确**（越过被占端口继续往后找）而测试红。
- **修复**：改为断言性质而不是具体端口——新增 `waitForListening(child, ms)`（累积 stdout 到「配置面板已启动」）与 `boundPort(output)`；用例 1 断言 `bound >= port + 2` 且两个被占 socket 仍 listening、HTTP 200；新增用例 2「setup keeps advancing when the next free port is taken by someone else (R14 window)」（三个端口全被外人占住 → `bound >= port + 3` + 200）；11 端口耗尽的边界用例保持不变。
- **红灯**：`.audit-evidence/r14-red.log`（探针 `r14-old-assertion-probe.cjs` 扮演抢跑者一直占住 `port+2`）：`被占端口：60527 / 60528 / 60529`、`面板实际监听：60530`、`旧断言（写死 port+2=60529）：失败（假失败）—— 期望 60529，实际 60530`、`新性质（越过被占的 60527/60528）：通过`。
- **绿灯**：`.audit-evidence/r14-green.log` `tests 3 / pass 3 / fail 0`。

### R16 · 归档读取不校验完整性（tar 校验和/截断、zip CRC）
- **机制**：`readTarGz` 只信头里的 size：`buf.subarray(pos, pos+size)` 在数据不足时**静默返回短 buffer**，损坏归档被当成正常数据；`readZipEntries` 校验了 local/central 签名与解压长度，但不比对中央目录里的 CRC（偏移 +16）。
- **修复**：新增 `readTarChecksum(header)` / `computeTarChecksum(header)`（字段 148..156 按 0x20 计和）；`readTarGz` 头校验和不符即抛 `archive: tar 头校验和不符（…）—— 归档已损坏`，数据区不足即抛 `archive: tar 数据区被截断（…）—— 归档已损坏`；`readZipEntries` 比对 `buf.readUInt32LE(pos + 16)` 与本地 `crc32(data)`，不符抛 `archive: ZIP CRC 校验失败（…）—— 归档已损坏`。
- **用例**：新增 `test/archive-integrity.test.js`（`ZCA_ARCHIVE_PATH` 覆盖；本地 `fixChecksum` 与手搓 method=0 的 `storedZip` fixture）：tar 头校验和被篡改、tar 声明长度超出实际、zip 内容被改写（CRC 不符），外加未损坏件必须仍能读。
- **红灯**：`.audit-evidence/r16-red.log`（快照 `r16-snapshot/archive.cjs`，sha256 `b6bca7d4…`）`tests 3 / pass 0 / fail 3`，三条均为 `AssertionError: Missing expected exception.`
- **绿灯**：`.audit-evidence/r16-green.log` 3/3/0（193ms）；回归 `.audit-evidence/r16-regression.log`（archive + archive-integrity + build-icon + build-installer）`tests 25 / pass 25 / fail 0`。
- **边界（不要过度宣称）**：这两道校验是**损坏检测**，不是防恶意篡改（能同时改内容和校验和）；且当前数据来源是构建器自产归档，不是远程输入。

### R18 · 用例用实现细节字符串探测能力 → 改名即静默 skip
- **机制**：`test/ocr-review.test.js` 用 `SUPPORTS_RAW_OUT_HARDENED = /mv -f "\$_raw_tmp"/`、`/LOCK_ACQUIRED/`、`includes('run_with_deadline')`、`includes('OCR_REVIEW_RAW_OUT')` 之类的**实现细节字面量**决定「这个能力用例要不要 skip」。语义等价的改名/重构会让这些用例**静默变成 skip**，套件依然全绿——测试从「守门」退化成「装饰」。
- **修复**：`scripts/ocr-review.sh:6` 显式声明 `# zca-caps: raw_out raw_out_hardened chain_file deadline total_budget usage_log lock_cleanup`（注释写明「改实现细节时不要改动这一行」）；`test/ocr-review.test.js` 解析该行得到 `DECLARED_CAPS`，`SUPPORTS_*` 改为 `hasCap('名', () => 旧字面量探测)`——**有声明按声明，没声明（历史快照）退回旧探测**，skip 语义保持不变。
- **用例**：新增 `test/ocr-review-caps.test.js`（`ZCA_OCR_CAPS_TARGET` 覆盖）：① 目标脚本必须带声明且含 7 个能力名；② 声明必须覆盖套件里全部 `hasCap\(\s*'([a-z_]+)'` 名字（两边漂移即红）；③ 把源码里 `_raw_tmp`→`_raw_stage`、`LOCK_ACQUIRED`→`LOCK_HELD` 改名后，声明不变（并断言改名确实破坏了旧探测依赖的字面量）。
- **等价性验证**：`.audit-evidence/r18-fallback-equivalence.log`（改造后、加声明**之前**跑整个 ocr-review 套件）`tests 35 / pass 34 / fail 1 / skipped 0`——**0 skip** 证明改造没有把任何既有能力悄悄降级为 skip；当时唯一失败即 R23（见下）。
- **红灯**：`.audit-evidence/r18-red.log`（快照 `r18-snapshot/ocr-review.sh`，sha256 `a7fa5705…`）`tests 3 / pass 0 / fail 3`，断言原文 `…缺少 \`# zca-caps:\` 声明行——能力探测会退回按实现细节字符串匹配（改名即静默 skip）`、`能力声明与测试门控漂移，声明里缺少：raw_out, raw_out_hardened, chain_file, deadline, total_budget, usage_log, lock_cleanup`、`改名后能力声明不应丢失：raw_out`。
- **绿灯**：`.audit-evidence/r18-green.log` 3/3/0；回归 `.audit-evidence/r18-regression.log`（ocr-review + caps）`tests 38 / pass 38 / fail 0 / skipped 0`（24.2s）。

### R21（轮外新发现）· OCR 评审套件会卡死 >6 分钟
- **现场**：两次把 OCR 全量套件当后台 job、同时跑其它 node 用例时，套件卡死 >6 分钟。`ps` 现场：`bash <sandbox>/repo/scripts/ocr-review.sh HEAD~1 HEAD`(26724) → 同 argv 的 watcher 子 shell(26750) → `sleep 900`(26751)；`sample 26724` 显示阻塞在 bash `waitchld`；**`kill -TERM 26750` 三秒后进程仍活**。只能 `kill -KILL` 收场。
- **机制**：`run_with_deadline` 里过期 watcher 是 `( sleep $secs … ) &`，父进程在命令结束后 `kill "$watcher_pid"` 然后 **`wait "$watcher_pid"` 无上限**——watcher 一旦不响应 TERM，父进程就被拖到计时器（默认 900s）走完为止。
- **修复**：① watcher 头加 `trap - INT TERM`（复位可能被继承的 SIG_IGN，否则 TERM 处理会静默失效）+ `trap 'exit 0' TERM`，等待改成 `while [ $((SECONDS - started)) -lt "$secs" ]` 轮询，到期写 deadline_flag；② 父进程改成**有界收尾**：`kill "$watcher_pid"` → 最多 40×50ms 轮询 → `kill -KILL "$watcher_pid"` 兜底 → 再 `wait`。删除旧的 `sleep $secs &` + `timer_pid` 机制，不留死代码。
- **红灯**：`.audit-evidence/r21-red.log`（快照 = `git show HEAD:scripts/ocr-review.sh` → `r21-snapshot/ocr-review.sh`，sha256 `c5b5f386…`，HEAD 版就是裸 `sleep` watcher + 无上限 wait）`node --test --test-name-pattern="TERM 对 watcher 无效"` → `tests 1 / pass 0 / fail 1`，断言原文 `TERM 对 watcher 无效时父进程必须自行兜底退出，却等了 8s —— 无上限 wait 被计时器拖满`（8095ms）。该用例是**确定性**的：probe 用 `timeout() { return 1; }` 强制走 fallback + `trap '' TERM`（bash 里被忽略的信号无法再 trap）模拟「TERM 对 watcher 无效」。
- **绿灯**：`.audit-evidence/r21-green.log` 1/1/0，250ms（有界等待 + SIGKILL 兜底）。
- **已披露的不确定性**：**症状**根因（父进程无上限 `wait`）已定位并修复；「watcher 为何偶发不响应 TERM」的更深机制**仍未定论**（归因实验排除了「wait 期间 trap 被推迟」，也未能复现「继承 SIG_IGN」）。修复的价值在于：即使 watcher 再次不响应，父进程也会在 ~2s 内 SIGKILL 收场，不再挂满计时器。

### R22（轮外新发现）· 单实例锁仍可双持（R01 的残留竞态）
- **来源**：批次四基线把 R01 的「陈旧锁接管」用例重新打红（`实际 2` 个赢家）。先怀疑是**用例假象**（赢家 400ms 后退出并 unlink 锁，落败方迟到拿到空锁），改用探针 `.audit-evidence/r01-flake-probe.cjs` 记录每个子进程「拿到锁的时刻 + 是否真的持有」，结论：**空载 12 轮里 3 轮出现两个真赢家（时刻几乎相同、都活到 +415ms），不是假象**；trial 12 现场还留下一串 `zcode-advisor-companion.lock.stale-*` 隔离文件与 `.tmp-*`。
- **机制**：旧 `acquireLock` 是「读陈旧 → `renameSync(LOCK, quarantine)` → 排他创建」三段式，而这三步之间没有串行化：B 读到的是陈旧租约，但在 B 执行 rename 之前 A 已接管并建好**新鲜**锁，于是 B 把 A 的新锁 rename 成 `${LOCK}.stale-<B pid>-<ts>`；B 发现 `moved.pid !== cur.pid` 走「放回原位」的 `linkSync`，若此刻 LOCK 已被第三方重建就 `EEXIST`，而那个 `catch (_) {}` 把错误和同一 try 里的 `unlinkSync(quarantine)` 一起吞掉 → 隔离文件永久留在盘上，A 仍自认持锁，而 LOCK 路径已空 → 下一个进程排他创建成功 → 两个实例同时持锁。
- **修复**：给「所有会改动 LOCK 的操作」加一道串行闸门——`STEAL_GUARD_FILE = \`${LOCK_FILE}.steal\`` + `STEAL_GUARD_STALE_MS = 5000`；`acquireStealGuard()` 用 `writeFileSync(..., {flag:'wx'})` 抢闸门，EEXIST 时看 mtime 超过 5s 就当崩溃残留清掉，再 20ms 重试（最多 60 次），抢不到就重读一轮；`releaseStealGuard()` 只在文件内容是自己 pid 时删除。`acquireLock` 重排为：先做**无副作用**的前置判断（自己是持有者 → 续租；别人活着 → 打印「已有 companion 实例在运行」并返回 false），否则进闸门、**闸门内重读** LOCK，再决定续租 / 放弃 / 隔离陈旧 + `createLockExclusive`，最后注册 `process.on('exit')` 清理，最多 3 轮；全部失败则 fail-closed 退出。
- **红灯**：`.audit-evidence/r22-red.log`（快照 `r22-snapshot/`（含 `lib.cjs`/`zcode-path.cjs`/`panel.cjs` 依赖），`controller.cjs` sha256 `bdb183f7…`）`ZCA_CONTROLLER_PATH=… node --test test/companion-singleton-race.test.js` → `tests 2 / pass 1 / fail 1`，断言原文 `第 1 轮：陈旧锁接管应恰好 1 个赢家，实际 2`；`r22-red-repeats.log` **3/3 全部 fail**（稳定复现）。用例同时加固为**放行文件协议**（`ZCA_RELEASE_FILE`：赢家拿到锁后不退出，等父进程确认全部子进程都已报告后再放行），并提高到正常启动 8×3 轮、陈旧接管 12×4 轮，排除「赢家已退出、落败方取空锁」的假红。
- **绿灯**：`.audit-evidence/r22-green.log` 2/2/0；探针 post-fix `r22-probe-post.log` 8/8 轮 `winners=1`、`files=[]`，`r22-probe-post-load.log` 12/12 轮 `winners=1`（无任何孤儿 `.stale-*`/`.tmp-*`）；回归 `.audit-evidence/r22-regression.log` `tests 47 / pass 47 / fail 0`。

### R23（轮外新发现）· 既有用例双因脆弱（测试侧，不是产品回归）
- **两个独立成因**：
  1. **并行负载下 1s 预算不够**：`.audit-evidence/batch4-final.log:756` 与 `r18-fallback-equivalence.log:69` → `Error: ENOENT: … open '…/T/deadline-child-XXXX/child.pid'`——整套件并行跑时，leader 启动 node + spawn 孙进程被拖到 1s 之外，孙进程还没登记 pid 就被计时器打断。
  2. **macOS 的 `?E` 状态**：单跑时报 `AssertionError: TERM-ignoring child remains alive: 49545 ?E`（`.audit-evidence/batch4-flake-recheck.log:15`）。macOS 对刚被 SIGKILL 的进程常报 `?E`（E 标志＝正在退出），旧断言只认 `Z`；而孙进程只忽略 TERM 且 `setInterval` 永活，`?E` 恰恰证明 KILL 已投递。
- **修复（仅测试）**：`run_with_deadline 1` → `run_with_deadline 3`（该用例只检查「到期后的 TERM→KILL 收尾」，与预算几秒无关）；加 `夹具未就绪：孙进程没有在预算内登记 pid` 的显式断言（不再以 ENOENT 形式爆栈）；进程状态改为最多 40×50ms 轮询，接受「进程消失 / `Z` / 含 `E`」。
- **绿灯**：`.audit-evidence/r23-green.log` 连跑 5 次全部 `tests 1 / pass 1 / fail 0`（每次 ~4.9s）+ 全量回归（下节）。

## 四、红→绿证据索引（本批唯一来源）

| 项 | 红灯日志 | ✖ / ✔（实测 grep -c，含 TAP 父子重复） | 绿灯日志 |
| --- | --- | --- | --- |
| R04 | `r04-red.log` | 5 / 0 | `r04-green.log` |
| R10 | `r10-red.log` | 3 / 33 | `r10-green.log` |
| R11 | `r11-red.log` | 3 / 0 | `r11-green.log` |
| R12 | `r12-red.log` | 5 / 1 | `r12-green.log` |
| R14 | `r14-red.log`（探针输出，非 TAP） | — | `r14-green.log` |
| R16 | `r16-red.log` | 7 / 0 | `r16-green.log` |
| R18 | `r18-red.log` | 7 / 0 | `r18-green.log` |
| R21 | `r21-red.log` | 3 / 0 | `r21-green.log` |
| R22 | `r22-red.log` + `r22-red-repeats.log`（3/3） | 3 / 1 | `r22-green.log` |
| R23 | `batch4-final.log`（ENOENT）+ `batch4-flake-recheck.log`（`?E`） | — | `r23-green.log`（5×） |

关联回归：`r04-regression.log` 66/66、`r11-regression.log` 12/12、`r16-regression.log` 25/25、`r18-regression.log` 38/38、`r22-regression.log` 47/47。

### 残留 skip 点名（终版全量 `ℹ skipped 1` 的唯一一条）

R18 的主题是「静默 skip 等于覆盖流失」，因此本批自己的残留 skip 必须点名，不能只留一个数字：

| 用例 | 位置 | 跳过条件 | 为什么留 | 各平台行为 |
| --- | --- | --- | --- | --- |
| `buildDmg：非 macOS 时明确返回不可用原因` | `test/packagers.test.js:226` | `skip: process.platform === 'darwin'` | 它断言的是**非 macOS** 分支（`buildDmg` 必须返回 `ok:false` 且 reason 含 `macOS`），在 macOS 上这条分支无法被真实触发，只能跳过；产品行为本身由互补用例覆盖 | macOS：跳过；CI 的 ubuntu / windows runner：**会执行**（正好对应 R19 首次真跑） |

互补用例 `buildDmg：产出可被 hdiutil verify 的 DMG，并含 Applications 符号链接`（`test/packagers.test.js:232`）条件相反（`skip: process.platform !== 'darwin' || !hasTool('hdiutil')`）。所以 CI 三平台各自的 `skipped` 条数相同，但**跳过的不是同一条用例**——在 ubuntu / windows 上被跳过的是 DMG 产出用例、被执行的是「非 macOS 返回不可用原因」用例；看 CI 结果时不要误读成「Windows 上 DMG 相关测试没跑」。

## 五、红灯是怎么取的（可复现性说明）

- **env 覆盖 + 快照**：R10 `ZCA_OCR_REVIEWER`、R11 `ZCA_SYNC_TOOL`、R12 `ZCA_BUMP_TOOL`、R16 `ZCA_ARCHIVE_PATH`、R18 `ZCA_OCR_CAPS_TARGET`、R22 `ZCA_CONTROLLER_PATH`，快照分别放 `.audit-evidence/{r10,r11,r12,r16,r18,r22}-snapshot/` 并登记 sha256（见上）。
- **git 历史当快照**：R21 用 `git show HEAD:scripts/ocr-review.sh`（工作区未提交，HEAD 即 pre-fix 版）。
- **探针**：R04（`r04-probe.cjs`）、R14（`r14-old-assertion-probe.cjs`）、R22（`r01-flake-probe.cjs`）用探针放大时序/人为占端口/记录时刻，把「偶发」变成「可判定」。
- **已披露缺口**：
  - R22 的红灯需要把 `r22-snapshot/controller.cjs`（pre-fix 版）重新拷回才能重跑；`plugins/zcode-advisor/` 镜像在批次末已同步，**不再**保留 pre-fix 形态。
  - R22 快照必须与 `lib.cjs`/`zcode-path.cjs`/`panel.cjs` 同目录（`controller.cjs` 顶部 `require('./lib.cjs')`），单独放一个文件会 `Cannot find module`。
  - `scripts/ocr-review.sh` 是**外部模板生成的**（`~/.dsh/bin/ocr-sync-reviewer.sh` + `~/.dsh/templates/ocr-review/chain-public`，standard 模式会整份重写）→ R10/R21/R18 的改动**必须同步进模板**，否则一次 resync 就把它们冲掉。
  - `plugins/zcode-advisor/scripts/` 不存在（sync 不镜像 `scripts/`），所以镜像不能当 OCR 脚本的快照。
  - R14 的「抢跑者」是探针**人工占住**端口，模拟的是同一个窗口，不是真实操作系统竞态的最小复现。

## 六、局限

- **平台**：本批全部证据都在 macOS + Node v24.17.0 上取得。Windows/Linux **从未真机执行**（R12 的写入失败回滚用例在 `win32` 上显式 skip 并注明未验证）。
- **R19 未做**：三平台 CI 矩阵（`.github/workflows/build-installers.yml` 的 `ubuntu-latest` / `macos-15` / `windows-2022`）仍是纸面配置，需要一次提交 + 推送才能真跑；本会话无该授权。
- **R21 的深层机制**未定论（见该节「已披露的不确定性」）。
- **R16 / R22 的边界**：R16 是损坏检测不是防篡改；R22 修复的是「同一台机器上两个 companion 同时持锁」，不涉及跨机/跨用户。

## 七、变更文件（批次四）

源码 / 脚本：

- `hooks/advisor-hook.js`（R04）
- `hooks/lib/state.js`（R04：`withExclusiveLock` :214、`admitGlobalWorker` :287）
- `scripts/ocr-review.sh`（R10 元素校验、R21 有界收尾 :415/:420/:455、R18 `# zca-caps` :6）
- `tools/sync-plugin-dir.cjs`（R11）
- `tools/companion/bump-version.cjs`（R12）
- `tools/companion/archive.cjs`（R16）
- `tools/companion/controller.cjs`（R22：`createLockExclusive` :334、`STEAL_GUARD_FILE` :385、`acquireStealGuard` :388、`releaseStealGuard` :410、`acquireLock` :433 起）

测试：

- `test/hook-global-workers.test.js`（新增，R04）
- `test/ocr-review.test.js`（R10 两条 + R21 一条 + R18 探测改造 + R23 加固）
- `test/plugin-dir.test.js`（R11）
- `test/bump-version.test.js`（新增，R12）
- `test/setup-port.test.js`（R14 改写）
- `test/archive-integrity.test.js`（新增，R16）
- `test/ocr-review-caps.test.js`（新增，R18）
- `test/companion-singleton-race.test.js`（R22 加固：放行文件协议 + 12×4 轮）

快照 / 探针 / 证据：`.audit-evidence/{r04,r10,r11,r12,r14,r16,r18,r21,r22,r23}-*`、`.audit-evidence/r02-prefix-build.cjs`、`.audit-evidence/r22-snapshot/`、`.audit-evidence/r21-snapshot/` 等。

## 八、与冻结版的关系

- 冻结报告 `.audit-evidence/audit-report.md` **未改动**（sha256 与冻结时一致）。
- 冻结清单里 R04 / R10 / R11 / R12 / R14 / R16 / R18 已闭环；R15 / R17 经核实由批次一修复；**R19 未做**（无提交/推送授权）。
- 轮外新增 R21 / R22 / R23 已在本文件单列来源与证据，不回写冻结报告的编号体系；其中 **R22 属 P1 级真实缺陷**（同一台机器上两个 companion 同时运行），建议下一轮把它与 R01 一起放入回归清单常驻。
