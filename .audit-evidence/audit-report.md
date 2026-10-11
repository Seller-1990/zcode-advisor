# ZCode Advisor 全面审计报告

**项目**: zcode-advisor  
**审计日期**: 2026-10-11  
**基准提交**: d7599d9 (main)  
**环境**: macOS · Node v24.17.0 · npm 11.16.0 · Python 3.14.6  
**范围**: 全量审查 — 第一性原则 + 对抗性思维  
**变更统计**: 53 files changed, +1238 / −350  

---

## 执行摘要

| 维度 | 修复前 | 修复后 | 评分 (0–10) | 理由 |
|------|--------|--------|-------------|------|
| **安全性** | 5 | 7 | 7 | 信任边界修复（Host/Origin 校验、corrupt JSON 拒绝、fetchModels body deadline）；残留 singleton lock 非原子、auto-enable 租约/owner 问题 |
| **稳定性** | 4 | 7 | 7 | 核心 bodyGuard 解除时序、pruneStates 正则锚定、ctl off 锁竞态假成功均已修复；残留 ensureState 竞态、history 并发追加丢失 |
| **性能** | 6 | 8 | 8 | build-installer icnsBuf 复用 2054→1000ms/arch；extractJsonObjects 二次复杂度仅 P2 建议 |
| **测试** | 5 | 8 | 8 | 593→659 pass（+66 用例），0 fail，覆盖 provider 对抗矩阵、HTTP 慢流、lock 隔离、跨平台；Windows CI 矩阵就位但未远程验证 |
| **可维护性** | 6 | 7 | 7 | ARCHITECTURE.md 修正、docs provider-only 纠正、README mock 隔离；sync-plugin-dir 自动同步；残留过度防御少量 |
| **设计** | 6 | 7 | 7 | provider tuple 不交叉混合规则统一 core/companion；UI generation guard；安装脚本时序修正；整体插件架构合理但 singleton lock 模式需改进 |
| **发布** | 5 | 7 | 7 | CI 三平台矩阵、permissions 最小化、fail_on_unmatched_files；未远程验证；install-templates 时序已修复 |
| **综合** | — | — | **7.3 (A)** | 加权平均 |

### 统计总览

| 类别 | 数量 |
|------|------|
| 已修复 P1 (Critical) | 4 |
| 已修复 P2 (Major) | 16 |
| 已修复 P3 (Minor) | 5 |
| 残留 P2 (建议) | 13 |
| 残留 P3 (建议) | 6 |
| 新增测试用例 | +66 |
| 基线测试 | 593 pass → 659 pass, 0 fail |

---

## 项目地图

```
zcode-advisor/
├── hooks/                    # ZCode 钩子主逻辑
│   ├── advisor-hook.js       # 入口：拦截 /review 调用 reviewer
│   └── lib/
│       ├── reviewer.js       # 审查核心：流式请求、body 预算、降级链
│       ├── config.js         # 配置读取：provider 合并、eligible 判定
│       ├── state.js          # 会话状态：ensureState、prune、lock
│       └── transcript.js     # 历史日志
├── tools/
│   ├── companion/            # Companion 桌面应用
│   │   ├── controller.cjs    # HTTP 服务控制器
│   │   ├── inject.js         # WebView 注入 UI
│   │   ├── panel.cjs         # 设置面板 HTML
│   │   ├── build-installer.cjs # 构建脚本：NSIS/DMG/tar.gz
│   │   ├── install-templates.cjs # 安装脚本模板生成
│   │   └── archive.cjs       # 归档解析
│   ├── setup-server.js       # 本地 HTTP 配置桥
│   ├── config-bridge.js      # 配置桥接
│   ├── multi-review.py       # Python 多模型审查编排
│   └── sync-plugin-dir.cjs   # 镜像同步
├── scripts/
│   ├── ocr-review.sh         # OCR 审查 shell 脚本
│   ├── enable.sh             # 插件启用脚本
│   └── bump-version.cjs      # 版本号管理
├── test/                     # 660 个测试用例
├── docs/                     # 命令文档
├── plugins/zcode-advisor/     # 发布镜像（sync-plugin-dir 同步）
└── .github/workflows/        # CI/CD
```

---

## 顶级风险

1. **reviewer.js bodyGuard 解除时序** — 修复前：预算不足时先 `disarmGuard()` 再 `break`，导致 error body 在无 deadline 下消费，实测 1502ms 挂起（stub 500 body hang），`signal.aborted=false`
2. **controller.cjs readUserConfig 静默吞错** — 修复前：`catch=>{}` 吞掉 corrupt JSON，后续 merge+save 覆盖用户完整配置
3. **setup-server.js save 假成功** — 修复前：忽略 `r.error` 返回 `200 ok:true`，corrupt 文件实际未修改
4. **provider tuple 交叉混合** — 修复前：两个不完整源的 baseURL/apiKey 交叉拼接，可能用 A 的密钥调 B 的端点

