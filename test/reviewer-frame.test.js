'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseFrame, salvageProse, extractJsonObjects, truncateCodePoints, normalizeChatEndpoint } = require('../hooks/lib/reviewer');

test('直接 JSON 帧', () => {
  assert.deepStrictEqual(parseFrame('{"severity":"nit","note":"a"}', false), { severity: 'nit', note: 'a' });
  assert.deepStrictEqual(parseFrame('{"severity":"none","note":""}', false), { severity: 'none', note: '' });
});

test('包裹在 prose/代码块中的 JSON 帧', () => {
  const text = '好的，我的判定如下：\n```json\n{"severity":"concern","note":"存在重复实现"}\n```\n以上。';
  assert.deepStrictEqual(parseFrame(text, false), { severity: 'concern', note: '存在重复实现' });
});

test('severity 带空白时归一（trim）', () => {
  assert.deepStrictEqual(parseFrame('{"severity":" blocker ","note":"x"}', false), { severity: 'blocker', note: 'x' });
});

test('非法 severity / 缺 note 拒绝', () => {
  assert.strictEqual(parseFrame('{"severity":"huge","note":"x"}', false), null);
  assert.strictEqual(parseFrame('{"severity":"nit"}', false), null);
  assert.strictEqual(parseFrame('', false), null);
});

test('多帧：取最后一个合法帧（模型自我纠正语义，非 max-of-N）', () => {
  // none 在前、blocker 在后 → 后帧覆盖前帧
  const t1 = '{"severity":"none","note":""}\n{"severity":"blocker","note":"立即停手"}';
  assert.deepStrictEqual(parseFrame(t1, false), { severity: 'blocker', note: '立即停手' });
  // blocker 在前、none 在后（模型自我纠正）→ 以后帧为准，不取最高 severity
  const t2 = '{"severity":"blocker","note":"先停"}\n{"severity":"none","note":""}';
  assert.deepStrictEqual(parseFrame(t2, false), { severity: 'none', note: '' });
});

test('伪码对象在前不杀死后面的真帧（继续扫描）', () => {
  const text = '用 {a:1} 这类伪码示意。{"severity":"concern","note":"真问题"}';
  assert.deepStrictEqual(parseFrame(text, false), { severity: 'concern', note: '真问题' });
});

test('JSON 帧的 note 也有码点上限（防超长注入）', () => {
  const longNote = 'x'.repeat(2000);
  const r = parseFrame(`{"severity":"nit","note":"${longNote}"}`, false, { maxNoteChars: 100 });
  assert.strictEqual(Array.from(r.note).length, 101); // 100 + 省略号
});

test('prose 回退仅在显式开启时生效', () => {
  assert.strictEqual(parseFrame('这条回复没有引用任何 JSON 帧。', false), null);
  assert.deepStrictEqual(parseFrame('这条回复没有引用任何 JSON 帧。', true), { severity: 'nit', note: '这条回复没有引用任何 JSON 帧。' });
});

test('extractJsonObjects：字符串内花括号、配平但非法的块跳过', () => {
  const objs = extractJsonObjects('前缀 {"severity":"blocker","note":"注意 {} 转义"} 后缀 {note: foo}');
  assert.strictEqual(objs.length, 1);
  assert.strictEqual(objs[0].severity, 'blocker');
  assert.deepStrictEqual(extractJsonObjects('没有对象'), []);
  assert.deepStrictEqual(extractJsonObjects('{"截断的'), []);
});

// —— 散文救回守门（源自 ADVISOR-GUARD-REPORT 的实战教训）——

test('散文救回：普通 prose 清洗后作为 nit', () => {
  const r = parseFrame('我注意到循环里每次都重新编译正则，建议提到循环外。', true, { maxNoteChars: 768 });
  assert.strictEqual(r.severity, 'nit');
  assert.ok(r.note.includes('循环外'));
});

