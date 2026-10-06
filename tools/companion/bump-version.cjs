#!/usr/bin/env node
'use strict';

// 一处改版本号，四处同步。
//
// 为什么需要（真机故障）：插件版本号散落在四处——
//   package.json、.zcode-plugin/plugin.json、
//   plugins/zcode-advisor/package.json、plugins/zcode-advisor/.zcode-plugin/plugin.json
// 2cd7e42 手工改版本时只动了 plugins/ 镜像的两份，根目录两份留在旧值。结果是仓库里
// 同时存在两个版本号，宿主按镜像那份把「版本号 0.2.20、内容却是 pre-anthropic」的插件
// 装进 cache；此后 auto-enable 的版本比较永远判「已装 == 包内 → 就绪」，新代码再也进不去。
// 用户看到的现象就是「修了没生效」。
//
// 版本号是安装侧判断「要不要重装」的**唯一依据**，必须四处同源。手工改极易漏，故收进脚本。
// test/plugin-dir.test.js 有对应守卫：四处不一致时 npm test 直接失败。
//
// 用法：
//   node tools/companion/bump-version.cjs 0.2.21   # 指定版本
//   node tools/companion/bump-version.cjs patch    # 0.2.20 → 0.2.21
//   node tools/companion/bump-version.cjs minor    # 0.2.20 → 0.3.0
//   node tools/companion/bump-version.cjs major    # 0.2.20 → 1.0.0
//   node tools/companion/bump-version.cjs --check  # 只校验四处一致（CI/测试用）

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const CANON = path.join(ROOT, '.zcode-plugin', 'plugin.json');   // 构建期 VERSION 的唯一来源
const FILES = [
  '.zcode-plugin/plugin.json',
  'package.json',
  'plugins/zcode-advisor/package.json',
  'plugins/zcode-advisor/.zcode-plugin/plugin.json'
];

function readVersion(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')).version || '';
}

function check() {
  const vs = FILES.map((f) => ({ f, v: readVersion(f) }));
  const first = vs[0].v;
  const bad = vs.filter((x) => x.v !== first);
  if (bad.length === 0) {
    process.stdout.write(`[bump-version] 四处版本号一致：${first}\n`);
    return 0;
  }
  process.stderr.write('[bump-version] ✗ 四处版本号不一致：\n');
  for (const x of vs) process.stderr.write(`  ${x.v || '(缺失)'}  ${x.f}\n`);
  process.stderr.write('  修复：node tools/companion/bump-version.cjs <新版本>\n');
  return 1;
}

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function nextVersion(cur, kind) {
  const p = parseVersion(cur);
  if (!p) throw new Error(`当前版本号不可解析：${cur}`);
  if (kind === 'patch') return `${p[0]}.${p[1]}.${p[2] + 1}`;
  if (kind === 'minor') return `${p[0]}.${p[1] + 1}.0`;
  if (kind === 'major') return `${p[0] + 1}.0.0`;
  return null;
}

// 就地替换 version 字段，保留其余内容的格式（缩进/键序）与末尾换行。
// 不用 JSON.parse→stringify 往返：那会重排/重格式化整个文件，diff 噪音淹没真实改动。
function writeVersion(rel, version) {
  const p = path.join(ROOT, rel);
  const src = fs.readFileSync(p, 'utf8');
  // 只替换**第一处** "version"（这几份文件里 version 都在顶部且唯一）
  const out = src.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
  if (out === src && readVersion(rel) !== version) {
    throw new Error(`${rel} 中未找到可替换的 version 字段`);
  }
  fs.writeFileSync(p, out, 'utf8');
}

function main() {
  const arg = process.argv[2];
  if (!arg || arg === '--check') return check();

  const cur = readVersion(FILES[0]);
  const target = /^\d+\.\d+\.\d+$/.test(arg) ? arg : nextVersion(cur, arg);
  if (!target) {
    process.stderr.write(`[bump-version] ✗ 参数无效：${arg}（用 0.2.21 / patch / minor / major / --check）\n`);
    return 1;
  }
  if (!parseVersion(target)) {
    process.stderr.write(`[bump-version] ✗ 版本号格式应为 X.Y.Z：${target}\n`);
    return 1;
  }

  for (const f of FILES) writeVersion(f, target);
  const rc = check();
  if (rc !== 0) return rc;
  process.stdout.write(`[bump-version] ${cur} → ${target}（四处已同步）\n`);
  process.stdout.write('[bump-version] 下一步：node tools/sync-plugin-dir.cjs && npm test\n');
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { FILES, check, parseVersion, nextVersion };
