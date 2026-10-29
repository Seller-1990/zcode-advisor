'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { buildZip, buildTarGz } = require('../tools/companion/archive.cjs');

// Run the actual build module with an isolated build root and an in-memory official
// distribution. No network, real dist directory, installer, or host configuration.
function fixture(t, version = 'v22.1.0', root = fs.mkdtempSync(path.join(os.tmpdir(), 'zca-build-cache-'))) {
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cache = path.join(root, 'dist', '.cache');
  fs.mkdirSync(cache, { recursive: true });
  const requests = [];
  const file = path.resolve(__dirname, '../tools/companion/build-installer.cjs');
  const realRequire = createRequire(file);
  const mod = { exports: {} };
  const sandbox = {
    module: mod, exports: mod.exports, Buffer, AbortSignal, setTimeout,
    console: { log() {}, warn() {} },
    process: { env: { NODE_EMBED_VERSION: version }, arch: process.arch },
    require(spec) {
      if (spec === './build-meta.cjs') return { ...realRequire(spec), ROOT: root };
      return realRequire(spec);
    },
    async fetch(url) {
      const selected = url.includes('index.json') ? 'v24.1.0' : url.match(/\/(v\d+\.\d+\.\d+)\//)[1];
      // buildZip/buildTarGz are deterministic, so SHASUMS256.txt can be computed from the same bytes.
      const zip = () => buildZip([{ path: `node-${selected}-win-x64/node.exe`, data: Buffer.from(selected) }]);
      const tgz = arch => buildTarGz([{ path: `node-${selected}-darwin-${arch}/bin/node`, data: Buffer.from(selected) }]);
      let bytes;
      if (url.endsWith('SHASUMS256.txt')) {
        // Checksum requests are not counted: the assertions below track binary/index downloads only.
        const h = b => crypto.createHash('sha256').update(b).digest('hex');
        bytes = Buffer.from([
          `${h(zip())}  node-${selected}-win-x64.zip`,
          `${h(tgz('arm64'))}  node-${selected}-darwin-arm64.tar.gz`,
          `${h(tgz('x64'))}  node-${selected}-darwin-x64.tar.gz`
        ].join('\n'));
      } else {
        requests.push(url);
        if (url.endsWith('index.json')) bytes = Buffer.from(JSON.stringify([{ version: selected, lts: 'Test' }]));
        else if (url.endsWith('.zip')) bytes = zip();
        else bytes = tgz(url.includes('darwin-x64') ? 'x64' : 'arm64');
      }
      return { ok: true, async arrayBuffer() { return bytes; } };
    }
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  return { cache, requests, fetchNode: mod.exports.fetchEmbeddedNodeBinary };
}

test('内嵌 Node：显式版本不命中无版本旧缓存，缓存按版本/平台/架构隔离', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.cache, 'node-win-x64'), 'stale-runtime');
  assert.equal((await f.fetchNode('win', 'x64')).toString(), 'v22.1.0');
  assert.equal(f.requests.length, 1);
  assert.equal((await f.fetchNode('win', 'x64')).toString(), 'v22.1.0');
  assert.equal(f.requests.length, 1, '同版本应复用缓存');
  await f.fetchNode('mac', 'arm64');
  assert.equal(f.requests.length, 2, '不同平台架构不能共用二进制');
  assert.equal(fs.readFileSync(path.join(f.cache, 'node-v22.1.0-win-x64'), 'utf8'), 'v22.1.0');
});

test('内嵌 Node：同平台不同架构与同缓存目录不同版本均不串用', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zca-build-versions-'));
  const first = fixture(t, 'v22.1.0', root);
  await first.fetchNode('mac', 'arm64');
  await first.fetchNode('mac', 'x64');
  assert.equal(first.requests.length, 2, '相同平台不同架构必须独立获取');
  const second = fixture(t, 'v24.2.0', root);
  assert.equal((await second.fetchNode('mac', 'arm64')).toString(), 'v24.2.0');
  assert.equal(second.requests.length, 1, '显式新版本不能命中旧版本缓存');
  assert.equal((await first.fetchNode('mac', 'arm64')).toString(), 'v22.1.0');
  assert.equal(first.requests.length, 2, '旧版本仍可命中自己的缓存');
});

test('内嵌 Node：LTS 版本每次构建只解析一次，空缓存重新获取', async t => {
  const f = fixture(t, '');
  fs.writeFileSync(path.join(f.cache, 'node-v24.1.0-win-x64'), '');
  assert.equal((await f.fetchNode('win', 'x64')).toString(), 'v24.1.0');
  assert.equal((await f.fetchNode('mac', 'arm64')).toString(), 'v24.1.0');
  assert.equal(f.requests.filter(url => url.endsWith('index.json')).length, 1);
});
