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
