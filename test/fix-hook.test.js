'use strict';

// 修复回归（2026-10-29 批次）：
// 1) 停机：只按主模型的错判；401/403 立即停机，404 连续 HALT_404_STREAK(3) 次才停；备用模型的错不停主模型。
// 2) worker 最终落盘：审查期间换模型/停用/停机恢复 → 本次结果作废。
// 3) transcript：快照模式（final）消费无换行但完整的末行。
// 4) 快照模式意见去重。
// 5) Stop（async、快照）确实把 --transcript 传给 worker。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

// history 路径在模块加载时解析：require advisor-hook 之前隔离。
const TMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-fix-'));
process.env.ZCODE_ADVISOR_HISTORY = path.join(TMP_BASE, 'history.jsonl');
test.after(() => { try { fs.rmSync(TMP_BASE, { recursive: true, force: true }); } catch (_) {} });

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const HOOK = path.join(PLUGIN_ROOT, 'hooks', 'advisor-hook.js');
const { reviewTurn, applyReviewOutcome } = require('../hooks/advisor-hook.js');
const { readDelta } = require('../hooks/lib/transcript.js');

const EFF = { model: 'primary-model', providerName: 'p' };
const CFG = {
  reviewMode: 'async', reviewTimeoutMs: 60000, fallbackModel: 'fb-model',
  maxTokens: 2048, temperature: 0.2, systemPrompt: '', proseFallback: false,
  maxNoteChars: 200, providerId: 'p1'
};
const TARGET = { model: 'primary-model', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', protocol: 'openai', providerId: 'p1', globalProviderId: 'p1' };
const FRAME_TEXT = '{"severity":"nit","note":"ok"}';

function mkState() {
  return { sessionId: 's', dropped: {}, droppedAt: {}, halted: false };
}

function makeEnv(stateDir, zcodeCfgObj, extra) {
  fs.mkdirSync(stateDir, { recursive: true });
  const zcodeCfg = path.join(stateDir, 'zcode-v2.json');
  fs.writeFileSync(zcodeCfg, JSON.stringify(zcodeCfgObj || {
    provider: {
      'prov-fix': {
        name: 'FIX 网关', kind: 'openai-compatible',
        options: { baseURL: 'http://127.0.0.1:1/v1', apiKey: 'fix-key-abc123-not-placeholder' },
        models: { 'fix-model': {}, 'other-model': {} }
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
  const transcript = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: '帮我实现一个功能' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: '好的，我来实现' } })
  ].join('\n') + '\n');
  return { dir, stateDir, transcript };
}

// ---------------- 1) 停机 ----------------

test('停机：主模型 404 连续 3 次才停机；中途成功清零', () => {
  const s = mkState();
  applyReviewOutcome(s, { error: 'llm_http_404', primaryFailure: 'llm_http_404' }, EFF, CFG);
  applyReviewOutcome(s, { error: 'llm_http_404', primaryFailure: 'llm_http_404' }, EFF, CFG);
  assert.ok(!s.halted, '2 次 404 不得停机');
  assert.strictEqual(s.primary404Streak, 2);
  applyReviewOutcome(s, { frame: { severity: 'none', note: '' } }, EFF, CFG);
  assert.strictEqual(s.primary404Streak, 0, '成功清零 404 连击');
  for (let i = 0; i < 2; i++) applyReviewOutcome(s, { error: 'llm_http_404' }, EFF, CFG);
  assert.ok(!s.halted);
  applyReviewOutcome(s, { error: 'llm_http_404' }, EFF, CFG);
  assert.strictEqual(s.halted, true, '连续第 3 次 404 停机');
  assert.strictEqual(s.haltedReason, 'llm_http_404');
  assert.strictEqual(s.haltedModel, 'primary-model');
});

test('停机：其它错打断 404 连击', () => {
  const s = mkState();
  applyReviewOutcome(s, { error: 'llm_http_404' }, EFF, CFG);
  applyReviewOutcome(s, { error: 'llm_http_404' }, EFF, CFG);
  applyReviewOutcome(s, { error: 'llm_timeout' }, EFF, CFG);
  applyReviewOutcome(s, { error: 'llm_http_404' }, EFF, CFG);
  assert.ok(!s.halted);
  assert.strictEqual(s.primary404Streak, 1);
});

test('停机：主模型 401/403 立即停机', () => {
  for (const code of ['llm_http_401', 'llm_http_403']) {
    const s = mkState();
    applyReviewOutcome(s, { error: code, halt: true }, EFF, CFG);
    assert.strictEqual(s.halted, true, `${code} 立即停机`);
    assert.strictEqual(s.haltedReason, code);
    assert.strictEqual(s.haltEpoch, 1);
  }
});

test('停机：备用模型 404/401 不让主模型停机（reviewTurn → applyReviewOutcome 全链路）', async () => {
  for (const fbErr of ['llm_http_404', 'llm_http_401']) {
    const callReviewer = async (p) => {
      if (p.model === 'primary-model') return { error: 'unparsed', text: 'prose', usage: {} };
      return { error: fbErr, text: '', usage: {} };
    };
    const s = mkState();
    for (let i = 0; i < 4; i++) {
      const r = await reviewTurn(CFG, TARGET, '增量内容', false, { callReviewer });
      assert.strictEqual(r.error, fbErr);
      assert.strictEqual(r.fromFallback, true);
      assert.strictEqual(r.halt, false, '备用模型的 401 不得上抛 halt');
      applyReviewOutcome(s, r, EFF, CFG);
    }
    assert.ok(!s.halted, `备用模型 ${fbErr} 不得停机主模型`);
    assert.strictEqual(s.primary404Streak || 0, 0);
  }
});

test('停机：主模型 404 + 备用也 404 → 计主模型 404 连击（第 3 次停机，haltedModel=主模型）', async () => {
  const callReviewer = async () => ({ error: 'llm_http_404', text: '', usage: {} });
  const s = mkState();
  for (let i = 0; i < 3; i++) {
    const r = await reviewTurn(CFG, TARGET, '增量内容', false, { callReviewer });
    applyReviewOutcome(s, r, EFF, CFG);
    if (i < 2) assert.ok(!s.halted);
  }
  assert.strictEqual(s.halted, true);
  assert.strictEqual(s.haltedModel, 'primary-model');
});

test('停机：主模型 404 但备用救回 → 不停机、连击清零', async () => {
  const callReviewer = async (p) => (p.model === 'primary-model'
    ? { error: 'llm_http_404', text: '', usage: {} }
    : { text: FRAME_TEXT, usage: {} });
  const s = mkState();
  for (let i = 0; i < 4; i++) applyReviewOutcome(s, await reviewTurn(CFG, TARGET, 'x', false, { callReviewer }), EFF, CFG);
  assert.ok(!s.halted);
  assert.strictEqual(s.primary404Streak, 0);
});

test('ctl on 清停机并清 404 连击', (t) => {
  const { stateDir } = setupDir(t, 'zcadv-fix-on-');
  const env = makeEnv(stateDir);
  const file = path.join(stateDir, 'sess-h.json');
  fs.writeFileSync(file, JSON.stringify({
    schema: 1, sessionId: 'h', enabled: true, pendingNotes: [],
    halted: true, haltedReason: 'llm_http_404', primary404Streak: 3, haltEpoch: 1
  }));
  const r = runHook(['ctl', 'on', '--state', file], null, env);
  assert.strictEqual(r.status, 0);
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(s.halted, false);
  assert.strictEqual(s.primary404Streak, 0);
  assert.strictEqual(s.haltEpoch, 2, '恢复 bump haltEpoch（在飞 worker 据此作废）');
});

// ---------------- 2) 过期 worker 结果作废 ----------------

async function runWorkerAgainstServer(t, mutateDuringReview) {
  const { stateDir, transcript } = setupDir(t, 'zcadv-fix-stale-');
  let env;
  let file;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (mutateDuringReview) mutateDuringReview(env, file);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: '{"severity":"concern","note":"过期意见不应入队"}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 }
      }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const port = server.address().port;
  env = makeEnv(stateDir, {
    provider: {
      'prov-fix': {
        name: 'FIX 网关', kind: 'openai-compatible',
        options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'fix-key-abc123-not-placeholder' },
        models: { 'fix-model': {}, 'other-model': {} }
      }
    }
  });
  delete env.ZCODE_ADVISOR_MOCK; // 走真实（本地）HTTP 路径
  runHook(['session-start'], { session_id: 'st', transcript_path: transcript }, env);
  file = path.join(stateDir, 'sess-st.json');
  const child = spawn(process.execPath, [HOOK, 'review-worker', '--state', file, '--transcript', transcript], { env, stdio: 'ignore' });
  const code = await new Promise((r) => child.on('exit', r));
  assert.strictEqual(code, 0);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('worker：审查期间无变更 → 正常入队（对照组）', async (t) => {
  const s = await runWorkerAgainstServer(t, null);
  assert.strictEqual(s.pendingNotes.length, 1);
  assert.strictEqual(s.reviews, 1);
});

