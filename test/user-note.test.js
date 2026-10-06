'use strict';

// issue #9：人工修改/确认意见注回会话（controller 侧）。
//
// 语义要点（三条都必须被测试锁住，否则会静默退化）：
//   ① 用户动作写进的是**同一个** pendingNotes 队列（不新开注入通道），
//      前缀 [advisor:user:*] 与机器意见 [advisor:*] 区分，仍是 advisory-only；
//   ② 队列上限与 hooks/lib/route.js 的 enqueueNote 同源（pendingNotesCap），
//      满了明确拒绝（queue_overflow）而不是静默丢弃；
//   ③ 截断按**码点**（同 hooks/lib/reviewer.js 的 normalizeFrame），
//      按 UTF-16 码元切会把代理对劈成乱码。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// controller require 时解析 HEALTH_DIR / USER_CONFIG / HISTORY_FILE，必须先设 env。
const healthDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-note-health-'));
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-note-state-'));
const userConfig = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-note-cfg-')), 'advisor.config.json');
const historyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-note-hist-')), 'advisor-history.jsonl');
process.env.ZCODE_ADVISOR_HEALTH_DIR = healthDir;
process.env.ZCODE_ADVISOR_USER_CONFIG = userConfig;
process.env.ZCODE_ADVISOR_HISTORY = historyFile;
// 生产日志隔离（static-guards 有守卫：require controller 必须隔离该 env）
process.env.ZCODE_ADVISOR_COMPANION_LOG = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'zca-note-log-')), 'companion.log');

const controller = require('../tools/companion/controller.cjs');

const SESSION_ID = 'sess_note0001';
const STATE_FILE = () => path.join(stateDir, `sess-${SESSION_ID}.json`);

function writeBeacon() {
  fs.writeFileSync(path.join(healthDir, `advisor-health-${SESSION_ID}.json`), JSON.stringify({
    sessionId: SESSION_ID, stateDir, state: 'ok', lastAttemptAt: new Date().toISOString()
  }));
}

function writeState(patch) {
  const st = Object.assign({
    schema: 1, sessionId: SESSION_ID, enabled: true, pendingNotes: [], reviews: 3
  }, patch || {});
  fs.writeFileSync(STATE_FILE(), JSON.stringify(st, null, 2));
  return st;
}

