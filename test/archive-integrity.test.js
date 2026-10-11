'use strict';

// R16（冻结清单 P3 残留）：归档读取器的**完整性校验**。
//
// 为什么需要：`readTarGz` 解析 tar 头时直接信 size 字段，`buf.subarray(pos, pos + size)`
// 在数据不足时会**静默返回短 buffer**——发行包构建中断/下载损坏时，会把截断的 node
// 二进制当成完好的写进安装目录，表现为"装完即崩"却查不到原因。同理 `readZipEntries`
// 校验了签名与解压后长度，却没比对中央目录里的 CRC，内容被改写但长度不变时无感知。
//
// 这里用**构造出来的损坏归档**驱动三条断言（tar 校验和 / tar 截断 / zip CRC）。
// 归档输入只来自构建器自身，不是远程可利用面；本用例防的是「静默产出坏包」。
//
// ZCA_ARCHIVE_PATH 用于把本用例指向修复前的快照，取得红灯。

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const zlib = require('zlib');

const ARCHIVE = process.env.ZCA_ARCHIVE_PATH || path.join(__dirname, '..', 'tools', 'companion', 'archive.cjs');
const { buildTarGz, readTarGz, extractFromTarGz, readZipEntries } = require(ARCHIVE);

const gunzip = (b) => zlib.gunzipSync(b);
const gzip = (b) => zlib.gzipSync(b);

// 与 buildTarHeader 同一算法：校验和字段按空格计，写成 6 位八进制 + NUL + 空格。
function fixChecksum(raw, headerAt) {
  raw.fill(0x20, headerAt + 148, headerAt + 156);
  let sum = 0;
  for (let i = headerAt; i < headerAt + 512; i++) sum += raw[i];
  raw.write(sum.toString(8).padStart(6, '0'), headerAt + 148, 'ascii');
  raw[headerAt + 154] = 0;
  raw[headerAt + 155] = 0x20;
}

// 手搓一个 method=0（store）的最小 zip：内容被改写时长度不变，只有 CRC 会不符，
// 因此它恰好是「CRC 校验到底有没有生效」的判据（deflate 条目改字节通常会先 inflate 报错）。
function storedZip(name, content) {
  const data = Buffer.from(content);
  const nameBuf = Buffer.from(name);
  const crc = require(ARCHIVE).crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8); // method 0 = store
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 10); // method 0
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE((0o644 << 16) >>> 0, 38);
  central.writeUInt32LE(0, 42); // local offset

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + nameBuf.length, 12);
  eocd.writeUInt32LE(30 + nameBuf.length + data.length, 16);

  return Buffer.concat([local, nameBuf, data, central, nameBuf, eocd]);
}

test('R16：tar 头校验和被篡改必须抛错（不得静默返回损坏条目）', () => {
  const raw = gunzip(buildTarGz([{ path: 'bin/node', data: Buffer.from('fake-node'), mode: 0o755 }]));
  raw[0] = raw[0] === 0x62 ? 0x63 : 0x62; // 'b' ↔ 'c'：只改内容，不动校验和字段
  assert.throws(() => readTarGz(gzip(raw)), /校验和/);
});

test('R16：tar 声明长度超出实际数据必须抛错（不得产出被截断的二进制）', () => {
  const raw = gunzip(buildTarGz([{ path: 'bin/node', data: Buffer.from('fake-node'), mode: 0o755 }]));
  raw.write('00000010000', 124, 'ascii'); // size = 4096，真实数据只有 9 字节
  raw[135] = 0;
  fixChecksum(raw, 0); // 同步修正校验和，隔离「长度字段撒谎」这一条
  assert.throws(() => readTarGz(gzip(raw)), /截断/);
  assert.throws(() => extractFromTarGz(gzip(raw), 'bin/node'), /截断/);
});

test('R16：zip 内容被改写（中央目录 CRC 不符）必须抛错', () => {
  const good = storedZip('bin/node', 'fake-node');
  assert.strictEqual(readZipEntries(good)[0].data.toString(), 'fake-node', '先用未损坏件校准夹具');
  const bad = Buffer.from(good);
  const at = bad.indexOf(Buffer.from('fake-node'));
  bad[at] = bad[at] === 0x66 ? 0x67 : 0x66; // 'f' ↔ 'g'
  assert.throws(() => readZipEntries(bad), /CRC/);
});
