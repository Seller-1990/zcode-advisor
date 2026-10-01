'use strict';

// 图标生成（零依赖）：盾牌图形 → PNG/ICO/ICNS。
// 从 build-installer.cjs 抽出，便于单测与复用；颜色与形状保持不变。

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

// ---------------- ICO / ICNS ----------------

function makeIco() {
  const s32 = drawShield(32);
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
  const png256 = encodePng(256, drawShield(256));

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
    const png = encodePng(size, drawShield(size));
    const typeBuf = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4); len.writeUInt32BE(png.length + 8);
    chunks.push(Buffer.concat([typeBuf, len, png]));
  }
  const body = Buffer.concat(chunks);
  const head = Buffer.from('icns', 'ascii');
  const total = Buffer.alloc(4); total.writeUInt32BE(body.length + 8);
  return Buffer.concat([head, total, body]);
}

module.exports = { drawShield, encodePng, makeIco, makeIcns, crc32, ICNS_SIZES };
