'use strict';

// 模型能力探针（M3）行为测试。
//
// 本模块的核心裁决是「做探针，不做持久『可用』标记」——因为可用性是概率属性。
// 因此测试守住两件事：
//   1. 判据必须真的能抓出「烧预算故障」——旧 ping（max_tokens=1，把空响应判 OK）
//      正是本次故障的误报源，探针不能重蹈；
//   2. 输出必须是分布与通过率，**不得出现「可用/不可用」判决**。

const test = require('node:test');
const assert = require('node:assert');
const R = require('../hooks/lib/reviewer');

// ---------------- provenance：区分真帧与散文救回 ----------------
// 探针判据 6 依赖它：salvageProse 一律返回 nit，永远产不出 concern/blocker，
// 只看 parseFrame 非空会把「模型只会说散文」误判为可用。

test('parseFrameDetailed：来源标注正确（direct/embedded/prose）', () => {
  assert.strictEqual(R.parseFrameDetailed('{"severity":"nit","note":"a"}', false).from, 'json-direct');
  assert.strictEqual(
    R.parseFrameDetailed('分析如下：{"severity":"concern","note":"x"}', false).from, 'json-embedded');
  const prose = R.parseFrameDetailed('这段没有 JSON 帧，但显然是一条够长的建议文本。', true);
  assert.strictEqual(prose.from, 'prose');
  assert.strictEqual(prose.frame.severity, 'nit', '散文救回一律 nit（隐性降级）');
  // 关掉救回时，散文不产帧
  assert.strictEqual(R.parseFrameDetailed('这段没有 JSON 帧，但显然是一条够长的建议文本。', false).frame, null);
});

test('parseFrame：行为与改造前一致（provenance 改造无回归）', () => {
  assert.deepStrictEqual(R.parseFrame('{"severity":"nit","note":"a"}', false), { severity: 'nit', note: 'a' });
  assert.deepStrictEqual(R.parseFrame('{"severity":"none","note":""}', false), { severity: 'none', note: '' });
  assert.strictEqual(R.parseFrame('{"severity":"huge","note":"x"}', false), null);
  assert.deepStrictEqual(R.parseFrame('这条回复没有引用任何 JSON 帧。', true),
    { severity: 'nit', note: '这条回复没有引用任何 JSON 帧。' });
});

test('parseFrameDetailed：截断标记（note 超上限 → truncated=true）', () => {
  const long = 'x'.repeat(200);
  const d = R.parseFrameDetailed(`{"severity":"nit","note":"${long}"}`, false, { maxNoteChars: 100 });
  assert.strictEqual(d.truncated, true, 'note 被截断应标记');
  const ok = R.parseFrameDetailed('{"severity":"nit","note":"短"}', false, { maxNoteChars: 100 });
  assert.strictEqual(ok.truncated, false);
});

// ---------------- 判据分类（classifyProbeResult） ----------------

const PC = { maxTokens: 4096, maxNoteChars: 768, proseFallback: true };

test('classify：合法 JSON 帧 → 通过', () => {
  assert.deepStrictEqual(
    R.classifyProbeResult({ text: '{"severity":"concern","note":"这里有问题"}' }, PC),
    { ok: true, reason: '' });
  // none 也合法（模型判定无问题，是正确输出而非失败）
  assert.strictEqual(R.classifyProbeResult({ text: '{"severity":"none","note":""}' }, PC).ok, true);
});

test('classify：空响应 → 失败（old ping 在这里误报 OK，探针必须判失败）', () => {
  // 这正是本次故障：思考型模型把 max_tokens 全烧在 reasoning 上。
  const r = R.classifyProbeResult({ error: 'llm_empty_response' }, PC);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'llm_empty_response');
});

test('classify：散文救回 → 失败 reason=prose_only（隐性降级，不算可用）', () => {
  const r = R.classifyProbeResult({ text: '我注意到这里的循环每次都在重复编译正则表达式，建议提到循环外。' }, PC);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'prose_only');
});

test('classify：HTTP 错误 → 失败并按码分类', () => {
  for (const code of ['llm_http_401', 'llm_http_404', 'llm_timeout', 'llm_error']) {
    const r = R.classifyProbeResult({ error: code }, PC);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, code);
  }
});

test('classify：note 被截断 → 失败 reason=note_truncated（失控信号）', () => {
  const long = 'x'.repeat(2000);
  const r = R.classifyProbeResult({ text: `{"severity":"nit","note":"${long}"}` }, { maxNoteChars: 100, proseFallback: true });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'note_truncated');
});

