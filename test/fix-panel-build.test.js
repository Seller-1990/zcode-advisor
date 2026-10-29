'use strict';
// 回归测试：panel 历史按钮索引解析、ICO 目录字节、icon-alpha 先检后写、
// NSIS 卸载递归删除护栏、内嵌 Node 的 SHA256 校验 / 原子缓存 / DMG expectNode。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { buildZip } = require('../tools/companion/archive.cjs');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const tmpdir = (t, p) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

// ---------------- 1. panel 历史按钮 ----------------

const PANEL_HTML = require('../tools/companion/panel.cjs');
const PANEL_SCRIPT = PANEL_HTML.match(/<script>([\s\S]*)<\/script>/)[1];

// 取出**实际下发**脚本里的 bindAction，用桩 $/submitUserAction 执行点击处理器。
function servedBindAction() {
  const src = PANEL_SCRIPT.match(/function bindAction\(id, action\) \{[\s\S]*?\n  \}\n/);
  assert.ok(src, '下发脚本中应有 bindAction');
  const buttons = new Map();
  const calls = [];
  const $ = (id) => buttons.get(id) || null;
  const bindAction = new Function('$', 'submitUserAction', src[0] + '\nreturn bindAction;')(
    $, (idx, action) => calls.push([idx, action]));
  const makeBtn = (id) => {
    const attrs = {}; const listeners = [];
    const btn = {
      id,
      getAttribute: (k) => attrs[k] ?? null,
      setAttribute: (k, v) => { attrs[k] = String(v); },
      addEventListener: (ev, fn) => { if (ev === 'click') listeners.push(fn); },
      click: () => listeners.forEach((fn) => fn())
    };
    buttons.set(id, btn);
    return btn;
  };
  return { bindAction, makeBtn, calls };
}

test('panel：点击历史按钮传给 submitUserAction 的索引不是 -1', () => {
  const h = servedBindAction();
  const ids = [['hact-ack-3', 'ack', 3], ['hact-note-0', 'note', 0], ['hact-dismiss-11', 'dismiss', 11]];
  const btns = ids.map(([id, action]) => { const b = h.makeBtn(id); h.bindAction(id, action); return b; });
  btns.forEach((b) => b.click());
  assert.deepEqual(h.calls, ids.map(([, action, idx]) => [idx, action]));
  // 幂等：重复绑定不重复触发
  h.bindAction('hact-ack-3', 'ack'); btns[0].click();
  assert.deepEqual(h.calls.at(-1), [3, 'ack']);
  assert.equal(h.calls.length, 4);
});

test('panel：下发脚本不含被模板字面量吞掉反斜杠的正则', () => {
  assert.ok(!/\/\(d\+\)/.test(PANEL_SCRIPT), '出现 /(d+) —— 单反斜杠 \\d 在反引号模板内被吞');
  assert.ok(PANEL_SCRIPT.includes('/([0-9]+)$/'), '应使用不依赖反斜杠的 [0-9]+');
  // 泛化护栏：源码模板内凡 \d/\w/\s 之类的单反斜杠转义，在下发结果里都会退化成裸字母。
  const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'companion', 'panel.cjs'), 'utf8');
  const body = src.slice(src.indexOf('const PANEL_HTML = `'), src.lastIndexOf('`;'));
  const bad = body.match(/(?<!\\)\\[dwsDWSbB.()[\]+*?]/g) || [];
  assert.deepEqual(bad, [], `模板内单反斜杠正则转义会被吞：${bad.join(' ')}`);
});

// ---------------- 2. ICO 目录 ----------------

test('ICO：目录项 width/height/colorCount 字节正确', () => {
  const { makeIco } = require('../tools/companion/icon.cjs');
  const ico = makeIco();
  assert.equal(ico.readUInt16LE(2), 1, 'type=icon');
  const n = ico.readUInt16LE(4);
  const seen = [];
  for (let i = 0; i < n; i++) {
    const base = 6 + i * 16;
    const w = ico[base]; const h = ico[base + 1];
    assert.equal(w, h, `第 ${i} 项宽高字节应相等`);
    assert.equal(ico[base + 2], 0, `第 ${i} 项 colorCount 必须为 0（32bpp）`);
    assert.equal(ico[base + 3], 0, '保留字节');
    assert.equal(ico.readUInt16LE(base + 6), 32);
    seen.push(w);
  }
  assert.deepEqual(seen, [32, 0], '32 与 256（记为 0）');
});