---

## 详细发现

### F01 · reviewer.js bodyGuard 解除时序 [P1 · 已修复 · confirmed]

- **严重性**: P1 (Critical)
- **置信度**: confirmed（探针实测）
- **分类**: 稳定性 / 资源泄漏
- **状态**: ✅ 已修复
- **影响文件**: `hooks/lib/reviewer.js:383-487`
- **问题**: `disarmGuard()` 在预算不足 `break` 之前调用，error body 在无超时保护下被消费。探针证实 stub 500 body hang 时 1502ms 后 `signal.aborted=false`。
- **影响**: 审查请求可能无限挂起，阻塞后续审查链。
- **修复**: `disarmGuard()` 仅在 body 消费完成或显式丢弃后调用。
- **证据**: `.audit-evidence/core-s1-green.log` red 9→green 84/84
- **回归建议**: `test/reviewer-frame.test.js` 已覆盖预算不足+慢 body 场景
- **工时**: 0.5h

### F02 · controller.cjs readUserConfig 静默吞错 [P1 · 已修复 · confirmed]

- **严重性**: P1 (Critical)
- **置信度**: confirmed（fixture 复现）
- **分类**: 安全性 / 数据完整性
- **状态**: ✅ 已修复
- **影响文件**: `tools/companion/controller.cjs:702-703`
- **问题**: `catch=>{}` 吞掉 JSON 解析错误，corrupt 配置被当作空对象继续 merge+save，覆盖用户完整配置。
- **影响**: 用户配置丢失，无任何提示。
- **修复**: corrupt JSON 抛出 rejection，上层返回错误提示。
- **证据**: `.audit-evidence/companion-boundaries-red.log` → `.audit-evidence/companion-boundaries-green.log`
- **回归建议**: fixture 测试覆盖 corrupt JSON 输入
- **工时**: 0.3h

### F03 · setup-server.js save 假成功 [P1 · 已修复 · confirmed]

- **严重性**: P1 (Critical)
- **置信度**: confirmed
- **分类**: 安全性 / 配置可靠性
- **状态**: ✅ 已修复
- **影响文件**: `tools/setup-server.js:287-301`
- **问题**: bridge 返回 `r.error` 时仍返回 `200 ok:true`，用户以为保存成功但 corrupt 文件未修改。
- **影响**: 配置修改静默丢失。
- **修复**: 检查 `r.error` 并返回对应错误状态。
- **证据**: `.audit-evidence/companion-boundaries-green.log`
- **工时**: 0.3h

### F04 · provider tuple 交叉混合 [P1 · 已修复 · confirmed]

- **严重性**: P1 (Critical)
- **置信度**: confirmed
- **分类**: 安全性 / 逻辑错误
- **状态**: ✅ 已修复
- **影响文件**: `hooks/lib/config.js:231-233`, `tools/companion/controller.cjs` (对应位置)
- **问题**: 两个不完整配置源（主配置 + provider_config）的 baseURL/apiKey 交叉拼接。
- **影响**: 可能用 A 服务商的密钥调用 B 服务商的端点，造成认证泄漏或请求失败。
- **修复**: 规则统一 — config 中 eligible+baseURL+apiKey 三项完整则保留整个 tuple；provider_config 中 isUsableKind+baseURL+key 完整则整体替换六字段；两个不完整源绝不交叉。core/companion 同步实施。
- **证据**: `test/config.test.js` provider 对抗矩阵, `.audit-evidence/core-s1-green.log`
- **工时**: 0.5h

### F05 · state.js pruneStates 正则未锚定 [P2 · 已修复 · confirmed]

- **严重性**: P2 (Major)
- **置信度**: confirmed
- **分类**: 稳定性 / 数据安全
- **状态**: ✅ 已修复
- **影响文件**: `hooks/lib/state.js:250`
- **问题**: `/^sess-.*\.json/` 缺少 `$` 锚，可能匹配 `.json.bak` 等意外文件；且与 `listStatePaths` 的锚定正则不一致。
- **修复**: 改为 `/^sess-.*\.json$/`。
- **证据**: `test/state.test.js` 新增用例
- **工时**: 0.1h

### F06 · config.js readZcodeProviders 主配置失败中断 [P2 · 已修复 · confirmed]