test('classify：非法/半截 JSON → unparsed（不注入会话）', () => {
  const r = R.classifyProbeResult({ text: '{"severity":' }, PC);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'unparsed');
});

// ---------------- 分布统计（probeModel） ----------------

// 注入 callReviewer 桩，不触网。
function stubReviewer(seq) {
  let i = 0;
  return async () => {
    const v = seq[Math.min(i, seq.length - 1)];
    i++;
    return typeof v === 'function' ? v() : v;
  };
}

test('probeModel：N 次采样、统计通过数与耗时分布', async () => {
  const stat = await R.probeModel(
    { baseUrl: 'http://x', model: 'm', apiKey: 'k' },
    { n: 4 },
    { callReviewer: stubReviewer([
      { text: '{"severity":"none","note":""}' },
      { text: '{"severity":"nit","note":"a"}' },
      { error: 'llm_empty_response' },
      { text: '{"severity":"concern","note":"b"}' }
    ]) }
  );
  assert.strictEqual(stat.n, 4);
  assert.strictEqual(stat.passed, 3);
  assert.strictEqual(stat.failed, 1);
  assert.strictEqual(stat.passRate, 0.75);
  assert.deepStrictEqual(stat.failures, { llm_empty_response: 1 });
  assert.ok(stat.ms.median >= stat.ms.min, 'median 应 ≥ min');
  assert.ok(stat.ms.max >= stat.ms.p90, 'max 应 ≥ p90');
});

test('probeModel：桩抛异常也计入失败，不中断采样', async () => {
  const stat = await R.probeModel(
    { baseUrl: 'http://x', model: 'm', apiKey: 'k' },
    { n: 3 },
    { callReviewer: stubReviewer([() => { throw new Error('ECONNREFUSED'); }]) }
  );
  assert.strictEqual(stat.passed, 0);
  assert.strictEqual(stat.failed, 3);
  assert.strictEqual(stat.failures.llm_error, 3);
});

test('probeModel：默认 N=5；使用生产参数而非 max_tokens=1', async () => {
  let seen = null;
  await R.probeModel({ baseUrl: 'http://x', model: 'm', apiKey: 'k' }, {}, {
    callReviewer: async (p) => { seen = p; return { text: '{"severity":"none","note":""}' }; }
  });
  // 默认 N=5：桩调用 5 次（这里只断言参数，次数由上一用例覆盖）
  assert.ok(seen.maxTokens > 1, '必须用生产 maxTokens，绝不能用 1（旧 ping 的误报源）');
  assert.strictEqual(seen.maxTokens, R.PROBE_DEFAULTS.maxTokens);
  assert.ok(String(seen.systemPrompt).includes('advisor'), '应使用生产系统提示');
  assert.ok(seen.userContent.includes('对话增量'), '应使用代表性 delta 而非 "ping"');
});

test('probeModel：N 次调用次数正确（默认 5）', async () => {
  let calls = 0;
  await R.probeModel({ baseUrl: 'http://x', model: 'm', apiKey: 'k' }, {}, {
    callReviewer: async () => { calls++; return { text: '{"severity":"none","note":""}' }; }
  });
  assert.strictEqual(calls, 5);
});

// ---------------- 输出纪律：绝不输出「可用」判决 ----------------

test('renderProbeReport：输出分布与通过率，且**不含**「可用/不可用」判决', async () => {
  const stat = await R.probeModel(
    { baseUrl: 'http://x', model: 'glm-x', apiKey: 'k' },
    { n: 5 },
    { callReviewer: stubReviewer([{ text: '{"severity":"none","note":""}' }]) }
  );
  const out = R.renderProbeReport(stat);
  assert.ok(out.includes('5/5'), '应含通过数/N');
  assert.ok(out.includes('median') && out.includes('p90'), '应含耗时分布');
  assert.ok(/不是「可用\/不可用」判决/.test(out), '必须声明这不是可用性判决');
  // 负面断言：不能出现正面判决词
  assert.ok(!/模型可用|判定可用|可以放心使用|推荐使用/.test(out), '不得输出可用性判决');
});

test('renderProbeReport：上界随 N 变化（不能写死 N=5）', async () => {
  const mk = async (n) => R.probeModel({ baseUrl: 'http://x', model: 'm', apiKey: 'k' }, { n }, {
    callReviewer: stubReviewer([{ text: '{"severity":"none","note":""}' }])
  });
  const outN5 = R.renderProbeReport(await mk(5));
  const outN15 = R.renderProbeReport(await mk(15));
  assert.match(outN5, /约 45%/, 'N=5 全过时上界约 45%');
  assert.match(outN15, /约 18%/, 'N=15 全过时上界约 18%');
});
