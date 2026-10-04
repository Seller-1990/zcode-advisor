#!/usr/bin/env node
'use strict';

// config-bridge：随会话启动的 MCP 桥接进程。
// 作用：把插件设置页（plugin.json userConfig 表单）里保存的值落盘到用户级配置
// ~/.zcode/advisor.config.json——这样 hook（读不到 user_config 环境变量）也能用上 GUI 配置。
// 纪律：
// - **只填补缺失键（例外：model）**：宿主会把 userConfig 声明的 default 展开进环境变量
//   （用户没填也有值），因此这里绝不能覆盖用户级配置里已有的非空值——否则每次会话启动
//   都会把用户在配置面板里调好的设置静默改回表单默认（真机实测踩过：401）。
//   表单是"兜底填充"，不是"权威覆盖"；显式写路径（面板保存按钮）才用覆盖语义。
//   **model 例外**：模型是用户明确要求可从插件设置表单直接修改的全局项（0.2.14 起），
//   表单非空即覆盖（forceKeys），其余键维持只兜底——用户在表单填模型 = 表单说了算，
//   想以面板为准就清空表单模型字段。
// - 0.2.17 起端点/key 不再由本插件维护（一律来自 ZCode 第三方服务商）：旧配置里的
//   apiKey/baseUrl/apiSource 残留会在写入时清除，防止「手动 key 发往服务商端点」的交叉。
// - 落盘失败只写 stderr，不影响 MCP 协议；
// - 启动即落盘，然后再服务最小 MCP 协议（stdio JSON-RPC），宿主异常时也不阻塞会话。

const fs = require('fs');
const os = require('os');
const path = require('path');

const USER_CONFIG = process.env.ZCODE_ADVISOR_USER_CONFIG
  || path.join(os.homedir(), '.zcode', 'advisor.config.json');

// 从 env 提取 GUI 表单值（由 plugin.json mcpServers env 的 ${user_config.*} 模板填充）。
function guiValuesFromEnv(env) {
  const out = {};
  const map = {
    ZCODE_ADVISOR_CFG_MODEL: 'model',
    ZCODE_ADVISOR_CFG_REVIEW_MODE: 'reviewMode',
    ZCODE_ADVISOR_CFG_ZCODE_PROVIDER: 'zcodeProvider',
    ZCODE_ADVISOR_CFG_MAX_TOKENS: 'maxTokens'
  };
  for (const [envKey, cfgKey] of Object.entries(map)) {
    const v = String(env[envKey] || '').trim();
    // 宿主可能把未填字段展开为字面模板串——同样跳过。
    if (!v || v.includes('${')) continue;
    // max_tokens：default 0 = 表单未干预；0/非法/越界一律跳过（与面板保存语义一致）
    if (cfgKey === 'maxTokens') {
      const mt = parseInt(v, 10);
      if (Number.isFinite(mt) && mt >= 64 && mt <= 16384) out[cfgKey] = mt;
      continue;
    }
    out[cfgKey] = v;
  }
  return out;
}

