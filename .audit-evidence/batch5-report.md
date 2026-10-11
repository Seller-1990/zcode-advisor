# 批次五报告 —— CI 三平台真跑暴露的三项用例缺陷（W1 / M1 / M2）

> 本批由 R19「CI 三平台真跑」触发，只处理**真实 runner 暴露的失败**，不扩大范围。
> 冻结报告 `.audit-evidence/audit-report.md` 未改动：sha256 `8ccedbf346350c5c1f8480d06366df04dd76b99123b2115238077f2b133067e0`。

## 一、范围与纪律

- 触发：首次真跑 CI（run **38123024541**，push `main` @ `43b4282`）。
- 首跑结论：`test (ubuntu-latest)` **全绿**；`test (macos-15)` 2 处失败（711 / pass 707 / fail 2 / skipped 2）；`test (windows-2022)` 1 处失败（711 / pass 660 / fail 1 / skipped 50）。`plan-macos` / `windows` / `macos` / `release` 全部 skipped —— 推 `main` 不触发构建与发布，门禁行为符合预期。
- 三处失败**全部落在测试的可移植性/时序**，没有一处是产品行为回归：本批产品代码（`hooks/`、`tools/`、`scripts/`）**零改动**。
- 纪律照旧：先红灯（优先取 CI 原始日志这个真实现场，本地能复现的再补本地红灯）→ 再修 → 后转绿 → 关联回归 → 镜像同步 → 本地全量 → 重新推送真机复验。
- **第二跑结论（run 38123718881，push @ `0e4c979`）：三平台全绿** ——
  | 平台 | tests | pass | fail | skipped |
  | --- | --- | --- | --- | --- |
  | `test (ubuntu-latest)` | 711 | 704 | **0** | 7 |
  | `test (macos-15)` | 711 | 709 | **0** | 2 |
  | `test (windows-2022)` | 711 | 661 | **0** | 50 |

  构建/发布作业（`windows` / `plan-macos` / `macos` / `release`）按门禁全部 skipped ✓。

## 二、结论摘要表

| 项 | 平台 | CI 现场（原文） | 归因 | 修复 | 真机复验 |
| --- | --- | --- | --- | --- | --- |
| **W1** | windows-2022 | `not ok 366 - install --now：沙箱 dir 只落盘，绝不 bootstrap 进真实 gui 域`；`The input did not match the regular expression /跳过 launchd 加载/. Input: '无法获取 uid，跳过加载'`（`test/launchd.test.js:234`） | **测试可移植性**：Windows 无 `process.getuid`，「无 uid」分支抢在「沙箱路径」分支之前命中 | `probeInstallNow` 增加 `stubUid`，让**路径判定**成为决定分支 | ✅ `ok 366`，duration_ms **65.6** |
| **M1** | macos-15 | `not ok 414 - run_with_deadline：TERM 对 watcher 无效时也必须在上限内返回`；`却等了 4s —— 无上限 wait 被计时器拖满`（`test/ocr-review.test.js:131`） | **用例阈值/时序**：秒级 `date +%s` 截断 + 阈值卡 4s，而 runner 的 bash 5 与本地 bash 3.2 对「继承的 SIG_IGN 能否 reset」行为不同 | 确定性造出「TERM 无效」+ Node 侧毫秒计时 + 阈值 10s | ✅ `ok 414`，duration_ms **4042.1**（阈值 10000，余量 2.5×） |
| **M2** | macos-15 | `not ok 158 - P0 回归：审查在飞时 /advisor-off 不被 worker 旧快照回滚`；`error: 'worker 应在审查超时后落盘'`（`test/e2e.test.js:402`，duration_ms 20358.4） | **根因未定位**（真·偶发，见三·M2） | 预算 20s→60s + 失败现场诊断 | ⚠️ 第二跑 `ok 158`，duration_ms **6163.0** —— 通过，但**不是**预算提高修好的 |

## 三、逐项机制 · 修复 · 证据

