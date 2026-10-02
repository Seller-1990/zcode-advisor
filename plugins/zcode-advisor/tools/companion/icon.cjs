'use strict';

// 图标生成（零依赖）：优先用 assets/icon.png（用户自定义源图）缩放出各档位；
// 源图不存在或格式不支持时回退到程序化盾牌。ICO/ICNS 的拼装结构保持不变。

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------- 像素绘制 ----------------

function drawShield(size) {
  const d = Buffer.alloc(size * size * 4);
  const px = (x, y, r, g, b, a) => {
    const i = (y * size + x) * 4;
    d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a;
  };
  const inRounded = (x, y, m, rad) => {
    const x0 = m, y0 = m, x1 = size - m, y1 = size - m;
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.max(x0 + rad, Math.min(x, x1 - rad));
    const cy = Math.max(y0 + rad, Math.min(y, y1 - rad));
    return (x - cx) * (x - cx) + (y - cy) * (y - cy) <= rad * rad
      || (x >= x0 + rad && x <= x1 - rad)
      || (y >= y0 + rad && y <= y1 - rad);
  };
  const shieldHalf = (t) => size * 0.26 * (1 - 0.42 * t * t); // t∈[0,1] 从顶到底收窄
  const shieldTop = size * 0.24, shieldBottom = size * 0.82, cx = size / 2;
  const inShield = (x, y, scale) => {
    if (y < shieldTop || y > shieldBottom) return false;
    const t = (y - shieldTop) / (shieldBottom - shieldTop);
    const half = shieldHalf(t) * scale;
    if (t > 0.86) { // 底部收尖
      const k = (t - 0.86) / 0.14;
      return Math.abs(x - cx) <= half * (1 - k);
    }
    return Math.abs(x - cx) <= half;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!inRounded(x, y, size * 0.03, size * 0.2)) { px(x, y, 0, 0, 0, 0); continue; }
      // 底：深蓝渐变
      const t = y / size;
      let r = Math.round(15 + 20 * t), g = Math.round(23 + 30 * t), b = Math.round(42 + 45 * t);
      if (inShield(x, y, 1)) { r = 226; g = 232; b = 240; }     // 外盾：浅色
      if (inShield(x, y, 0.74)) { r = 37; g = 99; b = 235; }     // 内盾：品牌蓝
      if (inShield(x, y, 0.74)) {
        // 中间一道浅色斜杠，增强辨识度
        const dx = x - cx, dy = y - (shieldTop + shieldBottom) / 2;
        if (Math.abs(dx - dy * 0.35) < size * 0.045) { r = 226; g = 232; b = 240; }
      }
      px(x, y, r, g, b, 255);
    }
  }
  return d;
}

// ---------------- PNG 编码（8-bit RGBA，filter 0） ----------------

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

function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------------- 外部源图（assets/icon.png）----------------

// 极简 PNG 解码（8-bit、非隔行、灰度 0 / RGB 2 / RGBA 6），够图标源图用；
// 其余格式抛错由调用方回退程序化盾牌，不在零依赖包里养完整 PNG 库。
function decodePng(buf) {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
  let off = 8;
  let width = 0; let height = 0; let colorType = -1; let bitDepth = -1;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG unsupported');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  const channels = { 0: 1, 2: 3, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported color type ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  // 每行首字节的滤波还原（0 None / 1 Sub / 2 Up / 3 Average / 4 Paeth）
  const bpp = channels;
  const paeth = (a, b, c) => {
    const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
  };
  const out = Buffer.alloc(width * height * 4);
  const prev = Buffer.alloc(stride);
  const line = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    raw.copy(line, 0, y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      if (f === 1) line[x] = (line[x] + a) & 0xff;
      else if (f === 2) line[x] = (line[x] + b) & 0xff;
      else if (f === 3) line[x] = (line[x] + ((a + b) >> 1)) & 0xff;
      else if (f === 4) line[x] = (line[x] + paeth(a, b, c)) & 0xff;
      else if (f > 4) throw new Error(`bad filter ${f}`);
    }
    line.copy(prev);
    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      if (colorType === 2) { out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2]; out[d + 3] = 255; }
      else if (colorType === 6) { out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2]; out[d + 3] = line[s + 3]; }
      else { out[d] = out[d + 1] = out[d + 2] = line[s]; out[d + 3] = 255; } // 灰度
    }
  }
  return { width, height, rgba: out };
}

// 双线性缩放到正方形（图标档位），边缘 clamp。
function resampleSquare(src, size) {
  const { width: w, height: h, rgba } = src;
  const out = Buffer.alloc(size * size * 4);
  const px = (x, y) => {
    const cx = Math.max(0, Math.min(w - 1, x));
    const cy = Math.max(0, Math.min(h - 1, y));
    return (cy * w + cx) * 4;
  };
  for (let y = 0; y < size; y++) {
    const gy = ((y + 0.5) * h) / size - 0.5;
    const y0 = Math.floor(gy); const fy = gy - y0;
    for (let x = 0; x < size; x++) {
      const gx = ((x + 0.5) * w) / size - 0.5;
      const x0 = Math.floor(gx); const fx = gx - x0;
      const d = (y * size + x) * 4;
      for (let ch = 0; ch < 4; ch++) {
        const p00 = rgba[px(x0, y0) + ch];
        const p10 = rgba[px(x0 + 1, y0) + ch];
        const p01 = rgba[px(x0, y0 + 1) + ch];
        const p11 = rgba[px(x0 + 1, y0 + 1) + ch];
        out[d + ch] = Math.round(
          p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy) + p01 * (1 - fx) * fy + p11 * fx * fy
        );
      }
    }
  }
  return out;
}

