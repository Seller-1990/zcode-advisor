'use strict';

// 会话级审查目标覆盖（0.2.17 起为「服务商 + 模型」，取代旧 /advisor-api 的端点/key 覆盖）。
// 覆盖：state.sessionProvider/sessionModel 持久化、门禁按会话级值放行、worker 实际用覆盖值、
// reset 清除、官方内置/不兼容服务商被拒绝。
// 端点与 key 永远由服务商解析得到——本文件不再断言任何会话级 key 落盘。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.resolve(__dirname, '..', 'hooks', 'advisor-hook.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'transcript-basic.jsonl');

// ZCode 服务商 fixture：一个可用的第三方 + 一个不兼容 + 一个官方内置
function writeZcodeConfig(dir) {
  const file = path.join(dir, 'zcode-v2.json');
  fs.writeFileSync(file, JSON.stringify({
    provider: {
      'prov-a': {
        name: '第三方A',
        kind: 'openai-compatible',
        options: { baseURL: 'http://10.0.0.9:9000/v1', apiKey: 'sk-prov-a-key-999' },
        models: { 'model-a1': {}, 'model-a2': {} }
      },
      'prov-b': {
        name: '第三方B',
        kind: 'openai',
        options: { baseURL: 'http://10.0.0.10:9000/v1', apiKey: 'sk-prov-b-key-888' },
        models: { 'model-b1': {} }
      },
      'builtin:bigmodel': {
        name: 'BigModel 官方',
        kind: 'openai',
        options: { baseURL: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'sk-official' },
        models: { 'glm-5.3': {} }
      }
    }
  }));
  return file;
}

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-sapi-'));
  const transcript = path.join(dir, 'transcript.jsonl');
  fs.copyFileSync(FIXTURE, transcript);
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, '.mock-allowed'), '1');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });
  return { dir, transcript, stateDir, zcodeCfg: writeZcodeConfig(dir) };
}

function makeEnv(stateDir, zcodeCfg, extra) {
  return Object.assign({}, process.env, {
    ZCODE_ADVISOR_STATE_DIR: stateDir,
    ZCODE_ADVISOR_NO_SPAWN: '1',
    // 隔离本机真实配置：用户级配置为空、ZCode 服务商用 fixture
    ZCODE_ADVISOR_USER_CONFIG: path.join(stateDir, 'no-user.json'),
    ZCODE_ADVISOR_ZCODE_CONFIG: zcodeCfg,
    // 隔离 provider_config.json（第二个数据源），避免读开发机真实配置。
    ZCODE_ADVISOR_ZCODE_PROVIDER_CONFIG: path.join(stateDir, 'no-such-provider-config.json')
  }, extra || {});
}

function runHook(args, stdinObj, env) {
  return spawnSync(process.execPath, [HOOK, ...args], {
    input: stdinObj ? JSON.stringify(stdinObj) : '',
    env, encoding: 'utf8', timeout: 60000
  });
}

function stateFile(stateDir, sid) { return path.join(stateDir, `sess-${sid}.json`); }
function readState(stateDir, sid) { return JSON.parse(fs.readFileSync(stateFile(stateDir, sid), 'utf8')); }

test('ctl model set：会话级服务商+模型落 state（不落任何端点/key）', (t) => {
  const { transcript, stateDir, zcodeCfg } = setup(t);
  runHook(['session-start'], { session_id: 'a1', transcript_path: transcript }, makeEnv(stateDir, zcodeCfg));
  const r = runHook(['ctl', 'model', 'set', 'model-b1', 'provider:prov-b', '--state', stateFile(stateDir, 'a1')],
    null, makeEnv(stateDir, zcodeCfg));
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /服务商=prov-b/);
  assert.match(r.stdout, /模型=model-b1/);
  const st = readState(stateDir, 'a1');
  assert.strictEqual(st.sessionProvider, 'prov-b');
  assert.strictEqual(st.sessionModel, 'model-b1');
  // 关键：状态文件不得出现任何 key 明文（0.2.17 起端点/key 只来自服务商解析）
  assert.strictEqual('sessionApi' in st, false, '旧 sessionApi 面应已移除');
  assert.ok(!JSON.stringify(st).includes('sk-prov-b-key-888'), 'state 不得落 key 明文');
});

test('ctl model provider：只换服务商，旧模型一并清掉（回落该服务商清单）', (t) => {
  const { transcript, stateDir, zcodeCfg } = setup(t);
  const env = makeEnv(stateDir, zcodeCfg);
  runHook(['session-start'], { session_id: 'a2', transcript_path: transcript }, env);
  runHook(['ctl', 'model', 'set', 'model-a1', 'provider:prov-a', '--state', stateFile(stateDir, 'a2')], null, env);
  runHook(['ctl', 'model', 'provider', 'prov-b', '--state', stateFile(stateDir, 'a2')], null, env);
  const st = readState(stateDir, 'a2');
  assert.strictEqual(st.sessionProvider, 'prov-b');
  assert.strictEqual(st.sessionModel, '', '换服务商后旧模型多半不属于它，应清空');
});

