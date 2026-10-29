'use strict';

// P3 审计修复回归：截断助手、错误分类、响应体上限、headHash 前缀比较。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { callReviewer, truncateCodePoints, parseFrameDetailed } = require('../hooks/lib/reviewer');
const { readDelta, clip } = require('../hooks/lib/transcript');

async function withFetch(stub, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await fn(); } finally { globalThis.fetch = orig; }
}

const baseParams = { baseUrl: 'https://fixture.invalid/v1', apiKey: 'k', model: 'm', userContent: 'x', timeoutMs: 10000, protocol: 'openai' };

test('truncateCodePoints：超长文本只展开头部，结果不劈开代理对', () => {
  const huge = '😀'.repeat(200000);
  const out = truncateCodePoints(huge, 5);
  assert.strictEqual(out, `${'😀'.repeat(5)}…`);
  assert.strictEqual(truncateCodePoints('abc', 3), 'abc');
  assert.strictEqual(truncateCodePoints('a😀b', 2), 'a😀…');
  // 2 个 BMP 字符 + 长度刚超 max 的混合
  assert.strictEqual(truncateCodePoints('😀😀', 2), '😀😀');
  assert.strictEqual(truncateCodePoints('abc', Infinity), 'abc');
});

test('clip 复用 truncateCodePoints 并保留空白归一', () => {
  assert.strictEqual(clip('  a \n\t b  ', 10), 'a b');
  assert.strictEqual(clip('😀😀😀', 2), '😀😀…');
});

test('parseFrameDetailed：超长 note 截断且 truncated=true', () => {
  const note = 'x'.repeat(100000);
  const det = parseFrameDetailed(JSON.stringify({ severity: 'nit', note }), true, { maxNoteChars: 10 });
  assert.strictEqual(det.frame.note, `${'x'.repeat(10)}…`);
  assert.strictEqual(det.truncated, true);
  const ok = parseFrameDetailed(`前文 {"severity":"concern","note":"短"}`, true, { maxNoteChars: 10 });
  assert.strictEqual(ok.from, 'json-embedded');
  assert.strictEqual(ok.truncated, false);
});

test('callReviewer：错误文本含 abort 但未超时 → llm_error（不误判 llm_timeout）', async () => {
  const r = await withFetch(async () => { throw new Error('connection aborted by peer'); }, () => callReviewer(baseParams));
  assert.strictEqual(r.error, 'llm_error');
  assert.match(r.detail, /aborted by peer/);
});

test('callReviewer：截止定时器中止请求 → llm_timeout', async () => {
  const stub = (_url, opt) => new Promise((_resolve, reject) => {
    opt.signal.addEventListener('abort', () => reject(new Error('generic failure')), { once: true });
  });
  const r = await withFetch(stub, () => callReviewer(Object.assign({}, baseParams, { timeoutMs: 1100 })));
  assert.strictEqual(r.error, 'llm_timeout');
});

test('callReviewer：content-length 超 2MB 直接拒绝，不读 body', async () => {
  let read = false;
  const stub = async () => ({
    ok: true, status: 200,
    headers: { get: (k) => (k === 'content-length' ? String(3 * 1024 * 1024) : null) },
    text: async () => { read = true; return '{}'; }
  });
  const r = await withFetch(stub, () => callReviewer(baseParams));
  assert.strictEqual(r.error, 'llm_error');
  assert.match(r.detail, /response_too_large/);
  assert.strictEqual(read, false);
});

test('callReviewer：无 content-length 但 body 超 2MB → llm_error', async () => {
  const big = JSON.stringify({ choices: [{ message: { content: 'a'.repeat(2 * 1024 * 1024 + 10) } }] });
  const stub = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => big });
  const r = await withFetch(stub, () => callReviewer(baseParams));
  assert.strictEqual(r.error, 'llm_error');
  assert.match(r.detail, /response_too_large/);
});

test('callReviewer：正常大小 body 经 text() 解析成功', async () => {
  const body = { choices: [{ message: { content: '{"severity":"none","note":""}' }, finish_reason: 'stop' }] };
  const stub = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) });
  const r = await withFetch(stub, () => callReviewer(baseParams));
  assert.strictEqual(r.error, undefined);
  assert.strictEqual(r.text, '{"severity":"none","note":""}');
});

test('callReviewer：非法 JSON body → llm_error', async () => {
  const stub = async () => ({ ok: true, status: 200, text: async () => 'not json' });
  const r = await withFetch(stub, () => callReviewer(baseParams));
  assert.strictEqual(r.error, 'llm_error');
});

test('readDelta：首读 <64B 的文件长大后不被误判为重写', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-transcript-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 't.jsonl');
  const l1 = `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })}\n`;
  assert.ok(Buffer.byteLength(l1) < 64);
  fs.writeFileSync(file, l1);
  const first = readDelta(file, 0);
  assert.match(first.headHash, /^\d+:[0-9a-f]+$/);

  const l2 = `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hello there, a longer reply' }] } })}\n`;
  fs.appendFileSync(file, l2);
  const second = readDelta(file, first.nextOffset, { expectedHeadHash: first.headHash });
  assert.strictEqual(second.reset, false);
  assert.strictEqual(second.consumed, 1);
  assert.match(second.headHash, /^[0-9a-f]+$/); // 满 64B 后回到纯 hex 格式

  // 真正重写（前缀变了）仍触发全量重读
  fs.writeFileSync(file, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'XX' } })}\n${l2}`);
  const third = readDelta(file, first.nextOffset, { expectedHeadHash: first.headHash });
  assert.strictEqual(third.reset, true);
});
