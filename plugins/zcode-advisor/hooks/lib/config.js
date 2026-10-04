'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// hooks.json 中 Stop 的硬超时为 320000ms（见 hooks/hooks.json）。
// sync 模式的审查超时必须留出余量，否则宿主强杀 hook 会造成"指针不推进→每轮重审"的停滞循环。
const SYNC_TIMEOUT_CAP_MS = 300000;

const DEFAULTS = {
  // —— 审查通道来源（0.2.17 起唯一来源：ZCode 已维护的**第三方**服务商）——
  // 端点/key/模型一律从 ~/.zcode/v2/config.json 的 provider.* 解析（一处维护两处生效），
  // 只认非官方（非 builtin:）且 OpenAI 兼容的服务商；本插件不再维护端点/key。
  // zcodeProvider：全局服务商（id 或名称）；留空 = 自动选择（优先含 cfg.model 的服务商）。
  zcodeProvider: '',
  // 全局审查模型（id）。留空 = 取所选服务商登记清单首项。
  // 会话级覆盖：state.sessionModel / state.sessionZcodeProvider（角标面板或 /advisor-model）。
  model: '',
  // 环境变量逃生舱（CI/测试/特殊部署）：ZCODE_ADVISOR_BASE_URL/API_KEY/MODEL 显式覆盖解析结果。
  // 注意：baseUrl/apiKey **不是**可落盘配置键（applyLayer 只拷贝 DEFAULTS 里登记的键）——
  // 旧配置文件里的手动端点/key 一律失效，防止「手动 key 发往服务商端点」的密钥交叉。
  apiKeyEnv: ['ZCODE_ADVISOR_API_KEY', 'ZAI_API_KEY', 'Z_AI_API_KEY', 'ZHIPUAI_API_KEY', 'BIGMODEL_API_KEY'],
  systemPrompt: '',
  // 审查模式：async（默认，Stop 立即返回，审查在后台完成，意见下条消息送达）
  // 或 sync（Stop 内联审查，concern/blocker 立即送达，但每轮收尾要等审查完成）。
  reviewMode: 'async',
  immuneTurns: 3,
  maxDeltaMessages: 60,
  // 768 对思考型模型不够（dsh-advisor issue #102 的实测教训）。注意：2048/240s 这组默认值
  // 没有在本插件的目标端点上独立验证过；有实证支撑的下限是 4096（dsh 端 guard 通道实测零丢弃）。
  // 思考型模型建议 4096；提高预算时同步关注 reviewTimeoutMs。
  maxTokens: 4096,
  temperature: 0.2,
  // 散文救回默认开启（对齐 dsh 端本地补丁 v2.2 的实际生效状态；上游 dsh-advisor 默认 false）。
  proseFallback: true,
  // 单条建议的长度上限（Unicode 码点）。同时约束 JSON 帧与散文救回两条路径，
  // 防止失控审查模型向主会话注入超长内容。
  maxNoteChars: 768,
  startEnabled: true,
  // sync 模式单轮 steer 上限。主要防循环依赖 stop_hook_active 跳过续跑轮；
  // 此值是纵深防御，正常流程下不会触达。
  maxBlocksPerTurn: 2,
  // 真实大输入下审查延迟可达数分钟（dsh 端实测 70~319s，跨栈外推仅供参考）；sync 模式此值必须容纳"思考+建议"。
  reviewTimeoutMs: 240000,
  // 全局同时在飞的 review-worker 上限（跨会话），超限计 busy 丢弃。
  maxGlobalWorkers: 4,
  // 增量回读上限（字节）：offset 大幅落后（门禁修复/compact/长期积压）时只从尾部回读，
  // 放弃更早历史，避免单次数拾 MB 的内存分配。
  backfillLimitBytes: 2097152,
  maxContextChars: 48000,
  pendingNotesCap: 5,
  // 降级备用模型（M4）：主模型触发**白名单**失败时临时换用。空 = 关闭（默认）。
  // 只换 model id，端点/key 沿用同一服务商（防密钥交叉）。
  // 建议配**快模型/非思考型**——它要在主模型烧剩的预算里跑完（见 reviewTurn 的 reserve）。
  fallbackModel: '',
  stateDir: ''
};

