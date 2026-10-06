'use strict';

// 面向「发行/安装层」的静态守卫测试。
//
// 背景：独立复审发现 4 个 blocker 全部集中在部署链路，且根因是同一个——
// **同一份「运行时文件清单」在 4 处各自维护、互不校验**：
//   1. build-meta.cjs 的 COMPANION_FILES（require 闭包推导）
//   2. sync-plugin-dir.cjs 的 ITEMS
//   3. stagePluginPayload 的 items
//   4. MAC_INSTALL_SH 的 cp 清单
// B3（Windows 不打包 auto-enable）、B4（arm64 硬编码 x64）、C5、C6 都是它的投影。
//
// 这些测试不跑构建，直接静态校验「引用」与「清单」是否闭合，
// 让同类缺失在 npm test 阶段暴露，而不是等用户安装后发现。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

test('child_process：controller.cjs 调用的每个 API 都已解构导入', () => {
  const src = read('tools/companion/controller.cjs');
  const m = /const\s*\{([^}]+)\}\s*=\s*require\('child_process'\)/.exec(src);
  assert.ok(m, 'controller.cjs 应解构 require(child_process)');
  const imported = new Set(m[1].split(',').map((s) => s.trim().split(':')[0].trim()).filter(Boolean));

  // 实际被调用的 child_process API 名
  const APIs = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
  const missing = APIs.filter((api) => {
    const re = new RegExp(`(^|[^\\w.])${api}\\s*\\(`, 'm');
    return re.test(src) && !imported.has(api);
  });
  assert.deepStrictEqual(missing, [],
    `controller.cjs 调用了未导入的 child_process API：${missing.join(', ')}（缺失会抛 ReferenceError 并被静默吞掉）`);
});

test('saveUserConfig：startEnabled 分支不早于 v 的声明（防 TDZ）', () => {
  const src = read('tools/companion/controller.cjs');
  const fnStart = src.indexOf('function saveUserConfig');
  assert.ok(fnStart > -1, '应存在 saveUserConfig');
  const body = src.slice(fnStart, src.indexOf('\n}', fnStart));

  const declIdx = body.indexOf('const v = patch[k];');
  const useIdx = body.indexOf("if (k === 'startEnabled')");
  assert.ok(declIdx > -1, 'saveUserConfig 应有 const v = patch[k]');
  assert.ok(useIdx > -1, 'saveUserConfig 应有 startEnabled 分支');
  assert.ok(declIdx < useIdx,
    'const v 必须在 startEnabled 分支之前声明——写在之后会触发 TDZ，使所有保存请求 500');
});

test('Windows 包：NSIS 引用的关键文件都被 buildWin 打包', () => {
  const nsis = read('tools/companion/packagers.cjs');
  // NSIS 里 $INSTDIR\xxx 引用的文件（取 basename，避免路径转义差异）
  const refs = new Set();
  const re = /\$INSTDIR\\+([A-Za-z0-9_.\\-]+)/g;
  let m;
  while ((m = re.exec(nsis)) !== null) {
    const rel = m[1].replace(/\\+/g, '/');
    if (/uninstall/i.test(rel)) continue;   // 卸载器由安装器自建
    refs.add(rel.split('/').pop());
  }
  assert.ok(refs.size > 0, 'NSIS 脚本应至少引用一个文件');

  const bi = read('tools/companion/build-installer.cjs');
  const winStart = bi.indexOf('async function buildWin');
  assert.ok(winStart > -1, '应有 buildWin');
  const winBody = bi.slice(winStart);

  const missing = [...refs].filter((base) => {
    if (winBody.includes("'" + base + "'")) return false;
    if (base === 'node.exe') return !winBody.includes('bin/node.exe');
    return !(winBody.includes('stagePluginPayload') || winBody.includes('collectEntries'));
  });
  assert.deepStrictEqual(missing, [],
    'NSIS 引用但 buildWin 未打包：' + missing.join(', ') + '（安装后 ExecWait 会静默失败）');

  assert.match(winBody, /auto-enable\.cjs/, 'buildWin 必须打包 auto-enable.cjs');
  assert.match(winBody, /stagePluginPayload/, 'buildWin 必须打包插件 payload（否则 Windows 装不上插件）');
});

