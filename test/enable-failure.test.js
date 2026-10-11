'use strict';

// R13：enable.sh 只对 `plugins install` 检查了退出码，对 `marketplace update` 与
// `plugins enable` 完全没有检查——这两步失败时脚本仍会打印「完成。新开 ZCode 会话
// 即自动启用审查。」并 exit 0，用户看到成功、实际插件未启用（假成功）。
// 本用例锁死「失败必须非零退出且不得报完成」这一不变量。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const source = fs.readFileSync(path.join(__dirname, '..', 'enable.sh'), 'utf8');

function runFixture(failingStep) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enable-fail-fixture-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const node = path.join(dir, 'node');
  fs.writeFileSync(node, '#!/bin/sh\nif [ "$1" = "-v" ]; then echo v24-mock; fi\nexit 0\n', { mode: 0o755 });
  const start = source.indexOf('echo "✓ ZCode CLI:');
  assert.ok(start >= 0, 'fixture 只运行前置宿主查找之后的脚本正文');
  // run_cli 替身：只让指定步骤返回 8（非零），其余步骤成功。
  const body = 'set -uo pipefail\nNO_COMPANION=1\n'
    + 'run_cli() {\n'
    + '  case "$*" in\n'
    + `    *"${failingStep}"*) return 8 ;;\n`
    + '    *) return 0 ;;\n'
    + '  esac\n'
    + '}\n'
    + source.slice(start);
  try {
    const result = spawnSync('bash', ['-c', body], {
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, ROOT: dir, HOME: home, ZC: 'mock-cli', NODE_BIN: node, LANG: '', LC_ALL: '', LC_CTYPE: 'C.UTF-8' },
    });
    assert.ifError(result.error);
    return result;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const step of ['marketplace update', 'plugins enable']) {
  test(`enable.sh：${step} 失败时不得报「完成」（R13）`, {
    skip: process.platform === 'win32' ? 'enable.sh 仅供 macOS/POSIX；此处不调用真实宿主' : false,
  }, () => {
    const result = runFixture(step);
    assert.strictEqual(result.status, 1,
      `「${step}」返回非零时脚本仍 exit ${result.status}（假成功）\n--- stdout ---\n${result.stdout}`);
    assert.doesNotMatch(result.stdout, /完成。新开 ZCode 会话即自动启用审查。/,
      `「${step}」失败时不得打印「完成」`);
  });
}
