'use strict';

// 探针（非产品代码）：确认 R01「陈旧锁并发接管」用例在负载下报出「2 个赢家」的成因。
// 假设二选一：
//   (a) 真缺陷——两个实例同时持锁（赢家时间戳几乎相同，且都在 400ms 存活窗口内）；
//   (b) 用例时序 artifact——先赢的子进程 400ms 后 exit 并 unlink 锁，被负载推迟的
//       子进程这时才执行 acquireLock()，取到的是「上一个赢家已释放」的空锁（合法行为），
//       却被 runChild 的 `out.includes('ACQUIRED=1')` 计成第二个赢家。
//
// 判据：把每个子进程打印 ACQUIRED=1 的绝对时刻带出来，与 syncAt 和「第一个赢家退出时刻」比较。
// 用法：node .audit-evidence/r01-flake-probe.cjs [trials] [loadProcs]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const TRIALS = Number(process.argv[2] || 6);
const LOAD = Number(process.argv[3] || 0);
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'zca-r01-probe-'));
const TMP = path.join(fixture, 'tmp');
fs.mkdirSync(TMP, { recursive: true });
const CONTROLLER = path.join(__dirname, '..', 'tools', 'companion', 'controller.cjs');
const LOCK = path.join(TMP, 'zcode-advisor-companion.lock');

const CHILD = `
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _internal } = require(process.env.ZCA_CONTROLLER);
const LOCK = path.join(os.tmpdir(), 'zcode-advisor-companion.lock');
const until = Number(process.env.ZCA_SYNC_AT);
while (Date.now() < until) {}
const ok = _internal.acquireLock();
const holderNow = (function () { try { return String(_internal.readLockInfo(LOCK).pid || ''); } catch (_) { return 'ERR'; } })();
const extra = (function () {
  try { return fs.readdirSync(path.dirname(LOCK)).filter((n) => n.indexOf('.stale-') >= 0 || n.indexOf('.tmp-') >= 0).join(','); }
  catch (_) { return 'ERR'; }
})();
process.stdout.write('RESULT=' + (ok ? 1 : 0) + ' at=' + Date.now() +
  ' exitAt=' + (Date.now() + 400) + ' pid=' + process.pid +
  ' holderNow=' + holderNow + ' files=[' + extra + ']\\n');
setTimeout(() => {
  const holderEnd = (function () { try { return String(_internal.readLockInfo(LOCK).pid || ''); } catch (_) { return 'ERR'; } })();
  process.stdout.write('END pid=' + process.pid + ' holderEnd=' + holderEnd + ' at=' + Date.now() + '\\n');
  process.exit(0);
}, 400);
`;

function runChild(syncAt) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', CHILD], {
      env: Object.assign({}, process.env, {
        HOME: fixture,
        USERPROFILE: fixture,
        TMPDIR: TMP,
        TMP: TMP,
        TEMP: TMP,
        ZCA_CONTROLLER: CONTROLLER,
        ZCA_SYNC_AT: String(syncAt),
        ZCODE_ADVISOR_COMPANION_LOG: path.join(fixture, 'companion.log')
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => resolve({ ok: false, at: 0, exitAt: 0, pid: 0 }));
    child.on('exit', () => {
      const ok = /RESULT=1/.test(out);
      const at = Number((out.match(/ at=(\d+)/) || [])[1] || 0);
      const exitAt = Number((out.match(/ exitAt=(\d+)/) || [])[1] || 0);
      const pid = Number((out.match(/ pid=(\d+)/) || [])[1] || 0);
      const holderNow = (out.match(/ holderNow=(\S*)/) || [])[1] || '';
      const holderEnd = (out.match(/ holderEnd=(\S*)/) || [])[1] || '';
      const files = (out.match(/ files=\[([^\]]*)\]/) || [])[1] || '';
      resolve({ ok, at, exitAt, pid, holderNow, holderEnd, files });
    });
  });
}

function startLoad(n) {
  const kids = [];
  for (let i = 0; i < n; i++) {
    kids.push(spawn(process.execPath, ['-e', 'const t=Date.now()+8000; while(Date.now()<t){Math.sqrt(Math.random());}'], { stdio: 'ignore' }));
  }
  return kids;
}

(async () => {
  const load = LOAD > 0 ? startLoad(LOAD) : [];
  console.log(`probe: trials=${TRIALS} loadProcs=${LOAD} tmp=${TMP}`);
  let doubleSeen = 0;
  for (let trial = 1; trial <= TRIALS; trial++) {
    const staleTs = Date.now() - 10 * 60 * 1000;
    fs.writeFileSync(LOCK, `pid=2147483646\nstarted=${staleTs}\ncdp=0\ncdpSince=${staleTs}\n`, 'utf8');
    const syncAt = Date.now() + 700;
    const res = await Promise.all(Array.from({ length: 6 }, () => runChild(syncAt)));
    const winners = res.filter((r) => r.ok).sort((a, b) => a.at - b.at);
    if (winners.length > 1) doubleSeen += 1;
    const rel = winners.map((w) => `+${w.at - syncAt}ms(pid ${w.pid}, holderNow=${w.holderNow}, holderEnd=${w.holderEnd}, 存活至 +${w.exitAt - syncAt}ms, files=[${w.files}])`);
    console.log(`trial ${trial}: winners=${winners.length} [${rel.join(' | ')}]`);
  }
  for (const k of load) { try { k.kill('SIGKILL'); } catch (_) {} }
  console.log(`summary: ${doubleSeen}/${TRIALS} trials with >1 winner`);
  try { fs.rmSync(fixture, { recursive: true, force: true }); } catch (_) {}
})();
