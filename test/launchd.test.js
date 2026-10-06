'use strict';

// launchd 自启动绑定的回归测试。
//
// 背景：真机两个症状——「点图标无反应」与「直接开 ZCode 没有角标」——的根因之一是
// **完全没有自启动绑定**：顾问外挂必须在用户双击 ZCode 之前就绪，否则那个 ZCode
// 实例没有调试端口，角标永远不出现。修复引入 LaunchAgent（RunAtLoad + KeepAlive）。
//
// 这些键一旦写错，症状都极难排查，故逐条锁死：
//   - 少 RunAtLoad      → 登录不自启（回到原故障）；
//   - 少 KeepAlive      → 崩溃后不恢复；
//   - KeepAlive 用 SuccessfulExit:true → 与 controller 的「让位 exit 0」冲突，
//                          表现为反复重启（真机实测：exit 0 时 run 1 次，exit 1 时 run 5 次）；
//   - 少 ThrottleInterval → 重启风暴刷爆日志；
//   - 少 ZCODE_ADVISOR_SUPERVISED → controller 退回 exit 0 让位语义，
//                          launchd 认为任务完成、不再重启 → 自启动形同虚设。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 先隔离所有「用户真实路径」再 require controller：controller 在模块加载期就解析
// LOG_FILE（controller.cjs:135 `process.env.ZCODE_ADVISOR_COMPANION_LOG || ~/.zcode/...`），
// 不设就会把测试日志写进用户真实的生产日志，把真实故障淹没在噪音里。
process.env.ZCODE_ADVISOR_COMPANION_LOG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zca-log-')), 'companion.log');

const L = require('../tools/companion/launchd.cjs');
const { _internal: I } = require('../tools/companion/controller.cjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zca-launchd-'));
}

// ---------------- plist 内容 ----------------

