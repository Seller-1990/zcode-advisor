'use strict';

// R02 红灯证据的取证脚本：把「批次一已修 / R02 未修」的 auto-enable.cjs 复原到
// tools/companion/.tmp-prefix-auto-enable.cjs，用同一份测试在修复前后各跑一次。
//
// 为什么需要复原而不是用 git：工作树里的改动（批次一 + R02）都还没提交，
// `git checkout` 会把批次一的修复一起退掉；而 plugins/ 镜像缺 .claude-plugin/
// （findPluginPayload 找不到市场目录，跑不到锁流程）。因此按 R02 的补丁逐条反向替换，
// 得到的正是「冻结树」里的那份行为。每条替换都断言命中且只命中一次，避免静默失配。

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'tools', 'companion', 'auto-enable.cjs');
const OUT = path.join(__dirname, '..', 'tools', 'companion', '.tmp-prefix-auto-enable.cjs');

// [修复后文本, 修复前文本, 标签]
const PAIRS = [
  [`// ③ **单步耗时有上界**：TTL 判据要成立，必须保证真实持锁者不会超过 TTL 不续租。
//    单次启用最坏 = alreadyEnabled(≤60s) + 4×(≤120s) = 540s，**大于 5 分钟 TTL**
//    （原注释断言「TTL 远大于单次启用耗时」，实测不成立：长安装跑到第 6 分钟就会被
//    后到的实例判为陈旧并接管，两个实例同时对同一份宿主插件缓存跑 CLI）。
//    因此每个步骤边界都续租（见 renewFlight），使「未续租间隔」的上界恒为
//    **单步超时 120s < TTL 300s**；而真正死掉（或 pid 被复用）的锁没人续租，
//    仍会在 TTL 之后按预期被接管——两条语义同时成立。
// ④ **释放要认主**：只有租约还写着自己 pid 时才删锁，否则会把接管者的锁删掉。
const LOCK_TTL_MS = 5 * 60 * 1000;   // 5 分钟：单步最长 2 分钟，超时必属异常
`,
    `//    （另有 zcode-advisor 自检：TTL 远大于单次启用耗时，不会误杀正常持锁。）
const LOCK_TTL_MS = 5 * 60 * 1000;   // 5 分钟：单次启用只需数秒，超时必属异常
`, 'TTL 注释'],

  [`// 续租：把 started 刷成「现在」，证明持锁者还在干活。
// 续租前先确认锁仍是自己的：一旦被接管（TTL 误判 / pid 被复用），就停止续租，
// 绝不把接管者的租约改回自己的名字（与 controller 的心跳同一纪律）。
function renewFlight(lockDir) {
  if (!lockDir) return false;
  try {
    const info = path.join(lockDir, 'info');
    const cur = readLockInfo(info);
    if (cur.pid !== process.pid) return false;
    fs.writeFileSync(info, \`pid=\${process.pid}\\nstarted=\${Date.now()}\\n\`, 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

function main() {`, `function main() {`, 'renewFlight'],

  [`  const releaseFlight = () => {
    try {
      const info = path.join(flight.lockDir, 'info');
      const cur = readLockInfo(info);
      // 租约已被别人接管（pid 不是自己）→ 绝不删别人的锁。
      if (cur.pid && cur.pid !== process.pid) return;
      // 先摘掉自己的租约再删目录：目录非空说明新主已写入租约，
      // rmdir 会失败（我们不再动它）——避免"删除空壳目录"把新主的锁一起删掉。
      try { fs.unlinkSync(info); } catch (_) {}
      fs.rmdirSync(flight.lockDir);
    } catch (_) {}
  };`, `  const releaseFlight = () => { try { fs.rmSync(flight.lockDir, { recursive: true, force: true }); } catch (_) {} };`, 'releaseFlight'],

  [`    return runEnable(flight.lockDir);`, `    return runEnable();`, 'runEnable 调用'],

  [`function runEnable(lockDir) {`, `function runEnable() {`, 'runEnable 签名'],

  [`  for (const args of steps) {
    // 步骤边界续租：单步最长 120s < TTL 300s，因此真实持锁者永远不会
    // 在跑长安装的过程中被别人判成陈旧（R02）。
    renewFlight(lockDir);
    try {`, `  for (const args of steps) {
    try {`, '步骤边界续租']
];

let src = fs.readFileSync(FILE, 'utf8');
for (const [fixed, before, label] of PAIRS) {
  const n = src.split(fixed).length - 1;
  if (n !== 1) throw new Error(`${label}：修复后文本命中 ${n} 次（应为 1）`);
  src = src.replace(fixed, before);
}
// 复原后不应再留任何 R02 痕迹
for (const kw of ['renewFlight', 'createLockExclusive', 'rmdirSync']) {
  if (src.includes(kw)) throw new Error(`复原后仍含 ${kw}`);
}
fs.writeFileSync(OUT, src, 'utf8');
console.log(`OK 已复原：${OUT}`);
