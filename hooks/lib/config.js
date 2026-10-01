'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// hooks.json 中 Stop 的硬超时为 320000ms（见 hooks/hooks.json）。
// sync 模式的审查超时必须留出余量，否则宿主强杀 hook 会造成"指针不推进→每轮重审"的停滞循环。
const SYNC_TIMEOUT_CAP_MS = 300000;

const DEFAULTS = {
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  model: 'glm-5.3-flash',
  apiKey: '',
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

function applyLayer(cfg, raw, problems) {
  if (!raw || typeof raw !== 'object') return;
  for (const [k, v] of Object.entries(raw)) {
    if (!(k in DEFAULTS)) continue;
    cfg[k] = v;
  }
}

// 加载顺序：内置默认 <- 插件目录 advisor.config.json <- 用户级 ~/.zcode/advisor.config.json <- 环境变量。
// 用户级文件由 /advisor-setup 维护，跨插件升级/重装保留，是推荐的 key/模型填写位置。
// 任何读取失败都只降级（问题挂到 cfg.problems，由注册行/status 消费），绝不抛错。
function loadConfig(pluginRoot, env) {
  const cfg = Object.assign({}, DEFAULTS);
  const problems = [];
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

  if (env.ZCODE_ADVISOR_BASE_URL) cfg.baseUrl = env.ZCODE_ADVISOR_BASE_URL;
  if (env.ZCODE_ADVISOR_MODEL) cfg.model = env.ZCODE_ADVISOR_MODEL;
  if (env.ZCODE_ADVISOR_API_KEY) cfg.apiKey = env.ZCODE_ADVISOR_API_KEY;
  if (env.ZCODE_ADVISOR_REVIEW_MODE) cfg.reviewMode = env.ZCODE_ADVISOR_REVIEW_MODE === 'sync' ? 'sync' : 'async';
  for (const k of INT_KEYS) {
    if (env[`ZCODE_ADVISOR_${snake(k)}`] != null) cfg[k] = toInt(env[`ZCODE_ADVISOR_${snake(k)}`], cfg[k]);
  }
  for (const k of BOOL_KEYS) {
    if (env[`ZCODE_ADVISOR_${snake(k)}`] != null) cfg[k] = toBool(env[`ZCODE_ADVISOR_${snake(k)}`], cfg[k]);
  }
  if (env.ZCODE_ADVISOR_TEMPERATURE != null) cfg.temperature = toFloat(env.ZCODE_ADVISOR_TEMPERATURE, cfg.temperature);
  if (env.ZCODE_ADVISOR_STATE_DIR) cfg.stateDir = env.ZCODE_ADVISOR_STATE_DIR;
  if (!Array.isArray(cfg.apiKeyEnv) || cfg.apiKeyEnv.length === 0) cfg.apiKeyEnv = DEFAULTS.apiKeyEnv;
  if (env.ZCODE_ADVISOR_API_KEY || env.ZCODE_ADVISOR_MODEL) sources.push('env');

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

  // sync 模式超时联动：reviewTimeoutMs 不得逼近 hooks.json 的 Stop 硬超时（320s），
  // 否则宿主强杀 hook → 指针不落盘 → 每轮重审同一增量的停滞循环。
  if (cfg.reviewMode === 'sync' && cfg.reviewTimeoutMs > SYNC_TIMEOUT_CAP_MS) {
    problems.push(`reviewTimeoutMs_clamped: sync 模式下 ${cfg.reviewTimeoutMs}ms 超过上限，已钳制到 ${SYNC_TIMEOUT_CAP_MS}ms（Stop hook 硬超时 320s）`);
    cfg.reviewTimeoutMs = SYNC_TIMEOUT_CAP_MS;
  }

  cfg.problems = problems;
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
  isPlaceholderKey, userConfigPath, maskKey
};
