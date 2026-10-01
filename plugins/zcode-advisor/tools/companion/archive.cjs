'use strict';

// 零依赖归档实现（ZIP / TAR+GZIP）。
//
// 为什么自研：发行包构建原先调用 `powershell Compress-Archive`（Windows）与
// `SystemRoot\System32\tar.exe`；这两条路径在 macOS 上都不存在（实测 powershell ENOENT、
// 无 SystemRoot）。项目坚持零第三方 npm 依赖，因此只能用 Node 内置模块自行归档。
//
// 格式约束（两处都保留 Unix mode，否则 mac 包解压后 install.sh 不可执行）：
// - ZIP：local file header + data descriptor 免用 + central directory + EOCD。
//   用 deflateRaw 压缩（node.exe 约 100MB+，store 会让包体积失控）。
// - TAR：固定 512 字节块头，ustar magic "ustar\0" + version "00"，末尾补两块零块，
//   整体过 gzip。
//
// 不实现 ZIP64（>4GB 触发），超限直接抛错——发行包远小于该上限，静默产出坏包更糟。

const zlib = require('zlib');

const ZIP_LOCAL_SIG = 0x04034b50;
const ZIP_CENTRAL_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_GPBF = 0x0800; // UTF-8 文件名标志
const ZIP_VERSION = 20; // 2.0：支持 deflate
const ZIP_UNIX_HOST = 3 << 8; // 外部属性高字节标记为 Unix，便于保留权限

const TAR_BLOCK = 512;
const USTAR_MAGIC = 'ustar';
const USTAR_VERSION = '00';
// 发行包内含的 node 二进制约 100~130MB，用 4GB 作为 ZIP 硬上限留足余量
const MAX_ZIP_TOTAL_BYTES = 0xffffffff;
const MAX_ZIP_SINGLE_BYTES = 0xffffffff;

// ---------------- 公共工具 ----------------

function normalizeMode(mode, fallback) {
  const m = Number.isFinite(mode) ? mode : fallback;
  // 只保留低 12 位（权限 + setuid/setgid/sticky）
  return m & 0o7777;
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data == null) return Buffer.alloc(0);
  return Buffer.from(String(data), 'utf8');
}

// 归档条目的路径统一用正斜杠，且不允许绝对路径或 .. 逃逸（解压侧安全）。
function sanitizeEntryPath(p) {
  const raw = String(p == null ? '' : p).replace(/\\/g, '/');
  if (!raw) throw new Error('archive: entry path 不能为空');
  if (raw.startsWith('/')) throw new Error(`archive: entry path 不允许绝对路径: ${raw}`);
  const parts = [];
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') throw new Error(`archive: entry path 不允许 .. 逃逸: ${raw}`);
    parts.push(seg);
  }
  if (parts.length === 0) throw new Error(`archive: entry path 无效: ${raw}`);
  return parts.join('/');
}

// ---------------- CRC32（ZIP 需要） ----------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------- ZIP ----------------

