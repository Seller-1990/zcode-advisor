'use strict';

// 顾问意见历史（JSONL 追加写）的行为测试。
// 写入点在 enqueueNote/deliver 三个收口，读取在两个面板——
// 格式漂移会让面板静默展示空列表，所以这里锁住读写往返。
//
// 说明：HISTORY_FILE 在模块加载时读取 env，因此每个用例用**独立子进程**运行，
// 结果写到 stdout 供本进程断言（子进程内完成操作与读取，避免跨进程缓存问题）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HIST = require('../hooks/lib/history');

// 在独立子进程里执行代码（HISTORY_FILE 指向临时文件），返回打印的 JSON
function runInChild(file, body) {
  const runner = `
    process.env.ZCODE_ADVISOR_HISTORY = ${JSON.stringify(file)};
    const H = require(${JSON.stringify(path.join(__dirname, '../hooks/lib/history'))});
    ${body}
  `;
  const out = execFileSync(process.execPath, ['-e', runner], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out.trim().split('\n').pop());
}

test('appendHistory：写入 JSONL，readHistory 倒序读取', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zca-hist-'));
  const file = path.join(dir, 'h.jsonl');
  const got = runInChild(file, `
    H.appendHistory({ event: 'queued', severity: 'nit', note: '第一条', sessionId: 's1' });
    H.appendHistory({ event: 'delivered', count: 1, sessionId: 's1' });
    process.stdout.write(JSON.stringify(H.readHistory(10)));
  `);
  assert.strictEqual(got.length, 2);
  assert.strictEqual(got[0].event, 'delivered', '新的在前');
  assert.strictEqual(got[1].note, '第一条', '旧的在后');
  assert.ok(got[0].ts, '应带时间戳');
  // 文件确实是 JSONL（每行一个 JSON）
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 2);
  for (const l of lines) assert.doesNotThrow(() => JSON.parse(l), '每行应是合法 JSON');
});

test('appendHistory：损坏行被跳过，不影响其余读取', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zca-hist-'));
  const file = path.join(dir, 'h.jsonl');
  const got = runInChild(file, `
    H.appendHistory({ event: 'queued', severity: 'nit', note: 'a' });
    require('fs').appendFileSync(H.HISTORY_FILE, '{broken json\\n');
    H.appendHistory({ event: 'queued', severity: 'nit', note: 'b' });
    process.stdout.write(JSON.stringify(H.readHistory(10)));
  `);
  assert.strictEqual(got.length, 2, '坏行应被跳过');
  assert.strictEqual(got[0].note, 'b');
});

test('appendHistory：超限裁剪（不会无限增长）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zca-hist-'));
  const file = path.join(dir, 'h.jsonl');
  const got = runInChild(file, `
    for (let i = 0; i < 600; i++) H.appendHistory({ event: 'queued', severity: 'nit', note: 'n' + i });
    process.stdout.write(JSON.stringify({ count: H.readHistory(1000).length, first: H.readHistory(1)[0] && H.readHistory(1)[0].note }));
  `);
  assert.ok(got.count <= HIST.HISTORY_MAX_LINES, `裁剪后应不超过上限，实际 ${got.count}`);
  assert.strictEqual(got.first, 'n599', '最新的应保留');
});

test('readHistory：文件不存在时返回空数组（不抛错）', () => {
  const file = path.join(os.tmpdir(), `zca-none-${Date.now()}.jsonl`);
  const got = runInChild(file, `process.stdout.write(JSON.stringify(H.readHistory(10)));`);
  assert.deepStrictEqual(got, []);
});

test('HISTORY_FILE 指向 ~/.zcode（与配置/面板读取路径一致）', () => {
  assert.strictEqual(
    HIST.HISTORY_FILE,
    path.join(os.homedir(), '.zcode', 'advisor-history.jsonl')
  );
});

// ---------------- STATE_DIR 隔离（防回归） ----------------
// 背景：e2e 曾在无隔离时把假记录写进用户真实 ~/.zcode（靠手动 ls 才发现）。
// 锁住：设置了 ZCODE_ADVISOR_STATE_DIR 时，历史必须落在 stateDir 下。

test('STATE_DIR 隔离：历史落在 stateDir/advisor-history.jsonl，而非用户目录', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zca-state-'));
  const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zca-fakehome-'));
  // 子进程：STATE_DIR 指向隔离目录，HOME 指向假主目录（确保真实 ~/.zcode 绝不参与）
  const runner = `
    process.env.ZCODE_ADVISOR_STATE_DIR = ${JSON.stringify(stateDir)};
    process.env.HOME = ${JSON.stringify(userHome)};
    delete process.env.ZCODE_ADVISOR_HISTORY;
    const H = require(${JSON.stringify(path.join(__dirname, '../hooks/lib/history'))});
    H.appendHistory({ event: 'queued', severity: 'nit', note: '隔离测试' });
    process.stdout.write(JSON.stringify({
      stateFile: H.HISTORY_FILE,
      existsInState: require('fs').existsSync(${JSON.stringify(path.join(stateDir, 'advisor-history.jsonl'))}),
      existsInFakeHome: require('fs').existsSync(${JSON.stringify(path.join(userHome, '.zcode/advisor-history.jsonl'))})
    }));
  `;
  const out = execFileSync(process.execPath, ['-e', runner], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const got = JSON.parse(out.trim().split('\n').pop());

  assert.strictEqual(got.stateFile, path.join(stateDir, 'advisor-history.jsonl'), 'HISTORY_FILE 应解析到 stateDir');
  assert.strictEqual(got.existsInState, true, '记录应写入 stateDir');
  assert.strictEqual(got.existsInFakeHome, false, '绝不应写进（假）用户主目录');
});

test('STATE_DIR 隔离：读取也从 stateDir 读（读写同源）', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zca-state-'));
  const got = runInChild(path.join(stateDir, 'h.jsonl'), `
    H.appendHistory({ event: 'queued', severity: 'nit', note: 'x' });
    process.stdout.write(JSON.stringify(H.readHistory(10)));
  `);
  assert.strictEqual(got.length, 1);
});
