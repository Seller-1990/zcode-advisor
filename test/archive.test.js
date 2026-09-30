'use strict';

// 归档实现的单测。重点不只是"能不能生成 Buffer"，而是**产物是否被真实工具认**：
// ZIP/TAR 的字节结构一旦写错，往往表现为"能生成、解压报错"或"能解压、内容损坏"，
// 所以这里除了自解析断言，还在可用的平台上调系统 `unzip` / `tar` 做反向校验。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const { buildZip, buildTar, buildTarGz, readTarGz, extractFromTarGz, readZipEntries, extractFromZip, crc32, sanitizeEntryPath } = require('../tools/companion/archive.cjs');

const hasTool = (name) => {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
};

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zca-archive-'));

// ---------------- 路径安全 ----------------

test('sanitizeEntryPath：拒绝绝对路径与 .. 逃逸，归一化分隔符', () => {
  assert.strictEqual(sanitizeEntryPath('a/b/c.txt'), 'a/b/c.txt');
  assert.strictEqual(sanitizeEntryPath('a\\b\\c.txt'), 'a/b/c.txt');
  assert.strictEqual(sanitizeEntryPath('./a//b/'), 'a/b');
  assert.throws(() => sanitizeEntryPath('/etc/passwd'), /绝对路径/);
  assert.throws(() => sanitizeEntryPath('a/../../etc/passwd'), /逃逸/);
  assert.throws(() => sanitizeEntryPath(''), /不能为空/);
});

test('crc32：已知向量（"123456789" → 0xCBF43926）', () => {
  assert.strictEqual(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.strictEqual(crc32(Buffer.alloc(0)), 0);
});

// ---------------- ZIP ----------------

test('buildZip：条目数、内容与 CRC 自洽（读 local header 复核）', () => {
  const entries = [
    { path: 'install.sh', data: Buffer.from('#!/bin/bash\necho hi\n'), mode: 0o755 },
    { path: 'dir/note.txt', data: Buffer.from('中文内容'), mode: 0o644 },
    { path: 'empty.txt', data: Buffer.alloc(0) }
  ];
  const zip = buildZip(entries);

  // EOCD 在末尾 22 字节
  const eocd = zip.subarray(zip.length - 22);
  assert.strictEqual(eocd.readUInt32LE(0), 0x06054b50, 'EOCD 签名');
  assert.strictEqual(eocd.readUInt16LE(8), entries.length, 'central 条目数');
  assert.strictEqual(eocd.readUInt16LE(10), entries.length, '总条目数');

  // 逐个 local header 校验方法与 CRC
  let offset = 0;
  for (const e of entries) {
    assert.strictEqual(zip.readUInt32LE(offset), 0x04034b50, `local 签名 @${e.path}`);
    const method = zip.readUInt16LE(offset + 8);
    const crc = zip.readUInt32LE(offset + 14);
    const compSize = zip.readUInt32LE(offset + 18);
    const rawSize = zip.readUInt32LE(offset + 22);
    const nameLen = zip.readUInt16LE(offset + 26);
    const name = zip.subarray(offset + 30, offset + 30 + nameLen).toString('utf8');
    const payload = zip.subarray(offset + 30 + nameLen, offset + 30 + nameLen + compSize);

    assert.strictEqual(name, e.path);
    assert.strictEqual(rawSize, e.data.length, `${e.path} 原始大小`);
    assert.strictEqual(crc, crc32(e.data), `${e.path} CRC`);
    const restored = method === 0 ? payload : zlib.inflateRawSync(payload);
    assert.deepStrictEqual(restored, e.data, `${e.path} 内容往返`);
    offset += 30 + nameLen + compSize;
  }
});

test('buildZip：unix mode 保留在 central directory 的外部属性里', () => {
  const zip = buildZip([{ path: 'install.sh', data: Buffer.from('x'), mode: 0o755 }]);
  const eocd = zip.subarray(zip.length - 22);
  const centralOffset = eocd.readUInt32LE(16);
  assert.strictEqual(zip.readUInt32LE(centralOffset), 0x02014b50, 'central 签名');
  const externalAttrs = zip.readUInt32LE(centralOffset + 38);
  assert.strictEqual((externalAttrs >>> 16) & 0o7777, 0o755, '可执行位保留');
});

test('buildZip：系统 unzip 可解析（可用时）', { skip: !hasTool('unzip') }, () => {
  const dir = tmpDir();
  const zipPath = path.join(dir, 'test.zip');
  fs.writeFileSync(zipPath, buildZip([
    { path: 'install.sh', data: Buffer.from('#!/bin/bash\n'), mode: 0o755 },
    { path: 'sub/data.txt', data: Buffer.from('hello 世界'), mode: 0o644 }
  ]));
  const out = execFileSync('unzip', ['-l', zipPath], { encoding: 'utf8' });
  assert.match(out, /install\.sh/);
  assert.match(out, /sub\/data\.txt/);
  // 实际解压校验内容
  execFileSync('unzip', ['-o', '-q', zipPath, '-d', path.join(dir, 'out')]);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'out', 'sub', 'data.txt'), 'utf8'), 'hello 世界');
});