const INT_KEYS = ['immuneTurns', 'maxDeltaMessages', 'maxTokens', 'maxBlocksPerTurn', 'reviewTimeoutMs', 'maxContextChars', 'pendingNotesCap', 'maxNoteChars', 'maxGlobalWorkers', 'backfillLimitBytes'];
// 必须为正的整数键（immuneTurns 允许 0）。越界回退默认并挂 problems，防止 0/负数触发静默荒谬行为。
const POSITIVE_INT_KEYS = INT_KEYS.filter((k) => k !== 'immuneTurns');
const BOOL_KEYS = ['proseFallback', 'startEnabled'];
const FLOAT_KEYS = ['temperature'];

function userConfigPath(env) {
  const e = env || process.env;
  // 测试/特殊部署可覆盖；默认在用户主目录（跨插件升级/重装保留）。
  if (e.ZCODE_ADVISOR_USER_CONFIG) return e.ZCODE_ADVISOR_USER_CONFIG;
  return path.join(os.homedir(), '.zcode', 'advisor.config.json');
}

// ZCode 桌面版把用户维护的模型服务商（含第三方 API）存在 ~/.zcode/v2/config.json：
// provider.<id> = { name, kind: 'anthropic'|'openai'|'openai-compatible',
//                   options: { baseURL, apiKey }, models: { <modelId>: … } }。
// 本插件审查通道只走 OpenAI 兼容 chat/completions（见 reviewer.js），kind=anthropic 不可用。
// id 以 builtin: 开头的是 ZCode 官方内置通道（bigmodel/z.ai），审查通道不使用（只借道第三方）。
function zcodeConfigPath(env) {
  const e = env || process.env;
  // 测试/特殊部署可覆盖。
  if (e.ZCODE_ADVISOR_ZCODE_CONFIG) return e.ZCODE_ADVISOR_ZCODE_CONFIG;
  return path.join(os.homedir(), '.zcode', 'v2', 'config.json');
}

// 读取全部 provider（含 apiKey，仅供 hook 解析/本机面板 Ping 等本地路径使用）。
// 读取失败返回 []（ZCode 未装/未配置过 provider 时是正常状态，不挂 problems）。
function readZcodeProviders(env) {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(zcodeConfigPath(env), 'utf8'));
  } catch (_) {
    return [];
  }
  const map = raw && raw.provider && typeof raw.provider === 'object' ? raw.provider : {};
  const out = [];
  for (const [id, p] of Object.entries(map)) {
    if (!p || typeof p !== 'object') continue;
    const opts = p.options && typeof p.options === 'object' ? p.options : {};
    const models = p.models && typeof p.models === 'object' ? Object.keys(p.models) : [];
    out.push({
      id,
      name: String(p.name || ''),
      kind: String(p.kind || ''),
      baseURL: String(opts.baseURL || '').trim(),
      apiKey: String(opts.apiKey || '').trim(),
      models,
      eligible: p.kind === 'openai' || p.kind === 'openai-compatible',
      // 官方内置通道（bigmodel/z.ai 的 builtin:*）——审查通道不使用。
      official: id.startsWith('builtin:')
    });
  }
  return out;
}

// 面板/状态展示用：剔除 apiKey 明文，只给掩码标记。
function listZcodeProviders(env) {
  return readZcodeProviders(env).map((p) => ({
    id: p.id, name: p.name, kind: p.kind, baseURL: p.baseURL,
    models: p.models, eligible: p.eligible, official: p.official,
    hasApiKey: Boolean(p.apiKey)
  }));
}

// 可用作审查通道的服务商：非官方 + OpenAI 兼容 + 端点/key 齐备。
// 注意：这段判定在 resolveProviderTarget 内联使用（需要区分「显式指定」与「自动选择」
// 两条路径的不同错误文案）；此前曾导出一份 usableZcodeProviders 副本，无人调用，已删除。
function findZcodeProvider(providers, want) {
  const w = String(want || '').trim();
  if (!w) return null;
  return providers.find((p) => p.id === w) || providers.find((p) => p.name && p.name === w) || null;
}