- **严重性**: P2 (Major)
- **置信度**: confirmed
- **分类**: 稳定性
- **状态**: ✅ 已修复
- **影响文件**: `hooks/lib/config.js:184-190`
- **问题**: 主配置文件读取失败直接 `return []`，不再继续读取 `provider_config`。
- **影响**: 仅使用 provider_config 的用户在主配置损坏时完全丧失 provider 列表。
- **修复**: 主配置失败后继续独立读取 provider_config。
- **证据**: `test/config.test.js`
- **工时**: 0.2h

### F07 · ctl off 锁竞态假成功 [P2 · 已修复 · confirmed]

- **严重性**: P2 (Major)
- **置信度**: confirmed
- **分类**: 稳定性
- **状态**: ✅ 已修复
- **影响文件**: hooks 相关 5 个写入点
- **问题**: `ctl off` 时打印 "disabled" 但实际 `enabled=true`。
- **修复**: 5 个写入点统一修正。
- **证据**: `.audit-evidence/core-s2-green.log`
- **工时**: 0.3h

### F08 · providers 无/多 session gate [P2 · 已修复 · confirmed]

- **严重性**: P2 (Major)
- **置信度**: confirmed
- **分类**: 逻辑正确性
- **状态**: ✅ 已修复
- **影响文件**: hooks 相关
- **问题**: 无 session / 多 session 情况下 provider 选择器 gate 异常。
- **修复**: 正确处理边界情况。
- **证据**: `.audit-evidence/core-s2-green.log`
- **工时**: 0.2h

### F09 · UPS queue 并发删除新笔记 [P2 · 已修复 · confirmed]

- **严重性**: P2 (Major)
- **置信度**: confirmed
- **分类**: 数据完整性
- **状态**: ✅ 已修复
- **影响文件**: hooks 相关
- **问题**: 两阶段 pop-by-count 可能删除并发插入的新笔记。
- **修复**: 按 delivered prefix/ids 精确匹配删除，保留 emit-first at-least-once 语义，无新锁。
- **证据**: `.audit-evidence/core-s2-green.log`
- **工时**: 0.3h

### F10 · Host/Origin 校验缺失 [P2 · 已修复 · confirmed]

- **严重性**: P2 (Major)
- **置信度**: confirmed
- **分类**: 安全性 / 服务边界
- **状态**: ✅ 已修复
- **影响文件**: `tools/setup-server.js`, `tools/companion/controller.cjs`
- **问题**: `GET /api/history` 等端点缺少 `isLocalRequest` 校验；动态 HTML 端点也未统一。
- **修复**: 统一 `isLocalRequest` 包括所有 API 端点和动态 HTML。
- **证据**: `.audit-evidence/companion-boundaries-green.log`
- **工时**: 0.3h

### F11 · fetchModels body deadline 缺失 [P2 · 已修复 · confirmed]

- **严重性**: P2 (Major)
- **置信度**: confirmed（实测 13.5s 挂起）
- **分类**: 稳定性 / 资源泄漏
- **状态**: ✅ 已修复
- **影响文件**: `tools/companion/controller.cjs:1494-1511`
- **问题**: `clearTimeout` 在 headers 到达时调用，`body.json()` 无超时保护。loopback 测试实证 13.5s 挂起。
- **修复**: 结构化 12.004s body deadline。
- **证据**: `.audit-evidence/companion-boundaries-green.log`
- **工时**: 0.3h

### F12 · inject.js session-toggle 代际回滚 [P2 · 已修复 · confirmed]

- **严重性**: P2 (Major)
- **置信度**: confirmed（native code_review dd825a70 发现）
- **分类**: UI 正确性
- **状态**: ✅ 已修复
- **影响文件**: `tools/companion/inject.js:656-665`
- **问题**: `toggleSession()` 的 `isCurrent()` guard 仅在成功路径，失败/catch 路径直接写 DOM `checked=!checked`，旧 token 的失败回滚可覆盖新 generation 的开关状态。
- **修复**: 失败和 catch 路径均增加 `isCurrent()` 检查。
- **证据**: `test/inject.test.js:1212` 两种 failure 模式（bad_token/network_reject）测试通过
- **工时**: 0.2h

### F13 · UI 4 个 generation guard [P2 · 已修复 · confirmed]

- **严重性**: P2 (Major)
- **置信度**: confirmed
- **分类**: UI 正确性
- **状态**: ✅ 已修复
- **影响文件**: `tools/companion/inject.js`
- **问题**: model repopulate、pending fetch race、reinject panel dedup、token health state 四处缺少 generation guard。
- **修复**: 全部增加 `isCurrent()` 检查。
- **证据**: `.audit-evidence/companion-targeted-green.log`
- **工时**: 0.5h

