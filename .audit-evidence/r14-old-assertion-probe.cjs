#!/usr/bin/env node
'use strict';

// R14 证据探针（不是测试套件的一部分，只用于留档）：
// 证明旧用例 test/setup-port.test.js 里把端口写死成 `port + 2` 的那条断言，在「第三个端口
// 被别人抢先占住」时必然假失败——这正是「close(port+2) → 面板 listen(port+2)」之间的
// TOCTOU 窗口。探针扮演抢跑者：自己一直占着 port+2，然后照旧启动面板，分别评估
//   旧断言：面板监听地址恰好是 port+2
//   新性质：面板越过两个被占端口（≥ port+2），落在哪个由机器当前可用性决定
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const { spawn } = require('child_process');

const script = path.join(__dirname, '..', 'tools', 'setup-server.js');
const listen = (port) => new Promise((resolve, reject) => {
  const s = net.createServer(); s.once('error', reject); s.listen(port, '127.0.0.1', () => resolve(s));
});
const close = (s) => new Promise((r) => s.close(r));

(async () => {
  let sockets = [], port = 0;
  for (let i = 0; i < 20; i++) {
    sockets = [await listen(0)]; port = sockets[0].address().port;
    try {
      if (port + 2 > 65535) throw Error('out of port range');
      sockets.push(await listen(port + 1));
      sockets.push(await listen(port + 2));
      break;
    } catch (_) { await Promise.all(sockets.map(close)); sockets = []; }
  }
  if (sockets.length === 0) { console.log('无法预留连续端口，探针作废'); process.exit(2); }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zca-r14-probe-'));
  const child = spawn(process.execPath, [script, '--port=' + port], {
    env: { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: home, TMP: home, TEMP: home,
      ZCODE_ADVISOR_PANEL_NO_OPEN: '1', NODE_ENV: 'test',
      ZCODE_ADVISOR_USER_CONFIG: path.join(home, 'advisor.json'),
      ZCODE_ADVISOR_ZCODE_CONFIG: path.join(home, 'zcode.json'),
      ZCODE_ADVISOR_ZCODE_PROVIDER_CONFIG: path.join(home, 'providers.json') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const output = await new Promise((resolve) => {
    let buf = '';
    const timer = setTimeout(() => resolve(buf), 2500);
    child.stdout.on('data', (chunk) => {
      buf += String(chunk);
      if (buf.includes('配置面板已启动')) { clearTimeout(timer); resolve(buf); }
    });
  });
  const m = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(output);
  const bound = m ? Number(m[1]) : null;

  console.log(`被占端口：${port} / ${port + 1} / ${port + 2}（第三个由探针扮演「抢跑者」一直占着）`);
  console.log(`面板实际监听：${bound}`);
  console.log(`旧断言（写死 port+2=${port + 2}）：${bound === port + 2 ? '通过' : `失败（假失败）—— 期望 ${port + 2}，实际 ${bound}`}`);
  console.log(`新性质（越过被占的 ${port}/${port + 1}）：${bound !== null && bound >= port + 2 ? '通过' : '失败'}`);
  console.log(`HTTP 探测 127.0.0.1:${bound} → ${(() => {
    try { return require('child_process').execFileSync(process.execPath, ['-e',
      `fetch('http://127.0.0.1:${bound}/').then(r=>{console.log(r.status);}).catch(e=>{console.log('ERR '+e.message);process.exit(1)})`],
      { encoding: 'utf8', timeout: 5000 }).trim(); } catch (e) { return 'ERR ' + e.message; }
  })()}`);

  child.kill('SIGTERM');
  await new Promise((r) => child.once('exit', r));
  await Promise.all(sockets.map(close));
  fs.rmSync(home, { recursive: true, force: true });
})();
