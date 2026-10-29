'use strict';

// P4 回归：
//   ① controller 无锁降级模式不能起心跳（否则 pid=0 → unknown → lost → ~40s 自杀重启循环）；
//      持锁时锁文件被外部删除/损坏 → 心跳夺回，而不是退出；只有别的 pid 持锁才 lost。
//   ② 首装脚本替换 /Applications 旧版：旧版先挪开、新版就位失败则恢复，绝不把新包 mv 进旧包里。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// require controller 前隔离临时目录与日志，绝不触碰宿主真实租约/日志。
const hostTmp = os.tmpdir();
const fixture = fs.mkdtempSync(path.join(hostTmp, 'zca-p4-test-'));
Object.assign(process.env, {
  HOME: fixture, USERPROFILE: fixture,
  ZCODE_ADVISOR_COMPANION_TMP: fixture,
  ZCODE_ADVISOR_COMPANION_LOG: path.join(fixture, 'companion.log')
});
test.after(() => {
  assert.ok(path.resolve(fixture).startsWith(path.resolve(hostTmp) + path.sep + 'zca-p4-test-'));
  fs.rmSync(fixture, { recursive: true, force: true });
});

const { _internal: I } = require('../tools/companion/controller.cjs');
const T = require('../tools/companion/install-templates.cjs');
const LOCK = I.LOCK_FILE;

test('锁文件位于隔离目录', () => {
  assert.strictEqual(path.dirname(LOCK), fixture);
});

test('未持锁（无锁降级）时 startLockHeartbeat 不起心跳', () => {
  assert.strictEqual(I.isLockHeld(), false);
  assert.strictEqual(I.startLockHeartbeat({ value: 0 }), false);
});

test('acquireLock 写锁失败分支显式标记未持锁', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'companion', 'controller.cjs'), 'utf8');
  const i = src.indexOf('继续启动，但可能多实例');
  assert.ok(i > 0);
  const tail = src.slice(i, i + 400);
  assert.ok(/lockHeld = false;[\s\S]*return true;/.test(tail), '降级分支须置 lockHeld=false 再 return true');
});

test('心跳单拍：自己的锁 → renew', () => {
  fs.rmSync(LOCK, { force: true });
  fs.writeFileSync(LOCK, `pid=${process.pid}\nstarted=1\ncdp=0\ncdpSince=1\n`);
  const st = { prevUnknown: false };
  assert.strictEqual(I.lockHeartbeatTick(st, LOCK, 9222), 'renew');
  const info = I.readLockInfo(LOCK);
  assert.strictEqual(info.pid, process.pid);
  assert.strictEqual(info.cdp, 9222);
  assert.ok(info.started > 1);
});

test('心跳单拍：锁文件被外部删除 → 夺回（不退出）并置为持锁', () => {
  fs.rmSync(LOCK, { force: true });
  const st = { prevUnknown: false };
  assert.strictEqual(I.lockHeartbeatTick(st, LOCK, 0), 'retaken');
  assert.strictEqual(I.readLockInfo(LOCK).pid, process.pid);
  assert.strictEqual(I.isLockHeld(), true);
  // 连续两拍丢失也只会夺回，不会 lost
  fs.rmSync(LOCK, { force: true });
  assert.strictEqual(I.lockHeartbeatTick(st, LOCK, 0), 'retaken');
});

test('心跳单拍：别的 pid 持锁 → lost（heartbeatDecision 语义不变）', () => {
  fs.writeFileSync(LOCK, `pid=${process.pid + 100000}\nstarted=${Date.now()}\ncdp=0\ncdpSince=${Date.now()}\n`);
  assert.strictEqual(I.lockHeartbeatTick({ prevUnknown: false }, LOCK, 0), 'lost');
  assert.strictEqual(I.lockHeartbeatTick({ prevUnknown: true }, LOCK, 0), 'lost');
  assert.strictEqual(I.heartbeatDecision(123, 456, false), 'lost');
  assert.strictEqual(I.heartbeatDecision(0, 456, false), 'unknown');
  assert.strictEqual(I.heartbeatDecision(0, 456, true), 'lost');
});

test('心跳单拍：空/损坏锁 → 首拍 unknown，次拍夺回', () => {
  fs.writeFileSync(LOCK, 'garbage');
  const st = { prevUnknown: false };
  assert.strictEqual(I.lockHeartbeatTick(st, LOCK, 0), 'unknown');
  assert.strictEqual(I.lockHeartbeatTick(st, LOCK, 0), 'retaken');
  assert.strictEqual(I.readLockInfo(LOCK).pid, process.pid);
  fs.rmSync(LOCK, { force: true });
});

// —— 首装脚本：只抽出「拷贝到 /Applications」段，用临时目录替代 /Applications 真跑 ——
function copyBlock() {
  const sh = T.MAC_FIRST_INSTALL('9.9.9');
  const a = sh.indexOf('APP_TMP="$APP_DST.installing.$$"');
  const b = sh.indexOf('# ── 剥离隔离属性');
  assert.ok(a > 0 && b > a);
  return sh.slice(a, b);
}

const POSIX_ONLY = process.platform === 'win32' ? 'bash 脚本仅供 macOS/POSIX' : false;

function runInstall(prelude) {
  const root = fs.mkdtempSync(path.join(fixture, 'inst-'));
  const src = path.join(root, 'src.app');
  const dst = path.join(root, 'Applications', 'ZCode Advisor.app');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'marker'), 'new');
  fs.mkdirSync(dst, { recursive: true });
  fs.writeFileSync(path.join(dst, 'marker'), 'old');
  const script = `APP_SRC=${JSON.stringify(src)}\nAPP_DST=${JSON.stringify(dst)}\n${prelude || ''}\n${copyBlock()}`;
  const r = spawnSync('bash', ['-c', script], { input: '\n', encoding: 'utf8' });
  return { r, dst, root };
}

test('首装脚本：替换旧版后不嵌套、不残留 .old', { skip: POSIX_ONLY }, () => {
  const { r, dst, root } = runInstall('');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.readFileSync(path.join(dst, 'marker'), 'utf8'), 'new');
  assert.ok(!fs.existsSync(path.join(dst, 'src.app')) && !fs.existsSync(path.join(dst, path.basename(dst))), '新包不应被 mv 进旧包里');
  const left = fs.readdirSync(path.dirname(dst)).filter((n) => n !== 'ZCode Advisor.app');
  assert.deepStrictEqual(left, [], `不应残留临时/备份目录：${left}`);
  assert.match(r.stdout, /已安装到/);
  void root;
});

test('首装脚本：新版就位失败 → 恢复旧版并 exit 1，不报成功', { skip: POSIX_ONLY }, () => {
  // 让「把 .installing 挪到目标」这一步失败，其余 mv 照常
  const prelude = 'mv() { case "$1" in *.installing.*) return 1;; esac; command mv "$@"; }';
  const { r, dst } = runInstall(prelude);
  assert.strictEqual(r.status, 1);
  assert.doesNotMatch(r.stdout, /已安装到/);
  assert.match(r.stderr, /已恢复原有版本/);
  assert.strictEqual(fs.readFileSync(path.join(dst, 'marker'), 'utf8'), 'old');
  const left = fs.readdirSync(path.dirname(dst)).filter((n) => n !== 'ZCode Advisor.app');
  assert.deepStrictEqual(left, []);
});

test('首装脚本语法有效', { skip: POSIX_ONLY }, () => {
  const r = spawnSync('bash', ['-n'], { input: T.MAC_FIRST_INSTALL('9.9.9'), encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
});
