# scripts / 辅助工具子范围审查与定向整改回传

## 范围、授权与验证边界

原委派为只读完整审查；随后父会话明确追加了有限整改授权：Python run_one 边界与超时、OCR deadline、Windows 测试假设、ARCHITECTURE 与同步清单、enable.sh 变量边界和 provider-only 指引。仅按这些追加范围修改；**未改市场镜像、未调用外网/API/OCR/真实宿主、未做 git 提交**。历史注释中的用户授权没有被用作本轮授权。

开始按要求先执行 `git ls-files` 并完整读取 [ARCHITECTURE.md](<ARCHITECTURE.md>)。实际版本脚本是 [tools/companion/bump-version.cjs](<tools/companion/bump-version.cjs>)，不存在 `tools/bump-version.cjs`；实际对应测试是 [ocr-review.test.js](<test/ocr-review.test.js>)、[multi-review.test.js](<test/multi-review.test.js>)、[packagers.test.js](<test/packagers.test.js>)、[plugin-dir.test.js](<test/plugin-dir.test.js>) 和 [auto-enable-version.test.js](<test/auto-enable-version.test.js>)。

本子范围完整深读原有文件 **25 个**；新增 [enable.test.js](<test/enable.test.js>) 为第 26 个完整检查文件。其余核心测试只作全目录可移植模式搜索及相关上下文审查，不把 grep 命中当全文审查。companion 构建/归档/安装模板/CI 的功能正确性属于父会话；hooks、controller、UI/config bridge 属于其他代理。

## 结果摘要

点名疑点均判真：原 `run_one` 会因顶层非对象 JSON 抛异常、没有 timeout；OCR stale-lock 接管存在两个并发者同时“取得锁”、先退出者删除仍在使用锁的真实竞态。前者已定向修复；后者按父会话指示仅报告，不重设计锁协议。

最终局部验证的原始日志为 [scripts-final-green.log](<.audit-evidence/scripts-final-green.log>)：**64 个实际用例通过**，分别为 multi-review 22、enable 1、user-note/session-toggle 33、deadline 3、架构 payload 1、health 4。日志中首次 health 名称过滤未匹配任何用例，那个文件级“通过”不计入 64；已在日志末尾明确纠正并执行实际用例。`bash -n` 与限定路径 `git diff --check` 均为 0。

实测平台只有 macOS、Node v24.17.0、Python 3.14.6、系统 Bash 3.2。**未实跑 Windows、Node 22、真实 GNU timeout 或真实 OCR。** GNU 分支只完成替身参数/退出码契约测试。顾问工具调用失败（invalid-required-scopes），没有独立通过结论；父会话已要求不重试，将统一独立代码复核。

## Confirmed findings

### S01 / Medium / 已修：run_one 外部 JSON 与退出码未经边界验证