test('散文救回守门一：JSON 尝试不救回（悬空/半截/带 note 键）', () => {
  assert.strictEqual(salvageProse('{"severity":"nit","note":', 768), null);       // 以 { 开头
  assert.strictEqual(salvageProse('[{"a":1', 768), null);                          // 以 [ 开头
  assert.strictEqual(salvageProse('这段 { 括号不配平的文本', 768), null);           // 花括号不配平
  assert.strictEqual(salvageProse('回复里带 note: 字样', 768), null);               // note 键特征
});

test('散文救回守门二：清洗只剥成对标记，代码内容保留', () => {
  const r = salvageProse('建议把 **snake_case_var** 与 `x => y` 的处理抽成 util，见 *.ts。', 768);
  assert.ok(r.note.includes('snake_case_var'));
  assert.ok(r.note.includes('x => y'));
  assert.ok(r.note.includes('*.ts'));
  assert.ok(!r.note.includes('**'));
});

test('散文救回守门三：过短丢弃、码点安全截断', () => {
  assert.strictEqual(salvageProse('太短', 768), null);
  // emoji 放在截断点之内：码点截断不允许把它劈成乱码
  const long = '好'.repeat(766) + '🎉🎉🎉';
  const r = salvageProse(long, 768);
  const chars = Array.from(r.note);
  assert.ok(chars.length <= 769); // 768 + 省略号
  assert.strictEqual(r.note.endsWith('…'), true);
  assert.ok(r.note.includes('🎉')); // emoji 未被劈开
});

test('truncateCodePoints 基础行为', () => {
  assert.strictEqual(truncateCodePoints('abcdef', 3), 'abc…');
  assert.strictEqual(truncateCodePoints('abc', 5), 'abc');
});

// ---------------- 围栏剥离：对齐上游 v0.5.4 语义 ----------------
// 上游 dsh-advisor v0.5.4 用 SURROUNDING_FENCE_PATTERN **只剥离完整包裹的围栏**。
// 早期实现用全局 replace(/```/g,'') 会把非包裹形态的尾部文本错误拼进 note，
// 也会把正文内部的代码块围栏逐行剥掉。

test('围栏剥离：完整包裹时剥掉外层围栏，救回正文', () => {
  const F = '```';
  const input = `${F}\n这条建议足够长可以救回，且应剥离外层围栏\n${F}`;
  const r = parseFrame(input, true, { maxNoteChars: 768 });
  assert.ok(r, '完整包裹的散文应被救回');
  assert.strictEqual(r.note, '这条建议足够长可以救回，且应剥离外层围栏');
  assert.strictEqual(r.severity, 'nit', '救回的 severity 一律 nit');
});

test('围栏剥离：非包裹（尾部有额外文本）保留原样，不得错拼', () => {
  const F = '```';
  const input = `${F}\n建议内容够长了\n${F}\n尾部说明文字`;
  const r = parseFrame(input, true, { maxNoteChars: 768 });
  // 关键：尾部文本不得被"并入"正文而丢掉围栏结构——
  // 保留原样说明未做剥离（与上游一致：非包裹的 fence 保持 as-is）
  assert.ok(r, '非包裹内容仍应救回（守门未拦截）');
  assert.strictEqual(r.note, input.trim(), '应保留原样，不拼接不撕裂');
});

test('围栏剥离：正文内部代码块的围栏不得被逐行剥掉', () => {
  const F = '```';
  const input = `这条回复包含一个代码块说明，长度足够救回\n${F}js\nconst a = 1;\n${F}`;
  const r = parseFrame(input, true, { maxNoteChars: 768 });
  assert.ok(r, '应救回');
  assert.ok(r.note.includes('```js'), '内部代码块围栏应保留（非包裹不能拆）');
  assert.ok(r.note.includes('const a = 1;'), '代码内容应保留');
});

// ---------------- 端点归一化（修复 Ping 404） ----------------
// 回归：配置面板引导用户填 `https://…/v1` 这类基地址，但早期实现直接 POST baseUrl，
// 请求打到 `/v1` 本身 → 端点返回 404 → 用户看到误导性的「模型 id 或端点路径不对」。

