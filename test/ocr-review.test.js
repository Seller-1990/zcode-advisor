'use strict';

// scripts/ocr-review.sh 的回归测试。
//
// 背景（2026-10-06 实测事故）：评审报告 .git/ocr-review-last.txt 曾被**后到的进程**
// 截断式重定向覆盖，留下 188B 的 NUL 空洞、前一次的结论被吞。根因有两处：
//   ① hook 侧 `> "$REPORT"` 是截断式重定向 + 固定单一路径（hook 不在本仓库，见 ~/.dsh/hooks/）；
//   ② 脚本侧 mktemp 的 OUT_JSON 在 cleanup 里被删 → 权威原始 JSON 事后无从复核。
// 这里锁住本仓库能负责的那一半：OCR_REVIEW_RAW_OUT 让原始 JSON 活过脚本退出。
//
// 这些用例用一个隔离的临时 git 仓库 + 假 `ocr` 驱动真实脚本，不碰本仓库状态。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const REVIEWER_SRC = path.join(REPO_ROOT, 'scripts', 'ocr-review.sh');
const REVIEWER_SRC_TEXT = fs.readFileSync(REVIEWER_SRC, 'utf8');

// 能力探测：RAW_OUT 支持是与另一处改动同文件落地的，若工作区/HEAD 的脚本还没有它，
// 这些用例应当**跳过**而不是失败——否则一个尚未合入的特性会把整个测试套件染红。
const SUPPORTS_RAW_OUT = REVIEWER_SRC_TEXT.includes('OCR_REVIEW_RAW_OUT');
const skipUnlessRawOut = SUPPORTS_RAW_OUT
  ? {}
  : { skip: 'scripts/ocr-review.sh 尚不支持 OCR_REVIEW_RAW_OUT（同文件改动未合入）' };

// 加固版（拒绝目录 / 同目录临时文件 + mv 原子发布 / 不跟随符号链接）是第二轮评审整改后
// 才有的。只探测到 OCR_REVIEW_RAW_OUT 并不代表加固已合入，故单独探测。
const SUPPORTS_RAW_OUT_HARDENED =
  SUPPORTS_RAW_OUT && /mv -f "\$_raw_tmp"/.test(REVIEWER_SRC_TEXT);
const skipUnlessHardened = SUPPORTS_RAW_OUT_HARDENED
  ? {}
  : { skip: 'scripts/ocr-review.sh 的 RAW_OUT 尚未加固（原子发布/目录拒绝）' };

const COMPLETE_JSON = {
  status: 'complete',
  comments: [{ path: 'x.js', severity: 'high', content: '示例意见' }],
  summary: 'ok'
};

function mkSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zca-ocr-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.copyFileSync(REVIEWER_SRC, path.join(repo, 'scripts', 'ocr-review.sh'));
  fs.chmodSync(path.join(repo, 'scripts', 'ocr-review.sh'), 0o755);

  const git = (...args) =>
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '.');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'x.js'), 'a\n');
  git('add', '-A');
  git('commit', '-qm', 'c1');
  fs.appendFileSync(path.join(repo, 'x.js'), 'b\n');
  git('commit', '-qam', 'c2');

  // 假 ocr：解析 --output 后写一份合法的 complete JSON
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const ocrPath = path.join(bin, 'ocr');
  fs.writeFileSync(ocrPath, `#!/usr/bin/env bash
out=""
while [ $# -gt 0 ]; do case "$1" in --output) out="$2"; shift 2;; *) shift;; esac; done
printf '%s\\n' '${JSON.stringify(COMPLETE_JSON)}' > "$out"
echo "fake ocr ok"
`);
  fs.chmodSync(ocrPath, 0o755);

  const chain = path.join(root, 'chain');
  // 链文件（scope|provider|model）是**另一处改动**引入的能力，HEAD 的脚本还不认识它。
  // 写上无害（被忽略时脚本退回自己的内嵌快照），但不能让断言依赖它——
  // 否则这个测试就只能在工作区那版脚本上跑，无法给「最小补丁」当回归锁。
  // 给两条：降级链的用例需要「下一跳」存在，只有一跳时永远测不到 fallback。
  fs.writeFileSync(chain, '# scope|provider|model\npublic|fake|m1\npublic|fake|m2\n');

  // 脚本会读 $HOME/.opencodereview/agent-model 并跳过与编码代理同模型的 provider。
  // 用真实 HOME 会让断言随开发者机器状态漂移；这里放一个绝不会命中链的值。
  fs.mkdirSync(path.join(root, '.opencodereview'), { recursive: true });
  fs.writeFileSync(path.join(root, '.opencodereview', 'agent-model'), '__never_matches__\n');

  return { root, repo, bin, chain };
}