// 解析「服务商 + 模型」→ 可直接发起调用的 { baseUrl, apiKey, model }（纯函数，测试锁字段名）。
// 失败一律返回 { ok:false, problem }：problem 文案面向用户、可操作，由调用方挂到 problems/提示行。
// 规则：
// - 未指定服务商 → 自动选择：优先登记清单里含 modelWant 的服务商，其次第一个可用的；
// - 显式指定的服务商即使清单里没有该模型也尊重（ZCode 清单可能滞后，真实可用性以端点为准）；
// - 官方内置（builtin:）/非 OpenAI 兼容/缺端点或 key → 明确拒绝，不产出任何凭据（防密钥交叉）。
function resolveProviderTarget(providers, providerWant, modelWant) {
  const want = String(providerWant || '').trim();
  const wantModel = String(modelWant || '').trim();
  let found = null;
  let auto = false;
  if (want) {
    found = findZcodeProvider(providers, want);
    if (!found) {
      return { ok: false, problem: `zcode_provider_not_found: ZCode 配置里找不到服务商「${want}」——请在面板点「刷新」后重新选择` };
    }
  } else {
    const usable = providers.filter((p) => !p.official && p.eligible && p.baseURL && p.apiKey);
    if (usable.length === 0) {
      return { ok: false, problem: 'zcode_provider_missing: ZCode 里没有可用的第三方服务商（需 OpenAI 兼容且已填端点与 key）——请先在 ZCode 设置里添加' };
    }
    found = (wantModel && usable.find((p) => p.models.includes(wantModel))) || usable[0];
    auto = true;
  }
  if (found.official) {
    return { ok: false, problem: `zcode_provider_official: 服务商「${found.name || found.id}」是 ZCode 官方内置通道——审查通道只使用第三方服务商` };
  }
  if (!found.eligible) {
    return { ok: false, problem: `zcode_provider_ineligible: 服务商「${found.name || found.id}」协议为 ${found.kind || '未知'}，审查通道仅支持 OpenAI 兼容端点` };
  }
  if (!found.baseURL || !found.apiKey) {
    const missing = [!found.baseURL && 'baseURL', !found.apiKey && 'apiKey'].filter(Boolean).join('/');
    return { ok: false, problem: `zcode_provider_incomplete: 服务商「${found.name || found.id}」缺少 ${missing}——请在 ZCode 设置里补全` };
  }
  const model = wantModel || found.models[0] || '';
  if (!model) {
    return { ok: false, problem: `zcode_no_model: 服务商「${found.name || found.id}」没有登记模型——请在 ZCode 设置里添加模型，或在面板手填模型 id` };
  }
  const notices = [];
  if (auto) {
    notices.push(`zcode_provider_auto: 未指定审查服务商，已自动选择「${found.name || found.id}」（可在角标面板或「完整配置」里更改）`);
  } else if (wantModel && found.models.length > 0 && !found.models.includes(wantModel)) {
    // 显式模型不在登记清单里：可能是清单滞后，也可能是旧配置残留。不阻断（尊重用户选择），但必须可见。
    notices.push(`zcode_model_unlisted: 模型「${wantModel}」不在服务商「${found.name || found.id}」的登记清单里（若不是有意为之，请在面板重新选择）`);
  }
  return { ok: true, provider: found, baseUrl: found.baseURL, apiKey: found.apiKey, model, auto, notices };
}

// 解析全局审查目标并写入 cfg（loadConfig 的 provider 解析阶段）。
// 解析失败不产出凭据（cfg.baseUrl/apiKey 留空）→ 门禁拦下并展示 problem；
// 环境变量逃生舱（ZCODE_ADVISOR_BASE_URL/API_KEY/MODEL）在调用方随后覆盖，仍可放行。
function applyZcodeTarget(cfg, problems, sources, notices, env) {
  cfg.providerLabel = 'ZCode 第三方服务商';
  cfg.providerId = '';
  cfg.providerName = '';
  cfg.providerAuto = false;
  const t = resolveProviderTarget(readZcodeProviders(env), cfg.zcodeProvider, cfg.model);
  if (!t.ok) {
    problems.push(t.problem);
    return;
  }
  cfg.baseUrl = t.baseUrl;
  cfg.apiKey = t.apiKey;
  cfg.model = t.model;
  cfg.providerId = t.provider.id;
  cfg.providerName = t.provider.name || t.provider.id;
  cfg.providerAuto = Boolean(t.auto);
  cfg.providerLabel = `ZCode 第三方服务商（${cfg.providerName}）`;
  sources.push(`zcode-provider:${cfg.providerName}`);
  for (const n of t.notices || []) notices.push(n);
}

