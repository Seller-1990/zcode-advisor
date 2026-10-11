'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const source = fs.readFileSync(path.join(__dirname, '..', 'enable.sh'), 'utf8');

test('enable.sh：带空格 Node 路径与非英文标点可用，模板只含行为配置', {
  skip: process.platform === 'win32' ? 'enable.sh 仅供 macOS/POSIX；此处不调用真实宿主' : false,
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enable-fixture-'));
  const home = path.join(dir, 'home');
  const nodeDir = path.join(dir, 'node with spaces');
  fs.mkdirSync(home);
  fs.mkdirSync(nodeDir);
  const node = path.join(nodeDir, 'node');
  fs.writeFileSync(node, '#!/bin/sh\nif [ "$1" = "-v" ]; then echo v24-mock; fi\nexit 0\n', { mode: 0o755 });
  const start = source.indexOf('echo "✓ ZCode CLI:');
  assert.ok(start >= 0, 'fixture 只运行前置宿主查找之后的脚本正文');
  const body = `set -uo pipefail\nNO_COMPANION=1\nrun_cli() { return 0; }\n${source.slice(start)}`;
  const config = path.join(home, '.zcode', 'advisor.config.json');
  try {
    const run = () => spawnSync('bash', ['-c', body], {
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, ROOT: dir, HOME: home, ZC: 'mock-cli', NODE_BIN: node, LANG: '', LC_ALL: '', LC_CTYPE: 'C.UTF-8' },
    });
    const result = run();
    assert.ifError(result.error);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /v24-mock/);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(config, 'utf8')), { enabled: true, reviewMode: 'async' });
    const existing = '{"enabled":false,"reviewMode":"sync"}\n';
    fs.writeFileSync(config, existing);
    const second = run();
    assert.ifError(second.error);
    assert.strictEqual(second.status, 0, second.stderr);
    assert.strictEqual(fs.readFileSync(config, 'utf8'), existing, '不得覆盖已有用户选择');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
