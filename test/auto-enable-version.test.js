'use strict';

// auto-enable「不降级」判据的回归测试。
//
// 背景（真机故障）：.app 内嵌的是打包时的插件快照（0.2.9）。用户从仓库装了
// 更新版本（0.2.11）后，只要点一次旧 .app，旧实现就会 marketplace add(.app/plugin)
// → update → install，把 0.2.9 装回去；之后 payload 与已装都是 0.2.9，
// 走幂等快路径，**新版本被永久钉死**。用户看到的现象是「UI 还是旧版本」，
// 而 P0 修复等改动全部没生效。
//
// 修复后：已装版本 >= 包内版本 即视为就绪，绝不回装更低版本。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { cmpSemver, isReadyFromList, computeFingerprint, parseInstallPath } =
  require('../tools/companion/auto-enable.cjs');

// 模拟 `plugins list` 的输出片段（真实格式见 controller 的 alreadyEnabled）
const listOut = (ver, enabled = true) =>
  `- zcode-advisor@zcode-advisor-local [${enabled ? 'enabled' : 'disabled'}]\n` +
  `  cache/zcode-advisor-local: /Users/x/.zcode/cli/plugins/cache/zcode-advisor-local/zcode-advisor/${ver}\n`;

test('不降级：已装 0.2.11、包内 0.2.9 → 就绪（绝不用旧包覆盖新版本）', () => {
  // 这是真机故障的核心用例：旧 .app（内嵌 0.2.9）点一次就把用户装的 0.2.11 盖回去
  assert.strictEqual(isReadyFromList(listOut('0.2.11'), '0.2.9'), true,
    '已装版本更高时必须视为就绪，否则会被旧包降级覆盖');
});

test('升级：已装 0.2.9、包内 0.2.11 → 不就绪（需要重装新版本）', () => {
  assert.strictEqual(isReadyFromList(listOut('0.2.9'), '0.2.11'), false,
    '包内版本更高时必须重装，否则跑的还是旧代码');
});

test('同版本：已装 0.2.11、包内 0.2.11 → 就绪', () => {
  assert.strictEqual(isReadyFromList(listOut('0.2.11'), '0.2.11'), true);
});

test('未启用 → 一律不就绪（无论版本高低）', () => {
  assert.strictEqual(isReadyFromList(listOut('0.2.11', false), '0.2.9'), false);
  assert.strictEqual(isReadyFromList(listOut('0.2.11', false), '0.2.11'), false);
});

test('输出里没有 zcode-advisor → 不就绪', () => {
  assert.strictEqual(isReadyFromList('some other plugin\n', '0.2.11'), false);
});

test('cmpSemver：版本高低比较正确', () => {
  assert.strictEqual(cmpSemver('0.2.11', '0.2.9'), 1, '0.2.11 高于 0.2.9（按数字段比，非字典序）');
  assert.strictEqual(cmpSemver('0.2.9', '0.2.11'), -1);
  assert.strictEqual(cmpSemver('0.2.9', '0.2.9'), 0);
  assert.strictEqual(cmpSemver('0.2.10', '0.2.9'), 1);
  assert.strictEqual(cmpSemver('0.3.0', '0.2.99'), 1);
});

test('cmpSemver：不可解析时返回 0（保守，走原逻辑而非误判）', () => {
  assert.strictEqual(cmpSemver('garbage', '0.2.9'), 0);
  assert.strictEqual(cmpSemver('', '0.2.9'), 0);
  assert.strictEqual(cmpSemver(undefined, '0.2.9'), 0);
});

test('cmpSemver：字典序陷阱——0.2.9 vs 0.2.10 必须按数字段判定', () => {
  // 字符串比较会得出 "0.2.9" > "0.2.10"（因为 '9' > '1'），这是经典坑
  assert.strictEqual(cmpSemver('0.2.9', '0.2.10'), -1, '数字段比较：9 < 10');
  assert.ok('0.2.9' > '0.2.10', '（对照）字符串比较确实是反的，说明必须走 cmpSemver');
});

// ── 同版本内容漂移检测（真机故障：cache 里是旧快照，版本号却相同）──
//
// 背景：宿主 cache 是市场源目录的逐字节拷贝，而市场源在 .app 内 = 打包时的快照。
// 某次发版只提了 plugins/ 镜像的 version、根目录没提，于是装出「版本 0.2.20、
// 代码却是 pre-anthropic」。此后纯版本比较永远判「已装 == 包内 → 就绪」，
// 幂等快路径直接返回，新代码永远进不了 cache（用户：「修了没生效」）。
//
// 修法：版本相同时再比内容指纹；不同即视为未就绪、强制重装。

// 造一对目录树，可精确控制两侧内容是否一致
function makeTree(mutate) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-fp-'));
  const payload = path.join(base, 'payload');
  const installed = path.join(base, 'installed');
  for (const d of [payload, installed]) {
    fs.mkdirSync(path.join(d, 'hooks', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'zcode-advisor', version: '0.2.20' }), 'utf8');
    fs.writeFileSync(path.join(d, 'hooks', 'lib', 'reviewer.js'), '// anthropic 适配\n', 'utf8');
    fs.writeFileSync(path.join(d, 'README.md'), '# readme\n', 'utf8');
  }
  if (mutate) mutate(payload, installed);
  return { base, payload, installed };
}

test('内容漂移：版本号相同但文件内容不同 → 不就绪（强制重装，修「修了没生效」）', () => {
  // 这是真机故障的核心用例：cache 里的 reviewer.js 是 pre-anthropic，包内是新的
  const { payload, installed } = makeTree((p) => {
    fs.writeFileSync(path.join(p, 'hooks', 'lib', 'reviewer.js'), '// 新的 anthropic 适配\n', 'utf8');
  });
  const fps = { payload: computeFingerprint(payload), installed: computeFingerprint(installed) };
  assert.notStrictEqual(fps.payload, fps.installed, '内容不同时指纹必须不同');
  assert.strictEqual(isReadyFromList(listOut('0.2.20'), '0.2.20', fps), false,
    '版本号相同但内容漂移时必须重装，否则新代码永远进不了宿主 cache');
});

