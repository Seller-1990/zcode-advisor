'use strict';

// R06：usage（Token 计数）在失败 / 空响应重试 / 降级路径上漏计。
//
// 现状：reviewTurn 只把**最后一次**物理调用的 usage 返回给上层
//   - runAttempt 内空响应重试（最多 2 次）时，前几次被丢弃；
//   - 主模型失败改走备用模型时 `attempt = fbAttempt`，主模型那次**已消耗**的
//     usage 被整段丢掉；
//   - applyReviewOutcome 之前的 accumulateUsage 只累加最终这一笔。
// 冻结报告 R06 的表述：失败/空/重试场景下「10/20 应计 30/60 但实际未累加」，
// 建议统一累加。本文件把「每次物理调用的 usage 都要累加」钉成契约。
//
// 说明：这里用 reviewTurn 的可注入调用器（o.callReviewer），不打网络。

const test = require('node:test');
const assert = require('node:assert');

const { reviewTurn } = require('../hooks/advisor-hook.js');

const CFG = {
  reviewMode: 'async',
  reviewTimeoutMs: 60000,
  fallbackModel: 'fb-model',
  maxTokens: 2048,
  temperature: 0.2,
  systemPrompt: '',
  proseFallback: false,
  maxNoteChars: 200,
  providerId: 'p1',
};

const TARGET = {
  model: 'main-model',
  baseUrl: 'http://127.0.0.1:1/v1',
  apiKey: 'k',
  protocol: 'openai',
  providerId: 'p1',
  globalProviderId: 'p1',
};

const frameText = '{"severity":"nit","note":"ok"}';

test('R06：空响应重试时，每次物理调用的 usage 都要累加（10/20 + 20/40 = 30/60）', async () => {
  const seen = [];
  const callReviewer = async () => {
    seen.push(1);
    if (seen.length === 1) {
      return { error: 'llm_empty_response', text: '', usage: { promptTokens: 10, completionTokens: 20 } };
    }
    return { text: frameText, usage: { promptTokens: 20, completionTokens: 40 } };
  };
  const r = await reviewTurn(CFG, TARGET, '增量内容', false, { callReviewer });
  assert.strictEqual(seen.length, 2, '前置：应发生一次重试（两次物理调用）');
  assert.strictEqual(r.frame && r.frame.severity, 'nit', '前置：重试后解析成帧');
  assert.deepStrictEqual(r.usage, { promptTokens: 30, completionTokens: 60 },
    '重试中被丢弃的那一笔 usage 必须计入选（否则 Token 累计系统性偏低）');
});

test('R06：主模型失败切备用时，主模型已消耗的 usage 不得丢掉（10/20 + 20/40 = 30/60）', async () => {
  const models = [];
  const callReviewer = async (p) => {
    models.push(p.model);
    if (p.model === 'main-model') {
      return { error: 'llm_http_404', text: '', usage: { promptTokens: 10, completionTokens: 20 } };
    }
    return { text: frameText, usage: { promptTokens: 20, completionTokens: 40 } };
  };
  const r = await reviewTurn(CFG, TARGET, '增量内容', false, { callReviewer });
  assert.deepStrictEqual(models, ['main-model', 'fb-model'], '前置：主模型 404 → 切备用模型');
  assert.strictEqual(r.usedFallback, true, '前置：确实走了降级');
  assert.deepStrictEqual(r.usage, { promptTokens: 30, completionTokens: 60 },
    '降级后只保留备用模型的 usage 会让主模型那次真实消耗凭空消失');
});

test('R06：单次成功调用时 usage 原样透传（防止累加逻辑把单次调用算成双份）', async () => {
  const callReviewer = async () => ({ text: frameText, usage: { promptTokens: 11, completionTokens: 22 } });
  const r = await reviewTurn(CFG, TARGET, '增量内容', false, { callReviewer });
  assert.deepStrictEqual(r.usage, { promptTokens: 11, completionTokens: 22 });
});

test('R06：完全拿不到 usage 时保持 undefined（不凭空造 0/0，兼容旧行为）', async () => {
  const callReviewer = async () => ({ text: frameText });
  const r = await reviewTurn(CFG, TARGET, '增量内容', false, { callReviewer });
  assert.strictEqual(r.usage, undefined);
});

test('R06：拿到过 usage 且累加结果为 0 时返回 {0,0}，不得退回 undefined', async () => {
  // 顾问 nit：旧实现用「总和为 0」当「一次都没拿到」的判据，会把真实上报的 0/0 抹成 undefined；
  // 契约改为「是否见过 usage」这一显式标志。
  let n = 0;
  const callReviewer = async () => {
    n += 1;
    return n === 1
      ? { error: 'llm_empty_response', text: '', usage: { promptTokens: 0, completionTokens: 0 } }
      : { text: frameText, usage: { promptTokens: 0, completionTokens: 0 } };
  };
  const r = await reviewTurn(CFG, TARGET, '增量内容', false, { callReviewer });
  assert.deepStrictEqual(r.usage, { promptTokens: 0, completionTokens: 0 },
    '上报过 usage（哪怕全 0）就必须返回累加值，而不是 undefined');
});

test('R06：解析失败（unparsed）时接口给的 usage 仍要上报（回归锁）', async () => {
  // 关掉降级，确保只有一次物理调用（unparsed 本身不触发 runAttempt 内部重试：
  // 内部重试只针对 llm_empty_response）
  const noFb = Object.assign({}, CFG, { fallbackModel: '' });
  const callReviewer = async () => ({ text: '这不是 JSON', usage: { promptTokens: 7, completionTokens: 9 } });
  const r = await reviewTurn(noFb, TARGET, '增量内容', false, { callReviewer });
  assert.strictEqual(r.error, 'unparsed');
  assert.deepStrictEqual(r.usage, { promptTokens: 7, completionTokens: 9 });
});