function reviewerEnv(sb, env) {
  return Object.assign({}, process.env, {
    // 隔离 HOME：脚本会读 $HOME/.opencodereview/agent-model 并**跳过同模型的 provider**，
    // 用真实 HOME 会让链的第一跳被跳过、断言随开发者机器状态漂移。
    HOME: sb.root,
    // 把脚本的 mktemp 产物（OUT_JSON / ATTEMPT_LOG）钉在沙箱内，这样「是否泄漏临时文件」
    // 可以在沙箱里精确断言，而不是去数整个 /tmp（并行跑测试时会互相干扰）。
    TMPDIR: sb.root,
    PATH: `${sb.bin}:${process.env.PATH}`,
    OCR_REVIEW_CHAIN_FILE: sb.chain,
    OCR_REVIEW_USAGE_LOG: path.join(sb.root, 'usage.log'),
    OCR_REVIEW_FORCE: '1' // 绕开并发锁，避免与真实评审/其它用例互扰
  }, env);
}

function runReviewer(sb, env) {
  return execFileSync('bash', [path.join(sb.repo, 'scripts', 'ocr-review.sh'), 'HEAD~1', 'HEAD'], {
    cwd: sb.repo,
    encoding: 'utf8',
    env: reviewerEnv(sb, env)
  });
}