// 读 assets/icon.png（相对仓库根，icon.cjs 位于 tools/companion/ 下）。
// 不存在或解码失败返回 null——调用方回退程序化盾牌，构建绝不因图标中断。
let sourceIconCache = null;
function loadSourceIcon() {
  if (sourceIconCache !== null) return sourceIconCache;
  try {
    const file = path.resolve(__dirname, '..', '..', 'assets', 'icon.png');
    sourceIconCache = decodePng(fs.readFileSync(file));
  } catch (_) {
    sourceIconCache = false;
  }
  return sourceIconCache;
}

// 各档位像素：有源图用源图缩放，否则画盾牌。
function iconPixels(size) {
  const src = loadSourceIcon();
  return src ? resampleSquare(src, size) : drawShield(size);
}

// ---------------- ICO / ICNS ----------------

function makeIco() {
  const s32 = iconPixels(32);
  // 32bpp BMP 的像素通道顺序是 **BGRA**（不是 RGBA）——写反会使红色/蓝色互换。
  // 早期实现直接拷贝 RGBA 缓冲区，Windows 取 32×32 档时会显示成红色盾牌
  // （macOS sips 同样按 BGRA 解读，可复现该错误）。
  const xor = Buffer.alloc(32 * 32 * 4);
  for (let y = 0; y < 32; y++) {
    const srcRow = y * 32 * 4;
    const dstRow = (31 - y) * 32 * 4; // BMP 自下而上
    for (let x = 0; x < 32; x++) {
      const s = srcRow + x * 4;
      const d = dstRow + x * 4;
      xor[d] = s32[s + 2];     // B
      xor[d + 1] = s32[s + 1]; // G
      xor[d + 2] = s32[s];     // R
      xor[d + 3] = s32[s + 3]; // A
    }
  }
  const and = Buffer.alloc(32 * 4); // 全 0 = 不透明位
  const bmpHeader = Buffer.alloc(40);
  bmpHeader.writeUInt32LE(40, 0); bmpHeader.writeInt32LE(32, 4); bmpHeader.writeInt32LE(64, 8);
  bmpHeader.writeUInt16LE(1, 12); bmpHeader.writeUInt16LE(32, 14);
  bmpHeader.writeUInt32LE(xor.length + and.length, 20);
  const bmp = Buffer.concat([bmpHeader, xor, and]);
  const png256 = encodePng(256, iconPixels(256));

  const entries = [];
  entries.push({ size: 32, data: bmp });
  entries.push({ size: 256, data: png256, png: true });

  const dir = Buffer.alloc(6 + entries.length * 16);
  dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(entries.length, 4);
  let off = 6 + entries.length * 16;
  entries.forEach((e, i) => {
    const base = 6 + i * 16;
    dir[base] = e.size % 256; dir[base + 1] = 0;      // 宽（256 记为 0）
    dir[base + 2] = e.size % 256; dir[base + 3] = 0;  // 高
    dir.writeUInt16LE(1, base + 4);                    // 调色板数
    dir.writeUInt16LE(32, base + 6);                   // bitcount
    dir.writeUInt32LE(e.data.length, base + 8);
    dir.writeUInt32LE(off, base + 12);
    off += e.data.length;
  });
  return Buffer.concat([dir, ...entries.map((e) => e.data)]);
}

// icns 类型码：ic07=128, ic08=256, ic09=512, ic11=32, ic12=64
const ICNS_SIZES = [
  ['ic11', 32],
  ['ic12', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512]
];

// ICNS 块序（**顺序很重要**）：icns 头 → 每个块为 [type(4)][length(4)][data...]，
// 其中 length 含 type 与 length 自身（即 data.length + 8）。
// 注意：早期实现把 length 写在 type 之前，导致系统工具（iconutil/sips）无法解码——
// 由于自测也按同样顺序读回，曾出现"自洽但格式错"的假通过。
function makeIcns() {
  const chunks = [];
  for (const [type, size] of ICNS_SIZES) {
    const png = encodePng(size, iconPixels(size));
    const typeBuf = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4); len.writeUInt32BE(png.length + 8);
    chunks.push(Buffer.concat([typeBuf, len, png]));
  }
  const body = Buffer.concat(chunks);
  const head = Buffer.from('icns', 'ascii');
  const total = Buffer.alloc(4); total.writeUInt32BE(body.length + 8);
  return Buffer.concat([head, total, body]);
}

module.exports = { drawShield, encodePng, makeIco, makeIcns, crc32, ICNS_SIZES, decodePng, resampleSquare, loadSourceIcon, iconPixels };