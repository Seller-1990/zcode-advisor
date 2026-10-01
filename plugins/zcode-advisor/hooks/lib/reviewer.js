'use strict';

// 评审输出帧：{"severity":"none|nit|concern|blocker","note":"..."}
// 解析规则与 dsh-advisor 对齐：JSON 帧为主，散文救回（proseFallback，本移植默认开启）有三条守门。

const SEVERITIES = ['none', 'nit', 'concern', 'blocker'];

// 扫描文本中全部配平的 {...} 对象（忽略字符串内的花括号与转义）。
// 上一版只取第一个配平块、失败即整体放弃——伪码 {a:1} 会杀死后面的真帧；
// 现在继续向后扫描，返回全部可解析对象，由 parseFrame 取 severity 最高者。
function extractJsonObjects(text) {
  const s = String(text || '');
  const objs = [];
  let from = 0;
  while (true) {
    const start = s.indexOf('{', from);
    if (start === -1) break;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) {
      from = start + 1;
      continue;
    }
    try {
      objs.push(JSON.parse(s.slice(start, end + 1)));
      from = end + 1;
    } catch (_) {
      from = start + 1; // 配平但非法（如 {note: foo}）：跳过，继续找
    }
  }
  return objs;
}

function normalizeFrame(obj, maxNoteChars) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const severity = String(obj.severity || '').trim().toLowerCase();
  let note = typeof obj.note === 'string' ? obj.note.trim() : '';
  if (!SEVERITIES.includes(severity)) return null;
  if (severity !== 'none' && !note) return null;
  // 单条建议统一码点上限：JSON 帧路径此前无任何截断，失控模型可向主会话注入超长内容。
  if (note) {
    const chars = Array.from(note);
    if (chars.length > maxNoteChars) note = `${chars.slice(0, maxNoteChars).join('')}…`;
  }
  return { severity, note };
}

