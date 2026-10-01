#!/usr/bin/env node
'use strict';

// zcode-advisor 本地配置面板（零依赖，双击「配置面板.cmd」即开）。
// - 表单：API key / 审查模型 / 端点 / 审查模式 → 写入用户级配置 ~/.zcode/advisor.config.json
// - Ping：用当前表单值实测端点/认证/模型可用性（max_tokens=1 的最小请求）
// - 只监听 127.0.0.1；hook 每次调用都会重读配置，保存后下一轮审查即生效，无需重启会话。

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { writeUserConfig, USER_CONFIG } = require('./config-bridge');
const { loadConfig, resolveApiKey, gate, configWarnings, maskKey, isPlaceholderKey } = require('../hooks/lib/config');
const { callReviewer } = require('../hooks/lib/reviewer');
const { readHistory } = require('../hooks/lib/history');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
// 端口解析顺序：--port= 参数 > ZCODE_ADVISOR_PANEL_PORT 环境变量 > 默认 8789
const PORT = parseInt(process.argv.find((a) => a.startsWith('--port='))?.split('=')[1], 10)
  || parseInt(process.env.ZCODE_ADVISOR_PANEL_PORT, 10)
  || 8789;
const MODEL_SUGGESTIONS = ['glm-5.3-flash', 'glm-5.3'];

function readUserConfig() {
  try {
    return JSON.parse(fs.readFileSync(USER_CONFIG, 'utf8'));
  } catch (_) {
    return {};
  }
}

function saveUserConfig(patch) {
  const allowed = {};
  for (const k of ['apiKey', 'model', 'baseUrl', 'reviewMode']) {
    const v = String(patch[k] || '').trim();
    if (v && !isPlaceholderKey(v)) allowed[k] = v;
  }
  // maxTokens 必须与其余字段走**同一次** read-modify-write：早期实现把它当作补丁，
  // 在 writeUserConfig 之后再读一次文件、再写一次（两次独立 RMW + 两处重复校验），
  // 既与 config-bridge 的合并语义分叉，也留下「后写覆盖先写」的窗口（审计报告 A1）。
  if (patch.maxTokens != null) {
    const mt = parseInt(patch.maxTokens, 10);
    if (Number.isFinite(mt) && mt >= 64 && mt <= 16384) allowed.maxTokens = mt;
  }
  return writeUserConfig(allowed);
}

