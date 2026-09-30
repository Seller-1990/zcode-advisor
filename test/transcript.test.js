'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readDelta, renderDelta, extractEntry, clip } = require('../hooks/lib/transcript');

function tmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-tr-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

const L1 = '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"第一问"}]}}\n';
const L2 = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"第一答"}]}}\n';
const L3 = '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"第二问"}]}}\n';

test('增量读取：第二次只读到追加内容，残行不消费', () => {
  const file = tmpFile('t.jsonl', L1 + L2);
  const first = readDelta(file, 0);
  assert.strictEqual(first.entries.length, 2);
  assert.ok(first.nextOffset > 0);

  fs.appendFileSync(file, L3.slice(0, 10)); // 残行
  const partial = readDelta(file, first.nextOffset);
  assert.strictEqual(partial.entries.length, 0);
  assert.strictEqual(partial.nextOffset, first.nextOffset);

  fs.appendFileSync(file, L3.slice(10)); // 补全
  const full = readDelta(file, first.nextOffset);
  assert.strictEqual(full.entries.length, 1);
  assert.strictEqual(full.entries[0].parts[0].text, '第二问');
});

test('headHash 指纹：同路径重写（大小未变小）也触发全量重读', () => {
  const file = tmpFile('t.jsonl', L1 + L2 + L3);
  const big = readDelta(file, 0);
  assert.strictEqual(big.reset, false);
  // 原地重写为不同内容、大小大于旧 offset
  fs.writeFileSync(file, '{"type":"user","message":{"role":"user","content":"重写后的内容"}}\n', 'utf8');
  const after = readDelta(file, big.nextOffset, { expectedHeadHash: big.headHash });
  assert.strictEqual(after.reset, true);
  assert.strictEqual(after.entries.length, 1);
  // 指纹一致时不重置
  const again = readDelta(file, after.nextOffset, { expectedHeadHash: after.headHash });
  assert.strictEqual(again.reset, false);
});

test('backfill 上限：offset 大幅落后时从尾部回读并跳过残行', () => {
  const file = tmpFile('t.jsonl', L1 + L2 + L3);
  const r = readDelta(file, 0, { backfillLimitBytes: 20 });
  assert.strictEqual(r.reset, true);
  // 20 字节只覆盖 L1 的前缀，跳过残行后应解析出 0-2 条，但不抛错
  assert.ok(r.entries.length <= 2);
});

test('无效 UTF-8 字节不使 offset 偏移（字节级切行）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-tr-'));
  const file = path.join(dir, 'bin.jsonl');
  const good1 = Buffer.from(L1, 'utf8');
  const bad = Buffer.from([0x7b, 0xff, 0xfe, 0x0a]); // { + 非法字节 + \n
  fs.writeFileSync(file, Buffer.concat([good1, bad]));
  const r = readDelta(file, 0);
  // 污染行解析失败被跳过，但 offset 按原始字节精确落位（不再系统性偏移）
  assert.strictEqual(r.entries.length, 1);
  assert.strictEqual(r.entries[0].parts[0].text, '第一问');
  assert.strictEqual(r.nextOffset, good1.length + bad.length);
  // 从该字节位继续，追加内容正常解析
  fs.appendFileSync(file, Buffer.from(L2, 'utf8'));
  const r2 = readDelta(file, r.nextOffset);
  assert.strictEqual(r2.entries.length, 1);
  assert.strictEqual(r2.entries[0].parts[0].text, '第一答');
});

test('CRLF 行尾：offset 一致、解析正常', () => {
  const crlf = L1.replace(/\n/g, '\r\n');
  const file = tmpFile('crlf.jsonl', crlf + L2);
  const r = readDelta(file, 0);
  assert.strictEqual(r.entries.length, 2);
  const r2 = readDelta(file, r.nextOffset);
  assert.strictEqual(r2.entries.length, 0); // 无新增
});

test('BOM：全量回读时首行不丢', () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const file = tmpFile('bom.jsonl', Buffer.concat([bom, Buffer.from(L1, 'utf8')]));
  const r = readDelta(file, 0);
  assert.strictEqual(r.entries.length, 1);
  assert.strictEqual(r.entries[0].parts[0].text, '第一问');
});