### F14 · lock test 非隔离 [P2 · 已修复 · confirmed]

- **严重性**: P2 (Major)
- **置信度**: confirmed
- **分类**: 测试可靠性
- **状态**: ✅ 已修复
- **影响文件**: `test/auto-enable-lock.test.js`, `test/companion-lock.test.js`
- **问题**: 测试删除真实 `os.homedir()` lock / 使用全局 temp lock，可影响并行运行。
- **修复**: 隔离到临时 HOME/TMP。
- **证据**: `.audit-evidence/companion-targeted-green.log`
- **工时**: 0.3h

### F15 · port retry 无限循环 [P2 · 已修复 · confirmed]

- **严重性**: P2 (Major)
- **置信度**: confirmed
- **分类**: 稳定性
- **状态**: ✅ 已修复
- **影响文件**: `tools/setup-server.js`
- **问题**: 2 端口繁忙时 PORT+1 无限循环。
- **修复**: 有界重试。
- **证据**: `.audit-evidence/companion-targeted-green.log`
- **工时**: 0.2h

### F16 · multi-review.py run_one 三重缺陷 [P2 · 已修复 · confirmed]

- **严重性**: P2 (Major)
- **置信度**: confirmed
- **分类**: 稳定性 / 正确性
- **状态**: ✅ 已修复
- **影响文件**: `tools/multi-review.py:67-84`
- **问题**: (1) 无 subprocess timeout → 僵死; (2) truthy non-object `.get` crash; (3) `coverage_ok` 仅检查 `status=='complete'` 忽略 exit/comments 类型。
- **修复**: (1) `timeout=900`; (2) `isinstance dict` guard; (3) 完整检查。
- **证据**: `.audit-evidence/scripts-platform-green.log`
- **工时**: 0.5h

### F17 · ocr-review.sh GNU timeout + fallback orphan [P2 · 已修复 · confirmed]

- **严重性**: P2 (Major)
- **置信度**: confirmed（探针证实 `child_alive_after_return=True`）
- **分类**: 稳定性 / 资源泄漏
- **状态**: ✅ 已修复
- **影响文件**: `scripts/ocr-review.sh:374-408`
- **问题**: (1) 缺少 `--kill-after=2s`; (2) fallback 路径 leader TERM 退出后 watcher 未杀孙进程。
- **修复**: (1) 增加 `--kill-after=2s`; (2) fallback 清理逻辑修正。
- **证据**: `.audit-evidence/scripts-fallback-child-probe.log`
- **工时**: 0.5h

### F18 · enable.sh Apple bash UTF-8 bracing [P2 · 已修复 · confirmed]

- **严重性**: P2 (Major)
- **置信度**: confirmed
- **分类**: 跨平台兼容性
- **状态**: ✅ 已修复
- **影响文件**: `scripts/enable.sh:55`
- **问题**: Apple bash 3.2.57 + `LC_CTYPE=C.UTF-8` 下 `（$NODE_BIN）` 中的全角括号被解释为 `NODE_BIN<0xef>`，`exit 127`。
- **修复**: 大括号 bracing 修正。
- **证据**: `.audit-evidence/scripts-platform-green.log`
- **工时**: 0.1h

### F19 · build-installer icnsBuf 双重生成 [P2 · 已修复 · confirmed]

- **严重性**: P2 (Major)
- **置信度**: confirmed（profile 实测）
- **分类**: 性能
- **状态**: ✅ 已修复
- **影响文件**: `tools/companion/build-installer.cjs:313`
- **问题**: `makeIcns()` 每架构调两次（tar.gz entry + stageMacApp DMG），生成字节级相同结果。
- **修复**: `const icnsBuf = makeIcns()` 共享。
- **影响量化**: 中位数 2054ms → 1000ms per arch（-51%），SHA256 验证输出一致。
- **证据**: `.audit-evidence/build-final-green.log`, `test/build-icon.test.js`
- **工时**: 0.3h

### F20 · maxTokens 字符串→数字 [P2 · 已修复 · confirmed]

- **严重性**: P2 (Major)
- **置信度**: confirmed
- **分类**: 逻辑正确性
- **状态**: ✅ 已修复
- **影响文件**: hooks 相关
- **问题**: string `'8192'` → 错误截断为 4096。
- **修复**: 正确数字解析。
- **证据**: `.audit-evidence/core-s2-green.log`
- **工时**: 0.1h

### F21 · 平台测试硬编码 [P3 · 已修复 · confirmed]

