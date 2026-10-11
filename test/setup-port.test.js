'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const { spawn } = require('child_process');
const script = path.join(__dirname, '../tools/setup-server.js');
const close = server => new Promise(resolve => server.close(resolve));
const listen = port => new Promise((resolve, reject) => {
  const s = net.createServer(); s.once('error', reject); s.listen(port, '127.0.0.1', () => resolve(s));
});
async function reserveConsecutive(count) {
  for (let i = 0; i < 20; i++) {
    const sockets = [await listen(0)], port = sockets[0].address().port;
    try {
      if (port + count > 65535) throw Error('out of port range');
      for (let n = 1; n < count; n++) sockets.push(await listen(port + n));
      return { sockets, port };
    } catch (_) { await Promise.all(sockets.map(close)); }
  }
  throw Error('could not reserve fixture ports');
}
async function runPanel(t, port) {
  const base = os.tmpdir(), home = fs.mkdtempSync(path.join(base, 'zca-setup-port-'));
  const child = spawn(process.execPath, [script, '--port=' + port], {
    env: { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: home, TMP: home, TEMP: home,
      ZCODE_ADVISOR_PANEL_NO_OPEN: '1', NODE_ENV: 'test',
      ZCODE_ADVISOR_USER_CONFIG: path.join(home, 'advisor.json'),
      ZCODE_ADVISOR_ZCODE_CONFIG: path.join(home, 'zcode.json'),
      ZCODE_ADVISOR_ZCODE_PROVIDER_CONFIG: path.join(home, 'providers.json') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exit;
    assert.ok(path.resolve(home).startsWith(path.resolve(base) + path.sep + 'zca-setup-port-'));
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { child, exit };
}
// 累积 stdout 直到出现监听横幅（旧用例只看第一块 data，分块时可能漏掉地址）。
async function waitForListening(child, ms) {
  return new Promise(resolve => {
    let buf = '';
    const timer = setTimeout(() => resolve(buf), ms);
    child.stdout.on('data', chunk => {
      buf += String(chunk);
      if (buf.includes('配置面板已启动')) { clearTimeout(timer); resolve(buf); }
    });
  });
}
const boundPort = (output) => {
  const m = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(output);
  return m ? Number(m[1]) : null;
};

test('setup advances beyond two occupied local ports and serves on the next free one', { timeout: 10000 }, async t => {
  const { sockets, port } = await reserveConsecutive(3);
  await close(sockets.pop());
  t.after(() => Promise.all(sockets.map(close)));
  const { child } = await runPanel(t, port);
  const output = await waitForListening(child, 2500);
  const bound = boundPort(output);
  assert.ok(bound !== null, `未在输出里看到监听地址：\n${output}`);
  // 不把断言写死成 port+2（R14）：那个端口刚被释放，任何进程都可能在「关闭→监听」的间隙里
  // 抢走它，面板这时会继续前进到 port+3。真正要守的性质是「越过两个被占端口」，写死具体
  // 端口只会让用例在机器繁忙时假失败。
  assert.ok(bound >= port + 2, `应越过被占的 ${port}/${port + 1}，实际落在 ${bound}`);
  assert.ok(sockets.every(s => s.listening), '测试持有的占用端口不应被面板接管或关闭');
  const r = await fetch('http://127.0.0.1:' + bound + '/');
  assert.equal(r.status, 200); await r.text();
});

test('setup keeps advancing when the next free port is taken by someone else (R14 window)', { timeout: 10000 }, async t => {
  // 等价于「释放→监听间隙里被别人抢先」：port+2 一直被占（这里由测试自己扮演抢跑者）。
  // 旧用例把断言写死成 port+2，这种场景下必然假失败；面板的正当行为是继续前进。
  const { sockets, port } = await reserveConsecutive(3);
  t.after(() => Promise.all(sockets.map(close)));
  const { child } = await runPanel(t, port);
  const output = await waitForListening(child, 2500);
  const bound = boundPort(output);
  assert.ok(bound !== null, `未在输出里看到监听地址：\n${output}`);
  assert.ok(bound >= port + 3, `port+2 被占时应继续前进，实际落在 ${bound}`);
  const r = await fetch('http://127.0.0.1:' + bound + '/');
  assert.equal(r.status, 200); await r.text();
});

test('setup exits with error after exhausting its bounded candidate range', { timeout: 10000 }, async t => {
  const { sockets, port } = await reserveConsecutive(11);
  t.after(() => Promise.all(sockets.map(close)));
  const { child, exit } = await runPanel(t, port);
  child.stdout.resume(); child.stderr.resume();
  let timer;
  const r = await Promise.race([exit, new Promise(resolve => { timer = setTimeout(() => resolve({ code: 'timeout' }), 2500); })]);
  clearTimeout(timer);
  assert.equal(r.code, 1);
});