test('worker：审查期间 model set → 结果作废，不入队', async (t) => {
  const s = await runWorkerAgainstServer(t, (env, file) => {
    const r = spawnSync(process.execPath, [HOOK, 'ctl', 'model', 'set', 'other-model', '--state', file], { env, encoding: 'utf8' });
    assert.strictEqual(r.status, 0);
  });
  assert.strictEqual(s.sessionModel, 'other-model');
  assert.strictEqual((s.pendingNotes || []).length, 0, '旧模型的审查结果不得入队');
  assert.strictEqual(s.lastAction, 'discarded_stale');
});

test('worker：审查期间 /advisor-off → 结果作废，不入队', async (t) => {
  const s = await runWorkerAgainstServer(t, (env, file) => {
    spawnSync(process.execPath, [HOOK, 'ctl', 'off', '--state', file], { env, encoding: 'utf8' });
  });
  assert.strictEqual(s.enabled, false);
  assert.strictEqual((s.pendingNotes || []).length, 0);
  assert.strictEqual(s.lastAction, 'discarded_stale');
});

// ---------------- 3) transcript 末行 ----------------

test('readDelta：无换行末行默认不消费；final 时可解析则消费，残缺仍不消费', (t) => {
  const { dir } = setupDir(t, 'zcadv-fix-tail-');
  const f = path.join(dir, 't.jsonl');
  const l1 = JSON.stringify({ type: 'user', message: { role: 'user', content: '问题' } });
  const l2 = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: '最新回复' } });
  fs.writeFileSync(f, `${l1}\n${l2}`);
  const normal = readDelta(f, 0, {});
  assert.strictEqual(normal.entries.length, 1, '默认：残行不消费');
  const fin = readDelta(f, 0, { final: true });
  assert.strictEqual(fin.entries.length, 2, 'final：完整末行消费');
  assert.strictEqual(fin.entries[1].parts[0].text, '最新回复');
  fs.writeFileSync(f, `${l1}\n${l2.slice(0, 20)}`);
  assert.strictEqual(readDelta(f, 0, { final: true }).entries.length, 1, 'final：残缺 JSON 仍不消费');
});