### W1 · `test/launchd.test.js` —— Windows 上没有 uid，断言红成了「文本不符」

`tools/companion/launchd.cjs` 的 `ensureLoaded` 有两条跳过分支，顺序固定：

- `:222 if (uid() === null) return { loaded:false, skipped:true, warn:'无法获取 uid，跳过加载' };`
- `:225 return { loaded:false, skipped:true, warn:'目标不是用户真实 LaunchAgent，跳过 launchd 加载（避免影响真实自启作业）' };`

`uid()`（`:110-112`）是 `typeof process.getuid === 'function' ? process.getuid() : null` —— Windows 上**没有** `process.getuid`，于是永远先命中第一条，第二条「沙箱路径不得进 launchd 域」的判定在 Windows 上**轮不到执行**。用例断言 `/跳过 launchd 加载/` 于是失败，但失败信息指向「警告文本」，看起来像产品 bug，实际是**用例没覆盖到它想覆盖的分支**。

修复（`test/launchd.test.js:208-243`）：`probeInstallNow(opts, extraEnv, extra)` 新增 `extra.stubUid`，为真时在子进程里 `process.getuid = () => 501;`，让「路径判定」成为决定分支。Windows 上 `canTouchLaunchd` 因 `process.platform === 'darwin'` 为假同样返回 false，落到**同一个**「跳过 launchd 加载」分支，因此断言在三个平台成立且语义一致（沙箱目录 → 不碰真实域）。

证据：

- 修复前形态复现（本机模拟 `platform=win32` + 无 `getuid`）：`warn = '无法获取 uid，跳过加载'` —— 与 CI 原文逐字一致。
- 修复后形态（本机模拟 `platform=win32` + 打桩 uid）：`warn = '目标不是用户真实 LaunchAgent，跳过 launchd 加载（避免影响真实自启作业）'`、`skipped:true`、`loaded:false`、`launchctl 调用 0 次`、`plist 已落盘`，断言 `/跳过 launchd 加载/` **匹配**。
- 本机全套件：`node --test test/launchd.test.js` → `.audit-evidence/w1-green.log` exit=0、tests 32 / pass 32 / fail 0 / skipped 0。
- **真机**：windows-2022 `ok 366`，65.6ms ✓。

### M1 · `test/ocr-review.test.js` —— 用例把「阈值」当成了「回归」

R21 修的是产品行为：`run_with_deadline` 的 watcher 若收不到 TERM，父进程**不得**无上限 `wait`，必须有界等待 + SIGKILL 兜底（`scripts/ocr-review.sh:58-70`，40 × 0.05s）。用例要验证的正是这条。

原用例有两处与实现无关的脆弱：

1. **「TERM 无效」是靠父 shell 的 SIG_IGN 继承间接造出来的**（probe 里 `trap '' TERM`）。bash 对「继承的 SIG_IGN 能否在子 shell 里 reset」的处理随版本而异：本地 bash 3.2 能 reset（watcher 收到 TERM 立刻退出，父进程 0.25s 返回），runner 的 bash 5 不能（watcher 全程不响应，父进程走满兜底循环）—— 同一份脚本在两个平台走出两种形态。
2. **计时用 `date +%s`（整秒截断）+ 阈值 `< 4`**：4.0–4.9s 一律显示 4，兜底循环在 runner 负载下正好落在 4s 附近 → 判红。

修复（`test/ocr-review.test.js:112-146`）：

- 把 watcher **自己的** TERM 处理换成忽略（`definition.replace("trap 'exit 0' TERM", "trap '' TERM")`），确定性造出「TERM 无效」；历史快照（旧形态 watcher 本就无 TERM 处理）原样使用，红灯照样成立。
- 计时改在 Node 侧 `Date.now()` 量毫秒；`run_with_deadline 6` → `15`；阈值 `< 4s` → `< 10s`；并断言探针本身正常结束（`status === 0`）。

证据：

