'use strict';
// In-memory audit probes: no ports, host processes or real locks.
const fs = require('fs'), path = require('path'), vm = require('vm');
const { createRequire } = require('module');
const { EventEmitter } = require('events');
const root = path.resolve(__dirname, '..');
{
  const file = path.join(root, 'tools/setup-server.js'), rq = createRequire(file);
  const server = new EventEmitter(), ports = [];
  server.listen = p => { ports.push(p); return server; };
  const fakeProcess = { argv: [], env: { ZCODE_ADVISOR_PANEL_NO_OPEN: '1', ZCODE_ADVISOR_PANEL_PORT: '18765' }, platform: 'darwin', stdout: { write() {} }, stderr: { write() {} }, exit: c => { throw Error('exit ' + c); } };
  const ctx = { require: n => n === 'http' ? { createServer: () => server } : rq(n), module: { exports: {} }, process: fakeProcess, __dirname: path.dirname(file), Buffer, URL, console };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
  for (let i = 0; i < 3; i++) server.emit('error', { code: 'EADDRINUSE' });
  console.log('setup bind attempts', JSON.stringify(ports));
}
{
  const file = path.join(root, 'tools/companion/controller.cjs'), source = fs.readFileSync(file, 'utf8'), rq = createRequire(file);
  const files = new Map(), lock = '/fixture/zcode-advisor-companion.lock';
  files.set(lock, 'pid=99999999\nstarted=1\ncdp=0\ncdpSince=0\n');
  let hook = null;
  function instance(pid) {
    const vfs = Object.create(fs);
    vfs.readFileSync = (p, ...a) => {
      if (p !== lock) return fs.readFileSync(p, ...a);
      const s = files.get(p);
      if (hook && pid === 101) { const f = hook; hook = null; f(); }
      if (s === undefined) { const e = Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return s;
    };
    vfs.writeFileSync = (p, s) => files.set(p, String(s));
    vfs.renameSync = (a, b) => { files.set(b, files.get(a)); files.delete(a); };
    vfs.unlinkSync = p => files.delete(p);
    vfs.mkdirSync = () => {}; vfs.appendFileSync = () => {};
    const p = { pid, env: { ZCODE_ADVISOR_COMPANION_LOG: '/fixture/log' }, platform: process.platform, execPath: process.execPath, versions: process.versions,
      kill: n => { if (n !== 101 && n !== 202) { const e = Error('gone'); e.code = 'ESRCH'; throw e; } }, on() {}, stdout: { write() {} }, stderr: { write() {} } };
    const ctx = { require: n => n === 'fs' ? vfs : n === 'os' ? { homedir: () => '/fixture-home', tmpdir: () => '/fixture' } : rq(n), process: p, module: { exports: {} }, __dirname: path.dirname(file), console: { log() {} }, setTimeout, clearTimeout, setInterval, clearInterval, Buffer, AbortController, fetch, URL, WebSocket };
    vm.runInNewContext(source, ctx, { filename: file }); return ctx.module.exports._internal;
  }
  const A = instance(101), B = instance(202); let b;
  hook = () => { b = B.acquireLock(); };
  const a = A.acquireLock();
  console.log('controller lock interleave', JSON.stringify({ A: a, B: b, finalOwner: A.readLockInfo(lock).pid }));
}
{
  const { isReadyFromList } = require('../tools/companion/auto-enable.cjs');
  const windows = '- zcode-advisor@local [enabled]\n  cache/local: C:\\Users\\fixture\\zcode-advisor\\0.2.22';
  const mixed = '- zcode-advisor@old [disabled]\n  cache/old: /fixture/zcode-advisor/9.0.0\n- zcode-advisor@local [enabled]\n  cache/local: /fixture/zcode-advisor/0.2.1';
  console.log('auto-enable list parsing', JSON.stringify({ windowsSameVersionReady: isReadyFromList(windows, '0.2.22'), mixedOlderEnabledReady: isReadyFromList(mixed, '0.2.22') }));
}
