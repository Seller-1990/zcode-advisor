'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { readTarGz } = require('../tools/companion/archive.cjs');

test('macOS 构建：每架构只生成一次图标，tar 与 DMG 共享相同字节但不跨构建缓存', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zca-build-icon-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const companion = path.join(root, 'tools', 'companion');
  fs.mkdirSync(companion, { recursive: true });
  for (const name of ['controller.cjs', 'auto-enable.cjs', 'launchd.cjs']) {
    fs.writeFileSync(path.join(companion, name), '// isolated fixture');
  }
  fs.writeFileSync(path.join(root, 'ARCHITECTURE.md'), '# Fixture architecture\n');
  const file = path.resolve(__dirname, '../tools/companion/build-installer.cjs');
  const realRequire = createRequire(file);
  const generated = [];
  const staged = [];
  const mod = { exports: {} };
  const context = vm.createContext({
    module: mod, exports: mod.exports, Buffer, setTimeout, AbortSignal,
    process: { env: {}, platform: 'darwin', arch: 'x64' },
    console: { log() {}, warn() {} },
    fetch() { throw new Error('unexpected network'); },
    require(spec) {
      if (spec === './build-meta.cjs') return { ROOT: root, VERSION: '1.2.3', COMPANION_FILES: ['controller.cjs'] };
      if (spec === 'child_process') return { execFileSync() { throw new Error('unexpected external tool'); } };
      if (spec === './icon.cjs') return { makeIcns() {
        const bytes = Buffer.from(`fixture-icon-${generated.length + 1}`);
        generated.push(bytes);
        return bytes;
      } };
      if (spec === './packagers.cjs') return {
        stageMacApp(opts) { staged.push(Buffer.from(opts.icnsBuf)); },
        buildDmg() { return { ok: true, bytes: 1 }; }
      };
      return realRequire(spec);
    }
  });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  const buildMac = vm.runInContext('buildMac', context);
  for (const [i, arch] of ['x64', 'arm64'].entries()) {
    const artifacts = await buildMac(arch, { embedNode: false, installer: true });
    assert.equal(generated.length, i + 1, 'each build should generate exactly one ICNS');
    const tarIcon = readTarGz(fs.readFileSync(artifacts[0].path)).find(e => e.path === 'advisor.icns').data;
    assert.deepEqual(tarIcon, generated[i]);
    assert.deepEqual(staged[i], generated[i]);
  }
  assert.notDeepEqual(generated[0], generated[1], 'separate builds must not share a global cache');
  await buildMac('x64', { embedNode: false, installer: false });
  assert.equal(generated.length, 3);
  assert.equal(staged.length, 2, 'archive-only build must not stage a DMG');
});