// ---------------- 4) 快照去重 ----------------

test('快照模式：同一意见重审不重复入队', (t) => {
  const { stateDir, transcript } = setupDir(t, 'zcadv-fix-dedupe-');
  fs.writeFileSync(path.join(stateDir, '.mock-allowed'), '1');
  const env = makeEnv(stateDir, null, { ZCODE_ADVISOR_MOCK_FRAME: '{"severity":"concern","note":"同一条意见"}' });
  runHook(['session-start'], { session_id: 'dd', transcript_path: transcript }, env);
  const file = path.join(stateDir, 'sess-dd.json');
  runHook(['review-worker', '--state', file, '--transcript', transcript], null, env);
  let s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(s.pendingNotes.length, 1);
  // 模拟 UPS 已送达（清队列），下一轮快照重审同一转录
  s.pendingNotes = [];
  fs.writeFileSync(file, JSON.stringify(s));
  runHook(['review-worker', '--state', file, '--transcript', transcript], null, env);
  s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(s.pendingNotes.length, 0, '已送达意见不得再次入队');
  assert.strictEqual(s.lastAction, 'deduped:concern');
  assert.strictEqual(s.deliveredNoteHashes.length, 1);
});

// ---------------- 5) Stop 传 --transcript ----------------

test('Stop（async，ZCode 快照）：派生 worker 参数含 --transcript <快照路径>', (t) => {
  const { stateDir, transcript } = setupDir(t, 'zcadv-fix-args-');
  fs.writeFileSync(path.join(stateDir, '.mock-allowed'), '1');
  const argsFile = path.join(stateDir, 'spawn-args.json');
  const env = makeEnv(stateDir, null, { ZCODE_ADVISOR_SPAWN_ARGS_FILE: argsFile, ZCODE_ADVISOR_REVIEW_MODE: 'async' });
  runHook(['session-start'], { session_id: 'sa', transcript_path: transcript }, env);
  const r = runHook(['stop'], { session_id: 'sa', transcript_path: transcript, stop_hook_active: false }, env);
  assert.strictEqual(r.status, 0);
  assert.ok(fs.existsSync(argsFile), '应写出 worker 参数');
  const args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
  assert.strictEqual(args[0], 'review-worker');
  const i = args.indexOf('--transcript');
  assert.ok(i !== -1, '必须传 --transcript');
  const snap = args[i + 1];
  assert.strictEqual(path.dirname(snap), path.join(stateDir, 'snapshots'));
  assert.ok(fs.readFileSync(snap, 'utf8').includes('帮我实现一个功能'));
});