// ---------------- 3. icon-alpha 先检后写 ----------------

test('icon-alpha：自检基于缓冲区，原子写不留临时文件', (t) => {
  const icon = require('../tools/companion/icon.cjs');
  const { selfCheck, writeAtomic } = require('../tools/icon-alpha.cjs');
  const size = 8;
  const px = Buffer.alloc(size * size * 4, 255); // 全不透明：四角不透明 → 失败
  const bad = icon.encodePng(size, px);
  assert.equal(selfCheck(bad).ok, false);
  const good = Buffer.from(px);
  for (const [x, y] of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]]) good[(y * size + x) * 4 + 3] = 0;
  assert.equal(selfCheck(icon.encodePng(size, good)).ok, true);

  const dir = tmpdir(t, 'zca-icon-alpha-');
  const file = path.join(dir, 'icon.png');
  fs.writeFileSync(file, 'original');
  writeAtomic(file, Buffer.from('new'));
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
  assert.deepEqual(fs.readdirSync(dir), ['icon.png']);
});

test('icon-alpha：main 中自检位于写盘之前', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'icon-alpha.cjs'), 'utf8');
  const main = src.slice(src.indexOf('function main()'), src.indexOf('function selfCheck'));
  assert.ok(main.indexOf('selfCheck(') > 0 && main.indexOf('selfCheck(') < main.indexOf('writeAtomic('));
  assert.ok(!/fs\.writeFileSync\(FILE/.test(main), '不得直接写目标文件');
});

// ---------------- 4. NSIS 卸载护栏 ----------------

test('NSIS：安装目录必须以 \\ZCodeAdvisor 结尾，卸载递归删除受同一条件保护', () => {
  const { nsisScript } = require('../tools/companion/packagers.cjs');
  const nsi = nsisScript({ outFile: 'out.exe', iconPath: 'a.ico', srcDirName: 'stage', version: '1.2.3' });
  // 先去掉末尾反斜杠（$1 为去尾后的副本），再比较后 13 位
  assert.match(nsi, /Function \.onVerifyInstDir\n\s+StrCpy \$1 "\$INSTDIR"\n\s+StrCpy \$0 "\$1" "" -1\n\s+StrCmp \$0 "\\" 0 \+2\n\s+StrCpy \$1 "\$1" -1\n\s+StrCpy \$0 "\$1" "" -13\n\s+StrCmp \$0 "\\ZCodeAdvisor" \+2 0\n\s+Abort\nFunctionEnd/);
  assert.equal('\\ZCodeAdvisor'.length, 13);
  const un = nsi.slice(nsi.indexOf('Section "Uninstall"'), nsi.indexOf('SectionEnd', nsi.indexOf('Section "Uninstall"')));
  // 只统计指令行（NSIS 注释以 ; 开头，注释里提及旧行为不算）
  const code = un.split('\n').filter((l) => !/^\s*;/.test(l)).join('\n');
  const rmr = code.match(/RMDir \/r[^\n]*/g) || [];
  assert.equal(rmr.length, 1, '只允许一处递归删除');
  assert.ok(code.indexOf('StrCmp $0 "\\ZCodeAdvisor" zca_rm_tree zca_rm_safe') < code.indexOf('RMDir /r'), '递归删除前必须校验目录名');
  assert.match(un, /zca_rm_safe:\n\s+Delete "\$INSTDIR\\uninstall\.exe"\n\s+RMDir "\$INSTDIR"\n/, '不匹配时只做非递归 RMDir');
  assert.match(nsi, /InstallDir "\$LOCALAPPDATA\\ZCodeAdvisor"/, '默认目录满足护栏');
});

// ---------------- 5. 内嵌 Node 校验 ----------------

const BI = require('../tools/companion/build-installer.cjs');