test('buildPlist：含 RunAtLoad 与 KeepAlive{SuccessfulExit:false}（登录自启 + 崩溃重启）', () => {
  const p = L.buildPlist({ nodeBin: '/x/node', controllerPath: '/x/controller.cjs' });
  assert.match(p, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(p, /<key>RunAtLoad<\/key><true\/>/, '缺 RunAtLoad → 登录不自启（回到原故障）');
  assert.match(p, /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/,
    'KeepAlive 必须用 SuccessfulExit:false——与 controller 的「让位 exit 0」语义配套');
});

test('buildPlist：注入 ZCODE_ADVISOR_SUPERVISED=1（否则 controller 让位退 0，launchd 不再重启）', () => {
  const p = L.buildPlist({ nodeBin: '/x/node', controllerPath: '/x/controller.cjs' });
  assert.match(p, /<key>ZCODE_ADVISOR_SUPERVISED<\/key><string>1<\/string>/,
    '缺该变量 → controller 按未受监督语义 exit 0 让位 → 永久失去监督');
});

test('buildPlist：含 ThrottleInterval（防重启风暴）与日志路径', () => {
  const p = L.buildPlist({ nodeBin: '/x/node', controllerPath: '/x/controller.cjs', logPath: '/tmp/z.log' });
  assert.match(p, /<key>ThrottleInterval<\/key><integer>30<\/integer>/, '必须节流，否则崩溃即重启风暴');
  assert.match(p, /<key>StandardOutPath<\/key><string>\/tmp\/z\.log<\/string>/);
  assert.match(p, /<key>StandardErrorPath<\/key><string>\/tmp\/z\.log<\/string>/);
});

test('buildPlist：node 与 controller 路径完整写入 ProgramArguments', () => {
  const p = L.buildPlist({ nodeBin: '/a b/node', controllerPath: '/c d/controller.cjs' });
  assert.match(p, /<string>\/a b\/node<\/string>/);
  assert.match(p, /<string>\/c d\/controller\.cjs<\/string>/);
});

test('buildPlist：路径含 XML 特殊字符时转义（否则 plist 解析失败、静默不自启）', () => {
  const p = L.buildPlist({ nodeBin: '/x/&<>/node', controllerPath: '/x/controller.cjs' });
  assert.match(p, /<string>\/x\/&amp;&lt;&gt;\/node<\/string>/);
  assert.ok(!/<string>[^<]*&(?!amp;|lt;|gt;)/.test(p), '不得残留未转义的裸 &');
});

// ---------------- 退出码决策（受监督语义的核心不变量） ----------------

test('exitCodeFor：retry 在受监督时退 3、未受监督时保持调用方原语义', () => {
  assert.strictEqual(I.exitCodeFor('retry', true, 0), I.RETRY_EXIT_CODE,
    '受监督时「让位」必须退非零，否则 launchd 认为任务完成、不再重启（自启动形同虚设）');
  assert.strictEqual(I.exitCodeFor('retry', true, 1), I.RETRY_EXIT_CODE);
  assert.strictEqual(I.exitCodeFor('retry', false, 0), 0, '未受监督时保持旧行为（双击启动器静默让位）');
  assert.strictEqual(I.exitCodeFor('retry', false, 1), 1);
});

test('exitCodeFor：fatal 在受监督时退 0（停止重启，不刷日志）', () => {
  assert.strictEqual(I.exitCodeFor('fatal', true, 1), 0,
    'Node 版本过低等永久性失败若退非零，launchd 会每 30s 重启一个注定失败的进程');
  assert.strictEqual(I.exitCodeFor('fatal', false, 1), 1, '未受监督时保持旧行为');
});

test('exitCodeFor：受监督时 retry 与 fatal 的退出码必须相反（两种语义不可混淆）', () => {
  const retry = I.exitCodeFor('retry', true, 0);
  const fatal = I.exitCodeFor('fatal', true, 1);
  assert.notStrictEqual(retry, 0, 'retry 必须非零（触发重启）');
  assert.strictEqual(fatal, 0, 'fatal 必须为零（不重启）');
  assert.notStrictEqual(retry, fatal);
});

test('classifySpawnError：路径不可执行/不存在 → fatal（否则受监督下崩溃重启循环）', () => {
  // 实测触发场景：zcodePath 指向无执行位的文件 → Node 抛 EACCES。
  // 若判成 retry，launchd 会每 30s 重启一个注定失败的进程，刷爆日志且永不恢复。
  for (const code of ['EACCES', 'ENOENT', 'ENOTDIR']) {
    assert.strictEqual(I.classifySpawnError(code), 'fatal', `${code} 应判永久失败`);
  }
  // 资源类错误稍后可能成功，应交给 launchd 重试
  for (const code of ['EMFILE', 'EAGAIN', 'ENOMEM']) {
    assert.strictEqual(I.classifySpawnError(code), 'retry', `${code} 应判可重试`);
  }
  assert.strictEqual(I.classifySpawnError(undefined), 'retry', '未知错误保守按可重试');
});

test('launchd.cjs 与 controller.cjs 的重试退出码一致（协议漂移会让重启静默失效）', () => {
  assert.strictEqual(L.RETRY_EXIT_CODE, I.RETRY_EXIT_CODE,
    '两处常量必须同源：controller 用 3 退出、launchd 按别的值判断会导致行为不一致');
});

// ---------------- 运行时解析 ----------------

test('resolveRuntime：.app 布局解析出 Resources/node + Resources/app/controller.cjs', () => {
  const base = tmpDir();
  const res = path.join(base, 'Resources');
  const app = path.join(res, 'app');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(res, 'node'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(app, 'controller.cjs'), '// c\n');

  const rt = L.resolveRuntime({ dir: app, execPath: '/usr/bin/false' });
  assert.strictEqual(rt.controllerPath, path.join(app, 'controller.cjs'));
  assert.strictEqual(rt.nodeBin, path.join(res, 'node'), '应优先用包内内嵌 node');
  assert.strictEqual(rt.packaged, true);
});

test('resolveRuntime：无内嵌 node 时回退当前解释器并标记为非打包布局', () => {
  const base = tmpDir();
  fs.writeFileSync(path.join(base, 'controller.cjs'), '// c\n');
  const rt = L.resolveRuntime({ dir: base, execPath: '/usr/bin/some-node' });
  assert.strictEqual(rt.nodeBin, '/usr/bin/some-node');
  assert.strictEqual(rt.packaged, false, '非打包布局不得自动装 agent（会指向临时 node 路径）');
});

test('resolveRuntime：找不到 controller 时返回空路径（调用方据此跳过）', () => {
  const rt = L.resolveRuntime({ dir: tmpDir(), execPath: '/usr/bin/node' });
  assert.strictEqual(rt.controllerPath, '');
});

// ---------------- install / uninstall（真实文件，隔离目录） ----------------

test('install：工作树布局默认拒绝（避免把自启动指向 nvm 临时 node）', () => {
  const dir = tmpDir();
  // 有 controller.cjs、但无包内 node → resolveRuntime 判定为非打包布局
  fs.writeFileSync(path.join(dir, 'controller.cjs'), '// c\n');
  const r = L.install({ dir, execPath: '/usr/bin/node' });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /工作树/);
  assert.ok(!fs.existsSync(L.plistPath(dir)), '拒绝时不得落盘 plist');
});

