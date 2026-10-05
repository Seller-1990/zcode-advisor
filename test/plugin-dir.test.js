'use strict';

// plugins/zcode-advisor/ 与仓库根的一致性守卫。
//
// 为什么需要：ZCode 的本地市场要求 <市场根>/plugins/<插件名>/ 布局，
// 而插件本体在仓库根。两者是拷贝关系，**改了根目录却忘记同步**会导致
// 宿主安装出旧代码（实测踩过：no_transcript 修复未进入宿主 cache，
// 顾问现场仍是空转版本）。
//
// 这里把"一致性"变成测试断言：任何漂移都会在 npm test 阶段暴露。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SYNC = path.join(ROOT, 'tools', 'sync-plugin-dir.cjs');

test('plugins/zcode-advisor 与仓库根无漂移（否则宿主会装出旧代码）', () => {
  let out = '';
  let code = 0;
  try {
    out = execFileSync(process.execPath, [SYNC, '--check'], { encoding: 'utf8' });
  } catch (err) {
    code = err.status;
    out = String(err.stdout || '') + String(err.stderr || '');
  }
  assert.strictEqual(code, 0, `检测到插件目录漂移：\n${out}\n修复：node tools/sync-plugin-dir.cjs`);
});

test('plugins/zcode-advisor 含插件运行必需文件', () => {
  const dest = path.join(ROOT, 'plugins', 'zcode-advisor');
  for (const f of ['.zcode-plugin/plugin.json', 'hooks/hooks.json', 'hooks/advisor-hook.js', 'commands']) {
    assert.ok(fs.existsSync(path.join(dest, f)), `plugins/zcode-advisor/${f} 应存在`);
  }
});

test('同步脚本能发现「源已删除、副本残留」的幽灵文件（0.2.17 删除 advisor-api 的教训）', () => {
  // 回归：diffTree 原先只做单向比对（源→目标），源里删掉的文件在副本里永远不会被报出来，
  // 宿主按目录拷贝就会把旧命令文档一起装进去。这里用临时幽灵文件验证反向检查已生效。
  const dest = path.join(ROOT, 'plugins', 'zcode-advisor');
  const ghost = path.join(dest, 'commands', '__ghost-test__.md');
  const orphanDirs = () => fs.readdirSync(dest).filter((n) => n.startsWith('.orphan-'));
  const before = new Set(orphanDirs());
  const run = () => {
    try {
      execFileSync(process.execPath, [SYNC, '--check'], { encoding: 'utf8', stdio: 'pipe' });
      return 0;
    } catch (err) {
      return err.status;
    }
  };
  try {
    fs.writeFileSync(ghost, '# ghost\n', 'utf8');
    assert.notStrictEqual(run(), 0, '副本里的幽灵文件必须让 --check 失败');
    // 走同步：应把幽灵文件隔离到 .orphan-*（不是直接删）
    execFileSync(process.execPath, [SYNC], { encoding: 'utf8', stdio: 'pipe' });
    assert.ok(!fs.existsSync(ghost), '同步应把幽灵文件移出插件目录');
    assert.strictEqual(run(), 0, '隔离后应恢复无漂移');
  } finally {
    // 本次测试自己造的隔离目录不留痕：移到系统临时目录（等价回收站，不直接删）
    try { if (fs.existsSync(ghost)) fs.unlinkSync(ghost); } catch (_) {}
    const trash = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-orphan-'));
    for (const name of orphanDirs()) {
      if (before.has(name)) continue;
      try { fs.renameSync(path.join(dest, name), path.join(trash, name)); } catch (_) {}
    }
  }
});

test('同步脚本幂等：连续两次 --check 均无漂移', () => {
  const run = () => {
    try {
      execFileSync(process.execPath, [SYNC, '--check'], { encoding: 'utf8', stdio: 'pipe' });
      return 0;
    } catch (err) {
      return err.status;
    }
  };
  assert.strictEqual(run(), 0);
  assert.strictEqual(run(), 0);
});

