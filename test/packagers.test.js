'use strict';

// 安装器打包测试（NSIS 脚本生成 + macOS .app 组装 + DMG 结构）。
// 说明：makensis 在本机（Homebrew 3.12 / Hackintosh x86_64）连最简脚本都 std::bad_alloc 崩溃，
// 因此 NSIS 的"真实编译"无法在本机验证——这里只锁住脚本生成与占位符，真实编译交给 CI
// （windows-2022 预装 NSIS 3.10）。DMG 与 .app 组装在本机可完整验证。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const P = require('../tools/companion/packagers.cjs');

const hasTool = (name) => {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
};
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zca-pkg-'));

// ---------------- NSIS 脚本生成 ----------------

test('version4：补成 4 段数字（满足 VIProductVersion 要求）', () => {
  assert.strictEqual(P.version4('0.2.0'), '0.2.0.0');
  assert.strictEqual(P.version4('1.2.3.4'), '1.2.3.4');
  assert.strictEqual(P.version4('2.5'), '2.5.0.0');
  assert.strictEqual(P.version4('bad'), '0.0.0.0');
});

test('nsisScript：构建期路径用正斜杠、含关键段落与卸载项', () => {
  const script = P.nsisScript({
    outFile: 'C:/out/setup.exe',
    iconPath: 'stage/advisor.ico',
    srcDirName: 'stage',
    version: '0.2.0'
  });
  // 说明：脚本中会有 `$LOCALAPPDATA\ZCodeAdvisor` 这类 **Windows 目标路径**（反斜杠是语义要求）。
  // File 指令改用相对路径（stage\*.*）——绝对路径+通配符在 Windows 的 makensis 上解析不可靠
  // （CI 实测 "no files found"，导致 setup.exe 静默缺失）。
  assert.match(script, /OutFile "C:\/out\/setup\.exe"/);
  assert.match(script, /!define MUI_ICON "stage\/advisor\.ico"/);
  // srcDirName 由调用方传入（必须等于实际目录的 basename）
  assert.match(script, /!define SRCFILES "stage"/);
  assert.match(script, /File \/r "\$\{SRCFILES\}\\\*\.\*"/);
  assert.match(script, /Unicode true/);
  assert.match(script, /InstallDir "\$LOCALAPPDATA\\ZCodeAdvisor"/);
  assert.match(script, /VIProductVersion "0\.2\.0\.0"/);
  assert.match(script, /WriteUninstaller/);
  assert.match(script, /RequestExecutionLevel user/, '应请求 user 级权限，不要求管理员');
});

test('nsisScript：快捷方式指向原始 node.exe 且最小化显示（非隐藏）', () => {
  const script = P.nsisScript({ outFile: 'o.exe', iconPath: 'i.ico', srcDirName: 'stage', version: '1.0.0' });
  // 不改名：直接指向 bin\node.exe
  assert.match(script, /CreateShortCut "\$DESKTOP\\ZCode Advisor\.lnk" "\$INSTDIR\\bin\\node\.exe"/);
  // SW_SHOWMINIMIZED (=7)，不隐藏控制台
  assert.match(script, /SW_SHOWMINIMIZED/);
  assert.ok(!/SW_HIDE/.test(script), '不应隐藏窗口');
});

test('nsisScript：卸载保留用户级配置（含 API key，不静默删除）', () => {
  const script = P.nsisScript({ outFile: 'o.exe', iconPath: 'i.ico', srcDirName: 'stage', version: '1.0.0' });
  assert.match(script, /Section "Uninstall"/);
  assert.match(script, /卸载保留用户级配置/);
  // 只看实际删除指令（注释里提到 .zcode 是说明，不是行为）：
  // 卸载段不得出现针对用户级配置的 Delete / RMDir / 注册表清理。
  const uninstallSection = script.slice(script.indexOf('Section "Uninstall"'));
  const destructive = uninstallSection
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^(Delete|RMDir|DeleteRegKey|DeleteRegValue)\b/.test(l))
    .filter((l) => /\.zcode|USERPROFILE|advisor\.config/i.test(l));
  assert.deepStrictEqual(destructive, [], `卸载不应删除用户级配置，实际：${destructive.join(' | ')}`);
});

