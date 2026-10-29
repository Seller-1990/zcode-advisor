'use strict';

// 顾问意见历史（JSONL 追加写）。
//
// 目的：把"顾问说了什么 / 什么时候说的 / 是否送达"持久化，供面板与人工回看。
// 对应 issue #102 的教训——可见性不只靠 status 计数，还要能回看具体意见。
//
// 设计：
// - **追加写**（append + flush）：崩溃安全，不重写已有内容；
// - **全局单文件**：跨会话可见，面板无需汇总多文件（用户已确认该取舍）；
// - **限制条数**：超过上限时整文件裁剪到一半（追加型日志的简单回收策略）；
// - 每行一个 JSON 对象：{ts, severity, note, sessionId, delivered, reason?}。
//
// 写入点（由调用方保证）：
// - enqueueNote 成功 → 记一条（delivered=false，待送达时由 UPS 补充标记）；
// - 送达 → 另记一条 delivered=true？——不必：入队时记 `queued`，
//   送达时在 UPS 里把该会话未送达的记录批量补记为 delivered，
//   代价是两次读文件；这里选择更简单的口径：**入队即记，事件字段区分 queued/delivered/dropped**。

const fs = require('fs');
const os = require('os');
const path = require('path');

const HISTORY_MAX_LINES = 500;      // 单文件上限（超过裁剪到一半）

// 路径解析：测试/CI 用 ZCODE_ADVISOR_STATE_DIR 隔离（与 state/config 同一套约定），
// 避免测试运行把假记录写进用户真实目录（实测踩过：e2e 曾污染 ~/.zcode）。
function resolveHistoryFile(env) {
  const e = env || process.env;
  if (e.ZCODE_ADVISOR_HISTORY) return e.ZCODE_ADVISOR_HISTORY;
  if (e.ZCODE_ADVISOR_STATE_DIR) return path.join(e.ZCODE_ADVISOR_STATE_DIR, 'advisor-history.jsonl');
  return path.join(os.homedir(), '.zcode', 'advisor-history.jsonl');
}

const HISTORY_FILE = resolveHistoryFile();

// 追加一条历史记录。任何失败都只静默返回（历史是辅助功能，绝不影响主流程）。
// 注意：HISTORY_FILE 在模块加载时解析 env——测试需在 require 前设置隔离变量。
function appendHistory(event) {
  try {
    const record = Object.assign({ ts: new Date().toISOString() }, event);
    // 目录 0o700 / 文件 0o600：历史含意见正文（可能引用源码片段），仅属主可读。
    // 与转录快照同等级别处理（快照已 0o600，历史曾遗漏——安全复审指出）。
    // mkdir + 收紧权限每进程一次即可（热路径不重复 syscall）。
    if (!prepared) {
      fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true, mode: 0o700 });
      fs.appendFileSync(HISTORY_FILE, '', { encoding: 'utf8', mode: 0o600 });
      try { fs.chmodSync(HISTORY_FILE, 0o600); } catch (_) {} // 历史遗留宽权限文件补正
      prepared = true;
    }
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 });
    trimIfNeeded();
    return true;
  } catch (_) {
    return false;   // 磁盘满/权限等：历史缺失可接受，主流程不受影响
  }
}

// 超过上限时裁剪到一半（按**行数**判断，不是字节——每行约 70B，500 行仅 ~35KB，
// 若以 64KB 字节为门槛，行数上限将永远不会触发，测试已抓到该缺陷）
//
// 并发语义（R05）：原来是「读全量 → 整段重写同一个文件」，两者之间别的进程 append
// 的记录会被这次重写整段覆盖——历史里凭空少记录，且没有任何错误可观测。现在改为：
//   1) 裁剪结果先写同目录临时文件（写坏了也不动原文件）；
//   2) 再从「裁剪前读到的字节数」偏移处，把期间被并发追加的尾巴补读并 append 到临时文件；
//   3) rename 原子替换（与 state.js 的写盘口径一致）。
// 残余窗口（如实披露，未声称竞态已消除）：最后一次补读与 rename 之间新追加的记录仍会丢。
let prepared = false;
// 最短记录 `{"ts":"<24 字符 ISO>"}\n` = 33 字节：文件小于 上限×33 时行数不可能超限，免读全文件。
const TRIM_MIN_BYTES = HISTORY_MAX_LINES * 33;

function trimIfNeeded() {
  try {
    if (fs.statSync(HISTORY_FILE).size <= TRIM_MIN_BYTES) return;
    const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length <= HISTORY_MAX_LINES) return;
    const keep = lines.slice(-Math.floor(HISTORY_MAX_LINES / 2)).join('\n') + '\n';
    const tmp = `${HISTORY_FILE}.trim-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(tmp, keep, { encoding: 'utf8', mode: 0o600 });
      // 补读并发追加：以裁剪前读到的字节数为界，多轮循环把新尾部搬进临时文件。
      let offset = Buffer.byteLength(raw, 'utf8');
      for (let i = 0; i < 3; i++) {
        const size = fs.statSync(HISTORY_FILE).size;
        if (size <= offset) break;
        const fd = fs.openSync(HISTORY_FILE, 'r');
        try {
          const buf = Buffer.alloc(size - offset);
          const read = fs.readSync(fd, buf, 0, buf.length, offset);
          if (read > 0) fs.appendFileSync(tmp, buf.subarray(0, read));
          offset += read;
        } finally {
          fs.closeSync(fd);
        }
      }
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, HISTORY_FILE);
    } finally {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
    }
  } catch (_) { /* 裁剪失败下次再试 */ }
}

// 读取最近 limit 条（新的在前）。文件不存在或损坏行会被跳过。
function readHistory(limit) {
  const max = Number.isFinite(limit) && limit > 0 ? limit : 20;
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
    const out = [];
    const lines = raw.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0 && out.length < max; i--) {
      try { out.push(JSON.parse(lines[i])); } catch (_) { /* 跳过坏行 */ }
    }
    return out;
  } catch (_) {
    return [];
  }
}

module.exports = { appendHistory, readHistory, HISTORY_FILE, HISTORY_MAX_LINES };
