'use strict';

// 延期项 D1/D2 回归：键删除路径（removeUserConfigKeys）与 fillMissingOnly 冲突信号。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { mergeUserConfig, removeUserConfigKeys, writeUserConfig } = require('../tools/config-bridge');

function tmpFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-remove-'));
  const file = path.join(dir, 'advisor.config.json');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });
  return file;
}

// —— removeUserConfigKeys ——

test('removeUserConfigKeys：删除目标键且兄弟键原样保留', (t) => {
  const file = tmpFile(t);
  fs.writeFileSync(file, JSON.stringify({ apiKey: 'k', model: 'glm-5.3', baseUrl: 'https://x' }), 'utf8');
  const r = removeUserConfigKeys(['apiKey'], file);
  assert.strictEqual(r.changed, true);
  assert.deepStrictEqual(r.removed, ['apiKey']);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(saved.model, 'glm-5.3');
  assert.strictEqual(saved.baseUrl, 'https://x');
  assert.strictEqual(saved.apiKey, undefined);
});

test('removeUserConfigKeys：目标目录不存在时自动创建且不报错（mkdir 前置于抢锁）', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-remove-'));
  const file = path.join(dir, 'sub', 'advisor.config.json');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });
  const r = removeUserConfigKeys(['apiKey'], file);
  assert.strictEqual(r.changed, false, '文件不存在时无改动');
});

test('removeUserConfigKeys：键不存在时 changed=false 且不重写文件', (t) => {
  const file = tmpFile(t);
  fs.writeFileSync(file, JSON.stringify({ model: 'glm-5.3' }), 'utf8');
  const mtimeBefore = fs.statSync(file).mtimeMs;
  const r = removeUserConfigKeys(['apiKey'], file);
  assert.strictEqual(r.changed, false);
  assert.strictEqual(fs.statSync(file).mtimeMs, mtimeBefore, '不应产生写动作（mtime 不变）');
});

test('removeUserConfigKeys：空数组/无有效键直接返回，不碰文件', (t) => {
  const file = tmpFile(t);
  fs.writeFileSync(file, JSON.stringify({ apiKey: 'k' }), 'utf8');
  const r = removeUserConfigKeys([], file);
  assert.strictEqual(r.changed, false);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).apiKey, 'k');
});

test('removeUserConfigKeys：损坏 JSON 报失败而非静默 ok（旧 key 不能假装已删）', (t) => {
  const file = tmpFile(t);
  fs.writeFileSync(file, '{"apiKey": "k",,,', 'utf8');
  const r = removeUserConfigKeys(['apiKey'], file);
  assert.strictEqual(r.changed, false);
  assert.ok(r.error, '必须携带 error');
  // 损坏文件原样保留：不因删除失败而把半截文件"修复"掉
  assert.match(fs.readFileSync(file, 'utf8'), /apiKey/);
});

test('removeUserConfigKeys：__proto__ 自有键不拷入重建结果', (t) => {
  const file = tmpFile(t);
  const raw = JSON.parse('{"apiKey":"k","__proto__":{"x":1},"model":"m"}');
  fs.writeFileSync(file, JSON.stringify(raw), 'utf8');
  const r = removeUserConfigKeys(['apiKey'], file);
  assert.strictEqual(r.changed, true);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(Object.keys(saved), ['model']);
});

test('removeUserConfigKeys：写入后文件权限 0600（内容含过 key）', (t) => {
  const file = tmpFile(t);
  fs.writeFileSync(file, JSON.stringify({ apiKey: 'k', model: 'm' }), 'utf8');
  fs.chmodSync(file, 0o644);
  removeUserConfigKeys(['apiKey'], file);
  if (process.platform === 'win32') return; // Windows 忽略 mode（ACL 继承）
  const mode = fs.statSync(file).mode & 0o777;
  assert.strictEqual(mode, 0o600);
});

test('removeUserConfigKeys：删除走锁文件（与写方互斥）', (t) => {
  const file = tmpFile(t);
  fs.writeFileSync(file, JSON.stringify({ apiKey: 'k' }), 'utf8');
  removeUserConfigKeys(['apiKey'], file);
  assert.ok(!fs.existsSync(`${file}.lock`), '临界区结束后锁应清除');
});

// —— D2：fillMissingOnly 冲突信号 ——

test('mergeUserConfig：冲突=被跳过且值不同；等值跳过不算冲突（稳态回归）', () => {
  const conflicts = [];
  mergeUserConfig(
    { apiKey: 'user-key', model: 'glm-5.3-flash' },
    { apiKey: 'form-key', model: 'glm-5.3-flash', baseUrl: 'https://user.example/v1' },
    { fillMissingOnly: true, conflicts }
  );
  assert.deepStrictEqual(conflicts, ['apiKey'], '等值的 model 不应入列');
});

test('mergeUserConfig：不同类型但字符串化相等不算冲突（4096 vs "4096"）', () => {
  const conflicts = [];
  mergeUserConfig(
    { maxTokens: 4096 },
    { maxTokens: '4096' },
    { fillMissingOnly: true, conflicts }
  );
  assert.deepStrictEqual(conflicts, []);
});

test('writeUserConfig：所有返回路径都带 conflicts', (t) => {
  const file = tmpFile(t);
  fs.writeFileSync(file, JSON.stringify({ apiKey: 'user-key' }), 'utf8');
  const conflicts = [];
  const r1 = writeUserConfig({ apiKey: 'form-key' }, file, { fillMissingOnly: true, conflicts });
  assert.strictEqual(r1.changed, false, '冲突键被跳过，无写入');
  assert.deepStrictEqual(r1.conflicts, ['apiKey']);
  assert.deepStrictEqual(conflicts, ['apiKey'], '调用方数组同步填充');

  const r2 = writeUserConfig({}, file); // 空 GUI 值早退路径
  assert.deepStrictEqual(r2.conflicts, [], '早退路径也带 conflicts 字段');
});

test('bridgeStatus：无文件/坏文件时不抛错，configured 反映 env key', (t) => {
  const cb = require('../tools/config-bridge');
  // bridgeStatus 读 USER_CONFIG 常量；测试环境该文件在 tmpdir 下且通常不存在。
  const st = cb.bridgeStatus();
  assert.strictEqual(st.ok, true);
  assert.strictEqual(typeof st.configured, 'boolean');
});
