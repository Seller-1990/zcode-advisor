'use strict';

// P4 审计修复回归：占位符模板 key、流式响应体字节上限、probe 通过率分母。
const test = require('node:test');
const assert = require('node:assert');

const { isPlaceholderKey } = require('../hooks/lib/config');
const R = require('../hooks/lib/reviewer');

async function withFetch(stub, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await fn(); } finally { globalThis.fetch = orig; }
}

const baseParams = { baseUrl: 'https://fixture.invalid/v1', apiKey: 'k', model: 'm', userContent: 'x', timeoutMs: 10000, protocol: 'openai' };
const MB2 = 2 * 1024 * 1024;

// ---------------- 1) isPlaceholderKey ----------------

test('isPlaceholderKey：模板 key 视为占位符', () => {
  for (const v of ['your-openai-api-key', 'your_deepseek_key', 'sk-your-key', 'sk-proj-xxxx', 'sk-...',
    'api-key-here', 'YOUR_API_KEY', 'sk-xxx', '<key>']) {
    assert.strictEqual(isPlaceholderKey(v), true, `${v} 应视为占位符`);
  }
});

test('isPlaceholderKey：真实 key 不误判', () => {
  for (const v of ['test-abc123realkey', 'your-co-gw-77aa', 'none-9f8e', 'sk-proj-AbC123def456',
    'sk-real-token-123', 'xxx-9f8e7d']) {
    assert.strictEqual(isPlaceholderKey(v), false, `${v} 不应被误判为占位符`);
  }
});

// ---------------- 2) 响应体流式字节上限 ----------------

// 构造带 body 流的响应桩；text() 被调用即记录，用于证明没有整体缓冲。
function streamResp(chunks, track) {
  let i = 0;
  const body = {
    getReader: () => ({
      read: async () => {
        if (i >= chunks.length) return { done: true, value: undefined };
        track.reads++;
        return { done: false, value: chunks[i++] };
      },
      cancel: async () => { track.cancelled = true; }
    })
  };
  return {
    ok: true, status: 200,
    headers: { get: () => null },
    body,
    text: async () => { track.textCalled = true; return ''; }
  };
}

test('callReviewer：分块 body 超 2MB → 读到超限即 cancel，不读剩余块', async () => {
  const track = { reads: 0, cancelled: false, textCalled: false };
  const chunk = new Uint8Array(1024 * 1024).fill(0x61);
  const chunks = [chunk, chunk, chunk, chunk, chunk]; // 5MB，第 3 块即超限
  const r = await withFetch(async () => streamResp(chunks, track), () => R.callReviewer(baseParams));
  assert.strictEqual(r.error, 'llm_error');
  assert.match(r.detail, /response_too_large/);
  assert.strictEqual(track.cancelled, true, '超限必须 cancel 流');
  assert.strictEqual(track.reads, 3, '超限后不应继续读');
  assert.strictEqual(track.textCalled, false, '有 body 流时不得走 text() 整体缓冲');
});

test('callReviewer：分块 body 正常大小 → 跨块 UTF-8 正确解码', async () => {
  const track = { reads: 0, cancelled: false, textCalled: false };
  const json = JSON.stringify({ choices: [{ message: { content: '{"severity":"nit","note":"中文😀"}' }, finish_reason: 'stop' }] });
  const bytes = new TextEncoder().encode(json);
  // 在多字节字符内部切块，验证流式解码不劈坏字符
  const cut = bytes.indexOf(0xe4) + 1;
  const r = await withFetch(async () => streamResp([bytes.slice(0, cut), bytes.slice(cut)], track), () => R.callReviewer(baseParams));
  assert.ok(!r.error, `不应报错：${r.error} ${r.detail || ''}`);
  assert.match(r.text, /中文😀/);
});

test('callReviewer：text() 兜底按 UTF-8 字节计（多字节内容 UTF-16 长度未超但字节超限）', async () => {
  // 每个「中」3 字节、1 个 UTF-16 码元：800K 字符 ≈ 2.4MB 字节，但 String.length 只有 0.8M
  const big = JSON.stringify({ choices: [{ message: { content: '中'.repeat(800 * 1024) } }] });
  assert.ok(big.length < MB2, '前提：UTF-16 长度未超');
  const stub = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => big });
  const r = await withFetch(stub, () => R.callReviewer(baseParams));
  assert.strictEqual(r.error, 'llm_error');
  assert.match(r.detail, /response_too_large/);
});

test('callReviewer：真实 Response 流（无 content-length）超限被拒', async () => {
  const chunk = new Uint8Array(512 * 1024).fill(0x61);
  let pulled = 0;
  const stream = new ReadableStream({
    pull(ctrl) { pulled++; if (pulled > 20) ctrl.close(); else ctrl.enqueue(chunk); }
  });
  const r = await withFetch(async () => new Response(stream, { status: 200 }), () => R.callReviewer(baseParams));
  assert.strictEqual(r.error, 'llm_error');
  assert.match(r.detail, /response_too_large/);
  assert.ok(pulled < 20, `超限后应停止拉取（实际 ${pulled}）`);
});

// ---------------- 3) probe passRate 分母 = ran ----------------

test('probeModel：整批预算截断时 passRate 按 ran 计', async () => {
  const stat = await R.probeModel(
    { baseUrl: 'http://x', model: 'slow', apiKey: 'k' },
    { n: 100, timeoutMs: 1000, batchTimeoutMs: 1500 },
    {
      callReviewer: async () => {
        await new Promise((r) => setTimeout(r, 600)); // 1500ms 预算：跑 1 次后剩余 <1000ms 即收尾
        return { text: '{"severity":"nit","note":"a"}' };
      }
    }
  );
  assert.strictEqual(stat.aborted, true);
  assert.ok(stat.ran > 0 && stat.ran < stat.n);
  assert.strictEqual(stat.passed, stat.ran);
  assert.strictEqual(stat.passRate, 1, '跑完的全部通过 → 1，而非 passed/n');
});

test('probeModel：ran=0 时 passRate=0（预算不足一次调用）', async () => {
  const stat = await R.probeModel(
    { baseUrl: 'http://x', model: 'm', apiKey: 'k' },
    { n: 3, batchTimeoutMs: 50 },
    { callReviewer: async () => ({ text: '{"severity":"nit","note":"a"}' }) }
  );
  assert.strictEqual(stat.ran, 0);
  assert.strictEqual(stat.aborted, true);
  assert.strictEqual(stat.passRate, 0);
});
