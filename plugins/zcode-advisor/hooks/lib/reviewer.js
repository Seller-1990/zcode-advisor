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

// 返回 {frame, truncated} 或 null。truncated = note 因超上限被截断（失控信号，
// 探针据「截断即失控」判失败，见 M3 判据 5）。
function normalizeFrame(obj, maxNoteChars) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const severity = String(obj.severity || '').trim().toLowerCase();
  let note = typeof obj.note === 'string' ? obj.note.trim() : '';
  if (!SEVERITIES.includes(severity)) return null;
  if (severity !== 'none' && !note) return null;
  // 单条建议统一码点上限：JSON 帧路径此前无任何截断，失控模型可向主会话注入超长内容。
  let truncated = false;
  if (note) {
    const chars = Array.from(note);
    if (chars.length > maxNoteChars) { note = `${chars.slice(0, maxNoteChars).join('')}…`; truncated = true; }
  }
  return { frame: { severity, note }, truncated };
}

// 返回 {severity, note} 或 null（无法解析）。行为与历史版本逐字一致——
// 内部委托 parseFrameDetailed，后者额外暴露「帧来源」（供 M3 探针区分
// 真帧与散文救回）。
function parseFrame(text, proseFallback, opts) {
  return parseFrameDetailed(text, proseFallback, opts).frame;
}

