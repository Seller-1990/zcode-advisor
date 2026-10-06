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
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const REVIEWER_SRC = path.join(REPO_ROOT, 'scripts', 'ocr-review.sh');

// 能力探测：RAW_OUT 支持是与另一处改动同文件落地的，若工作区/HEAD 的脚本还没有它，
// 这些用例应当**跳过**而不是失败——否则一个尚未合入的特性会把整个测试套件染红。
const SUPPORTS_RAW_OUT = fs
  .readFileSync(REVIEWER_SRC, 'utf8')
  .includes('OCR_REVIEW_RAW_OUT');
const skipUnlessRawOut = SUPPORTS_RAW_OUT
  ? {}
  : { skip: 'scripts/ocr-review.sh 尚不支持 OCR_REVIEW_RAW_OUT（同文件改动未合入）' };

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
  fs.writeFileSync(chain, '# scope|provider|model\npublic|fake|m1\n');

  return { root, repo, bin, chain };
}

function runReviewer(sb, env) {
  return execFileSync('bash', [path.join(sb.repo, 'scripts', 'ocr-review.sh'), 'HEAD~1', 'HEAD'], {
    cwd: sb.repo,
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
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
    }, env)
  });
}

// 命中的那一跳由脚本自己决定（HEAD 版读内嵌快照，工作区版读链文件），
// 断言只认「有一次完整评审完成」，不绑定具体 provider/model。
const COMPLETED_RE = /评审完成（[^）]+）/;

function leftoverTempFiles(sb) {
  return fs
    .readdirSync(sb.root)
    .filter((f) => f.startsWith('ocr-review-') || f.startsWith('ocr-attempt-'));
}

test('ocr-review.sh：OCR_REVIEW_RAW_OUT 让权威原始 JSON 活过脚本退出', () => {
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

test('ocr-review.sh：不设 OCR_REVIEW_RAW_OUT 时不产生额外文件（保持旧行为）', () => {
  const sb = mkSandbox();
  const raw = path.join(sb.root, 'raw.json');
  runReviewer(sb, {});
  assert.ok(!fs.existsSync(raw), '未指定 raw-out 时不应凭空创建该路径');
});

test('ocr-review.sh：mktemp 的 OUT_JSON 仍被 cleanup 删除（不因新逻辑泄漏临时文件）', () => {
  const sb = mkSandbox();
  const raw = path.join(sb.root, 'raw.json');
  runReviewer(sb, { OCR_REVIEW_RAW_OUT: raw });
  const leaked = leftoverTempFiles(sb);
  assert.deepStrictEqual(leaked, [], `cleanup 应删掉 OUT_JSON，却残留：${leaked.join(', ')}`);
});

test('ocr-review.sh：评审失败时不发布 raw-out（不得把半成品当成「最后一次结论」）', () => {
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
