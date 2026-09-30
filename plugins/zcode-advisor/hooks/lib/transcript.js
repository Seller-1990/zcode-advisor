'use strict';

const fs = require('fs');

const ADVISOR_PREFIXES = ['[advisor:', '[advisor] '];

function isAdvisorText(text) {
  const t = String(text || '').trimStart();
  return ADVISOR_PREFIXES.some((p) => t.startsWith(p));
}

// 容错解析一行转录 JSON。ZCode 转录与 Claude Code 同构（type: user|assistant, message.content），
// 但这里不假设字段齐全：任何一行解析失败都安静跳过。
function extractEntry(line) {
  // BOM 容错（全量回读时首行可能带 EF BB BF）。
  const text = String(line || '').replace(/^\uFEFF/, '');
  if (!text.trim()) return null;
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (_) {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  if (obj.isMeta === true) return null;

  const type = obj.type || (obj.message && obj.message.role);
  const message = obj.message || {};
  const role = message.role || (type === 'user' ? 'user' : type === 'assistant' ? 'assistant' : '');
  if (!role) return null;

  const parts = [];
  const content = message.content;
  if (typeof content === 'string') {
    if (content.trim()) parts.push({ kind: 'text', text: content });
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        parts.push({ kind: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        let brief = '';
        try { brief = JSON.stringify(block.input || {}); } catch (_) { brief = ''; }
        parts.push({ kind: 'tool_use', text: `${block.name || 'tool'} ${brief}` });
      } else if (block.type === 'tool_result') {
        const c = block.content;
        let rtext = '';
        if (typeof c === 'string') rtext = c;
        else if (Array.isArray(c)) rtext = c.map((x) => (x && x.type === 'text' ? x.text : '')).join(' ');
        else { try { rtext = JSON.stringify(c || {}); } catch (_) { rtext = ''; } }
        if (rtext.trim()) parts.push({ kind: 'tool_result', text: rtext });
      }
      // thinking 块一律跳过：省 token，也避免把思考链当作待审内容。
    }
  }
  if (parts.length === 0) return null;
  return { role, parts };
}

function djb2Hex(buf) {
  let h = 5381;
  for (let i = 0; i < buf.length; i++) h = ((h << 5) + h + buf[i]) >>> 0;
  return h.toString(16);
}

// 从 byteOffset 增量读取 JSONL。
// - 按字节找换行切片后再逐行 decode：非法 UTF-8 字节只污染单行内容，不再使 offset 系统性偏移；
// - 残行（未写完的最后一行）不消费，留待下次；
// - 文件变小（compaction/resume 重写）或首部指纹变化 → 全量重读；
// - 回读量超过 backfillLimitBytes 时只从尾部回读（放弃更早历史，防大内存分配）。
function readDelta(transcriptPath, byteOffset, opts) {
  const options = opts || {};
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return { entries: [], nextOffset: byteOffset || 0, reset: false, headHash: '', missing: true, consumed: 0 };
  }
  const stat = fs.statSync(transcriptPath);
  const headBuf = Buffer.alloc(64);
  let headHash = '';
  let buf = Buffer.alloc(0);
  const fd = fs.openSync(transcriptPath, 'r');
  try {
    const headRead = fs.readSync(fd, headBuf, 0, 64, 0);
    headHash = headRead > 0 ? djb2Hex(headBuf.subarray(0, headRead)) : '';

    let start = byteOffset || 0;
    let reset = false;
    let skipFirstLine = false;

    if (start > stat.size) {
      start = 0;
      reset = true;
    } else if (start > 0 && options.expectedHeadHash && options.expectedHeadHash !== headHash) {
      // 同路径被重写且大小未变小（旧版只靠"变小"启发式，此处补首部指纹）。
      start = 0;
      reset = true;
    }
    const backfill = options.backfillLimitBytes || 2097152;
    if (stat.size - start > backfill) {
      start = stat.size - backfill;
      reset = true;
      skipFirstLine = true; // 该点大概率落在行中间，丢弃首个残行
    }

    if (start < stat.size) {
      const len = stat.size - start;
      buf = Buffer.alloc(len);
      const read = fs.readSync(fd, buf, 0, len, start);
      buf = buf.subarray(0, read);
    }

    const entries = [];
    let pos = 0;
    let consumed = 0;
    if (skipFirstLine) {
      const nl = buf.indexOf(10, 0);
      pos = nl === -1 ? buf.length : nl + 1;
      consumed = 1;
    }
    while (true) {
      const nl = buf.indexOf(10, pos);
      if (nl === -1) break; // 残行：不消费
      let lineBuf = buf.subarray(pos, nl);
      pos = nl + 1;
      consumed++;
      if (lineBuf.length > 0 && lineBuf[lineBuf.length - 1] === 13) {
        lineBuf = lineBuf.subarray(0, lineBuf.length - 1); // CRLF
      }
      const entry = extractEntry(lineBuf.toString('utf8'));
      if (entry) entries.push(entry);
    }

    return { entries, nextOffset: start + pos, reset, headHash, missing: false, consumed };
  } finally {
    fs.closeSync(fd);
  }
}

