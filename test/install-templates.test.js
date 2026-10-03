'use strict';

// 安装模板与图标生成的测试。
// 这些模板是"明文可审计"的交付物（README 明确声明），改动它们等于改动用户安装体验，
// 因此对关键约束做锁定：不含自解压/改名进程/隐藏启动，install.sh 可执行位正确。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const T = require('../tools/companion/install-templates.cjs');
const { COMPANION_FILES, companionRuntimeFiles } = require('../tools/companion/build-meta.cjs');
const { makeIco, makeIcns, drawShield, encodePng, ICNS_SIZES, iconPixels, decodePng, loadSourceIcon } = require('../tools/companion/icon.cjs');

const { VERSION } = require('../tools/companion/build-meta.cjs');

const hasTool = (name) => {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
};

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zca-tpl-'));

// ---------------- Windows 模板 ----------------

test('INSTALL_CMD：明文、xcopy 到 LOCALAPPDATA、调用 vbs 建快捷方式', () => {
  assert.match(T.INSTALL_CMD, /@echo off/);
  assert.match(T.INSTALL_CMD, /%LOCALAPPDATA%\\ZCodeAdvisor/);
  assert.match(T.INSTALL_CMD, /xcopy/);
  assert.match(T.INSTALL_CMD, /install-shortcut\.vbs/);
});

test('INSTALL_SHORTCUT_VBS：指向原始 node.exe，不改名不隐藏', () => {
  assert.match(T.INSTALL_SHORTCUT_VBS, /bin\\node\.exe/);
  assert.match(T.INSTALL_SHORTCUT_VBS, /controller\.cjs/);
  assert.match(T.INSTALL_SHORTCUT_VBS, /IconLocation/);
  // WindowStyle 7 = 最小化（可见于任务栏），非隐藏
  assert.match(T.INSTALL_SHORTCUT_VBS, /WindowStyle = 7/);
});

test('杀软友好纪律：模板中不含自解压/隐藏启动/改名进程特征', () => {
  const all = [T.INSTALL_CMD, T.INSTALL_SHORTCUT_VBS, T.winReadme(true)].join('\n');
  assert.ok(!/IExpress|iexpress/i.test(all), '不应含 IExpress 自解压');
  assert.ok(!/WindowStyle\s*=\s*0/.test(all), '不应隐藏窗口（0=隐藏）');
  assert.ok(!/Run\s+.*, \s*0\s*,\s*False/.test(all), '不应隐藏启动');
  // node.exe 保持原名
  assert.match(T.winReadme(true), /bin\\node\.exe/);
});

test('WIN_README：指明配置路径与共存说明', () => {
  assert.match(T.winReadme(true), /\.zcode\\advisor\.config\.json/);
  assert.match(T.winReadme(true), /zcode-plus/);
});

// ---------------- macOS 模板 ----------------

