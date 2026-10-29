'use strict';
// P3 构建工具链修复的回归测试：archive / icon / build-meta / packagers。
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');

const archive = require('../tools/companion/archive.cjs');
const icon = require('../tools/companion/icon.cjs');
const meta = require('../tools/companion/build-meta.cjs');
const { version4 } = require('../tools/companion/packagers.cjs');

const ZIP_CENTRAL_SIG = 0x02014b50;

test('archive.buildZip：Uint8Array / ArrayBuffer / DataView 按字节写入，未知类型抛错', () => {
  const bytes = [0, 1, 2, 250, 255];
  const u8 = new Uint8Array(bytes);
  const zip = archive.buildZip([
    { path: 'u8.bin', data: u8 },
    { path: 'ab.bin', data: u8.buffer },
    { path: 'sub.bin', data: new Uint8Array([9, 8, 7, 6]).subarray(1, 3) },
    { path: 'dv.bin', data: new DataView(u8.buffer, 1, 2) },
  ]);
  const got = Object.fromEntries(archive.readZipEntries(zip).map((e) => [e.path, [...e.data]]));
  assert.deepStrictEqual(got['u8.bin'], bytes);
  assert.deepStrictEqual(got['ab.bin'], bytes);
  assert.deepStrictEqual(got['sub.bin'], [8, 7]);
  assert.deepStrictEqual(got['dv.bin'], [1, 2]);
  assert.throws(() => archive.buildZip([{ path: 'x', data: { a: 1 } }]), TypeError);
  assert.throws(() => archive.buildZip([{ path: 'x', data: 42 }]), TypeError);
});

test('archive.buildZip：DOS 日期字段合法（非 0，日 ≥ 1）', () => {
  const zip = archive.buildZip([{ path: 'a.txt', data: 'a' }]);
  const date = zip.readUInt16LE(12); // local header 修改日期
  assert.ok(date !== 0 && (date & 0x1f) >= 1, `DOS date=${date.toString(16)}`);
});

test('archive.extractFromZip：只解压目标条目（其他条目损坏不影响）', () => {
  const zip = Buffer.from(archive.buildZip([
    { path: 'a.txt', data: 'alpha' },
    { path: 'b.txt', data: 'bravo' },
  ]));
  // 篡改第二条中央目录记录的 CRC
  let seen = 0;
  for (let i = 0; i + 4 <= zip.length; i++) {
    if (zip.readUInt32LE(i) === ZIP_CENTRAL_SIG && ++seen === 2) { zip.writeUInt32LE(0xdeadbeef, i + 16); break; }
  }
  assert.strictEqual(seen, 2);
  assert.strictEqual(archive.extractFromZip(zip, 'a.txt').toString(), 'alpha');
  assert.throws(() => archive.extractFromZip(zip, 'b.txt'), /CRC/);
  assert.throws(() => archive.readZipEntries(zip), /CRC/);
  assert.strictEqual(archive.extractFromZip(zip, 'missing.txt'), null);
});

// 改写 tar 第一个头的 typeflag 并重算校验和
function retype(tar, flag) {
  const buf = Buffer.from(tar);
  buf[156] = flag.charCodeAt(0);
  buf.fill(0x20, 148, 156);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i];
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return buf;
}

test('archive.readTarGz：GNU 长名 / PAX 路径头明确报错，纯元数据 PAX 头可忽略', () => {
  const gnu = retype(archive.buildTar([{ path: 'longname', data: 'some/very/long/path' }]), 'L');
  assert.throws(() => archive.readTarGz(zlib.gzipSync(gnu)), /GNU/);

  const paxPath = retype(archive.buildTar([{ path: 'pax', data: '13 path=long\n' }]), 'x');
  assert.throws(() => archive.readTarGz(zlib.gzipSync(paxPath)), /PAX/);

  const paxMeta = retype(archive.buildTar([
    { path: 'pax', data: '12 mtime=10\n' },
    { path: 'real.txt', data: 'ok' },
  ]), 'x');
  const entries = archive.readTarGz(zlib.gzipSync(paxMeta));
  assert.deepStrictEqual(entries.map((e) => e.path), ['real.txt']);
  assert.strictEqual(entries[0].data.toString(), 'ok');
});

test('icon：crc32 与 archive 共用同一实现', () => {
  assert.strictEqual(icon.crc32, archive.crc32);
});

test('icon.decodePng：截断 / CRC 错误 / 尺寸异常均抛错', () => {
  const png = icon.encodePng(2, Buffer.alloc(2 * 2 * 4, 255));
  assert.strictEqual(icon.decodePng(png).width, 2);

  assert.throws(() => icon.decodePng(png.subarray(0, png.length - 20)));

  const badCrc = Buffer.from(png);
  badCrc[16] ^= 0xff; // IHDR 宽度字节
  assert.throws(() => icon.decodePng(badCrc), /CRC/i);

  const huge = Buffer.from(png);
  huge.writeUInt32BE(100000, 16); // 宽度 100000，CRC 重算后仍须被尺寸检查拦下
  huge.writeUInt32BE(archive.crc32(huge.subarray(12, 29)), 29);
  assert.throws(() => icon.decodePng(huge));
});

test('build-meta.companionRuntimeFiles：路径都在 companion 目录内', () => {
  const files = meta.companionRuntimeFiles();
  assert.ok(files.length > 0);
  for (const f of files) assert.ok(!f.startsWith('..') && !require('node:path').isAbsolute(f), f);
});

test('packagers.version4：只取数字 x.y.z 前缀并钳到 0..65535', () => {
  assert.strictEqual(version4('0.2.24-rc.1'), '0.2.24.0');
  assert.strictEqual(version4('1.2.3.4'), '1.2.3.4');
  assert.strictEqual(version4('2.5'), '2.5.0.0');
  assert.strictEqual(version4('v1.2.3'), '1.2.3.0');
  assert.strictEqual(version4('70000.1.2'), '65535.1.2.0');
  assert.strictEqual(version4('bad'), '0.0.0.0');
});