test('ctl model reset：清除覆盖，回落全局默认', (t) => {
  const { transcript, stateDir, zcodeCfg } = setup(t);
  const env = makeEnv(stateDir, zcodeCfg);
  runHook(['session-start'], { session_id: 'a3', transcript_path: transcript }, env);
  runHook(['ctl', 'model', 'set', 'model-b1', 'provider:prov-b', '--state', stateFile(stateDir, 'a3')], null, env);
  const reset = runHook(['ctl', 'model', 'reset', '--state', stateFile(stateDir, 'a3')], null, env);
  assert.match(reset.stdout, /回到全局默认/);
  const st = readState(stateDir, 'a3');
  assert.strictEqual(st.sessionProvider, '');
  assert.strictEqual(st.sessionModel, '');
});

test('门禁放行：全局不指定服务商 + 会话固定服务商 → 该会话可审查（无需任何会话级 key）', (t) => {
  const { transcript, stateDir, zcodeCfg } = setup(t);
  const env = makeEnv(stateDir, zcodeCfg, {
    ZCODE_ADVISOR_MOCK: '1',
    ZCODE_ADVISOR_REVIEW_MODE: 'sync',
    ZCODE_ADVISOR_MOCK_FRAME: '{"severity":"concern","note":"会话级服务商场景"}'
  });
  runHook(['session-start'], { session_id: 'a4', transcript_path: transcript }, env);
  // 全局自动选择也能解析出服务商 → 直接就该能审查（凭据来自 ZCode，不再需要会话级 key）
  const pass = runHook(['stop'], { session_id: 'a4', transcript_path: transcript, stop_hook_active: false }, env);
  assert.match(pass.stdout, /"decision":"block"/, '应放行门禁并完成审查');
  assert.match(pass.stdout, /会话级服务商场景/);
  assert.strictEqual(readState(stateDir, 'a4').reviews, 1);
});

test('门禁拒绝：只有官方内置服务商时明确不放行（不借道官方通道）', (t) => {
  const { transcript, stateDir, dir } = setup(t);
  // 只留官方内置通道的配置
  const officialOnly = path.join(dir, 'zcode-official-only.json');
  fs.writeFileSync(officialOnly, JSON.stringify({
    provider: {
      'builtin:bigmodel': {
        name: 'BigModel 官方', kind: 'openai',
        options: { baseURL: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'sk-official' },
        models: { 'glm-5.3': {} }
      }
    }
  }));
  const env = makeEnv(stateDir, officialOnly, { ZCODE_ADVISOR_MOCK: '1' });
  runHook(['session-start'], { session_id: 'a5', transcript_path: transcript }, env);
  const st = readState(stateDir, 'a5');
  const gateLine = runHook(['ctl', 'status', '--state', stateFile(stateDir, 'a5')], null, env);
  assert.match(gateLine.stdout, /门禁: 未满足/, '官方内置通道不得放行审查');
  assert.match(gateLine.stdout, /zcode_provider_missing|官方内置/, `应给出可操作原因：\n${gateLine.stdout}`);
  assert.ok(st.enabled);
});

test('status：显示会话覆盖行与生效服务商/模型（不回显任何 key）', (t) => {
  const { transcript, stateDir, zcodeCfg } = setup(t);
  const env = makeEnv(stateDir, zcodeCfg);
  runHook(['session-start'], { session_id: 'a6', transcript_path: transcript }, env);
  runHook(['ctl', 'model', 'set', 'model-b1', 'provider:prov-b', '--state', stateFile(stateDir, 'a6')], null, env);
  const r = runHook(['ctl', 'status', '--state', stateFile(stateDir, 'a6')], null, env);
  assert.match(r.stdout, /会话覆盖: 服务商 \+ 模型|会话覆盖/);
  assert.match(r.stdout, /第三方B|prov-b/);
  assert.match(r.stdout, /model-b1/);
  // key 明文永不出现（只允许掩码形式）
  assert.ok(!r.stdout.includes('sk-prov-b-key-888'), 'status 不得回显 key 明文');
  assert.ok(!/门禁: 未满足/.test(r.stdout), `会话覆盖后门禁应满足，实际输出：\n${r.stdout}`);
});

test('worker 传参：review-worker 收到会话覆盖目标（--transcript 快照路径保留）', () => {
  const src = fs.readFileSync(HOOK, 'utf8');
  assert.ok(src.includes('function effectiveApi('), 'effectiveApi 应存在');
  assert.match(src, /const eff = effectiveApi\(cfg, apiKeyInfo, (current|state)\);/);
  assert.ok(!src.includes('reviewTurn(cfg, apiKeyInfo,'), 'reviewTurn 不得再直接吃 apiKeyInfo（旧签名）');
  // 旧 /advisor-api 会话端点覆盖面应彻底移除（用户明确要求取消第三方 API 适配）
  assert.ok(!/sub === 'api'/.test(src), 'ctl api 子命令应已移除');
});