test('macOS 包：stageMacApp 的 pluginDir 不得硬编码架构，且 payload 语义正确', () => {
  const bi = read('tools/companion/build-installer.cjs');

  // 不能硬编码 x64（曾使 arm64 DMG 缺插件本体）
  assert.ok(!/\.stage-mac-payload-x64/.test(bi),
    'pluginDir 不得硬编码 x64——arm64 DMG 会缺插件本体');

  // pluginRoot 必须由 arch 推导
  assert.match(bi, /stagePluginPayload\(path\.join\(DIST,\s*`\.stage-mac-payload-\$\{arch\}`\)\)/,
    'payload 目录应由当前 arch 推导');

  // stageMacApp 收到的必须是 pluginRoot（= <stage>/plugin），而非其父目录：
  // cpSync(pluginDir, Resources/app/plugin) 是"整体拷为"，传父目录会多套一层。
  const winStart = bi.indexOf('async function buildMac');
  const macBody = bi.slice(winStart);
  assert.match(macBody, /pluginDir:\s*pluginRoot/, 'pluginDir 应传 pluginRoot（避免 plugin/plugin 嵌套）');
});

test('launchd 自启动：三个发行路径都必须携带 launchd.cjs（独立 CLI 不在 require 闭包内）', () => {
  const bi = read('tools/companion/build-installer.cjs');
  const pk = read('tools/companion/packagers.cjs');
  const it = read('tools/companion/install-templates.cjs');
  const bm = read('tools/companion/build-meta.cjs');

  // 前提：它确实不在依赖闭包里（否则不该显式打包，说明设计已变）
  assert.ok(!/launchd\.cjs/.test(bm), 'launchd.cjs 不应进入 require 闭包（它是独立 CLI）');

  // 1) .app（stageMacApp 拷贝 + buildMac 的 tar.gz entries）
  assert.match(pk, /launchdMod[\s\S]{0,200}appRes[\s\S]{0,80}launchd\.cjs/,
    'stageMacApp 必须把 launchd.cjs 拷进 Resources/app');
  // 2) tar.gz
  assert.match(bi, /entries\.push\(\{\s*path:\s*'launchd\.cjs'/,
    'buildMac 必须把 launchd.cjs 打进 tar.gz');
  // 3) tar.gz 的 install.sh
  assert.match(it, /cp -f "\$SRC\/launchd\.cjs" "\$SUPPORT\/"/,
    'install.sh 必须把 launchd.cjs 复制到 Support 目录');
  // 4) 构建期校验（缺了就报错，而不是静默失效）
  assert.match(bi, /names\.includes\('launchd\.cjs'\)/, 'tar.gz 校验必须要求 launchd.cjs');
  assert.match(bi, /launchdMod\)/, '.app 校验必须要求 launchd.cjs');
});

test('macOS DMG：必须校验内嵌 node（GUI 启动不继承 PATH，缺 node 必然启动失败）', () => {
  const bi = read('tools/companion/build-installer.cjs');
  // 回归背景：曾用 --no-embed-node 构建并分发，用户双击只得到「找不到 node」弹窗
  // （Finder 启动不继承 shell PATH，nvm 管理的 node 找不到），而校验当时不查 node。
  assert.match(bi, /const nodeBin = path\.join\(resources, 'node'\)/,
    'verifyDmg 必须检查 .app 内的内嵌 node');
  assert.match(bi, /expectNode/, '内嵌 node 的校验要区分构建选项（--no-embed-node 时只警告）');
  // 校验必须真正失败（throw），不能只 warn
  const idx = bi.indexOf("if (!fs.existsSync(nodeBin))");
  assert.ok(idx > -1, '应有 node 缺失分支');
  assert.match(bi.slice(idx, idx + 400), /throw new Error/,
    '内嵌 node 缺失必须 throw（否则构建绿灯放行坏包）');
});

test('controller：spawn 宿主必须监听 error 事件（否则未处理 error 直接崩进程）', () => {
  const src = read('tools/companion/controller.cjs');
  // 回归背景：实测用不可执行的 zcodePath 触发，Node 对未处理的 'error' 会抛异常终止
  // 进程；受监督时 launchd 见非零退出就每 30s 重启 → 崩溃重启循环刷爆日志。
  const spawnIdx = src.indexOf('const child = spawn(zcodePath');
  assert.ok(spawnIdx > -1, '应保存 spawn 返回值（需要挂 error 监听）');
  const tail = src.slice(spawnIdx, spawnIdx + 400);
  assert.match(tail, /child\.once\('error'/, 'spawn 返回的 child 必须监听 error 事件');
  // 且必须区分「永久性失败」（EACCES/ENOENT，重试无意义）与可重试失败
  assert.match(src, /EACCES/, 'EACCES（不可执行）应走永久失败分支');
  assert.match(src, /exitPermanent/, '不可恢复的启动失败应走 exitPermanent（受监督时停止重启）');
});

test('controller：日志不得重复落盘（stdout 已指向日志文件时不再 appendFileSync）', () => {
  const src = read('tools/companion/controller.cjs');
  // 回归背景：log() 既写 stdout 又 appendFileSync(LOG_FILE)，而 launchd 的
  // StandardOutPath 与启动器的 nohup >>LOG 都指向同一文件 → 每行落盘两次。
  assert.match(src, /detectStdoutIsLogFile/, '应检测 stdout 是否已指向日志文件');
  const logIdx = src.indexOf('const log = (...a) =>');
  const logBody = src.slice(logIdx, logIdx + 600);
  assert.match(logBody, /if \(detectStdoutIsLogFile\(\)\) return;/,
    'stdout 已指向日志文件时必须提前返回，否则重复落盘');
});

test('stagePluginPayload：items 覆盖 plugin.json 声明的全部组件（含 tools/）', () => {
  const bi = read('tools/companion/build-installer.cjs');
  const m = /const items = \[([\s\S]*?)\];/.exec(bi.slice(bi.indexOf('function stagePluginPayload')));
  assert.ok(m, '应能定位 stagePluginPayload 的 items');
  const items = m[1].match(/'[^']+'/g).map((s) => s.replace(/'/g, ''));

  // plugin.json 的 mcpServers 若引用 ${CLAUDE_PLUGIN_ROOT}/x/y.js，则顶层目录 x 必须在 items
  const plugin = JSON.parse(read('.zcode-plugin/plugin.json'));
  const needed = new Set();
  for (const srv of Object.values(plugin.mcpServers || {})) {
    for (const arg of srv.args || []) {
      const mm = /\$\{CLAUDE_PLUGIN_ROOT\}\/([^/]+)\//.exec(arg);
      if (mm) needed.add(mm[1]);
    }
  }
  const missing = [...needed].filter((d) => !items.includes(d));
  assert.deepStrictEqual(missing, [],
    `payload 清单缺少 plugin.json 声明的目录：${missing.join(', ')}（配置桥接会失效）`);
  // hooks 与 commands 是功能主体
  for (const d of ['hooks', 'commands']) assert.ok(items.includes(d), `items 应含 ${d}`);
});