- **严重性**: P3 (Minor)
- **置信度**: confirmed
- **分类**: 跨平台兼容性
- **状态**: ✅ 已修复
- **影响文件**: `test/health.test.js`, `test/user-note.test.js`, `test/session-toggle.test.js`
- **问题**: `/tmp` 硬编码（Windows 无效）；`pid 1` 硬编码；`0o600` 权限检查（Windows 无 POSIX 权限）。
- **修复**: `os.tmpdir()`、`process.pid`、平台条件检查。
- **证据**: `.audit-evidence/scripts-platform-green.log`
- **工时**: 0.3h

### F22 · ARCHITECTURE.md 过时计数 [P3 · 已修复 · confirmed]

- **严重性**: P3 (Minor)
- **置信度**: confirmed
- **分类**: 文档准确性
- **状态**: ✅ 已修复
- **影响文件**: `ARCHITECTURE.md`
- **问题**: 写死 "191 个测试"、provider-only credentials 描述错误。
- **修复**: 移除过时计数，纠正描述。
- **工时**: 0.1h

### F23 · docs advisor-on/INSTALL-CHECK 过时 [P3 · 已修复 · confirmed]

- **严重性**: P3 (Minor)
- **置信度**: confirmed
- **分类**: 文档准确性
- **状态**: ✅ 已修复
- **影响文件**: `commands/advisor-on.md`, `docs/INSTALL-CHECK.md`
- **问题**: provider-only 说明过时；INSTALL-CHECK 引用过时 API key 字段。
- **修复**: 纠正描述。
- **工时**: 0.1h

### F24 · README mock 示例泄漏真实路径 [P3 · 已修复 · confirmed]

- **严重性**: P3 (Minor)
- **置信度**: confirmed
- **分类**: 安全性 / 文档
- **状态**: ✅ 已修复
- **影响文件**: `README.md:280-291`
- **问题**: mock 示例使用裸 key，无隔离 HOME/state/endpoint。
- **修复**: 替换为隔离示例。
- **工时**: 0.1h

### F25 · sync-plugin-dir 缺少 ARCHITECTURE.md [P3 · 已修复 · confirmed]

- **严重性**: P3 (Minor)
- **置信度**: confirmed
- **分类**: 发布完整性
- **状态**: ✅ 已修复
- **影响文件**: `tools/sync-plugin-dir.cjs`
- **问题**: ITEMS 列表缺少 ARCHITECTURE.md，镜像漂移。
- **修复**: 加入 ITEMS。
- **证据**: `test/plugin-dir.test.js` 漂移检测通过
- **工时**: 0.1h

---

## 残留发现（未修复 · 建议）

### R01 · singleton lock 非原子 [P2 · 残留]

- **影响文件**: `tools/companion/controller.cjs:316-365`
- **问题**: read/rename/read 序列非原子，main 150s auto-enable 阻塞在 60s lease heartbeat 之前。
- **建议**: 改用 `open(O_EXCL)` 原子创建 + flock 锁持有。
- **工时**: 2h

### R02 · auto-enable 租约/owner [P2 · 残留]

- **影响文件**: companion auto-enable 相关
- **问题**: 5min lease 但 CLI max 9min；`finally/exit` 删除 lock 不检查 owner。
- **建议**: lease 延长至 CLI max 或定期续约；删除前校验 owner pid。n- **工时**: 1h

### R03 · ensureState 竞态 [P2 · 残留]

- **影响文件**: `hooks/lib/state.js`
- **问题**: A 见 missing → B 创建+off+note → A 继续 → enabled=true notes=[]。
- **建议**: 使用 `O_EXCL` 创建或检查已有文件。
- **工时**: 1h

### R04 · globalWorkers TOCTOU [P2 · 残留]

- **影响文件**: hooks 相关
- **问题**: max=1 时两个请求可同时通过（各持一把锁）。
- **建议**: 原子计数器或全局锁。
- **工时**: 0.5h

### R05 · history rotation 并发追加丢失 [P2 · 残留]

- **影响文件**: `hooks/lib/transcript.js` 相关
- **问题**: read+overwrite 丢失并发 append。
- **建议**: 使用 append mode 或引入轻量锁。
- **工时**: 1h

### R06 · usage billing 计数不足 [P2 · 残留]

- **影响文件**: hooks 相关
- **问题**: 失败/空/重试场景下 10/20 应计 30/60 但实际未累加。
- **建议**: 统一在 finally 中累加。
- **工时**: 0.5h

### R07 · extractJsonObjects 二次复杂度 [P2 · 残留]

- **影响文件**: hooks 相关
- **问题**: 4K=20ms, 8K=71ms, 16K=296ms 的二次增长。
- **建议**: 流式括号匹配或限制输入长度。
- **工时**: 1h

### R08 · stale-lock 竞态 [P2 · 残留]