test('extractEntry：思考块跳过、工具块摘要、垃圾行忽略', () => {
  assert.strictEqual(extractEntry('not json'), null);
  const thinkingOnly = extractEntry('{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"x"}]}}');
  assert.strictEqual(thinkingOnly, null);
  const toolUse = extractEntry('{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Read","input":{"file_path":"foo.js"}}]}}');
  assert.strictEqual(toolUse.parts[0].kind, 'tool_use');
  assert.ok(toolUse.parts[0].text.includes('Read'));
  const meta = extractEntry('{"type":"user","isMeta":true,"message":{"role":"user","content":"meta"}}');
  assert.strictEqual(meta, null);
});

test('clip：按码点截断，不劈开 emoji', () => {
  const s = '好'.repeat(10) + '🎉🎉🎉';
  const c = clip(s, 11);
  assert.strictEqual(Array.from(c).length, 12); // 11 + 省略号
  assert.ok(c.includes('🎉'));
  assert.strictEqual(clip('短文本', 100), '短文本');
});

test('renderDelta：过滤 advisor 自身注入，按条数与字符数截断', () => {
  const entries = [];
  for (let i = 0; i < 5; i++) {
    entries.push({ role: 'user', parts: [{ kind: 'text', text: `问题${i}` }] });
    entries.push({ role: 'assistant', parts: [{ kind: 'text', text: `[advisor:nit] 应被过滤${i}` }] });
  }
  const r = renderDelta(entries, { maxDeltaMessages: 4, maxContextChars: 100000, userChars: 4000, assistantChars: 4000, toolChars: 300 });
  assert.strictEqual(r.count, 4);
  assert.ok(!r.text.includes('应被过滤'));
  assert.ok(r.text.includes('问题3'));
});

test('renderDelta：窗口内无用户消息时回补最早的用户文本（保底）', () => {
  const entries = [
    { role: 'user', parts: [{ kind: 'text', text: '用户的原始指令' }] },
    { role: 'assistant', parts: [{ kind: 'text', text: '答' }] }
  ];
  for (let i = 0; i < 70; i++) {
    entries.push({ role: 'assistant', parts: [{ kind: 'tool_use', text: `Tool${i} {}` }] });
  }
  const r = renderDelta(entries, { maxDeltaMessages: 10, maxContextChars: 100000, userChars: 4000, assistantChars: 4000, toolChars: 300, keepFirstUserMessage: true });
  assert.ok(r.text.includes('[较早上下文]'));
  assert.ok(r.text.includes('用户的原始指令'));
  // 不开启保底时不回补
  const r2 = renderDelta(entries, { maxDeltaMessages: 10, maxContextChars: 100000, userChars: 4000, assistantChars: 4000, toolChars: 300 });
  assert.ok(!r2.text.includes('用户的原始指令'));
});

test('renderDelta：保底注入的内容不受字符帽约束（否则承诺反转）', () => {
  const entries = [
    { role: 'user', parts: [{ kind: 'text', text: '用户的关键指令，不能被字符帽裁掉' }] },
    { role: 'assistant', parts: [{ kind: 'text', text: '答' }] }
  ];
  for (let i = 0; i < 40; i++) {
    entries.push({ role: 'assistant', parts: [{ kind: 'text', text: `长回复内容${i}。`.repeat(50) }] });
  }
  // 字符帽很小：非保底行几乎全被裁，但保底注入必须存活
  const r = renderDelta(entries, { maxDeltaMessages: 32, maxContextChars: 600, userChars: 4000, assistantChars: 4000, toolChars: 300, keepFirstUserMessage: true });
  assert.ok(r.text.includes('用户的关键指令，不能被字符帽裁掉'), '保底用户指令必须在字符帽下幸存');
  assert.ok(r.text.includes('[较早上下文]'));
});

test('renderDelta：字符串型 content 与 tool_result 均可渲染', () => {
  const entries = [
    extractEntry('{"type":"user","message":{"role":"user","content":"纯字符串用户消息"}}'),
    extractEntry('{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"工具输出文本"}]}}')
  ];
  const r = renderDelta(entries, { maxDeltaMessages: 60, maxContextChars: 100000, userChars: 4000, assistantChars: 4000, toolChars: 300 });
  assert.ok(r.text.includes('【用户】纯字符串用户消息'));
  assert.ok(r.text.includes('【工具结果】工具输出文本'));
});

test('转录文件缺失时返回 missing', () => {
  const r = readDelta(path.join(os.tmpdir(), 'no-such-file-zcadv.jsonl'), 0);
  assert.strictEqual(r.missing, true);
  assert.strictEqual(r.entries.length, 0);
});
