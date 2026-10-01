#!/usr/bin/env node
'use strict';

// config-bridge：随会话启动的 MCP 桥接进程。
// 作用：把插件设置页（plugin.json userConfig 表单）里保存的值落盘到用户级配置
// ~/.zcode/advisor.config.json——这样 hook（读不到 user_config 环境变量）也能用上 GUI 配置。
// 纪律：
// - **只填补缺失键**：宿主会把 userConfig 声明的 default 展开进环境变量（用户没填也有值），
//   因此这里绝不能覆盖用户级配置里已有的非空值——否则每次会话启动都会把用户在
//   配置面板/advisor-setup 里调好的端点、模型静默改回表单默认（真机实测踩过：401）。
//   表单是"兜底填充"，不是"权威覆盖"；显式写路径（面板保存按钮）才用覆盖语义。
// - 落盘失败只写 stderr，不影响 MCP 协议；
// - 启动即落盘，然后再服务最小 MCP 协议（stdio JSON-RPC），宿主异常时也不阻塞会话。

const fs = require('fs');
const os = require('os');
const path = require('path');

const USER_CONFIG = process.env.ZCODE_ADVISOR_USER_CONFIG
  || path.join(os.homedir(), '.zcode', 'advisor.config.json');

// 从 env 提取 GUI 表单值（由 plugin.json mcpServers env 的 ${user_config.*} 模板填充）。
function guiValuesFromEnv(env) {
  const out = {};
  const map = {
    ZCODE_ADVISOR_CFG_API_KEY: 'apiKey',
    ZCODE_ADVISOR_CFG_MODEL: 'model',
    ZCODE_ADVISOR_CFG_BASE_URL: 'baseUrl',
    ZCODE_ADVISOR_CFG_REVIEW_MODE: 'reviewMode'
  };
  for (const [envKey, cfgKey] of Object.entries(map)) {
    const v = String(env[envKey] || '').trim();
    // 宿主可能把未填字段展开为字面模板串——同样跳过。
    if (v && !v.includes('${')) out[cfgKey] = v;
  }
  return out;
}

function isBlank(v) {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

// 合并策略：
// - 默认（覆盖）：GUI 非空值覆盖同名键，其余既有字段原样保留。
//   用于**显式写路径**——配置面板「保存配置」按钮、controller 的保存动作。
// - fillMissingOnly（只填补）：GUI 值仅在既有配置对应键缺失/空值时才写入，
//   已有非空值一律保留。用于**随会话启动的桥接进程**（见文件头纪律）。
function mergeUserConfig(existingRaw, guiValues, opts) {
  const fillMissingOnly = !!(opts && opts.fillMissingOnly);
  let base = {};
  if (existingRaw && typeof existingRaw === 'object' && !Array.isArray(existingRaw)) {
    base = existingRaw;
  }
  const merged = Object.assign({}, base);
  for (const [k, v] of Object.entries(guiValues || {})) {
    if (isBlank(v)) continue;
    if (fillMissingOnly && !isBlank(merged[k])) continue; // 已有非空值：用户配置优先
    merged[k] = v;
  }
  return merged;
}

function writeUserConfig(guiValues, file, opts) {
  const target = file || USER_CONFIG;
  const values = guiValues || {};
  if (Object.keys(values).length === 0) return { changed: false, file: target };
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (_) {}
  const merged = mergeUserConfig(existing, values, opts);
  // 无实际变化就不落盘：桥接进程每次会话启动都跑一遍，无谓改写会污染 mtime
  // 并让用户误以为配置被改动（排查 401 时正是靠 mtime 定位到本缺陷）。
  if (JSON.stringify(merged) === JSON.stringify(existing)) {
    return { changed: false, file: target };
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8');
  fs.renameSync(tmp, target);
  return { changed: true, file: target, keys: Object.keys(values) };
}

// —— 最小 MCP stdio 服务（initialize / tools/list / tools/call / ping）——
function serveMcp() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      handle(msg);
    }
  });
  process.stdin.on('end', () => process.exit(0));

  function send(obj) {
    try { process.stdout.write(JSON.stringify(obj) + '\n'); } catch (_) {}
  }

  function handle(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.id === undefined) return; // notification：忽略
    switch (msg.method) {
      case 'initialize':
        send({
          jsonrpc: '2.0', id: msg.id,
          result: {
            protocolVersion: (msg.params && msg.params.protocolVersion) || '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'zcode-advisor-config-bridge', version: '0.2.0' }
          }
        });
        return;
      case 'tools/list':
        send({
          jsonrpc: '2.0', id: msg.id,
          result: {
            tools: [{
              name: 'advisor_config_status',
              description: '返回 zcode-advisor GUI 配置桥接状态',
              inputSchema: { type: 'object', properties: {} }
            }]
          }
        });
        return;
      case 'tools/call':
        send({
          jsonrpc: '2.0', id: msg.id,
          result: { content: [{ type: 'text', text: 'config bridge active' }] }
        });
        return;
      case 'ping':
        send({ jsonrpc: '2.0', id: msg.id, result: {} });
        return;
      default:
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
    }
  }
}

function main() {
  let result = { changed: false, file: USER_CONFIG };
  try {
    // fillMissingOnly：宿主展开的 userConfig 默认值只用于兜底，绝不覆盖用户已配置的非空值。
    result = writeUserConfig(guiValuesFromEnv(process.env), undefined, { fillMissingOnly: true });
  } catch (err) {
    try { process.stderr.write(`[advisor-bridge] 落盘失败: ${err && err.message}\n`); } catch (_) {}
  }
  if (process.env.ZCODE_ADVISOR_BRIDGE_VERBOSE === '1') {
    try { process.stderr.write(`[advisor-bridge] ${JSON.stringify(result)}\n`); } catch (_) {}
  }
  serveMcp();
}

module.exports = { guiValuesFromEnv, mergeUserConfig, writeUserConfig, USER_CONFIG };

if (require.main === module) main();