test('会话覆盖三键场景：全局无服务商可解析 + 会话固定服务商 → worker 用生效值审查', (t) => {
  const { transcript, stateDir, dir } = setup(t);
  // 全局配置里没有任何可用服务商（只有不兼容的 anthropic）
  const noUsable = path.join(dir, 'zcode-no-usable.json');
  fs.writeFileSync(noUsable, JSON.stringify({
    provider: {
      'prov-anthropic': {
        name: 'Anthropic 中转', kind: 'anthropic',
        options: { baseURL: 'https://relay.example.com', apiKey: 'sk-ant' },
        models: { 'claude-opus-5': {} }
      }
    }
  }));
  // 会话覆盖要指向一个可用服务商：把它放进同一份配置里，但不指定全局 zcodeProvider
  const mixed = path.join(dir, 'zcode-mixed.json');
  fs.writeFileSync(mixed, JSON.stringify({
    provider: {
      'prov-anthropic': {
        name: 'Anthropic 中转', kind: 'anthropic',
        options: { baseURL: 'https://relay.example.com', apiKey: 'sk-ant' },
        models: { 'claude-opus-5': {} }
      },
      'prov-a': {
        name: '第三方A', kind: 'openai-compatible',
        options: { baseURL: 'http://10.0.0.9:9000/v1', apiKey: 'sk-prov-a-key-999' },
        models: { 'model-a1': {} }
      }
    }
  }));
  const env = makeEnv(stateDir, mixed, {
    ZCODE_ADVISOR_MOCK: '1',
    ZCODE_ADVISOR_MOCK_FRAME: '{"severity":"nit","note":"async worker 生效值场景"}'
  });
  runHook(['session-start'], { session_id: 'a7', transcript_path: transcript }, env);
  const r = runHook(['ctl', 'model', 'set', 'model-a1', 'provider:prov-a', '--state', stateFile(stateDir, 'a7')], null, env);
  assert.strictEqual(r.status, 0);
  // 直接走真实 worker 入口（async 模式下 Stop 只负责 spawn，门禁在 worker 内）
  const w = runHook(['review-worker', '--state', stateFile(stateDir, 'a7')], null, env);
  assert.strictEqual(w.status, 0, `worker 应成功：${w.stderr}`);
  const st = readState(stateDir, 'a7');
  assert.strictEqual(st.reviews, 1, `worker 应完成审查，disabledReason=${st.disabledReason}`);
  assert.strictEqual(st.disabledReason || '', '', 'worker 放行后不得残留 disabledReason');
});

// —— 0.2.17 修复：env 逃生舱必须成对覆盖（防密钥交叉复活） ——

test('env 逃生舱：只给 BASE_URL 不给 API_KEY → 整体不生效并挂 problem（防服务商 key 发往 env 端点）', (t) => {
  const { transcript, stateDir, zcodeCfg } = setup(t);
  const env = makeEnv(stateDir, zcodeCfg, {
    // 只设端点：若生效，就会把服务商 A 的 key 发往这个 env 端点 = 密钥交叉
    ZCODE_ADVISOR_BASE_URL: 'http://evil.example/v1/chat/completions'
  });
  runHook(['session-start'], { session_id: 'e1', transcript_path: transcript }, env);
  const r = runHook(['ctl', 'status', '--state', stateFile(stateDir, 'e1')], null, env);
  // 端点必须仍来自服务商（未被 env 单独改掉）
  assert.match(r.stdout, /端点: http:\/\/10\.0\.0\.9:9000\/v1/, `端点不得被半截 env 覆盖：\n${r.stdout}`);
  assert.match(r.stdout, /env_override_incomplete/, '应挂 problem 让用户看见');
});

test('env 逃生舱：BASE_URL 与 API_KEY 成对提供 → 正常生效', (t) => {
  const { transcript, stateDir, zcodeCfg } = setup(t);
  const env = makeEnv(stateDir, zcodeCfg, {
    ZCODE_ADVISOR_BASE_URL: 'http://127.0.0.1:9999/v1/chat/completions',
    ZCODE_ADVISOR_API_KEY: 'env-paired-key'
  });
  runHook(['session-start'], { session_id: 'e2', transcript_path: transcript }, env);
  const r = runHook(['ctl', 'status', '--state', stateFile(stateDir, 'e2')], null, env);
  assert.match(r.stdout, /端点: http:\/\/127\.0\.0\.1:9999\/v1/, `成对时 env 应生效：\n${r.stdout}`);
  assert.match(r.stdout, /env:ZCODE_ADVISOR_API_KEY/, 'key 来源应标为 env');
});
