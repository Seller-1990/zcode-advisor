'use strict';

// P3 审计项回归：面板/注入脚本/安装模板的低危修复。
// 浏览器侧代码以源码静态断言为主（无真实浏览器）；install.sh 以隔离 HOME/PATH 实跑。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('setup-server：打开浏览器的 spawn 挂了 error 监听（ENOENT 不崩进程）', () => {
  const src = read('tools/setup-server.js');
  assert.ok(!/spawn\([^)]*\)\.unref\(\)/.test(src), '不应再有无监听的 spawn(...).unref()');
  assert.strictEqual((src.match(/c\.on\('error'/g) || []).length, 2, 'win32 与 posix 两个分支都要挂监听');
});

test('setup-server：maxTokens 转义、无内联重复 require、保存回报 ignored 字段、Ping 在途禁用', () => {
  const src = read('tools/setup-server.js');
  assert.match(src, /value="\$\{esc\(cfg\.maxTokens \|\| 4096\)\}"/);
  assert.ok(!src.includes("require('../hooks/lib/history').HISTORY_FILE"), '应复用顶部导入的 HISTORY_FILE');
  assert.match(src, /ignored: r\.ignored \|\| \[\]/);
  assert.match(src, /id="pingBtn"/);
  assert.match(src, /b\.disabled=true/);
  assert.ok(!/replace\('T',' '\)\.slice\(5,16\)\;/.test(src.replace(/isNaN[^\n]*/g, '')), '历史时间戳应按本地时区格式化');
});

test('panel.cjs：脚本可解析；畸形 hash 不中止 IIFE；展开历史每次重读；按钮在途禁用', () => {
  const html = require('../tools/companion/panel.cjs');
  for (const s of html.match(/<script>[\s\S]*?<\/script>/g)) {
    // eslint-disable-next-line no-new-func
    new Function(s.replace(/<\/?script>/g, ''));
  }
  assert.match(html, /try \{ TOKEN = decodeURIComponent\(RAW_HASH\); \} catch/);
  assert.ok(!html.includes('childElementCount <= 1'), '旧条件会在 >=2 条后停止刷新');
  assert.match(html, /if \(this\.open\) loadHistory\(\)/);
  assert.match(html, /esc\(fmtTs\(it\.ts\)\)/);
  assert.match(html, /getHours\(\)/);
  assert.match(html, /btns\.forEach\(x => \{ x\.disabled = true; \}\)/);
});

test('inject.js：观察器 rAF 节流 + 已挂载早返回；健康轮询在途守卫/超时/隐藏跳过；时间戳本地化', () => {
  const src = read('tools/companion/inject.js');
  // 注入脚本本体可解析
  // eslint-disable-next-line no-new-func
  new Function(src.replace(/__API_PORT__/g, '1'));
  assert.match(src, /if \(scheduled\) return;/);
  assert.match(src, /raf\(check\)/);
  assert.match(src, /b\.isConnected === true/);
  assert.match(src, /healthInFlight/);
  assert.match(src, /AbortSignal\.timeout\(/);
  assert.match(src, /document\.hidden/);
  assert.ok(!/String\(b\.last\w+At\)\.replace\('T'/.test(src), '健康详情时间应走 fmtTs（本地时区）');
  assert.match(src, /btns\.forEach\(\(x\) => \{ x\.disabled = true; \}\)/);
});

test('install-templates：系统 node 缺 WebSocket 时明确失败，不复制', {
  skip: process.platform === 'win32'
}, (t) => {
  const T = require('../tools/companion/install-templates.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-ui-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const src = path.join(root, 'source');
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  fs.mkdirSync(src);
  fs.mkdirSync(bin);
  for (const name of ['dirname', 'mkdir', 'cp']) {
    fs.symlinkSync(execFileSync('which', [name], { encoding: 'utf8' }).trim(), path.join(bin, name));
  }
  // 冒充一个过旧的系统 node：WebSocket 探测一律失败
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  for (const f of ['controller.cjs', 'launchd.cjs']) fs.writeFileSync(path.join(src, f), '');
  const script = path.join(src, 'install.sh');
  fs.writeFileSync(script, T.MAC_INSTALL_SH(['controller.cjs']));
  const bash = execFileSync('which', ['bash'], { encoding: 'utf8' }).trim();
  const r = spawnSync(bash, [script], { env: { ...process.env, HOME: home, PATH: bin }, encoding: 'utf8', timeout: 15000 });
  assert.ifError(r.error);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /版本过旧（缺少全局 WebSocket）/);
  const support = path.join(home, 'Library', 'Application Support', 'ZCodeAdvisor');
  assert.ok(!fs.existsSync(path.join(support, 'bin', 'node')), '过旧 node 不应被复制');
});

test('install-templates：首装脚本先复制到临时位置再替换（不先 rm -rf 旧版）', () => {
  const T = require('../tools/companion/install-templates.cjs');
  const sh = T.MAC_FIRST_INSTALL('9.9.9');
  const iCp = sh.indexOf('cp -R "$APP_SRC" "$APP_TMP"');
  const iRm = sh.indexOf('rm -rf "$APP_DST"');
  const iMv = sh.indexOf('mv "$APP_TMP" "$APP_DST"');
  assert.ok(iCp > 0 && iRm > iCp && iMv > iRm, '顺序应为 cp 到临时 → 删旧 → mv');
  const r = spawnSync('bash', ['-n'], { input: sh, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const r2 = spawnSync('bash', ['-n'], { input: T.MAC_INSTALL_SH(['controller.cjs']), encoding: 'utf8' });
  assert.strictEqual(r2.status, 0, r2.stderr);
});