function isBlank(v) {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

// 合并策略：
// - 默认（覆盖）：GUI 非空值覆盖同名键，其余既有字段原样保留。
//   用于**显式写路径**——配置面板「保存配置」按钮、controller 的保存动作。
// - fillMissingOnly（只填补）：GUI 值仅在既有配置对应键缺失/空值时才写入，
//   已有非空值一律保留。用于**随会话启动的桥接进程**（见文件头纪律）。
function mergeUserConfig(existingRaw, guiValues, opts) {
  const fillMissingOnly = !!(opts && opts.fillMissingOnly);
  // opts.forceKeys（可选数组）：fillMissingOnly 语义下仍**非空即覆盖**的键。
  // 背景：model 是用户明确要求可从插件设置表单直接修改的全局项——若同样只兜底，
  // 配置文件里已有非空模型时表单永远改不动。其余键维持只兜底纪律（宿主缓存旧表单值时，
  // 覆盖语义会把面板里调好的配置静默改回——真机 401 教训）。
  const forceKeys = opts && Array.isArray(opts.forceKeys) ? opts.forceKeys : null;
  // opts.conflicts（可选数组，传入即收集）：fillMissingOnly 语义下被跳过、且 GUI 值
  // 与既有值**不同**的键。等值跳过是稳态（表单默认 === 已保存值），不算冲突——否则
  // 每次会话启动都会误报。冲突键不落盘、不报错，仅供提示与状态查询。
  const conflicts = opts && Array.isArray(opts.conflicts) ? opts.conflicts : null;
  // opts.overwrites（可选数组，传入即收集）：forceKeys 覆盖语义下**值确实变了**的键。
  // 等值写入也是稳态，不记；只有真覆盖才提示（用户需知道面板值被表单压回）。
  const overwrites = opts && Array.isArray(opts.overwrites) ? opts.overwrites : null;
  let base = {};
  if (existingRaw && typeof existingRaw === 'object' && !Array.isArray(existingRaw)) {
    base = existingRaw;
  }
  const merged = {};
  // 逐键拷贝并跳过 __proto__：Object.assign 对自有 __proto__ 键走 [[Set]] 触发原型 setter，
  // 键丢失且与 existing 的 stringify 比较恒不等 → 等值跳过保证被击穿（每次启动必写盘）。
  for (const k of Object.keys(base)) {
    if (k === '__proto__') continue;
    merged[k] = base[k];
  }
  for (const [k, v] of Object.entries(guiValues || {})) {
    if (k === '__proto__') continue;
    if (isBlank(v)) continue;
    const forced = !!(fillMissingOnly && forceKeys && forceKeys.includes(k));
    if (fillMissingOnly && !isBlank(merged[k]) && !forced) {
      if (conflicts && String(v) !== String(merged[k])) conflicts.push(k);
      continue; // 已有非空值：用户配置优先
    }
    if (forced && !isBlank(merged[k]) && String(v) !== String(merged[k]) && overwrites) {
      overwrites.push(k);
    }
    merged[k] = v;
  }
  return merged;
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_) {}
}

// 配置文件跨进程 RMW 临界区。
// **锁协议的 vendored 双副本必须逐字一致**：本文件与 tools/companion/controller.cjs
// （发行包不含 hooks/ 无法 require 共享，只能复制；test/static-guards.test.js 锁两副本
// 的协议标记防漂移）。写方全景：本文件 writeUserConfig（桥接启动 + setup-server 面板保存
// 经它共享）、controller saveUserConfig；auto-enable 仅「不存在则创建」，不入锁。
//   协议：锁文件 <target>.lock，内容=持有者 pid，wx 抢建；持有者 pid 已死或锁 mtime>10s
//   → 接管；进入与写入前双查属主，仅属主清除；EEXIST 重试 40×25ms≈1s，EACCES/EROFS
//   等永久性失败立即放弃（只读 HOME 下不再白烧 1s）。
function withConfigLock(target, fn) {
  const lock = `${target}.lock`;
  const myPid = String(process.pid);
  let got = false;
  for (let i = 0; i < 40 && !got; i++) {
    try {
      fs.writeFileSync(lock, myPid, { flag: 'wx' });
      got = true;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') return false;
      let holder = '';
      try { holder = fs.readFileSync(lock, 'utf8').trim(); } catch (_) {}
      let stale = true;
      try { stale = Date.now() - fs.statSync(lock).mtimeMs > 10000; } catch (_) {}
      const pid = parseInt(holder, 10);
      let alive = false;
      if (pid > 0) {
        try { process.kill(pid, 0); alive = true; } catch (e) { alive = !!(e && e.code === 'EPERM'); }
      }
      if (!alive || stale) { try { fs.unlinkSync(lock); } catch (_) {} }
      sleepSync(25);
    }
  }
  if (!got) return false;
  const ownLock = () => {
    try { return fs.readFileSync(lock, 'utf8').trim() === myPid; } catch (_) { return false; }
  };
  try {
    if (!ownLock()) return false;
    return fn();
  } finally {
    try { if (fs.readFileSync(lock, 'utf8').trim() === myPid) fs.unlinkSync(lock); } catch (_) {}
  }
}

