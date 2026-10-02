'use strict';

// logReview / reviewBudgetMs / reviewTurn 的回归测试（审计第三轮：补「改了但没锁住」清单）。
// advisor-hook.js 现在带 require.main 守卫并导出内部函数，可在进程内直接驱动真实路径。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hook = require('../hooks/advisor-hook.js');

function baseCfg(overrides) {
  return Object.assign({
    baseUrl: 'http://127.0.0.1:9/v1',
    model: 'test-model',
    maxTokens: 100,
    temperature: 0,
    reviewTimeoutMs: 60000,
    reviewMode: 'async',
    proseFallback: false,
    maxNoteChars: 200
  }, overrides);
}

// 环境变量保存/恢复：node --test 同文件内用例串行，串场污染会互相打爆
function withEnv(name, value, fn) {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  return Promise.resolve().then(fn).finally(() => {
    if (prev === undefined) delete process.env[name]; else process.env[name] = prev;
  });
}

test('reviewBudgetMs：sync 用（被钳制后的）timeout，async 放宽到 2×', () => {
  assert.strictEqual(hook.reviewBudgetMs({ reviewMode: 'sync', reviewTimeoutMs: 60000 }), 60000);
  assert.strictEqual(hook.reviewBudgetMs({ reviewMode: 'async', reviewTimeoutMs: 60000 }), 120000);
});

test('logReview：DEBUG=1 时 reviewTurn 落盘一行 JSONL（kind/severity/model/ms/requestId）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zca-log-'));
  return withEnv('ZCODE_ADVISOR_STATE_DIR', dir, () => withEnv('ZCODE_ADVISOR_DEBUG', '1', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: '{"severity":"concern","note":"n"}' } }] })
    });
    try {
      const r = await hook.reviewTurn(baseCfg(), { baseUrl: baseCfg().baseUrl, model: 'test-model', apiKey: 'k', key: 'k', source: 'test' }, '内容', false);
      assert.ok(r.frame, '应产出帧');
      const logPath = path.join(dir, 'review.log');
      assert.ok(fs.existsSync(logPath), '应落盘 review.log');
      const line = JSON.parse(fs.readFileSync(logPath, 'utf8').trim());
      assert.strictEqual(line.kind, 'frame');
      assert.strictEqual(line.severity, 'concern');
      assert.strictEqual(line.model, 'test-model');
      assert.strictEqual(typeof line.ms, 'number');
      assert.strictEqual(typeof line.requestId, 'string');
      assert.ok(line.ts, '应带时间戳');
    } finally {
      globalThis.fetch = origFetch;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }));
});

test('logReview：未开 DEBUG 时零落盘（默认零常驻 IO）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zca-log-'));
  return withEnv('ZCODE_ADVISOR_STATE_DIR', dir, () => withEnv('ZCODE_ADVISOR_DEBUG', undefined, async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: '{"severity":"none","note":""}' } }] })
    });
    try {
      const r = await hook.reviewTurn(baseCfg(), { baseUrl: baseCfg().baseUrl, model: 'test-model', apiKey: 'k', key: 'k', source: 'test' }, '内容', false);
      assert.ok(r.frame);
      assert.ok(!fs.existsSync(path.join(dir, 'review.log')), '不应产生 review.log');
    } finally {
      globalThis.fetch = origFetch;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }));
});

test('async 预算集成：挂起的 fetch 在 ≈2×timeout（而非 timeout）处被中止', async () => {
  const origFetch = globalThis.fetch;
  // 挂起到被 AbortSignal 中止（与真实 fetch 一致：不监听 signal 的桩会让用例永不结束）
  globalThis.fetch = (url, opt) => new Promise((resolve, reject) => {
    const s = opt && opt.signal;
    if (s) s.addEventListener('abort', () => {
      const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
    }, { once: true });
  });
  try {
    const t0 = Date.now();
    const r = await hook.reviewTurn(baseCfg({ reviewTimeoutMs: 600 }), { baseUrl: baseCfg({ reviewTimeoutMs: 600 }).baseUrl, model: 'test-model', apiKey: 'k', key: 'k', source: 'test' }, '内容', false);
    const elapsed = Date.now() - t0;
    assert.strictEqual(r.error, 'llm_timeout');
    assert.ok(elapsed >= 1050 && elapsed <= 2600,
      `async 预算应为 2×600=1200ms，实际 ${elapsed}ms`);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('sync 预算集成：挂起的 fetch 在 ≈timeout 处被中止（不翻倍）', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (url, opt) => new Promise((resolve, reject) => {
    const s = opt && opt.signal;
    if (s) s.addEventListener('abort', () => {
      const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
    }, { once: true });
  });
  try {
    const t0 = Date.now();
    // timeout 取 1200：reviewer 的预检（remaining()<1000 不发请求）要求预算 ≥1000ms
    const r = await hook.reviewTurn(baseCfg({ reviewMode: 'sync', reviewTimeoutMs: 1200 }), { key: 'k', source: 'test' }, '内容', undefined, false);
    const elapsed = Date.now() - t0;
    assert.strictEqual(r.error, 'llm_timeout');
    assert.ok(elapsed >= 1000 && elapsed <= 2600,
      `sync 预算应为 1200ms，实际 ${elapsed}ms`);
  } finally {
    globalThis.fetch = origFetch;
  }
});