- **影响文件**: 多处 lock 文件
- **问题**: A 的清理可删除 B 正在使用的 lock（探针证实）。
- **建议**: lock 文件包含 pid+timestamp，清理前校验。
- **工时**: 1h

### R09 · Windows 反斜杠版本解析 [P2 · 残留]

- **影响文件**: controller.cjs
- **问题**: Windows 路径反斜杠可能导致版本字符串解析失败。
- **建议**: 路径操作统一使用 `path.join`/`path.normalize`。
- **工时**: 0.5h

### R10 · OCR output element 验证 [P2 · 残留]

- **影响文件**: `scripts/ocr-review.sh`
- **问题**: OCR 输出的 JSON 元素未做类型/结构验证。
- **建议**: 增加 jq schema 验证。
- **工时**: 0.5h

### R11 · sync type conflict [P2 · 残留]

- **影响文件**: `tools/sync-plugin-dir.cjs`
- **问题**: sync 先复制再检查，文件/目录类型冲突时 EISDIR。
- **建议**: 先检查目标类型，冲突时先删后写。
- **工时**: 0.5h

### R12 · bump partial write [P2 · 残留]

- **影响文件**: `scripts/bump-version.cjs`
- **问题**: 更新前2个 manifest 成功、后续失败→部分版本号不一致。
- **建议**: 先全部读取校验再统一写入，或事务回滚。
- **工时**: 0.5h

### R13 · enable false-success [P2 · 残留]

- **影响文件**: `scripts/enable.sh`
- **问题**: sync 失败+marketplace 更新 exit 8 + enable exit 8 但 install 0 仍报完成。
- **建议**: 累计非零退出码并最终报告。
- **工时**: 0.3h

### R14 · setup-port TOCTOU [P3 · 残留]

- **影响文件**: `test/setup-port.test.js:43-55`
- **问题**: 端口释放→监听间隙可被抢占（parallel 103/104 pass, serial 104/104）。
- **建议**: 测试使用 port 0 自动分配。
- **工时**: 0.2h

### R15 · install-templates 时序 (原始缺陷已修复，shell 安装脚本中仅提示 LaunchAgent) [P3 · 残留]

- **影响文件**: `tools/companion/install-templates.cjs`
- **问题**: echo 错误地说 "LaunchAgent 已配置" 即使仅首次启动才执行。
- **建议**: 条件化提示文本。
- **工时**: 0.1h

### R16 · archive.cjs 无校验和/截断检查 [P3 · 残留]

- **影响文件**: `tools/companion/archive.cjs:263-290, 315-361`
- **问题**: readTarGz 无 checksum/截断检查；readZipEntries 无 CRC 验证。仅处理构建器自产归档，非远程可利用。
- **建议**: 增加 checksum 校验，防御供应链攻击。
- **工时**: 1h

### R17 · install-templates 首装时序 (已修复核心问题) [P3 · 残留]

- **影响文件**: `tools/companion/install-templates.cjs:117-121`
- **问题**: 首次安装时 auto-enable 在运行时就位前执行（已修复），但 fallback 拷贝 `command -v node` 无系统 node 时 exit 1 的错误提示不够明确。
- **建议**: 改进无 runtime 时的用户提示。
- **工时**: 0.2h

### R18 · marker-skip brittleness [P3 · 残留]

- **影响文件**: 测试相关
- **问题**: skip marker 依赖特定字符串匹配，脆弱。
- **建议**: 使用结构化 skip 标记。
- **工时**: 0.2h

### R19 · CI 未远程验证 [P3 · 残留]

- **影响文件**: `.github/workflows/build-installers.yml`
- **问题**: 三平台矩阵已就位但未实际远程 push 验证。
- **建议**: 推送至 CI 分支验证。
- **工时**: 0.1h

---

## 原则合规性

| 原则 | 状态 |
|------|------|
| 最小特权 | ✅ CI permissions 已收窄至 contents:read（全局）+ contents:write（仅 release job） |
| 防御纵深 | ✅ Host/Origin 统一校验；provider tuple 不交叉；body deadline 全覆盖 |
| 快速失败 | ✅ corrupt config 拒绝；save 假成功修复；bodyGuard 时序修正 |
| 幂等性 | ⚠️ ensureState/history rotation 仍有并发风险 |
| 可观测性 | ✅ 错误信息改进（enable bracing、save error、provider gate）|
| 最小变更 | ✅ 53 文件修改中无架构重写；所有修复局部精确 |

---

## 推荐修复顺序

### 🔴 立即（下个版本前）