test('同步清单覆盖 plugin.json 声明的全部组件（防再漏 tools/ 之类）', () => {
  const fs2 = require('fs');
  const path2 = require('path');
  const root = path2.join(__dirname, '..');
  const plugin = JSON.parse(fs2.readFileSync(path2.join(root, '.zcode-plugin', 'plugin.json'), 'utf8'));

  // 从 plugin.json 提取声明的目录/文件
  const declared = [];
  if (typeof plugin.commands === 'string') declared.push(plugin.commands.replace(/^\.\//, ''));
  if (typeof plugin.hooks === 'string') declared.push(plugin.hooks.replace(/^\.\//, ''));
  else if (fs2.existsSync(path2.join(root, 'hooks', 'hooks.json'))) declared.push('hooks');
  // mcpServers 的 args 里引用的路径必须存在（config-bridge 曾因此缺失）
  for (const srv of Object.values(plugin.mcpServers || {})) {
    for (const arg of srv.args || []) {
      const m = /\$\{CLAUDE_PLUGIN_ROOT\}\/(.+)$/.exec(arg);
      if (m) declared.push(m[1]);
    }
  }

  const dest = path2.join(root, 'plugins', 'zcode-advisor');
  const missing = declared.filter((rel) => !fs2.existsSync(path2.join(dest, rel)));
  assert.deepStrictEqual(missing, [],
    `副本目录缺少 plugin.json 声明的组件：${missing.join(', ')}（同步清单漏项会让插件功能失效）`);
});

test('同步脚本：目录内残留（walk 分支）被检出并隔离', () => {
  // 反向比对的基本情形：副本里多出一个源侧不存在的子项。
  const dest = path.join(ROOT, 'plugins', 'zcode-advisor');
  const run = () => {
    try {
      execFileSync(process.execPath, [SYNC, '--check'], { encoding: 'utf8', stdio: 'pipe' });
      return 0;
    } catch (err) {
      return err.status;
    }
  };
  const orphanDirs = () => fs.readdirSync(dest).filter((n) => n.startsWith('.orphan-'));
  const before = new Set(orphanDirs());
  const ghostSub = path.join(dest, 'commands', '__ghost-dir__');
  try {
    fs.mkdirSync(ghostSub, { recursive: true });
    fs.writeFileSync(path.join(ghostSub, 'x.md'), '# x\n', 'utf8');
    assert.notStrictEqual(run(), 0, '目录内残留必须让 --check 失败');
    execFileSync(process.execPath, [SYNC], { encoding: 'utf8', stdio: 'pipe' });
    assert.ok(!fs.existsSync(ghostSub), '同步应隔离该残留');
    assert.strictEqual(run(), 0, '隔离后应恢复无漂移');
  } finally {
    try { fs.rmSync(ghostSub, { recursive: true, force: true }); } catch (_) {}
    const trash = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-orphan2-'));
    for (const name of orphanDirs()) {
      if (before.has(name)) continue;
      try { fs.renameSync(path.join(dest, name), path.join(trash, name)); } catch (_) {}
    }
  }
});

test('同步脚本：源侧整个 ITEM 消失 → 副本里的整块残留被 --check 报出并被隔离（顶层分支）', (t) => {
  // 回归（OCR medium + advisor 复核）：cleanup/check 对「ITEMS 里某项在源侧已不存在」
  // 曾直接 continue，副本里的整块残留（如整个 commands/ 目录）永远不会被报出或隔离。
  // 必须在**独立 fixture 树**里造这个场景——在真实仓库临时移走 ITEMS 会污染并行的其他测试。
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-syncfx-'));
  const fxRoot = path.join(fx, 'src');
  const fxDest = path.join(fx, 'dest');
  t.after(() => { try { fs.rmSync(fx, { recursive: true, force: true }); } catch (_) {} });

  // 最小 fixture：源侧只有 commands/ 一个 ITEM，且它存在；副本侧除它之外还有整块残留
  fs.mkdirSync(path.join(fxRoot, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(fxRoot, 'commands', 'keep.md'), 'keep\n', 'utf8');
  fs.mkdirSync(path.join(fxDest, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(fxDest, 'commands', 'keep.md'), 'keep\n', 'utf8');
  // 残留：源侧不存在的整个 ITEM（模拟「commands 整个被删/改名」后副本没跟上）
  fs.mkdirSync(path.join(fxDest, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(fxDest, 'tools', 'stale.cjs'), 'stale\n', 'utf8');

  const env = Object.assign({}, process.env, {
    ZCODE_ADVISOR_SYNC_ROOT: fxRoot,
    ZCODE_ADVISOR_SYNC_DEST: fxDest
  });
  const run = (args) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [SYNC, ...args], { encoding: 'utf8', stdio: 'pipe', env }) };
    } catch (err) {
      return { code: err.status, out: String(err.stdout || '') + String(err.stderr || '') };
    }
  };

  // 前置：残留存在时 --check 必须失败（旧实现这里恒为 0 —— 顶层 continue 跳过了它）
  const before = run(['--check']);
  assert.notStrictEqual(before.code, 0, `源侧不存在的整项残留必须让 --check 失败：\n${before.out}`);

  // 同步后：残留被隔离出 DEST，且恢复无漂移
  const syncRes = run([]);
  assert.strictEqual(syncRes.code, 0, `同步应成功：\n${syncRes.out}`);
  assert.ok(!fs.existsSync(path.join(fxDest, 'tools')), '整块残留应被移出 DEST');
  const after = run(['--check']);
  assert.strictEqual(after.code, 0, `隔离后应无漂移：\n${after.out}`);

  // 隔离目录在 DEST 内、且残留内容确实在里面（等价回收站语义，不是直接删）
  const orphans = fs.readdirSync(fxDest).filter((n) => n.startsWith('.orphan-'));
  assert.strictEqual(orphans.length, 1, '应恰好产生一个隔离目录');
  const rescued = path.join(fxDest, orphans[0], 'tools', 'stale.cjs');
  assert.ok(fs.existsSync(rescued), '残留内容应可在隔离目录里回捞');
});

test('同步脚本：跳过 __pycache__（回归：CI 上 .pyc 曾造成伪漂移）', (t) => {
  // 回归：跑 tools/*.py 会生成 tools/__pycache__/*.pyc，它被 sync-plugin-dir 当成
  // "副本缺该文件"的漂移（CI 上实测踩到：本机 Python 3.9 不生成、CI 的 3.12 生成，
  // 本地因此复现不出）。修法是 4 处跳过（copy/diff 正反/隔离）。这里逐条验证。
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-pycache-'));
  const fxRoot = path.join(fx, 'src');
  const fxDest = path.join(fx, 'dest');
  t.after(() => { try { fs.rmSync(fx, { recursive: true, force: true }); } catch (_) {} });

  // 源侧：commands/ 一项 + 其下的 __pycache__（模拟跑过 Python）
  fs.mkdirSync(path.join(fxRoot, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(fxRoot, 'commands', 'keep.md'), 'keep\n', 'utf8');
  fs.mkdirSync(path.join(fxRoot, 'commands', '__pycache__'), { recursive: true });
  fs.writeFileSync(path.join(fxRoot, 'commands', '__pycache__', 'x.cpython-312.pyc'), 'bytecode', 'utf8');
  // 副本侧：与源一致（含 __pycache__），模拟"已经同步过"
  fs.mkdirSync(path.join(fxDest, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(fxDest, 'commands', 'keep.md'), 'keep\n', 'utf8');

  const env = Object.assign({}, process.env, {
    ZCODE_ADVISOR_SYNC_ROOT: fxRoot,
    ZCODE_ADVISOR_SYNC_DEST: fxDest
  });
  const run = (args) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [SYNC, ...args], { encoding: 'utf8', stdio: 'pipe', env }) };
    } catch (err) {
      return { code: err.status, out: String(err.stdout || '') + String(err.stderr || '') };
    }
  };

  // ① 副本缺少 __pycache__ 时，不得被判成漂移（这正是 CI 失败的原因）
  const checked = run(['--check']);
  assert.strictEqual(checked.code, 0, `源含 __pycache__ 而副本没有时不应报漂移：\n${checked.out}`);

  // ② 同步不得把 __pycache__ 拷进副本（它不属于插件 payload）
  const synced = run([]);
  assert.strictEqual(synced.code, 0, `同步应成功：\n${synced.out}`);
  assert.ok(!fs.existsSync(path.join(fxDest, 'commands', '__pycache__')),
    '__pycache__ 不得被同步进副本');
  assert.strictEqual(run(['--check']).code, 0, '同步后仍应无漂移');
});

test('同步脚本：副本里的 __pycache__ 不被当作"残留"隔离', (t) => {
  // 反向检查（副本有、源没有）也要跳过 __pycache__：否则每次同步都会把上一轮的
  // 字节码缓存"隔离"进 .orphan-*，越积越多且看着像有问题。
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-pycache2-'));
  const fxRoot = path.join(fx, 'src');
  const fxDest = path.join(fx, 'dest');
  t.after(() => { try { fs.rmSync(fx, { recursive: true, force: true }); } catch (_) {} });

  fs.mkdirSync(path.join(fxRoot, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(fxRoot, 'commands', 'keep.md'), 'keep\n', 'utf8');
  // 副本多出一个 __pycache__（源侧没有）
  fs.mkdirSync(path.join(fxDest, 'commands', '__pycache__'), { recursive: true });
  fs.writeFileSync(path.join(fxDest, 'commands', '__pycache__', 'y.pyc'), 'bc', 'utf8');
  fs.writeFileSync(path.join(fxDest, 'commands', 'keep.md'), 'keep\n', 'utf8');

  const env = Object.assign({}, process.env, {
    ZCODE_ADVISOR_SYNC_ROOT: fxRoot,
    ZCODE_ADVISOR_SYNC_DEST: fxDest
  });
  const out = execFileSync(process.execPath, [SYNC, '--check'], { encoding: 'utf8', stdio: 'pipe', env });
  assert.ok(true, out);
  // 副本里的 __pycache__ 不应算漂移，也不该被隔离
  execFileSync(process.execPath, [SYNC], { encoding: 'utf8', stdio: 'pipe', env });
  const orphans = fs.readdirSync(fxDest).filter((n) => n.startsWith('.orphan-'));
  assert.strictEqual(orphans.length, 0, '__pycache__ 不该被隔离进 .orphan-*');
});
