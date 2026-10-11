'use strict';
// R20（批次二窗口内新发现，不在冻结报告 R01–R19 清单内）：
// 干净机器上 ~/.zcode 还不存在时，单飞锁的 mkdirSync(lockDir, {recursive:false}) 因父目录缺失
// 直接 ENOENT；于是 acquireSingleFlight 落进 catch → readLockInfo 读到「无锁」却被 isStale 判为
// 陈旧 → tryTakeOver 往同一个不存在的父目录写 info 也 ENOENT → 最终返回 acquired:false + holder:''
// → main() 打出「已有自动启用实例在运行（pid 未知），本次跳过以免并发踩踏」并 return 0。
// 后果：自动启用在干净机器上永久静默失效（假成功），日志还把责任推给一个不存在的实例。
// 本机 ~/.zcode 已存在，所以一直没暴露。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = process.env.ZCA_AUTO_ENABLE_PATH
  || path.join(__dirname, '..', 'tools', 'companion', 'auto-enable.cjs');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'zca-auto-enable-clean-'));
const home = path.join(fixture, 'home');
const tmp = path.join(fixture, 'tmp');
const logFile = path.join(fixture, 'auto-enable.log');

// 假 ZCode：只有可执行文件、**没有** 同级的 Resources/glm/zcode.cjs。
// 这样既走到取锁流程，又保证不会去调宿主真正的 CLI。
const binDir = path.join(fixture, 'zcodebin');
fs.mkdirSync(binDir, { recursive: true });
fs.mkdirSync(tmp, { recursive: true });
const zcodeBin = path.join(binDir, process.platform === 'win32' ? 'ZCode.cmd' : 'ZCode');
fs.writeFileSync(zcodeBin, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', { mode: 0o755 });

test('干净 HOME（尚无 ~/.zcode）不得误报「已有实例在运行」而静默跳过', () => {
  assert.equal(fs.existsSync(path.join(home, '.zcode')), false, '前提：fixture 的 HOME 里没有 .zcode');

  const res = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    timeout: 30000,
    env: Object.assign({}, process.env, {
      HOME: home,
      USERPROFILE: home,
      TMPDIR: tmp,
      TMP: tmp,
      TEMP: tmp,
      ZCODE_ADVISOR_ZCODE_PATH: zcodeBin,
      ZCODE_ADVISOR_COMPANION_LOG: logFile
    })
  });
  assert.equal(res.error, undefined, `子进程未能启动：${res.error}`);
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';

  assert.ok(
    !/已有自动启用实例在运行/.test(log),
    `父目录缺失被误报成「已有实例在运行」（假成功，自动启用静默失效）：\n${log}`
  );
  // 取锁之后至少要走到的真实决策点：插件市场缺失 或 CLI 缺失（两者都在取锁之后）。
  assert.ok(
    /未找到插件市场目录|未找到 ZCode CLI/.test(log),
    `取锁之后必须继续走到真正的工作流程（说明单飞锁没把自己挡在门外）：\n${log}`
  );
});

test.after(() => {
  assert.ok(fixture.startsWith(os.tmpdir()), 'fixture 必须位于系统临时目录内');
  fs.rmSync(fixture, { recursive: true, force: true });
});