test('buildNsisInstaller：makensis 不可用/崩溃时返回可读原因（不抛裸异常、不假装成功）', () => {
  const workDir = tmpDir();
  const r = P.buildNsisInstaller({
    workDir,
    srcDir: tmpDir(),          // .nsi 会写到它的父目录
    iconPath: '/nonexistent.ico',
    version: '0.0.1',
    outFile: path.join(tmpDir(), 'never.exe')
  });

  // 不论 makensis 是否存在，调用都必须返回 {ok} 对象（而非抛异常），
  // 且失败时必须给出非空 reason，便于上层打印可读提示。
  assert.strictEqual(typeof r.ok, 'boolean', '应返回 {ok:boolean}');
  if (!hasTool('makensis')) {
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /makensis/);
  } else if (r.ok === false) {
    // 本机 makensis 崩溃（Homebrew 3.12 的 bad_alloc）→ 原因必须可读
    assert.ok(r.reason && r.reason.length > 0, '失败必须带非空 reason');
  } else {
    // 若真的编译成功，产物必须存在且非空
    assert.ok(fs.existsSync(r.path), 'ok:true 时产物必须存在');
    assert.ok(r.bytes > 0, 'ok:true 时产物必须非空');
  }
});

test('buildNsisInstaller：写出的 .nsi 带 UTF-8 BOM（含中文时的编码必需）', () => {
  // 回归：makensis 在 Windows 上按 ACP 解析非 BOM 输入（NSIS 源码 DetectUTFBOM 只认 BOM），
  // 无 BOM 的 UTF-8 + 中文会 "Bad text encoding" 编译失败，而失败被上层当成"跳过安装器"，
  // 造成 CI 绿灯却无 setup.exe。这里直接检查生成物首字节。
  const srcDir = tmpDir();          // .nsi 写到它的父目录
  const outFile = path.join(tmpDir(), 'x.exe');
  P.buildNsisInstaller({
    workDir: tmpDir(),
    srcDir,
    iconPath: '/nonexistent.ico',
    version: '1.2.3',
    outFile
  });

  const nsiPath = path.join(path.dirname(srcDir), 'zcode-advisor-1.2.3.nsi');
  assert.ok(fs.existsSync(nsiPath), '应生成 .nsi 脚本（无论 makensis 是否可用）');
  const head = fs.readFileSync(nsiPath).subarray(0, 3);
  assert.deepStrictEqual([...head], [0xEF, 0xBB, 0xBF], '.nsi 必须以 UTF-8 BOM 开头');

  // BOM 之后的正文应能按 UTF-8 解出中文（证明 BOM 与正文编码一致）
  const body = fs.readFileSync(nsiPath).subarray(3).toString('utf8');
  assert.match(body, /卸载 ZCode Advisor|顾问|安装/, '正文应含中文且可按 UTF-8 解码');
});

test('nsisScript：脚本含中文（这正是必须带 BOM 的原因）', () => {
  const s = P.nsisScript({ outFile: 'o.exe', iconPath: 'i.ico', srcDirName: 'stage', version: '1.0.0' });
  assert.ok(/[\u4e00-\u9fff]/.test(s), '脚本应含中文（否则 BOM 就不必要了）');
});

// ---------------- macOS .app 组装 ----------------