test('normalizeChatEndpoint：基地址补全为 chat/completions（修复 Ping 404）', () => {
  assert.strictEqual(
    normalizeChatEndpoint('http://192.168.50.139:8788/v1'),
    'http://192.168.50.139:8788/v1/chat/completions'
  );
  assert.strictEqual(
    normalizeChatEndpoint('https://open.bigmodel.cn/api/paas/v4'),
    'https://open.bigmodel.cn/api/paas/v4/chat/completions'
  );
});

test('normalizeChatEndpoint：已含完整路径时原样返回（不重复追加）', () => {
  const full = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
  assert.strictEqual(normalizeChatEndpoint(full), full);
  // 尾斜杠也应被规范化，不产生双斜杠
  assert.strictEqual(normalizeChatEndpoint('https://x.com/v1/'), 'https://x.com/v1/chat/completions');
});

test('normalizeChatEndpoint：空值与空串安全', () => {
  assert.strictEqual(normalizeChatEndpoint(''), '');
  assert.strictEqual(normalizeChatEndpoint(null), '');
  assert.strictEqual(normalizeChatEndpoint(undefined), '');
  assert.strictEqual(normalizeChatEndpoint('   '), '');
});

// ---------------- 思考型模型兼容（reasoning_content） ----------------
// 真机实测：本机 8787 网关（hy4-preview-f）把推理内容放在 message.reasoning_content，
// message.content 为 null → 只读 content 会判 llm_empty_response，顾问 100% 空转。
// 修复后应回退到 reasoning_content 并成功解析出帧。