function readState() { return JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')); }
function readHistory() {
  if (!fs.existsSync(historyFile)) return [];
  return fs.readFileSync(historyFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
function clearHistory() { try { fs.unlinkSync(historyFile); } catch (_) {} }

function resetEnvLimits() {
  delete process.env.ZCODE_ADVISOR_PENDING_NOTES_CAP;
  delete process.env.ZCODE_ADVISOR_MAX_NOTE_CHARS;
}

test.beforeEach(() => {
  resetEnvLimits();
  try { fs.unlinkSync(userConfig); } catch (_) {}
  clearHistory();
  for (const f of fs.readdirSync(healthDir)) { try { fs.unlinkSync(path.join(healthDir, f)); } catch (_) {} }
  writeBeacon();
  writeState();
});

// ---------------- 注回文本合成 ----------------

test('composeUserNote：前缀为 [advisor:user:<action>]，带原意见与 severity，且明示 advisory-only', () => {
  const note = controller.composeUserNote('ack', 'blocker', '这个分支没有覆盖 null 输入。', '', 768);
  assert.match(note, /^\[advisor:user:ack\]/, '前缀必须是 [advisor:user:ack]（与机器意见 [advisor:*] 区分）');
  assert.match(note, /blocker/, '必须带上原意见的 severity——主模型据此判断权重');
  assert.match(note, /这个分支没有覆盖 null 输入。/, '必须带原意见正文，否则主模型不知道在说什么');
  assert.match(note, /advisory-only/, 'ack 的语义必须声明 advisory-only（不强制改代码）');
});

test('composeUserNote：dismiss 明确叫停，note 带上用户补充', () => {
  const dis = controller.composeUserNote('dismiss', 'nit', '建议重命名变量。', '', 768);
  assert.match(dis, /^\[advisor:user:dismiss\]/);
  assert.match(dis, /驳回/, 'dismiss 必须明确表达"不要据此改动"');

  const sup = controller.composeUserNote('note', 'nit', '建议重命名变量。', '这个名字是上游 API 的字段名，不能改。', 768);
  assert.match(sup, /^\[advisor:user:note\]/);
  assert.match(sup, /上游 API 的字段名/, '「补充说明」的全部价值就是那段文字，必须进注回文本');
});

test('truncateByCodepoint：按码点截断，不劈开代理对（emoji/扩展汉字）', () => {
  const emoji = '😀'.repeat(20);            // 每个占 2 个 UTF-16 码元
  const out = controller.truncateByCodepoint(emoji, 10);
  assert.strictEqual(Array.from(out).length, 11, '10 个码点 + 省略号');
  // 反证：String.slice 会留下孤立高位代理（乱码）
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out), '截断后不得出现孤立高位代理');
  assert.ok(!/[\uDC00-\uDFFF]/.test(out.slice(0, out.length - 1).replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')),
    '截断后不得出现孤立低位代理');
  // 未超限时原样返回
  assert.strictEqual(controller.truncateByCodepoint('短', 10), '短');
  assert.strictEqual(controller.truncateByCodepoint(null, 10), '');
});

// ---------------- 队列上限：与 enqueueNote 同源 ----------------

test('queueLimits：内置默认 5/768，用户配置覆盖，环境变量最终覆盖（与 hook 同源）', () => {
  resetEnvLimits();
  assert.deepStrictEqual(controller.queueLimits(), { cap: 5, maxChars: 768 }, '内置默认必须与 hooks/lib/config.js 一致');

  fs.writeFileSync(userConfig, JSON.stringify({ pendingNotesCap: 3, maxNoteChars: 100 }));
  assert.deepStrictEqual(controller.queueLimits(), { cap: 3, maxChars: 100 }, '用户配置应生效');

  process.env.ZCODE_ADVISOR_PENDING_NOTES_CAP = '7';
  process.env.ZCODE_ADVISOR_MAX_NOTE_CHARS = '200';
  assert.deepStrictEqual(controller.queueLimits(), { cap: 7, maxChars: 200 }, '环境变量优先级最高');

  // 非法值回退：env '0' 覆盖成 0 后过正整数守卫 → 回退**内置默认 5**（不是用户层 3）；
  // env 'abc' 解析失败 → 保持用户层 100。与 hooks 的 toInt + POSITIVE_INT_KEYS 完全一致。
  process.env.ZCODE_ADVISOR_PENDING_NOTES_CAP = '0';
  process.env.ZCODE_ADVISOR_MAX_NOTE_CHARS = 'abc';
  assert.deepStrictEqual(controller.queueLimits(), { cap: 5, maxChars: 100 }, '非法值必须回退而不是变成 NaN/0');
});

// ---------------- 入队行为 ----------------

test('enqueueUserNote：ack 写入同一 pendingNotes 队列，带前缀，并落一条 user_followup 历史', () => {
  const r = controller.enqueueUserNote({ action: 'ack', severity: 'nit', note: '建议合并重复分支。' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.queued, true);
  assert.strictEqual(r.pending, 1);
  assert.strictEqual(r.cap, 5);
  assert.strictEqual(r.sessionId, SESSION_ID);

  const st = readState();
  assert.strictEqual(st.pendingNotes.length, 1, '必须写进**同一个** pendingNotes 队列（不新开注入通道）');
  assert.match(st.pendingNotes[0], /^\[advisor:user:ack\]/);
  assert.match(st.pendingNotes[0], /建议合并重复分支。/);
  // 锁与临时文件都不该残留
  assert.ok(!fs.existsSync(`${STATE_FILE()}.wrlock`), '临界区结束后锁应清除');
  assert.ok(!fs.existsSync(`${STATE_FILE()}.tmp-${process.pid}`), '不应残留 tmp 文件');

  // 历史标注（issue #9 第 3 点）：面板据此把「这条意见被人工跟进过」标出来
  const hist = readHistory();
  const fu = hist.filter((e) => e.event === 'user_followup');
  assert.strictEqual(fu.length, 1, '应写入一条 user_followup 事件');
  assert.strictEqual(fu[0].action, 'ack');
  assert.strictEqual(fu[0].severity, 'nit');
  assert.strictEqual(fu[0].note, '建议合并重复分支。', 'note 必须与原意见逐字一致——面板靠内容键配对');
  assert.strictEqual(fu[0].sessionId, SESSION_ID);
  assert.ok(fu[0].ts, '应带时间戳');
});

test('enqueueUserNote：多次提交累加到同一队列（顺序即送达顺序）', () => {
  controller.enqueueUserNote({ action: 'ack', severity: 'nit', note: '第一条' });
  const r2 = controller.enqueueUserNote({ action: 'dismiss', severity: 'blocker', note: '第二条' });
  assert.strictEqual(r2.pending, 2);
  const st = readState();
  assert.strictEqual(st.pendingNotes.length, 2);
  assert.match(st.pendingNotes[0], /第一条/);
  assert.match(st.pendingNotes[1], /第二条/);
});

test('enqueueUserNote：note 动作必须带文字，空文字直接拒绝且不改状态', () => {
  const before = readState();
  const r = controller.enqueueUserNote({ action: 'note', severity: 'nit', note: '原意见', text: '   ' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'text_required');
  assert.strictEqual(readState().pendingNotes.length, before.pendingNotes.length, '拒绝时不得写入队列');
  assert.ok(!fs.existsSync(`${STATE_FILE()}.wrlock`), '提前返回也必须释放锁');
});

test('enqueueUserNote：非法 action / 缺原意见 → 明确报错（不静默成功）', () => {
  const bad = controller.enqueueUserNote({ action: 'whatever', severity: 'nit', note: 'x' });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.error, 'bad_action');

  const noNote = controller.enqueueUserNote({ action: 'ack', severity: 'nit', note: '   ' });
  assert.strictEqual(noNote.ok, false);
  assert.strictEqual(noNote.error, 'bad_note');

  const noPayload = controller.enqueueUserNote(undefined);
  assert.strictEqual(noPayload.ok, false);
  assert.strictEqual(noPayload.error, 'bad_action');
  assert.strictEqual(readState().pendingNotes.length, 0, '任何拒绝路径都不得写入队列');
});

test('enqueueUserNote：无信标 → no_session（不静默成功）', () => {
  for (const f of fs.readdirSync(healthDir)) fs.unlinkSync(path.join(healthDir, f));
  const r = controller.enqueueUserNote({ action: 'ack', severity: 'nit', note: 'x' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'no_session');
});

test('enqueueUserNote：状态文件损坏 → state_unreadable（不覆盖用户状态）', () => {
  fs.writeFileSync(STATE_FILE(), '{ 这不是 JSON');
  const r = controller.enqueueUserNote({ action: 'ack', severity: 'nit', note: 'x' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'state_unreadable');
  assert.strictEqual(fs.readFileSync(STATE_FILE(), 'utf8'), '{ 这不是 JSON', '读失败时绝不得改写状态文件');
});

// ---------------- 容量：与 enqueueNote 同构 ----------------

test('enqueueUserNote：队列已满 → queue_overflow（明确拒绝，不静默丢弃）', () => {
  process.env.ZCODE_ADVISOR_PENDING_NOTES_CAP = '2';
  writeState({ pendingNotes: ['[advisor:nit] 已有甲', '[advisor:nit] 已有乙'], failStreak: 4 });

  const r = controller.enqueueUserNote({ action: 'ack', severity: 'nit', note: '第三条' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'queue_overflow');
  assert.strictEqual(r.pending, 2);
  assert.strictEqual(r.cap, 2);
  assert.match(r.hint, /队列已满/, '必须给出可操作的提示（等下一轮送达后再提交）');

  const st = readState();
  assert.strictEqual(st.pendingNotes.length, 2, '溢出时不得追加（也不得覆盖已有条目）');
  // 计数器与 hook 侧同形：dropped[reason] / droppedAt[reason]
  assert.strictEqual(st.dropped.queue_overflow, 1);
  assert.ok(st.droppedAt.queue_overflow, '应记录溢出时间');
  // queue_overflow 不在 failStreak 白名单里：它是"队列满"，不是"审查失败"，
  // 动 failStreak 会让健康灯因用户多点了几下而变红。
  assert.strictEqual(st.failStreak, 4, 'queue_overflow 不得污染 failStreak');

  const dropped = readHistory().filter((e) => e.event === 'dropped:queue_overflow');
  assert.strictEqual(dropped.length, 1, '溢出必须留痕（面板的丢弃统计不能漏掉面板侧溢出）');
  assert.strictEqual(dropped[0].action, 'ack');
  assert.strictEqual(dropped[0].mode, 'panel');
});

test('enqueueUserNote：上限来自 hooks 同一配置（改 advisor.config.json 立即生效）', () => {
  fs.writeFileSync(userConfig, JSON.stringify({ pendingNotesCap: 1 }));
  writeState({ pendingNotes: ['[advisor:nit] 占位'] });
  const r = controller.enqueueUserNote({ action: 'ack', severity: 'nit', note: 'x' });
  assert.strictEqual(r.error, 'queue_overflow', '必须读用户配置的 pendingNotesCap，而不是写死 5');
  assert.strictEqual(r.cap, 1);
});

// ---------------- 截断 ----------------

test('enqueueUserNote：超长注回文本按 maxNoteChars 码点截断', () => {
  process.env.ZCODE_ADVISOR_MAX_NOTE_CHARS = '30';
  const long = '这是一条很长的顾问意见，'.repeat(20);
  const r = controller.enqueueUserNote({ action: 'ack', severity: 'nit', note: long });
  assert.strictEqual(r.ok, true);
  const stored = readState().pendingNotes[0];
  assert.strictEqual(Array.from(stored).length, 31, '30 个码点 + 省略号（与 normalizeFrame 同规则）');
  assert.ok(stored.endsWith('…'), '截断应带省略号，让主模型知道内容不完整');
  assert.match(stored, /^\[advisor:user:ack\]/, '截断不得吃掉前缀——否则与机器意见无法区分');
});

// ---------------- 与 hook 侧互斥 ----------------

test('enqueueUserNote：与 hook 侧活锁并发 → lock_timeout（互斥而非互相覆盖）', () => {
  writeState({ pendingNotes: [] });
  fs.writeFileSync(`${STATE_FILE()}.wrlock`, '1');   // pid 1 恒存在 + mtime 新鲜 = 活锁
  try {
    const r = controller.enqueueUserNote({ action: 'ack', severity: 'nit', note: 'x' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'lock_timeout');
    assert.strictEqual(readState().pendingNotes.length, 0, '未抢到锁时不得改写状态（否则会覆盖 hook 刚写的条目）');
  } finally {
    try { fs.unlinkSync(`${STATE_FILE()}.wrlock`); } catch (_) {}
  }
});

test('enqueueUserNote：陈旧锁接管（持锁者已死）', () => {
  const lock = `${STATE_FILE()}.wrlock`;
  fs.writeFileSync(lock, '999999999');
  const old = Date.now() - 20000;
  fs.utimesSync(lock, new Date(old), new Date(old));
  const r = controller.enqueueUserNote({ action: 'ack', severity: 'nit', note: 'x' });
  assert.strictEqual(r.ok, true, '陈旧锁应被接管');
  assert.strictEqual(readState().pendingNotes.length, 1);
});

// ---------------- 历史写入器（与 hooks 同格式） ----------------

test('appendHistoryRecord：与 hooks/lib/history.js 写出的行格式一致（同一 JSONL 双向可读）', () => {
  assert.strictEqual(controller.appendHistoryRecord({ event: 'user_followup', severity: 'nit', note: 'n' }), true);
  const line = fs.readFileSync(historyFile, 'utf8').trim();
  const obj = JSON.parse(line);
  assert.strictEqual(obj.event, 'user_followup');
  assert.ok(obj.ts, '必须带 ts（hooks 侧同款，面板 fmtTs 依赖它）');
  // 文件权限：历史含意见正文，仅属主可读
  const mode = fs.statSync(historyFile).mode & 0o777;
  assert.strictEqual(mode, 0o600, `历史文件应为 0600，实际 ${mode.toString(8)}`);
});

test('appendHistoryRecord：超过 HISTORY_MAX_LINES 时裁剪到一半（面板侧是唯一写入方时不能无界增长）', () => {
  const many = controller.HISTORY_MAX_LINES + 50;
  const lines = [];
  for (let i = 0; i < many; i++) lines.push(JSON.stringify({ ts: new Date().toISOString(), event: 'queued', note: `n${i}` }));
  fs.writeFileSync(historyFile, lines.join('\n') + '\n');
  controller.appendHistoryRecord({ event: 'user_followup', note: '最后一条' });
  const after = fs.readFileSync(historyFile, 'utf8').split('\n').filter(Boolean);
  assert.ok(after.length <= controller.HISTORY_MAX_LINES, `裁剪后行数应 <= ${controller.HISTORY_MAX_LINES}，实际 ${after.length}`);
  assert.match(after[after.length - 1], /最后一条/, '刚写入的那条必须保留');
});

// ---------------- 静态一致性（防两侧漂移） ----------------

test('跨文件一致性：HISTORY_MAX_LINES 与 hooks 侧同值；queue_overflow 语义与 route.js 同构', () => {
  const ROOT = path.join(__dirname, '..');
  const hook = fs.readFileSync(path.join(ROOT, 'hooks', 'lib', 'history.js'), 'utf8');
  const route = fs.readFileSync(path.join(ROOT, 'hooks', 'lib', 'route.js'), 'utf8');
  const ctrl = fs.readFileSync(path.join(ROOT, 'tools', 'companion', 'controller.cjs'), 'utf8');
  const m = /HISTORY_MAX_LINES\s*=\s*(\d+)/.exec(hook);
  assert.ok(m, 'hooks/lib/history.js 应有 HISTORY_MAX_LINES');
  assert.match(ctrl, new RegExp(`HISTORY_MAX_LINES\\s*=\\s*${m[1]}\\b`),
    'controller 的 HISTORY_MAX_LINES 必须与 hooks 侧同值（否则一侧裁剪阈值另一侧读不懂）');
  // 两侧都必须在容量耗尽时记 queue_overflow（同一 reason 字符串，面板统计才合并）
  assert.match(route, /queue_overflow/);
  assert.match(ctrl, /queue_overflow/);
});

// 这条是 S1.K1 的**行为**守卫，比上面的正则强：正则只能证明「controller 里写着 5」，
// 不能证明「这个 5 与 hook 实际算出来的是同一个数」。
// 变异实测：把 hooks/lib/config.js 的 pendingNotesCap 默认值 5 改成 9，上面那条正则断言
// 依然全绿（它只读 controller 与 route.js，从不加载 hooks 的默认值）——即两侧漂移时
// 面板会认为「还能再放 4 条」而 hook 认为已满，用户看到入队成功但下一轮什么都没注回。
// 因此这里真正调用 hooks 的 loadConfig 取三层结果，与 controller.queueLimits() 逐一比对。
test('S1.K1：queueLimits 与 hooks 的 loadConfig 在三层（默认/用户配置/env）逐层同值', () => {
  const ROOT = path.join(__dirname, '..');
  const hooksConfig = require(path.join(ROOT, 'hooks', 'lib', 'config.js'));
  // 与 controller 读到的是**同一个**用户配置文件（require 前已设 env 指向 userConfig）
  const mkEnv = () => {
    const env = Object.assign({}, process.env);
    env.ZCODE_ADVISOR_USER_CONFIG = userConfig;
    return env;
  };
  const hooksLimits = () => {
    const c = hooksConfig.loadConfig(ROOT, mkEnv());
    return { cap: c.pendingNotesCap, maxChars: c.maxNoteChars };
  };

  // 第 1 层：内置默认（无用户配置、无 env 覆盖）
  resetEnvLimits();
  try { fs.unlinkSync(userConfig); } catch (_) {}
  assert.deepStrictEqual(controller.queueLimits(), hooksLimits(),
    '内置默认必须与 hooks/lib/config.js 的 DEFAULTS 实际值一致（不能只在注释里声称一致）');

  // 第 2 层：用户配置覆盖
  fs.writeFileSync(userConfig, JSON.stringify({ pendingNotesCap: 3, maxNoteChars: 100 }));
  assert.deepStrictEqual(controller.queueLimits(), hooksLimits(),
    '用户配置层必须与 hooks 算出同一组上限');

  // 第 3 层：env 覆盖（最高优先级）
  process.env.ZCODE_ADVISOR_PENDING_NOTES_CAP = '7';
  process.env.ZCODE_ADVISOR_MAX_NOTE_CHARS = '200';
  assert.deepStrictEqual(controller.queueLimits(), hooksLimits(),
    'env 层必须与 hooks 算出同一组上限（否则面板与 hook 的满/未满判定会分歧）');
  assert.deepStrictEqual(controller.queueLimits(), { cap: 7, maxChars: 200 });

  // 第 4 层：非法值回退（0 / 非数字）。这里是最容易漂移的一层，实测语义是：
  //   env 层先走 toInt —— '0' 是合法整数故**覆盖**成 0，'abc' 解析失败故**保持**用户层 100；
  //   随后统一过正整数守卫 —— cap=0 回退的是**内置默认 5**，而**不是**用户层的 3。
  // 所以结果是 {cap:5, maxChars:100}：cap 跳过用户层直接回默认，maxChars 停在用户层。
  // 早先 controller 按层回退（0 → 用户层 3）得到 {cap:3, maxChars:100}，与 hook 分歧：
  // 面板认为"还能再放 2 条"而 hook 认为已满，用户看到入队成功但下一轮什么都没注回。
  process.env.ZCODE_ADVISOR_PENDING_NOTES_CAP = '0';
  process.env.ZCODE_ADVISOR_MAX_NOTE_CHARS = 'abc';
  assert.deepStrictEqual(controller.queueLimits(), hooksLimits(),
    '非法值回退路径也必须同值（toInt 保持层值 + POSITIVE_INT_KEYS 回退内置默认）');
  assert.deepStrictEqual(controller.queueLimits(), { cap: 5, maxChars: 100 });

  resetEnvLimits();
});

test('issue #7：controller 不再下发 Runtime.enable（只保留 Runtime.evaluate 与 Page 域）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'companion', 'controller.cjs'), 'utf8');
  assert.ok(!/method:\s*'Runtime\.enable'/.test(src),
    'Runtime.enable 会让 renderer 持续推送本进程不消费的事件，纯粹增大"调试器已附着"暴露面');
  assert.match(src, /method:\s*'Runtime\.evaluate'/, 'Runtime.evaluate（注入脚本）必须保留');
  assert.match(src, /method:\s*'Page\.enable'/, 'Page.enable 必须保留（持久注入依赖它）');
  assert.match(src, /Runtime\.enable 会让 renderer/, '应保留解释性注释，防止后人"顺手加回来"');
});

test('issue #7：启动期风控告知存在且被 main 调用（附着分支也不漏）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'companion', 'controller.cjs'), 'utf8');
  assert.ok(Array.isArray(controller.CDP_RISK_NOTICE) && controller.CDP_RISK_NOTICE.length >= 2,
    'CDP_RISK_NOTICE 应至少包含"现象"与"可操作动作"两段');
  const text = controller.CDP_RISK_NOTICE.join('\n');
  assert.match(text, /调试/, '必须点明"调试模式/调试端口"是风险来源');
  assert.match(text, /F008|验证/, '必须点明已知现象（发送前验证失败）');
  assert.match(text, /双击/, '必须给出可操作动作（改直接双击 ZCode 启动）');
  assert.ok(!/已修复/.test(text), '不得宣称已修复根因（本机无法复现该因果）');
  // 调用点必须在 ensureCdp 之后（此时才能确定工作实例确实处于 CDP 模式）
  const callIdx = src.indexOf('warnCdpRisk();');
  const ensureIdx = src.indexOf('const cdpPort = await ensureCdp();');
  assert.ok(ensureIdx >= 0 && callIdx > ensureIdx, 'warnCdpRisk 必须在 ensureCdp 之后调用（否则附着分支会漏报）');
});

test('issue #7：warnCdpRisk 真的把每一条告知写进日志（不只是定义常量）', () => {
  // 定义常量却不调用/不落盘，是"告知形同虚设"的典型形态（inject.js 曾整张样式表只定义不注入）。
  // 这里真跑一次，断言日志文件里逐行出现。LOG_FILE 已被隔离到临时目录。
  const before = fs.existsSync(process.env.ZCODE_ADVISOR_COMPANION_LOG)
    ? fs.readFileSync(process.env.ZCODE_ADVISOR_COMPANION_LOG, 'utf8') : '';
  controller.warnCdpRisk();
  const after = fs.readFileSync(process.env.ZCODE_ADVISOR_COMPANION_LOG, 'utf8');
  const added = after.slice(before.length);
  for (const line of controller.CDP_RISK_NOTICE) {
    // log() 会加时间戳前缀，故按内容片段匹配（取每段前 12 字，避开换行拼接差异）
    const probe = line.slice(0, 12);
    assert.ok(added.includes(probe), `日志里应出现告知：${probe}…，实际新增：${added}`);
  }
  assert.ok(added.includes('F008') || added.includes('验证'), '日志应含已知现象说明');
});