test('install：打包布局写入 plist，内容与 buildPlist 一致，且幂等（二次安装 changed=false）', () => {
  const dir = tmpDir();
  const r1 = L.install({ dir, nodeBin: '/x/node', controllerPath: '/x/controller.cjs' });
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.changed, true);
  const p = L.plistPath(dir);
  assert.ok(fs.existsSync(p));
  assert.strictEqual(fs.readFileSync(p, 'utf8'), L.buildPlist({ nodeBin: '/x/node', controllerPath: '/x/controller.cjs' }));

  const r2 = L.install({ dir, nodeBin: '/x/node', controllerPath: '/x/controller.cjs' });
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.changed, false, '内容未变不应重写（否则每次点图标都触发无谓重载）');
});

test('install：运行时变化时 changed=true（升级后必须重载，否则 launchd 仍跑旧配置）', () => {
  const dir = tmpDir();
  L.install({ dir, nodeBin: '/x/node', controllerPath: '/x/controller.cjs' });
  const r = L.install({ dir, nodeBin: '/y/node2', controllerPath: '/x/controller.cjs' });
  assert.strictEqual(r.changed, true);
});

test('install：默认不加载（避免已有实例在跑时制造反复重启噪音）', () => {
  const dir = tmpDir();
  const r = L.install({ dir, nodeBin: '/x/node', controllerPath: '/x/controller.cjs' });
  assert.strictEqual(r.loaded, false, '不带 --now 时只落盘，由下次登录加载');
});

// 在子进程里跑 launchd 的域操作，并把 launchctl / fs.unlinkSync 打桩。
//
// 必须在 require(launchd.cjs) **之前**打桩：launchd.cjs:26 用的是
// `const { execFileSync } = require('child_process')`，解构在 require 期取值，
// 之后补丁无效。子进程隔离还能避免污染本进程的 require 缓存。
// 真机故障回归防线：沙箱 dir 绝不能触发 `bootout gui/<uid>/local.zcode.advisor`。
function probeUninstall(opts, extraEnv) {
  const runner = `
    const cp = require('child_process');
    const calls = [];
    // execFileSync 必须在 require 前打桩：launchd.cjs:26 解构取值，之后再补丁无效。
    cp.execFileSync = (f, a) => { calls.push([f, a]); return ''; };
    const L = require(${JSON.stringify(path.join(__dirname, '../tools/companion/launchd.cjs'))});
    // unlinkSync 是在调用期通过 fs 模块对象取的，require 之后再打桩即可。
    const fs = require('fs');
    const unlinked = [];
    fs.unlinkSync = (p) => { unlinked.push(p); return undefined; };
    const r = L.uninstall(${JSON.stringify(opts)});
    process.stdout.write(JSON.stringify({ r, calls, unlinked }));
  `;
  const out = require('child_process').execFileSync(process.execPath, ['-e', runner], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, extraEnv || {})
  });
  return JSON.parse(out.trim());
}

