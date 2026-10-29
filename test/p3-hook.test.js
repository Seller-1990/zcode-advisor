'use strict';

// P3 审计修复回归：
// 1) enqueueNote 队满时 concern/blocker 挤掉最旧的 nit，而不是丢弃新的紧急意见。
// 2) worker 门禁放行后清掉盘上残留的 disabledReason（此前只改本地副本，不落盘）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { enqueueNote, decideActionAsync } = require('../hooks/lib/route');

const HOOK = path.join(__dirname, '..', 'hooks', 'advisor-hook.js');
const CFG = { pendingNotesCap: 3 };

test('enqueueNote：队满 + concern → 挤掉最旧的 nit，新意见入队', () => {
  const state = { pendingNotes: ['[advisor:concern] c0', '[advisor:nit] n1', '[advisor:nit:deferred] n2'] };
  const drops = [];
  const ok = enqueueNote(state, '[advisor:concern] new', CFG, (r) => drops.push(r));
  assert.strictEqual(ok, true);
  assert.deepStrictEqual(state.pendingNotes, ['[advisor:concern] c0', '[advisor:nit:deferred] n2', '[advisor:concern] new']);
  assert.deepStrictEqual(drops, ['queue_overflow'], '被挤掉的 nit 计一次 queue_overflow');
});

test('enqueueNote：队满 + blocker 但无 nit 可挤 → 丢弃新意见', () => {
  const state = { pendingNotes: ['[advisor:concern] a', '[advisor:blocker] b', '[advisor:user:ack] c'] };
  const drops = [];
  assert.strictEqual(enqueueNote(state, '[advisor:blocker] new', CFG, (r) => drops.push(r)), false);
  assert.strictEqual(state.pendingNotes.length, 3);
  assert.ok(!state.pendingNotes.includes('[advisor:blocker] new'));
  assert.deepStrictEqual(drops, ['queue_overflow']);
});

test('enqueueNote：队满 + 新 nit → 照旧丢弃新 nit（不挤别的 nit）', () => {
  const state = { pendingNotes: ['[advisor:nit] a', '[advisor:nit] b', '[advisor:nit] c'] };
  assert.strictEqual(enqueueNote(state, '[advisor:nit] new', CFG, () => {}), false);
  assert.deepStrictEqual(state.pendingNotes, ['[advisor:nit] a', '[advisor:nit] b', '[advisor:nit] c']);
});

test('decideActionAsync：不再依赖 cfg 参数', () => {
  assert.deepStrictEqual(decideActionAsync({ severity: 'concern' }, { immuneTurns: 2 }), { deliver: 'queue', deferred: true });
  assert.deepStrictEqual(decideActionAsync({ severity: 'bogus' }, {}), { deliver: 'none' });
});

test('review-worker：门禁放行后清掉盘上残留的 disabledReason', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-p3-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const zcodeCfg = path.join(dir, 'zcode.json');
  fs.writeFileSync(zcodeCfg, JSON.stringify({
    provider: {
      'prov-p3': {
        name: 'P3 网关', kind: 'openai-compatible',
        options: { baseURL: 'http://127.0.0.1:1/v1', apiKey: 'p3-key-abc123-not-placeholder' },
        models: { 'p3-model': {} }
      }
    }
  }));
  const file = path.join(stateDir, 'sess-p3.json');
  fs.writeFileSync(file, JSON.stringify({
    schema: 1, sessionId: 'p3', enabled: true, pendingNotes: [], halted: false,
    disabledReason: 'missing:apiKey',
    // 不存在的转录：门禁通过后 readDelta 报 missing 即返回，无需真实审查
    transcriptPath: path.join(dir, 'no-such-transcript.jsonl'), byteOffset: 0
  }));
  const env = Object.assign({}, process.env, {
    ZCODE_ADVISOR_STATE_DIR: stateDir,
    ZCODE_ADVISOR_USER_CONFIG: path.join(dir, 'no-user-config.json'),
    ZCODE_ADVISOR_ZCODE_CONFIG: zcodeCfg,
    ZCODE_ADVISOR_ZCODE_PROVIDER_CONFIG: path.join(dir, 'no-provider-config.json'),
    ZCODE_ADVISOR_HISTORY: path.join(dir, 'history.jsonl'),
    ZCODE_ADVISOR_HEALTH_DIR: path.join(dir, 'health'),
    ZCODE_ADVISOR_COMPANION_TMP: path.join(dir, 'companion-tmp')
  });
  for (const k of ['ZCODE_ADVISOR_BASE_URL', 'ZCODE_ADVISOR_API_KEY', 'ZCODE_ADVISOR_MODEL', 'ZCODE_ADVISOR_MOCK']) delete env[k];
  const r = spawnSync(process.execPath, [HOOK, 'review-worker', '--state', file], { env, encoding: 'utf8', timeout: 20000 });
  assert.strictEqual(r.status, 0, r.stderr);
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(s.disabledReason || '', '', '门禁放行后盘上不得残留旧 disabledReason');
  assert.ok(s.dropped && s.dropped.no_transcript >= 1, '应走到 readDelta（证明门禁已放行）');
});
