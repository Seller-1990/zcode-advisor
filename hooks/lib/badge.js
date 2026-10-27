'use strict';

// 角标链路状态探测 + companion 自愈兜底。
//
// 背景（2026-10-27 真实故障）：输入框角标由 companion 经 CDP 注入，companion 由
// launchd（local.zcode.advisor）监督。两层各自都会断，且断了以后用户毫无线索：
//   ① ZCode 以「直接双击」方式启动（无 --remote-debugging-port）——companion 检测到
//      后只能等其完全退出再接管，期间角标不可用；
//   ② launchd 自身停止拉起 companion（实测：退出码 3 的作业卡在 LastExitStatus，
//      不再重启）——既无角标、又无自愈路径。
// hook 是唯一每轮必然活着的组件：由它读 companion 的单实例锁文件（tools/companion/
// controller.cjs 写，心跳每 20s 刷新）判断链路状态，在会话里给一句人话；②发生时
// 补一脚 launchctl kickstart（节流），把「角标悄悄消失」变成「可见 + 可自愈」。

const fs = require('fs');
const os = require('os');
const path = require('path');

const LOCK_FILE_NAME = 'zcode-advisor-companion.lock';
// 与 controller.cjs 的 LOCK_TTL_MS 一致：心跳 20s，三拍不跳即判心跳死亡。
const LOCK_TTL_MS = 60 * 1000;

// 待命标记（controller.cjs 在「裸 ZCode 在跑、attach-only 本轮不附着」时写）。
// 为什么需要它：这种场景下 companion 已经**退出**（锁里 pid 是死的），只看锁只能判
// down；而 down 会触发 kickstart 自愈——再拉起一轮、再发现裸 ZCode、再退出，白烧一次
// auto-enable（最长 150s）且提示词说错原因。标记把「本轮为什么不附着」跨进程传出来。
const STANDBY_FILE_NAME = 'zcode-advisor-companion.standby';
// 待命标记的保鲜期：它只说明「最近一次启动时宿主是裸 ZCode」，超过一天就不再可信
//（用户可能早已换过启动方式或外挂真的挂了），宁可退回 down 让自愈重新判断。
const STANDBY_TTL_MS = 24 * 60 * 60 * 1000;

const LAUNCHD_LABEL = 'local.zcode.advisor';

// Windows 的 node 没有 process.getuid；revivePlan/tryRevive 的 platform 是参数
// （测试会传 'darwin'），在 Windows 上跑测试时不能因取 uid 炸掉。
function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : 0;
}

// 测试与多用户环境可重定向：锁文件所在目录（默认系统 tmp，与 controller 一致）。
function resolveLockDir(env) {
  return (env && env.ZCODE_ADVISOR_COMPANION_TMP) || os.tmpdir();
}

function resolveLockFile(env) {
  return path.join(resolveLockDir(env), LOCK_FILE_NAME);
}

function resolveStandbyFile(env) {
  return path.join(resolveLockDir(env), STANDBY_FILE_NAME);
}

// 读 companion 租约。文件缺失/坏内容一律按「不在」处理（宁可多提示也不误报健康）。
// fresh 判定 = 心跳新鲜 且 pid 仍存活——controller 用 kill(pid,0) 判活，
// ESRCH（不存在）才算死、EPERM 等一律算活（Windows/权限下的 access denied 同理）。
function readCompanionLock(env, now) {
  const at = Number.isFinite(now) ? now : Date.now();
  const file = resolveLockFile(env);
  let info = { pid: 0, started: 0, cdp: 0, cdpSince: 0 };
  try {
    const txt = fs.readFileSync(file, 'utf8');
    const num = (re) => Number(((re.exec(txt) || [])[1]) || 0);
    info = {
      pid: num(/(?:^|\n)pid=(\d+)/),
      started: num(/(?:^|\n)started=(\d+)/),
      cdp: num(/(?:^|\n)cdp=(\d+)/),
      cdpSince: num(/(?:^|\n)cdpSince=(\d+)/)
    };
  } catch (_) {
    return { present: false, fresh: false, pid: 0, cdp: 0, cdpSince: 0, ttlMs: LOCK_TTL_MS };
  }
  const pidAlive = info.pid > 0 && (() => {
    try { process.kill(info.pid, 0); return true; } catch (err) { return !!(err && err.code !== 'ESRCH'); }
  })();
  // controller 从不写 pid/started 为 0 的锁；读出来是 0 说明内容损坏（半写/被改），
  // 视同无锁——present 的语义是「租约有效存在」，不是「文件存在」。
  const valid = info.pid > 0 && info.started > 0;
  return {
    present: valid,
    fresh: valid && info.started <= at && at - info.started <= LOCK_TTL_MS && pidAlive,
    pid: info.pid,
    cdp: info.cdp,
    cdpSince: info.cdpSince,
    ttlMs: LOCK_TTL_MS
  };
}

// 读待命标记：文件缺失/坏内容/过期一律按「没有」处理（与锁同一纪律：不猜健康）。
function readStandby(env, now) {
  const at = Number.isFinite(now) ? now : Date.now();
  try {
    const txt = fs.readFileSync(resolveStandbyFile(env), 'utf8');
    const reason = ((/(?:^|\n)reason=([^\n]*)/.exec(txt) || [])[1] || '').trim();
    const written = Number(((/(?:^|\n)at=(\d+)/.exec(txt) || [])[1]) || 0);
    const fresh = written > 0 && written <= at && at - written <= STANDBY_TTL_MS;
    return { present: fresh, fresh, reason, at: written, ttlMs: STANDBY_TTL_MS };
  } catch (_) {
    return { present: false, fresh: false, reason: '', at: 0, ttlMs: STANDBY_TTL_MS };
  }
}

