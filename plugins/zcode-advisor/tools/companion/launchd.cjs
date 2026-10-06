#!/usr/bin/env node
'use strict';

// macOS 自启动绑定（LaunchAgent）。
//
// 为什么用 launchd 而不是「登录项 / 自启目录」：
//   顾问外挂必须在**登录后、且早于用户第一次双击 ZCode 之前**就绪，否则用户直接
//   打开 ZCode 时它没有调试端口，角标/设置面板永远不出现（真机故障）。
//   launchd 的 RunAtLoad 在登录时触发，与 ZCode 自身的生命周期解耦——这正是
//   「点击插件图标无反应」与「直接开 ZCode 没有角标」两个问题的共同根因解法。
//
// 与 controller 的配合（受监督语义）：
//   plist 注入 ZCODE_ADVISOR_SUPERVISED=1，controller 据此把「让位/暂不可用」
//   的退出码从 0/1 改为 3（稍后重试），配合 KeepAlive{SuccessfulExit:false}
//   由 launchd 按 ThrottleInterval 重启——**既不会重启风暴，也不会因 exit 0
//   而永久失去监督**（exit 0 会让 launchd 认为任务已完成，不再重启）。
//
// 幂等与可逆：install 只在内容变化时写文件；uninstall 完整移除。
// 不 bootstrap 也能生效——~/Library/LaunchAgents 下的 plist 会在下次登录时被
// launchd 自动加载。需要**立即**生效时才用 `--now`（会立刻拉起一个实例，
// 若已有实例在跑则表现为反复「稍后重试」，属预期，退出旧实例后自愈）。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const LABEL = 'local.zcode.advisor';
const RETRY_EXIT_CODE = 3;   // 与 controller 的 exitCodeFor('yield'|'fatal', supervised) 一致

// 测试/多用户可覆盖 LaunchAgents 目录（避免测试写用户真实目录）。
function launchAgentsDir(override) {
  if (override) return override;
  if (process.env.ZCODE_ADVISOR_LAUNCHD_DIR) return process.env.ZCODE_ADVISOR_LAUNCHD_DIR;
  return path.join(os.homedir(), 'Library', 'LaunchAgents');
}