test('build：verifyAgainstShasums 接受匹配条目、拒绝不符/缺失', () => {
  const buf = Buffer.from('payload');
  const sums = `${'0'.repeat(64)}  other.zip\n${sha(buf)}  node-v22.1.0-win-x64.zip\n`;
  assert.equal(BI.verifyAgainstShasums(buf, 'node-v22.1.0-win-x64.zip', sums), sha(buf));
  assert.throws(() => BI.verifyAgainstShasums(Buffer.from('tampered'), 'node-v22.1.0-win-x64.zip', sums), /SHA256 不匹配/);
  assert.throws(() => BI.verifyAgainstShasums(buf, 'node-v22.1.0-darwin-arm64.tar.gz', sums), /没有/);
});

test('build：缓存原子写 + .sha256 旁注；内容被改即不命中', (t) => {
  const dir = tmpdir(t, 'zca-cache-');
  const p = path.join(dir, 'node-v22.1.0-win-x64');
  BI.writeCacheAtomic(p, Buffer.from('bin'));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['node-v22.1.0-win-x64', 'node-v22.1.0-win-x64.sha256']);
  assert.equal(BI.readVerifiedCache(p).toString(), 'bin');
  fs.writeFileSync(p, 'bi');               // 截断
  assert.equal(BI.readVerifiedCache(p), null);
  fs.rmSync(`${p}.sha256`); fs.writeFileSync(p, 'bin');
  assert.equal(BI.readVerifiedCache(p), null, '无旁注的旧缓存不复用');
});

test('build：DMG expectNode 跟随 embedNode 请求而非是否取到', () => {
  assert.equal(BI.dmgExpectNode({ embedNode: true }), true);
  assert.equal(BI.dmgExpectNode({ embedNode: false }), false);
  const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'companion', 'build-installer.cjs'), 'utf8');
  assert.ok(src.includes("kind: 'dmg', expectNode: dmgExpectNode(opts)"));
  assert.ok(!src.includes('expectNode: !!nodeEntry'));
});

// 端到端（无网络）：内存发行包 + SHASUMS，验证正确哈希入缓存、错误哈希拒绝且不落缓存。
function fixture(t, sumsFor) {
  const root = tmpdir(t, 'zca-build-sha-');
  const cache = path.join(root, 'dist', '.cache');
  fs.mkdirSync(cache, { recursive: true });
  const requests = [];
  const file = path.resolve(__dirname, '../tools/companion/build-installer.cjs');
  const realRequire = createRequire(file);
  const mod = { exports: {} };
  const zip = buildZip([{ path: 'node-v22.1.0-win-x64/node.exe', data: Buffer.from('node-bin') }]);
  const sandbox = {
    module: mod, exports: mod.exports, Buffer, AbortSignal, setTimeout,
    console: { log() {}, warn() {} },
    process: { env: { NODE_EMBED_VERSION: 'v22.1.0' }, arch: process.arch, pid: process.pid },
    require: (spec) => spec === './build-meta.cjs' ? { ...realRequire(spec), ROOT: root } : realRequire(spec),
    async fetch(url) {
      requests.push(url);
      const bytes = url.endsWith('SHASUMS256.txt') ? Buffer.from(sumsFor(zip)) : zip;
      return { ok: true, async arrayBuffer() { return bytes; } };
    }
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  return { cache, requests, fetchNode: mod.exports.fetchEmbeddedNodeBinary };
}

test('build：下载的发行包按 SHASUMS256.txt 校验，通过后缓存复用', async (t) => {
  const f = fixture(t, (zip) => `${sha(zip)}  node-v22.1.0-win-x64.zip\n`);
  assert.equal((await f.fetchNode('win', 'x64')).toString(), 'node-bin');
  assert.ok(f.requests.some((u) => u.endsWith('/v22.1.0/SHASUMS256.txt')));
  const n = f.requests.length;
  assert.equal((await f.fetchNode('win', 'x64')).toString(), 'node-bin');
  assert.equal(f.requests.length, n, '已校验缓存应复用');
  assert.ok(fs.existsSync(path.join(f.cache, 'node-v22.1.0-win-x64.sha256')));
});

test('build：哈希不符时失败且不写缓存', async (t) => {
  const f = fixture(t, () => `${'a'.repeat(64)}  node-v22.1.0-win-x64.zip\n`);
  await assert.rejects(f.fetchNode('win', 'x64'), /SHA256 不匹配/);
  assert.deepEqual(fs.readdirSync(f.cache), []);
});