// install --now 走的是 ensureLoaded 的「跳过」分支，这是 install 侧的主修复点。
// 必须在子进程里打桩：真机上不拦的话，`install --now` 会把沙箱 plist bootstrap 进
// 用户真实的 gui 域，等于凭空多出一个自启作业。
function probeInstallNow(opts, extraEnv) {
  const runner = `
    const cp = require('child_process');
    const calls = [];
    cp.execFileSync = (f, a) => { calls.push([f, a]); return ''; };
    const L = require(${JSON.stringify(path.join(__dirname, '../tools/companion/launchd.cjs'))});
    const r = L.install(${JSON.stringify(opts)});
    process.stdout.write(JSON.stringify({ r, calls }));
  `;
  const out = require('child_process').execFileSync(process.execPath, ['-e', runner], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, extraEnv || {})
  });
  return JSON.parse(out.trim());
}

test('install --now：沙箱 dir 只落盘，绝不 bootstrap 进真实 gui 域', () => {
  const dir = tmpDir();
  const probe = probeInstallNow({ dir, now: true, nodeBin: '/x/node', controllerPath: '/x/controller.cjs' });
  assert.deepStrictEqual(probe.calls, [],
    '沙箱 install --now 不得调用任何 launchctl（bootstrap 会往用户真实 gui 域塞作业）');
  assert.strictEqual(probe.r.loaded, false);
  assert.strictEqual(probe.r.skipped, true, '必须把「跳过加载」明确报给调用方');
  assert.match(probe.r.warn, /跳过 launchd 加载/);
  assert.ok(fs.existsSync(L.plistPath(dir)), 'plist 仍应正常落盘');
});

// 符号链接规范化：只做 path.resolve 时，「指向真实 LaunchAgents 目录的链接」会被判成
// 另一个位置 → 真实卸载被静默跳过（卸载功能失效）。macOS 上 /var → /private/var 就是
// 这类链接。这里用自建链接锁死语义，不依赖平台上的 /var 是否存在。
test('路径判定：指向真实目录的符号链接仍算真实作业（否则卸载被静默跳过）', { skip: process.platform !== 'darwin' && '仅在 macOS 有 launchd 域' }, () => {
  const linkParent = tmpDir();
  const link = path.join(linkParent, 'LaunchAgents-link');
  const realDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  if (!fs.existsSync(realDir)) return;
  fs.symlinkSync(realDir, link, 'dir');
  // 打桩后 status 不会真的查 launchd；queried 表示「判定为真实作业、允许操作域」。
  const probe = probeStatus({ dir: link });
  assert.strictEqual(probe.r.queried, true,
    '链接指向真实目录时必须认定为真实作业（path.resolve 版本会误判为沙箱）');
});

test('路径判定：沙箱目录即使经 /var 符号链接也不得认定为真实作业', () => {
  const dir = tmpDir();
  const probe = probeStatus({ dir });
  assert.strictEqual(probe.r.queried, false);
});

// status 的域查询同样要打桩：真机上不拦的话，`status` 会去 print 用户真实作业，
// 把真实运行态当成沙箱 plist 的态返回（装了 agent 的开发机上断言必红）。
function probeStatus(opts, extraEnv) {
  const runner = `
    const cp = require('child_process');
    const calls = [];
    cp.execFileSync = (f, a) => { calls.push([f, a]); return ''; };
    const L = require(${JSON.stringify(path.join(__dirname, '../tools/companion/launchd.cjs'))});
    const r = L.status(${JSON.stringify(opts)});
    process.stdout.write(JSON.stringify({ r, calls }));
  `;
  const out = require('child_process').execFileSync(process.execPath, ['-e', runner], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, extraEnv || {})
  });
  return JSON.parse(out.trim());
}

test('uninstall：移除 plist 文件（可逆）', () => {
  const dir = tmpDir();
  L.install({ dir, nodeBin: '/x/node', controllerPath: '/x/controller.cjs' });
  assert.ok(fs.existsSync(L.plistPath(dir)));
  const r = L.uninstall({ dir });
  assert.strictEqual(r.removed, true);
  assert.ok(!fs.existsSync(L.plistPath(dir)));
});

test('uninstall：plist 不存在时不报错（幂等）', () => {
  const r = L.uninstall({ dir: tmpDir() });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.removed, false);
});