// 链路三态（纯函数，便于单测）：
//   attached = companion 活着且已附着调试通道（角标应存在）
//   waiting  = 没有可附着的 CDP——要么 companion 起来了但还在等端口，要么宿主是直接
//              双击启动的裸 ZCode（companion 已按 attach-only 语义安静退场，留了待命标记）
//   down     = companion 不在，且没有待命证据（锁缺失/心跳过期/pid 已死）
function deriveBadgeState(lock, standby) {
  if (lock && lock.present && lock.fresh) return lock.cdp > 0 ? 'attached' : 'waiting';
  if (standby && standby.present && standby.fresh) return 'waiting';
  return 'down';
}

// 自愈节流判定（纯函数）：lastReviveIso 是状态文件里存的 ISO 字符串。
// 这里必须是 Date.parse 而不是 Number()——Number('2026-10-27T…') 是 NaN，
// NaN 参与比较恒为 false，节流会静默失效（曾经就是这么错的：每个新会话都 kickstart）。
function shouldRevive(state, lastReviveIso, now, opts) {
  const o = opts || {};
  if (state !== 'down' || o.disabled) return false;
  const at = Number.isFinite(now) ? now : Date.now();
  const last = Date.parse(lastReviveIso || '') || 0;
  const gap = Number.isFinite(o.minIntervalMs) ? o.minIntervalMs : 0;
  return at - last > gap;
}

// launchd 自愈方案。仅 macOS 且 plist 在位才有意义；返回 null 表示本机无从自愈。
function revivePlan(platform, plistPath) {
  if (platform !== 'darwin') return null;
  try {
    if (!plistPath || !fs.existsSync(plistPath)) return null;
  } catch (_) { return null; }
  return { argv: ['launchctl', 'kickstart', `gui/${currentUid()}/${LAUNCHD_LABEL}`] };
}

// 执行一次自愈。kickstart 失败（作业未加载）时退回 bootstrap 重新装载。
// spawnSyncFn 可注入（测试）；真实调用失败只返回错误，绝不向上抛——
// 角标自愈是尽力而为的兜底，不能反过来影响每轮审查。
function tryRevive(opts) {
  const o = opts || {};
  const platform = o.platform || process.platform;
  const plistPath = o.plistPath
    || path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
  const spawnSyncFn = o.spawnSyncFn || require('child_process').spawnSync;
  const plan = revivePlan(platform, plistPath);
  if (!plan) return { attempted: false, ok: false, reason: platform === 'darwin' ? 'no_plist' : 'unsupported' };
  const run = (argv) => {
    try {
      const r = spawnSyncFn(argv[0], argv.slice(1), { timeout: 10 * 1000 });
      return !r.error && r.status === 0;
    } catch (_) { return false; }
  };
  if (run(plan.argv)) return { attempted: true, ok: true, via: 'kickstart' };
  if (run(['launchctl', 'bootstrap', `gui/${currentUid()}`, plistPath])) {
    return { attempted: true, ok: true, via: 'bootstrap' };
  }
  return { attempted: true, ok: false, via: 'kickstart+bootstrap' };
}

// 用户可见文案（additionalContext 单行前缀 [advisor]，与既有控制面行同风格）。
// 关键承诺必须写明：审查功能不受影响——用户容易把「角标没了」读成「顾问也挂了」。
function badgeHintLines(state, platform) {
  if (state === 'waiting') {
    // 不再承诺「退出后自动拉起」：attach-only 语义下外挂不会代启，只有启动器会。
    // 提示必须给出用户真正能做的一步，否则等于把「角标没了」翻译成一句空话。
    return ['[advisor] 角标不可用：当前 ZCode 没有调试端口（直接双击启动的 ZCode 都没有），'
      + '角标/设置面板不可用，但每轮审查不受影响。需要角标时请完全退出 ZCode（⌘Q）后，'
      + '双击「ZCode Advisor」启动器重新打开。'];
  }
  if (state === 'down') {
    if (platform === 'darwin') {
      return ['[advisor] 角标外挂未运行（后台监督进程没在跑）。'
        + `若下轮仍提示，请手动运行：launchctl kickstart -k gui/\$(id -u)/${LAUNCHD_LABEL}，或重启 ZCode。审查功能不受影响。`];
    }
    return ['[advisor] 角标外挂未运行（后台监督进程没在跑），请重装本插件或用启动器重新打开 ZCode。审查功能不受影响。'];
  }
  return [];
}

// 自愈结果行（仅 down 态、真正发起过调用时追加，如实报告成败）。
function reviveResultLines(result) {
  if (!result || !result.attempted) return [];
  if (result.ok) return [`[advisor] 已发起角标外挂自愈（launchctl ${result.via}），约 30 秒内生效。`];
  return ['[advisor] 角标外挂自动拉起失败，请按上一行提示手动处理。'];
}

module.exports = {
  LOCK_FILE_NAME,
  LOCK_TTL_MS,
  STANDBY_FILE_NAME,
  STANDBY_TTL_MS,
  LAUNCHD_LABEL,
  resolveLockDir,
  resolveLockFile,
  resolveStandbyFile,
  readCompanionLock,
  readStandby,
  deriveBadgeState,
  shouldRevive,
  revivePlan,
  tryRevive,
  badgeHintLines,
  reviveResultLines
};