test('install.sh：使用包内 payload（tar.gz 路径也要能装插件）', () => {
  const t = read('tools/companion/install-templates.cjs');
  assert.match(t, /auto-enable\.cjs/, 'install.sh 应调用 auto-enable.cjs');
  assert.match(t, /\$SRC\/plugin/, 'install.sh 应使用包内 plugin/ payload');
});

test('readHistory：controller 与 hooks 的路径解析规则一致（含 STATE_DIR 分支）', () => {
  const ctrl = read('tools/companion/controller.cjs');
  const hook = read('hooks/lib/history.js');
  // 两份实现都必须处理这三个来源
  for (const src of [ctrl, hook]) {
    assert.match(src, /ZCODE_ADVISOR_HISTORY/, '应支持 ZCODE_ADVISOR_HISTORY');
    assert.match(src, /ZCODE_ADVISOR_STATE_DIR/, '应支持 ZCODE_ADVISOR_STATE_DIR（隔离部署）');
  }
});

test('配置写入：含 apiKey 的落盘收紧到 0600', () => {
  const ctrl = read('tools/companion/controller.cjs');
  const fnStart = ctrl.indexOf('function saveUserConfig');
  const body = ctrl.slice(fnStart, ctrl.indexOf('\n}', fnStart));
  assert.match(body, /0o600|0o700/, 'saveUserConfig 应设置 0o600/0o700（配置含明文 apiKey）');
});