function writeJsonAtomic(target, text) {
  // 该文件含 API key：新建目录/文件收紧到 0700/0600，不依赖 umask（默认会落成 0644）。
  // rename 整体替换目标文件，历史遗留的宽权限文件也一并收紧；Windows 忽略 mode（ACL 继承）。
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  try {
    // Windows 上杀毒/索引器持有目标句柄时 rename 报 EPERM（hooks/lib/state.js saveState
    // 同款实证），3 次退避重试。
    for (let i = 0; ; i++) {
      try { fs.renameSync(tmp, target); return; } catch (err) {
        if (i >= 2 || !err || (err.code !== 'EPERM' && err.code !== 'EACCES')) throw err;
        sleepSync(30 * (i + 1));
      }
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {} // 成功时 tmp 已不存在；失败时清尸
  }
}

function writeUserConfig(guiValues, file, opts) {
  const target = file || USER_CONFIG;
  const values = guiValues || {};
  // ⚠️ 空 GUI 值**不能**在这里直接早退：0.2.16→0.2.17 升级用户的配置可能只剩
  // `{apiKey:'...'}`（旧版唯一必填项），而桥接在没收到 CFG_* 环境变量时 values 就是空——
  // 早退会让下面的 legacy 清理永远不跑，明文 key 长期留盘（安全意图落空）。
  // 改为继续往下走：清理后若确实无变化，后面的「无变化不落盘」会自然短路。
  const hasValues = Object.keys(values).length > 0;
  // 抢锁前先建目录：wx 建锁需要父目录存在（否则 ENOENT 被误判为永久性失败立即放弃）。
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  // 读-合-比-写全程在跨进程临界区内：面板保存与桥接启动写并发时不再互相覆盖（丢更新）。
  // 冲突/覆盖收集：调用方传了数组就用调用方的（同步填充），否则内部自建并随返回值带出。
  const conflicts = opts && Array.isArray(opts.conflicts) ? opts.conflicts : [];
  const overwrites = opts && Array.isArray(opts.overwrites) ? opts.overwrites : [];
  const outcome = withConfigLock(target, () => {
    let existing = null;
    try {
      existing = JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch (err) {
      if (err && err.code === 'ENOENT') existing = null; // 首次写入，正常路径
      else {
        // 损坏/不可读 → 拒绝写入：静默拿空 base 重建会把盘上的 apiKey/maxTokens
        // 等全部蒸发（401 同构事故）。对齐 removeUserConfigKeys 的红线：损坏必须报失败。
        return {
          changed: false, file: target, conflicts, overwrites,
          error: `配置文件已损坏或不可读（${(err && err.code) || 'parse'}），拒绝自动写入以免丢失已有配置；请修复或删除该文件：${target}`
        };
      }
    }
    if (existing !== null && (typeof existing !== 'object' || Array.isArray(existing))) {
      // 合法 JSON 但不是对象（如数组/数字）：同样拒绝——mergeUserConfig 会把非对象
      // base 当空处理，写盘等于清空重建。
      return {
        changed: false, file: target, conflicts, overwrites,
        error: `配置文件内容不是 JSON 对象，拒绝自动写入以免丢失已有配置；请修复或删除该文件：${target}`
      };
    }
    const merged = mergeUserConfig(existing || {}, values, Object.assign({}, opts, { conflicts, overwrites }));
    // 0.2.17：端点/key 只来自 ZCode 服务商，插件配置里的手动残留（apiKey/baseUrl/apiSource/
    // zcodeModel）写入时一并清除——留着会让用户误以为它们还在生效，且明文 key 是纯风险。
    for (const legacy of ['apiKey', 'baseUrl', 'apiSource', 'zcodeModel']) {
      if (Object.prototype.hasOwnProperty.call(merged, legacy)) delete merged[legacy];
    }
    // 无实际变化就不落盘：桥接进程每次会话启动都跑一遍，无谓改写会污染 mtime
    // 并让用户误以为配置被改动（排查 401 时正是靠 mtime 定位到本缺陷）。
    if (JSON.stringify(merged) === JSON.stringify(existing || {})) {
      return { changed: false, file: target, conflicts, overwrites };
    }
    writeJsonAtomic(target, JSON.stringify(merged, null, 2));
    return { changed: true, file: target, keys: Object.keys(values), conflicts, overwrites };
  });
  if (outcome === false) {
    // 拿不到锁（约 1s）：如实上报，调用方决定失败语义。fillMissingOnly 不会在下次会话
    // 「兜底」补回本次写入（只填缺失键），显式保存必须当场成功或当场报错。
    return { changed: false, file: target, lockTimeout: true, conflicts, overwrites };
  }
  return outcome;
}

// 删除用户级配置里的键（当前唯一调用方：面板「清除 API key」，keys=['apiKey']）。
// 覆盖语义做不到这件事——writeUserConfig 只会写非空值；而直接整体重写文件会与
// 面板保存/桥接启动并发丢更新，因此删除也必须走同一把跨进程锁、同一条原子写路径。
// 红线：损坏/非对象配置**报失败**而不是静默 ok（用户以为清掉了，实际旧 key 还在盘上）；
// mkdir 在抢锁前（同 writeUserConfig 的 ENOENT 教训）；逐键拷贝跳过 __proto__。
function removeUserConfigKeys(keys, file) {
  const target = file || USER_CONFIG;
  const wanted = (Array.isArray(keys) ? keys : []).filter((k) => typeof k === 'string' && k);
  if (wanted.length === 0) return { changed: false, file: target, removed: [] };
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const outcome = withConfigLock(target, () => {
    let existing;
    try {
      existing = JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch (err) {
      // 文件不存在 = 幂等成功（本来就没有 key 可删）；损坏 = 失败——
      // 用户必须知道旧 key 还在盘上，而不是拿到一个假装成功的 ok。
      if (err && err.code === 'ENOENT') return { changed: false, file: target, removed: [] };
      return { changed: false, file: target, removed: [], error: '配置文件已损坏，无法安全删除；请手动检查 ' + target };
    }
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      return { changed: false, file: target, removed: [], error: '配置文件不是 JSON 对象，无法安全删除' };
    }
    const rebuilt = {};
    const removed = [];
    for (const k of Object.keys(existing)) {
      if (k === '__proto__') continue;
      if (wanted.includes(k)) { removed.push(k); continue; }
      rebuilt[k] = existing[k];
    }
    if (removed.length === 0 || Object.keys(rebuilt).length === Object.keys(existing).length) {
      // removed 为空=键本就不存在；长度守卫双保险（ wanted 全部命中时 rebuilt 必然更短）
      return { changed: false, file: target, removed: [] };
    }
    writeJsonAtomic(target, JSON.stringify(rebuilt, null, 2));
    return { changed: true, file: target, removed };
  });
  if (outcome === false) {
    return { changed: false, file: target, lockTimeout: true, removed: [] };
  }
  return outcome;
}

// —— 最小 MCP stdio 服务（initialize / tools/list / tools/call / ping）——
function serveMcp() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      handle(msg);
    }
  });
  process.stdin.on('end', () => process.exit(0));

  function send(obj) {
    try { process.stdout.write(JSON.stringify(obj) + '\n'); } catch (_) {}
  }

  function handle(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.id === undefined) return; // notification：忽略
    switch (msg.method) {
      case 'initialize':
        send({
          jsonrpc: '2.0', id: msg.id,
          result: {
            protocolVersion: (msg.params && msg.params.protocolVersion) || '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'zcode-advisor-config-bridge', version: '0.2.0' }
          }
        });
        return;
      case 'tools/list':
        send({
          jsonrpc: '2.0', id: msg.id,
          result: {
            tools: [{
              name: 'advisor_config_status',
              description: '返回 zcode-advisor GUI 配置桥接状态',
              inputSchema: { type: 'object', properties: {} }
            }]
          }
        });
        return;
      case 'tools/call':
        // 早期实现固定返回 'config bridge active'——状态查询名存实亡。
        // 现在返回真实解析结果（key 是否配置、来源、已存键清单）。
        send({
          jsonrpc: '2.0', id: msg.id,
          result: { content: [{ type: 'text', text: JSON.stringify(bridgeStatus()) }] }
        });
        return;
      case 'ping':
        send({ jsonrpc: '2.0', id: msg.id, result: {} });
        return;
      default:
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
    }
  }
}