// ---------------- TAR ----------------

test('buildTar：512 块头、ustar magic、末尾双零块', () => {
  const tar = buildTar([{ path: 'a.txt', data: Buffer.from('abc'), mode: 0o644 }]);
  assert.strictEqual(tar.length % 512, 0, '总长应为 512 的倍数');
  assert.strictEqual(tar.subarray(257, 262).toString('ascii'), 'ustar', 'magic');
  assert.strictEqual(tar.subarray(263, 265).toString('ascii'), '00', 'version');
  assert.strictEqual(tar.readUInt8(156), '0'.charCodeAt(0), 'typeflag');
  // mode 字段八进制
  assert.strictEqual(parseInt(tar.subarray(100, 107).toString('ascii'), 8), 0o644);
  // 末尾 1024 字节全零
  assert.ok(tar.subarray(tar.length - 1024).every((b) => b === 0), '末尾双零块');
});

test('buildTar：checksum 字段自洽', () => {
  const tar = buildTar([{ path: 'x.txt', data: Buffer.from('hello'), mode: 0o600 }]);
  const header = tar.subarray(0, 512);
  const recorded = parseInt(header.subarray(148, 154).toString('ascii'), 8);
  const copy = Buffer.from(header);
  copy.fill(0x20, 148, 156); // 校验和字段按空格计算
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += copy[i];
  assert.strictEqual(recorded, sum, 'checksum 与按空格重算一致');
});

test('buildTarGz：系统 tar 可解析并解出正确内容（可用时）', { skip: !hasTool('tar') }, () => {
  const dir = tmpDir();
  const tarPath = path.join(dir, 'test.tar.gz');
  fs.writeFileSync(tarPath, buildTarGz([
    { path: 'install.sh', data: Buffer.from('#!/bin/bash\necho ok\n'), mode: 0o755 },
    { path: 'nested/deep/file.txt', data: Buffer.from('深层内容'), mode: 0o644 }
  ]));
  const list = execFileSync('tar', ['-tzf', tarPath], { encoding: 'utf8' });
  assert.match(list, /install\.sh/);
  assert.match(list, /nested\/deep\/file\.txt/);
  execFileSync('tar', ['-xzf', tarPath, '-C', dir]);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'nested', 'deep', 'file.txt'), 'utf8'), '深层内容');
  if (process.platform !== 'win32') {
    const mode = fs.statSync(path.join(dir, 'install.sh')).mode & 0o777;
    assert.strictEqual(mode, 0o755, '可执行位经 tar 往返保留');
  }
});

test('buildTar：超过 100 字节的路径用 prefix 拆分', () => {
  const longDir = 'a'.repeat(60) + '/' + 'b'.repeat(60);
  const p = `${longDir}/file.txt`;
  const tar = buildTar([{ path: p, data: Buffer.from('x'), mode: 0o644 }]);
  const name = tar.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
  const prefix = tar.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
  assert.strictEqual(`${prefix}/${name}`, p, 'prefix + name 还原原路径');
});

test('buildTar：路径超过 255 字节时明确报错（未实现 PAX）', () => {
  const p = Array.from({ length: 5 }, () => 'x'.repeat(70)).join('/');
  assert.throws(() => buildTar([{ path: p, data: Buffer.from('x') }]), /路径过长/);
});

// ---------------- 读取器（S3 提取内嵌 Node 依赖它） ----------------