test('面板开关：refreshStatus 回填会话启用开关（防"打开面板即误关"）', () => {
  const src = read('tools/companion/inject.js');
  const fnStart = src.indexOf('async function refreshStatus');
  const body = src.slice(fnStart, src.indexOf('\n  }', fnStart));
  // 0.2.15 起开关是会话级（zca-session-enabled，初始态来自 /api/session）——
  // 不变量不变：必须回填，否则默认未勾选会被一次误触停用。
  assert.match(body, /zca-session-enabled/, 'refreshStatus 必须回填会话启用开关');
});

test('配置锁协议：config-bridge 与 controller 的 vendored 双副本一致（防协议漂移复活丢更新）', () => {
  // 两份 withConfigLock 是同一协议的复制（发行包不含 hooks/，无法 require 共享）。
  // 协议若单侧漂移（锁路径/陈旧阈值/属主检查），一方会偷走另一方的新鲜锁 → RMW 竞态复活。
  // 这里锁住协议的关键标记；改协议必须两处同改（本测试会拦住只改一侧的提交）。
  const bridge = read('tools/config-bridge.js');
  const ctrl = read('tools/companion/controller.cjs');
  const markers = [
    'function withConfigLock',
    '`${target}.lock`',    // 锁路径后缀（<target>.lock）
    '10000',               // 陈旧阈值 10s
    "flag: 'wx'",          // wx 抢建
    'process.kill(pid, 0)', // 持有者存活检查（EPERM=存活）
    'code !== \'EEXIST\'',  // 仅竞争重试，EACCES/EROFS 立即失败
  ];
  for (const m of markers) {
    assert.ok(bridge.includes(m), `tools/config-bridge.js 缺锁协议标记：${m}`);
    assert.ok(ctrl.includes(m), `tools/companion/controller.cjs 缺锁协议标记：${m}`);
  }
});

test('测试文件：无遗留的调试输出', () => {
  for (const f of fs.readdirSync(path.join(ROOT, 'test'))) {
    if (!f.endsWith('.test.js')) continue;
    const src = read(path.join('test', f));
    assert.ok(!/\[dbg\]/.test(src), `test/${f} 残留调试输出`);
  }
});

// 生产日志隔离守卫。
//
// 真机故障：controller.cjs:135 在模块加载期固化
//   LOG_FILE = process.env.ZCODE_ADVISOR_COMPANION_LOG || ~/.zcode/advisor-companion.log
// 只要测试 require 了 controller 却忘了设该 env，测试产生的日志（startApi 的
// 「本机 API 就绪」、saveUserConfig 的 0.2.17 迁移行）就会写进用户**真实**日志，
// 把真实故障淹没在测试噪音里，且「外挂从未启动」会被误读成「外挂反复启动」。
// 这条守卫让「新增一个 require controller 的测试却忘记隔离」在 npm test 阶段就暴露。
test('测试文件：require controller.cjs 必须同时隔离 ZCODE_ADVISOR_COMPANION_LOG', () => {
  const offenders = [];
  for (const f of fs.readdirSync(path.join(ROOT, 'test'))) {
    if (!/\.test\.(js|cjs)$/.test(f)) continue;
    const src = read(path.join('test', f));
    // 只看真正 require() 控制器模块的文件；纯读文本的静态断言不算。
    if (!/require\(['"][^'"]*companion\/controller/.test(src)) continue;
    if (!/ZCODE_ADVISOR_COMPANION_LOG/.test(src)) offenders.push(`test/${f}`);
  }
  assert.deepStrictEqual(offenders, [],
    `以下测试 require 了 controller.cjs 但未隔离 ZCODE_ADVISOR_COMPANION_LOG，会污染用户真实日志：${offenders.join(', ')}`);
});
