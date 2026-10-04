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

// ROOT/DEST 支持 env 覆盖：测试需要造一份「源侧整个 ITEM 消失」的完整 fixture 树
// 才能真正触发顶层分支（在真实仓库里临时移走 ITEMS 会污染并行的其他测试文件）。
// 与本仓库其他可覆盖项（ZCODE_ADVISOR_USER_CONFIG / _ZCODE_CONFIG）同一惯例。
const ROOT = process.env.ZCODE_ADVISOR_SYNC_ROOT
  ? path.resolve(process.env.ZCODE_ADVISOR_SYNC_ROOT)
  : path.resolve(__dirname, '..');
const DEST = process.env.ZCODE_ADVISOR_SYNC_DEST
  ? path.resolve(process.env.ZCODE_ADVISOR_SYNC_DEST)
  : path.join(ROOT, 'plugins', 'zcode-advisor');

// 插件运行必需的文件/目录。
// **必须与 .zcode-plugin/plugin.json 的声明一致**——尤其 tools/：
// plugin.json 的 mcpServers 声明 config-bridge 从 ${CLAUDE_PLUGIN_ROOT}/tools/config-bridge.js
// 启动，缺它会导致 MCP 启动失败、插件设置表单的配置桥接失效（实测踩过）。
const ITEMS = [
  '.zcode-plugin', 'hooks', 'commands', 'tools',
  'package.json', 'README.md', 'advisor.config.example.json'
];

