'use strict';

// R09：Windows 路径分隔符下的「已装版本 / 已装目录」解析。
//
// 背景：`plugins list` 的输出里，插件 cache 路径在 Windows 上是反斜杠形态
// （`cache\zcode-advisor-local: C:\Users\x\.zcode\cli\plugins\cache\…\zcode-advisor\0.2.20`），
// 而 isReadyFromList / parseInstallPath 只在正斜杠上取版本与目录：
//   - isReadyFromList：/zcode-advisor\/(\d+\.\d+\.\d+)/ 与 out.includes('zcode-advisor/'+ver)
//     双双不匹配 → 每个受管平台都为 false → **每次启动都重装插件**，
//     并且「不降级」与「同版本内容漂移」两条判据在 Windows 上永不生效；
//   - parseInstallPath：/cache\/…/ 不匹配 → 已装目录为空 → 内容指纹漂移检测静默失效。
//
// 证据边界（必须如实标注）：本文件的输入是**合成的 Windows 输出**，
// 在 macOS 上跑，属于**模拟验证**，不等于 Windows 真机验证。
// 真机验证缺口见冻结报告「审计限制」一节（CI 三平台矩阵尚未真跑）。

const test = require('node:test');
const assert = require('node:assert');

const { isReadyFromList, parseInstallPath } = require('../tools/companion/auto-enable.cjs');

const WIN_DIR = 'C:\\Users\\x\\.zcode\\cli\\plugins\\cache\\zcode-advisor-local\\zcode-advisor\\0.2.20';

// Windows 形态的 `plugins list` 片段（含相邻插件，防止越界取错）
const winOut = (ver, enabled = true) =>
  '- other-plugin@x [enabled]\r\n' +
  '  cache\\x: C:\\Users\\x\\.zcode\\cli\\plugins\\cache\\x\\other\\1.0.0\r\n' +
  `- zcode-advisor@zcode-advisor-local [${enabled ? 'enabled' : 'disabled'}]\r\n` +
  `  cache\\zcode-advisor-local: C:\\Users\\x\\.zcode\\cli\\plugins\\cache\\zcode-advisor-local\\zcode-advisor\\${ver}\r\n` +
  '  skills: 0, commands: 1, hooks: 3\r\n';

test('parseInstallPath：Windows 反斜杠输出也要取出 zcode-advisor 的 cache 目录（R09）', () => {
  assert.strictEqual(parseInstallPath(winOut('0.2.20')), WIN_DIR,
    '反斜杠形态解析不出目录 → 内容指纹漂移检测在 Windows 上静默失效');
});

test('isReadyFromList：Windows 反斜杠 · 同版本应判就绪（否则每次启动都重装，R09）', () => {
  assert.strictEqual(isReadyFromList(winOut('0.2.20'), '0.2.20'), true,
    '已装版本解析不出 → 幂等快路径失效，每次启动都重装插件');
});

test('isReadyFromList：Windows 反斜杠 · 已装更高应判就绪（不降级，R09）', () => {
  assert.strictEqual(isReadyFromList(winOut('0.2.20'), '0.2.11'), true,
    '不降级判据在 Windows 上必须同样生效，否则旧包会覆盖用户新装的版本');
});

test('isReadyFromList：Windows 反斜杠 · 包内更高必须判不就绪（防止修复过宽）', () => {
  assert.strictEqual(isReadyFromList(winOut('0.2.20'), '0.2.30'), false,
    '包内版本更高时必须重装，不能因为兼容反斜杠就把所有情况都判成就绪');
});

test('isReadyFromList：Windows 反斜杠 · 未启用一律不就绪', () => {
  assert.strictEqual(isReadyFromList(winOut('0.2.20', false), '0.2.20'), false);
});
