'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseFrame, salvageProse, extractJsonObjects, truncateCodePoints } = require('../hooks/lib/reviewer');

test('直接 JSON 帧', () => {
  assert.deepStrictEqual(parseFrame('{"severity":"nit","note":"a"}', false), { severity: 'nit', note: 'a' });
  assert.deepStrictEqual(parseFrame('{"severity":"none","note":""}', false), { severity: 'none', note: '' });
});

test('包裹在 prose/代码块中的 JSON 帧', () => {
  const text = '好的，我的判定如下：\n```json\n{"severity":"concern","note":"存在重复实现"}\n```\n以上。';
  assert.deepStrictEqual(parseFrame(text, false), { severity: 'concern', note: '存在重复实现' });
});

test('severity 带空白时归一（trim）', () => {
  assert.deepStrictEqual(parseFrame('{"severity":" blocker ","note":"x"}', false), { severity: 'blocker', note: 'x' });
});

test('非法 severity / 缺 note 拒绝', () => {
  assert.strictEqual(parseFrame('{"severity":"huge","note":"x"}', false), null);
  assert.strictEqual(parseFrame('{"severity":"nit"}', false), null);
  assert.strictEqual(parseFrame('', false), null);
});

test('多帧：取最后一个合法帧（模型自我纠正语义，非 max-of-N）', () => {
  // none 在前、blocker 在后 → 后帧覆盖前帧
  const t1 = '{"severity":"none","note":""}\n{"severity":"blocker","note":"立即停手"}';
  assert.deepStrictEqual(parseFrame(t1, false), { severity: 'blocker', note: '立即停手' });
  // blocker 在前、none 在后（模型自我纠正）→ 以后帧为准，不取最高 severity
  const t2 = '{"severity":"blocker","note":"先停"}\n{"severity":"none","note":""}';
  assert.deepStrictEqual(parseFrame(t2, false), { severity: 'none', note: '' });
});

test('伪码对象在前不杀死后面的真帧（继续扫描）', () => {
  const text = '用 {a:1} 这类伪码示意。{"severity":"concern","note":"真问题"}';
  assert.deepStrictEqual(parseFrame(text, false), { severity: 'concern', note: '真问题' });
});

test('JSON 帧的 note 也有码点上限（防超长注入）', () => {
  const longNote = 'x'.repeat(2000);
  const r = parseFrame(`{"severity":"nit","note":"${longNote}"}`, false, { maxNoteChars: 100 });
  assert.strictEqual(Array.from(r.note).length, 101); // 100 + 省略号
});

test('prose 回退仅在显式开启时生效', () => {
  assert.strictEqual(parseFrame('这条回复没有引用任何 JSON 帧。', false), null);
  assert.deepStrictEqual(parseFrame('这条回复没有引用任何 JSON 帧。', true), { severity: 'nit', note: '这条回复没有引用任何 JSON 帧。' });
});

test('extractJsonObjects：字符串内花括号、配平但非法的块跳过', () => {
  const objs = extractJsonObjects('前缀 {"severity":"blocker","note":"注意 {} 转义"} 后缀 {note: foo}');
  assert.strictEqual(objs.length, 1);
  assert.strictEqual(objs[0].severity, 'blocker');
  assert.deepStrictEqual(extractJsonObjects('没有对象'), []);
  assert.deepStrictEqual(extractJsonObjects('{"截断的'), []);
});

// —— 散文救回守门（源自 ADVISOR-GUARD-REPORT 的实战教训）——

test('散文救回：普通 prose 清洗后作为 nit', () => {
  const r = parseFrame('我注意到循环里每次都重新编译正则，建议提到循环外。', true, { maxNoteChars: 768 });
  assert.strictEqual(r.severity, 'nit');
  assert.ok(r.note.includes('循环外'));
});

test('散文救回守门一：JSON 尝试不救回（悬空/半截/带 note 键）', () => {
  assert.strictEqual(salvageProse('{"severity":"nit","note":', 768), null);       // 以 { 开头
  assert.strictEqual(salvageProse('[{"a":1', 768), null);                          // 以 [ 开头
  assert.strictEqual(salvageProse('这段 { 括号不配平的文本', 768), null);           // 花括号不配平
  assert.strictEqual(salvageProse('回复里带 note: 字样', 768), null);               // note 键特征
});

test('散文救回守门二：清洗只剥成对标记，代码内容保留', () => {
  const r = salvageProse('建议把 **snake_case_var** 与 `x => y` 的处理抽成 util，见 *.ts。', 768);
  assert.ok(r.note.includes('snake_case_var'));
  assert.ok(r.note.includes('x => y'));
  assert.ok(r.note.includes('*.ts'));
  assert.ok(!r.note.includes('**'));
});

test('散文救回守门三：过短丢弃、码点安全截断', () => {
  assert.strictEqual(salvageProse('太短', 768), null);
  // emoji 放在截断点之内：码点截断不允许把它劈成乱码
  const long = '好'.repeat(766) + '🎉🎉🎉';
  const r = salvageProse(long, 768);
  const chars = Array.from(r.note);
  assert.ok(chars.length <= 769); // 768 + 省略号
  assert.strictEqual(r.note.endsWith('…'), true);
  assert.ok(r.note.includes('🎉')); // emoji 未被劈开
});

test('truncateCodePoints 基础行为', () => {
  assert.strictEqual(truncateCodePoints('abcdef', 3), 'abc…');
  assert.strictEqual(truncateCodePoints('abc', 5), 'abc');
});