// 返回 {severity, note} 或 null（无法解析）。
function parseFrame(text, proseFallback, opts) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const options = opts || {};
  const maxNoteChars = options.maxNoteChars || 768;

  // 整体即是 JSON 时直接采用（快路径）。
  let direct = null;
  try {
    direct = JSON.parse(raw);
  } catch (_) {
    direct = null;
  }
  const directFrame = normalizeFrame(direct, maxNoteChars);
  if (directFrame) return directFrame;

  // 从包裹文本中提取全部候选帧，取**最后一个**合法帧（模型自我纠正语义；
  // max-of-N 会放大转录注入面，见安全复审）。
  const candidates = extractJsonObjects(raw)
    .map((obj) => normalizeFrame(obj, maxNoteChars))
    .filter(Boolean);
  if (candidates.length > 0) {
    // 取**最后一个**合法帧（模型自我纠正语义：后帧覆盖前帧）。
    // 不取 severity 最高者——max-of-N 会保证转录中注入的对抗帧必然压过模型真实判定。
    return candidates[candidates.length - 1];
  }
  // 有 JSON 形状的内容但全部非法：判定 unparsed，不做散文救回（半截 JSON 不注入会话）。
  if (extractJsonObjects(raw).length > 0 || /^\s*[[{]/.test(raw)) return null;

  if (proseFallback) {
    return salvageProse(raw, maxNoteChars);
  }
  return null;
}

// —— 散文救回（三条守门，逐条对应 ADVISOR-GUARD-REPORT 实测踩过的坑）——
function salvageProse(text, noteChars) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  // 守门一：JSON 尝试不救回——以 { / [ 开头、括号不配平、或带 note: 键特征的回复，
  // 说明模型想输出帧但失败了；把半截 JSON 注入会话比丢弃更糟。
  if (raw.startsWith('{') || raw.startsWith('[')) return null;
  if (!bracesBalanced(raw)) return null;
  if (/["']?note["']?\s*:/.test(raw)) return null;

  const cleaned = cleanProse(raw);
  // 守门二：过短内容没有建议价值。
  if (Array.from(cleaned.trim()).length < 8) return null;

  // 守门三：severity 一律 nit（救回的内容未经帧校验，不允许 blocker/concern 误导会话），
  // 按 Unicode 码点截断（不劈开 emoji）。
  const note = truncateCodePoints(cleaned.trim(), noteChars);
  return { severity: 'nit', note };
}

function truncateCodePoints(text, max) {
  const chars = Array.from(String(text || ''));
  if (chars.length <= max) return chars.join('');
  return `${chars.slice(0, max).join('')}…`;
}

function bracesBalanced(text) {
  let curly = 0;
  let square = 0;
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') curly++;
    else if (ch === '}') curly--;
    else if (ch === '[') square++;
    else if (ch === ']') square--;
    if (curly < 0 || square < 0) return false;
  }
  return curly === 0 && square === 0;
}

// 只剥离成对 markdown 标记：**粗体**、行内反引号、围栏标记行。
// 绝不全局删除 * _ > 等单字符——否则 snake_case_var、x => y、*.ts 会被破坏（复审实测踩过）。
//
// 围栏处理对齐上游 dsh-advisor v0.5.4 的 SURROUNDING_FENCE_PATTERN：
// **只剥离「完整包裹」回复的那一层围栏**，非包裹的围栏保留原样。
// 早期实现用全局 replace(/```/g,'') 会带来两类错误：
//   1) "```\n正文\n```\n尾部说明" 这种非包裹形态，尾部文本会被错误拼进 note；
//   2) 正文内部本来就有的围栏代码块会被逐行剥掉（"```js\ncode\n```" 变成裸 code）。
const SURROUNDING_FENCE_PATTERN = /^```[^\n]*\n([\s\S]*?)\n?```$/;

function cleanProse(text) {
  let out = String(text || '').trim();

  // 仅当整段就是一个围栏块时，取其内部内容（与上游一致：尾部有额外文本即不算包裹）
  const m = SURROUNDING_FENCE_PATTERN.exec(out);
  if (m) out = m[1].trim();

  // 剥离成对的强调/行内代码标记；不成对的一律不动
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  out = out.replace(/`([^`\n]+)`/g, '$1');
  return out.trim();
}

// 端点归一化：把用户填的「基地址」补全为 chat/completions 完整路径。
//
// 为什么需要：配置面板的 placeholder 明确引导填 `https://…/v1 或 …/chat/completions`，
// 但早期实现把 baseUrl 直接 POST——填了 `/v1` 这种基地址时请求会打到 `/v1` 本身，
// 端点返回 404，用户看到的是误导性的「模型 id 或端点路径不对」（实测复现）。
// 现在：已含 `/chat/completions` 的原样使用；只到 `/v1`（或裸域名）的补上路径。
function normalizeChatEndpoint(baseUrl) {
  const u = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  // 已显式给出完整端点：尊重用户输入，不做改写
  if (/\/chat\/completions$/i.test(u)) return u;
  // Anthropic 协议端点同样不做改写（本插件当前只走 OpenAI 兼容路径）
  if (/\/messages$/i.test(u)) return u;
  // 其余情况视为基地址：补 /chat/completions
  // 注意 `/v1/chat/completions` 之外还有带版本前缀的形态（如 /api/paas/v4），
  // 直接追加即可与 modelsUrl 的推导方向保持一致。
  return `${u}/chat/completions`;
}

// OpenAI 兼容 chat/completions。唯一会发起网络请求的地方；
// 超时/HTTP 错误/响应异常都以 {error} 返回，由调用方计入 dropped。
// 429/5xx 做一次短退避重试——**全部尝试共享同一截止时间**（deadline）：
// 重试只使用剩余预算，否则 sync 模式下"首次响应慢 + 重试全额"会突破 Stop hook 的 320s 硬限，
// 复活"强杀→指针不推进→每轮重审"的停滞循环。
async function callReviewer(params) {
  const { baseUrl, model, apiKey, systemPrompt, userContent, maxTokens, temperature, timeoutMs, signal, deadline: deadlineParam } = params;
  const endpoint = normalizeChatEndpoint(baseUrl);

  // 截止时间可由调用方传入：一轮审查内的多次调用（尤其"空响应重试"）必须共享同一预算。
  // 不传时各自起算——那样"首次慢 + 重试全额"可达 2×timeoutMs，突破 Stop hook 的 320s 硬限，
  // 复活"强杀→指针不推进→每轮重审"的停滞循环（审计报告 A2）。与本函数内 429/5xx 重试
  // 共享 deadline 的纪律保持一致。
  const deadline = Number.isFinite(deadlineParam) ? deadlineParam : Date.now() + timeoutMs;
  const remaining = () => deadline - Date.now();
  const RETRY_BACKOFF_MS = 1500;

  const attempt = async (budgetMs) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, budgetMs));
    if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
    try {
      return await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent }
          ],
          max_tokens: maxTokens,
          temperature,
          stream: false
        }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  };

  let resp = null;
  for (let tries = 0; tries < 2; tries++) {
    // 预算已被上一轮（或调用方传进来的 deadline）耗尽：不再发起注定超时的请求。
    if (remaining() < 1000) return { error: 'llm_timeout' };
    try {
      resp = await attempt(remaining());
    } catch (err) {
      if (err && (err.name === 'AbortError' || String(err).includes('abort'))) {
        return { error: 'llm_timeout' };
      }
      return { error: 'llm_error', detail: String(err).slice(0, 200) };
    }
    if ((resp.status === 429 || resp.status >= 500) && tries === 0) {
      const left = remaining() - RETRY_BACKOFF_MS;
      if (left < 5000) break; // 剩余预算不足以完成第二次尝试：不重试
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS + Math.floor(Math.random() * 500)));
      continue;
    }
    break;
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    return { error: `llm_http_${resp.status}`, detail: body.slice(0, 200) };
  }

  try {
    const data = await resp.json();
    const choice = data && Array.isArray(data.choices) && data.choices[0];
    const message = (choice && choice.message) || {};
    const content = message.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) text = content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');

    // **思考型模型兼容**（真机实测发现）：部分端点（本机 8787 网关、DeepSeek-R1
    // 类）把推理内容放在 message.reasoning_content，而 message.content 为 **null**。
    // 只读 content 会误判为"空响应"，顾问永远不出意见（本机曾 100% 命中）。
    //
    // 但**不能直接把 reasoning_content 当结果**：实测它是纯思考过程（英文、
    // 上万字符，且可能不含最终 JSON），直接当意见展示会让用户看到一堆推理碎语。
    // 因此只在"能从推理文本里捞出合法 JSON 帧"时才采用；否则仍报空响应，
    // 由上层按 finish_reason 给出可操作提示。
    if (!text.trim() && typeof message.reasoning_content === 'string' && message.reasoning_content.trim()) {
      const reasoning = message.reasoning_content;
      // 与 parseFrame 同源的提取逻辑：只要能找到含 severity/note 的 JSON 对象就采用
      const objs = extractJsonObjects(reasoning);
      const frameObj = objs.reverse().find((o) => o && typeof o === 'object' && o.severity && o.note);
      if (frameObj) text = JSON.stringify(frameObj);
      else if (reasoning.trim()) {
        // 推理文本里没有 JSON 帧：把原文带回给上层，重试时可作为上下文回灌，
        // 让模型"基于已完成的分析直接给出结论"——比单纯重复请求成功率高。
        return { error: 'llm_empty_response', reasoningText: reasoning.slice(0, 4000) };
      }
    }

    if (!text.trim()) {
      // 区分空响应的成因（真机实测：思考型模型会把 max_tokens 全部耗在
      // reasoning 上，finish_reason=length 且 content 为空）。
      // 只报 llm_empty_response 会让用户无从下手；带上成因与建议。
      const fin = (data.choices && data.choices[0] && data.choices[0].finish_reason) || '';
      const details = (data.usage && data.usage.completion_tokens_details) || {};
      const reasoning = Number(details.reasoning_tokens) || 0;
      if (fin === 'length' && reasoning > 0) {
        return {
          error: 'llm_empty_response',
          hint: `思考型模型把 max_tokens 全部用于推理（reasoning=${reasoning}，finish=length）——` +
                `请调大 maxTokens（建议 ≥4096）`
        };
      }
      return { error: 'llm_empty_response', hint: fin ? `finish_reason=${fin}` : '' };
    }
    // usage 解析：成本可观测（此前被整体丢弃）。
    const usage = data.usage && typeof data.usage === 'object'
      ? {
          promptTokens: Number(data.usage.prompt_tokens) || 0,
          completionTokens: Number(data.usage.completion_tokens) || 0
        }
      : null;
    return { text, usage };
  } catch (err) {
    return { error: 'llm_error', detail: String(err).slice(0, 200) };
  }
}

