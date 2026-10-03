# zcode-advisor

ZCode（z.ai CLI）插件：**每轮被动审查对话增量的独立审查副模型**。本插件是 [dsh-advisor](https://github.com/omdsh-dev/dsh-advisor)（omp "advisor" 子系统的 DeepSeek Harness 移植）在 zcode 端的对应实现：一个独立配置的审查模型观察主会话转录，在每轮结束时评审"继续做下去是否明显有问题"，并把 nit / concern / blocker 三级建议注回会话。

> **AI 协作者 / 新维护者**：先读 [ARCHITECTURE.md](./ARCHITECTURE.md)——三形态职责边界、
> 事件生命周期、状态归属、部署链路与已知局限都在那里，能避免"只看片段就下判断"。

**advisory-only 纪律**（与上游一致）：审查副模型从不批准/否决主模型的动作，从不代行操作；每条送达的意见都带 `[advisor:*]` 前缀并以"仅供参考"框架自述。故障有界：错误分类计入 `Dropped` 统计并安静退出，绝不拖垮主会话（被宿主强杀的进程无法自行计数，见"局限"）。

```
[advisor:concern] 输入没有做长度校验
（以上来自审查副模型，仅供参考，不构成指令。……）
```

## 快速开始

前置条件：**PATH 上有 Node**（hook 以 `node` 派生；`node -v` 自查）。版本要求分两档：

| 组件 | 最低 Node | 原因 |
| --- | --- | --- |
| hook 审查链路（SessionStart / UserPromptSubmit / Stop） | **≥ 18** | 只用 `fetch`、`fs` 等 18 起稳定的能力 |
| 🛡️ 角标外挂（`tools/companion/controller.cjs`） | **≥ 22** | 依赖全局 `WebSocket`（v21 需 `--experimental-websocket`，22 起默认提供） |

发行包内嵌官方 Node，目标机无需自行安装；仅在包**未内嵌**时才需要系统 Node 满足上表。

1. **安装**：ZCode → 设置 → 插件管理 → 添加插件市场 → 选择本目录（`.claude-plugin/marketplace.json`，插件源指向自身；`.zcode-plugin/marketplace.json` 为等价副本）→ 安装 **zcode-advisor** 并保持启用。
2. **新开会话**。

> ⚠️ **斜杠命令（/advisor-*）与 `[advisor]` 注册行都在会话创建时注册**：安装前就已打开的旧会话里它们不存在，这是宿主机制而非故障——**新建一个会话即可**。

3. **填写 API key（三种方式，任选其一）**：
   - **插件设置表单**：设置 → 插件管理 → zcode-advisor 详情页，直接填 API key / 模型 / 模式并保存（桥接进程以「只兜底填补缺失项」语义写入用户级配置：**已有非空配置不会被表单覆盖**，唯一例外是模型字段非空即覆盖；修改已有 key/端点请用配置面板）；
   - **双击 `配置面板.cmd`**：打开本地网页面板（127.0.0.1，不联网），填 key / 选模型 / 一键 Ping 验证 / 保存；
   - 会话内 `/advisor-setup`（效果同上，聊天内完成）。
4. 观察效果：几轮对话后 `/advisor-status` 看 `审查次数` 与 `Token 累计` 增长；`Dropped` 非零时按故障排查表处置。

## API key 与模型在哪里填

四种方式，**推荐前两种（图形界面，无命令行）**：

| 方式 | 操作 | 生效范围 |
| --- | --- | --- |
| ① 插件设置表单 | 设置 → 插件管理 → zcode-advisor 详情页填 key/模型/模式 → 保存。表单值由随会话启动的 MCP 桥接进程（config-bridge）写入用户级配置：**只兜底填补缺失项，绝不覆盖你已有的非空配置**（表单默认值不会把面板里调好的端点改回去）；**唯一例外是模型字段：非空即覆盖**——在这里填模型 = 直接改全局审查模型 | 全局，**下一轮审查即生效**，跨升级保留 |
| ② 本地配置面板 | **双击项目里的 `配置面板.cmd`** → 浏览器自动打开 `http://127.0.0.1:8789/`：填 key、选模型、**Ping 测试**一键验证、保存；**「清除 API key」**移除已保存的 key（模型/端点等其余配置保留） | 同上 |
| ③ `/advisor-setup` | 会话内运行，聊天内引导填写并自动 Ping 验证（需新会话） | 同上 |
| ④ 手动/环境变量 | 编辑 `~/.zcode/advisor.config.json`（模板 `advisor.config.example.json`）；或 `setx ZCODE_ADVISOR_API_KEY <key>` 后重启 ZCode | 同上 |

配置加载优先级：**环境变量 > 用户级配置 `~/.zcode/advisor.config.json`（①②③写入的都是它）> 插件目录 `advisor.config.json` > 内置默认**。hook 每次调用都会重读配置，因此**保存后无需重启会话**。随时用 `ctl doctor` 查看配置解析链与 key 来源（脱敏显示）。

**清除/更换 key**：面板「清除 API key」只删本机配置文件里的副本；清掉后若无环境变量 key，顾问进入 `missing:apiKey` 状态并**静默跳过审查**（控制面提示照常可达，不会报错刷屏）。三点须知：① **清除 ≠ 作废**——key 若已泄露，到智谱/Z.ai 控制台吊销才是根治；② 环境变量 key（`ZCODE_ADVISOR_API_KEY` 等）不受清除影响，仍在解析链上生效，Ping 也可能依旧绿——那验的是 env key；③ 只在主配置面板提供清除入口（插件设置表单没有删除语义，桥接是只兜底不覆盖的填空路径）；若宿主缓存的表单值与配置文件不一致，桥接启动会在 stderr 留一行提示（VERBOSE 下有完整 JSON）。

**版本倾斜（插件与 companion 不同步）**：通常**无症状**——hook 侧与面板各自独立工作。安装器与升级流程会把两半一起更新；若你手动只替换了一半且行为异常，重新运行安装器即可自愈（`--force` 覆盖）。登记为已知简化，不做运行时检测。

**模型怎么选**：审查模型建议与主对话模型形成能力差（主模型是 flash 级时，审查优先试 `glm-5.3` 等更强模型，以套餐实际可用为准）。改全局模型三处入口等价：**插件设置表单的模型字段（非空即覆盖）**、配置面板、直接编辑配置文件；配置面板与 `/advisor-setup` 都能一键 Ping 验证候选模型。会话级临时切换用 `/advisor-model set <model-id>`（自下一轮审查生效，仅当前会话，优先级高于全局；`reset` 恢复全局）。注意两处入口别同时常改：表单模型非空时，每次会话启动都会以表单值覆盖配置文件（桥接会在 stderr 提示）；想以面板为准就清空表单的模型字段。`maxTokens` 默认即 4096（有实证支撑的下限：768 会把预算耗在思考上导致空转，有实测）；越界值会被钳到 64–16384 并在 `/advisor-status` 的「配置问题」行登记。

## 发行包

构建零第三方依赖，**macOS 与 Windows 均可运行**：

```bash
npm run build                                   # 默认：win 全套 + 当前架构 mac 全套
node tools/companion/build-installer.cjs --mac-arch=both   # 同时产出 mac x64 与 arm64
node tools/companion/build-installer.cjs --skip-win        # 只出 mac
node tools/companion/build-installer.cjs --no-installer    # 只出绿色包（跳过 exe/dmg）
```

| 产物 | 平台 | 形态 | 安装方式 |
| --- | --- | --- | --- |
| `ZCodeAdvisor-<v>-win-x64-setup.exe` | Windows x64 | **NSIS 安装器** | 双击 → 向导安装 → 桌面/开始菜单快捷方式 + 控制面板卸载项 |
| `ZCodeAdvisor-<v>-win-x64.zip` | Windows x64 | 绿色包 | 解压 → 双击 `install.cmd`（明文脚本） |
| `ZCodeAdvisor-<v>-macos-<arch>.dmg` | macOS | **DMG 安装包** | 打开 → 把 `ZCode Advisor.app` 拖入 Applications |
| `ZCodeAdvisor-<v>-macos-<arch>.tar.gz` | macOS | 绿色包 | 解压 → `./install.sh` |

两种形态的差异：安装器（exe/dmg）提供标准安装体验；绿色包全程明文脚本、可先审阅。
**两者都内嵌官方 Node 运行时**（Windows `bin\node.exe` 保留原始签名；macOS 内嵌官方二进制），
目标机无需安装 Node。DMG 内的 `.app` 是**自包含**的（运行时与控制器都在包内，不依赖 `~/Library`）。

> **受限网络注意**：nodejs.org 在部分网络下直连不通，需走代理，例如
> `export https_proxy=http://127.0.0.1:7897` 后以 `NODE_USE_ENV_PROXY=1` 运行构建（Node ≥ 22）；
> 或设 `NODE_DIST_MIRROR` 指向可达镜像。内嵌运行时获取失败时，构建**不静默**：会给出警告并产出
> 「回退到系统 Node」的包，包内 README 与 `install.sh` 都会明确提示需要系统 Node（**角标外挂需 ≥ 22**，见上方版本表）。

构建完成后脚本做**三层校验**，任一层失败即非零退出：
1. **依赖闭包**：从源码 `require` 链自动推导运行时文件清单，逐个确认已进包
   （这道防线是必需的——早期硬编码清单曾漏掉 `zcode-path.cjs`，产物装完即崩）；
2. **系统工具交叉验证**：`unzip` / `tar` / `hdiutil verify` 实际校验产物（工具不存在时跳过并提示；
   注意 `unzip` 不是 Windows 自带，需 Git for Windows 的 CmdTools 才有）；
3. **require 冒烟**：把包内 JS 释放到临时目录并真实 `require` 一次入口，确认依赖可解析。

**工具可用性**（缺失时明确跳过并提示，不算构建失败）：

| 产物 | 依赖工具 | 说明 |
| --- | --- | --- |
| setup.exe | `makensis` | Windows 上 `choco install nsis`；CI 用 `windows-2022`（预装 NSIS 3.10） |
| dmg | `hdiutil` | 仅 macOS 可构建 |

> 实测记录：本机（Hackintosh x86_64）的 Homebrew `makensis 3.12` 连最简 NSIS 脚本都
> `std::bad_alloc` 崩溃（与该二进制自身有关，非脚本问题），且其 SIGABRT 会干扰同进程内随后的
> `hdiutil` 调用——因此 NSIS 构建在**独立子进程**中执行，二者互不影响。macOS 上产出 setup.exe
> 因此不可靠，**建议在 Windows/CI 上构建**。

**杀软友好形态**（刻意保持，不得回退）：不做自解压 dropper、不改进程名、不做隐藏启动——
NSIS 是业界标准安装器（非 IExpress 自解压），快捷方式直接指向原始 `node.exe` 且以最小化窗口运行。
若你的环境仍有误报，自行斟酌是否加白。

**与 zcode-plus 共存**：本外挂的 controller 先扫描调试端口段（9333-9350），
**发现已有调试实例就直接附着**（不抢占、不重复拉起 ZCode）；因此与 zcode+ 谁先启动都行，
✨ 与 🛡️ 可在同一页面共存。

## 自动构建（GitHub Actions）

`.github/workflows/build-installers.yml`：

- **打 tag 即自动发布**：`git tag v0.2.2 && git push origin v0.2.2` → 三平台并行构建 →
  安装包自动挂到 Release；
- **手动触发**：Actions 页面 `Run workflow`，只上传 artifact 供验证，不发 Release。

流程包含一道确定性门禁：Linux 上先跑全量测试（`npm test`），通过后才进入打包；
macOS 侧在打包后额外做 **DMG 挂载冒烟**（确认 `.app` 与启动器存在），Windows 侧确认 `makensis` 可用。

> 为何固定 `windows-2022`：查证 `actions/runner-images` 得知 NSIS 3.10 预装在该镜像，
> 而 `windows-2025` 未预装 NSIS（只有 InnoSetup）——换镜像会导致 setup.exe 静默跳过。

## 在 ZCode 界面中访问设置（🛡️ 角标）

ZCode 桌面版没有官方 UI 扩展机制，因此在界面内提供设置入口依赖 CDP 注入：

- **双击 `启动-Advisor-ZCode.cmd`**（Windows）或运行 `node tools/companion/controller.cjs`：
  以调试模式拉起 ZCode（或在已有调试实例时直接附着），保持一个控制台窗口（使用期间别关）；
  **macOS 装好 DMG 后无需此步**——`.app` 会自动配置 LaunchAgent，登录即就绪（见上节）；
- ZCode 输入框区域右下角出现 **🛡️ 顾问角标**，点开即设置面板：
  - **API 来源（二选一）**：`ZCode 已维护` = 直接选用 ZCode 设置里配置的第三方 API（下拉选服务商 + 模型，key 留在 ZCode 配置里不出进程）；`手动维护` = 在面板里单独填端点 / key / 模型；
  - **启用顾问**：面板首行的独立开关（新会话是否自动启用审查）；
  - **拉取模型**（手动维护模式）：填好端点与 key 后点「拉取模型」，自动请求 `{端点}/models` 列出可选模型；
  - **Ping 测试** / **保存**：保存写入用户级配置，下一轮审查即生效，无需重启；
  - 审查模式 / max_tokens 收在「高级」折叠区，面板默认占地更小。
- **健康状态灯（角标上的小圆点）**：角标带一个状态灯，由图外的 companion 每 5s 轮询本机 `/api/health` 着色——**绿=正常、黄=降级、红=审查未成功返回、灰=未知**（未运行或数据过期）。**只有明确成功才显绿**：取不到数据一律灰，避免"灯坏了"被误读成"顾问健康"。悬停角标可看上次成功/尝试时间与失败原因。
- 注入采用 `Page.addScriptToEvaluateOnNewDocument` + 当前文档补注入双通道，
  页面刷新/导航后角标自动恢复；原版方式启动的 ZCode 不会有角标（无调试通道）。

**macOS 用户**：若自动探测不到 ZCode，在 `~/.zcode/advisor-companion.json` 填
`{ "zcodePath": "/Applications/ZCode.app" }`（支持直接填 `.app` 包路径，会自动解析到内部可执行文件）。

### macOS 登录自启动（LaunchAgent）

DMG 安装的 `.app` 首次打开时会**自动装上 LaunchAgent**（`~/Library/LaunchAgents/local.zcode.advisor.plist`），
此后**登录即自动就绪**——不必再用启动器打开，直接双击 ZCode 也会有角标：

- `RunAtLoad`：登录时自动拉起；`KeepAlive{SuccessfulExit:false}`：崩溃后自动重启；
  `ThrottleInterval=30`：重试间隔 30s（不会重启风暴）。
- 由 launchd 监督时，controller 的退出码语义会切换：**暂不可用**（ZCode 正以非调试模式运行、
  端口占用等）退 `3` 让 launchd 稍后重试；**永久性失败**（Node 版本过低、`zcodePath` 不可执行）
  退 `0` 停止重启，避免每 30s 空转刷日志。
- 若你**习惯直接打开 ZCode**：那个实例没有调试端口，注入无法后补——受监督的外挂会每 30s 重试，
  你**完全退出 ZCode（含菜单栏图标）**后它会自动接管并重新以调试模式拉起，无需手动操作。

管理命令（用包内 Node 运行，`<app>` = `ZCode Advisor.app/Contents/Resources`）：

```bash
"<app>/node" "<app>/app/launchd.cjs" status         # 查看是否已加载
"<app>/node" "<app>/app/launchd.cjs" install --now  # 安装并立即加载（幂等）
"<app>/node" "<app>/app/launchd.cjs" uninstall      # 卸载自启动（可逆）
```

> 也可直接删掉该 plist 并执行 `launchctl bootout gui/$UID/local.zcode.advisor` 完成卸载。

> **关于插件设置表单（`userConfig`）的如实说明**：本项目在 `.zcode-plugin/plugin.json` 中声明了
> `userConfig` 设置表单（沿用 Claude Code 契约）。但 ZCode 官方插件规范
> （`plugin-creator` 的 `plugin-json-spec.md`）只声明 `skills`/`commands`/`hooks`/`mcpServers`，
> **未定义 `userConfig`**；在 ZCode 3.14.4 的 `app.asar` 中也未检索到插件系统处理该字段的逻辑。
> 因此**不要依赖**该表单单作为配置入口——请优先使用 **🛡️ 角标** 或本地配置面板。
> 若你的 ZCode 版本确实渲染了该表单：桥接进程会以「只兜底填补缺失项」语义写入用户级
> 配置——表单值仅在对应键缺失/为空时落盘，**已有的非空配置不被表单覆盖**
> （0.2.14 起 model 字段例外：非空即覆盖，作为全局审查模型生效）；
> 修改已有 key/端点请用本地配置面板（面板保存为覆盖语义）。

原理与限制（如实声明）：ZCode 桌面版是 Electron 应用且无官方 UI 扩展机制，本外挂经 Chrome DevTools Protocol 注入页面脚本——依赖 ZCode 的非公开接口，**ZCode 大版本更新可能导致角标失效**（重新适配即可，hook 审查功能不受影响）；调试端口仅监听 127.0.0.1；面板 API 使用随注入下发的共享令牌，本机其他网页无法调用；不承诺官方兼容性，介意者只用前文的命令/面板方式。

## 工作原理

```
SessionStart ──── 创建会话状态（幂等）；resume/compact 后重发注册行；清理过期状态文件
UserPromptSubmit ─ 送达积压意见（additionalContext）或注册行；无 key/已停用时控制面提示照常可达
Stop ──────────── 每轮结束时触发审查（按 reviewMode 分两条路径）
```

- **async 模式（默认）**：Stop 立即返回、固定开销为亚秒级（每轮 hook 冷启动 + 一次后台进程派生）。后台 `review-worker`（detached 子进程，同会话互斥锁 + 全局并发上限 + 陈旧锁过滤）读取转录增量、调用审查模型、把意见写入顺延队列；你下一条消息提交时意见以 `additionalContext` 送达。代价：concern/blocker 失去"当轮打断"时机（blocker 顺延时保留 `[advisor:blocker]` 前缀可辨识）。
- **sync 模式**：Stop 内联审查。concern/blocker 经 `{"decision":"block","reason":"…"}` 立即送达（宿主强制续跑，最多 3 连续轮），nit 仍顺延。代价：每轮收尾等待审查完成；`reviewTimeoutMs` 自动钳制到 300s 且 **429/5xx 重试与单次尝试共享同一截止时间**（总时长不超 Stop hook 硬限 320s，避免"强杀→指针不推进→每轮重审"的停滞循环）；送达前还会复查会话启停状态。

增量机制：转录按 **byte offset** 增量读取（按字节切行，非法 UTF-8 只污染单行内容、不影响指针），文件首部指纹（headHash）变化或体积变小（compaction/resume 重写）时全量回退；回读量超过 `backfillLimitBytes`（默认 2MB）时只从尾部回读。窗口默认最近 60 条实质消息、总量 48K 字符封顶（长消息场景实际生效的是字符帽），并**保底保留最早的用户指令**（该注入不受字符帽约束）；思考链不送审；advisor 自身注入的内容按 `[advisor:` 前缀过滤；"有完整行但零解析产率"会计 `parse_empty`（转录格式异常的可观测信号）。

状态写纪律：所有写路径（UPS/ctl/Stop 父进程/worker 落盘）经由跨进程短临界区（`.wrlock`，写前后双重属主校验）重读最新状态后做**字段级合并**——审查在飞期间执行的 `/advisor-off`、`/advisor-model set`、意见投递不会被 worker 的落盘覆盖（有真实子进程 + 挂起 TCP 服务的并发回归测试保障）；UPS 只清除自己已投递的意见，不吞并发入队的新意见。

## 与 dsh-advisor 的映射与差异

| dsh-advisor | 本插件 | 说明 |
| --- | --- | --- |
| `agent.inject`（nit） | UserPromptSubmit `additionalContext` | 语义一致：不唤醒、下个边界消费 |
| `agent.steer`（concern/blocker） | sync：Stop block；async：顺延队列 | async 是宿主约束下的选择（见上），非被迫 |
| 每步审查（step boundary） | Stop 时点审查 | zcode 无逐步注入通道，粒度为整轮 |
| `immuneTurns` / `maxDeltaMessages` / `maxTokens` / `systemPrompt` | 同名配置 | 语义一致；冷却设点差异见下 |
| `proseFallback` | 同名配置，**本移植默认 true** | 上游默认 false；对齐 dsh 端本地补丁 v2.2 的生效状态。守门规则见下 |
| `enabled` 配置键（已废弃） | 同样没有 | 插件管理里的启用开关即主开关；会话级用 `/advisor-on` `/advisor-off` |
| `/advisor status\|on\|off\|model` | `/advisor-status` `/advisor-setup` `/advisor-on` `/advisor-off` `/advisor-model` | 会话级命令经注册行里的**状态文件路径**精确定位本会话；多会话并存时裸 `ctl` 会被拒绝，防误伤 |
| provider + model 硬门禁 | baseUrl + model + apiKey 硬门禁 | 缺任一项绝不发起调用；门禁失败时注册行照常投递（含 `missing:*` 提示），命令通道不失联 |

冷却（`immuneTurns`）口径如实声明：sync 在 block 真正发出时进入冷却；async 在**入队成功**时进入冷却（无投递回执下的近似，间隔至多一个 UPS 边界）——入队后若会话终止未送达，冷却已消耗。冷却期内的 deferred concern 不算送达、不进冷却。`maxBlocksPerTurn` 是纵深防御，正常流程下主防护是 `stop_hook_active` 跳过续跑轮。status 中的 steer 计数：sync=实际送达数，async=入队数。

dsh 端教训（`ADVISOR-GUARD-REPORT.md`，[issue #102](https://github.com/omdsh-dev/dsh-advisor/issues/102)）的吸收情况：

- **散文救回三条守门**：只剥离成对 markdown 标记（`**粗体**`、行内反引号、围栏行），绝不全局删 `* _ >`（否则破坏 `snake_case_var`、`x => y`、`*.ts`）；以 `{`/`[` 开头、括号不配平、含 `note:` 键特征的回复不救回（避免注入半截 JSON）；救回的 severity 一律 nit，按 Unicode 码点截断（不劈开 emoji）。**默认开启**。
- **多帧解析**：模型输出中混杂伪码 `{a:1}` 不会杀死后面的真帧（扫描全部配平块，取**最后一个**合法帧——模型自我纠正语义；不用 max-of-N，避免放大转录注入面）。
- **可见性**：`/advisor-status` 输出 `Dropped` 分类计数与 Token 累计（usage 解析入账），杜绝"看似在运行、实际不产出"。

## 配置

配置加载优先级：**环境变量 > 用户级 `~/.zcode/advisor.config.json` > 插件目录 `advisor.config.json` > 内置默认**（损坏的层自动跳过并把 `config_invalid` 挂到"配置问题"行展示）。环境变量逐项覆盖，命名 `camelCase` → `ZCODE_ADVISOR_SNAKE_CASE`：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `baseUrl` | `https://open.bigmodel.cn/api/paas/v4/chat/completions` | OpenAI 兼容端点。`http://` 非本机地址会在状态中给出明文传输警告 |
| `model` | `glm-5.3-flash` | 审查模型；建议与主模型形成能力差。思考型模型配 `maxTokens: 4096` |
| `apiKey` / `apiKeyEnv` | 空 / 见文件 | key 解析链：`apiKey` → 依次尝试 `apiKeyEnv`；占位符样式值（`REPLACE_*`、`test*`、含中文的模板文案等）视为未配置。共享 env key 发往非签发方端点会触发警告 |
| `apiSource` | `manual` | **API 获取方式**：`manual` 用本配置里的 key/端点/模型；`zcode` 直接读取 ZCode 已维护的第三方 API（`~/.zcode/v2/config.json` 的 provider），改 ZCode 设置无需再同步本插件。配置面板里是「ZCode 已维护 / 手动维护」二选一 |
| `zcodeProvider` / `zcodeModel` | 空 / 空 | `apiSource=zcode` 时选中的服务商（provider id，容忍写名称）与模型 id；模型留空取该服务商列表首项。provider 缺失或协议非 OpenAI 兼容（`anthropic` 类）时沿用手动值并在「配置问题」行登记 |
| `reviewMode` | `async` | `async`（亚秒级固定税，意见下条消息送达）或 `sync`（立即打断，超时自动钳制 ≤300s） |
| `immuneTurns` | 3 | steer 后的冷却轮数；冷却期内 concern 降级顺延（blocker 不受限） |
| `maxDeltaMessages` / `maxContextChars` | 60 / 48000 | 送审窗口（条数 / 总字符）。两者同时生效，长消息下字符帽先到 |
| `maxTokens` | 4096 | 单次审查输出预算；接受字符串数字，越界钳到 64–16384 并登记「配置问题」 |
| `fallbackModel` | 空（关闭） | **降级备用模型**：主模型遇白名单错误（`llm_empty_response`/`unparsed`/`llm_http_404`）时临时换用它，端点/key 不变。**仅 async 生效**（sync 下会砍半 primary 预算，已禁用）。建议配**快模型/非思考型**——它要在主模型烧剩的预算里跑完。降级成功会写 history 的 `degraded` 事件并触发独立降级告警（不掩盖主模型劣化） |
| `temperature` | 0.2 | 审查调用温度 |
| `proseFallback` / `maxNoteChars` | true / 768 | 无 JSON 帧时把清洗后的散文救回为 nit；JSON 帧与散文的 note 统一按码点截断到该上限 |
| `systemPrompt` | 内置 | **完全替换**内置审查提示词（含 advisory-only 纪律）。注意：插件目录可被会话内的工具写入，不建议设置——保持内置纪律不可被改写 |
| `startEnabled` | true | 新会话是否自动启用（会话级仍可 `/advisor-off`） |
| `maxBlocksPerTurn` | 2 | sync 单轮 steer 上限（纵深防御，正常流程不触达） |
| `reviewTimeoutMs` | 240000 | 单次审查超时（含重试共享截止）；<1000 回退默认，sync 钳制 ≤300000，async 钳制 ≤600000（async 单轮总预算为其 2×，仍小于 worker 锁过期窗 2×+60s） |
| `maxGlobalWorkers` | 4 | 全局同时在飞审查上限（跨会话，只计新鲜锁），超限计 `global_busy` |
| `backfillLimitBytes` | 2097152 | offset 大幅落后时的尾部回读上限 |
| `pendingNotesCap` | 5 | 顺延队列上限，溢出计 `queue_overflow` |
| `stateDir` | 插件数据目录 `state/`（无则退回插件目录内） | 会话状态目录。默认优先使用宿主插件数据目录（`ZCODE_ADVISOR_PLUGIN_DATA`，跨版本升级保留——待真机确认）；需确保跨升级时显式配置到插件目录外 |

调试环境变量：`ZCODE_ADVISOR_DEBUG=1`（hook 异常栈写 stderr，见宿主 hook 运行记录）、`ZCODE_ADVISOR_DRY_RUN=1`（sync 演练，不真正 block、不虚增计数）、`ZCODE_ADVISOR_MOCK=1` + `ZCODE_ADVISOR_MOCK_FRAME='{"severity":"concern","note":"…"}'`（免 key 联调；**需同时**在 state 目录放 `.mock-allowed` 空文件，否则静默滑入真实调用并给出注册行警告；mock 帧与生产同口径校验）。

## 命令（会话级）

| 命令 | 作用 |
| --- | --- |
| `/advisor-setup` | **交互式配置**：填写 API key、选择模型 → 写入用户级配置 → `ctl doctor --probe` 当场验证能力（`--n 5` 采样、`--model <id>` 逐个测候选）；只想看连通性用 `--ping` |
| `/advisor-status` | 状态：启用/门禁/模式/模型及来源/审查与 steer 计数/Token 累计/顺延队列/`Dropped` 分类/配置问题与警告 |
| `/advisor-api` | 会话级覆盖端点/key/模型（`api set <baseUrl|-> <apiKey|-> [model:<id>]`、`api show`、`api reset`）；key 明文只落本会话状态文件（0600），状态行只回显掩码 |
| `/advisor-on` `/advisor-off` | 当前会话启停（临时覆盖；审查在飞时执行也不会被回滚；停用会话仍可用注册行自救） |
| `/advisor-model` | 查看审查模型及来源；`/advisor-model set <model-id>` 本会话固定（下一轮生效）；`/advisor-model reset` 回落全局默认 |

命令通过首条消息注入的 `[advisor]` 注册行定位（含脚本与状态文件两个绝对路径；门禁失败/会话停用时也会投递或重发）。`ctl doctor` 可随时做无会话体检：配置解析链、key 来源（脱敏）、门禁；`ctl doctor --probe` 用**生产参数**跑 N 次能力探针并输出通过率与耗时分布（不做「可用/不可用」判决——可用性是概率属性），`--ping` 则是最小连通性检查。

## 验证

```sh
npm test          # 全量测试（用例数随开发增长，不在此写死；实际数量见命令输出）
                  # 覆盖：配置分层/状态临界区/转录增量与指纹/帧解析与散文救回/路由/端到端（含 P0 并发回归）
                  #      + 归档读写（ZIP/TAR 字节结构与系统工具交叉校验）
                  #      + ZCode 路径探测（macOS .app 解析 / Windows 候选链 / 降级链）
                  #      + 安装模板、图标生成（ICO/ICNS 经系统工具校验）、运行时依赖闭包
                  #      + 页面注入脚本行为（样式注入、令牌版本、模型下拉、403 提示）
npm run build     # 构建发行包（构建后自动做三层产物校验）
```

mock 链路验证（以下命令需 **Git Bash**；PowerShell 用户请用等价写法，注意 JSON 内路径需用正斜杠或双反斜杠）：

```bash
cd "<插件目录>"                                     # state/ 默认建在当前目录下
mkdir -p state && touch state/.mock-allowed        # mock 双要素之二（必须，否则会发起真实调用）
ZCODE_ADVISOR_MOCK=1 \
ZCODE_ADVISOR_MOCK_FRAME='{"severity":"blocker","note":"演示"}' \
ZCODE_ADVISOR_API_KEY=e2e-key \
ZCODE_ADVISOR_REVIEW_MODE=sync \
  node hooks/advisor-hook.js stop <<< '{"session_id":"demo","transcript_path":"test/fixtures/transcript-basic.jsonl","stop_hook_active":false}'
# 期望 stdout：{"decision":"block","reason":"[advisor:blocker] 演示（以上来自审查副模型……）"}
```

接真实模型：`/advisor-setup` 配好 key（Ping OK）→ 新开会话 → 首条消息出现 `[advisor]` 注册行 → 几轮后 `/advisor-status` 看 `审查次数` 与 `Token 累计` 增长。

## 故障排查

`/advisor-status` 的 `Dropped` 行按类别定位（`config_invalid`/`config_out_of_range` 属于"配置问题"行，不在 Dropped 内）：

| 类别 | 含义 | 处置 |
| --- | --- | --- |
| `llm_empty_response` | 模型把输出预算耗在思考上，正文为空 | `maxTokens` 提到 4096 |
| `unparsed` | 无合法 JSON 帧且救回被守门拒绝 | 确认 `proseFallback: true`；换格式稳定的模型 |
| `llm_timeout` | 审查超时（含重试共享截止） | 提高 `reviewTimeoutMs`（sync 已自动钳制 ≤300s）或缩小 `maxDeltaMessages`（20~30） |
| 面板保存 503 | 配置文件正被其他进程写入（跨进程锁在保护它） | 等几秒重试；持续出现则删除 `~/.zcode/advisor.config.json.lock`（进程崩溃残留，锁协议会自动接管死主的锁，正常无需手动） |
| `llm_http_4xx/5xx` | 端点/认证/限流错误 | 检查 key 与模型 id；429/5xx 已内置一次共享截止的退避重试 |
| `llm_error` | 网络层失败（DNS/连接） | 检查端点可达性 |
| `no_transcript` | 转录文件缺失 | 宿主契约问题，带 `ZCODE_ADVISOR_DEBUG=1` 反馈 |
| `parse_empty` | 转录有完整行但全部无法解析 | 转录格式与预期不符，带样例反馈 |
| `busy` / `global_busy` | 同会话在审 / 全局并发达上限（只计新鲜锁） | 正常现象；高频出现说明审查耗时超过交互节奏，缩小窗口 |
| `queue_overflow` | 顺延队列满（cap 5） | 意见产出快于消费，属正常丢弃 |
| `spawn_failed` / `worker_error` | 后台派生失败 / worker 内部异常 | 带调试日志反馈 |

其他：无 key/停用状态下**不会全哑**——控制面提示照常可达；每轮收尾变慢 → 确认在 `async`；长会话后命令失联 → resume/compact 会重发注册行。

## 安全与成本

- **注入链残余风险（如实声明）**：本插件向主会话新增两条自动注入通道（sync 的 Stop block、async 的 additionalContext）。**能影响转录内容的一方**（被 Read 的网页/代码注释/工具输出）理论上可经审查模型植入 note 影响主模型；缓解是 note 码点截断（768）、帧校验（多帧取末帧而非最高severity）、advisory 前缀与"仅供参考"框架、内置提示词禁止 note 携带可执行指令——但对蓄意注入无硬性防线。选型提示拆开说：**担心注入链 → 用 async**（无强制续跑）；**担心 blocker 迟到 → 用 sync**（当轮打断），两个维度独立决策。
- **敏感数据外发（如实声明）**：转录增量（代码、路径、可能的密钥）不做脱敏直接发送到 `baseUrl`；主模型 Read `.env` 后其内容会进入转录并外发。当前无可配置脱敏规则——请自行权衡端点可信度；插件目录（含本配置文件）可被会话内工具改写，"独立审查"对被审查者不设防，`/advisor-status` 的配置警告行可辅助发现端点篡改。
- **key 落盘**：用户级配置（`~/.zcode/advisor.config.json`）不在任何 git 仓库内、跨升级保留；插件目录的 `advisor.config.json` 已被 gitignore（模板见 example）。共享 env key（`ZAI_API_KEY` 等）发往非官方端点会在状态中警告；`http://` 非本机端点会警告明文传输。
- **成本可观测**：每次调用的 usage 解析入账（`/advisor-status` 的 Token 累计；数字来自端点自报，恶意端点可伪造）；单次调用输入上限 48K 字符 + `maxTokens` 输出，单轮（含空响应重试）最多 3 次调用、总耗时 ≤ 预算上界（sync=1×、async=2× `reviewTimeoutMs`）。空转（有调用无产出）在 `Dropped:llm_empty_response` 可见。

## 局限（如实声明）

- async 模式下 concern/blocker 没有"当轮打断"；blocker 顺延送达时任务可能已完成（时效损失未完全缓解，仅有前缀可辨识）。
- sync 模式受 Stop hook 硬超时 320s 约束（配置与重试已联动钳制），且宿主"最多 3 连续续跑"为文档声明、未实测。
- **被宿主强杀/会话释放杀掉的 worker 无法自我计数**：该轮意见丢失且不计入任何 Dropped 类别；其残留锁在 `staleMs`（约 9 分钟）内会让该会话计 `busy`（全局额度只计新鲜锁，不受影响）。
- resume/compact 后全量回读（窗口截断保护）可能对最近的旧事重提一条意见。
- 转录按 Claude Code 同构 JSONL 容错解析，**尚未在真实 zcode 转录上验证过**；宿主格式差异的表现为 `parse_empty` 信号 + 审查无产出，不崩溃。
- headHash 指纹取文件头 64 字节：若真实转录前 64 字节为纯样板（跨重写恒定），重写检测退化为"仅变小才重置"——真机验证项。
- 单 advisor、单模型；无会话内面板、无转录持久化。逐步（step-boundary）审查未实现，粒度为整轮。
- **降级（fallback）仅 async**：sync 下单轮受 Stop 硬超时约束，切预算会复活"强杀→指针不推进→每轮重审"停滞循环，故禁用。且只在"换模型能治"的白名单错误上切换（401/403/429/5xx/timeout 都不切——那是 key/端点问题）。
- **配置面板的 Ping 仍按旧口径**（`max_tokens=1`，思考型模型会误报 OK）；能力探针 `ctl doctor --probe` 是 CLI 入口，面板用户暂不受益。三处 ping 的统一是后续项。
- **健康状态灯依赖 CDP 角标**：controller 未运行时角标不存在，也就没有灯（不是"灯变灰"，是"没有灯"）。此时用 `/advisor-status` 或 `ctl doctor` 兜底。

## 目录结构

```
zcode-advisor/
├─ .zcode-plugin/         plugin.json + marketplace.json（含展示元数据）
├─ .claude-plugin/        marketplace.json（Claude Code 兼容副本）
├─ hooks/hooks.json       SessionStart / UserPromptSubmit / Stop 三个 process 型 hook
├─ hooks/advisor-hook.js  入口：事件分发 + review-worker + ctl（含 doctor）
├─ hooks/lib/             config（分层加载）/ state（临界区写）/ transcript（字节级增量）/ reviewer / route
├─ commands/              /advisor-setup /advisor-status /advisor-on /advisor-off /advisor-model
├─ tools/                 config-bridge.js（设置表单桥）+ setup-server.js（本地网页面板）
├─ tools/companion/       输入框角标外挂与打包：
│                         ├─ controller.cjs       CDP 注入 + 本机 API（macOS/Windows 双平台探测）
│                         ├─ inject.js            页面角标 + 设置面板
│                         ├─ lib.cjs              模型端点推导（纯函数）
│                         ├─ zcode-path.cjs       ZCode 可执行文件探测（含 .app 解析）
│                         ├─ archive.cjs          零依赖 ZIP/TAR 读写
│                         ├─ icon.cjs             零依赖 ICO/ICNS/PNG 生成
│                         ├─ install-templates.cjs 明文安装脚本模板
│                         ├─ build-meta.cjs       版本号单一来源
│                         └─ build-installer.cjs  发行包构建（跨平台）
├─ 配置面板.cmd            双击打开本地网页配置面板
├─ 启动-Advisor-ZCode.cmd  双击以角标模式启动 ZCode（CDP 注入）
├─ advisor.config.json    插件目录兜底配置（gitignore；模板见 advisor.config.example.json）
├─ test/                  node:test 单测 + mock 端到端 + P0 并发回归 + 面板/桥接/companion/归档/路径测试
└─ state/                 兜底状态目录（默认优先宿主插件数据目录）
```

## 许可证

MIT
