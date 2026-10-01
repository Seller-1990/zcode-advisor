#!/usr/bin/env node
'use strict';

// config-bridge：随会话启动的 MCP 桥接进程。
// 作用：把插件设置页（plugin.json userConfig 表单）里保存的值落盘到用户级配置
// ~/.zcode/advisor.config.json——这样 hook（读不到 user_config 环境变量）也能用上 GUI 配置。
// 纪律：
// - 只合并非空值，绝不覆盖用户在配置面板/其他途径写入的其他字段；
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

// 合并策略：GUI 非空值覆盖同名键，其余既有字段原样保留；原子写。
function mergeUserConfig(existingRaw, guiValues) {
  let base = {};
  if (existingRaw && typeof existingRaw === 'object' && !Array.isArray(existingRaw)) {
    base = existingRaw;
  }
  return Object.assign({}, base, guiValues);
}

function writeUserConfig(guiValues, file) {
  const target = file || USER_CONFIG;
  if (Object.keys(guiValues).length === 0) return { changed: false, file: target };
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (_) {}
  const merged = mergeUserConfig(existing, guiValues);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8');
  fs.renameSync(tmp, target);
  return { changed: true, file: target, keys: Object.keys(guiValues) };
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
    result = writeUserConfig(guiValuesFromEnv(process.env));
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
