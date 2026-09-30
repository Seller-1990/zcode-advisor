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
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(record) + '\n', 'utf8');
    trimIfNeeded();
    return true;
  } catch (_) {
    return false;   // 磁盘满/权限等：历史缺失可接受，主流程不受影响
  }
}

// 超过上限时裁剪到一半（按**行数**判断，不是字节——每行约 70B，500 行仅 ~35KB，
// 若以 64KB 字节为门槛，行数上限将永远不会触发，测试已抓到该缺陷）
function trimIfNeeded() {
  try {
    const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length <= HISTORY_MAX_LINES) return;
    fs.writeFileSync(HISTORY_FILE, lines.slice(-Math.floor(HISTORY_MAX_LINES / 2)).join('\n') + '\n', 'utf8');
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