// 占位符样式的 key（REPLACE_YOUR_KEY / your-api-key / test-key 等）视为未配置。
// 注意：以 test 开头的真实 key 会被误判——这是有意的安全默认，README 已说明。
function isPlaceholderKey(value) {
  if (typeof value !== 'string') return true;
  const v = value.trim();
  if (!v) return true;
  if (/^<.*>$/.test(v)) return true;
  if (/^(replace|your|xxx+|test|placeholder|changeme|sk-xxx+|none|null|empty)/i.test(v)) return true;
  if (/your[_-]?api/i.test(v)) return true;
  if (/[\u4e00-\u9fff]/.test(v)) return true; // 含中文 = 未替换的模板文案
  return false;
}

function toInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function toFloat(value, fallback) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

function toBool(value, fallback) {
  if (value === true) return true;
  if (value === false || value == null) return fallback;
  const v = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

function readConfigFile(file, problems, label) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    problems.push(`config_invalid: ${label} 解析失败（${err.message.slice(0, 80)}），该层已跳过`);
    return null;
  }
}

// 只拷贝 DEFAULTS 里登记的键：旧版配置残留（apiSource/baseUrl/apiKey/zcodeModel 等）
// 自动失效、不再参与解析——0.2.17 起端点/key 一律来自 ZCode 服务商，插件配置里的旧值
// 若继续生效会造成"key 与端点交叉"（手动 key 发往服务商端点）。
function applyLayer(cfg, raw, problems) {
  if (!raw || typeof raw !== 'object') return;
  for (const [k, v] of Object.entries(raw)) {
    if (!(k in DEFAULTS)) continue;
    cfg[k] = v;
  }
}

