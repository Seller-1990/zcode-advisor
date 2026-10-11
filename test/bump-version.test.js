'use strict';

// 版本四联同步的「全有或全无」守卫。
//
// 为什么需要（真机故障 + 审计 R12）：四处 manifest 分两次写、任何一份在中途失败，
// 都会留下「两个版本号并存」的状态——宿主按版本号判断要不要重装，于是新代码永久进不了
// cache（用户现象是「修了没生效」）。脚本的核心承诺就是四处同源，因此必须
// ① 先整体渲染校验、再统一写入（任一份不可替换 → 一个字节都不落盘）；
// ② 写入阶段失败 → 回滚已写文件。
//
// fixture 树用 ZCODE_ADVISOR_BUMP_ROOT 指向临时目录：在真实仓库里改坏 manifest 会污染仓库
// （同一惯例见 test/plugin-dir.test.js 的 ZCODE_ADVISOR_SYNC_ROOT）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
// ZCA_BUMP_TOOL：红灯用例指向修复前的快照（与 ZCA_OCR_REVIEWER / ZCA_SYNC_TOOL 同惯例）。
const BUMP = process.env.ZCA_BUMP_TOOL || path.join(ROOT, 'tools', 'companion', 'bump-version.cjs');
const RELS = [
  '.zcode-plugin/plugin.json',
  'package.json',
  'plugins/zcode-advisor/package.json',
  'plugins/zcode-advisor/.zcode-plugin/plugin.json'
];
const CUR = '0.2.20';
const NEW = '0.2.30';

function makeFixture(t, { breakRel = null, readOnlyRel = null } = {}) {
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-bump-'));
  t.after(() => {
    for (const rel of RELS) {
      try { fs.chmodSync(path.join(fx, rel), 0o644); } catch (_) {}
    }
    try { fs.rmSync(fx, { recursive: true, force: true }); } catch (_) {}
  });
  for (const rel of RELS) {
    const p = path.join(fx, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const body = rel === breakRel
      ? JSON.stringify({ name: 'x', engines: { node: '>=18' } }, null, 2) // 没有 version 字段
      : JSON.stringify({ name: 'x', version: CUR }, null, 2);
    fs.writeFileSync(p, body + '\n', 'utf8');
  }
  if (readOnlyRel) fs.chmodSync(path.join(fx, readOnlyRel), 0o444);
  return fx;
}

function run(fx, arg) {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [BUMP, arg], {
        encoding: 'utf8', stdio: 'pipe', env: { ...process.env, ZCODE_ADVISOR_BUMP_ROOT: fx }
      })
    };
  } catch (err) {
    return { code: err.status, out: String(err.stdout || '') + String(err.stderr || '') };
  }
}

const versions = (fx) => RELS.map((rel) => {
  try { return JSON.parse(fs.readFileSync(path.join(fx, rel), 'utf8')).version; } catch (_) { return '(parse-fail)'; }
});

test('bump-version：任一份 manifest 不可替换时，一个字节都不写（不得留下两个版本号）', (t) => {
  const fx = makeFixture(t, { breakRel: 'plugins/zcode-advisor/package.json' });
  const before = RELS.map((rel) => fs.readFileSync(path.join(fx, rel), 'utf8'));
  const res = run(fx, NEW);
  assert.notStrictEqual(res.code, 0, `应当失败退出：\n${res.out}`);
  assert.match(res.out, /未写入任何文件/);
  const after = RELS.map((rel) => fs.readFileSync(path.join(fx, rel), 'utf8'));
  assert.deepStrictEqual(after, before,
    '整体校验失败时四处必须逐字节原样不动（旧实现会先改前两份，留下两种版本号）');
  assert.deepStrictEqual(versions(fx), [CUR, CUR, undefined, CUR], 'fixture 自检：第 3 份本身没有 version 字段');
});

test('bump-version：写入阶段失败时回滚已写文件（四处仍同源）', {
  skip: process.platform === 'win32' ? 'Windows 只读位语义不同，未在真机验证' : false
}, (t) => {
  const fx = makeFixture(t, { readOnlyRel: 'plugins/zcode-advisor/package.json' });
  const before = RELS.map((rel) => fs.readFileSync(path.join(fx, rel), 'utf8'));
  const res = run(fx, NEW);
  assert.notStrictEqual(res.code, 0, `应当失败退出：\n${res.out}`);
  assert.match(res.out, /已回滚|回滚失败/);
  assert.deepStrictEqual(RELS.map((rel) => fs.readFileSync(path.join(fx, rel), 'utf8')), before,
    '写入失败后必须回滚到底，四处仍保持一致');
  assert.deepStrictEqual(versions(fx), [CUR, CUR, CUR, CUR]);
});

test('bump-version：四处齐全时统一写入新版本号', (t) => {
  const fx = makeFixture(t);
  const res = run(fx, NEW);
  assert.strictEqual(res.code, 0, `应当成功：\n${res.out}`);
  assert.deepStrictEqual(versions(fx), [NEW, NEW, NEW, NEW]);
  const checked = run(fx, '--check');
  assert.strictEqual(checked.code, 0, `--check 应通过：\n${checked.out}`);
});