function plistPath(dir) {
  return path.join(launchAgentsDir(dir), `${LABEL}.plist`);
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// 纯函数：生成 LaunchAgent plist。抽出来是为了能直接单测——
// 这几个键写错一个，症状都很难查（少了 RunAtLoad 就不自启；少了
// KeepAlive 就崩了不恢复；ThrottleInterval 过小会变成重启风暴）。
function buildPlist(opts) {
  const { nodeBin, controllerPath, logPath, label } = opts;
  const l = label || LABEL;
  const log = logPath || path.join(os.homedir(), '.zcode', 'advisor-companion.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xmlEscape(l)}</string>
<key>ProgramArguments</key><array>
<string>${xmlEscape(nodeBin)}</string>
<string>${xmlEscape(controllerPath)}</string>
</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>30</integer>
<key>EnvironmentVariables</key><dict>
<key>ZCODE_ADVISOR_SUPERVISED</key><string>1</string>
</dict>
<key>StandardOutPath</key><string>${xmlEscape(log)}</string>
<key>StandardErrorPath</key><string>${xmlEscape(log)}</string>
</dict></plist>
`;
}

// 解析运行时（node 与 controller）在三种布局下的位置：
//   1) 发行 .app：<Resources>/node + <Resources>/app/controller.cjs
//   2) tar.gz 安装：~/Library/Application Support/ZCodeAdvisor/{bin/node,controller.cjs}
//   3) 仓库工作树：process.execPath + tools/companion/controller.cjs
// 只有 1)/2) 视为「打包布局」——工作树不自动装 agent（避免把开发机的
// 自启动指向 nvm 里的临时 node 版本，那个路径随时会消失）。
function resolveRuntime(opts) {
  const o = opts || {};
  const here = o.dir || __dirname;
  const exists = o.existsSync || fs.existsSync;
  const controllerCandidates = [
    path.join(here, 'controller.cjs'),
    path.join(here, '..', 'controller.cjs')
  ];
  const nodeCandidates = [
    path.join(here, '..', 'node'),            // .app: Resources/node
    path.join(here, 'bin', 'node'),           // tar.gz: Support/bin/node
    path.join(here, '..', 'bin', 'node')
  ];
  let controllerPath = '';
  for (const c of controllerCandidates) {
    if (exists(c)) { controllerPath = c; break; }
  }
  let nodeBin = '';
  let packaged = false;
  for (const c of nodeCandidates) {
    if (exists(c)) { nodeBin = c; packaged = true; break; }
  }
  if (!nodeBin) {
    nodeBin = o.execPath || process.execPath;   // 工作树兜底：当前解释器
  }
  return { nodeBin, controllerPath, packaged };
}

function uid() {
  try { return typeof process.getuid === 'function' ? process.getuid() : null; } catch (_) { return null; }
}

function launchctl(args) {
  return execFileSync('/bin/launchctl', args, { stdio: 'pipe', timeout: 20000, encoding: 'utf8' });
}

// 用户真实自启作业的 plist 路径——**绕过一切覆盖**（dir 参数 / ZCODE_ADVISOR_LAUNCHD_DIR）。
// 完整安全不变量见 canTouchLaunchd 上方注释；这里只负责算出路径。
function realPlistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

// 路径规范化：优先 realpath 父目录（plist 可能还没落盘，但父目录一定存在），
// 再退回 realpath 自身，最后退回 path.resolve。
//
// 只做 path.resolve 会把「指向真实目录的符号链接」判成另一个位置：macOS 上
// /var → /private/var、/tmp → /private/tmp 都是这种链接。后果是真实卸载被误判成
// 「不是真实作业」而静默跳过——卸载功能本身失效。realpath 之后两个方向都不会误判：
// 指向真实目录的链接被认成真实（该 bootout），沙箱仍被认成沙箱（不碰 launchd 域）。
function canonicalPath(p) {
  const dir = path.dirname(p);
  const base = path.basename(p);
  try { return path.join(fs.realpathSync(dir), base); } catch (_) { /* 父目录不存在 */ }
  try { return fs.realpathSync(p); } catch (_) { /* 文件也不存在 */ }
  return path.resolve(p);
}

// 目标 plist 是否就是用户真实那份（只有这份才允许操作 launchd 域）。
//
// 注意：os.homedir() 在个别环境下会抛（用户记录查不到）。这里**不静默吞掉**：
// 吞掉会让 install 照旧把 plist 落盘、却永远不 bootstrap——正好是本 bug 的另一种形态
// （文件在、作业不在、用户以为装好了）。出错时明确写 stderr 再返回 false。
function managesRealAgent(p) {
  let real;
  try {
    real = realPlistPath();
  } catch (err) {
    process.stderr.write(`[launchd] 无法定位用户 LaunchAgents 目录，跳过 launchd 域操作：${(err && err.message) || err}\n`);
    return false;
  }
  return canonicalPath(p) === canonicalPath(real);
}

// launchd 域操作仅在 macOS、拿得到 uid、且**目标就是用户真实那份 plist** 时才允许。
//
// 关键不变量：LABEL 是固定常量，重定向只能改 plist 的**路径**，改不掉 launchd
// 域里的作业名。所以一旦目标 plist 不是这一份，任何
// `launchctl print/bootout gui/<uid>/<LABEL>` 都打在用户**真实**的自启作业上：
//   - bootout 会终止真实作业的进程并把它从 launchd 卸载。KeepAlive 监督随作业
//     一起消失 → 进程被杀且**永远不会自动重启**，直到用户重开一次 App
//     （真机故障：在本机跑一次 `npm test`，外挂就被打死，表现为「动不动就连不上
//     controller」，而 CI 跑在 Linux 上、launchctl 不存在，ENOENT 被 catch 吞掉，
//     所以结构性看不见）。
//   - print 会把真实作业的运行态误报成沙箱的态（装了 agent 的开发机上，
//     「已写入但未加载」这条断言必然变红）。
// 用路径判定而不是「有没有传 dir」：这样显式把 dir 指向真实目录、或经环境变量
// 重定向的情形都能被正确识别。
// 显式判断 platform/uid 而不是靠 execFileSync 抛 ENOENT 再吞掉——「静默吞掉」
// 正是本 bug 在 CI 上无法暴露的原因。
function canTouchLaunchd(p) {
  return process.platform === 'darwin' && uid() !== null && managesRealAgent(p);
}

// 写 plist（幂等：内容相同则不重写，保持 mtime 稳定，避免触发无谓的重载）。
function writePlist(content, dir) {
  const p = plistPath(dir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  try {
    if (fs.readFileSync(p, 'utf8') === content) return { path: p, changed: false };
  } catch (_) { /* 不存在：走写入 */ }
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, p);
  return { path: p, changed: true };
}

function isLoaded(label) {
  if (uid() === null) return false;
  try {
    launchctl(['print', `gui/${uid()}/${label || LABEL}`]);
    return true;
  } catch (_) {
    return false;
  }
}

// 幂等加载：已加载且 plist 未变 → 什么都不做（**不能无条件 bootout+bootstrap**，
// 那会把正在跑的实例杀掉再拉起，用户每次点图标都会闪断一次）。
// plist 变了 → 必须重载，否则 launchd 仍按旧配置跑（升级后不生效）。
//
// 注意 plistFile 指向沙箱时**绝不能**走 launchd 域（见 canTouchLaunchd）：
// 那里的 bootout 打的是真实 LABEL，会把用户真实的 agent 打死并卸载。
//
// 返回契约（三种形状，靠 skipped / warn 区分「跳过」与「失败」）：
//   { loaded:true,  reloaded:boolean }            —— 已加载（reloaded 表示是否重载过）
//   { loaded:false, skipped:true, warn }          —— 故意跳过域操作（沙箱/非 darwin/无 uid）
//   { loaded:false, warn }                        —— 真失败（bootstrap 抛错）
function ensureLoaded(plistFile, changed, label) {
  const l = label || LABEL;
  if (uid() === null) return { loaded: false, warn: '无法获取 uid，跳过加载' };
  if (!canTouchLaunchd(plistFile)) {
    // 只落盘，由调用方决定是否需要别的加载方式；不谎报「已加载」。
    return { loaded: false, skipped: true, warn: '目标不是用户真实 LaunchAgent，跳过 launchd 加载（避免影响真实自启作业）' };
  }
  const loaded = isLoaded(l);
  if (loaded && !changed) return { loaded: true, reloaded: false };
  try {
    if (loaded) { try { launchctl(['bootout', `gui/${uid()}/${l}`]); } catch (_) { /* 已卸载 */ } }
    launchctl(['bootstrap', `gui/${uid()}`, plistFile]);
    return { loaded: true, reloaded: loaded };
  } catch (err) {
    return { loaded: false, warn: `bootstrap 失败：${(err && err.message) || err}` };
  }
}

function install(opts) {
  const o = opts || {};
  const rt = o.nodeBin && o.controllerPath
    ? { nodeBin: o.nodeBin, controllerPath: o.controllerPath, packaged: true }
    : resolveRuntime(o);
  if (!rt.controllerPath) {
    return { ok: false, reason: '未找到 controller.cjs，跳过自启动安装' };
  }
  if (rt.packaged === false && o.allowDev !== true) {
    return { ok: false, reason: '当前为仓库工作树布局（非发行包），跳过自启动安装（避免指向临时 node 路径）' };
  }
  const content = buildPlist({
    nodeBin: rt.nodeBin,
    controllerPath: rt.controllerPath,
    logPath: o.logPath
  });
  let written;
  try {
    written = writePlist(content, o.dir);
  } catch (err) {
    return { ok: false, reason: `写 LaunchAgent 失败：${err && err.message}` };
  }

  // 默认只落盘：~/Library/LaunchAgents 的 plist 会在下次登录自动加载。
  // --now 才立即 bootstrap（launchctl bootstrap 会因 RunAtLoad 立刻拉起 controller）。
  let loaded = false;
  let warn = '';
  let skipped = false;
  if (o.now) {
    const r = ensureLoaded(written.path, written.changed);
    loaded = r.loaded;
    warn = r.warn || '';
    skipped = r.skipped === true;
    if (!r.loaded && warn) {
      return { ok: true, path: written.path, changed: written.changed, loaded: false, skipped, warn };
    }
  }
  return { ok: true, path: written.path, changed: written.changed, loaded, skipped };
}

function uninstall(opts) {
  const o = opts || {};
  const p = plistPath(o.dir);
  // 只在「目标就是用户真实那份 + macOS」时才 bootout：否则会打掉用户真实的自启作业
  // （见 canTouchLaunchd）。重定向调用方（测试）只清理自己沙箱里的 plist 文件。
  let bootedOut = false;
  let skipped = false;
  if (canTouchLaunchd(p)) {
    try { launchctl(['bootout', `gui/${uid()}/${LABEL}`]); bootedOut = true; } catch (_) { /* 未加载：忽略 */ }
  } else {
    // 非 darwin / 拿不到 uid / 目标是沙箱：bootedOut=false 是**故意**的，
    // 用 skipped 与「bootout 试过但作业本就没加载」区分开。
    skipped = true;
  }
  let removed = false;
  try { fs.unlinkSync(p); removed = true; } catch (_) { /* 不存在：忽略 */ }
  return { ok: true, path: p, removed, bootedOut, skipped };
}

// 返回：{ path, exists, loaded, queried, state }。
// loaded 的含义**始终**是「launchd 报告该作业已加载」；重定向（沙箱）时不去查询，
// 于是 loaded 恒为 false，靠 queried=false 表示「没查过」而不是「查过、没加载」。
// 调用方若要区分这两种情况，看 queried。
function status(opts) {
  const o = opts || {};
  const p = plistPath(o.dir);
  const exists = fs.existsSync(p);
  // 目标不是真实那份时不去查 launchd 域：作业名仍是真实 LABEL，查出来的是用户真实
  // agent 的态，当成沙箱 plist 的态返回会让调用方拿到自相矛盾的结果（沙箱里文件不存在，
  // 却报 loaded=true）——装了 agent 的开发机上这条断言必红。
  // 返回 loaded=false + queried=false，让「没查过」与「查过、没加载」可区分。
  let loaded = false;
  let queried = false;
  let detail = '';
  if (canTouchLaunchd(p)) {
    queried = true;
    try {
      detail = launchctl(['print', `gui/${uid()}/${LABEL}`]);
      loaded = true;
    } catch (_) { /* 未加载 */ }
  }
  const state = /state = (\w+)/.exec(detail);
  return { path: p, exists, loaded, queried, state: state ? state[1] : '' };
}

function main(argv) {
  const cmd = (argv[0] || 'status').replace(/^--/, '');
  const now = argv.includes('--now');
  if (cmd === 'install') {
    const r = install({ now });
    console.log(`[launchd] install: ${r.ok ? 'OK' : 'FAILED'} ${r.path || r.reason || ''}${r.changed ? '（已更新）' : '（无变化）'}${r.loaded ? '（已加载）' : ''}${r.warn ? ` 警告：${r.warn}` : ''}`);
    return r.ok ? 0 : 1;
  }
  if (cmd === 'uninstall') {
    const r = uninstall();
    console.log(`[launchd] uninstall: ${r.removed ? '已移除' : '文件不存在'} ${r.path}`);
    return 0;
  }
  const s = status();
  console.log(`[launchd] status: plist=${s.exists ? '存在' : '不存在'} loaded=${s.loaded ? '是' : '否'}${s.state ? ` state=${s.state}` : ''} path=${s.path}`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { LABEL, RETRY_EXIT_CODE, buildPlist, resolveRuntime, plistPath, launchAgentsDir, install, uninstall, status, xmlEscape };
