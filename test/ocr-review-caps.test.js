'use strict';

// R18（冻结清单 P3 残留）：用例的**能力探测**必须读结构化声明，而不是实现细节字符串。
//
// 旧机制（改动前）：`SUPPORTS_RAW_OUT_HARDENED = /mv -f "\$_raw_tmp"/.test(源码)`、
// `/LOCK_ACQUIRED/`、`includes('run_with_deadline')` … 这些都是**实现细节**：把 `_raw_tmp`
// 改名成 `_raw_stage`（语义等价的重构），对应的十几条加固用例就静默变成 skip——
// 套件依旧全绿，覆盖却没了，而且没有任何信号。
//
// 现在 scripts/ocr-review.sh 顶部声明自己具备的能力：
//   # zca-caps: raw_out raw_out_hardened chain_file deadline total_budget usage_log lock_cleanup
// 本文件锁三件事：
//   ① 脚本必须带该声明行（缺行是失败，不是静默退回字符串匹配）；
//   ② 声明必须覆盖 test/ocr-review.test.js 里全部受门控的能力名（两边不许漂移）；
//   ③ 对实现细节做重命名后，声明内容不变（证明探测不再依赖字符串）。
//
// ZCA_OCR_CAPS_TARGET 用于把本文件指向修复前的快照取得红灯；不带该变量时校验仓库里的真实脚本。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SUITE = path.join(REPO_ROOT, 'test', 'ocr-review.test.js');
const TARGET = process.env.ZCA_OCR_CAPS_TARGET || path.join(REPO_ROOT, 'scripts', 'ocr-review.sh');

const CAPS_RE = /^\s*#\s*zca-caps:\s*(.+)$/m;
const parseCaps = (src) => {
  const m = CAPS_RE.exec(src);
  return m ? m[1].trim().split(/\s+/) : null;
};

// 脚本声明里必须有的能力名（与 ocr-review.test.js 的门控一一对应）。
const REQUIRED = [
  'raw_out',
  'raw_out_hardened',
  'chain_file',
  'deadline',
  'total_budget',
  'usage_log',
  'lock_cleanup'
];

test('R18：评测脚本必须声明结构化能力标记（# zca-caps:）', () => {
  const caps = parseCaps(fs.readFileSync(TARGET, 'utf8'));
  assert.ok(
    caps,
    `${path.relative(REPO_ROOT, TARGET)} 缺少 \`# zca-caps:\` 声明行——能力探测会退回按实现细节字符串匹配（改名即静默 skip）`
  );
  for (const name of REQUIRED) {
    assert.ok(caps.includes(name), `声明里缺少能力名 ${name}`);
  }
});

test('R18：声明必须覆盖 test/ocr-review.test.js 里全部受门控的能力名', () => {
  const caps = new Set(parseCaps(fs.readFileSync(TARGET, 'utf8')) || []);
  const gated = [...fs.readFileSync(SUITE, 'utf8').matchAll(/hasCap\(\s*'([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(gated.length >= REQUIRED.length, `测试文件里应能解析出全部受门控能力名，实际 ${gated.length} 个`);
  const missing = gated.filter((n) => !caps.has(n));
  assert.deepStrictEqual(missing, [], `能力声明与测试门控漂移，声明里缺少：${missing.join(', ')}`);
});

test('R18：实现细节改名后能力声明不变（旧的字面量探测会在此形态下误判）', () => {
  const src = fs.readFileSync(TARGET, 'utf8');
  const renamed = src.replace(/_raw_tmp/g, '_raw_stage').replace(/LOCK_ACQUIRED/g, 'LOCK_HELD');
  assert.notStrictEqual(renamed, src, '夹具必须真的改动了源码');
  assert.ok(!/mv -f "\$_raw_tmp"/.test(renamed), '夹具应已破坏旧探测依赖的字面量（raw_out_hardened）');
  assert.ok(!/LOCK_ACQUIRED/.test(renamed), '夹具应已拿掉旧探测依赖的变量名（lock_cleanup）');
  const caps = new Set(parseCaps(renamed) || []);
  for (const name of REQUIRED) {
    assert.ok(caps.has(name), `改名后能力声明不应丢失：${name}`);
  }
});