// 带来源信息的解析（M3 探针用）。
// 返回 {frame, from, truncated}：frame=null 表示无法解析；
// from ∈ 'json-direct' | 'json-embedded' | 'prose' | null。
// **为什么探针必须看 from**：散文救回（salvageProse）一律产出 severity=nit，
// 即「救回 = 永远不可能产出 concern/blocker」——这在生产里是**隐性降级**，
// 只看 parseFrame 非空会把「模型只会说散文」误判为模型可用。
function parseFrameDetailed(text, proseFallback, opts) {
  const raw = String(text || '').trim();
  if (!raw) return { frame: null, from: null, truncated: false };
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
  if (directFrame) return { frame: directFrame.frame, from: 'json-direct', truncated: directFrame.truncated };

  // 从包裹文本中提取全部候选帧，取**最后一个**合法帧（模型自我纠正语义；
  // max-of-N 会放大转录注入面，见安全复审）。
  const candidates = extractJsonObjects(raw)
    .map((obj) => normalizeFrame(obj, maxNoteChars))
    .filter(Boolean);
  if (candidates.length > 0) {
    // 取**最后一个**合法帧（模型自我纠正语义：后帧覆盖前帧）。
    // 不取 severity 最高者——max-of-N 会保证转录中注入的对抗帧必然压过模型真实判定。
    const last = candidates[candidates.length - 1];
    return { frame: last.frame, from: 'json-embedded', truncated: last.truncated };
  }
  // 有 JSON 形状的内容但全部非法：判定 unparsed，不做散文救回（半截 JSON 不注入会话）。
  if (extractJsonObjects(raw).length > 0 || /^\s*[[{]/.test(raw)) return { frame: null, from: null, truncated: false };

  if (proseFallback) {
    const f = salvageProse(raw, maxNoteChars);
    return { frame: f, from: f ? 'prose' : null, truncated: false };
  }
  return { frame: null, from: null, truncated: false };
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

  // abort 计时器必须活到 body 消费完成：fetch 在响应头到达即 resolve，若此刻就 clearTimeout，
  // 慢滴流的 body 读取不受 deadline 约束 → 单轮突破预算 → worker 锁被判陈旧 → 同会话双开
  // （A2 同族停滞）。body 消费统一经 consumeBody：超时中止归类 llm_timeout，用完即拆定时器。
  let bodyGuard = null;
  const armGuard = (budgetMs) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, budgetMs));
    if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
    bodyGuard = { timer, controller };
  };
  const disarmGuard = () => {
    if (bodyGuard) { clearTimeout(bodyGuard.timer); bodyGuard = null; }
  };
  const consumeBody = async (promise) => {
    try {
      return { ok: true, value: await promise };
    } catch (err) {
      if (err && (err.name === 'AbortError' || String(err).includes('abort'))) return { ok: false };
      throw err;
    } finally {
      disarmGuard();
    }
  };

  const attempt = async (budgetMs) => {
    armGuard(budgetMs);
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
        signal: bodyGuard.controller.signal
      });
    } catch (err) {
      disarmGuard(); // 请求层失败立即清理；成功路径的定时器延后到 body 消费完
      throw err;
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
      disarmGuard(); // 该响应被丢弃：不消费 body，拆掉守卫定时器
      const left = remaining() - RETRY_BACKOFF_MS;
      if (left < 5000) break; // 剩余预算不足以完成第二次尝试：不重试
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS + Math.floor(Math.random() * 500)));
      continue;
    }
    break;
  }

  if (!resp.ok) {
    const r = await consumeBody(resp.text().catch(() => ''));
    if (!r.ok) return { error: 'llm_timeout' }; // body 读取撞上 deadline
    return { error: `llm_http_${resp.status}`, detail: String(r.value).slice(0, 200) };
  }

  try {
    const parsed = await consumeBody(resp.json());
    if (!parsed.ok) return { error: 'llm_timeout' };
    const data = parsed.value;
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
      // 上游端点完全控制 finish_reason 内容：截断到 40 字符，防被劫持端点借 hint 向日志无界注入。
      const fin = String((data.choices && data.choices[0] && data.choices[0].finish_reason) || '').slice(0, 40);
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

// —— 能力探针（M3）——
// 目的：让用户知道「某模型能否**按时按标准**返回建议」。**不做持久「可用」标记**——
// 可用性是概率属性（n=5 全过时失败率上界仍约 45%），持久化布尔判决 = 虚假确定性。
// 输出的是**分布与通过率**，不是「可用/不可用」判决。
//
// 探针用**生产参数**（真实 cfg.maxTokens + DEFAULT_SYSTEM_PROMPT + 代表性 delta），
// 不用 max_tokens=1 的 ping——那正是本次故障的误报源：思考型模型会把它全部烧在
// reasoning 上（content 为空、finish_reason=length），而旧 ping 把 llm_empty_response
// 当正常，于是对「烧预算故障」误报 OK。

// probeModel 级默认（cfg 未提供时回退；与 config.js 的 DEFAULTS 同值）。
const PROBE_DEFAULTS = {
  maxTokens: 4096,
  temperature: 0.2,
  reviewTimeoutMs: 240000,
  maxNoteChars: 768,
  proseFallback: true,
  // 整批上限：无论 n 与单次 timeout 多大，探针最坏耗时封顶 10 分钟（防 --n 50 --timeout 240000 = 3.3h）。
  maxBatchTimeoutMs: 600000
};

// 代表性 delta：模拟真实增量形态（含代码块与回答正文），而非 'ping'——
// 短输入下模型几乎不会被推理烧预算，测不出真实故障模式。
const PROBE_DELTA = [
  '以下是一轮对话增量（按时间顺序，可能被截断）。请按系统指令输出 JSON 判定。',
  '',
  '【user】帮我把 parseConfig 里的重复分支合并一下。',
  '【assistant】我改了三处：',
  '1. 把 if (a) {…} else if (b) {…} 合并为一个查表分支；',
  '2. 抽出了 normalizeKey()；',
  '3. 补了单元测试。'
].join('\n');

// 判据（全有代码依据，任一不满足即该次失败并给出分类）：
//   1. 有产出文本（空响应 = 烧预算故障本身）
//   2. 能解析出帧
//   3. severity 合法（parseFrame 已保证，此处防御）
//   4. severity≠none 时 note 非空（parseFrame 已保证）
//   5. note 未被截断（截断 = 模型失控信号）
//   6. 帧来自 JSON 而非散文救回（salvageProse 一律 nit → 永远产不出 concern/blocker，
//      是隐性降级；只看 parseFrame 非空会把「只会说散文」误判为可用）
// 返回 { ok, reason, severity }，reason 为失败分类（成功时 ''），severity 为解析出的严重级
// （成功时才有意义；用于统计分布，暴露"只会回 none"的退化模型——见 probeModel）。
function classifyProbeResult(res, cfg) {
  if (!res || res.error) {
    return { ok: false, reason: (res && res.error) || 'no_result', severity: '' };
  }
  const det = parseFrameDetailed(res.text, cfg.proseFallback !== false, { maxNoteChars: cfg.maxNoteChars });
  if (!det.frame) return { ok: false, reason: 'unparsed', severity: '' };
  if (!SEVERITIES.includes(det.frame.severity)) return { ok: false, reason: 'bad_severity', severity: '' };
  if (det.frame.severity !== 'none' && !String(det.frame.note || '').trim()) return { ok: false, reason: 'empty_note', severity: det.frame.severity };
  if (det.truncated) return { ok: false, reason: 'note_truncated', severity: det.frame.severity };
  if (det.from === 'prose') return { ok: false, reason: 'prose_only', severity: det.frame.severity };
  return { ok: true, reason: '', severity: det.frame.severity };
}

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

// 单次探针调用：跑首调 + 最多 2 次空响应重试（与 reviewTurn 的 runAttempt 同一策略）。
// 必须复刻重试：思考型模型首调 content 为空、带 reasoning 回灌的第 2 调常能救回，
// 探针若不做重试会把这类模型误判为不可用（与旧 ping 误报方向相反的另一种失真）。
async function probeOnce(call, params, deadline) {
  let res = await call(Object.assign({}, params, { deadline }));
  for (let i = 0; i < 2 && res && res.error === 'llm_empty_response'; i++) {
    if (deadline - Date.now() < 10000) break; // 剩余不足一次重试：放弃
    const carry = res.reasoningText
      ? `\n\n【你上一步的分析（供参考，不要重复）】\n${res.reasoningText.slice(0, 3000)}\n\n请基于以上分析，只输出一个 JSON 对象，格式：{"severity":"none|nit|concern|blocker","note":"一句具体建议"}。不要输出任何其他文字。`
      : '\n\n（请直接输出一个 JSON 对象，不要输出推理过程或其他文本。）';
    res = await call(Object.assign({}, params, { deadline, temperature: 0, userContent: `${params.userContent}${carry}` }));
  }
  return res;
}

// 跑 N 次探针，返回统计分布。**绝不返回「可用/不可用」判决**。
// deps.callReviewer 可注入（测试 stub fetch；生产用真实 callReviewer）。
// 整批有预算上限（batchTimeoutMs）：n 次串行 × 单次 timeout 可能到几小时，必须能提前收尾。
async function probeModel(target, opts, deps) {
  const o = opts || {};
  const call = (deps && deps.callReviewer) || callReviewer;
  const cfg = {
    maxTokens: Number.isFinite(o.maxTokens) ? o.maxTokens : PROBE_DEFAULTS.maxTokens,
    temperature: Number.isFinite(o.temperature) ? o.temperature : PROBE_DEFAULTS.temperature,
    maxNoteChars: Number.isFinite(o.maxNoteChars) ? o.maxNoteChars : PROBE_DEFAULTS.maxNoteChars,
    proseFallback: o.proseFallback !== false
  };
  const n = Number.isFinite(o.n) && o.n > 0 ? Math.floor(o.n) : 5;
  const timeoutMs = Number.isFinite(o.timeoutMs) ? o.timeoutMs : PROBE_DEFAULTS.reviewTimeoutMs;
  // 整批预算：默认 min(n×timeout, 10min)；调用方可覆盖（也有上界）。
  const batchCap = Number.isFinite(o.batchTimeoutMs) && o.batchTimeoutMs > 0
    ? Math.min(o.batchTimeoutMs, PROBE_DEFAULTS.maxBatchTimeoutMs)
    : Math.min(n * timeoutMs, PROBE_DEFAULTS.maxBatchTimeoutMs);
  const batchDeadline = Date.now() + batchCap;
  const systemPrompt = (o.systemPrompt && String(o.systemPrompt).trim()) || DEFAULT_SYSTEM_PROMPT;
  const userContent = o.delta || PROBE_DELTA;

  const results = [];
  let aborted = false;
  for (let i = 0; i < n; i++) {
    // 每次调用用 min(单次 timeout, 整批剩余)：避免最后一次拖爆整批预算。
    const left = batchDeadline - Date.now();
    if (left < 1000) { aborted = true; break; }
    const perCallTimeout = Math.min(timeoutMs, left);
    // 单次调用预算 = perCallTimeout，deadline 供 callReviewer 内部裁剪。
    const deadline = Date.now() + perCallTimeout;
    const t0 = Date.now();
    let res;
    try {
      res = await probeOnce(call, {
        baseUrl: target.baseUrl,
        model: target.model,
        apiKey: target.apiKey,
        systemPrompt,
        userContent,
        maxTokens: cfg.maxTokens,
        temperature: cfg.temperature,
        timeoutMs: perCallTimeout
      }, deadline);
    } catch (err) {
      res = { error: 'llm_error', detail: String(err).slice(0, 200) };
    }
    const ms = Date.now() - t0;
    const c = classifyProbeResult(res, cfg);
    results.push({ ok: c.ok, reason: c.reason, ms, severity: c.severity });
  }

  const passed = results.filter((r) => r.ok).length;
  const ran = results.length;
  const sorted = results.map((r) => r.ms).sort((a, b) => a - b);
  const failures = {};
  // 严重级分布：暴露「只会回 none」的退化模型——它能让判据全过（none 合法），
  // 但在生产里制造的是静默。只看通过率会把这种退化误认证为合格。
  const severities = {};
  for (const r of results) {
    if (r.severity) severities[r.severity] = (severities[r.severity] || 0) + 1;
  }
  for (const r of results) {
    if (!r.ok) failures[r.reason] = (failures[r.reason] || 0) + 1;
  }
  return {
    model: target.model,
    n,
    ran,
    aborted,
    batchMs: batchCap,
    passed,
    failed: n - passed,
    passRate: n > 0 ? passed / n : 0,
    ms: { min: sorted[0] || 0, median: percentile(sorted, 50), p90: percentile(sorted, 90), max: sorted[sorted.length - 1] || 0 },
    failures,
    severities
  };
}

// 供 CLI 展示：把统计渲染成人类可读多行（含 N 的诚实说明）。
// **不输出「可用」**——只输出通过率与分布，避免虚假确定性。
function renderProbeReport(stat, opts) {
  const o = opts || {};
  const lines = [];
  const ranNote = stat.aborted && stat.ran < stat.n ? `（预算内只跑了 ${stat.ran}/${stat.n}，整批上限 ${Math.round(stat.batchMs / 1000)}s）` : '';
  lines.push(`  探针: ${stat.model} —— ${stat.passed}/${stat.n} 次通过（失败 ${stat.failed}）${ranNote}`);
  lines.push(`  耗时: min=${stat.ms.min}ms median=${stat.ms.median}ms p90=${stat.ms.p90}ms max=${stat.ms.max}ms`);
  const reasons = Object.keys(stat.failures);
  if (reasons.length > 0) {
    lines.push(`  失败分类: ${reasons.map((k) => `${k}×${stat.failures[k]}`).join(', ')}`);
  }
  // 严重级分布：暴露「只会回 none」的退化——它能让判据全过（none 合法）却在生产中制造静默。
  const sev = stat.severities || {};
  const sevKeys = Object.keys(sev);
  if (sevKeys.length > 0) {
    const total = sevKeys.reduce((a, k) => a + sev[k], 0);
    const order = ['blocker', 'concern', 'nit', 'none'];
    const parts = order.filter((k) => sev[k]).map((k) => `${k}×${sev[k]}`);
    lines.push(`  严重级分布: ${parts.join(', ')}`);
    if (sev.none === total && total >= 3) {
      lines.push('  ⚠ 全部返回 none：模型可能只是"从不产出意见"。none 是合法帧、判据会全过，'
        + '但这类模型在生产里制造的是静默——请用更多轮/更贴真实的 delta 复核，勿仅凭通过率换掉现有模型。');
    }
  }
  // N 的诚实说明：按**实际 N** 算「全过时失败率的 95% 上界」= 1 - 0.05^(1/N)。
  // 写死 N=5 会在用户指定其它 N 时误导，故动态计算。
  const bound = stat.n > 0 ? Math.round((1 - Math.pow(0.05, 1 / stat.n)) * 100) : 100;
  lines.push(`  说明: 以上是样本分布，不是「可用/不可用」判决。`
    + `N=${stat.n} 全过时，真实失败率仍有约 ${bound}% 的 95% 置信上界`
    + `${stat.n < 14 ? `——要压到 20% 以下需 N≥14` : ''}。模型会漂移，结论有时效。`);
  if (o.hint) lines.push(`  提示: ${o.hint}`);
  return lines.join('\n');
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

module.exports = { callReviewer, parseFrame, parseFrameDetailed, salvageProse, extractJsonObjects, truncateCodePoints, normalizeChatEndpoint, DEFAULT_SYSTEM_PROMPT, SEVERITIES, probeModel, classifyProbeResult, renderProbeReport, PROBE_DELTA, PROBE_DEFAULTS };
