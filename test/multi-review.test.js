'use strict';

// tools/multi-review.py 的合成逻辑测试。
// 为什么需要：3 模型评审的价值全在"合并"这一步——并集保覆盖、共性加权筛噪声。
// 合并逻辑错了（比如把不同问题并成一条、或把同一条拆成三条），
// 用户看到的就是误导性结论，比单模型还糟。

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

// Windows 的 Python 安装通常只提供 python；不可把应用商店别名当成可用解释器。
const PYTHON = [process.env.PYTHON, 'python3', 'python'].filter(Boolean).find((candidate) => {
  const probe = spawnSync(candidate, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 7) else 1)'], {
    stdio: 'ignore', timeout: 5000,
  });
  return !probe.error && probe.status === 0;
});
if (!PYTHON) throw new Error('multi-review tests require Python 3 (set PYTHON to its executable)');

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
  // `-B`：禁止写 .pyc。exec_module 会为加载的模块生成 tools/__pycache__/*.pyc，
  // 而 tools/ 属于 sync-plugin-dir 的同步范围 —— 残留会被判成"副本缺该文件"的漂移
  //（CI 上实测踩到：本机 Python 3.9 不生成、CI 的 3.12 生成，本地因此复现不出）。
  // 同步器与 .gitignore 另加两道防线兜底。
  const out = execFileSync(PYTHON, ['-B', '-c', py], {
    input: JSON.stringify(results), encoding: 'utf8', timeout: 15000,
    env: Object.assign({}, process.env, { PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' }),
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

test('merge：相邻行（±3 内）的不同问题**不得**误并（回归：曾用 `near or similar`）', () => {
  // 密集改动区里相邻行常是不同问题。早期实现只要"行号邻近"就归并，
  // 会把两条无关意见并成一条并标成「两个模型都提到」→ 假高置信，比漏并更糟。
  const merged = runMerge([
    slot(1, 'p', 'm1', 'complete', [
      { path: 'x.js', start_line: 10, severity: 'high', content: 'sql injection via string concat' },
      { path: 'x.js', start_line: 12, severity: 'low', content: 'unused import of fs module' },
      { path: 'x.js', start_line: 11, severity: 'medium', content: 'missing rate limit on this endpoint' },
    ]),
  ]);
  assert.strictEqual(merged.length, 3, '同一文件相邻行的三个不同问题必须各自独立');
  for (const m of merged) {
    assert.strictEqual(m.confidence, 'single', '都不该被判为"多模型共同提到"');
  }
});

test('merge：同一问题、相邻行、措辞不同 → 仍应归并为高置信', () => {
  const merged = runMerge([
    slot(1, 'p', 'm1', 'complete', [
      { path: 'x.js', start_line: 10, severity: 'high', content: 'env override is not paired with the key' },
    ]),
    slot(3, 'p2', 'm2', 'complete', [
      { path: 'x.js', start_line: 12, severity: 'high', content: 'env override is not paired with the key' },
    ]),
  ]);
  assert.strictEqual(merged.length, 1, '内容相同应归并（不能因收紧规则而漏并）');
  assert.strictEqual(merged[0].confidence, 'high');
});

function runPython(body, input = {}) {
  const py = `
import json, importlib.util, sys, tempfile, os, subprocess, time
from unittest import mock
spec = importlib.util.spec_from_file_location('mr', ${JSON.stringify(SCRIPT)})
mr = importlib.util.module_from_spec(spec); spec.loader.exec_module(mr)
case = json.loads(sys.stdin.read())
${body}
`;
  return JSON.parse(execFileSync(PYTHON, ['-B', '-c', py], {
    input: JSON.stringify(input), encoding: 'utf8', timeout: 15000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' },
  }));
}

function runSlot(payload, exit = 0) {
  return runPython(`
with tempfile.TemporaryDirectory() as tmp:
    outfile = os.path.join(tmp, 'review.json')
    with open(outfile, 'w', encoding='utf8') as fh:
        json.dump(case['payload'], fh)
    with mock.patch.object(mr.subprocess, 'run', return_value=subprocess.CompletedProcess([], case['exit'], '', 'diagnostic')) as run:
        result = mr.run_one(1, 'mock-provider', 'mock-model', 'base', 'head', outfile)
    print(json.dumps({'result': result, 'timeout': run.call_args[1].get('timeout')}))
`, { payload, exit });
}

for (const payload of [null, [], [1], 'invalid', 7, true]) {
  test(`run_one：非对象 JSON ${JSON.stringify(payload)} 是失败而不是异常`, () => {
    const { result } = runSlot(payload);
    assert.strictEqual(result.coverage_ok, false);
    assert.deepStrictEqual(result.comments, []);
  });
}

for (const payload of [
  { status: 'complete' },
  { status: 'complete', comments: {} },
  { status: 'complete', comments: [null] },
  { status: 'complete', comments: [{ content: 17 }] },
  { status: 'complete', comments: [{ content: 'issue', start_line: '10' }] },
]) {
  test(`run_one：拒绝不能安全合并的输出 ${JSON.stringify(payload)}`, () => {
    const { result } = runSlot(payload);
    assert.strictEqual(result.coverage_ok, false);
    assert.deepStrictEqual(result.comments, []);
  });
}

test('run_one：非零退出码不能被 complete 输出伪装成成功', () => {
  const { result } = runSlot({ status: 'complete', comments: [] }, 7);
  assert.strictEqual(result.exit, 7);
  assert.strictEqual(result.coverage_ok, false);
});

test('run_one：有效 complete/partial 保留意见，外部调用有有限正数超时', () => {
  const comments = [{ path: 'x.js', start_line: 0, content: 'issue', severity: 'high' }];
  for (const status of ['complete', 'partial']) {
    const { result, timeout } = runSlot({ status, comments });
    assert.strictEqual(result.coverage_ok, status === 'complete');
    assert.deepStrictEqual(result.comments, comments);
    assert.ok(Number.isFinite(timeout) && timeout > 0, `missing finite timeout: ${timeout}`);
  }
});

test('run_one：本地挂起子进程按指定超时结束且返回结构化失败（无 OCR）', () => {
  const { result, elapsed } = runPython(`
real_run = subprocess.run
with tempfile.TemporaryDirectory() as tmp:
    outfile = os.path.join(tmp, 'review.json')
    def local_sleep(_cmd, **kwargs):
        return real_run([sys.executable, '-c', 'import time; time.sleep(30)'], **kwargs)
    start = time.monotonic()
    with mock.patch.object(mr.subprocess, 'run', side_effect=local_sleep):
        result = mr.run_one(1, 'mock', 'mock', 'base', 'head', outfile, timeout=0.1)
    print(json.dumps({'result': result, 'elapsed': time.monotonic() - start}))
`);
  assert.strictEqual(result.status, 'timeout');
  assert.strictEqual(result.coverage_ok, false);
  assert.strictEqual(result.exit, 124);
  assert.ok(elapsed < 5, `timeout did not bound execution: ${elapsed}s`);
});

test('run_one：命令无法启动时返回失败，不丢弃其它槽位', () => {
  const result = runPython(`
with mock.patch.object(mr.subprocess, 'run', side_effect=FileNotFoundError('mock missing executable')):
    result = mr.run_one(1, 'mock', 'mock', 'base', 'head', 'unused.json')
print(json.dumps(result))
`);
  assert.strictEqual(result.coverage_ok, false);
  assert.strictEqual(result.status, 'error');
  assert.match(result.stderr_tail, /mock missing executable/);
});
