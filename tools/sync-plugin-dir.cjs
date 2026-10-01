#!/usr/bin/env node
'use strict';

// 把插件 payload 从仓库根同步到 plugins/zcode-advisor/（宿主市场布局要求的子目录）。
//
// 为什么需要：ZCode 的本地市场布局是 <市场根>/plugins/<插件名>/.zcode-plugin/plugin.json
// （见官方 plugin-creator 的 dev 布局示例）。而本仓库的插件本体在根目录
// （hooks/ commands/ .zcode-plugin/），宿主安装时从 plugins/<名字>/ 读取——
// 两者若不同步，**修了根目录却安装出旧代码**（实测踩过：快照修复未进入宿主 cache）。
//
// 不用符号链接：市场根包含 plugins/，而 plugins/zcode-advisor → 根 会形成循环，
// 宿主递归拷贝时会无限展开。
//
// 用法：
//   node tools/sync-plugin-dir.cjs          # 同步
//   node tools/sync-plugin-dir.cjs --check  # 只检查是否漂移（CI/测试用），漂移则退出码 1

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEST = path.join(ROOT, 'plugins', 'zcode-advisor');

// 插件运行必需的文件/目录（与 .zcode-plugin/plugin.json 声明的一致）
const ITEMS = ['.zcode-plugin', 'hooks', 'commands', 'package.json', 'README.md'];

// 递归比较两个目录，返回差异列表
function diffTree(a, b, rel, out) {
  let st;
  try { st = fs.statSync(a); } catch (_) { out.push(`缺失: ${rel}`); return out; }
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(a)) {
      diffTree(path.join(a, name), path.join(b, name), path.join(rel, name), out);
    }
    return out;
  }
  let other;
  try { other = fs.readFileSync(b); } catch (_) { out.push(`缺失: ${rel}`); return out; }
  if (!fs.readFileSync(a).equals(other)) out.push(`内容不同: ${rel}`);
  return out;
}

function check() {
  const diffs = [];
  for (const item of ITEMS) {
    const src = path.join(ROOT, item);
    if (!fs.existsSync(src)) continue;
    diffTree(src, path.join(DEST, item), item, diffs);
  }
  return diffs;
}

function sync() {
  fs.mkdirSync(DEST, { recursive: true });
  for (const item of ITEMS) {
    const src = path.join(ROOT, item);
    if (!fs.existsSync(src)) continue;
    fs.cpSync(src, path.join(DEST, item), { recursive: true, force: true });
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--check')) {
    const diffs = check();
    if (diffs.length === 0) {
      process.stdout.write('[sync-plugin] 无漂移\n');
      return 0;
    }
    process.stderr.write(`[sync-plugin] 检测到 ${diffs.length} 处漂移：\n`);
    for (const d of diffs.slice(0, 20)) process.stderr.write(`  - ${d}\n`);
    process.stderr.write('  运行 node tools/sync-plugin-dir.cjs 修复\n');
    return 1;
  }
  sync();
  process.stdout.write('[sync-plugin] 已同步 plugins/zcode-advisor/\n');
  return 0;
}

process.exitCode = main();
