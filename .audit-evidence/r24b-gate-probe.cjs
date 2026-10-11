'use strict';
// R24b 探针：核实「附带收益」——`.global-workers.lock`（admitGlobalWorker 的准入闸门）
// 崩溃残留是否也会被 R24 的死属主回收。前提是锁文件内容为属主 pid。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CUR = path.join(ROOT, 'hooks', 'lib', 'state.js');
const PRE = path.join(ROOT, '.audit-evidence', 'r24-snapshot', 'state.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r24b-'));
const gate = path.join(dir, '.global-workers.lock');

// 真子进程「持锁时 process.exit(0)」——process.exit 不展开栈，withExclusiveLock 的 finally 不执行
const childCode = `
const state = require(${JSON.stringify(CUR)});
state.withExclusiveLock(process.argv[1], () => process.exit(0));
`;
function leaveResidualGate() {
  try { fs.unlinkSync(gate); } catch (_) {}
  const r = spawnSync(process.execPath, ['-e', childCode, gate], { encoding: 'utf8' });
  return r;
}

const r1 = leaveResidualGate();
const residual = fs.existsSync(gate);
const content = residual ? fs.readFileSync(gate, 'utf8') : null;
console.log('① 子进程 exit=' + r1.status + ' stderr=' + JSON.stringify((r1.stderr || '').trim()));
console.log('② 残留闸门文件存在=' + residual + ' 内容=' + JSON.stringify(content) +
            ' 是纯数字 pid=' + /^\d+$/.test(String(content)));

function tryAcquire(mod, label) {
  const state = require(mod);
  const t0 = Date.now();
  const ret = state.withExclusiveLock(gate, () => 'ok');
  console.log(`${label}: 返回=${JSON.stringify(ret)} 耗时=${Date.now() - t0}ms 锁仍在=${fs.existsSync(gate)}`);
  return ret;
}

// ③ pre-fix（git HEAD 快照）对残留闸门的行为
tryAcquire(PRE, '③ pre-fix  withExclusiveLock(.global-workers.lock)');
console.log('   残留闸门是否仍在（pre-fix 未回收）=' + fs.existsSync(gate));

// ④ post-fix（当前 tree）对同一残留闸门的行为
tryAcquire(CUR, '④ post-fix withExclusiveLock(.global-workers.lock)');

// ⑤ post-fix 真实准入路径：再造残留闸门，然后调 admitGlobalWorker
leaveResidualGate();
const state = require(CUR);
const t0 = Date.now();
const adm = state.admitGlobalWorker(path.join(dir, 'sess-x.json'), dir, 10000, 1);
console.log(`⑤ post-fix admitGlobalWorker(limit=1) 结果=${JSON.stringify(adm)} 耗时=${Date.now() - t0}ms 闸门仍在=${fs.existsSync(gate)}`);
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