function buildZip(entries) {
  const files = [];
  let total = 0;

  for (const entry of entries) {
    const name = sanitizeEntryPath(entry.path);
    const data = toBuffer(entry.data);
    const mode = normalizeMode(entry.mode, entry.dir ? 0o755 : 0o644);
    if (data.length > MAX_ZIP_SINGLE_BYTES) {
      throw new Error(`archive: 单条目超过 ZIP 上限（${data.length} 字节）: ${name}`);
    }
    total += data.length;
    if (total > MAX_ZIP_TOTAL_BYTES) {
      throw new Error('archive: 总大小超过 ZIP 上限（不支持 ZIP64）');
    }
    const crc = crc32(data);
    const compressed = data.length === 0 ? Buffer.alloc(0) : zlib.deflateRawSync(data, { level: 9 });
    // 压缩后反而更大时用 store（method 0），避免负收益
    const useStore = compressed.length >= data.length;
    files.push({
      name: Buffer.from(name, 'utf8'),
      data,
      mode,
      crc,
      method: useStore ? 0 : 8,
      payload: useStore ? data : compressed,
      uncompressedSize: data.length
    });
  }

  const localParts = [];
  let offset = 0;
  for (const f of files) {
    const header = Buffer.alloc(30);
    header.writeUInt32LE(ZIP_LOCAL_SIG, 0);
    header.writeUInt16LE(ZIP_VERSION, 4);
    header.writeUInt16LE(ZIP_GPBF, 6); // UTF-8 文件名
    header.writeUInt16LE(f.method, 8);
    header.writeUInt16LE(0, 10); // 时间：固定 0，保证构建可复现
    header.writeUInt16LE(0, 12); // 日期：同上
    header.writeUInt32LE(f.crc, 14);
    header.writeUInt32LE(f.payload.length, 18);
    header.writeUInt32LE(f.uncompressedSize, 22);
    header.writeUInt16LE(f.name.length, 26);
    header.writeUInt16LE(0, 28); // extra 长度
    localParts.push(header, f.name, f.payload);
    f.localOffset = offset;
    offset += header.length + f.name.length + f.payload.length;
  }

  const centralParts = [];
  for (const f of files) {
    const rec = Buffer.alloc(46);
    rec.writeUInt32LE(ZIP_CENTRAL_SIG, 0);
    rec.writeUInt16LE(ZIP_VERSION | ZIP_UNIX_HOST, 4); // version made by
    rec.writeUInt16LE(ZIP_VERSION, 6);
    rec.writeUInt16LE(ZIP_GPBF, 8);
    rec.writeUInt16LE(f.method, 10);
    rec.writeUInt16LE(0, 12);
    rec.writeUInt16LE(0, 14);
    rec.writeUInt32LE(f.crc, 16);
    rec.writeUInt32LE(f.payload.length, 20);
    rec.writeUInt32LE(f.uncompressedSize, 24);
    rec.writeUInt16LE(f.name.length, 28);
    rec.writeUInt16LE(0, 30); // extra
    rec.writeUInt16LE(0, 32); // comment
    rec.writeUInt16LE(0, 34); // disk number
    rec.writeUInt16LE(0, 36); // internal attrs
    // 外部属性高 16 位 = Unix mode，低 16 位 0（非目录）
    rec.writeUInt32LE((f.mode << 16) >>> 0, 38);
    rec.writeUInt32LE(f.localOffset, 42);
    centralParts.push(rec, f.name);
  }

  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(ZIP_EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // central 起始 disk
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment 长度

  return Buffer.concat([...localParts, central, eocd]);
}

// ---------------- TAR ----------------

// ustar 字段：内容 + NUL 填充到固定长度。数字用八进制 + NUL 结尾。
function writeString(buf, offset, length, value) {
  const b = Buffer.from(String(value), 'utf8');
  const len = Math.min(b.length, length);
  b.copy(buf, offset, 0, len);
  return buf;
}

function writeOctal(buf, offset, length, value) {
  // 长度含结尾 NUL/空格；允许的最大值为 8^(length-1)-1
  const str = Math.max(0, Math.floor(value)).toString(8).padStart(length - 1, '0');
  if (str.length > length - 1) throw new Error(`archive: tar 字段溢出（值 ${value} 超出 ${length} 字节）`);
  buf.write(str, offset, 'ascii');
  buf[offset + length - 1] = 0;
  return buf;
}

function buildTarHeader(name, size, mode, typeflag) {
  // ustar 单字段路径上限 100 字节；kNameMax 之外用 prefix 拆分
  const header = Buffer.alloc(TAR_BLOCK);
  const nameBuf = Buffer.from(name, 'utf8');

  if (nameBuf.length <= 100) {
    writeString(header, 0, 100, name);
  } else {
    // 尝试拆成 prefix + name（各自不超限）
    let splitAt = -1;
    for (let i = nameBuf.length - 1; i > 0; i--) {
      if (nameBuf[i] === 0x2f /* / */ && nameBuf.length - i - 1 <= 100 && i <= 155) {
        splitAt = i;
        break;
      }
    }
    if (splitAt === -1) throw new Error(`archive: tar 路径过长（>255 字节），未实现 PAX 扩展: ${name}`);
    writeString(header, 0, 100, nameBuf.subarray(splitAt + 1).toString('utf8'));
    writeString(header, 345, 155, nameBuf.subarray(0, splitAt).toString('utf8'));
  }

  writeOctal(header, 100, 8, mode); // mode
  writeOctal(header, 108, 8, 0); // uid
  writeOctal(header, 116, 8, 0); // gid
  writeOctal(header, 124, 12, size); // size
  writeOctal(header, 136, 12, 0); // mtime：固定 0，保证可复现
  header[156] = typeflag.charCodeAt(0); // typeflag：'0' 普通文件
  writeString(header, 257, 6, USTAR_MAGIC);
  writeString(header, 263, 2, USTAR_VERSION);
  // 其余字段留空（uname/gname/devmajor/devminor/prefix 已在上面处理）

  // checksum：先按空格计算，再写入
  writeString(header, 148, 8, '        ');
  let sum = 0;
  for (let i = 0; i < TAR_BLOCK; i++) sum += header[i];
  const sumStr = sum.toString(8).padStart(6, '0');
  header.write(sumStr, 148, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function buildTar(entries) {
  const parts = [];
  for (const entry of entries) {
    const name = sanitizeEntryPath(entry.path);
    const data = toBuffer(entry.data);
    const mode = normalizeMode(entry.mode, 0o644);
    parts.push(buildTarHeader(name, data.length, mode, '0'));
    if (data.length > 0) {
      parts.push(data);
      const pad = TAR_BLOCK - (data.length % TAR_BLOCK);
      if (pad !== TAR_BLOCK) parts.push(Buffer.alloc(pad));
    }
  }
  // 末尾两块零块
  parts.push(Buffer.alloc(TAR_BLOCK * 2));
  return Buffer.concat(parts);
}

function buildTarGz(entries) {
  return zlib.gzipSync(buildTar(entries), { level: 9 });
}

// ---------------- TAR 读取（用于提取内嵌 Node 运行时） ----------------

function readOctalField(buf, offset, length) {
  // 兼容 NUL 结尾与空格结尾两种写法
  const raw = buf.subarray(offset, offset + length).toString('ascii').replace(/\0.*$/, '').trim();
  if (!raw) return 0;
  const n = parseInt(raw, 8);
  return Number.isFinite(n) ? n : 0;
}

// 解析（可能 gzip 压缩的）tar，返回 [{ path, data, mode, type }]。
// 只支持 ustar 普通文件与目录；不做 PAX/GNU 长名扩展（官方 Node 发行包是 ustar）。
function readTarGz(input) {
  const buf = zlib.gunzipSync(input);
  const entries = [];
  let pos = 0;
  while (pos + TAR_BLOCK <= buf.length) {
    const header = buf.subarray(pos, pos + TAR_BLOCK);
    // 双零块 → 结束
    if (header.every((b) => b === 0)) break;

    const nameField = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefixField = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const size = readOctalField(header, 124, 12);
    const mode = readOctalField(header, 100, 8);
    const type = String.fromCharCode(header[156] || 0x30);
    const name = prefixField ? `${prefixField}/${nameField}` : nameField;

    pos += TAR_BLOCK;
    if (type === '0' || type === '\0' || type === '') {
      entries.push({ path: name, data: buf.subarray(pos, pos + size), mode, type: 'file' });
    } else if (type === '5') {
      entries.push({ path: name, data: Buffer.alloc(0), mode, type: 'dir' });
    }
    // 数据区按 512 对齐
    pos += Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }
  return entries;
}

// 从 tar.gz 中按路径取单文件内容；缺失返回 null。
// 与 extractFromZip 同样的兼容策略：官方 Node 发行包的顶层目录名带版本号
// （如 node-v24.21.0-darwin-x64/bin/node），因此除精确匹配外还允许尾部匹配。
function extractFromTarGz(input, wantedPath) {
  const wanted = sanitizeEntryPath(wantedPath);
  const files = readTarGz(input).filter((e) => e.type === 'file');
  for (const e of files) {
    const p = e.path.replace(/^\.\//, '');
    if (p === wanted) return e.data;
  }
  for (const e of files) {
    const p = e.path.replace(/^\.\//, '');
    if (p.endsWith(`/${wanted}`)) return e.data;
  }
  return null;
}

// ---------------- ZIP 读取（用于提取官方 Node 的 zip 发行包） ----------------

// 从中央目录解析条目。刻意走中央目录而非顺序扫 local header：
// 流式写入的 zip 会在 local header 置 bit 3（data descriptor），此时 local header 里的
// 大小为 0，只有中央目录记录的才是真实值。官方 Node zip 即可能带该标志。
function readZipEntries(buf) {
  // 从尾部找 EOCD（注释最长 65535，向前最多找 64KB）
  let eocdAt = -1;
  const from = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === ZIP_EOCD_SIG) { eocdAt = i; break; }
  }
  if (eocdAt === -1) throw new Error('archive: 未找到 ZIP EOCD（不是有效 zip）');

  const count = buf.readUInt16LE(eocdAt + 10);
  let pos = buf.readUInt32LE(eocdAt + 16);
  const out = [];

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(pos) !== ZIP_CENTRAL_SIG) {
      throw new Error(`archive: central directory 第 ${i} 条签名错误 @${pos}`);
    }
    const method = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const rawSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const externalAttrs = buf.readUInt32LE(pos + 38);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');

    // local header 自带 name/extra 长度，需用它定位数据起点（可能与中央目录不同）
    if (buf.readUInt32LE(localOffset) !== ZIP_LOCAL_SIG) {
      throw new Error(`archive: local header 签名错误: ${name}`);
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const payload = buf.subarray(dataStart, dataStart + compSize);

    let data;
    if (method === 0) data = Buffer.from(payload);
    else if (method === 8) data = zlib.inflateRawSync(payload);
    else throw new Error(`archive: 不支持 ZIP 压缩方法 ${method}（${name}）`);

    if (data.length !== rawSize) {
      throw new Error(`archive: 解压大小不符（${name}: ${data.length} != ${rawSize}）`);
    }
    out.push({ path: name, data, size: rawSize, mode: (externalAttrs >>> 16) & 0o7777 });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// 从 ZIP 中按路径取单文件（兼容发行包内的顶层目录名）；缺失返回 null。
// 与 TAR 版保持一致：**先精确匹配、再尾部匹配**两趟。
// 单趟混排会让结果依赖条目顺序——实测 zip 内若 `.../node.exe` 排在 `node.exe` 之前，
// 单趟实现会错误返回嵌套那个（tar 版当时返回的是正确值，两者行为不一致）。
function extractFromZip(buf, wantedPath) {
  const wanted = sanitizeEntryPath(wantedPath);
  const files = readZipEntries(buf).map((e) => ({ ...e, path: e.path.replace(/^\.\//, '') }));

  for (const e of files) {
    if (e.path === wanted) return e.data;
  }
  for (const e of files) {
    if (e.path.endsWith(`/${wanted}`)) return e.data;
  }
  return null;
}

module.exports = {
  buildZip,
  buildTar,
  buildTarGz,
  readTarGz,
  extractFromTarGz,
  readZipEntries,
  extractFromZip,
  crc32,
  sanitizeEntryPath,
  ZIP_LOCAL_SIG,
  ZIP_CENTRAL_SIG,
  ZIP_EOCD_SIG
};