test('readTarGz / extractFromTarGz：自研 tar.gz 往返', () => {
  const t = buildTarGz([
    { path: 'bin/node', data: Buffer.from('fake-node-bin'), mode: 0o755 },
    { path: 'install.sh', data: Buffer.from('#!/bin/bash\n'), mode: 0o755 }
  ]);
  const entries = readTarGz(t);
  assert.deepStrictEqual(entries.map((e) => e.path).sort(), ['bin/node', 'install.sh']);
  assert.strictEqual(extractFromTarGz(t, 'bin/node').toString(), 'fake-node-bin');
  assert.strictEqual(extractFromTarGz(t, 'nope.txt'), null);
});

test('readZipEntries：自研 zip 往返，mode 保留', () => {
  const z = buildZip([
    { path: 'a.txt', data: Buffer.from('hello'), mode: 0o755 },
    { path: 'sub/b.txt', data: Buffer.from('nested'), mode: 0o644 }
  ]);
  const entries = readZipEntries(z);
  assert.deepStrictEqual(entries.map((e) => e.path), ['a.txt', 'sub/b.txt']);
  assert.strictEqual(entries[0].mode, 0o755);
  assert.strictEqual(extractFromZip(z, 'sub/b.txt').toString(), 'nested');
});

test('readZipEntries：能读系统 zip（含目录条目与可能的 data descriptor）', { skip: !hasTool('zip') }, () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'content-A\n');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'content-B\n');
  const zipPath = path.join(dir, 'sys.zip');
  execFileSync('zip', ['-q', '-r', zipPath, 'a.txt', 'sub'], { cwd: dir });

  const entries = readZipEntries(fs.readFileSync(zipPath));
  const names = entries.map((e) => e.path);
  assert.ok(names.includes('a.txt'), '含 a.txt');
  assert.ok(names.includes('sub/b.txt'), '含 sub/b.txt');
  assert.strictEqual(extractFromZip(fs.readFileSync(zipPath), 'a.txt').toString(), 'content-A\n');
  assert.strictEqual(extractFromZip(fs.readFileSync(zipPath), 'sub/b.txt').toString(), 'content-B\n');
});

test('extractFromZip：按尾部匹配官方发行包的顶层目录（node-vX-win-x64/node.exe）', () => {
  const z = buildZip([{ path: 'node-v22.0.0-win-x64/node.exe', data: Buffer.from('MZ-fake') }]);
  assert.strictEqual(extractFromZip(z, 'node.exe').toString(), 'MZ-fake');
});

test('extractFromZip：精确匹配优先于尾部匹配（与 TAR 行为一致）', () => {
  // 回归：早期实现单趟混排，结果依赖条目顺序——当嵌套条目排在前面时会误取。
  const z = buildZip([
    { path: 'node-v22.0.0-win-x64/node.exe', data: Buffer.from('NESTED') },
    { path: 'node.exe', data: Buffer.from('EXACT') }
  ]);
  assert.strictEqual(extractFromZip(z, 'node.exe').toString(), 'EXACT');
});

test('extractFromTarGz：按尾部匹配官方发行包的顶层目录（node-vX-darwin-x64/bin/node）', () => {
  // 回归：官方 Node tar 包顶层带版本目录，精确匹配会取不到二进制
  const t = buildTarGz([{ path: 'node-v24.21.0-darwin-x64/bin/node', data: Buffer.from('macho-fake'), mode: 0o755 }]);
  assert.strictEqual(extractFromTarGz(t, 'bin/node').toString(), 'macho-fake');
  assert.strictEqual(extractFromTarGz(t, 'nonexistent'), null);
});

test('extractFromTarGz：精确路径优先于尾部匹配（同名文件不误取）', () => {
  const t = buildTarGz([
    { path: 'bin/node', data: Buffer.from('exact'), mode: 0o755 },
    { path: 'node-v1-darwin-x64/bin/node', data: Buffer.from('nested'), mode: 0o755 }
  ]);
  assert.strictEqual(extractFromTarGz(t, 'bin/node').toString(), 'exact');
});

test('extractFromZip / readTarGz：非法输入明确抛错', () => {
  assert.throws(() => readZipEntries(Buffer.from('not a zip at all')), /未找到 ZIP EOCD/);
  assert.throws(() => readTarGz(Buffer.from('not gzip')), /unexpected|incorrect header|invalid/i);
});