test('内容一致：版本号相同且逐字节相同 → 就绪（保持幂等快路径）', () => {
  const { payload, installed } = makeTree();
  const fps = { payload: computeFingerprint(payload), installed: computeFingerprint(installed) };
  assert.strictEqual(fps.payload, fps.installed);
  assert.strictEqual(isReadyFromList(listOut('0.2.20'), '0.2.20', fps), true,
    '内容一致时应走幂等快路径，不能每次都重装');
});

test('内容漂移检测不影响「不降级」：已装更高时即使内容不同也判就绪', () => {
  // 旧 .app 的快照内容与用户手装的新版本必然不同；若此时判「未就绪」，
  // 旧 .app 就会把新版本降级覆盖回去——正是本判据要防的事。
  const fps = { payload: 'aaa', installed: 'bbb' };
  assert.strictEqual(isReadyFromList(listOut('0.2.21'), '0.2.20', fps), true,
    '已装版本更高时必须就绪，不得因内容不同而降级');
});

test('内容漂移检测不影响「升级」：包内更高时即使指纹相同也要重装', () => {
  const fps = { payload: 'same', installed: 'same' };
  assert.strictEqual(isReadyFromList(listOut('0.2.20'), '0.2.21', fps), false,
    '包内版本更高时必须重装（版本优先于内容判定）');
});

test('指纹缺失时保守退回旧行为（不可读目录不得变成「每次启动都重装」）', () => {
  const empty = { payload: '', installed: '' };
  assert.strictEqual(isReadyFromList(listOut('0.2.20'), '0.2.20', empty), true,
    '指纹算不出时应判就绪，退回纯版本比较');
  assert.strictEqual(isReadyFromList(listOut('0.2.20'), '0.2.20', undefined), true,
    '未传指纹时行为与旧版完全一致');
  assert.strictEqual(isReadyFromList(listOut('0.2.20'), '0.2.20', { payload: 'x', installed: '' }), true,
    '只有单侧指纹时也保守判就绪');
});

test('computeFingerprint：忽略 marketplace.json（构建期会按设计改写 source）', () => {
  // stagePluginPayload 把 marketplace.json 的 source 改写成 './'，
  // 两侧本就不该逐字节相同；若纳入指纹，每次启动都会误判为漂移而重装。
  const { payload, installed } = makeTree();
  fs.mkdirSync(path.join(payload, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(installed, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(payload, '.claude-plugin', 'marketplace.json'), '{"source":"./plugins/zcode-advisor"}', 'utf8');
  fs.writeFileSync(path.join(installed, '.claude-plugin', 'marketplace.json'), '{"source":"./"}', 'utf8');
  assert.strictEqual(computeFingerprint(payload), computeFingerprint(installed),
    'marketplace.json 内容不同不得计入指纹');
});

test('computeFingerprint：忽略 __pycache__ 与 .orphan-*（非 payload 产物）', () => {
  const { payload, installed } = makeTree();
  fs.mkdirSync(path.join(installed, 'tools', '__pycache__'), { recursive: true });
  fs.writeFileSync(path.join(installed, 'tools', '__pycache__', 'x.pyc'), 'junk', 'utf8');
  fs.mkdirSync(path.join(installed, '.orphan-2026'), { recursive: true });
  fs.writeFileSync(path.join(installed, '.orphan-2026', 'old.md'), 'junk', 'utf8');
  assert.strictEqual(computeFingerprint(payload), computeFingerprint(installed),
    '跑过 tools/*.py 生成的 __pycache__ 与隔离目录不得造成伪漂移');
});

test('computeFingerprint：缺文件会让指纹不同（缺失 = 内容漂移）', () => {
  const { payload, installed } = makeTree((p, i) => {
    fs.unlinkSync(path.join(i, 'README.md'));
  });
  assert.notStrictEqual(computeFingerprint(payload), computeFingerprint(installed));
});

test('computeFingerprint：目录不存在时返回空串（不抛错）', () => {
  assert.strictEqual(computeFingerprint(path.join(os.tmpdir(), 'zcadv-does-not-exist-xyz')), '');
});

test('parseInstallPath：从真实 plugins list 输出取 zcode-advisor 的 cache 目录', () => {
  const out =
    '- other-plugin@x [enabled]\n' +
    '  cache/x: /Users/u/.zcode/cli/plugins/cache/x/other/1.0.0\n' +
    '- zcode-advisor@zcode-advisor-local [enabled]\n' +
    '  cache/zcode-advisor-local: /Users/u/.zcode/cli/plugins/cache/zcode-advisor-local/zcode-advisor/0.2.20\n' +
    '  skills: 0, commands: 1, hooks: 3, mcp: plugin:zcode-advisor:config-bridge\n' +
    '- yet-another@y [enabled]\n' +
    '  cache/y: /Users/u/.zcode/cli/plugins/cache/y/other2/9.9.9\n';
  assert.strictEqual(parseInstallPath(out),
    '/Users/u/.zcode/cli/plugins/cache/zcode-advisor-local/zcode-advisor/0.2.20',
    '必须取 zcode-advisor 那一块，不能拿到相邻插件的路径');
});

test('parseInstallPath：没有 zcode-advisor 时返回空串', () => {
  assert.strictEqual(parseInstallPath('- other@x [enabled]\n  cache/x: /a/b\n'), '');
  assert.strictEqual(parseInstallPath(''), '');
});
