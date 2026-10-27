'use strict';

// 审查失败样本留存（unparsed / llm_truncated 专供，P1-③）。
//
// 动机：2026-10-24~26 的 unparsed 丢弃潮事后无法归因——计数器只说"失败了 N 次"，
// 原始响应长什么样（半截 JSON？散文？端点错误页？）没有任何留痕，debug 日志默认关闭。
// 诊断"模型到底返回了什么"必须靠样本，而不是靠猜测。
//
// 设计：
// - **只存模型响应头部**（默认 200 字符，按码点截断），不存转录——样本可能引用对话
//   片段，但它是模型生成物，与 advisor-history 的意见正文同级；文件 0o600 仅属主可读；
// - **追加写** + 超限裁剪到一半（与 history.js 同一回收策略）——丢弃潮刷屏时有界；
// - 任何失败都静默返回（样本是诊断辅助，绝不影响审查主流程）；
// - env 覆盖：ZCODE_ADVISOR_SAMPLES（测试/CI 隔离用）。

const fs = require('fs');
const os = require('os');
const path = require('path');

const SAMPLES_MAX_LINES = 100;   // 单文件上限（超过裁剪到一半）
const SAMPLE_HEAD_CHARS = 200;   // 原始响应留存的最大码点数

function resolveSamplesFile(env) {
  const e = env || process.env;
  if (e.ZCODE_ADVISOR_SAMPLES) return e.ZCODE_ADVISOR_SAMPLES;
  if (e.ZCODE_ADVISOR_STATE_DIR) return path.join(e.ZCODE_ADVISOR_STATE_DIR, 'review-samples.jsonl');
  return path.join(os.homedir(), '.zcode', 'advisor-review-samples.jsonl');
}

// 按码点截断（不劈开 emoji/代理对），先做空白归一——JSON 残骸往往带着长段缩进。
function headOf(text, max) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(t);
  if (chars.length <= max) return t;
  return `${chars.slice(0, max).join('')}…`;
}

// 追加一条样本。entry: {error, model, finishReason, textHead, deltaChars, ms}。
// 时间戳与事件类型在这里补齐；调用方只给事实字段。
function appendSample(entry) {
  try {
    const file = resolveSamplesFile();
    const e = entry || {};
    const record = {
      ts: new Date().toISOString(),
      error: String(e.error || '').slice(0, 40),
      model: String(e.model || '').slice(0, 80),
      finishReason: String(e.finishReason || '').slice(0, 40),
      textHead: headOf(e.textHead, SAMPLE_HEAD_CHARS),
      deltaChars: Number(e.deltaChars) || 0,
      ms: Number(e.ms) || 0
    };
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch (_) {}
    trimIfNeeded(file);
    return true;
  } catch (_) {
    return false;
  }
}

function trimIfNeeded(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length <= SAMPLES_MAX_LINES) return;
    fs.writeFileSync(file, lines.slice(-Math.floor(SAMPLES_MAX_LINES / 2)).join('\n') + '\n', 'utf8');
  } catch (_) { /* 裁剪失败下次再试 */ }
}

module.exports = { appendSample, headOf, resolveSamplesFile, SAMPLES_MAX_LINES, SAMPLE_HEAD_CHARS };