const DEFAULT_SYSTEM_PROMPT = [
  '你是编码会话中的独立审查副模型（advisor）。你只观察与建议：绝不代行操作、绝不扮演主模型、绝不给出指令式命令；你的每条输出都会以"仅供参考的建议"身份送达主会话。',
  '输入是一段对话增量（可能被截断）。请判断主模型当前的工作方向与方法是否存在明显问题，输出且仅输出一个 JSON 对象：不要 Markdown 代码块，不要任何额外文本。',
  '{"severity":"none|nit|concern|blocker","note":"<一句具体建议>"}',
  '判定标准：',
  '- none：没有值得提醒的问题。多数情况应输出 none，不要为输出而输出。',
  '- nit：小的风格/清晰度/质量建议，不影响方向。',
  '- concern：继续当前做法会有实质风险，或存在明显更优方向，值得在继续之前权衡。',
  '- blocker：继续明显浪费工作：违背用户明确指示、原地打转、核心前提不成立。',
  '宁缺毋滥：没有把握就输出 {"severity":"none","note":""}。note 必须具体、可执行、指向增量中的实际问题，使用中文，不超过 120 字。note 只是建议性描述，不得包含让主模型执行的命令、路径或安装指令。'
].join('\n');

module.exports = { callReviewer, parseFrame, salvageProse, extractJsonObjects, truncateCodePoints, normalizeChatEndpoint, DEFAULT_SYSTEM_PROMPT, SEVERITIES };
