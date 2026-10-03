'use strict';

// auto-enable「不降级」判据的回归测试。
//
// 背景（真机故障）：.app 内嵌的是打包时的插件快照（0.2.9）。用户从仓库装了
// 更新版本（0.2.11）后，只要点一次旧 .app，旧实现就会 marketplace add(.app/plugin)
// → update → install，把 0.2.9 装回去；之后 payload 与已装都是 0.2.9，
// 走幂等快路径，**新版本被永久钉死**。用户看到的现象是「UI 还是旧版本」，
// 而 P0 修复等改动全部没生效。
//
// 修复后：已装版本 >= 包内版本 即视为就绪，绝不回装更低版本。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { cmpSemver, isReadyFromList } = require('../tools/companion/auto-enable.cjs');

// 模拟 `plugins list` 的输出片段（真实格式见 controller 的 alreadyEnabled）
const listOut = (ver, enabled = true) =>
  `- zcode-advisor@zcode-advisor-local [${enabled ? 'enabled' : 'disabled'}]\n` +
  `  cache/zcode-advisor-local: /Users/x/.zcode/cli/plugins/cache/zcode-advisor-local/zcode-advisor/${ver}\n`;

test('不降级：已装 0.2.11、包内 0.2.9 → 就绪（绝不用旧包覆盖新版本）', () => {
  // 这是真机故障的核心用例：旧 .app（内嵌 0.2.9）点一次就把用户装的 0.2.11 盖回去
  assert.strictEqual(isReadyFromList(listOut('0.2.11'), '0.2.9'), true,
    '已装版本更高时必须视为就绪，否则会被旧包降级覆盖');
});

test('升级：已装 0.2.9、包内 0.2.11 → 不就绪（需要重装新版本）', () => {
  assert.strictEqual(isReadyFromList(listOut('0.2.9'), '0.2.11'), false,
    '包内版本更高时必须重装，否则跑的还是旧代码');
});

test('同版本：已装 0.2.11、包内 0.2.11 → 就绪', () => {
  assert.strictEqual(isReadyFromList(listOut('0.2.11'), '0.2.11'), true);
});

test('未启用 → 一律不就绪（无论版本高低）', () => {
  assert.strictEqual(isReadyFromList(listOut('0.2.11', false), '0.2.9'), false);
  assert.strictEqual(isReadyFromList(listOut('0.2.11', false), '0.2.11'), false);
});

test('输出里没有 zcode-advisor → 不就绪', () => {
  assert.strictEqual(isReadyFromList('some other plugin\n', '0.2.11'), false);
});

test('cmpSemver：版本高低比较正确', () => {
  assert.strictEqual(cmpSemver('0.2.11', '0.2.9'), 1, '0.2.11 高于 0.2.9（按数字段比，非字典序）');
  assert.strictEqual(cmpSemver('0.2.9', '0.2.11'), -1);
  assert.strictEqual(cmpSemver('0.2.9', '0.2.9'), 0);
  assert.strictEqual(cmpSemver('0.2.10', '0.2.9'), 1);
  assert.strictEqual(cmpSemver('0.3.0', '0.2.99'), 1);
});

test('cmpSemver：不可解析时返回 0（保守，走原逻辑而非误判）', () => {
  assert.strictEqual(cmpSemver('garbage', '0.2.9'), 0);
  assert.strictEqual(cmpSemver('', '0.2.9'), 0);
  assert.strictEqual(cmpSemver(undefined, '0.2.9'), 0);
});

test('cmpSemver：字典序陷阱——0.2.9 vs 0.2.10 必须按数字段判定', () => {
  // 字符串比较会得出 "0.2.9" > "0.2.10"（因为 '9' > '1'），这是经典坑
  assert.strictEqual(cmpSemver('0.2.9', '0.2.10'), -1, '数字段比较：9 < 10');
  assert.ok('0.2.9' > '0.2.10', '（对照）字符串比较确实是反的，说明必须走 cmpSemver');
});