// 递归比较两个目录，返回差异列表。
// 同时做**反向检查**（目标有、源没有 = 源里删过但副本残留）：只做单向比对会让
// 「源删了文件、副本还在」这种漂移永远查不出来，宿主装出的插件就带着幽灵文件
//（实测踩过：0.2.17 删掉 commands/advisor-api.md，副本里还留着旧命令文档）。
function diffTree(a, b, rel, out) {
  let st;
  try { st = fs.statSync(a); } catch (_) { out.push(`缺失: ${rel}`); return out; }
  if (st.isDirectory()) {
    const srcNames = fs.readdirSync(a);
    let destNames = [];
    try { destNames = fs.readdirSync(b); } catch (_) { /* 目标缺失：下面的 diffTree 会记 */ }
    for (const name of destNames) {
      if (!srcNames.includes(name)) out.push(`多余（源已删除）: ${path.join(rel, name)}`);
    }
    for (const name of srcNames) {
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
    const dest = path.join(DEST, item);
    // 整个 ITEM 在源里已不存在：副本里若还留着就是漂移（否则宿主会装出已被删除的整块内容）
    if (!fs.existsSync(src)) {
      if (fs.existsSync(dest)) diffs.push(`多余（源已删除）: ${item}`);
      continue;
    }
    diffTree(src, dest, item, diffs);
  }
  return diffs;
}

// 只复制**内容不同**的文件，内容相同则保留目标文件的 mtime。
//
// 为什么不用 fs.cpSync(force)：Windows 上 core.autocrlf=true 时，内容与索引完全一致、
// 只是被重新写过的文件会让 `git status` 伪报 " M"（w/lf 与检出预期不符），
// 表现为"同步后出现零内容差异的 modified"（审计报告 A5）。
// 跳过相同内容即可从根上消除这类噪音，同时让同步保持真正的幂等。
function copyIfChanged(src, dest) {
  let st;
  try { st = fs.statSync(src); } catch (_) { return; }
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) copyIfChanged(path.join(src, name), path.join(dest, name));
    return;
  }
  try {
    if (fs.readFileSync(dest).equals(fs.readFileSync(src))) {
      // 内容一致：不动数据，但修复权限漂移（如执行位丢失）。仅类 Unix（Windows mode 恒
      // 0o666/0o444 无意义，且 --check（diffTree）只比对内容，chmod 不会制造伪漂移）。
      if (process.platform !== 'win32') {
        try {
          const dm = fs.statSync(dest).mode & 0o777;
          const sm = st.mode & 0o777; // 掩掉文件类型位，直接传 chmodSync 会 EINVAL
          if (dm !== sm) fs.chmodSync(dest, sm);
        } catch (_) {}
      }
      return;
    }
  } catch (_) { /* 目标缺失/不可读：走复制分支 */ }
  // tmp + rename 原子替换：并发读者（宿主加载插件文件）不会读到半文件；
  // rename 撞上杀毒句柄 EPERM 时退避重试（hooks/lib/state.js saveState 同款），退出时清尸。
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.copyFileSync(src, tmp);
  try {
    for (let i = 0; ; i++) {
      try { fs.renameSync(tmp, dest); return; } catch (err) {
        if (i >= 2 || !err || (err.code !== 'EPERM' && err.code !== 'EACCES')) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30 * (i + 1));
      }
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

// 清理「源已删除、副本残留」的幽灵文件。
// 不直接删除：移入副本内的 .orphan-<时间戳>/ 隔离目录（等价回收站语义，误删可回捞），
// 该目录名以 . 开头且不参与 ITEMS 递归，不会被后续同步当成插件内容。
// 返回 { moved, failed }。宿主按目录拷贝，残留的旧命令文档/旧代码会被真的装进去——必须清。
// ⚠️ rename 失败**绝不静默吞掉**：早期实现 `try{rename}catch(_){}` 会让函数谎报"已隔离"，
// 幽灵文件其实还在 DEST 里、照样被宿主装出去（这正是本功能要防的事，反而被掩盖）。
// 失败项收集到 failed 里由调用方报出并以非零退出码结束（CI/测试能拦住）。
function quarantineOrphans() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bin = path.join(DEST, `.orphan-${stamp}`);
  let moved = 0;
  const failed = [];
  const retire = (from, relPath) => {
    const target = path.join(bin, relPath);
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // rename 在目标已存在（EEXIST/EPERM，Windows 常见）或跨卷时失败：
      // 先清掉残留目标再重试一次，仍失败则记录（而不是假装成功）。
      try { fs.rmSync(target, { recursive: true, force: true }); } catch (_) {}
      fs.renameSync(from, target);
      moved++;
      return true;
    } catch (err) {
      failed.push(`${relPath}（${(err && err.code) || err}）`);
      return false;
    }
  };
  const walk = (srcDir, destDir, rel) => {
    let srcNames = [];
    try { srcNames = fs.readdirSync(srcDir); } catch (_) { return; }
    let destNames = [];
    try { destNames = fs.readdirSync(destDir); } catch (_) { return; }
    for (const name of destNames) {
      if (name.startsWith('.orphan-')) continue;
      const destPath = path.join(destDir, name);
      const relPath = path.join(rel, name);
      if (!srcNames.includes(name)) {
        retire(destPath, relPath);
        continue;
      }
      // statSync 必须守卫：readdirSync 与 statSync 之间条目可能被并发删掉
      //（杀毒/索引器/用户手动操作），未守卫会抛错并让整轮隔离中止。
      let isDir = false;
      try { isDir = fs.statSync(destPath).isDirectory(); } catch (_) { continue; }
      if (isDir) walk(path.join(srcDir, name), destPath, relPath);
    }
  };
  for (const item of ITEMS) {
    const src = path.join(ROOT, item);
    const dest = path.join(DEST, item);
    // 整项在源里已不存在（如整个 commands/ 目录被移除）时，副本里的残留必须一并隔离——
    // 此前 `if (!fs.existsSync(src)) continue;` 直接跳过，残留会永远留在副本里被宿主装出去。
    if (!fs.existsSync(src)) {
      if (fs.existsSync(dest)) retire(dest, item);
      continue;
    }
    let srcIsDir = false;
    let destIsDir = false;
    try { srcIsDir = fs.statSync(src).isDirectory(); } catch (_) { continue; }
    try { destIsDir = fs.existsSync(dest) && fs.statSync(dest).isDirectory(); } catch (_) {}
    if (srcIsDir && destIsDir) walk(src, dest, item);
    else if (!srcIsDir && fs.existsSync(dest)) {
      // 单文件项：内容不同由 copyIfChanged 处理，这里只处理类型冲突（源是文件、目标是目录）
      try { if (fs.statSync(dest).isDirectory()) retire(dest, item); } catch (_) {}
    }
  }
  if (moved === 0 && failed.length === 0) { try { fs.rmdirSync(bin); } catch (_) {} }
  return { moved, failed };
}

function sync() {
  fs.mkdirSync(DEST, { recursive: true });
  for (const item of ITEMS) {
    const src = path.join(ROOT, item);
    if (!fs.existsSync(src)) continue;
    copyIfChanged(src, path.join(DEST, item));
  }
  const { moved, failed } = quarantineOrphans();
  if (moved > 0) {
    process.stdout.write(`[sync-plugin] 隔离 ${moved} 个源已删除的残留文件（副本内 .orphan-* 目录）\n`);
  }
  if (failed.length > 0) {
    // 隔离失败 = 幽灵文件仍在副本里、会被宿主装出去。必须报错且非零退出，
    // 不能只写一行提示（否则 CI/测试看不见、用户也以为干净了）。
    process.stderr.write(`[sync-plugin] ✗ ${failed.length} 个残留文件隔离失败（仍留在副本目录，会被宿主装出）：\n`);
    for (const f of failed) process.stderr.write(`  - ${f}\n`);
    process.stderr.write('  请手动移走这些文件（如权限/占用问题），再重跑同步\n');
    return 1;
  }
  return 0;
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
  const rc = sync();
  if (rc !== 0) return rc;
  process.stdout.write('[sync-plugin] 已同步 plugins/zcode-advisor/\n');
  return 0;
}

process.exitCode = main();
