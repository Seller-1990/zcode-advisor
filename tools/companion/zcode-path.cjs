'use strict';

// ZCode 可执行文件探测（纯函数，依赖注入以便单测）。
//
// 背景：原实现只探测 Windows 路径（%LOCALAPPDATA%\Programs\ZCode\ZCode.exe、
// C:\Program Files\ZCode\ZCode.exe 等），在 macOS 上无候选可用 → 直接 process.exit(1)，
// 导致 README 宣称可用的 macOS 包实际无法启动。
//
// macOS 要点（实机验证）：
// - ZCode 安装为 /Applications/ZCode.app，内部可执行文件为 Contents/MacOS/ZCode，
//   名字由 Info.plist 的 CFBundleExecutable 决定（实测 3.14.4 为 "ZCode"）。
// - 直接 spawn 该内部可执行文件并传 --remote-debugging-port=<port> 是有效的：
//   本机 zcode+ 正是这样拉起的（renderer 命令行可见该参数、CDP 端口可达）。

const path = require('path');

const WIN_EXE = 'ZCode.exe';
const MAC_APP = 'ZCode.app';
const MAC_DEFAULT_EXECUTABLE = 'ZCode';

// 从 XML plist 取字符串值；解析失败返回 ''（不抛错——探测链要能继续走）。
function parsePlistString(xml, key) {
  if (typeof xml !== 'string' || !xml) return '';
  const re = new RegExp(`<key>\\s*${key}\\s*</key>\\s*<string>([^<]*)</string>`);
  const m = re.exec(xml);
  return m ? m[1].trim() : '';
}

// 是否形如 .app 包路径（忽略结尾斜杠）
function isAppBundle(p) {
  return /\.app\/?$/i.test(String(p || '').trim());
}

// 把候选路径解析成「可直接 spawn 的可执行文件路径」。
// - .app 包 → 读 Contents/Info.plist 的 CFBundleExecutable，拼出 Contents/MacOS/<exe>
// - 其他路径原样返回（可能是 .exe 或内部可执行文件）
// 返回 { path, source, ok } 形态由调用方补充；此函数只负责路径换算。
function resolveExecutablePath(candidate, deps) {
  const d = deps || {};
  const raw = String(candidate || '').trim();
  if (!raw) return '';
  if (!isAppBundle(raw)) return raw;

  const appDir = raw.replace(/\/+$/, '');
  const plistPath = path.join(appDir, 'Contents', 'Info.plist');
  let executable = MAC_DEFAULT_EXECUTABLE;
  try {
    const xml = d.readFileSync ? d.readFileSync(plistPath, 'utf8') : '';
    const fromPlist = parsePlistString(xml, 'CFBundleExecutable');
    if (fromPlist) executable = fromPlist;
  } catch (_) {
    // 读不到 plist 时退到约定名，避免整条探测链失败
  }
  return path.join(appDir, 'Contents', 'MacOS', executable);
}

// macOS 候选链（按可信度排序）。
function macCandidates(deps) {
  const d = deps || {};
  const home = d.homedir ? d.homedir() : '';
  const list = [];
  if (home) list.push(path.join(home, 'Applications', MAC_APP));
  list.push(path.join('/Applications', MAC_APP));
  return list;
}

// Windows 候选链（保持原有路径，顺序不变）。
function winCandidates(deps) {
  const d = deps || {};
  const env = d.env || {};
  const list = [];
  if (env.LOCALAPPDATA) list.push(path.join(env.LOCALAPPDATA, 'Programs', 'ZCode', WIN_EXE));
  if (env['ProgramFiles']) list.push(path.join(env['ProgramFiles'], 'ZCode', WIN_EXE));
  if (env['ProgramFiles(x86)']) list.push(path.join(env['ProgramFiles(x86)'], 'ZCode', WIN_EXE));
  if (env.ProgramW6432) list.push(path.join(env.ProgramW6432, 'ZCode', WIN_EXE));
  return list;
}

