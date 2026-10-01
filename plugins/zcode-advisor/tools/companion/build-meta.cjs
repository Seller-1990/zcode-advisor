'use strict';

// 构建元信息（单一来源）。
//
// 抽成独立模块的原因：
// 1. 版本号从 plugin.json 读取，避免多处硬编码漂移；
// 2. companion 运行时文件清单在此**由依赖闭包自动推导**，避免"打包清单"与
//    "实际 require 依赖"漂移——曾漏掉 zcode-path.cjs 导致发行包内 controller
//    require 失败、安装后直接崩溃，而构建期校验当时只检查了文件名是否存在。

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const PLUGIN_JSON = path.join(ROOT, '.zcode-plugin', 'plugin.json');

function readVersion() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(PLUGIN_JSON, 'utf8'));
  } catch (err) {
    throw new Error(`构建元信息读取失败：无法解析 ${PLUGIN_JSON}（${err.message}）`);
  }
  if (!raw || typeof raw.version !== 'string' || !raw.version.trim()) {
    throw new Error(`构建元信息读取失败：${PLUGIN_JSON} 缺少 version 字段`);
  }
  return raw.version.trim();
}

const COMPANION_DIR = __dirname;
// 入口：发行包内必须存在的运行时文件（inject.js 是 controller 运行时 readFileSync 读取的）
const ENTRY_FILES = ['controller.cjs', 'inject.js'];

// 扫描源文件里的相对 require 与 readFileSync(__dirname, '...')，推导运行时依赖闭包。
// 只跟随相对路径（'./x'），忽略内置模块与第三方包（本项目零依赖）。
function childDependencies(source) {
  const deps = new Set();
  // require('./x') / require("./x")
  const requireRe = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  let m;
  while ((m = requireRe.exec(source)) !== null) deps.add(m[1]);
  return deps;
}

// 解析相对 require 到实际文件名（补 .cjs/.js 后缀）。
function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, `${base}.cjs`, `${base}.js`];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch (_) { /* 不存在，试下一个 */ }
  }
  return null;
}

// 推导 companion 运行时文件闭包（返回相对于 companion 目录的文件名列表，已排序）。
// 入口文件的直接 require 链全部纳入；缺失的依赖直接抛错——构建期就暴露，不留到用户机上。
function companionRuntimeFiles() {
  const found = new Set();
  const queue = ENTRY_FILES.map((f) => path.join(COMPANION_DIR, f));

  while (queue.length > 0) {
    const file = queue.shift();
    const rel = path.relative(COMPANION_DIR, file);
    if (found.has(rel)) continue;
    found.add(rel);

    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch (err) {
      throw new Error(`companion 运行时文件缺失或不可读：${rel}（${err.message}）`);
    }
    for (const spec of childDependencies(source)) {
      const resolved = resolveRelative(file, spec);
      if (!resolved) {
        throw new Error(`${rel} 依赖的 ${spec} 不存在——发行包会缺少该文件`);
      }
      queue.push(resolved);
    }
  }

  // 只纳入 .cjs/.js 代码文件；inject.js 是页面脚本，由 controller 运行时读取，也算运行时文件。
  return [...found].filter((f) => /\.(cjs|js)$/.test(f)).sort();
}

const COMPANION_FILES = companionRuntimeFiles();

module.exports = {
  ROOT,
  VERSION: readVersion(),
  COMPANION_DIR,
  COMPANION_FILES,
  companionRuntimeFiles
};