1. **R01 + R02** — singleton lock 原子化 + auto-enable 租约修正（影响并发安全核心路径）
2. **R03** — ensureState 竞态（可导致会话状态不一致）
3. **R13** — enable false-success（用户可见的静默失败）

### 🟡 近期（1-2 个版本内）

4. **R08** — stale-lock 竞态
5. **R05** — history rotation 并发丢失
6. **R07** — extractJsonObjects 二次复杂度
7. **R09** — Windows 反斜杠解析
8. **R06** — usage billing 计数

### 🟢 计划中（可单独排期）

9. **R04** — globalWorkers TOCTOU
10. **R10-R12** — OCR/sync/bump 边界
11. **R14-R19** — 测试/文档/CI 小项

---

## 速赢清单

| # | 改动 | 工时 | 价值 |
|---|------|------|------|
| 1 | 推送 CI 分支远程验证三平台矩阵 | 0.1h | 确认 Windows/macOS CI 可用 |
| 2 | R13 enable.sh 累计退出码 | 0.3h | 消除用户可见假成功 |
| 3 | R14 test/setup-port 使用 port 0 | 0.2h | 消除 TOCTOU 测试不稳定 |
| 4 | R15 install-templates 条件化提示 | 0.1h | 准确用户反馈 |

---

## 长期架构建议

| 方向 | 理由 | 建议 | 工时 |
|------|------|------|------|
| Lock 机制统一 | 当前 R01/R02/R03/R04/R08 均涉及文件锁竞态 | 引入统一的 `flock`-based lock manager，消除 5 个独立的竞态点 | 4h |
| 并发模型 | history/state/UPS 多处 read-modify-write 无保护 | 统一 write-ahead-log 或 CAS 模式 | 3h |
| Windows 完整支持 | 路径分隔符、权限模型、shell 脚本兼容性 | 系统化 `path.posix`/`path.win32` 处理；CI 远程验证 | 2h |
| 构建安全 | archive.cjs 无校验和 | tar/zip checksum 验证 + 签名链 | 2h |

---

## 测试基线对比

| 指标 | 修复前 | 修复后 |
|------|--------|--------|
| 测试总数 | 594 | 660 |
| 通过 | 593 | 659 |
| 失败 | 0 | 0 |
| 跳过 | 1 | 1 |
| 耗时 | 33712ms | 39682ms |
| 新增覆盖 | — | provider 对抗矩阵、HTTP 慢流、lock 隔离、跨平台 tmpdir/pid、构建 icon 复用、安装 no-node failure、plugin-dir 漂移检测 |

---

## 证据索引

| 文件 | 内容 |
|------|------|
| `.audit-evidence/baseline.log` | 修复前基线 593 pass |
| `.audit-evidence/core-s1-green.log` | Core 第一批修复 84/84 |
| `.audit-evidence/core-s2-green.log` | Core 第二批绿灯 |
| `.audit-evidence/core-final-green.log` | Core 最终 178/178 |
| `.audit-evidence/core-residual-probes.log` | Core 残留探针 |
| `.audit-evidence/companion-boundaries-green.log` | Companion 边界绿灯 |
| `.audit-evidence/companion-targeted-green.log` | Companion 靶向 222/222 |
| `.audit-evidence/companion-audit.md` | Companion 完整报告 |
| `.audit-evidence/scripts-platform-green.log` | Scripts 平台 58+1 |
| `.audit-evidence/scripts-final-green.log` | Scripts 最终 64 |
| `.audit-evidence/scripts-audit.md` | Scripts 完整报告 |
| `.audit-evidence/scripts-stale-lock-probe.log` | stale-lock 竞态探针 |
| `.audit-evidence/scripts-fallback-child-probe.log` | OCR fallback 孤儿探针 |
| `.audit-evidence/build-final-green.log` | 构建修复 37/37 |
| `.audit-evidence/integration-final.log` | 最终集成 660 pass |

**红灯证据**（修复前复现）— 全文唯一来源，其他章节只引用本表，不复制计数：

计数口径：✖ / ✔ 为日志中的实测标记数；红灯日志是 Node TAP 原始栈、无汇总行，且嵌套子用例会被父子各标一次，故 ✖ 数大于去重后的真实失败用例数。

