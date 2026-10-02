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
