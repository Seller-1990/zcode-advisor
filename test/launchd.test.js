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

test('LABEL：使用反向域名的固定标识（升级/卸载要能定位同一 agent）', () => {
  assert.strictEqual(L.LABEL, 'local.zcode.advisor');
});

test('plistPath：位于 LaunchAgents 目录且以 Label 命名', () => {
  const dir = tmpDir();
  assert.strictEqual(L.plistPath(dir), path.join(dir, 'local.zcode.advisor.plist'));
});