function bridgeStatus() {
  let cfg = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(USER_CONFIG, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) cfg = parsed;
  } catch (_) {}
  return {
    ok: true,
    file: USER_CONFIG,
    // 0.2.17：审查凭据一律来自 ZCode 第三方服务商（~/.zcode/v2/config.json），
    // 本文件不再保存端点/key；这里只回报已保存的选择（服务商/模型）。
    provider: String(cfg.zcodeProvider || ''),
    model: String(cfg.model || ''),
    keys: Object.keys(cfg).filter((k) => k !== '__proto__')
  };
}

function main() {
  const conflicts = [];
  const overwrites = [];
  let result = { changed: false, file: USER_CONFIG, conflicts, overwrites };
  try {
    // fillMissingOnly：宿主展开的 userConfig 默认值只用于兜底，绝不覆盖用户已配置的非空值。
    // 例外 forceKeys=['model']：模型是用户明确要求「插件设置表单可直接改全局」的键，
    // 表单非空即覆盖（见 mergeUserConfig 注释）。
    result = writeUserConfig(guiValuesFromEnv(process.env), undefined,
      { fillMissingOnly: true, forceKeys: ['model'], conflicts, overwrites });
  } catch (err) {
    // 关键：conflicts/overwrites 与 result 共享同一数组引用，merge 阶段可能已填充——
    // 异常路径必须整体重置 result，否则下方「已作为全局模型写入」会在**写盘失败**的
    // 同一进程里照打不误（假成功，复审后端对抗者击穿点）。
    result = { changed: false, file: USER_CONFIG, conflicts: [], overwrites: [] };
    try { process.stderr.write(`[advisor-bridge] 落盘失败: ${err && err.message}\n`); } catch (_) {}
  }
  if (process.env.ZCODE_ADVISOR_BRIDGE_VERBOSE === '1') {
    try { process.stderr.write(`[advisor-bridge] ${JSON.stringify(result)}\n`); } catch (_) {}
  } else if (result.error) {
    // 损坏/不可读文件：拒绝写入的失败必须可见（否则用户不知道兜底失效了）
    try { process.stderr.write(`[advisor-bridge] ${result.error}\n`); } catch (_) {}
  } else if (result.lockTimeout) {
    // 归因留两种可能：锁被占用是暂时性，EROFS/ENOSPC 是永久性——旧文案只说前者会误导排障
    try { process.stderr.write('[advisor-bridge] 无法获取配置文件锁（被其他进程占用，或文件系统只读/已满），本次跳过写入\n'); } catch (_) {}
  } else if (result.changed && Array.isArray(result.overwrites) && result.overwrites.includes('model')) {
    // 表单模型覆盖了本地配置里已有的非空模型：这是 forceKeys 的预期行为，但用户
    // 可能不知道两头入口在互相顶（面板刚改的模型被下次会话启动的表单值压回）。
    // 指明优先关系与退出方式，不猜哪边是对的。
    try {
      process.stderr.write('[advisor-bridge] 提示：插件设置页表单的「模型」已作为全局模型写入（覆盖了本地配置此前保存的值）。'
        + '若想以配置面板/角标面板为准，请清空插件设置页的模型字段并保存\n');
    } catch (_) {}
  }
  serveMcp();
}

module.exports = { guiValuesFromEnv, mergeUserConfig, writeUserConfig, removeUserConfigKeys, bridgeStatus, USER_CONFIG };

if (require.main === module) main();