- 原位置：[multi-review.py:63–86](<tools/multi-review.py#L63-L103>) 的 `run_one`；原 74–75 行执行 `(data or {}).get(...)`，原 84 行只依据 `status == 'complete'` 计算 coverage。
- 触发：输出 `[1]`、非空字符串、整数或布尔值；或者 `comments` 不是数组/元素不是对象；或者 OCR exit=7 却留下一份 `status=complete` 文件。
- 复现：mock subprocess 只写本地 JSON，不调用 OCR。红灯 22 项中 13 项失败；可见 `AttributeError: 'list' object has no attribute 'get'` 及错误的 coverage 成功断言。[红灯日志](<.audit-evidence/scripts-multi-review-red.log>)。
- 影响：单个槽位异常经 `future.result()` 传播而使总报告丢失；非零退出可被文件内容伪装为覆盖完整。
- 已修：当前 90–102 行验证对象、状态字符串、comments 数组、元素对象和合并所需字段类型；coverage 同时要求 exit=0 和 complete，partial 仍保留合法意见。
- 回归：顶层六类非对象、畸形 comments/content/start_line、非零 complete、合法 complete/partial；[multi-review.test.js:159–207](<test/multi-review.test.js#L159-L207>)。预估同类修复含回归 1–2 小时。

### S02 / Medium / 已修直接子进程边界：run_one 可无限等待外部命令

- 原位置：原 [multi-review.py:67](<tools/multi-review.py#L72-L83>) 的 `subprocess.run(...capture_output=True,text=True)` 无 timeout；当前 [main:207–211](<tools/multi-review.py#L207-L211>) 仍等待每个 future（有界调用后才安全）。
- 触发/复现：替身把 OCR 命令替换成本地 Python sleep(30)，传 timeout=0.1；无 API/OCR。原实现不接受 timeout 参数且没有传递任何 deadline，新增回归失败。
- 已修：默认 900 秒；TimeoutExpired 返回 exit=124/status=timeout，OSError 返回 exit=127/status=error；UTF-8 显式解码并保留 stderr tail。当前 [run_one:63–83](<tools/multi-review.py#L63-L83>)。
- 回归：实际本地睡眠进程在约 0.1 秒超时；mock 缺失命令返回结构化失败，[multi-review.test.js:209–236](<test/multi-review.test.js#L209-L236>)。工时 1–2 小时。
- 限制：此测试证明直接子进程有界，不证明所有平台上 OCR 派生树都被清理；尤其 Python/Windows 孙进程继承管道场景未执行，不作端到端承诺。

### S03 / Medium / 未修：OCR stale-lock 接管不是互斥操作

- 位置：[ocr-review.sh:62–79](<scripts/ocr-review.sh#L62-L79>)；新锁 `mkdir` 后到写 info 之间也有“已建目录但未发布 pid”的窗口。
- 根因：mkdir 失败后只读旧 pid；发现死 pid 或缺 info 时，直接设置 `LOCK_ACQUIRED=1` 并覆盖同一 info，没有独占的接管步骤。退出 trap 无 owner token 校验就删除整个锁目录。
- 确定性复现：提取原锁段，在 temp 目录放 dead pid=99999999；用本地 `sed` barrier 令两个真实 Bash 都读取旧 owner 后继续。结果 `both_contenders_entered=True`；A 退出时 `B_alive=True` 且 `lock_exists_after_A_exit=False`。[证据](<.audit-evidence/scripts-stale-lock-probe.log>)。
- 影响：重复模型调用、争用报告/配额、锁在工作未结束时被拆掉。不是只有 FORCE 才会发生，也不是仅“理论 race”。
- 最小修复方向：接管必须有独占 claim，重新核实 owner/目录身份，释放时核验本次 owner token；更稳的是受 OS 生命周期管理的锁。仅“先 rm 再 mkdir”或无身份核对的 rename 仍有 ABA/race，不能当完整修复。
- 回归：两个 stale contender、活 owner 尚未写 info、旧 owner 晚退场不能删新 owner、FORCE 不删别人锁。预估 4–8 小时（含 POSIX/Windows Git Bash 契约取舍）。本轮明确不改。

### S04 / Medium / 已修：deadline 的 TERM→KILL 未覆盖完整进程树生命周期

- 原 GNU 分支 [ocr-review.sh:375](<scripts/ocr-review.sh#L375>) 只有 timeout，无 kill-after；TERM 被忽略时缺最终 KILL 上限。已增加 `--kill-after=2s`；真实 GNU 二进制未安装，只验证替身参数和 124 透传。
- 原 fallback 378–404 行：leader 接 TERM 后 `wait` 返回，父函数立即杀 watcher，取消 2 秒后的 KILL；而最终分支重新查询已消失的 leader PGID，也失去可用组身份。
- 真实复现：本地 Node/Python leader 派生忽略 TERM 的孙进程。原函数返回 143，孙进程仍为 S 状态；另快命令 exit=7 因 timer 的继承管道无法及时收束，外层 3 秒超时。回归 red 2/2 失败。[旧行为探针](<.audit-evidence/scripts-fallback-child-probe.log>)、[红灯](<.audit-evidence/scripts-fallback-red.log>)。
- 已修：当前 [ocr-review.sh:378–420](<scripts/ocr-review.sh#L378-L420>) 记录本次已确认 PGID；私有 mktemp 标记先记录过期再 TERM；已过期不取消最终 KILL，正常结束取消 watcher 并回收 timer。未改变 stale-lock 协议。
- 回归：真实 TERM-ignoring child，finally 仅清理 fixture 记录的 PID，Linux zombie 作为已停止处理；正常快命令保留 exit=7；GNU 契约。最终 3/3 通过，[绿灯](<.audit-evidence/scripts-fallback-green.log>)。工时 2–4 小时。

### S05 / Medium / 未修：OCR 输出可把畸形意见“洗成无问题”

- 位置：[ocr-review.sh:347–349](<scripts/ocr-review.sh#L347-L349>) 只校验 comments 是数组；[ocr-review.sh:510–513](<scripts/ocr-review.sh#L510-L513>) 展示时过滤掉所有非对象。
- 触发/复现：`{"status":"complete","comments":[null,"invalid",17]}` 传给提取的 `valid_output`，exit=0。随后的列表过滤得到空数组。[探针](<.audit-evidence/scripts-output-shape-probe.log>)。
- 影响：外部协议/模型畸形结果被当完整审查，再显示零意见，不再尝试 fallback。输入是外部工具输出，不能仅因“正常 OCR 不应这样”而免验证。
- 最小修复：valid_output 同时验证每个意见对象和后续消费的必要字段类型；坏元素应使该跳无效，而非静默丢弃。
- 回归：数组含 null/字符串/数值、混合好坏条目；合法空数组仍通过。预估 0.5–1.5 小时。本轮只记录。

### S06 / Medium / 未修：sync 类型冲突修复顺序失效，且空目录 check 假阳性

- 位置：[sync-plugin-dir.cjs:50–65](<tools/sync-plugin-dir.cjs#L50-L65>)、[217–224](<tools/sync-plugin-dir.cjs#L217-L224>)，类型隔离实际在 [203–210](<tools/sync-plugin-dir.cjs#L203-L210>)。
- 复现均在 env root/dest 指定的 temp fixture：源 package.json 是文件、目标 package.json 是目录时，复制先报 EISDIR/exit=1，根本到不了声称修复类型冲突的隔离逻辑；源 hooks 是空目录、目标缺失时，check 仍 exit=0/无漂移。[证据](<.audit-evidence/scripts-sync-version-probe.log>)。
- 影响：结构迁移/损坏镜像不能通过一次 sync 自愈；空目录丢失未被守卫报告。错误不是所有同步都失效，当前常规内容复制仍有原子落盘与非零错误报告。
- 最小修复：在复制前做类型一致性预检并将冲突目标放入隔离区；check 必须先判断对应目标目录存在且类型正确。
- 回归：双向 file↔dir、空目录缺失、冲突隔离失败不报成功；保留 pycache 忽略与恢复性。预估 2–4 小时。本轮不改协议。

### S07 / Medium / 未修：版本镜像更新可部分写入，check 接受全空版本

- 位置：[bump-version.cjs:36–46](<tools/companion/bump-version.cjs#L36-L46>)、[70–79](<tools/companion/bump-version.cjs#L70-L79>)、[96](<tools/companion/bump-version.cjs#L96>)。
- 确定性复现：复制 helper 到 temp 工程，第三份 manifest 去掉 version，执行 patch；exit=1，但版本已成为 `[0.2.23,0.2.23,null,0.2.22]`。四份 manifest 均 `{}` 时 `--check` exit=0，输出“四处版本号一致：”。[证据](<.audit-evidence/scripts-sync-version-probe.log>)。
- 影响：可预见的输入错误会留下半升级状态；缺失字段被等价性校验当成合法一致。
- 最小修复：任何写入前读取/解析/验证四份 JSON 与版本、构建所有新内容；每份原子替换，并明确失败回滚/恢复策略。check 除相等还应验证非空合法版本。
- 回归：第三份缺失/非法 JSON/不可写，四份无 version、成功 bump 与格式保持。预估 2–4 小时。本轮不改多 manifest 事务。
- 当前基线的四个真实版本均为 0.2.22；没有对真实仓库运行 bump。

### S08 / Medium / 未修：enable.sh 在关键步骤失败后仍宣告完成

- 位置：[enable.sh:58](<enable.sh#L58>) sync、[68](<enable.sh#L68>) marketplace update、[79](<enable.sh#L79>) enable 均未检查结果；只有 install 的 [72–75](<enable.sh#L72-L75>) 有显式失败分支。
- 复现：提取正文，假 Node 返回失败，mock run_cli 仅 install 成功，其他阶段返回 8；在 temp 版本仅修 bracing 后，脚本仍 exit=0 并打印“完成”。[证据](<.audit-evidence/scripts-enable-failure-probe.log>)。
- 影响：可能安装陈旧市场快照或根本未启用，却显示成功。`pipefail` 没有配合检查/errexit，不会自动退出。
- 最小修复：显式检查 sync/update/enable，失败停止且不打印完成；marketplace add 的“已注册”与真正失败需按 CLI 契约区别处理，不建议盲目加 `set -e`。
- 回归：每个步骤分别失败时 exit 非零、后续不运行，已有市场重入仍成功。预估 1–2 小时。父会话指示本轮不扩大到全流程修复。

### S09 / Medium / 已修：enable.sh 的 Node 路径/中文标点展开会中止脚本

- 原位置：[enable.sh:55](<enable.sh#L55>)：未引用的 `$($NODE_BIN -v)` 和紧贴全角括号的 `$NODE_BIN）`。
- macOS Bash 3.2 + LC_CTYPE=C.UTF-8 复现 `NODE_BIN�: unbound variable`、exit=127；Node 路径含空格还会拆成不存在的第一段路径。纯 fixture，无宿主。[红灯](<.audit-evidence/scripts-enable-red.log>)。
- 已修：命令路径加双引号，变量使用 `${NODE_BIN}` 边界。回归 [enable.test.js](<test/enable.test.js>) 通过，且验证第二次运行不覆盖已有用户选择。预估 0.5–1 小时。

### S10 / Medium / 主要已修：provider-only 凭据指引与分发文档漂移

- 原 [enable.sh:87–111](<enable.sh#L87-L111>) 生成旧 apiKey/baseUrl/model 配置并宣称面板可编辑 key；原 [INSTALL-CHECK.md:47、60、70](<docs/INSTALL-CHECK.md#L47-L70>) 指导旧 key 流程，与 provider-only 运行时不符。原 [advisor-on.md:14](<commands/advisor-on.md#L14>) 同样建议插件 key/单独 setx key，已交核心代理修复。
- 原自检示例在安装缓存引用不分发的 test fixture，且只给 key 不给端点；已改成源码仓库、隔离 HOME/state、成对 env 覆盖，并说明无真实模型服务。没有执行该文档的宿主实验。
- ARCHITECTURE 原含固定旧测试数量/旧 key 保存说明，已对齐真实职责；README 链接 ARCHITECTURE，但 sync ITEMS 未带它。新增隔离 fixture red ENOENT→green 后将架构文档纳入清单，[sync-plugin-dir.cjs:41–44](<tools/sync-plugin-dir.cjs#L41-L44>)、[plugin-dir.test.js:22–38](<test/plugin-dir.test.js#L22-L38>)。
- 剩余需父会话收口：[README.md:280–290](<README.md#L280-L290>) 原 mock 示例同样只有 key、缺显式隔离端点/state；本代理未获此段改写任务且冻结后未扩展。
- 回归建议：源码包/安装包链接可达，fresh HOME 下文档 mock 示例确实执行且绝不触发网络，凭据字段不得重新进入插件模板。总工时 1–2 小时。

### S11 / Medium / 平台假设已修，Windows 实证待 CI

- 原 [health.test.js:72–76](<test/health.test.js#L72-L76>) 把 `/tmp/x` 与 Windows 规范化 dirname 直接比较；[99–101](<test/health.test.js#L99-L101>) 和 [user-note.test.js:283–288](<test/user-note.test.js#L283-L288>) 对真实 Windows 文件系统断言 POSIX 0600。
- 原 [user-note.test.js:254](<test/user-note.test.js#L254>)、[session-toggle.test.js:146](<test/session-toggle.test.js#L146>) 把 pid=1 当存活进程；Windows 无此保证，会走 stale 而非 lock_timeout。
- 已修：os.tmpdir/path.join；只在 POSIX 断言 mode，保留其他内容断言；活锁使用 process.pid。Python 测试不再只硬编码 python3，优先 PYTHON 环境并探测 python3/python >=3.7，显式 UTF-8 与进程上限。
- OCR 测试依赖 Bash、冒号 PATH、symlink、chmod、dirname/sleep 与 POSIX 进程组，现 Windows 显式逐用例 skip；新增 enable 是 macOS/POSIX launcher fixture，Windows 只 skip 该用例。其余 core 测试不白名单删减。
- 回归：Ubuntu/macOS 全功能集、Windows 全 core + setup-python；必须检查跳过原因和具体计数。工时 1–2 小时。当前只有本地 macOS 实证，不声称 Windows 已通过。

### S12 / Medium / 报告转交：测试隔离与自适应 skip 可制造虚假信心

- 原 [auto-enable-lock.test.js:21–25](<test/auto-enable-lock.test.js#L21-L25>) 派生真实 HOME lock 并 reset；原 [companion-lock.test.js:29–40](<test/companion-lock.test.js#L29-L40>) 备份/覆写/删除真实 controller lock。已有 mock CLI 不等于 lock 路径隔离。风险已通知父会话/核心代理；最终以他们冻结版本复核，不重复改动。
- [ocr-review.test.js:89–127](<test/ocr-review.test.js#L89-L127>) 根据源码是否含 `OCR_REVIEW_RAW_OUT`、`OCR_REVIEW_TOTAL_BUDGET`、`LOCK_ACQUIRED` 等 marker 决定 skip：删除已发布功能可能让原回归转成绿的跳过。
- 最小修复：锁测试显式隔离 HOME/USERPROFILE 或注入路径，绝不操作开发机真实锁；已合入能力的回归不应因源码消失而 skip，应先失败断言能力存在。保留真正平台限制的有理由 skip。
- 回归：设置临时 HOME，预置无关 lock 内容并保证不被改；移除 feature marker 的 mutation 应使测试失败。预估 1–3 小时。前项是否最终修完由所属代理证据确定，后项本轮未改。

## Suspected / 未证实的剩余跨平台风险

- [multi-review.py:187–189](<tools/multi-review.py#L187-L189>) CLI 默认 `--out=/tmp/multi-review-result.json`、`--workdir=/tmp`，并在 [235](<tools/multi-review.py#L235>) 直接 open 最终输出。Windows 默认无这个目录，CLI 与 OCR 的目录创建行为尚未实测；本轮的 Windows 合并/槽位单测不覆盖 main 默认调用。建议改用 tempfile 标准目录、明确创建输出父目录或提前报错，并加 mock CLI 的 native Windows main 测试。预估 1–2 小时；不把测试能跑等同工具 CLI 可部署。
- Python `subprocess.run` timeout 未针对 Windows OCR 派生孙进程/继承 stdout 管道做端到端回收验证。需原生 Windows 本地无 OCR 进程树 fixture，再决定是否需要 process group / Job Object。当前证据不足以宣称残余挂起已经出现。

## 排除的低价值/误报项

[remove-and-conflicts.test.js:83–85](<test/remove-and-conflicts.test.js#L83-L85>) 的 mode 断言已有 Windows guard；[launchd.test.js:267–272](<test/launchd.test.js#L267-L272>) symlink 已限 darwin；[packagers.test.js:159–164](<test/packagers.test.js#L159-L164>) 可执行位有 Windows guard。不要据 grep 命中把这些文件整体排除 Windows。

默认模型、历史计划中的实测记录、脚本中的授权注释未作为当前授权。未把双市场目录、镜像复制本身、长注释、命名样式或冗余文字列为风险。

## 原有 25 个完整深读文件清单

1. [scripts/ocr-review.sh](<scripts/ocr-review.sh>) — 锁、chain、deadline、raw 保存、输出验证、usage 全文。
2. [tools/multi-review.py](<tools/multi-review.py>) — slots、run_one、merge、main 全文。
3. [tools/sync-plugin-dir.cjs](<tools/sync-plugin-dir.cjs>) — check/copy/quarantine/sync 全文。
4. [tools/companion/bump-version.cjs](<tools/companion/bump-version.cjs>) — 版本四联更新/check 全文。
5. [enable.sh](<enable.sh>) — 启用与配置全文。
6. [启动-Advisor-ZCode.cmd](<启动-Advisor-ZCode.cmd>) — 全文，仅调用 Node controller。
7. [配置面板.cmd](<配置面板.cmd>) — 全文，仅调用 Node setup-server。
8. [ARCHITECTURE.md](<ARCHITECTURE.md>) — 全文，含版本/市场层次与凭据契约。
9. [README.md](<README.md>) — 365 行全文，运行、构建、验证、凭据与示例。
10. [docs/INSTALL-CHECK.md](<docs/INSTALL-CHECK.md>) — 全文，原 104 行及授权修订。
11. [docs/PLAN-health-visibility-probe-fallback.md](<docs/PLAN-health-visibility-probe-fallback.md>) — 482 行全文，历史资料，不授权运行真机实验。
12. [commands/advisor-model.md](<commands/advisor-model.md>) — 全文。
13. [commands/advisor-off.md](<commands/advisor-off.md>) — 全文。
14. [commands/advisor-on.md](<commands/advisor-on.md>) — 原文全文，已把修订归属交核心代理。
15. [commands/advisor-setup.md](<commands/advisor-setup.md>) — 全文。
16. [commands/advisor-status.md](<commands/advisor-status.md>) — 全文。
17. [test/multi-review.test.js](<test/multi-review.test.js>) — 原文与新增回归全文。
18. [test/ocr-review.test.js](<test/ocr-review.test.js>) — 原 664 行全文与新增测试；旧 fixture 会 git commit，故未执行整套。
19. [test/plugin-dir.test.js](<test/plugin-dir.test.js>) — 原 289 行全文与新增 fixture；旧真实镜像写入测试未执行。
20. [test/auto-enable-version.test.js](<test/auto-enable-version.test.js>) — 188 行全文。
21. [test/packagers.test.js](<test/packagers.test.js>) — 277 行全文，仅本子范围判测试隔离/平台适用；未运行 hdiutil/NSIS 真工具。
22. [package.json](<package.json>) — scripts、engines、version。
23. [plugins/zcode-advisor/package.json](<plugins/zcode-advisor/package.json>) — 对应镜像版本。
24. [.zcode-plugin/plugin.json](<.zcode-plugin/plugin.json>) — 组件声明、userConfig、版本。
25. [plugins/zcode-advisor/.zcode-plugin/plugin.json](<plugins/zcode-advisor/.zcode-plugin/plugin.json>) — 对应镜像版本/声明。

新增完整文件：[test/enable.test.js](<test/enable.test.js>)。额外上下文审查而非全文覆盖：[test/health.test.js](<test/health.test.js>)、[test/user-note.test.js](<test/user-note.test.js>)、[test/session-toggle.test.js](<test/session-toggle.test.js>)、[test/remove-and-conflicts.test.js](<test/remove-and-conflicts.test.js>)、[test/launchd.test.js](<test/launchd.test.js>)、[test/auto-enable-lock.test.js](<test/auto-enable-lock.test.js>)、[test/companion-lock.test.js](<test/companion-lock.test.js>)、[test/archive.test.js](<test/archive.test.js>)、[test/install-templates.test.js](<test/install-templates.test.js>)；全 test 目录另做 POSIX 工具、spawn、mode、symlink、固定 PID/路径模式搜索。后来出现的 [test/build-installer.test.js](<test/build-installer.test.js>) 属父会话构建审查，只作模式搜索。

除上面明确读过的两个 manifest/package 副本外，镜像中其余重复源码/文档不计入 25 个深读数；最终 source→mirror 字节一致性、版本检查、全套测试交父会话统一执行。未读历史 HTML 审计报告、图标二进制作为新证据；工具 [icon-alpha.cjs](<tools/icon-alpha.cjs>) 已提醒父会话纳入 icon/build 链，不声称本代理覆盖。

## 19 维适用性映射（限本子范围，不作全仓评分）

1. 架构/边界：root→mirror→宿主快照关系已核对；S06/S07/S10。
2. 安全：provider 凭据位置、临时输出、进程 kill 目标、测试真实 HOME；S03/S10/S12。
3. 稳定性/错误处理：S01/S02/S03/S04/S05/S08。
4. 性能/伸缩：并发重复调用、孙进程泄漏、deadline/预算；未做重负载 benchmark。
5. 测试质量：从仅 merge 补 run_one，64 个实际局部用例；S11/S12。
6. 可维护性：协议边界/镜像一致性/文档同步；不以文件长度或风格单独扣分。
7. 设计原则：外部输入 fail-fast、多步版本写入前预检、单一配置事实来源。
8. 发布/部署：S06/S07/S10；companion installer/CI 主责在父会话。
9. 文档准确性：S10；历史 PLAN 与当前契约区分。
10. 配置安全：provider-only、成对 env、无插件 key 模板；Windows /tmp 默认待验证。
11. 可观测性：结构化槽位错误、stderr tail、正确 coverage；enable 假成功仍未修。
12. fallback/防御代码：OCR 只接受 complete 有效，但元素被静默丢弃；S04/S05/S08。
13. 测试真实性：本地真实进程树对照 mock 契约；明确 GNU/Windows 未实跑，marker skip 风险 S12。
14. 类型安全：Python 外部 JSON 对象/数组/字符串/行号校验；Shell JSON 元素缺口 S05。
15. 前端状态：不适用于本子范围，交 UI/controller 代理。
16. 后端 API：无服务 API 主责；CLI 外部进程/输出契约按 S01/S02/S05 审查，config bridge 交其他代理。
17. 依赖重量：未新增三方依赖，Python/Bash/coreutils 可用性显式区分；未做供应链网络查询。
18. 代码一致性：统一结构化错误与模型意见保留；镜像复制待父会话最终同步。
19. 注释覆盖：未把历史授权当本次许可；修正测试数量/凭据来源；没有纯注释密度风格发现。

## 冻结与交接

本代理改动 13 个源/测试/文档文件，已冻结：上述 ARCHITECTURE、INSTALL-CHECK、enable、OCR、multi-review、sync，以及 enable/multi-review/ocr-review/plugin-dir/health/user-note/session-toggle 七个测试文件。没有改镜像、bump 工具或 stale-lock 协议。

未关闭的实质风险为 S03、S05、S06、S07、S08、S12 的 marker skip，以及 S10 的 README mock 示例；原生 Windows/真实 GNU/真实宿主/OCR 为验证空白，不算已通过。父会话需统一镜像同步、版本一致性、独立代码复核和受其授权的集成测试后再给总交付结论。
