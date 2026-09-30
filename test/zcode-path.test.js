'use strict';

// ZCode 路径探测的纯函数测试。
// 背景：原实现只探测 Windows 路径，macOS 上无候选 → process.exit(1)，
// 使 README 声称可用的 macOS 包实际无法启动。这里锁住平台分支行为。

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  parsePlistString,
  isAppBundle,
  resolveExecutablePath,
  macCandidates,
  winCandidates,
  detectZcodePath,
  missingHint
} = require('../tools/companion/zcode-path.cjs');

const APP = '/Applications/ZCode.app';
const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleName</key><string>ZCode</string>
<key>CFBundleExecutable</key><string>ZCode</string>
<key>CFBundleIdentifier</key><string>dev.zcode.app</string>
</dict></plist>`;

// ---------------- plist 解析 ----------------

test('parsePlistString：取出 CFBundleExecutable，缺失返回空串', () => {
  assert.strictEqual(parsePlistString(PLIST, 'CFBundleExecutable'), 'ZCode');
  assert.strictEqual(parsePlistString(PLIST, 'CFBundleIdentifier'), 'dev.zcode.app');
  assert.strictEqual(parsePlistString(PLIST, 'NotThere'), '');
  assert.strictEqual(parsePlistString('', 'CFBundleExecutable'), '');
});

test('parsePlistString：自定义可执行文件名也能取出（不硬编码 ZCode）', () => {
  const custom = '<key>CFBundleExecutable</key><string>ZCodeBeta</string>';
  assert.strictEqual(parsePlistString(custom, 'CFBundleExecutable'), 'ZCodeBeta');
});

// ---------------- .app 路径解析 ----------------

test('isAppBundle：识别 .app 与结尾斜杠', () => {
  assert.ok(isAppBundle('/Applications/ZCode.app'));
  assert.ok(isAppBundle('/Applications/ZCode.app/'));
  assert.ok(!isAppBundle('/Applications/ZCode.app/Contents/MacOS/ZCode'));
  assert.ok(!isAppBundle('C:/Program Files/ZCode/ZCode.exe'));
  assert.ok(!isAppBundle(''));
});

test('resolveExecutablePath：.app → Contents/MacOS/<CFBundleExecutable>', () => {
  const deps = { readFileSync: () => PLIST };
  assert.strictEqual(
    resolveExecutablePath(APP, deps),
    path.join(APP, 'Contents', 'MacOS', 'ZCode')
  );
});

test('resolveExecutablePath：plist 读不到时回退约定名（不中断探测链）', () => {
  const deps = { readFileSync: () => { throw new Error('ENOENT'); } };
  assert.strictEqual(
    resolveExecutablePath(APP, deps),
    path.join(APP, 'Contents', 'MacOS', 'ZCode')
  );
});

test('resolveExecutablePath：非 .app 路径原样返回', () => {
  const exe = '/Applications/ZCode.app/Contents/MacOS/ZCode';
  assert.strictEqual(resolveExecutablePath(exe, {}), exe);
  assert.strictEqual(resolveExecutablePath('C:/z/ZCode.exe', {}), 'C:/z/ZCode.exe');
  assert.strictEqual(resolveExecutablePath('', {}), '');
});

test('resolveExecutablePath：结尾斜杠的 .app 不产生双斜杠', () => {
  const deps = { readFileSync: () => PLIST };
  assert.strictEqual(
    resolveExecutablePath(`${APP}/`, deps),
    path.join(APP, 'Contents', 'MacOS', 'ZCode')
  );
});

// ---------------- 候选链 ----------------

test('macCandidates：含 ~/Applications 与 /Applications', () => {
  const list = macCandidates({ homedir: () => '/Users/tester' });
  assert.deepStrictEqual(list, [
    path.join('/Users/tester', 'Applications', 'ZCode.app'),
    path.join('/Applications', 'ZCode.app')
  ]);
});

test('winCandidates：保留原有三个标准位置', () => {
  const list = winCandidates({
    env: {
      LOCALAPPDATA: 'C:\\Users\\t\\AppData\\Local',
      'ProgramFiles': 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)'
    }
  });
  assert.ok(list.some((p) => p.includes('Programs') && p.endsWith('ZCode.exe')));
  assert.ok(list.some((p) => p === path.join('C:\\Program Files', 'ZCode', 'ZCode.exe')));
  assert.ok(list.some((p) => p === path.join('C:\\Program Files (x86)', 'ZCode', 'ZCode.exe')));
});

// ---------------- 探测优先级 ----------------

test('detectZcodePath：环境变量优先于配置文件', () => {
  const deps = { existsSync: () => true, readFileSync: () => PLIST };
  const r = detectZcodePath({
    platform: 'darwin',
    env: { ZCODE_ADVISOR_ZCODE_PATH: '/custom/ZCode.app' },
    config: { zcodePath: '/config/ZCode.app' },
    deps
  });
  assert.strictEqual(r.source, 'env:ZCODE_ADVISOR_ZCODE_PATH');
  assert.strictEqual(r.path, path.join('/custom/ZCode.app', 'Contents', 'MacOS', 'ZCode'));
});

test('detectZcodePath：macOS 命中 /Applications/ZCode.app 并解析出内部二进制', () => {
  const deps = {
    homedir: () => '/Users/tester',
    existsSync: (p) => p === path.join(APP, 'Contents', 'MacOS', 'ZCode'),
    readFileSync: () => PLIST
  };
  const r = detectZcodePath({ platform: 'darwin', env: {}, config: {}, deps });
  assert.strictEqual(r.path, path.join(APP, 'Contents', 'MacOS', 'ZCode'));
  assert.match(r.source, /自动探测/);
});

test('detectZcodePath：macOS 优先 ~/Applications（存在时）', () => {
  const homeApp = path.join('/Users/tester', 'Applications', 'ZCode.app');
  const deps = {
    homedir: () => '/Users/tester',
    existsSync: (p) => p === path.join(homeApp, 'Contents', 'MacOS', 'ZCode'),
    readFileSync: () => PLIST
  };
  const r = detectZcodePath({ platform: 'darwin', env: {}, config: {}, deps });
  assert.strictEqual(r.path, path.join(homeApp, 'Contents', 'MacOS', 'ZCode'));
});

test('detectZcodePath：候选链全落空时走 Spotlight 兜底', () => {
  const deps = {
    homedir: () => '/Users/tester',
    existsSync: (p) => p === path.join('/opt/custom/ZCode.app', 'Contents', 'MacOS', 'ZCode'),
    readFileSync: () => PLIST,
    mdfind: () => '/opt/custom/ZCode.app'
  };
  const r = detectZcodePath({ platform: 'darwin', env: {}, config: {}, deps });
  assert.strictEqual(r.source, 'spotlight');
});

test('detectZcodePath：显式配置无效时继续尝试后续来源（不静默终止）', () => {
  // 回归：早期实现遇到无效 env 立即 return，一个过期环境变量会把可用的
  // 配置文件/标准安装路径全部顶掉（Windows 侧属行为回归）。
  const deps = {
    homedir: () => '/Users/tester',
    existsSync: (p) => p === path.join('/Applications', 'ZCode.app', 'Contents', 'MacOS', 'ZCode'),
    statSync: (p) => ({ isFile: () => p === path.join('/Applications', 'ZCode.app', 'Contents', 'MacOS', 'ZCode') }),
    readFileSync: () => PLIST
  };
  const r = detectZcodePath({
    platform: 'darwin',
    env: { ZCODE_ADVISOR_ZCODE_PATH: '/nope/old/ZCode.app' }, // 过期
    config: {},
    deps
  });
  assert.ok(r.path, '应回退到候选链而不是直接失败');
  assert.match(r.source, /自动探测/, '来源应是候选链');
});

test('detectZcodePath：env 无效但 config 有效时用 config', () => {
  // env 指向的路径不存在 → 应继续尝试 config，而不是带着 invalid 直接返回。
  const configTarget = path.join('/custom/ZCode.app', 'Contents', 'MacOS', 'ZCode');
  const deps = {
    homedir: () => '/Users/tester',
    existsSync: (p) => p === configTarget,
    statSync: (p) => ({ isFile: () => p === configTarget }),
    readFileSync: () => PLIST
  };
  const r = detectZcodePath({
    platform: 'darwin',
    env: { ZCODE_ADVISOR_ZCODE_PATH: '/nope/ZCode.app' },
    config: { zcodePath: '/custom/ZCode.app' },
    deps
  });
  assert.strictEqual(r.source, 'config:zcodePath');
  assert.strictEqual(r.path, configTarget);
});

test('detectZcodePath：全部来源无效时带 invalid 诊断信息', () => {
  const deps = { existsSync: () => false, statSync: () => ({ isFile: () => false }), readFileSync: () => '' };
  const r = detectZcodePath({
    platform: 'darwin',
    env: { ZCODE_ADVISOR_ZCODE_PATH: '/nope/ZCode.app' },
    config: {},
    deps
  });
  assert.strictEqual(r.path, '');
  assert.ok(r.invalid, '应带 invalid 信息');
  assert.strictEqual(r.invalid.value, '/nope/ZCode.app');
});

test('detectZcodePath：目录不算可执行文件（只 existsSync 会误判）', () => {
  // 回归：早期实现只做 existsSync，把目录当可执行文件返回，随后 spawn 一个目录必然失败。
  const deps = {
    existsSync: () => true,
    statSync: () => ({ isFile: () => false }), // 是目录
    readFileSync: () => ''
  };
  const r = detectZcodePath({
    platform: 'darwin',
    env: {},
    config: { zcodePath: '/Applications' },
    deps
  });
  assert.strictEqual(r.path, '', '目录不应被当作 ZCode');
});

test('detectZcodePath：Windows 平台走 Windows 候选链', () => {
  const target = path.join('C:\\Program Files', 'ZCode', 'ZCode.exe');
  const deps = {
    env: {},
    existsSync: (p) => p === target,
    statSync: (p) => ({ isFile: () => p === target }),
    readFileSync: () => ''
  };
  const r = detectZcodePath({
    platform: 'win32',
    env: {
      'ProgramFiles': 'C:\\Program Files',
      'LOCALAPPDATA': 'C:\\Users\\t\\AppData\\Local',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)'
    },
    config: {},
    deps
  });
  assert.strictEqual(r.path, target);
});

test('detectZcodePath：找不到时返回空路径（调用方负责提示）', () => {
  const deps = {
    homedir: () => '/Users/tester',
    existsSync: () => false,
    statSync: () => ({ isFile: () => false }),
    readFileSync: () => ''
  };
  const r = detectZcodePath({ platform: 'darwin', env: {}, config: {}, deps });
  assert.strictEqual(r.path, '');
  assert.strictEqual(r.source, '');
});

// ---------------- 提示文案 ----------------

test('missingHint：按平台给出对应示例', () => {
  const mac = missingHint('darwin', '/Users/t/.zcode/advisor-companion.json');
  assert.match(mac, /\.app/);
  assert.match(mac, /zcodePath/);

  const win = missingHint('win32', 'C:/Users/t/.zcode/advisor-companion.json');
  assert.match(win, /ZCode\.exe/);

  const other = missingHint('linux', '/tmp/cfg.json');
  assert.match(other, /zcodePath/);
});

// ---------------- 与真实系统的对照（可用时） ----------------

test('detectZcodePath：在本机 macOS 上能真实解析出 ZCode 可执行文件', {
  skip: process.platform !== 'darwin' || !fs.existsSync('/Applications/ZCode.app')
}, () => {
  const r = detectZcodePath({
    platform: 'darwin',
    env: {},
    config: {},
    deps: { existsSync: fs.existsSync, statSync: fs.statSync, readFileSync: fs.readFileSync, homedir: os.homedir }
  });
  assert.ok(r.path, '应解析出路径');
  assert.ok(fs.existsSync(r.path), `解析出的路径应存在：${r.path}`);
  assert.ok(/Contents\/MacOS\//.test(r.path), `应为 .app 内部可执行文件：${r.path}`);
});
