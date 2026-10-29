'use strict';

// 回归：reviewer.js 帧选择 / 宽松提取 / note 守门 / 探针 failed 计数。

const test = require('node:test');
const assert = require('node:assert');

const R = require('../hooks/lib/reviewer.js');
const { parseFrame, salvageProse, extractJsonObjects, callReviewer } = R;

function mockFetch(body) {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  return () => { globalThis.fetch = orig; };
}

const OPENAI_P = { baseUrl: 'http://127.0.0.1:9/v1', model: 'm', apiKey: 'k', systemPrompt: 'sp', userContent: 'uc', maxTokens: 100, temperature: 0, timeoutMs: 5000 };
const ANTH_P = { ...OPENAI_P, baseUrl: 'https://relay.example.com/v1', protocol: 'anthropic', model: 'claude-x', maxTokens: 4096 };

test('reasoning_content：none + 空 note 的合法帧被采用', async () => {
  const restore = mockFetch({
    choices: [{ message: { content: null, reasoning_content: '分析完毕。{"severity":"none","note":""}' }, finish_reason: 'stop' }],
    usage: {}
  });
  try {
    const r = await callReviewer(OPENAI_P);
    assert.ok(!r.error, `不应报错：${JSON.stringify(r)}`);
    assert.deepStrictEqual(parseFrame(r.text, false), { severity: 'none', note: '' });
  } finally { restore(); }
});

test('reasoning_content：回显的 schema 模板不被选中，取其前的真帧', async () => {
  const restore = mockFetch({
    choices: [{ message: { content: null, reasoning_content: '{"severity":"concern","note":"真问题"} 输出格式：{"severity":"none|nit|concern|blocker","note":"..."}' }, finish_reason: 'stop' }],
    usage: {}
  });
  try {
    const r = await callReviewer(OPENAI_P);
    assert.ok(!r.error, `不应报错：${JSON.stringify(r)}`);
    assert.deepStrictEqual(parseFrame(r.text, false), { severity: 'concern', note: '真问题' });
  } finally { restore(); }
});

test('thinking 块：none + 空 note 被采用、schema 模板被拒绝', async () => {
  const restore = mockFetch({
    content: [{ type: 'thinking', thinking: '{"severity":"nit","note":"早期"} 最终：{"severity":"none","note":""} 模板 {"severity":"none|nit|concern|blocker","note":"..."}' }],
    stop_reason: 'end_turn',
    usage: {}
  });
  try {
    const r = await callReviewer(ANTH_P);
    assert.ok(!r.error, `不应报错：${JSON.stringify(r)}`);
    assert.deepStrictEqual(parseFrame(r.text, false), { severity: 'none', note: '' });
  } finally { restore(); }
});

test('前文奇数个引号不吞掉后面的真帧（宽松回退）', () => {
  const text = 'He said "hi. Then {"severity":"concern","note":"bug"}';
  assert.deepStrictEqual(parseFrame(text, false), { severity: 'concern', note: 'bug' });
});

test('宽松回退取最后一个合法帧', () => {
  const text = 'x "y {"severity":"nit","note":"a"} {"severity":"blocker","note":"b"}';
  assert.deepStrictEqual(parseFrame(text, false), { severity: 'blocker', note: 'b' });
});

test('extractJsonObjects 语义锁不变：字符串内的切片仍返回 []', () => {
  assert.deepStrictEqual(extractJsonObjects('{bad "k":"x{ "a":1 }"'), []);
});

test('宽松回退有界：48K 失衡花括号 + 奇数引号仍快速返回', () => {
  const s = '"' + '{'.repeat(48000);
  const t0 = process.hrtime.bigint();
  assert.strictEqual(parseFrame(s, false), null);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 400, `耗时 ${ms.toFixed(1)}ms`);
});

test('散文守门：Please note: 不被当成 note 键', () => {
  const r = salvageProse('Please note: the loop index is off by one here.', 768);
  assert.ok(r && r.severity === 'nit');
});

test('散文守门：带引号的 note 键与裸 note: 仍拒绝', () => {
  assert.strictEqual(salvageProse('回复里带 note: 字样', 768), null);
  assert.strictEqual(salvageProse('the frame "note": something long', 768), null);
  assert.strictEqual(salvageProse('note: something long enough', 768), null);
});

test('probeModel：failed 按实际运行数计算（中途中止时不把未跑的算失败）', async () => {
  // 整批上限 1100ms：第 1 次跑完（~200ms）后剩余 <1000ms 触发 aborted，n=5 只跑 1 次。
  const stat = await R.probeModel(
    { baseUrl: 'http://x', model: 'm', apiKey: 'k' },
    { n: 5, batchTimeoutMs: 1100 },
    { callReviewer: async () => { await new Promise((r) => setTimeout(r, 200)); return { text: '{"severity":"nit","note":"ok"}' }; } }
  );
  assert.strictEqual(stat.aborted, true);
  assert.strictEqual(stat.ran, 1);
  assert.strictEqual(stat.passed, 1);
  assert.strictEqual(stat.failed, 0);
});