test('callReviewer：content 为 null 时回退 reasoning_content（思考型模型）', async () => {
  const { callReviewer } = require('../hooks/lib/reviewer.js');
  const origFetch = globalThis.fetch;
  const frameJson = '{"severity":"concern","note":"直接拼接 SQL 有注入风险，建议参数化查询"}';
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: null, reasoning_content: `推理过程…\n${frameJson}\n完毕` }
      }],
      usage: { prompt_tokens: 10, completion_tokens: 20 }
    })
  });
  try {
    const r = await callReviewer({
      baseUrl: 'http://127.0.0.1:9/v1',
      model: 'm', apiKey: 'k',
      systemPrompt: 'sp', userContent: 'uc',
      maxTokens: 2048, temperature: 0, timeoutMs: 5000
    });
    assert.ok(!r.error, `不应报错，实际 ${r.error}`);
    assert.ok(r.text && r.text.includes('severity'), '应回退到 reasoning_content 取得文本');
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ---------------- 整轮共享截止时间（A2 回归） ----------------
// 修复前：reviewTurn 的空响应重试每次调用 callReviewer 都各自起算 Date.now()+timeoutMs，
// 单轮最坏 2×reviewTimeoutMs（240s×2=480s），突破 hooks.json 的 Stop 硬超时 320s →
// 宿主强杀 hook → 指针不推进 → 每轮重审同一增量的停滞循环。
// 现在调用方可传入 deadline，整轮（含重试）共享同一预算。

test('callReviewer：外部 deadline 生效（不再独自起算 timeoutMs）', async () => {
  const { callReviewer } = require('../hooks/lib/reviewer.js');
  const origFetch = globalThis.fetch;
  let calls = 0;
  // 挂起到被 AbortSignal 中止（与真实 fetch 一致：不监听 signal 的桩会让用例永不结束）
  globalThis.fetch = (url, opt) => new Promise((resolve, reject) => {
    calls++;
    const s = opt && opt.signal;
    if (s) s.addEventListener('abort', () => {
      const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
    }, { once: true });
  });
  try {
    const t0 = Date.now();
    const r = await callReviewer({
      baseUrl: 'http://127.0.0.1:9/v1', model: 'm', apiKey: 'k',
      systemPrompt: 'sp', userContent: 'uc', maxTokens: 100, temperature: 0,
      timeoutMs: 60000,                      // 故意远大于外部 deadline
      deadline: Date.now() + 1500
    });
    const elapsed = Date.now() - t0;
    assert.strictEqual(r.error, 'llm_timeout');
    assert.ok(elapsed <= 3500, `应在外部 deadline 附近结束而非 timeoutMs，实际 ${elapsed}ms`);
    assert.strictEqual(calls, 1);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('callReviewer：预算已耗尽时不再发起注定超时的请求', async () => {
  const { callReviewer } = require('../hooks/lib/reviewer.js');
  const origFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: true, status: 200, json: async () => ({}) }; };
  try {
    const r = await callReviewer({
      baseUrl: 'http://127.0.0.1:9/v1', model: 'm', apiKey: 'k',
      systemPrompt: 'sp', userContent: 'uc', maxTokens: 100, temperature: 0,
      timeoutMs: 60000,
      deadline: Date.now() - 5000            // 上一轮已耗尽预算
    });
    assert.strictEqual(r.error, 'llm_timeout');
    assert.strictEqual(calls, 0, '预算已耗尽不应发起任何请求');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('callReviewer：content 正常时不使用 reasoning_content（优先级正确）', async () => {
  const { callReviewer } = require('../hooks/lib/reviewer.js');
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({
      choices: [{ index: 0, finish_reason: 'stop',
        message: { content: '{"severity":"nit","note":"来自 content"}', reasoning_content: '{"severity":"blocker","note":"来自 reasoning"}' } }],
      usage: {}
    })
  });
  try {
    const r = await callReviewer({
      baseUrl: 'http://127.0.0.1:9/v1', model: 'm', apiKey: 'k',
      systemPrompt: 'sp', userContent: 'uc', maxTokens: 100, temperature: 0, timeoutMs: 5000
    });
    assert.ok(r.text.includes('来自 content'), 'content 非空时必须优先用 content');
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ---------------- Anthropic /v1/messages 适配 ----------------
// 背景：ZCode 里 kind=anthropic 的服务商（内网 192.168.50.139:8088 的 Anthropic 通道、AIPM）
// 走的是 /v1/messages，与 OpenAI 的 chat/completions 在端点路径、鉴权头、请求体与响应结构上
// 全都不同。适配前这些服务商被直接过滤掉，用户那台内网机上的 4 个 claude-opus 模型用不了。

test('normalizeMessagesEndpoint：裸主机补 /v1/messages，已含 /v1 只补 /messages', () => {
  const { normalizeMessagesEndpoint } = require('../hooks/lib/reviewer.js');
  // 真机实测：ZCode 里 6 个 anthropic 服务商的 baseURL 都不含 /v1，
  // 真实路径是 + /v1/messages（探测：/v1/messages → 401 鉴权层；/messages → 404）。
  // 曾只补 /messages，导致这些服务商全部 404（真机复现）。
  assert.strictEqual(normalizeMessagesEndpoint('http://192.168.50.139:8088'), 'http://192.168.50.139:8088/v1/messages');
  assert.strictEqual(normalizeMessagesEndpoint('https://api.z.ai/api/anthropic'), 'https://api.z.ai/api/anthropic/v1/messages');
  assert.strictEqual(normalizeMessagesEndpoint('https://open.bigmodel.cn/api/anthropic'), 'https://open.bigmodel.cn/api/anthropic/v1/messages');
  assert.strictEqual(normalizeMessagesEndpoint('https://aipm9527.ccwu.cc'), 'https://aipm9527.ccwu.cc/v1/messages');
  // 已含 /v1：只补 /messages（避免 /v1/v1/messages）
  assert.strictEqual(normalizeMessagesEndpoint('https://x.com/v1'), 'https://x.com/v1/messages');
  assert.strictEqual(normalizeMessagesEndpoint('https://x.com/v1/'), 'https://x.com/v1/messages');
  assert.strictEqual(normalizeMessagesEndpoint('https://x.com/v1/messages'), 'https://x.com/v1/messages');
  // 填了 OpenAI 完整端点也应换成 messages，而不是拼出 /chat/completions/messages
  assert.strictEqual(normalizeMessagesEndpoint('https://x.com/v1/chat/completions'), 'https://x.com/v1/messages');
  assert.strictEqual(normalizeMessagesEndpoint(''), '');
  assert.strictEqual(normalizeMessagesEndpoint(null), '');
});

test('normalizeChatEndpoint：填了 Anthropic 端点时不拼出 /messages/chat/completions', () => {
  const { normalizeChatEndpoint } = require('../hooks/lib/reviewer.js');
  assert.strictEqual(normalizeChatEndpoint('https://x.com/v1/messages'), 'https://x.com/v1/chat/completions');
  assert.strictEqual(normalizeChatEndpoint('https://x.com/v1'), 'https://x.com/v1/chat/completions');
});

test('isAnthropicProtocol：只认显式协议标识，未知/空走 OpenAI', () => {
  const { isAnthropicProtocol } = require('../hooks/lib/reviewer.js');
  assert.strictEqual(isAnthropicProtocol('anthropic'), true);
  assert.strictEqual(isAnthropicProtocol('anthropic-messages'), true);
  assert.strictEqual(isAnthropicProtocol('Anthropic'), true);
  assert.strictEqual(isAnthropicProtocol('openai'), false);
  assert.strictEqual(isAnthropicProtocol(''), false);
  assert.strictEqual(isAnthropicProtocol(undefined), false);
});

test('callReviewer(anthropic)：请求头用 x-api-key + anthropic-version，system 走顶层字段', async () => {
  const { callReviewer } = require('../hooks/lib/reviewer.js');
  const origFetch = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, opt) => {
    seen = { url, opt };
    return {
      ok: true, status: 200,
      json: async () => ({
        id: 'msg_1', type: 'message', role: 'assistant',
        content: [{ type: 'text', text: '{"severity":"concern","note":"来自 content[0].text"}' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 11, output_tokens: 22 }
      })
    };
  };
  try {
    const r = await callReviewer({
      baseUrl: 'https://relay.example.com/v1',
      protocol: 'anthropic',
      model: 'claude-opus-5', apiKey: 'sk-ant',
      systemPrompt: 'SYS-PROMPT', userContent: 'USER-DELTA',
      maxTokens: 1024, temperature: 0.2, timeoutMs: 5000
    });
    assert.ok(!r.error, `不应报错，实际 ${r.error}`);
    assert.ok(r.text.includes('来自 content[0].text'), '必须从 content[] 的 text 块取正文');
    assert.deepStrictEqual(r.usage, { promptTokens: 11, completionTokens: 22 },
      'usage 字段名是 input_tokens/output_tokens');
    // 端点：基地址补 /messages（不是 /chat/completions）
    assert.strictEqual(seen.url, 'https://relay.example.com/v1/messages');
    // 鉴权头：x-api-key 而非 Authorization: Bearer
    assert.strictEqual(seen.opt.headers['x-api-key'], 'sk-ant');
    assert.strictEqual(seen.opt.headers['anthropic-version'], '2023-06-01');
    assert.strictEqual(seen.opt.headers.Authorization, undefined, 'anthropic 不得带 Bearer 头');
    // 请求体：system 是顶层字段，messages 里只有 user
    const body = JSON.parse(seen.opt.body);
    assert.strictEqual(body.system, 'SYS-PROMPT');
    assert.deepStrictEqual(body.messages, [{ role: 'user', content: 'USER-DELTA' }]);
    assert.strictEqual(body.max_tokens, 1024);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('callReviewer：baseUrl 以 /messages 结尾时自动按 anthropic 处理（端点自证协议）', async () => {
  const { callReviewer } = require('../hooks/lib/reviewer.js');
  const origFetch = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, opt) => {
    seen = { url, opt };
    return {
      ok: true, status: 200,
      json: async () => ({
        content: [{ type: 'text', text: '{"severity":"nit","note":"ok"}' }],
        stop_reason: 'end_turn', usage: {}
      })
    };
  };
  try {
    const r = await callReviewer({
      baseUrl: 'https://relay.example.com/v1/messages',
      model: 'claude-opus-5', apiKey: 'sk-ant',
      systemPrompt: 'sp', userContent: 'uc', maxTokens: 100, temperature: 0, timeoutMs: 5000
    });
    assert.ok(!r.error, `不应报错，实际 ${r.error}`);
    assert.strictEqual(seen.url, 'https://relay.example.com/v1/messages');
    assert.strictEqual(seen.opt.headers['x-api-key'], 'sk-ant');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('callReviewer(anthropic)：content 为空但 stop_reason=max_tokens → 给出可操作提示', async () => {
  const { callReviewer } = require('../hooks/lib/reviewer.js');
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({
      content: [], stop_reason: 'max_tokens',
      usage: { input_tokens: 10, output_tokens: 4096 }
    })
  });
  try {
    const r = await callReviewer({
      baseUrl: 'https://relay.example.com/v1', protocol: 'anthropic',
      model: 'claude-opus-5', apiKey: 'sk-ant',
      systemPrompt: 'sp', userContent: 'uc', maxTokens: 4096, temperature: 0, timeoutMs: 5000
    });
    assert.strictEqual(r.error, 'llm_empty_response');
    assert.ok(/max_tokens/.test(r.hint || ''), '应提示预算烧在推理上');
    assert.ok(/4096/.test(r.hint || ''), '应带上 output_tokens 便于诊断');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('callReviewer(anthropic)：extended thinking 里能捞出 JSON 帧时采用', async () => {
  const { callReviewer } = require('../hooks/lib/reviewer.js');
  const origFetch = globalThis.fetch;
  const frame = '{"severity":"blocker","note":"来自 thinking 块"}';
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({
      content: [{ type: 'thinking', thinking: `分析…\n${frame}\n完毕` }],
      stop_reason: 'end_turn', usage: {}
    })
  });
  try {
    const r = await callReviewer({
      baseUrl: 'https://relay.example.com/v1', protocol: 'anthropic',
      model: 'claude-opus-5', apiKey: 'sk-ant',
      systemPrompt: 'sp', userContent: 'uc', maxTokens: 4096, temperature: 0, timeoutMs: 5000
    });
    assert.ok(!r.error, `不应报错，实际 ${r.error}`);
    assert.ok(r.text.includes('severity'), '应从 thinking 块捞出合法 JSON 帧');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('callReviewer(openai)：显式 protocol=openai 时仍走 chat/completions（不误伤）', async () => {
  const { callReviewer } = require('../hooks/lib/reviewer.js');
  const origFetch = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, opt) => {
    seen = { url, opt };
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: '{"severity":"nit","note":"ok"}' }, finish_reason: 'stop' }], usage: {} })
    };
  };
  try {
    const r = await callReviewer({
      baseUrl: 'https://relay.example.com/v1', protocol: 'openai',
      model: 'm', apiKey: 'k',
      systemPrompt: 'sp', userContent: 'uc', maxTokens: 100, temperature: 0, timeoutMs: 5000
    });
    assert.ok(!r.error);
    assert.strictEqual(seen.url, 'https://relay.example.com/v1/chat/completions');
    assert.strictEqual(seen.opt.headers.Authorization, 'Bearer k');
    assert.strictEqual(seen.opt.headers['x-api-key'], undefined);
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ---------------- 复审整改（protocol 优先级 / 尾斜杠 / 信封容错） ----------------
// 复审实测：隐式 `/messages$` 判定若**覆盖**显式 protocol，会让「baseUrl 恰好以 /messages
// 结尾的 OpenAI 兼容服务商」被误判成 anthropic —— key 以 x-api-key 发到 OpenAI 端点，
// 而 controller 只认显式 protocol → 同一服务商 ping 成功、审查必失败。

test('callReviewer：显式 protocol=openai 不被 baseUrl 的 /messages 结尾覆盖', async () => {
  const { callReviewer } = require('../hooks/lib/reviewer.js');
  const origFetch = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, opt) => {
    seen = { url, opt };
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: '{"severity":"nit","note":"ok"}' }, finish_reason: 'stop' }], usage: {} })
    };
  };
  try {
    const r = await callReviewer({
      baseUrl: 'https://gw.example/openai/messages',
      protocol: 'openai',
      model: 'm', apiKey: 'K',
      systemPrompt: 'sp', userContent: 'uc', maxTokens: 100, temperature: 0, timeoutMs: 5000
    });
    assert.ok(!r.error, `不应报错，实际 ${r.error}`);
    assert.strictEqual(seen.url, 'https://gw.example/openai/chat/completions',
      '显式 openai 必须走 chat/completions（与 controller 判定一致）');
    assert.strictEqual(seen.opt.headers.Authorization, 'Bearer K');
    assert.strictEqual(seen.opt.headers['x-api-key'], undefined, '不得以 x-api-key 发凭据');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('callReviewer：protocol 缺省时才按 /messages 结尾推断 anthropic', async () => {
  const { callReviewer } = require('../hooks/lib/reviewer.js');
  const origFetch = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, opt) => {
    seen = { url, opt };
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: '{"severity":"nit","note":"ok"}' }], stop_reason: 'end_turn', usage: {} }) };
  };
  try {
    const r = await callReviewer({
      baseUrl: 'https://gw.example/v1/messages',
      model: 'm', apiKey: 'K',
      systemPrompt: 'sp', userContent: 'uc', maxTokens: 100, temperature: 0, timeoutMs: 5000
    });
    assert.ok(!r.error, `不应报错，实际 ${r.error}`);
    assert.strictEqual(seen.url, 'https://gw.example/v1/messages');
    assert.strictEqual(seen.opt.headers['x-api-key'], 'K');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('callReviewer：尾斜杠的 /messages/ 也能推断出 anthropic（与归一化同纪律）', async () => {
  const { callReviewer } = require('../hooks/lib/reviewer.js');
  const origFetch = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, opt) => {
    seen = { url, opt };
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: '{"severity":"nit","note":"ok"}' }], stop_reason: 'end_turn', usage: {} }) };
  };
  try {
    const r = await callReviewer({
      baseUrl: 'https://gw.example/v1/messages/',
      model: 'm', apiKey: 'K',
      systemPrompt: 'sp', userContent: 'uc', maxTokens: 100, temperature: 0, timeoutMs: 5000
    });
    assert.ok(!r.error, `不应报错，实际 ${r.error}`);
    assert.strictEqual(seen.url, 'https://gw.example/v1/messages');
    assert.strictEqual(seen.opt.headers['x-api-key'], 'K', '尾斜杠不得让 anthropic 静默退回 Bearer');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('callReviewer(anthropic)：网关回成 OpenAI 信封时也能取到正文', async () => {
  const { callReviewer } = require('../hooks/lib/reviewer.js');
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({
      choices: [{ message: { content: '{"severity":"concern","note":"被网关包成 OpenAI 信封"}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 4 }
    })
  });
  try {
    const r = await callReviewer({
      baseUrl: 'https://relay.example.com/v1', protocol: 'anthropic',
      model: 'm', apiKey: 'k',
      systemPrompt: 'sp', userContent: 'uc', maxTokens: 100, temperature: 0, timeoutMs: 5000
    });
    assert.ok(!r.error, `不应判成空响应，实际 ${r.error}`);
    assert.ok(r.text.includes('被网关包成 OpenAI 信封'));
    assert.deepStrictEqual(r.usage, { promptTokens: 3, completionTokens: 4 });
  } finally {
    globalThis.fetch = origFetch;
  }
});