- 红灯（新用例 vs pre-R21 快照 `.audit-evidence/r21-snapshot/ocr-review.sh`）：`.audit-evidence/m1-red.log` exit=1、tests 1 / pass 0 / fail 1，断言原文 `TERM 对 watcher 无效时父进程必须自行兜底退出，却等了 15.0s —— 无上限 wait 被计时器拖满`。
- 绿灯（新用例 vs 当前脚本）：`.audit-evidence/m1-green.log` exit=0、tests 1 / pass 1 / fail 0、duration 2665.8ms。
- **真机**：macos-15 `ok 414`，4042.1ms ✓ —— 与首跑 4244ms 基本一致，说明首跑确实是**阈值**问题（4s 门槛卡在实测值上），不是修复回退。

### M2 · `test/e2e.test.js` —— 20s 预算在 runner 上耗尽，根因仍未定位

用例（`test/e2e.test.js:369-405`）用「只收连接不回包的本地 TCP 服务」把真实 detached worker 的审查请求挂到超时（`ZCODE_ADVISOR_REVIEW_TIMEOUT_MS: '3000'`，并删掉 `ZCODE_ADVISOR_MOCK` / `ZCODE_ADVISOR_NO_SPAWN`），然后在在飞窗口里执行 `ctl off`，等 `dropped.llm_timeout === 1`。

- 本机（macOS 15.8 / Node 24）单跑通过 6451ms；ubuntu-latest 两跑都通过；macos-15 首跑等满 20358ms 判红。
- **第二跑 macos-15 通过，duration 6163ms** —— 远小于 20s。这条数据很重要：**首跑的红不是「预算不够」，而是 worker 那一次根本没在 20s 内落盘**；把预算提到 60s 只是加了余量，**没有证据表明它治好了什么**。

已排除的路径：

- 预算耗尽不是原因：`hooks/lib/reviewer.js:425` 在 `remaining() < 1000` 时同样返回 `{ error: 'llm_timeout' }`，任何预算路径都会计入 `llm_timeout`。
- worker 继承 env 不是问题：`hooks/advisor-hook.js:751` 的 `spawn` 未传 `env`，worker 继承 hook 的 `ZCODE_ADVISOR_REVIEW_TIMEOUT_MS`。
- 本机负载复现失败：Node 24 + 4 个 busy loop 连跑 3 次 `test/e2e.test.js`（42 用例）全绿；本机没有 Node 22（runner 版本），`nvm install 22` 在本环境未生效，故「是否 Node 22 相关」**未验证**。

因此本项**不宣称已修复**，只做两件可验证的事：

- 预算 20s → **60s**（worker 是 detached 进程，runner 上十几个测试文件并行；60s 仍远小于默认 `reviewTimeoutMs` 240000ms，不会掩盖真实挂起）。
- 失败信息带上现场：`dropped=…` / `enabled=…` / `lock=…` / `stateDir=[…]` / `stop.stderr=…` / `off.stderr=…` —— 下次再红，红里自带证据。

本地证据：`.audit-evidence/m2-green.log` exit=0、tests 1 / pass 1 / fail 0、duration 6689.2ms。

## 四、红 → 绿证据索引（全文唯一来源）

| 项 | 红灯（失败） | 绿灯（通过） |
| --- | --- | --- |
| W1 | CI 原始日志 `.audit-evidence/r19-ci-windows2022.log:2333`（`not ok 366`）+ 本机模拟 Windows 探针输出 `无法获取 uid，跳过加载` | 真机 `.audit-evidence/r19b-ci-windows2022.log:2333`（`ok 366`，65.6ms）+ `.audit-evidence/w1-green.log`（32/32） |
| M1 | `.audit-evidence/m1-red.log`（1/0/1，`却等了 15.0s`）+ CI `.audit-evidence/r19-ci-macos15.log:2661`（`not ok 414`） | 真机 `.audit-evidence/r19b-ci-macos15.log:2648`（`ok 414`，4042.1ms）+ `.audit-evidence/m1-green.log`（1/1，2665.8ms） |
| M2 | CI 原始日志 `.audit-evidence/r19-ci-macos15.log:1098`（`not ok 158`，20358.4ms，`worker 应在审查超时后落盘`） | 真机 `.audit-evidence/r19b-ci-macos15.log:1098`（`ok 158`，6163.0ms）+ `.audit-evidence/m2-green.log`（1/1） |

