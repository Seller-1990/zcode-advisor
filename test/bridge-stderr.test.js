'use strict';

// D2 回归：桥接进程在环境变量表单值与已保存 key 不一致时，stderr 应有一行指路提示
// （main() 只在 require.main 下运行，因此用子进程验证，模块级测试覆盖不到）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function runBridge(env, userConfigPath) {
  return spawnSync(process.execPath, [path.join(ROOT, 'tools', 'config-bridge.js')], {
    env: Object.assign({}, process.env, {
      ZCODE_ADVISOR_USER_CONFIG: userConfigPath,
      ZCODE_ADVISOR_PANEL_NO_OPEN: '1',
      // MCP stdio 服务无输入即退出（stdin end → exit(0)）
      ZCODE_ADVISOR_BRIDGE_VERBOSE: ''
    }, env),
    input: '',
    encoding: 'utf8',
    timeout: 10000
  });
}

test('桥接 stderr：表单 key 与已保存 key 不同 → 一行冲突提示', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-stderr-'));
  const file = path.join(dir, 'advisor.config.json');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });
  fs.writeFileSync(file, JSON.stringify({ apiKey: 'saved-key' }), 'utf8');

  const r = runBridge({ ZCODE_ADVISOR_CFG_API_KEY: 'form-key' }, file);
  assert.match(r.stderr, /apiKey 与已保存配置不一致/, `应有冲突提示：\n${r.stderr}`);
  // 冲突不落盘：保存的 key 必须原样保留（fillMissingOnly 纪律）
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).apiKey, 'saved-key');
});

test('桥接 stderr：等值稳态（表单默认 === 已保存）→ 无冲突提示', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-stderr-'));
  const file = path.join(dir, 'advisor.config.json');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });
  fs.writeFileSync(file, JSON.stringify({ apiKey: 'same-key' }), 'utf8');

  const r = runBridge({ ZCODE_ADVISOR_CFG_API_KEY: 'same-key' }, file);
  assert.doesNotMatch(r.stderr, /不一致/, `等值不应误报：\n${r.stderr}`);
});

test('桥接 stderr：表单模型覆盖已保存模型 → 一行指路提示（forceKeys 语义）', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-stderr-'));
  const file = path.join(dir, 'advisor.config.json');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });
  fs.writeFileSync(file, JSON.stringify({ model: 'glm-5.3-flash' }), 'utf8');

  const r = runBridge({ ZCODE_ADVISOR_CFG_MODEL: 'kimi-k3' }, file);
  assert.match(r.stderr, /模型.*已作为全局模型写入/, `应有覆盖提示：\n${r.stderr}`);
  // model 是 forceKeys：覆盖语义，落盘的是表单值
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).model, 'kimi-k3');
});

test('桥接 stderr：表单模型与已保存等值 → 稳态无提示', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-stderr-'));
  const file = path.join(dir, 'advisor.config.json');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });
  fs.writeFileSync(file, JSON.stringify({ model: 'kimi-k3' }), 'utf8');

  const r = runBridge({ ZCODE_ADVISOR_CFG_MODEL: 'kimi-k3' }, file);
  assert.doesNotMatch(r.stderr, /已作为全局模型写入/, `等值不应误报：\n${r.stderr}`);
});

test('桥接 stderr：损坏文件 → 拒绝写入并提示，绝不静默重建蒸发 apiKey', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-stderr-'));
  const file = path.join(dir, 'advisor.config.json');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });
  fs.writeFileSync(file, '{"apiKey": "saved-key",,,', 'utf8');

  const r = runBridge({ ZCODE_ADVISOR_CFG_MODEL: 'kimi-k3' }, file);
  assert.match(r.stderr, /已损坏/, `应提示损坏：\n${r.stderr}`);
  assert.doesNotMatch(r.stderr, /已作为全局模型写入/, '损坏路径决不能报覆盖成功：\n' + r.stderr);
  // 文件原样保留：半截 JSON 不被「仅表单值」的重建替换掉
  assert.match(fs.readFileSync(file, 'utf8'), /apiKey/, '损坏文件不应被改写');
});

test('桥接 stderr：model 覆盖与 apiKey 冲突同时成立 → 两行提示并存（互斥链回归）', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-stderr-'));
  const file = path.join(dir, 'advisor.config.json');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });
  fs.writeFileSync(file, JSON.stringify({ apiKey: 'saved-key', model: 'glm-5.3-flash' }), 'utf8');

  const r = runBridge({ ZCODE_ADVISOR_CFG_MODEL: 'kimi-k3', ZCODE_ADVISOR_CFG_API_KEY: 'form-key' }, file);
  assert.match(r.stderr, /已作为全局模型写入/, `应有 model 覆盖提示：\n${r.stderr}`);
  assert.match(r.stderr, /apiKey 与已保存配置不一致/, 'model 提示不得吞掉 apiKey 提示：\n' + r.stderr);
});
