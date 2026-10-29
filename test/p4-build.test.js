'use strict';

// P4：NSIS 安装目录校验 / 卸载护栏、ocr-review 时间预算校验、tar 长名扩展。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const P = require('../tools/companion/packagers.cjs');
const archive = require('../tools/companion/archive.cjs');

// ---------------- NSIS ----------------

const script = P.nsisScript({ outFile: 'o.exe', iconPath: 'i.ico', srcDirName: 'stage', version: '1.0.0' });

function fnBody(name) {
  const m = new RegExp(`Function ${name.replace('.', '\\.')}\\n([\\s\\S]*?)FunctionEnd`).exec(script);
  assert.ok(m, `应有 Function ${name}`);
  return m[1];
}

test('nsis .onInit：注册表旧目录不以 \\ZCodeAdvisor 结尾时去尾斜杠并补子目录', () => {
  const body = fnBody('.onInit');
  assert.match(body, /StrCmp \$0 "\\" 0 \+2\n\s+StrCpy \$INSTDIR "\$INSTDIR" -1/);
  assert.match(body, /StrCpy \$INSTDIR "\$INSTDIR\\ZCodeAdvisor"/);
});

test('nsis .onVerifyInstDir：比较前去掉末尾反斜杠', () => {
  const body = fnBody('.onVerifyInstDir');
  assert.match(body, /StrCpy \$0 "\$1" "" -1\n\s+StrCmp \$0 "\\" 0 \+2\n\s+StrCpy \$1 "\$1" -1/);
  assert.match(body, /StrCpy \$0 "\$1" "" -13\n\s+StrCmp \$0 "\\ZCodeAdvisor" \+2 0\n\s+Abort/);
});

test('nsis 卸载：去尾斜杠后判断；跳过递归删除时提示用户残留文件', () => {
  const m = /Section "Uninstall"\n([\s\S]*?)SectionEnd/.exec(script);
  assert.ok(m);
  const body = m[1];
  assert.match(body, /StrCmp \$0 "\\" 0 \+2\n\s+StrCpy \$1 "\$1" -1/);
  assert.match(body, /RMDir \/r "\$1"/);
  const safe = body.slice(body.indexOf('zca_rm_safe:'), body.indexOf('zca_rm_done:'));
  assert.match(safe, /DetailPrint /);
  assert.match(safe, /MessageBox MB_OK\|MB_ICONEXCLAMATION "[^"]*\$INSTDIR[^"]*" \/SD IDOK/);
  assert.doesNotMatch(safe, /RMDir \/r/);
});

// ---------------- ocr-review.sh 时间预算 ----------------

const ocrSrc = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'ocr-review.sh'), 'utf8');
const start = ocrSrc.indexOf('HOP_TIMEOUT="${OCR_REVIEW_HOP_TIMEOUT');
const end = ocrSrc.indexOf('CHAIN_START=');
const budgetBlock = ocrSrc.slice(start, end);

function evalBudget(hop, total) {
  const env = { ...process.env };
  delete env.OCR_REVIEW_HOP_TIMEOUT;
  delete env.OCR_REVIEW_TOTAL_BUDGET;
  if (hop !== undefined) env.OCR_REVIEW_HOP_TIMEOUT = hop;
  if (total !== undefined) env.OCR_REVIEW_TOTAL_BUDGET = total;
  const r = spawnSync('bash', ['-c', `${budgetBlock}\necho "$HOP_TIMEOUT $TOTAL_BUDGET"`], { env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout.trim();
}

test('ocr-review 预算：区块可定位', () => {
  assert.ok(start > 0 && end > start);
});

test('ocr-review 预算：全零值被拒绝回落默认', () => {
  assert.strictEqual(evalBudget('00', '000'), '900 5400');
  assert.strictEqual(evalBudget('0', '0'), '900 5400');
});

test('ocr-review 预算：前导零按十进制归一化（08/09 不再八进制报错）', () => {
  assert.strictEqual(evalBudget('08', '09'), '8 9');
  assert.strictEqual(evalBudget('0900', '05400'), '900 5400');
});

test('ocr-review 预算：非法值回落，合法值与默认值不变', () => {
  assert.strictEqual(evalBudget('15m', ''), '900 5400');
  assert.strictEqual(evalBudget('120', '600'), '120 600');
  assert.strictEqual(evalBudget(undefined, undefined), '900 5400');
});

// ---------------- tar 长名扩展 ----------------

function retypeAt(tar, offset, flag) {
  const buf = Buffer.from(tar);
  buf[offset + 156] = flag.charCodeAt(0);
  buf.fill(0x20, offset + 148, offset + 156);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[offset + i];
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', offset + 148, 8, 'ascii');
  return buf;
}

const LONG = `node-v24.0.0-linux-x64/${'deep/'.repeat(40)}file.txt`; // > 255 字节

test('readTarGz：GNU L 长名套用到下一条', () => {
  const tar = retypeAt(archive.buildTar([
    { path: '././@LongLink', data: `${LONG}\0` },
    { path: 'truncated', data: 'long-data' },
    { path: 'node-v24.0.0-linux-x64/bin/node', data: 'NODE' },
  ]), 0, 'L');
  const entries = archive.readTarGz(zlib.gzipSync(tar));
  assert.deepStrictEqual(entries.map((e) => e.path), [LONG, 'node-v24.0.0-linux-x64/bin/node']);
  assert.strictEqual(entries[0].data.toString(), 'long-data');
});

test('extractFromTarGz：归档中别处有长名/K 头/PAX path 时仍能取到 bin/node', () => {
  let tar = archive.buildTar([
    { path: '././@LongLink', data: `${LONG}\0` },          // L
    { path: 'truncated', data: 'x' },
    { path: '././@LongLink', data: 'some/long/link/target' }, // K（忽略）
    { path: 'pax', data: '30 path=a/pax/long/name.txt\n' },     // x
    { path: 'short', data: 'y' },
    { path: 'node-v24.0.0-linux-x64/bin/node', data: 'NODE' },
  ]);
  tar = retypeAt(tar, 0, 'L');
  tar = retypeAt(tar, 512 * 4, 'K');
  tar = retypeAt(tar, 512 * 6, 'x');
  const gz = zlib.gzipSync(tar);
  assert.strictEqual(archive.extractFromTarGz(gz, 'bin/node').toString(), 'NODE');
  const paths = archive.readTarGz(gz).map((e) => e.path);
  assert.deepStrictEqual(paths, [LONG, 'a/pax/long/name.txt', 'node-v24.0.0-linux-x64/bin/node']);
});

test('readTarGz：PAX path= 逃逸 / 绝对路径仍被 sanitizeEntryPath 拒绝', () => {
  for (const bad of ['../evil', '/etc/passwd']) {
    const tar = retypeAt(archive.buildTar([
      { path: 'pax', data: `20 path=${bad}\n` },
      { path: 'ok.txt', data: 'z' },
    ]), 0, 'x');
    assert.throws(() => archive.readTarGz(zlib.gzipSync(tar)), /逃逸|绝对路径/);
  }
});

test('readTarGz：纯元数据 PAX / g 全局头不影响下一条名字', () => {
  let tar = archive.buildTar([
    { path: 'g', data: '30 path=global/ignored.txt\n' },
    { path: 'real.txt', data: 'ok' },
  ]);
  tar = retypeAt(tar, 0, 'g');
  assert.deepStrictEqual(archive.readTarGz(zlib.gzipSync(tar)).map((e) => e.path), ['real.txt']);
});
