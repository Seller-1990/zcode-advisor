'use strict';

// R07：extractJsonObjects 的失配回退是「从 start+1 重新扫到结尾」，遇到大量不平衡
// 花括号（模型输出被截断的典型形态）就是二次复杂度：16K→285ms、32K→1.1s、48K→2.45s。
// 这条路径对每一段模型输出都会跑，而且是同步跑在 hook 里，长输出会把主流程拖住。
//
// 本文件锁两件事：
//   1) 病理输入的耗时上限（红→绿）；
//   2) 既有语义逐条不变（等价回归锁）——修复只许改复杂度，不许改结果。

const test = require('node:test');
const assert = require('node:assert');

const { extractJsonObjects } = require('../hooks/lib/reviewer.js');

const PERF_INPUT_CHARS = 48000;
const PERF_BUDGET_MS = 400;

test('extractJsonObjects：48K 不平衡花括号必须在 400ms 内返回（R07 二次复杂度）', () => {
  const s = '{'.repeat(PERF_INPUT_CHARS);
  const t0 = process.hrtime.bigint();
  const objs = extractJsonObjects(s);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.deepStrictEqual(objs, [], '整串不平衡时不应解析出任何对象');
  assert.ok(
    ms < PERF_BUDGET_MS,
    `解析 ${PERF_INPUT_CHARS} 个失衡花括号耗时 ${ms.toFixed(1)}ms，超过 ${PERF_BUDGET_MS}ms 上限（失配回退仍是 O(n²)）`
  );
});

// 语义等价锁：下列期望值取自修复前的实现（逐条实测），修复后必须逐条一致。
const CASES = [
  ['字符串内的花括号不进配对', JSON.stringify({ severity: 'nit', note: 'a{b}c' }), [{ severity: 'nit', note: 'a{b}c' }]],
  ['非法配平块被跳过后仍能找到合法帧', '前缀 {not json} 然后 {"severity":"blocker","note":"x"}', [{ severity: 'blocker', note: 'x' }]],
  ['多层嵌套包裹的合法对象取最内层', '{{{ "a":1 }}}', [{ a: 1 }]],
  ['相邻对象按出现顺序全部返回', '{"a":1}{"b":2}', [{ a: 1 }, { b: 2 }]],
  ['未闭合的尾对象被跳过', '{"a":1', []],
  ['空串返回空数组', '', []],
  ['null 返回空数组', null, []],
  ['非字符串（数字）返回空数组', 123, []],
  ['前面未闭合、后面完整：只取完整那个', '{"a":1}{"b":', [{ a: 1 }]],
  ['转义引号不影响配对', '{"severity":"nit","note":"say \\"hi\\" {ok}"}', [{ severity: 'nit', note: 'say "hi" {ok}' }]],
  [
    '数组里的多个对象全部返回',
    '[\n {"severity":"nit","note":"n1"},\n {"severity":"concern","note":"n2"}\n]',
    [{ severity: 'nit', note: 'n1' }, { severity: 'concern', note: 'n2' }],
  ],
  ['大量失衡前缀后仍能取到合法对象', '{'.repeat(2000) + '{"a":1}', [{ a: 1 }]],
  ['字符串里的未转义花括号不制造假配对', '{"note":"{{{","severity":"nit"}', [{ note: '{{{', severity: 'nit' }]],
];

for (const [name, input, expected] of CASES) {
  test(`extractJsonObjects 语义不变：${name}`, () => {
    assert.deepStrictEqual(extractJsonObjects(input), expected);
  });
}
