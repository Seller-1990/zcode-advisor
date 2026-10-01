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