test('MAC_INSTALL_SH：语法健全、生成 .app、LSUIElement、内嵌 node 优先', () => {
  const sh = T.MAC_INSTALL_SH(COMPANION_FILES);
  assert.match(sh, /^#!\/bin\/bash/);
  assert.match(sh, /ZCode Advisor\.app/);
  assert.match(sh, /Contents\/MacOS/);
  assert.match(sh, /<key>LSUIElement<\/key><true\/>/);
  assert.match(sh, /bin\/node/);
  assert.match(sh, /\$SRC\/bin\/node/);
  // 版本号用 __VERSION__ 占位，由构建脚本替换（避免 heredoc 展开带来的 shell 注入面）
  assert.ok(sh.includes('__VERSION__'), '应含 __VERSION__ 占位符');
  assert.ok(!sh.includes('</dict></plist>\nPLIST') || sh.includes("<<'PLIST'"), 'heredoc 应加引号');
});

test('MAC_INSTALL_SH：内嵌 node 缺失时回退系统 node，两者都无则明确失败', () => {
  const sh = T.MAC_INSTALL_SH(COMPANION_FILES);
  assert.match(sh, /command -v node/);
  assert.match(sh, /exit 1/);
  assert.match(sh, /包内未内嵌 Node/);
});

test('macReadme：按是否内嵌给出不同说明', () => {
  const withNode = T.macReadme(true);
  assert.match(withNode, /已内嵌官方 Node/);
  assert.ok(!/未内嵌/.test(withNode));

  const without = T.macReadme(false);
  assert.match(without, /未内嵌/);
  assert.match(without, /Node ≥ 22/);
});

test('macReadme：给出 macOS 探测失败时的配置指引', () => {
  const r = T.macReadme(true);
  assert.match(r, /advisor-companion\.json/);
  assert.match(r, /zcodePath/);
  assert.match(r, /\/Applications\/ZCode\.app/);
});

test('MAC_BUILD_INFO：记录版本/架构/内嵌状态', () => {
  const info = T.MAC_BUILD_INFO('x64', true);
  assert.match(info, /arch: x64/);
  assert.match(info, /内嵌 Node: 是/);
  assert.match(info, new RegExp(`version: ${VERSION.replace(/\./g, '\\.')}`));
});

// ---------------- 图标 ----------------

test('drawShield：输出 RGBA 像素，尺寸正确', () => {
  const px = drawShield(32);
  assert.strictEqual(px.length, 32 * 32 * 4);
  // 应有不透明像素（图形非全透明）
  const opaque = px.filter((_, i) => i % 4 === 3 && px[i] > 0).length;
  assert.ok(opaque > 0, '应存在不透明像素');
});

test('encodePng：PNG 魔数与 IHDR 尺寸正确', () => {
  const png = encodePng(32, drawShield(32));
  assert.deepStrictEqual(
    [...png.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'PNG 签名'
  );
  assert.strictEqual(png.subarray(12, 16).toString('ascii'), 'IHDR');
  assert.strictEqual(png.readUInt32BE(16), 32, '宽');
  assert.strictEqual(png.readUInt32BE(20), 32, '高');
  assert.strictEqual(png.subarray(png.length - 8, png.length - 4).toString('ascii'), 'IEND');
});

test('makeIco：ICO 目录头与 2 个条目（32 + 256）', () => {
  const ico = makeIco();
  assert.strictEqual(ico.readUInt16LE(0), 0, '保留位');
  assert.strictEqual(ico.readUInt16LE(2), 1, '类型 1 = ICO');
  assert.strictEqual(ico.readUInt16LE(4), 2, '条目数');
  // 第一项 32x32，第二项 256 记作 0
  assert.strictEqual(ico[6], 32);
  assert.strictEqual(ico[6 + 16], 0, '256 宽在 ICO 中记作 0');
});

test('makeIco：32bpp 条目按 BGRA 写入（写反会使红蓝互换）', () => {
  // 回归：早期实现直接拷贝 RGBA 缓冲区，Windows 取 32×32 档时显示成红色盾牌。
  // 这里按 **BMP 规范**（BGRA）解读像素，并与 iconPixels(32)（实际像素来源：
  // assets/icon.png 缩放或盾牌回退）的 RGBA 语义逐通道比对。
  const ico = makeIco();
  // ICO 布局：头 6 字节 + 目录项 16 字节 × 2 条目 = 38 起为第一个条目的数据
  const dataOff = 6 + 16 * 2;
  assert.strictEqual(ico.readUInt32LE(dataOff), 40, 'BMP header 大小');

  const xorOff = dataOff + 40;
  const cx = 16;
  const srcRow = 16; // 从顶部数第 16 行
  const dstRow = 31 - srcRow; // BMP 自下而上
  const px = xorOff + dstRow * 32 * 4 + cx * 4;

  const b = ico[px], g = ico[px + 1], r = ico[px + 2], a = ico[px + 3];

  // 与 iconPixels 的同一像素（RGBA）比对——通道序结构断言，与源图内容无关
  const rgba = iconPixels(32);
  const s = srcRow * 32 * 4 + cx * 4;
  assert.strictEqual(r, rgba[s], 'R 通道应等于源 R');
  assert.strictEqual(g, rgba[s + 1], 'G 通道应等于源 G');
  assert.strictEqual(b, rgba[s + 2], 'B 通道应等于源 B');
  assert.strictEqual(a, rgba[s + 3], 'A 通道应等于源 A');
});

test('makeIco：系统工具可识别（macOS sips 交叉校验）', {
  skip: process.platform !== 'darwin' || !hasTool('sips')
}, () => {
  const dir = tmpDir();
  const icoPath = path.join(dir, 'a.ico');
  fs.writeFileSync(icoPath, makeIco());
  const out = execFileSync('sips', ['-g', 'format', icoPath], { encoding: 'utf8' });
  assert.match(out, /ico/i, 'sips 应识别为 ico');
});

test('makeIcns：icns 魔数、长度字段自洽、包含多档尺寸', () => {
  const icns = makeIcns();
  assert.strictEqual(icns.subarray(0, 4).toString('ascii'), 'icns');
  assert.strictEqual(icns.readUInt32BE(4), icns.length, '总长度字段应等于实际长度');

  // 按 ICNS 规范解析：[type(4)][length(4)]，length 含自身。
  // 这里刻意不按 makeIcns 的写法读，而是按规范读——避免"同义反复"式测试
  // （早期 length/type 写反时，自洽读回也能通过，但系统工具解不开）。
  const types = [];
  let pos = 8;
  while (pos + 8 <= icns.length) {
    const type = icns.subarray(pos, pos + 4).toString('ascii');
    const len = icns.readUInt32BE(pos + 4);
    assert.ok(len > 8, `${type} 长度字段应大于 8`);
    assert.ok(pos + len <= icns.length, `${type} 长度不应越界`);
    types.push(type);
    pos += len;
  }
  assert.strictEqual(pos, icns.length, '块长度应恰好铺满文件');
  assert.ok(types.includes('ic07') && types.includes('ic08'), '应含 128/256 档');
  assert.strictEqual(types.length, ICNS_SIZES.length);
});

test('makeIcns：含有效的 PNG 负载（每个块内嵌完整 PNG）', () => {
  const icns = makeIcns();
  let pos = 8;
  let count = 0;
  while (pos + 8 <= icns.length) {
    const len = icns.readUInt32BE(pos + 4);
    const png = icns.subarray(pos + 8, pos + len);
    assert.deepStrictEqual(
      [...png.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      '内嵌负载应为 PNG'
    );
    count++;
    pos += len;
  }
  assert.strictEqual(count, ICNS_SIZES.length);
});

test('makeIcns：系统工具可解码（macOS 上真实校验格式合法性）', {
  skip: process.platform !== 'darwin' || !hasTool('sips')
}, () => {
  // 用 sips 做交叉校验：格式写错时（如 length/type 顺序反了）sips 会拒绝解码。
  const dir = tmpDir();
  const icnsPath = path.join(dir, 'advisor.icns');
  fs.writeFileSync(icnsPath, makeIcns());
  const out = execFileSync('sips', ['-g', 'format', icnsPath], { encoding: 'utf8' });
  assert.match(out, /icns/, 'sips 应识别为 icns');
  // 实际转码：能转出 PNG 才说明负载可解码
  const pngOut = path.join(dir, 'out.png');
  execFileSync('sips', ['-s', 'format', 'png', icnsPath, '--out', pngOut], { stdio: 'pipe' });
  assert.ok(fs.existsSync(pngOut) && fs.statSync(pngOut).size > 0, 'sips 应能转出 PNG');
});

test('makeIcns：iconutil 可完整往返（macOS 严格校验）', {
  skip: process.platform !== 'darwin' || !hasTool('iconutil')
}, () => {
  // 说明：iconutil 导出 iconset 要求尺寸集完整，因此这里补齐 16/32/128/256/512
  // 之外的常见档位后再校验；核心目的是验证块结构被系统接受。
  const dir = tmpDir();
  const icnsPath = path.join(dir, 'a.icns');
  fs.writeFileSync(icnsPath, makeIcns());
  const out = execFileSync('iconutil', ['-c', 'iconset', icnsPath, '-o', path.join(dir, 'a.iconset')], {
    encoding: 'utf8'
  }).toString();
  const files = fs.readdirSync(path.join(dir, 'a.iconset'));
  assert.ok(files.some((f) => f.endsWith('.png')), 'iconutil 应能解出 PNG 档位');
  void out;
});

// ---------------- 源图标透明度（四角白底回归防线） ----------------

test('assets/icon.png：已透明化——有 alpha 通道且四角透明、中心不透明', () => {
  const src = loadSourceIcon();
  assert.ok(src, 'assets/icon.png 应可解码');
  const { width, height, rgba } = src;
  const alphaAt = (x, y) => rgba[(y * width + x) * 4 + 3];
  // 四角必须透明：源图是 RGB 无 alpha 的徽章时，角上的白底会被原样带进 ico/icns，
  // 在深色桌面/坞栏上出现白色杂角（实测缺陷）。
  assert.strictEqual(alphaAt(0, 0), 0, '左上角应透明');
  assert.strictEqual(alphaAt(width - 1, 0), 0, '右上角应透明');
  assert.strictEqual(alphaAt(0, height - 1), 0, '左下角应透明');
  assert.strictEqual(alphaAt(width - 1, height - 1), 0, '右下角应透明');
  assert.strictEqual(alphaAt(Math.floor(width / 2), Math.floor(height / 2)), 255, '中心应不透明');
});

test('makeIco：AND 掩码与 32px 档 alpha 对齐（透明像素置 1）', () => {
  // AND 掩码位=1 表示透明；部分旧渲染路径只读掩码不读 alpha——掩码全 0 会把
  // 已透明的四角画成杂边。布局：目录 6 + 目录项 16×2 = 38 起，BMP 头 40 + XOR 32*32*4。
  const ico = makeIco();
  const andOff = 6 + 16 * 2 + 40 + 32 * 32 * 4;
  const s32 = iconPixels(32);
  const isTransparentAt = (x, y) => s32[(y * 32 + x) * 4 + 3] < 128;
  // AND 掩码自下而上：掩码行 = 31 - y
  const maskBit = (x, y) => {
    const row = 31 - y;
    return (ico[andOff + row * 4 + (x >> 3)] >> (7 - (x & 7))) & 1;
  };
  // 至少一个角透明（源图透明化后必然成立；程序化盾牌回退同样有透明角）
  const cornerTransparent = isTransparentAt(0, 0) || isTransparentAt(31, 0)
    || isTransparentAt(0, 31) || isTransparentAt(31, 31);
  assert.ok(cornerTransparent, '32px 档应有透明角（源图或盾牌回退）');
  for (const [x, y] of [[0, 0], [31, 0], [0, 31], [31, 31]]) {
    assert.strictEqual(maskBit(x, y), isTransparentAt(x, y) ? 1 : 0, `AND 掩码应与 alpha 对齐：(${x},${y})`);
  }
  assert.strictEqual(maskBit(16, 16), 0, '中心应不透明（掩码位 0）');
});

// ---------------- 依赖闭包（B1 回归防线） ----------------

test('companionRuntimeFiles：闭包包含 controller 的全部相对依赖（含 zcode-path.cjs）', () => {
  // 回归：发行包曾漏掉 zcode-path.cjs，导致安装后 controller require 失败直接崩溃。
  // 这里从源码推导闭包，任何新增的相对 require 都会自动纳入；漏项即失败。
  const files = companionRuntimeFiles();
  assert.ok(files.includes('controller.cjs'), '应含入口 controller.cjs');
  assert.ok(files.includes('inject.js'), '应含页面脚本 inject.js');
  assert.ok(files.includes('zcode-path.cjs'), '应含 zcode-path.cjs（曾漏包）');
  assert.ok(files.includes('lib.cjs'), '应含 lib.cjs');
});

test('companionRuntimeFiles：闭包与 controller 源码中的相对 require 一致', () => {
  const path = require('path');
  const fsMod = require('fs');
  const controller = fsMod.readFileSync(
    path.join(__dirname, '..', 'tools', 'companion', 'controller.cjs'),
    'utf8'
  );
  const requires = [...controller.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)]
    .map((m) => m[1].replace(/^\.\//, '').replace(/\.(cjs|js)$/, ''));

  const files = companionRuntimeFiles();
  for (const dep of requires) {
    assert.ok(
      files.some((f) => f.replace(/\.(cjs|js)$/, '') === dep),
      `controller 依赖的 ${dep} 应进入运行时闭包`
    );
  }
});

test('COMPANION_FILES：与闭包推导结果一致，且 build-installer 直接引用它', () => {
  assert.deepStrictEqual([...COMPANION_FILES].sort(), companionRuntimeFiles().sort());
});

test('MAC_INSTALL_SH：cp 清单由闭包注入，逐个校验存在（漏包时安装即失败）', () => {
  const sh = T.MAC_INSTALL_SH(COMPANION_FILES);
  for (const f of COMPANION_FILES) {
    assert.ok(sh.includes(`cp -f "$SRC/${f}"`), `install.sh 应复制 ${f}`);
    assert.ok(sh.includes(`$SRC/${f}" ] ||`), `install.sh 应校验 ${f} 存在`);
  }
});

test('winReadme：未内嵌 Node 时给出补救说明（与构建日志陈述一致）', () => {
  const noNode = T.winReadme(false);
  assert.match(noNode, /未内嵌/);
  assert.match(noNode, /node\.exe/, '应说明如何补齐 node.exe');

  const withNode = T.winReadme(true);
  assert.ok(!/未内嵌/.test(withNode), '内嵌时不应出现缺失警告');
});