function page() {
  const cfg = readUserConfig();
  const keyMasked = cfg.apiKey ? maskKey(cfg.apiKey) : '（未设置）';
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<title>zcode-advisor 配置面板</title>
<style>
 body{font-family:"Microsoft YaHei",system-ui,sans-serif;max-width:720px;margin:32px auto;padding:0 16px;color:#222}
 h1{font-size:20px} fieldset{border:1px solid #ddd;border-radius:8px;margin-bottom:16px;padding:12px 16px}
 label{display:block;margin:10px 0 4px;font-weight:600} input,select{width:100%;box-sizing:border-box;padding:8px;border:1px solid #ccc;border-radius:6px;font-size:14px}
 button{padding:8px 18px;margin:12px 8px 0 0;border:0;border-radius:6px;background:#2563eb;color:#fff;font-size:14px;cursor:pointer}
 button.alt{background:#64748b} #msg{margin-top:12px;padding:10px;border-radius:6px;display:none;white-space:pre-wrap}
 .ok{background:#ecfdf5;border:1px solid #a7f3d0} .bad{background:#fef2f2;border:1px solid #fecaca}
 small{color:#666} code{background:#f1f5f9;padding:1px 5px;border-radius:4px}
</style></head><body>
<h1>zcode-advisor 配置面板</h1>
<fieldset><legend>当前状态</legend>
<div>配置文件：<code>${USER_CONFIG}</code></div>
<div>API key：<code>${keyMasked}</code> ｜ 模型：<code>${cfg.model || '（默认 glm-5.3-flash）'}</code> ｜ 模式：<code>${cfg.reviewMode || 'async'}</code></div>
<small>保存后**下一轮审查即生效**，无需重启 ZCode；新建会话后斜杠命令（/advisor-status 等）可用。</small>
</fieldset>
<fieldset><legend>审查副模型配置</legend>
<label>API key（智谱 BigModel / Z.ai）</label>
<input id="apiKey" placeholder="留空 = 不修改已保存的 key">
<label>审查模型</label>
<input id="model" list="models" value="${cfg.model || 'glm-5.3-flash'}">
<datalist id="models">${MODEL_SUGGESTIONS.map((m) => `<option value="${m}">`).join('')}</datalist>
<small>建议与主对话模型形成能力差；思考型模型请把高级设置里的 max_tokens 提到 4096</small>
<label>端点（OpenAI 兼容，一般不用改）</label>
<input id="baseUrl" value="${cfg.baseUrl || 'https://open.bigmodel.cn/api/paas/v4/chat/completions'}">
<label>审查模式</label>
<select id="reviewMode">
 <option value="async"${(cfg.reviewMode || 'async') === 'async' ? ' selected' : ''}>async（默认：零体感延迟，意见随下一条消息送达）</option>
 <option value="sync"${cfg.reviewMode === 'sync' ? ' selected' : ''}>sync（当轮打断：concern/blocker 立即送达，每轮收尾等待审查）</option>
</select>
<label style="margin-top:14px">max_tokens（高级，默认 2048；思考型模型建议 4096）</label>
<input id="maxTokens" type="number" min="64" max="16384" value="${cfg.maxTokens || 2048}">
<button onclick="save()">保存配置</button>
<button class="alt" onclick="ping()">Ping 测试（验证 key 与模型）</button>
<div id="msg"></div>
</fieldset>
<fieldset><legend>📜 顾问意见记录（最近 50 条）</legend>
<div id="hist" style="font-size:13px;color:#444">载入中…</div>
<script>
(async()=>{
  try{
    const r=await post('/api/history',{});
    const items=(r&&r.ok&&Array.isArray(r.history))?r.history:[];
    if(items.length===0){document.getElementById('hist').textContent='暂无记录——顾问意见产生后会出现在这里';return;}
    document.getElementById('hist').innerHTML=items.map(it=>{
      const ts=String(it.ts||'').replace('T',' ').slice(5,16);
      const sev=it.severity||it.event||'-';
      const note=String(it.note||(it.event==='delivered'?('已送达 '+(it.count||'')+' 条意见'):it.event||'')).slice(0,200);
      return '<div style="margin:6px 0"><b>'+ts+'</b> ['+sev+'] <span></span></div>';
    }).join('');
    const spans=document.querySelectorAll('#hist span');
    items.forEach((it,i)=>{ if(spans[i]) spans[i].textContent=String(it.note||(it.event==='delivered'?('已送达 '+(it.count||'')+' 条意见'):it.event||'')).slice(0,200); });
  }catch(e){document.getElementById('hist').textContent='读取失败：'+e;}
})();
</script>
</fieldset>
<fieldset><legend>说明</legend>
<small>保存写入用户级配置文件（跨插件升级保留，不在任何 git 仓库内）。审查在每轮结束时由后台进程进行；
意见以 <code>[advisor:concern] …</code> 形式随你的下一条消息送达。状态查看请在 ZCode 会话内运行
<code>/advisor-status</code>；斜杠命令与注册行只在新会话中注册。</small>
</fieldset>
<script>
const $=id=>document.getElementById(id);
function msg(t,ok){const m=$('msg');m.textContent=t;m.style.display='block';m.className=ok?'ok':'bad';}
async function post(url,body){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});return r.json();}
async function save(){
 const body={};for(const k of['apiKey','model','baseUrl','reviewMode']){const v=$(k).value.trim();if(v)body[k]=v;}
 const mt=parseInt($('maxTokens').value,10);if(Number.isFinite(mt))body.maxTokens=mt;
 const r=await post('/api/save',body);msg(r.ok?('已保存：'+r.file+'（下一轮审查生效）'):('保存失败：'+r.error),r.ok);
}
async function ping(){
 msg('Ping 中…',true);
 const body={};for(const k of['apiKey','model','baseUrl']){const v=$(k).value.trim();if(v)body[k]=v;}
 const r=await post('/api/ping',body);
 msg(r.ok?('Ping OK（'+r.ms+'ms）— 端点可达、认证与模型有效'+(r.note||'')):('Ping 失败 → '+r.error+(r.hint?('：'+r.hint):'')),r.ok);
}
</script></body></html>`;
}

function hint(err) {
  if (String(err).startsWith('llm_http_401') || String(err).startsWith('llm_http_403')) return 'key 无效或无权限';
  if (String(err).startsWith('llm_http_404') || String(err).startsWith('llm_http_400')) return '模型 id 或端点路径不对，换个模型再试';
  if (err === 'llm_timeout') return '端点无响应（超时）';
  if (err === 'llm_error') return '网络失败，检查端点可达性';
  return '';
}

async function ping(body) {
  const envLike = Object.assign({}, process.env);
  const cfg = loadConfig(PLUGIN_ROOT, envLike);
  const model = body.model || cfg.model;
  const baseUrl = body.baseUrl || cfg.baseUrl;
  const apiKey = body.apiKey || cfg.apiKey;
  const t0 = Date.now();
  const res = await callReviewer({
    baseUrl, model, apiKey,
    systemPrompt: 'You are a health check.',
    userContent: 'ping',
    maxTokens: 1,
    temperature: 0,
    timeoutMs: 20000
  });
  if (!res.error || res.error === 'llm_empty_response') {
    return { ok: true, ms: Date.now() - t0, note: res.error === 'llm_empty_response' ? '；响应体为空是 max_tokens=1 下的正常现象' : '' };
  }
  return { ok: false, error: res.error, detail: res.detail, hint: hint(res.error) };
}

// CSRF/DNS-rebinding 防护：写接口只接受本机来源。
// - Host 必须是回环地址：DNS rebinding 会把 Host 换成攻击者域名 → 拒绝；
// - 浏览器跨源请求必带 Origin（text/plain 简单请求免预检也会带上），非回环来源一律拒绝——
//   否则恶意网页可静默 POST /api/save 改写 baseUrl/apiKey，下轮审查会把对话增量外传；
// - curl 等本机工具不带 Origin，不受影响；端口可变（EADDRINUSE 重试），只比对主机名。
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
function isLocalRequest(req) {
  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return LOOPBACK_HOSTS.has(new URL(String(origin)).hostname.toLowerCase());
  } catch (_) {
    return false;
  }
}

const server = http.createServer((req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page());
    return;
  }
  if (req.method === 'POST' && req.url === '/api/save') {
    if (!isLocalRequest(req)) { send(403, { ok: false, error: '非本机来源，已拒绝' }); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        const patch = JSON.parse(body || '{}');
        const r = saveUserConfig(patch);
        send(200, { ok: true, file: r.file });
      } catch (err) {
        send(500, { ok: false, error: String(err).slice(0, 200) });
      }
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/api/history') {
    send(200, { ok: true, history: readHistory(50), file: require('../hooks/lib/history').HISTORY_FILE });
    return;
  }
  if (req.method === 'POST' && req.url === '/api/ping') {
    if (!isLocalRequest(req)) { send(403, { ok: false, error: '非本机来源，已拒绝' }); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { ping(JSON.parse(body || '{}')).then((r) => send(200, r)).catch((e) => send(500, { ok: false, error: String(e).slice(0, 200) })); }
      catch (err) { send(500, { ok: false, error: String(err).slice(0, 200) }); }
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    const next = PORT + 1;
    if (next <= PORT + 10) {
      process.env.__RETRY__ = '1';
      process.stdout.write(`端口 ${PORT} 被占用，改用 ${next}…\n`);
      server.listen(next, '127.0.0.1');
      return;
    }
  }
  process.stderr.write(`[advisor-panel] ${err && err.message}\n`);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  // 端口重试后实际端口以 address() 为准
  const actual = server.address().port;
  const url = `http://127.0.0.1:${actual}/`;
  process.stdout.write(`zcode-advisor 配置面板已启动：${url}（Ctrl+C 退出）\n`);
  if (process.env.ZCODE_ADVISOR_PANEL_NO_OPEN === '1' || process.env.NODE_ENV === 'test') return;
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else {
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(opener, [url], { detached: true, stdio: 'ignore' }).unref();
  }
});

// 导出真实 server 实例（require 即开始监听；测试用其 close/closeAllConnections 释放）
module.exports = server;
