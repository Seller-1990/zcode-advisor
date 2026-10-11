'use strict';

// R05：history 裁剪（trimIfNeeded）原来是「读全量 → 整段重写同一个文件」，
// 读取与重写之间别的进程 append 的记录会被这次重写整段覆盖（历史里凭空少记录，
// 而且是"悄悄少"——没有任何错误可观测）。
// 本用例在裁剪真正落笔那一刻注入一次真实的并发追加，锁死不变量：
//   「裁剪可以丢老记录，但绝不能丢裁剪开始之后才写进来的记录」。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const HISTORY_MODULE = path.join(__dirname, '..', 'hooks', 'lib', 'history.js');

test('history 裁剪不得覆盖并发追加的记录（R05）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-trim-'));
  const file = path.join(dir, 'advisor-history.jsonl');
  // 先铺 520 行（超过 HISTORY_MAX_LINES=500），使随后的 append 触发裁剪。
  const seed = [];
  for (let i = 0; i < 520; i++) {
    seed.push(JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', event: 'queued', note: `seed-${i}` }));
  }
  fs.writeFileSync(file, seed.join('\n') + '\n', 'utf8');

  const prevEnv = process.env.ZCODE_ADVISOR_HISTORY;
  process.env.ZCODE_ADVISOR_HISTORY = file;
  delete require.cache[HISTORY_MODULE];

  const realWriteFileSync = fs.writeFileSync;
  const realAppendFileSync = fs.appendFileSync;
  const patchedFs = Object.create(fs);
  const marker = { ts: '2026-01-01T00:00:01.000Z', event: 'concurrent', note: '另一个进程的并发追加' };
  let injected = false;
  // 只在「裁剪要写文件」的那一刻注入一次真实追加（模拟并发进程），再照原样写。
  // 修复后裁剪写的是临时文件，注入点仍然落在同一次裁剪里，因此仍能验证尾部搬运。
  patchedFs.writeFileSync = function (target, data, opts) {
    if (!injected) {
      injected = true;
      realAppendFileSync.call(fs, file, JSON.stringify(marker) + '\n', 'utf8');
    }
    return realWriteFileSync.call(fs, target, data, opts);
  };
  const origLoad = Module._load;
  Module._load = function (request, parent) {
    if (request === 'fs' && parent && path.resolve(parent.filename) === path.resolve(HISTORY_MODULE)) {
      return patchedFs;
    }
    return origLoad.apply(this, arguments);
  };

  let history;
  try {
    history = require(HISTORY_MODULE);
    history.appendHistory({ event: 'queued', note: 'trim-trigger' });
  } finally {
    Module._load = origLoad;
    if (prevEnv === undefined) delete process.env.ZCODE_ADVISOR_HISTORY;
    else process.env.ZCODE_ADVISOR_HISTORY = prevEnv;
  }

  try {
    assert.ok(injected, '前置条件：裁剪应当真的发生，否则本用例什么都没验证到');
    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    assert.ok(lines.length <= history.HISTORY_MAX_LINES,
      `裁剪后行数应 <= 上限 ${history.HISTORY_MAX_LINES}，实际 ${lines.length}`);
    assert.ok(lines.length > 200, `裁剪应保留约一半行数，实际只剩 ${lines.length} 行`);
    const notes = lines.map((l) => { try { return JSON.parse(l).note; } catch (_) { return null; } });
    assert.ok(notes.includes(marker.note),
      `裁剪开始后并发追加的记录被整段覆盖丢失（R05）——现有 ${lines.length} 行里找不到它`);
    assert.strictEqual(history.readHistory(1)[0].note, marker.note,
      '并发追加的记录应当是最后一条（裁剪不得把它丢在旧位置或丢掉）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
