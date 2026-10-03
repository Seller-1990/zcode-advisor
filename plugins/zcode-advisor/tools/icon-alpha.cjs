'use strict';

// assets/icon.png 透明化生成脚本（v0.2.14 复审后从一次性脚本收编入库）。
//
// 背景：源图原为 1254×1254 RGB 无 alpha，四角白底会被 makeIco/makeIcns 带进
// 应用图标（深色桌面/坞栏上出现白色杂角）。本脚本用「逐行描迹」生成 alpha：
//   - 每行找第一个/最后一个暗像素（lum < 160）作为徽章边界；
//   - 边界 ±2px 内按亮度比例羽化（白→0，徽章深色→255）；
//   - 行内其余像素全不透明。
// 为什么逐行描迹而不是固定圆角半径：徽章角是连续曲线（squircle 风格），
// 正圆拟合在角落中部偏差 ~20px；描迹精确贴合实际轮廓。
//
// **适用前提（换图前必读，详见 test/install-templates.test.js 的属性测试）**：
//   1. 徽章满幅铺满画布、每行暗区是**单一连续区间**（行内断裂会把断裂区涂成不透明背景）；
//   2. 图案为「深色底 + 浅色内容」（白色 Z/盾线是内容，必须保留为不透明）；
//   3. 换图后必须跑 `npm test`——install-templates.test.js 锁四角 alpha、AND 掩码
//      对齐与行连续性三项属性。
//
// 用法：node tools/icon-alpha.cjs   # 原地重写 assets/icon.png（幂等：已有 alpha 的
//                                    # 像素会被重算，对白底源图结果稳定）

const fs = require('fs');
const path = require('path');
const icon = require('./companion/icon.cjs');

const FILE = path.resolve(__dirname, '..', 'assets', 'icon.png');
const DARK_THRESHOLD = 160;  // 暗像素判定：徽章底色 lum≈20，白底 255，切在 AA 渐变约 37% 处
const FEATHER = 2;           // 边界羽化半宽（像素）
const LUM_SPAN = 225;        // 羽化分母：255 - 徽章底色 lum（≈30），白→0 / 深底→1

function main() {
  const { width, height, rgba } = icon.decodePng(fs.readFileSync(FILE));
  const lum = (x, y) => {
    const i = (y * width + x) * 4;
    return 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
  };
  const firstDarkInRow = (y) => {
    for (let x = 0; x < width; x++) if (lum(x, y) < DARK_THRESHOLD) return x;
    return -1;
  };
  const lastDarkInRow = (y) => {
    for (let x = width - 1; x >= 0; x--) if (lum(x, y) < DARK_THRESHOLD) return x;
    return -1;
  };

  const out = Buffer.alloc(width * height * 4);
  rgba.copy(out);
  for (let y = 0; y < height; y++) {
    const lo = firstDarkInRow(y);
    const hi = lastDarkInRow(y);
    if (lo < 0) {
      // 全亮行：整行透明（徽章不应出现这种行；出现说明图不符合适用前提 1）
      for (let x = 0; x < width; x++) out[(y * width + x) * 4 + 3] = 0;
      continue;
    }
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      let a = 255;
      if (x < lo || x > hi) a = 0;
      else if (x <= lo + FEATHER || x >= hi - FEATHER) {
        a = Math.round(255 * Math.min(1, Math.max(0, (255 - lum(x, y)) / LUM_SPAN)));
      }
      out[i + 3] = a;
    }
  }

  fs.writeFileSync(FILE, icon.encodePng(width, out));

  // 自检：四角透明、中心不透明
  const rt = icon.decodePng(fs.readFileSync(FILE));
  const alphaAt = (x, y) => rt.rgba[(y * width + x) * 4 + 3];
  const corners = [alphaAt(0, 0), alphaAt(width - 1, 0), alphaAt(0, height - 1), alphaAt(width - 1, height - 1)];
  if (!corners.every((a) => a === 0) || alphaAt(width >> 1, height >> 1) !== 255) {
    console.error('[icon-alpha] 自检失败：', { corners, center: alphaAt(width >> 1, height >> 1) });
    process.exit(1);
  }
  console.log(`[icon-alpha] 已写入 ${FILE}（${width}×${height}，四角透明自检通过）`);
}

if (require.main === module) main();

module.exports = { DARK_THRESHOLD, FEATHER, LUM_SPAN };