// 加载顺序：内置默认 <- 插件目录 advisor.config.json <- 用户级 ~/.zcode/advisor.config.json
// <- ZCode 服务商解析（zcodeProvider → baseUrl/apiKey/model）<- 环境变量（显式逃生舱）。
// 任何读取失败都只降级（问题挂到 cfg.problems，由注册行/status 消费），绝不抛错。
function loadConfig(pluginRoot, env) {
  const cfg = Object.assign({}, DEFAULTS);
  const problems = [];
  const notices = [];
  const sources = [];

  const pluginCfg = readConfigFile(path.join(pluginRoot, 'advisor.config.json'), problems, '插件目录 advisor.config.json');
  if (pluginCfg) {
    applyLayer(cfg, pluginCfg);
    sources.push('plugin:advisor.config.json');
  }
  const userCfg = readConfigFile(userConfigPath(env), problems, '用户级 ~/.zcode/advisor.config.json');
  if (userCfg) {
    applyLayer(cfg, userCfg);
    sources.push('user:~/.zcode/advisor.config.json');
  }

  // 环境变量可显式指定服务商（CI/测试/多套配置切换）。
  if (env.ZCODE_ADVISOR_ZCODE_PROVIDER != null) cfg.zcodeProvider = String(env.ZCODE_ADVISOR_ZCODE_PROVIDER).trim();

  // 服务商解析：端点/key/模型一次定稿（全局层）。env 逃生舱在下一段覆盖。
  applyZcodeTarget(cfg, problems, sources, notices, env);

  if (env.ZCODE_ADVISOR_BASE_URL) cfg.baseUrl = env.ZCODE_ADVISOR_BASE_URL;
  if (env.ZCODE_ADVISOR_MODEL) cfg.model = env.ZCODE_ADVISOR_MODEL;
  if (env.ZCODE_ADVISOR_API_KEY) cfg.apiKey = env.ZCODE_ADVISOR_API_KEY;
  if (env.ZCODE_ADVISOR_REVIEW_MODE) cfg.reviewMode = env.ZCODE_ADVISOR_REVIEW_MODE === 'sync' ? 'sync' : 'async';
  if (env.ZCODE_ADVISOR_FALLBACK_MODEL != null) cfg.fallbackModel = String(env.ZCODE_ADVISOR_FALLBACK_MODEL).trim();
  for (const k of INT_KEYS) {
    if (env[`ZCODE_ADVISOR_${snake(k)}`] != null) cfg[k] = toInt(env[`ZCODE_ADVISOR_${snake(k)}`], cfg[k]);
  }
  for (const k of BOOL_KEYS) {
    if (env[`ZCODE_ADVISOR_${snake(k)}`] != null) cfg[k] = toBool(env[`ZCODE_ADVISOR_${snake(k)}`], cfg[k]);
  }
  if (env.ZCODE_ADVISOR_TEMPERATURE != null) cfg.temperature = toFloat(env.ZCODE_ADVISOR_TEMPERATURE, cfg.temperature);
  if (env.ZCODE_ADVISOR_STATE_DIR) cfg.stateDir = env.ZCODE_ADVISOR_STATE_DIR;
  if (!Array.isArray(cfg.apiKeyEnv) || cfg.apiKeyEnv.length === 0) cfg.apiKeyEnv = DEFAULTS.apiKeyEnv;
  if (env.ZCODE_ADVISOR_API_KEY || env.ZCODE_ADVISOR_MODEL || env.ZCODE_ADVISOR_BASE_URL) sources.push('env');

  // 整数范围守卫：正整数键被配成 0/负数时回退默认（0/负数会触发静默荒谬行为）。
  for (const k of POSITIVE_INT_KEYS) {
    if (!Number.isFinite(cfg[k]) || cfg[k] <= 0) {
      problems.push(`config_out_of_range: ${k}=${cfg[k]} 必须为正整数，已回退默认 ${DEFAULTS[k]}`);
      cfg[k] = DEFAULTS[k];
    }
  }
  if (!Number.isFinite(cfg.immuneTurns) || cfg.immuneTurns < 0) {
    problems.push(`config_out_of_range: immuneTurns=${cfg.immuneTurns} 必须为非负整数，已回退默认 ${DEFAULTS.immuneTurns}`);
    cfg.immuneTurns = DEFAULTS.immuneTurns;
  }

  // reviewMode 归一化：大小写漂移（手写 "SYNC"）会同时漏掉下面的 sync 钳制与预算分支
  // （都用 === 'sync' 判断）→ 脏值绕过 300s 钳制。未知值/非字符串一律归一 async 并登记。
  if (typeof cfg.reviewMode === 'string') cfg.reviewMode = cfg.reviewMode.trim().toLowerCase();
  if (cfg.reviewMode !== 'sync') {
    if (cfg.reviewMode !== 'async') {
      problems.push(`config_normalized: reviewMode=${JSON.stringify(cfg.reviewMode)} 非法，已归一为 async`);
    }
    cfg.reviewMode = 'async';
  }

  // maxTokens 专守卫：接受字符串数字（手写配置常见，Number("8192")=8192 直接采用）；
  // 数值越界**钳到** [64,16384]（贴近用户意图，低侧回退是 64 倍成本惩罚、高侧回退是 4 倍质量退化）；
  // 非整数垃圾（""/null/true/[]）回退默认。修复：字符串被静默降级、999999999 无上界直发、浮点穿透。
  const mtRaw = Number(cfg.maxTokens);
  if (!Number.isInteger(mtRaw) || mtRaw <= 0) {
    problems.push(`config_out_of_range: maxTokens=${JSON.stringify(cfg.maxTokens)} 不是正整数，已回退默认 ${DEFAULTS.maxTokens}`);
    cfg.maxTokens = DEFAULTS.maxTokens;
  } else if (mtRaw < 64 || mtRaw > 16384) {
    const clamped = Math.min(16384, Math.max(64, mtRaw));
    problems.push(`config_out_of_range: maxTokens=${mtRaw} 越界 [64,16384]，已钳制到 ${clamped}`);
    cfg.maxTokens = clamped;
  } else {
    cfg.maxTokens = mtRaw;
  }

  // reviewTimeoutMs 下界：<1000ms 时 reviewer 的预检（remaining()<1000）直接 0 请求返回，
  // 审查全废且只有 llm_timeout 计数——回退默认并登记。（1000~5000 的本地快模型合法，不钳。）
  if (Number.isFinite(cfg.reviewTimeoutMs) && cfg.reviewTimeoutMs < 1000) {
    problems.push(`config_out_of_range: reviewTimeoutMs=${cfg.reviewTimeoutMs} 低于最小 1000ms，已回退默认 ${DEFAULTS.reviewTimeoutMs}`);
    cfg.reviewTimeoutMs = DEFAULTS.reviewTimeoutMs;
  }

  // sync 模式超时联动：reviewTimeoutMs 不得逼近 hooks.json 的 Stop 硬超时（320s），
  // 否则宿主强杀 hook → 指针不落盘 → 每轮重审同一增量的停滞循环。
  if (cfg.reviewMode === 'sync' && cfg.reviewTimeoutMs > SYNC_TIMEOUT_CAP_MS) {
    problems.push(`reviewTimeoutMs_clamped: sync 模式下 ${cfg.reviewTimeoutMs}ms 超过上限，已钳制到 ${SYNC_TIMEOUT_CAP_MS}ms（Stop hook 硬超时 320s）`);
    cfg.reviewTimeoutMs = SYNC_TIMEOUT_CAP_MS;
  }
  // async 上界：无宿主硬限也须有界——预算按 2× 放大后，worker 最坏占全局槽 2×上限、
  // 崩溃残留锁让该会话 busy 2×上限+60s。10 分钟 = 实证上限（dsh 端 319s）的 30 倍余量。
  if (cfg.reviewMode !== 'sync' && cfg.reviewTimeoutMs > 600000) {
    problems.push(`reviewTimeoutMs_clamped: async 模式下 ${cfg.reviewTimeoutMs}ms 超过上限，已钳制到 600000ms`);
    cfg.reviewTimeoutMs = 600000;
  }

  cfg.problems = problems;
  cfg.notices = notices;
  cfg.configSources = sources;
  return cfg;
}