全量回归（本机）：`.audit-evidence/batch5-local.log` exit=0、`tests 711 / pass 710 / fail 0 / skipped 1 / duration 40192.5ms`。

## 五、红灯取得方式与已披露缺口

- **W1**：本机是 macOS，Windows 分支只能用「伪造 `process.platform = 'win32'`」模拟；红灯原始现场来自 CI 日志（真实 Windows runner），真机复验已在第二跑完成。
- **M1**：红灯取自 pre-R21 快照 `.audit-evidence/r21-snapshot/ocr-review.sh`（不含 R21 修复的那一版），用例通过 `ZCA_OCR_REVIEWER` 指过去跑。
- **M2**：**没有本地红灯**（本机 6.5s 通过、ubuntu 两跑通过），红灯只有 CI 原始日志；且第二跑真机通过，**没有红→绿闭环**，只有「诊断已就位」。
- 第一轮 CI 的 ubuntu 作业未下载日志（结论 success，无失败可查）；第二轮三平台日志均已下载留证。

## 六、局限

1. **M2 根因未定位**，且第二跑通过（6163ms ≪ 20s 预算）说明「预算提高」不是它的解药。目前只能定性为 macos-15 runner 上的偶发（2 跑中 1 次），诊断信息已埋好；下次复现即可定位。
2. 「M2 是否 Node 22 相关」未验证（本机 `nvm install 22` 未生效，实验实际跑在 Node 24）。
3. Windows 作业的 50 条 skip 是**平台条件跳过**（macOS 专属：sips/iconutil/launchd 域；POSIX 专属：`enable.sh`、`MAC_INSTALL_SH`；语义差异：`bump-version` 只读位、zip data descriptor、pid 1 EPERM），Windows 上真正执行了 661 条断言；ubuntu 7 条、macos-15 2 条同理。
4. `scripts/ocr-review.sh` 由外部模板生成（`~/.dsh/templates/ocr-review/` + `~/.dsh/bin/ocr-sync-reviewer.sh`），本批**未新增**脚本改动，但 R10/R21/R18 的脚本改动仍不在模板里，将来一次外部 resync 会覆盖（已在前批披露）。

## 七、变更文件

| 文件 | 变更 |
| --- | --- |
| `test/launchd.test.js` | `probeInstallNow` 增加 `extra.stubUid`；`install --now` 用例改用它（+17 / −2） |
| `test/ocr-review.test.js` | R21 用例改为确定性造「TERM 无效」+ 毫秒计时 + 阈值 10s |
| `test/e2e.test.js` | 预算 20s→60s + 失败现场诊断 |
| `.audit-evidence/*` | 新增：`m1-red.log`、`m1-green.log`、`m2-green.log`、`w1-green.log`、`batch5-local.log`、`r19b-ci-{ubuntu,macos15,windows2022}.log`、`r19b-ci-run-id.txt`、`r19b-ci-watch.log` |

产品代码（`hooks/`、`tools/`、`scripts/`）本批**零改动**。

## 八、与冻结版关系

- 冻结报告 `.audit-evidence/audit-report.md` 未改动，sha256 仍为 `8ccedbf346350c5c1f8480d06366df04dd76b99123b2115238077f2b133067e0`。
- 本批是 R19 的落地收尾：把「Windows/macOS 兼容性 = 纸面配置」推进到「**已在真实 runner 上三平台全绿**」——三平台各跑 711 条用例（Windows 661 条断言 + 50 条平台条件跳过；ubuntu 704 + 7；macos-15 709 + 2）。
- 首跑暴露的三处失败中，W1/M1 已闭环（真机复验通过）；M2 属偶发、根因未定位，已如实登记为残留项。