// 真机故障回归（本 bug 的原始形态）：npm test → test/launchd.test.js → uninstall({dir})
// → 旧实现无条件 `launchctl bootout gui/<uid>/local.zcode.advisor`。LABEL 是常量，
// bootout 打的是用户**真实**的自启作业：进程被杀 + 作业被卸载 + KeepAlive 监督消失
// → 外挂永远不再自启，表现为「动不动就连不上本机 controller（外挂未运行？）：Failed to fetch」。
// 沙箱 dir 的 uninstall 必须完全不碰 launchd 域。
test('uninstall：dir 覆盖时绝不 bootout 真实 LABEL（本机 npm test 会打死外挂的回归）', () => {
  const dir = tmpDir();
  const probe = probeUninstall({ dir });
  assert.deepStrictEqual(probe.calls, [],
    '沙箱 uninstall 不得调用任何 launchctl（bootout 会终止并卸载用户真实自启作业）');
  assert.strictEqual(probe.r.bootedOut, false);
  assert.deepStrictEqual(probe.unlinked, [L.plistPath(dir)],
    '只应删除沙箱自己的 plist');
});

test('uninstall：ZCODE_ADVISOR_LAUNCHD_DIR 重定向时同样不碰真实 LABEL', () => {
  const dir = tmpDir();
  const probe = probeUninstall({}, { ZCODE_ADVISOR_LAUNCHD_DIR: dir });
  assert.deepStrictEqual(probe.calls, [], '经环境变量重定向也必须与真实作业隔离');
  assert.strictEqual(probe.r.bootedOut, false);
  assert.strictEqual(probe.r.path, path.join(dir, 'local.zcode.advisor.plist'));
});

// 反向防线：真实路径**必须**继续 bootout，否则「卸载」这个功能本身就废了。
// 打桩后真实 plist 不会被删、launchd 也不会被动到。
// 仅在 macOS 有意义：非 darwin 上 canTouchLaunchd 恒为 false（本就不该有 launchctl）。
test('uninstall：无 dir 时仍 bootout 真实 LABEL（卸载功能未被修坏）', { skip: process.platform !== 'darwin' && '仅在 macOS 有 launchd 域' }, () => {
  const probe = probeUninstall({});
  assert.deepStrictEqual(probe.calls, [['/bin/launchctl', ['bootout', `gui/${process.getuid()}/local.zcode.advisor`]]]);
  assert.strictEqual(probe.r.bootedOut, true);
});

test('status：未安装时 exists=false（启动器据此走回退路径）', () => {
  const s = L.status({ dir: tmpDir() });
  assert.strictEqual(s.exists, false);
});

test('status：已写入但未加载时 exists=true、loaded=false', () => {
  const dir = tmpDir();
  L.install({ dir, nodeBin: '/x/node', controllerPath: '/x/controller.cjs' });
  const s = L.status({ dir });
  assert.strictEqual(s.exists, true);
  assert.strictEqual(s.loaded, false, '仅落盘不算加载（启动器据此决定是否自行拉起）');
});

// status 与 uninstall 同类缺陷：旧实现用 `launchctl print gui/<uid>/LABEL` 查真实作业，
// 却把结果当成沙箱 plist 的态。装了 agent 的开发机上沙箱里明明没有 plist，
// 也会报 loaded=true（这条断言在真机上必红）。
test('status：dir 覆盖时不去查询真实作业，queried=false（不得把真实态冒充沙箱态）', () => {
  const s = L.status({ dir: tmpDir() });
  assert.strictEqual(s.queried, false, '重定向时不应查询 launchd 域');
  assert.strictEqual(s.loaded, false);
});

test('LABEL：使用反向域名的固定标识（升级/卸载要能定位同一 agent）', () => {
  assert.strictEqual(L.LABEL, 'local.zcode.advisor');
});

test('plistPath：位于 LaunchAgents 目录且以 Label 命名', () => {
  const dir = tmpDir();
  assert.strictEqual(L.plistPath(dir), path.join(dir, 'local.zcode.advisor.plist'));
});