function snake(name) {
  return name.replace(/([A-Z])/g, '_$1').toUpperCase();
}

function resolveApiKey(cfg, env) {
  const direct = String(cfg.apiKey || '').trim();
  if (direct && !isPlaceholderKey(direct)) return { key: direct, source: 'config' };
  for (const name of cfg.apiKeyEnv) {
    const v = String(env[name] || '').trim();
    if (v && !isPlaceholderKey(v)) return { key: v, source: `env:${name}` };
  }
  return { key: '', source: '' };
}

// 硬门禁：与 dsh-advisor 一致，model/apiKey/baseUrl 缺失时绝不发起模型调用。
function gate(cfg, apiKeyInfo) {
  const reasons = [];
  if (!cfg.baseUrl) reasons.push('missing:baseUrl');
  if (!cfg.model) reasons.push('missing:model');
  if (!apiKeyInfo || !apiKeyInfo.key) reasons.push('missing:apiKey');
  return reasons;
}

// 非阻断性配置警告（发往任意端点的风险提示，由 status/注册行展示）。
function configWarnings(cfg, apiKeyInfo) {
  const warnings = [];
  const url = String(cfg.baseUrl || '');
  if (url.startsWith('http://')) {
    const m = /^http:\/\/([^/:]+)/.exec(url);
    const host = m ? m[1] : '';
    if (!/^(localhost|127\.|::1|\[::1\])/i.test(host)) {
      warnings.push('insecure_http_endpoint: 转录与 key 将明文发送到非本机 HTTP 端点');
    }
  }
  // 共享环境变量 key 发往非签发方端点 = key 外泄（安全复审第 3 条）。
  const sharedEnv = apiKeyInfo && apiKeyInfo.source && apiKeyInfo.source.startsWith('env:')
    && apiKeyInfo.source !== 'env:ZCODE_ADVISOR_API_KEY';
  if (sharedEnv && !/bigmodel\.cn|z\.ai/i.test(url)) {
    warnings.push(`key_endpoint_mismatch: ${apiKeyInfo.source} 是官方签发的共享 key，正发往非官方端点`);
  }
  return warnings;
}

function maskKey(key) {
  const k = String(key || '');
  if (k.length <= 8) return '****';
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

module.exports = {
  DEFAULTS, SYNC_TIMEOUT_CAP_MS, loadConfig, resolveApiKey, gate, configWarnings,
  isPlaceholderKey, userConfigPath, maskKey,
  zcodeConfigPath, readZcodeProviders, listZcodeProviders,
  findZcodeProvider, resolveProviderTarget
};
