'use strict';

// P4 审计修复回归：快照模式意见去重环（deliveredNoteHashes）
// 1) enqueueNote 挤掉的 nit 从未送达：其哈希须从去重环撤回，下一轮快照重审可重新入队。
// 2) 换审查目标 / 重新启用（ctl on、model set|provider|reset）时去重环清空。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { enqueueNote } = require('../hooks/lib/route');

const HOOK = path.join(__dirname, '..', 'hooks', 'advisor-hook.js');

function makeEnv(stateDir, extra) {
  fs.mkdirSync(stateDir, { recursive: true });
  const zcodeCfg = path.join(stateDir, 'zcode-v2.json');
  fs.writeFileSync(zcodeCfg, JSON.stringify({
    provider: {
      'prov-p4': {
        name: 'P4 网关', kind: 'openai-compatible',
        options: { baseURL: 'http://127.0.0.1:1/v1', apiKey: 'p4-key-abc123-not-placeholder' },
        models: { 'p4-model': {}, 'other-model': {} }
      }
    }
  }));
  const env = Object.assign({}, process.env, {
    ZCODE_ADVISOR_STATE_DIR: stateDir,
    ZCODE_ADVISOR_MOCK: '1',
    ZCODE_ADVISOR_NO_SPAWN: '1',
    ZCODE_ADVISOR_USER_CONFIG: path.join(stateDir, 'no-such-user-config.json'),
    ZCODE_ADVISOR_ZCODE_CONFIG: zcodeCfg,
    ZCODE_ADVISOR_ZCODE_PROVIDER_CONFIG: path.join(stateDir, 'no-such-provider-config.json'),
    ZCODE_ADVISOR_COMPANION_TMP: path.join(stateDir, 'companion-tmp'),
    ZCODE_ADVISOR_BADGE_REVIVE: '0',
    ZCODE_ADVISOR_HISTORY: path.join(stateDir, 'history.jsonl')
  });
  delete env.ZCODE_ADVISOR_API_KEY;
  delete env.ZCODE_ADVISOR_SPAWN_ARGS_FILE;
  return Object.assign(env, extra || {});
}

function runHook(args, stdinObj, env) {
  return spawnSync(process.execPath, [HOOK, ...args], {
    input: stdinObj ? JSON.stringify(stdinObj) : '', env, encoding: 'utf8', timeout: 60000
  });
}

function setupDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, '.mock-allowed'), '1');
  const transcript = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: '帮我实现一个功能' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: '好的，我来实现' } })
  ].join('\n') + '\n');
  return { dir, stateDir, transcript };
}

const readState = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const frameEnv = (stateDir, severity, note) =>
  makeEnv(stateDir, { ZCODE_ADVISOR_MOCK_FRAME: JSON.stringify({ severity, note }) });

// ---------------- 1) enqueueNote onEvict ----------------

test('enqueueNote：挤掉 nit 时 onEvict 收到被挤掉的完整意见', () => {
  const state = { pendingNotes: ['[advisor:concern] c0', '[advisor:nit] n1', '[advisor:nit] n2'] };
  const evicted = [];
  assert.strictEqual(enqueueNote(state, '[advisor:blocker] b', { pendingNotesCap: 3 }, () => {}, (n) => evicted.push(n)), true);
  assert.deepStrictEqual(evicted, ['[advisor:nit] n1']);
});

test('enqueueNote：未挤掉（丢弃新意见 / 未满）时不调用 onEvict', () => {
  const evicted = [];
  const full = { pendingNotes: ['[advisor:nit] a', '[advisor:nit] b'] };
  assert.strictEqual(enqueueNote(full, '[advisor:nit] c', { pendingNotesCap: 2 }, () => {}, (n) => evicted.push(n)), false);
  const roomy = { pendingNotes: [] };
  assert.strictEqual(enqueueNote(roomy, '[advisor:concern] x', { pendingNotesCap: 2 }, () => {}, (n) => evicted.push(n)), true);
  assert.deepStrictEqual(evicted, []);
});