| 文件 | ✖ | ✔ | 对应修复批次 |
|------|---|---|--------------|
| `.audit-evidence/core-s1-red.log` | 19 | 1 | Core 第一批（reviewer/state/config） |
| `.audit-evidence/core-s2-red.log` | 17 | 0 | Core 第二批（ctl/providers/UPS/maxTokens） |
| `.audit-evidence/core-s3-red.log` | 9 | 0 | Core 第三批 |
| `.audit-evidence/core-review-red.log` | 5 | 1 | Core 复审回归 |
| `.audit-evidence/companion-boundaries-red.log` | 13 | 0 | Companion 边界（corrupt/保存/Host/fetchModels） |
| `.audit-evidence/companion-ui-red.log` | 9 | 0 | Companion UI 4 项 generation guard |
| `.audit-evidence/companion-ports-red.log` | 5 | 0 | 端口重试有界 |
| `.audit-evidence/companion-providers-red.log` | 3 | 0 | provider tuple 不交叉 |
| `.audit-evidence/scripts-multi-review-red.log` | 27 | 9 | Python multi-review 形状/超时 |
| `.audit-evidence/scripts-enable-red.log` | 3 | 0 | enable.sh bracing / 假成功 |
| `.audit-evidence/scripts-fallback-red.log` | 5 | 0 | OCR fallback 孤儿 |
| `.audit-evidence/scripts-architecture-red.log` | 3 | 0 | ARCHITECTURE.md 陈旧内容 |
| `.audit-evidence/scripts-ocr-deadline-red.log` | 3 | 0 | OCR deadline |
| `.audit-evidence/build-red.log` | 7 | 31 | 构建隔离 |
| `.audit-evidence/build-icon-red.log` | 3 | 0 | icns 重复生成 |

---

## 审计限制

1. **仅 macOS 本地验证** — Node 24 / macOS 环境；Windows 和 Linux 测试依赖 CI 矩阵（已配置但未远程运行）
2. **无 E2E 用户流测试** — 审计覆盖单元/集成层；完整 UI 交互流未覆盖（需真实 ZCode 宿主）
3. **Hindsight 不可用** — API 认证失败，未使用项目历史记忆
4. **Companion P2 两项未完成** — session-toggle DOM guard（已另行修复）、setup-port TOCTOU（残留 R14）
5. **构建产物未验证** — build-installer 修复通过单元测试验证，未实际构建 DMG/NSIS 产物
6. **S1 检查点未经独立机械复审** — 顾问子进程在本会话无法读取工作区文件（`read-tools-disabled-or-no-cwd`，相对/绝对路径均失败），故 S1 只能自证。详见下节。

---

## 验证状态（S1 检查点自证）

> **状态声明**：以下三项由本会话直接读取源码/测试日志自证，**未经独立顾问机械复核**。不得视为第三方验收通过；如需形式复核，请在顾问文件读取能力可用的环境中重跑。

| 检查点 | 结论 | 直接证据 |
|--------|------|----------|
| S1.K1 macOS tar.gz 首次安装链路 | 自证通过 | `tools/companion/install-templates.cjs:119-123` 先拷贝 `auto-enable.cjs`+`plugin` 到 `$SUPPORT` 持久目录；`:128-139` 就位 Node 运行时（包内内嵌→`$SUPPORT/bin/node`，或系统 node 回退，两者皆无则 `exit 1`）；`:140` 显式 `-x $SUPPORT/bin/node` 守卫；`:144-148` 运行时+payload 确认后才**从持久路径**执行 auto-enable |
| S1.K2 内嵌 Node 缓存键 | 自证通过 | `tools/companion/build-installer.cjs:163` `version=NODE_EMBED_VERSION\|\|resolveLatestLtsVersion()`；`:164` 以 `/^v\d+\.\d+\.\d+$/` 校验；`:165` `key=\`${version}-${platform}-${arch}\`` 三元组完整；`:166` `cachePath=node-${key}` — 旧缓存无法绕过显式版本 |
| S1.K3 失败用例可复现 + 修复后回归 | 自证通过 | 红灯证据见「证据索引」章节的**红灯证据**表（✖ 为实测标记数，含 Node TAP 父子用例重复计数，故大于去重后的用例数）——新用例在原实现上真实复现；绿灯证据：`.audit-evidence/integration-final.log` 660 tests / 659 pass / 0 fail / 1 skip |

### 红灯证据

红灯日志清单与实测计数见本文档「证据索引」章节的**红灯证据**表（唯一来源）。此处不再复制计数，以免两处漂移。

**未能取得独立复核的原因**：`consult_task`（review_result）对 `install-templates.cjs`、`build-installer.cjs`、`integration-final.log` 三个 subject 均返回 `status:"unavailable"`，`reason:"read-tools-disabled-or-no-cwd"`。该失败在相对路径与绝对路径下完全一致，属本会话顾问子进程的读取能力限制，非证据缺失。

**基线与总数一致性**：`baseline.log` 报告 593 pass + 0 fail + 1 skip = 594 total；最终 659 pass + 0 fail + 1 skip = 660 total。报告中「594→660 总数」「593→659 通过」与此逐项吻合。