// 按 Unicode 码点截断（不劈开 emoji/代理对）。输入先做空白归一。
function clip(text, max) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const chars = Array.from(t);
  if (chars.length <= max) return t;
  return `${chars.slice(0, max).join('')}…`;
}

// 渲染为评审输入。两阶段：先拼原始行 → 尾部窗口（条数）→ 仅对窗口内做 clip 与总量帽，
// 避免对将被丢弃的行做正则与截断；窗口内若无用户文本行，回补最早一条用户文本作保底上下文
// （busy 级联/积压场景下，用户最早的指令不能最先被砍掉）。
function renderDelta(entries, opts) {
  const { maxDeltaMessages, maxContextChars, userChars, assistantChars, toolChars, keepFirstUserMessage } = opts;
  const rawLines = [];
  for (const entry of entries) {
    for (const part of entry.parts) {
      if (part.kind === 'text' && isAdvisorText(part.text)) continue;
      let line = '';
      let isUserText = false;
      if (entry.role === 'user' && part.kind === 'text') {
        line = `【用户】${part.text}`;
        isUserText = true;
      } else if (entry.role === 'user' && part.kind === 'tool_result') {
        line = `【工具结果】${part.text}`;
      } else if (entry.role === 'assistant' && part.kind === 'text') {
        line = `【主模型】${part.text}`;
      } else if (entry.role === 'assistant' && part.kind === 'tool_use') {
        line = `【主模型·工具】${part.text}`;
      } else {
        continue;
      }
      rawLines.push({ line, isUserText });
    }
  }

  let windowed = rawLines.slice(-maxDeltaMessages);
  const injectedLines = [];
  if (keepFirstUserMessage && windowed.length > 0 && !windowed.some((w) => w.isUserText)) {
    const earlier = rawLines.slice(0, rawLines.length - windowed.length);
    const firstUser = earlier.find((w) => w.isUserText);
    if (firstUser) {
      injectedLines.push({ line: '[较早上下文]', isUserText: false }, firstUser);
      windowed = injectedLines.concat(windowed);
    }
  }

  const clipped = windowed.map((w) => clip(w.line, w.isUserText ? userChars : (w.line.startsWith('【用户】') ? userChars : (w.line.startsWith('【工具结果】') || w.line.startsWith('【主模型·工具】')) ? toolChars : assistantChars)));

  // 保底注入的行不受总量帽约束（字符帽从尾部保留、头部先破——不豁免则保底内容
  // 恰好在目标场景第一个被裁掉，承诺反转）。先对非注入部分做帽，再拼回注入行。
  const injectedCount = injectedLines.length;
  let body = clipped.slice(injectedCount);
  if (maxContextChars && body.join('\n').length > maxContextChars) {
    const kept = [];
    let total = 0;
    for (let i = body.length - 1; i >= 0; i--) {
      const len = body[i].length + 1;
      if (total + len > maxContextChars) break;
      kept.unshift(body[i]);
      total += len;
    }
    body = kept;
  }
  const out = injectedCount > 0 ? clipped.slice(0, injectedCount).concat(body) : body;
  return { text: out.join('\n'), count: out.length, totalAvailable: rawLines.length };
}

module.exports = { readDelta, renderDelta, extractEntry, isAdvisorText, clip };