// ---------------- 2) 快照模式：被挤掉的 nit 可重新入队 ----------------

test('快照模式：被 concern 挤掉的 nit 撤回去重哈希，下一轮可重新入队', (t) => {
  const { stateDir, transcript } = setupDir(t, 'zcadv-p4-evict-');
  const file = path.join(stateDir, 'sess-ev.json');
  runHook(['session-start'], { session_id: 'ev', transcript_path: transcript }, makeEnv(stateDir));

  // 轮 1：nit A 入队并记哈希
  runHook(['review-worker', '--state', file, '--transcript', transcript], null, frameEnv(stateDir, 'nit', '意见A'));
  let s = readState(file);
  assert.strictEqual(s.pendingNotes.length, 1, `nit 应入队（lastAction=${s.lastAction}）`);
  assert.strictEqual(s.deliveredNoteHashes.length, 1);
  const hashA = s.deliveredNoteHashes[0];

  // 队列塞满：A 是最旧的 nit
  const cap = 5;
  while (s.pendingNotes.length < cap) s.pendingNotes.push(`[advisor:concern] filler${s.pendingNotes.length}`);
  fs.writeFileSync(file, JSON.stringify(s));

  // 轮 2：concern B 挤掉 A → A 的哈希须撤回
  runHook(['review-worker', '--state', file, '--transcript', transcript], null, frameEnv(stateDir, 'concern', '意见B'));
  s = readState(file);
  assert.ok(!s.pendingNotes.some((n) => n.includes('意见A')), 'A 被挤掉');
  assert.ok(s.pendingNotes.some((n) => n.includes('意见B')), `B 入队（lastAction=${s.lastAction}）`);
  assert.ok(!s.deliveredNoteHashes.includes(hashA), '被挤掉的 A 不得留在去重环');
  assert.strictEqual(s.deliveredNoteHashes.length, 1, '仅剩 B 的哈希');

  // 轮 3：清队列后快照重审又产出 A → 应重新入队而非 deduped
  s.pendingNotes = [];
  fs.writeFileSync(file, JSON.stringify(s));
  runHook(['review-worker', '--state', file, '--transcript', transcript], null, frameEnv(stateDir, 'nit', '意见A'));
  s = readState(file);
  assert.notStrictEqual(s.lastAction, 'deduped:nit');
  assert.ok(s.pendingNotes.some((n) => n.includes('意见A')), '从未送达的 A 可重新入队');
});

// ---------------- 3) ctl 清空去重环 ----------------

for (const args of [['on'], ['model', 'set', 'other-model'], ['model', 'provider', 'prov-p4'], ['model', 'reset']]) {
  test(`ctl ${args.join(' ')}：清空 deliveredNoteHashes`, (t) => {
    const { stateDir, transcript } = setupDir(t, 'zcadv-p4-ctl-');
    const env = makeEnv(stateDir);
    runHook(['session-start'], { session_id: 'cc', transcript_path: transcript }, env);
    const file = path.join(stateDir, 'sess-cc.json');
    const s = readState(file);
    s.deliveredNoteHashes = ['h1', 'h2'];
    fs.writeFileSync(file, JSON.stringify(s));
    const r = runHook(['ctl', ...args, '--state', file], null, env);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(readState(file).deliveredNoteHashes, []);
  });
}

test('ctl off：不动去重环', (t) => {
  const { stateDir, transcript } = setupDir(t, 'zcadv-p4-off-');
  const env = makeEnv(stateDir);
  runHook(['session-start'], { session_id: 'oo', transcript_path: transcript }, env);
  const file = path.join(stateDir, 'sess-oo.json');
  const s = readState(file);
  s.deliveredNoteHashes = ['h1'];
  fs.writeFileSync(file, JSON.stringify(s));
  runHook(['ctl', 'off', '--state', file], null, env);
  assert.deepStrictEqual(readState(file).deliveredNoteHashes, ['h1']);
});