// 需要在**成功**路径上检查 stderr（警告）的用例走这里：execFileSync 只在非零退出时
// 才把 stderr 交出来，而这些用例恰恰是「退出码不变、但必须吭一声」。
function runReviewerSync(sb, env) {
  const r = spawnSync('bash', [path.join(sb.repo, 'scripts', 'ocr-review.sh'), 'HEAD~1', 'HEAD'], {
    cwd: sb.repo,
    encoding: 'utf8',
    env: reviewerEnv(sb, env)
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// 覆写沙箱里的假 ocr。body 里可用 $out（--output 目标）、$STATE、$CAPTURE。
function writeFakeOcr(sb, body) {
  const p = path.join(sb.bin, 'ocr');
  fs.writeFileSync(p, body);
  fs.chmodSync(p, 0o755);
}

// 命中的那一跳由脚本自己决定（HEAD 版读内嵌快照，工作区版读链文件），
// 断言只认「有一次完整评审完成」，不绑定具体 provider/model。
const COMPLETED_RE = /评审完成（[^）]+）/;

function leftoverTempFiles(sb) {
  return fs
    .readdirSync(sb.root)
    .filter((f) => f.startsWith('ocr-review-') || f.startsWith('ocr-attempt-'));
}

test('ocr-review.sh：OCR_REVIEW_RAW_OUT 让权威原始 JSON 活过脚本退出', skipUnlessRawOut, () => {
  const sb = mkSandbox();
  const raw = path.join(sb.root, 'raw.json');
  const out = runReviewer(sb, { OCR_REVIEW_RAW_OUT: raw });

  assert.ok(fs.existsSync(raw), '原始 JSON 必须被保存（此前 cleanup 会删掉唯一的权威产物）');
  const data = JSON.parse(fs.readFileSync(raw, 'utf8'));
  assert.strictEqual(data.status, 'complete');
  assert.strictEqual(data.comments.length, 1);
  // 渲染表仍然正常输出
  assert.match(out, COMPLETED_RE);
  assert.match(out, /high/);
});

test('ocr-review.sh：不设 OCR_REVIEW_RAW_OUT 时不产生额外文件（保持旧行为）', skipUnlessRawOut, () => {
  const sb = mkSandbox();
  const raw = path.join(sb.root, 'raw.json');
  runReviewer(sb, {});
  assert.ok(!fs.existsSync(raw), '未指定 raw-out 时不应凭空创建该路径');
});

test('ocr-review.sh：mktemp 的 OUT_JSON 仍被 cleanup 删除（不因新逻辑泄漏临时文件）', skipUnlessRawOut, () => {
  const sb = mkSandbox();
  const raw = path.join(sb.root, 'raw.json');
  runReviewer(sb, { OCR_REVIEW_RAW_OUT: raw });
  const leaked = leftoverTempFiles(sb);
  assert.deepStrictEqual(leaked, [], `cleanup 应删掉 OUT_JSON，却残留：${leaked.join(', ')}`);
});

test('ocr-review.sh：评审失败时不发布 raw-out（不得把半成品当成「最后一次结论」）', skipUnlessRawOut, () => {
  const sb = mkSandbox();
  const raw = path.join(sb.root, 'raw.json');
  // 先放一份**已存在的**好结论，验证失败的那一轮不会把它覆盖成半成品
  const good = { status: 'complete', comments: [], summary: '上一次的好结论' };
  fs.writeFileSync(raw, JSON.stringify(good));

  // 假 ocr 返回非 complete 状态 → valid_output 判失败 → 链耗尽 → 脚本 exit 1
  fs.writeFileSync(path.join(sb.bin, 'ocr'), `#!/usr/bin/env bash
out=""
while [ $# -gt 0 ]; do case "$1" in --output) out="$2"; shift 2;; *) shift;; esac; done
printf '%s\\n' '{"status":"partial","comments":[]}' > "$out"
`);
  fs.chmodSync(path.join(sb.bin, 'ocr'), 0o755);

  assert.throws(() => runReviewer(sb, { OCR_REVIEW_RAW_OUT: raw }), /Command failed/);
  const data = JSON.parse(fs.readFileSync(raw, 'utf8'));
  assert.strictEqual(data.status, 'complete', 'partial 结果不得覆盖上一次的完整结论');
  assert.strictEqual(data.summary, '上一次的好结论');
});

// ── 第二轮评审（nas-hy4/minimax-m3）6 条意见的整改回归锁 ─────────────────────────
// 意见 #6：此前只覆盖「全失败」，缺「前一跳写 partial、后一跳成功」的边界。
test(
  'ocr-review.sh：前一跳写 partial、后一跳成功时，只发布成功那次的原始 JSON（逐字节一致）',
  skipUnlessRawOut,
  () => {
    const sb = mkSandbox();
    const raw = path.join(sb.root, 'raw.json');
    const capture = path.join(sb.root, 'capture.json');
    const state = path.join(sb.root, 'state');
    fs.mkdirSync(state, { recursive: true });

    // 第 1 跳：返回 partial（无效）→ 脚本应继续降级，且**不得**把这份半成品发布出去。
    // 第 2 跳起：返回完整 JSON，并把同一份字节抄到 $CAPTURE 供逐字节比对。
    // 用计数文件而不是固定「第几次调用」，这样 HEAD 版（读内嵌 9 条快照）与工作区版
    // （读链文件）都能跑：两边都会在第 2 跳拿到成功结果。
    writeFakeOcr(sb, `#!/usr/bin/env bash
out=""
while [ $# -gt 0 ]; do case "$1" in --output) out="$2"; shift 2;; *) shift;; esac; done
n=0
if [ -f "$STATE/count" ]; then n=$(cat "$STATE/count"); fi
n=$((n + 1))
printf '%s' "$n" > "$STATE/count"
if [ "$n" -eq 1 ]; then
  printf '%s\\n' '{"status":"partial","comments":[]}' > "$out"
  exit 0
fi
printf '%s\\n' '${JSON.stringify(COMPLETE_JSON)}' > "$out"
cp -f "$out" "$CAPTURE"
exit 0
`);

    const out = runReviewer(sb, { OCR_REVIEW_RAW_OUT: raw, STATE: state, CAPTURE: capture });
    assert.match(out, COMPLETED_RE, '第 2 跳成功后应渲染出评审完成');

    const published = fs.readFileSync(raw, 'utf8');
    const data = JSON.parse(published);
    assert.strictEqual(data.status, 'complete', '发布的必须是成功那一跳，而不是第 1 跳的 partial');
    assert.strictEqual(data.comments.length, 1);
    // 意见 #6 的具体要求：发布内容与 OUT_JSON 逐字节一致（中间没有经过重新序列化）
    assert.strictEqual(
      published,
      fs.readFileSync(capture, 'utf8'),
      'RAW_OUT 必须与 ocr 写出的原始 JSON 逐字节一致'
    );
  }
);

// 意见 #1：把目录传进来时，cp/mv 会把文件**塞进目录**并可能覆盖同名文件。
test('ocr-review.sh：OCR_REVIEW_RAW_OUT 指向目录时明确拒绝并警告（不把文件塞进去）', skipUnlessHardened, () => {
  const sb = mkSandbox();
  const rawDir = path.join(sb.root, 'rawdir');
  fs.mkdirSync(rawDir);
  // 目录里放一个同名文件，旧实现会把它覆盖掉
  fs.writeFileSync(path.join(rawDir, 'raw.json'), '不该被覆盖');

  const r = runReviewerSync(sb, { OCR_REVIEW_RAW_OUT: rawDir });
  assert.strictEqual(r.code, 0, '拒绝保存不应改变脚本本身的退出码');
  assert.match(r.stderr, /警告/, '拒绝保存必须出声，不能静默');
  assert.deepStrictEqual(
    fs.readdirSync(rawDir),
    ['raw.json'],
    '不得往目标目录里塞文件，也不得覆盖目录内同名文件'
  );
  assert.strictEqual(fs.readFileSync(path.join(rawDir, 'raw.json'), 'utf8'), '不该被覆盖');
});

// 意见 #5：cp **跟随**符号链接（把内容写穿到链接目标）；mv 替换链接本身。
test('ocr-review.sh：目标是指向别处的符号链接时替换链接本身，不写穿被指向的文件', skipUnlessHardened, () => {
  const sb = mkSandbox();
  const real = path.join(sb.root, 'real.json');
  const link = path.join(sb.root, 'link.json');
  fs.writeFileSync(real, '被链接的真实文件，必须原封不动');
  fs.symlinkSync(real, link);

  runReviewer(sb, { OCR_REVIEW_RAW_OUT: link });

  assert.ok(!fs.lstatSync(link).isSymbolicLink(), '符号链接应被替换成普通文件，而不是继续指向别处');
  assert.strictEqual(
    fs.readFileSync(real, 'utf8'),
    '被链接的真实文件，必须原封不动',
    'cp 会写穿链接、污染目标文件；mv 不会'
  );
  const data = JSON.parse(fs.readFileSync(link, 'utf8'));
  assert.strictEqual(data.status, 'complete');
});

// 意见 #4：cp 是「打开→截断→写入」，并发读者会看到 0 字节或半截文件；脚本明确支持
// OCR_REVIEW_FORCE=1 并行，故发布必须原子（同目录临时文件 + mv）。
// 原子性无法在黑盒里稳定观察（发布发生在 cleanup、就在进程退出前），故用静态守卫钉住实现，
// 再用「不留临时文件」和「写失败要出声」两条行为用例兜住失败面。
test('ocr-review.sh：发布走「同目录临时文件 + mv」而非直接 cp（原子发布，不跟随链接）', skipUnlessHardened, () => {
  assert.match(
    REVIEWER_SRC_TEXT,
    /mv -f "\$_raw_tmp" "\$OCR_REVIEW_RAW_OUT"/,
    '必须以 mv 原子发布临时文件'
  );
  assert.doesNotMatch(
    REVIEWER_SRC_TEXT,
    /cp -f "\$OUT_JSON" "\$OCR_REVIEW_RAW_OUT"/,
    '不得直接 cp 到目标：非原子且会跟随符号链接'
  );
});

test('ocr-review.sh：成功发布后不留中间文件', skipUnlessHardened, () => {
  const sb = mkSandbox();
  const raw = path.join(sb.root, 'raw.json');
  runReviewer(sb, { OCR_REVIEW_RAW_OUT: raw });
  assert.ok(fs.existsSync(raw));
  const leftovers = fs.readdirSync(sb.root).filter((f) => f.includes('.tmp.') || f.startsWith('.ocr-raw-'));
  assert.deepStrictEqual(leftovers, [], `不得残留临时文件：${leftovers.join(', ')}`);
});

// 第三轮评审意见 #3：临时名若是 "${TARGET}.tmp.$$"，PID 可枚举，攻击者能预置同名符号
// 链接，而 cp 会跟随它把内容写穿到任意文件（已实测复现）。必须用 mktemp。
test('ocr-review.sh：临时文件名不可预测（不得用 .tmp.$$ 这类可枚举名）', skipUnlessHardened, () => {
  assert.doesNotMatch(
    REVIEWER_SRC_TEXT,
    /_raw_tmp="\$\{OCR_REVIEW_RAW_OUT\}\.tmp\.\$\$"/,
    '可预测的临时名 + cp 跟随符号链接 = 任意文件写穿，必须改用 mktemp'
  );
  assert.match(
    REVIEWER_SRC_TEXT,
    /_raw_tmp="\$\(mktemp /,
    '临时文件必须由 mktemp 创建（O_EXCL，不会被既有链接抢占）'
  );
});

// 第三轮评审意见 #6：指向目录的符号链接也要被拒绝（[ -d ] 会跟随链接）。
test('ocr-review.sh：OCR_REVIEW_RAW_OUT 是指向目录的符号链接时同样拒绝', skipUnlessHardened, () => {
  const sb = mkSandbox();
  const realDir = path.join(sb.root, 'realdir');
  const link = path.join(sb.root, 'linkdir');
  fs.mkdirSync(realDir);
  fs.symlinkSync(realDir, link);

  const r = runReviewerSync(sb, { OCR_REVIEW_RAW_OUT: link });
  assert.strictEqual(r.code, 0, '拒绝保存不应改变脚本本身的退出码');
  assert.match(r.stderr, /警告/, '必须出声');
  assert.deepStrictEqual(fs.readdirSync(realDir), [], '不得往链接指向的目录里塞文件');
  assert.ok(fs.lstatSync(link).isSymbolicLink(), '链接本身不应被替换');
});

// 第三轮评审意见 #2：两条警告都应回显实际路径值，而不是只说变量名。
test('ocr-review.sh：警告必须回显实际路径值（便于定位）', skipUnlessHardened, () => {
  const sb = mkSandbox();
  const rawDir = path.join(sb.root, 'rawdir');
  fs.mkdirSync(rawDir);
  const r = runReviewerSync(sb, { OCR_REVIEW_RAW_OUT: rawDir });
  assert.match(r.stderr, new RegExp(rawDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '警告里应含被拒绝的实际路径');
});

// 意见 #2：写失败曾用 `2>/dev/null || true` 完全静默，与「事后可复核」的初衷矛盾。
test('ocr-review.sh：保存失败时必须警告，但不改变脚本退出码', skipUnlessHardened, () => {
  const sb = mkSandbox();
  // 父目录不存在 → 临时文件与 mv 都会失败
  const raw = path.join(sb.root, 'no-such-dir', 'raw.json');
  const r = runReviewerSync(sb, { OCR_REVIEW_RAW_OUT: raw });
  assert.strictEqual(r.code, 0, '保存失败不应把评审判为失败');
  assert.match(r.stdout, COMPLETED_RE, '评审本身仍然成功');
  assert.match(r.stderr, /警告.*保存原始 JSON/, '写失败必须出声');
  assert.ok(!fs.existsSync(raw));
});

// 第四轮评审意见 #1 判为误报：dirname 对 "/foo.json" 返回 "/"、对 "foo.json" 返回 "."，
// **永不为空**，故 `${_raw_dir%/}` 不会退化成空串、也就不需要 `_raw_dir="${_raw_dir:-.}"`。
// 该建议非但是空操作，若真把 _raw_dir 兜底成 "."，临时文件会落到 CWD、与目标可能跨文件
// 系统，mv 退化成 copy+unlink —— 恰好破坏上面 ③ 条「只有同目录 mv 才原子」的前提。
// 用静态守卫钉住这个判断，免得下次评审又提同一建议。
test('ocr-review.sh：不得为 _raw_dir 加 "." 兜底（会破坏同目录原子发布）', skipUnlessHardened, () => {
  assert.doesNotMatch(
    REVIEWER_SRC_TEXT,
    /_raw_dir="\$\{_raw_dir:-\.\}"/,
    'dirname 永不为空；兜底成 "." 会让临时文件离开目标目录，跨文件系统时 mv 不再原子'
  );
  // 真实行为核对：dirname 的两种极端输入都不是空串
  const { execFileSync } = require('node:child_process');
  const dirname = (p) => execFileSync('dirname', [p], { encoding: 'utf8' }).trim();
  assert.strictEqual(dirname('/foo.json'), '/');
  assert.strictEqual(dirname('foo.json'), '.');
});

// 第四轮评审意见 #4：建议「预清理目标目录里历史的 .ocr-raw-*」。本脚本用
// OCR_REVIEW_FORCE=1 明确支持并行评审，另一个并发进程的临时文件正等着 mv，清掉它等于
// 毁掉那次评审的发布。故只清自己的 _raw_tmp，绝不扫描删除别人的。
test('ocr-review.sh：不得预清理目录里他人的 .ocr-raw-*（会毁掉并发评审的发布）', skipUnlessHardened, () => {
  const sb = mkSandbox();
  const otherTmp = path.join(sb.root, '.ocr-raw-otherpid');
  fs.writeFileSync(otherTmp, '另一个并发评审正在用的临时文件');
  const raw = path.join(sb.root, 'raw.json');

  runReviewer(sb, { OCR_REVIEW_RAW_OUT: raw });

  assert.ok(fs.existsSync(otherTmp), '不得删除并发进程的临时文件');
  assert.strictEqual(fs.readFileSync(otherTmp, 'utf8'), '另一个并发评审正在用的临时文件');
  assert.ok(fs.existsSync(raw), '自己的发布仍应成功');
});

// mktemp 建的是 0600，mv 保留该权限 → 发布出去的原始 JSON（可能含代码）不对同机其他用户可读。
// 旧的 `cp -f` 直写会带上 umask（通常 0644），这条守卫防止实现被改回去。
test('ocr-review.sh：发布出的原始 JSON 权限不得宽于 0600（评审原文可能含代码）', skipUnlessHardened, () => {
  const sb = mkSandbox();
  const raw = path.join(sb.root, 'raw.json');
  runReviewer(sb, { OCR_REVIEW_RAW_OUT: raw });
  assert.ok(fs.existsSync(raw));
  const mode = fs.statSync(raw).mode & 0o777;
  assert.strictEqual(mode & 0o077, 0, `不得对组/其他用户开放，实际权限 ${mode.toString(8)}`);
});
