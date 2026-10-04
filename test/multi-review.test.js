'use strict';

// tools/multi-review.py 的合成逻辑测试。
// 为什么需要：3 模型评审的价值全在"合并"这一步——并集保覆盖、共性加权筛噪声。
// 合并逻辑错了（比如把不同问题并成一条、或把同一条拆成三条），
// 用户看到的就是误导性结论，比单模型还糟。

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'tools', 'multi-review.py');

// 直接用 python 跑脚本内部的 merge（避免引测试框架）
function runMerge(results) {
  const py = `
import json, importlib.util, sys
spec = importlib.util.spec_from_file_location('mr', ${JSON.stringify(SCRIPT)})
mr = importlib.util.module_from_spec(spec); spec.loader.exec_module(mr)
results = json.loads(sys.stdin.read())
print(json.dumps(mr.merge(results), ensure_ascii=False))
`;
  const out = execFileSync('python3', ['-c', py], {
    input: JSON.stringify(results), encoding: 'utf8',
  });
  return JSON.parse(out);
}

function slot(no, provider, model, status, comments) {
  return { slot: no, provider, model, status, coverage_ok: status === 'complete', comments };
}

test('merge：跨模型同一条目（行号邻近）合并为高置信，单方意见标 single', () => {
  const merged = runMerge([
    slot(1, 'nas-hy4', 'deepseek-v4.1-flash', 'complete', [
      { path: 'a.js', start_line: 10, severity: 'high', content: 'env override is not paired' },
      { path: 'b.js', start_line: 5, severity: 'low', content: 'dead code x' },
    ]),
    slot(2, 'nas-hy4', 'glm-5.3-flash', 'partial', [
      { path: 'a.js', start_line: 12, severity: 'high', content: 'env override not paired!' },
    ]),
    slot(3, 'nas-hy4', 'minimax-m3', 'complete', [
      { path: 'c.js', start_line: 1, severity: 'medium', content: 'unique finding here' },
    ]),
  ]);
  assert.strictEqual(merged.length, 3, '三个不同位置的条目不应被并成一条');
  const paired = merged.find((m) => m.path === 'a.js');
  assert.strictEqual(paired.confidence, 'high', '两个模型都提到 → 高置信');
  assert.strictEqual(paired.reported_by.length, 2);
  assert.strictEqual(merged.find((m) => m.path === 'b.js').confidence, 'single');
  assert.strictEqual(merged.find((m) => m.path === 'c.js').confidence, 'single');
});

test('merge：内容相似但行号相差较远 → 仍归并（同一问题被定位到不同行）', () => {
  const merged = runMerge([
    slot(1, 'p', 'm1', 'complete', [
      { path: 'x.js', start_line: 10, severity: 'medium', content: 'the legacy key cleanup runs after the early return guard' },
    ]),
    slot(3, 'p2', 'm2', 'complete', [
      { path: 'x.js', start_line: 90, severity: 'medium', content: 'legacy key cleanup runs after early return guard' },
    ]),
  ]);
  assert.strictEqual(merged.length, 1, '内容高度重合应归并');
  assert.strictEqual(merged[0].confidence, 'high');
});

test('merge：同名文件不同问题不误并', () => {
  const merged = runMerge([
    slot(1, 'p', 'm1', 'complete', [
      { path: 'x.js', start_line: 10, severity: 'high', content: 'sql injection via string concat' },
      { path: 'x.js', start_line: 80, severity: 'low', content: 'unused import of fs module' },
    ]),
  ]);
  assert.strictEqual(merged.length, 2, '两个不相关的问题必须分开');
});

test('merge：按严重度排序，high 优先于 low', () => {
  const merged = runMerge([
    slot(1, 'p', 'm1', 'complete', [
      { path: 'a.js', start_line: 1, severity: 'low', content: 'minor nit here' },
      { path: 'b.js', start_line: 1, severity: 'high', content: 'serious bug over there' },
    ]),
  ]);
  assert.strictEqual(merged[0].severity, 'high', '更严重的排前面');
});

test('merge：多模型报同一问题取更严重的等级', () => {
  const merged = runMerge([
    slot(1, 'p', 'm1', 'complete', [
      { path: 'a.js', start_line: 5, severity: 'low', content: 'missing null check on user input' },
    ]),
    slot(3, 'p2', 'm2', 'complete', [
      { path: 'a.js', start_line: 5, severity: 'high', content: 'missing null check on user input' },
    ]),
  ]);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].severity, 'high', '应升级到更严重的等级，不能降级掩盖');
});
