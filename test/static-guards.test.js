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

test('面板开关：refreshStatus 回填 zca-enabled（防"保存即静默关闭顾问"）', () => {
  const src = read('tools/companion/inject.js');
  const fnStart = src.indexOf('async function refreshStatus');
  const body = src.slice(fnStart, src.indexOf('\n  }', fnStart));
  assert.match(body, /zca-enabled/, 'refreshStatus 必须回填顾问总开关，否则默认未勾选会被保存为 false');
});

test('测试文件：无遗留的调试输出', () => {
  for (const f of fs.readdirSync(path.join(ROOT, 'test'))) {
    if (!f.endsWith('.test.js')) continue;
    const src = read(path.join('test', f));
    assert.ok(!/\[dbg\]/.test(src), `test/${f} 残留调试输出`);
  }
});