test('stageMacApp：生成完整 .app（Info.plist / 启动器 / Resources/app / node / icns）', () => {
  const dest = tmpDir();
  const companion = path.join(__dirname, '..', 'tools', 'companion');
  const nodeSrc = path.join(dest, 'fake-node');
  fs.writeFileSync(nodeSrc, '#!/bin/sh\necho node\n');
  fs.chmodSync(nodeSrc, 0o755);

  const icns = Buffer.from('icns-test');
  const appDir = P.stageMacApp({
    destDir: dest,
    version: '9.9.9',
    runtimeFiles: ['controller.cjs', 'inject.js', 'lib.cjs', 'zcode-path.cjs'],
    companionDir: companion,
    nodeBinPath: nodeSrc,
    icnsBuf: icns
  });

  assert.ok(fs.existsSync(path.join(appDir, 'Contents', 'Info.plist')));
  const launcher = path.join(appDir, 'Contents', 'MacOS', 'ZCodeAdvisor');
  assert.ok(fs.existsSync(launcher));
  assert.ok((fs.statSync(launcher).mode & 0o111) !== 0, '启动器应有执行位');

  for (const f of ['controller.cjs', 'inject.js', 'lib.cjs', 'zcode-path.cjs']) {
    assert.ok(fs.existsSync(path.join(appDir, 'Contents', 'Resources', 'app', f)), `应有 app/${f}`);
  }
  assert.ok(fs.existsSync(path.join(appDir, 'Contents', 'Resources', 'node')));
  assert.deepStrictEqual(fs.readFileSync(path.join(appDir, 'Contents', 'Resources', 'advisor.icns')), icns);

  const plist = fs.readFileSync(path.join(appDir, 'Contents', 'Info.plist'), 'utf8');
  assert.match(plist, /<string>9\.9\.9<\/string>/, '版本号应写入 plist');
  assert.match(plist, /<key>LSUIElement<\/key><true\/>/);
});

test('macAppPlist：合法 XML 且关键键齐全', () => {
  const plist = P.macAppPlist('1.2.3');
  assert.match(plist, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(plist, /<key>CFBundleExecutable<\/key><string>ZCodeAdvisor<\/string>/);
  assert.match(plist, /<key>CFBundleIdentifier<\/key><string>local\.zcode\.advisor<\/string>/);
  assert.match(plist, /<string>1\.2\.3<\/string>/);
});

test('MAC_APP_LAUNCHER：自包含运行时，缺 node 时弹窗而非静默失败', () => {
  const sh = P.MAC_APP_LAUNCHER;
  assert.match(sh, /^#!\/bin\/bash/);
  assert.match(sh, /Resources/);
  assert.match(sh, /command -v node/, '应回退系统 node');
  assert.match(sh, /osascript -e 'display dialog/);
  assert.match(sh, /nohup "\$NODE" "\$DIR\/app\/controller\.cjs"/);
});

// ---------------- DMG（macOS 专属） ----------------

test('buildDmg：非 macOS 时明确返回不可用原因', {
  skip: process.platform === 'darwin'
}, () => {
  const r = P.buildDmg({ stageDir: tmpDir(), outFile: '/tmp/x.dmg', volumeName: 'x' });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /macOS/);
});

test('buildDmg：产出可被 hdiutil verify 的 DMG，并含 Applications 符号链接', {
  skip: process.platform !== 'darwin' || !hasTool('hdiutil')
}, () => {
  const stage = tmpDir();
  fs.writeFileSync(path.join(stage, 'README.txt'), 'hello\n');
  fs.mkdirSync(path.join(stage, 'ZCode Advisor.app', 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'ZCode Advisor.app', 'Contents', 'MacOS', 'ZCodeAdvisor'), '#!/bin/bash\n');
  fs.chmodSync(path.join(stage, 'ZCode Advisor.app', 'Contents', 'MacOS', 'ZCodeAdvisor'), 0o755);

  const out = path.join(tmpDir(), 'test.dmg');
  const r = P.buildDmg({ stageDir: stage, outFile: out, volumeName: 'ZCA Test' });
  assert.strictEqual(r.ok, true, r.reason);
  assert.ok(fs.statSync(out).size > 0);

  // 系统工具交叉校验
  execFileSync('hdiutil', ['verify', out], { stdio: 'pipe' });

  // 挂载确认内容与符号链接
  const mp = tmpDir();
  execFileSync('hdiutil', ['attach', out, '-nobrowse', '-readonly', '-mountpoint', mp], { stdio: 'pipe' });
  try {
    assert.ok(fs.existsSync(path.join(mp, 'README.txt')));
    assert.ok(fs.existsSync(path.join(mp, 'ZCode Advisor.app')));
    const link = fs.readlinkSync(path.join(mp, 'Applications'));
    assert.strictEqual(link, '/Applications');
  } finally {
    execFileSync('hdiutil', ['detach', mp, '-quiet'], { stdio: 'pipe' });
  }
});