// 探测入口。
// 优先级：环境变量 > companion 配置 > 平台候选链 > Spotlight（macOS 兜底）。
//
// 降级纪律（重要）：显式配置无效时**继续尝试后续来源**，而不是立刻失败。
// 早期实现遇到无效 env 就直接 return，导致一个过期的环境变量会把可用的
// 配置文件/标准安装路径全部顶掉（Windows 侧属行为回归）。只有在**所有**来源
// 都落空时，才把第一个无效的显式配置作为诊断信息带回。
// 返回 { path, source, invalid? }；找不到时 path 为 ''。
function detectZcodePath(opts) {
  const o = opts || {};
  const deps = o.deps || {};
  const platform = o.platform || process.platform;
  const env = o.env || deps.env || {};
  const config = o.config || {};

  // 1) 显式配置（环境变量优先于配置文件）。无效则记录诊断并继续。
  let firstInvalid = null;
  const explicit = [
    ['env:ZCODE_ADVISOR_ZCODE_PATH', env.ZCODE_ADVISOR_ZCODE_PATH],
    ['config:zcodePath', config.zcodePath]
  ];
  for (const [source, value] of explicit) {
    if (!value) continue;
    const resolved = resolveExecutablePath(value, deps);
    if (resolved && isRunnableFile(deps, resolved)) return { path: resolved, source };
    if (!firstInvalid) firstInvalid = { value, resolved, source };
  }

  // 2) 平台候选链
  // 注意：候选链构造需要 env（Windows 依赖 ProgramFiles/LOCALAPPDATA 等），
  // 这里显式把调用方的 env 注入 deps，避免 deps.env 与 o.env 不一致时静默失效。
  const chainDeps = Object.assign({}, deps, { env });
  const candidates = platform === 'darwin'
    ? macCandidates(chainDeps).map((c) => [`自动探测:${c}`, c])
    : platform === 'win32'
      ? winCandidates(chainDeps).map((c) => [`自动探测:${c}`, c])
      : [];

  for (const [source, value] of candidates) {
    const resolved = resolveExecutablePath(value, deps);
    if (resolved && isRunnableFile(deps, resolved)) return { path: resolved, source };
  }

  // 3) macOS Spotlight 兜底（可选；失败不影响结果）
  if (platform === 'darwin' && typeof deps.mdfind === 'function') {
    const found = deps.mdfind();
    if (found) {
      const resolved = resolveExecutablePath(found, deps);
      if (resolved && isRunnableFile(deps, resolved)) return { path: resolved, source: 'spotlight' };
    }
  }

  const result = { path: '', source: '' };
  if (firstInvalid) result.invalid = firstInvalid;
  return result;
}

// 候选必须是**普通文件**（早期实现只做 existsSync，目录会被误判为可执行文件，
// 随后 spawn 一个目录必然失败）。有 statSync 时优先用它。
function isRunnableFile(deps, p) {
  try {
    if (typeof deps.statSync === 'function') return deps.statSync(p).isFile();
    return typeof deps.existsSync === 'function' && deps.existsSync(p);
  } catch (_) {
    return false;
  }
}

// 探测失败时按平台给出可操作的指引。
function missingHint(platform, configPath) {
  if (platform === 'darwin') {
    return `未找到 ZCode.app。请在 ${configPath} 中填写（可直接填 .app 包路径）：\n  { "zcodePath": "/Applications/ZCode.app" }`;
  }
  if (platform === 'win32') {
    return `未找到 ZCode.exe。请在 ${configPath} 中填写：\n  { "zcodePath": "C:/Users/<你>/AppData/Local/Programs/ZCode/ZCode.exe" }`;
  }
  return `未找到 ZCode。请在 ${configPath} 中填写 zcodePath 指向 ZCode 可执行文件。`;
}

module.exports = {
  parsePlistString,
  isAppBundle,
  resolveExecutablePath,
  macCandidates,
  winCandidates,
  detectZcodePath,
  missingHint
};
