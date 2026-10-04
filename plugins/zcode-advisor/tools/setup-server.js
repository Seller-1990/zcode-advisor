#!/usr/bin/env node
'use strict';

// zcode-advisor 本地配置面板（零依赖，双击「配置面板.cmd」即开）。
// - 表单（0.2.17）：服务商 / 审查模型 / 审查模式 / 启停 → 写入 ~/.zcode/advisor.config.json
//   端点与 key 一律来自 ZCode 已维护的第三方服务商，本面板不收集、不显示。
// - Ping：用当前表单选择实测服务商端点/认证/模型可用性（max_tokens=1 的最小请求）
// - 只监听 127.0.0.1；hook 每次调用都会重读配置，保存后下一轮审查即生效，无需重启会话。

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { writeUserConfig, removeUserConfigKeys, USER_CONFIG } = require('./config-bridge');
const { loadConfig, readZcodeProviders, findZcodeProvider, resolveProviderTarget } = require('../hooks/lib/config');
const { callReviewer } = require('../hooks/lib/reviewer');
const { readHistory } = require('../hooks/lib/history');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
// 端口解析顺序：--port= 参数 > ZCODE_ADVISOR_PANEL_PORT 环境变量 > 默认 8789
const PORT = parseInt(process.argv.find((a) => a.startsWith('--port='))?.split('=')[1], 10)
  || parseInt(process.env.ZCODE_ADVISOR_PANEL_PORT, 10)
  || 8789;

function readUserConfig() {
  try {
    return JSON.parse(fs.readFileSync(USER_CONFIG, 'utf8'));
  } catch (_) {
    return {};
  }
}

// 面板可保存的键（0.2.17 起：端点/key 不在本插件维护，只保存服务商与模型选择）。
const SAVE_STRING_KEYS = ['model', 'reviewMode', 'zcodeProvider'];

function saveUserConfig(patch) {
  const allowed = {};
  for (const k of SAVE_STRING_KEYS) {
    const v = String(patch[k] || '').trim();
    if (v) allowed[k] = v;
  }
  // 顾问总开关（新会话是否自动启用）：接受布尔与字符串形式
  if (patch.startEnabled === true || patch.startEnabled === 'true') allowed.startEnabled = true;
  else if (patch.startEnabled === false || patch.startEnabled === 'false') allowed.startEnabled = false;
  // maxTokens 必须与其余字段走**同一次** read-modify-write：早期实现把它当作补丁，
  // 在 writeUserConfig 之后再读一次文件、再写一次（两次独立 RMW + 两处重复校验），
  // 既与 config-bridge 的合并语义分叉，也留下「后写覆盖先写」的窗口（审计报告 A1）。
  if (patch.maxTokens != null) {
    const mt = parseInt(patch.maxTokens, 10);
    if (Number.isFinite(mt) && mt >= 64 && mt <= 16384) allowed.maxTokens = mt;
  }
  // 旧版残留（手动端点/key/来源）由 writeUserConfig 在写盘时统一清除（0.2.17）——
  // 这里不再重复调 removeUserConfigKeys：那是第二次读-改-写，会多占一次配置锁，
  // 且失败时状态与返回值不一致（writeUserConfig 已保证清理）。
  return writeUserConfig(allowed);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function page() {
  const cfg = readUserConfig();
  // 状态栏（0.2.17）：审查通道只走 ZCode 第三方服务商，端点/key 由 ZCode 统一维护。
  const providers = listZcodeProvidersSafe().filter((p) => p.eligible && !p.official && p.baseURL && p.apiKey);
  const selProvider = providers.find((p) => p.id === cfg.zcodeProvider) || providers[0] || null;
  const statusModel = cfg.model || (selProvider && selProvider.models[0]) || '（服务商默认）';
  const statusKey = selProvider ? '服务商 key（ZCode 维护）' : '（ZCode 里暂无可用第三方服务商）';
  const providerOpts = providers.length === 0
    ? '<option value="">（ZCode 里暂无可用第三方服务商）</option>'
    : providers.map((p) => `<option value="${esc(p.id)}"${cfg.zcodeProvider === p.id ? ' selected' : ''}>${esc(p.name || p.id)}（${p.models.length} 模型）</option>`).join('');
  const modelOpts = selProvider
    ? selProvider.models.map((m) => `<option value="${esc(m)}"${cfg.model === m ? ' selected' : ''}>${esc(m)}</option>`).join('')
    : '';
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<title>zcode-advisor 配置面板</title>
<style>
 body{font-family:"Microsoft YaHei",system-ui,sans-serif;max-width:640px;margin:24px auto;padding:0 16px 40px;color:#222;background:#f6f7f9}
 h1{font-size:18px;margin:18px 0 12px}
 .card{background:#fff;border:1px solid #e4e7ec;border-radius:10px;padding:14px 16px;margin-bottom:12px;box-shadow:0 1px 2px rgba(16,24,40,.04)}
 .card h2{font-size:14px;margin:0 0 10px;color:#111}
 label{display:block;margin:8px 0 3px;font-weight:600;font-size:13px}
 input,select{width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid #d0d5dd;border-radius:7px;font-size:13px;background:#fff}
 input:focus,select:focus{outline:none;border-color:#2563eb}
 small{color:#667085;font-size:12px} code{background:#eef2f6;padding:1px 5px;border-radius:4px;font-size:12px}
 .btnrow{margin-top:12px;display:flex;gap:8px}
 button.act{padding:8px 18px;border:0;border-radius:7px;background:#2563eb;color:#fff;font-size:13px;cursor:pointer}
 button.act.alt{background:#fff;color:#344054;border:1px solid #d0d5dd}
 button.act:disabled{opacity:.55;cursor:default}
 #msg{margin-top:10px;padding:9px 11px;border-radius:7px;display:none;white-space:pre-wrap;font-size:13px}
 .ok{background:#ecfdf3;border:1px solid #abefc6;color:#067647} .bad{background:#fef3f2;border:1px solid #fecdca;color:#b42318}
 .hintline{color:#667085;font-size:12px;margin-top:4px;word-break:break-all}
 #hist{font-size:13px;color:#344054;max-height:260px;overflow:auto}
 #hist div{margin:5px 0}
</style></head><body>
<h1>🛡️ zcode-advisor 配置面板</h1>
<div class="card"><h2>当前状态</h2>
<div style="font-size:13px">配置文件：<code>${esc(USER_CONFIG)}</code></div>
<div style="font-size:13px;margin-top:4px">服务商：<code>${esc(selProvider ? (selProvider.name || selProvider.id) : '（无）')}</code> ｜ 模型：<code>${esc(statusModel)}</code> ｜ 模式：<code>${esc(cfg.reviewMode || 'async')}</code> ｜ key：<code id="st-key">${esc(statusKey)}</code></div>
<small>保存后**下一轮审查即生效**，无需重启 ZCode；新建会话后斜杠命令（/advisor-status 等）可用。</small>
</div>
<div class="card"><h2>审查副模型</h2>
<label>启用</label>
<select id="startEnabled">
 <option value="true"${cfg.startEnabled !== false ? ' selected' : ''}>启用（新会话自动开启审查）</option>
 <option value="false"${cfg.startEnabled === false ? ' selected' : ''}>停用（新会话不开启）</option>
</select>
<label>服务商（来自 ZCode 已维护的第三方服务商）</label>
<select id="zcodeProvider">${providerOpts}</select>
<label>审查模型</label>
<select id="zcodeModel">${modelOpts || '<option value="">（该服务商未配置模型）</option>'}</select>
<div class="hintline" id="zcodeEndpoint">${selProvider ? esc(`端点：${selProvider.baseURL || '（该服务商未配置 baseURL）'}`) : '先在 ZCode 设置里添加 OpenAI 兼容服务商（官方内置通道不用于审查）'}</div>
<label>审查模式</label>
<select id="reviewMode">
 <option value="async"${(cfg.reviewMode || 'async') === 'async' ? ' selected' : ''}>async（默认：零体感延迟，意见随下一条消息送达）</option>
 <option value="sync"${cfg.reviewMode === 'sync' ? ' selected' : ''}>sync（当轮打断：concern/blocker 立即送达，每轮收尾等待审查）</option>
</select>
<label>max_tokens（引擎默认 4096；越界会被钳到 64–16384）</label>
<input id="maxTokens" type="number" min="64" max="16384" value="${cfg.maxTokens || 4096}">
<div class="btnrow">
 <button class="act" onclick="save()">保存配置</button>
 <button class="act alt" onclick="ping()">Ping 测试（验证服务商与模型）</button>
</div>
<small class="hintline">端点与 key 由 ZCode 服务商统一维护（本插件不单独保存，也不显示明文）；会话级临时换服务商/模型用 ZCode 角标面板或 /advisor-model。</small>
<div id="msg"></div>
</div>
<div class="card"><h2>📜 顾问意见记录（最近 50 条）</h2>
<div id="hist">载入中…</div>
<script>
// 自带请求函数且走 GET：服务端 /api/history 只收 GET（POST 会 404），
// 且本 IIFE 先于底部主脚本执行，引用主脚本的 post 会 ReferenceError（实测截图抓到）
// ⚠️ 本段在**浏览器**里执行：服务端那个 esc() 属 Node 作用域，在这里**不存在**。
// 历史行是拼 innerHTML 的，必须自带转义函数——曾直接调 esc() 导致 ReferenceError，
// 整个历史区渲染失败、只显示"读取失败"。本页能改写配置，不可给注入留口。
const esc=(v)=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
(async()=>{
  const getJSON=async(url)=>{const r=await fetch(url);return r.json();};
  try{
    const r=await getJSON('/api/history');
    const items=(r&&r.ok&&Array.isArray(r.history))?r.history:[];
    if(items.length===0){document.getElementById('hist').textContent='暂无记录——顾问意见产生后会出现在这里';return;}
    document.getElementById('hist').innerHTML=items.map(it=>{
      const ts=String(it.ts||'').replace('T',' ').slice(5,16);
      const sev=it.severity||it.event||'-';
      // 历史行来自本机 JSONL（无枚举校验），ts/sev 必须转义后才能拼 innerHTML
      //（note 一直走 textContent）。本页能改写配置，不可给注入留口。
      return '<div><b>'+esc(ts)+'</b> ['+esc(sev)+'] <span></span></div>';
    }).join('');
    const spans=document.querySelectorAll('#hist span');
    items.forEach((it,i)=>{ if(spans[i]) spans[i].textContent=String(it.note||(it.event==='delivered'?('已送达 '+(it.count||'')+' 条意见'):it.event||'')).slice(0,200); });
  }catch(e){document.getElementById('hist').textContent='读取失败：'+e;}
})();
</script>
</div>
<div class="card"><h2>说明</h2>
<small>保存写入用户级配置文件（跨插件升级保留，不在任何 git 仓库内）。审查在每轮结束时由后台进程进行；
意见以 <code>[advisor:concern] …</code> 形式随你的下一条消息送达。状态查看请在 ZCode 会话内运行
<code>/advisor-status</code>；斜杠命令与注册行只在新会话中注册。</small>
</div>
<script>
const $=id=>document.getElementById(id);
function msg(t,ok){const m=$('msg');m.textContent=t;m.style.display='block';m.className=ok?'ok':'bad';}
async function post(url,body){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});return r.json();}
$('zcodeProvider').addEventListener('change',async()=>{
 // 服务商切换：从服务端取该服务商的模型清单与端点提示（apiKey 不出进程）
 const r=await post('/api/zcode-models',{providerId:$('zcodeProvider').value});
 const sel=$('zcodeModel');sel.innerHTML='';
 for(const m of (r&&r.ok&&Array.isArray(r.models))?r.models:[]){const o=document.createElement('option');o.value=m;o.textContent=m;sel.appendChild(o);}
 if(!sel.children.length){const o=document.createElement('option');o.value='';o.textContent='（该服务商未配置模型）';sel.appendChild(o);}
 $('zcodeEndpoint').textContent=(r&&r.ok)?('端点：'+(r.baseURL||'（该服务商未配置 baseURL）')):'服务商读取失败';
});
function formBody(){
 const body={startEnabled:$('startEnabled').value==='true'};
 if($('zcodeProvider').value)body.zcodeProvider=$('zcodeProvider').value;
 if($('zcodeModel').value)body.model=$('zcodeModel').value;
 const rm=$('reviewMode').value.trim();if(rm)body.reviewMode=rm;
 const mt=parseInt($('maxTokens').value,10);if(Number.isFinite(mt))body.maxTokens=mt;
 return body;
}
async function save(){
 const r=await post('/api/save',formBody());
 msg(r.ok?('已保存：'+r.file+'（下一轮审查生效）'):('保存失败：'+r.error),r.ok);
}
async function ping(){
 msg('Ping 中…',true);
 const r=await post('/api/ping',formBody());
 msg(r.ok?('Ping OK（'+r.ms+'ms）— 服务商端点可达、认证与模型有效'+(r.note||'')):('Ping 失败 → '+r.error+(r.hint?('：'+r.hint):'')),r.ok);
}
</script></body></html>`;
}

// 服务端渲染用：provider 清单（不含 apiKey 明文）。读失败按空处理。
function listZcodeProvidersSafe() {
  try { return readZcodeProviders(process.env); } catch (_) { return []; }
}

function hint(err) {
  if (String(err).startsWith('llm_http_401') || String(err).startsWith('llm_http_403')) return 'key 无效或无权限';
  if (String(err).startsWith('llm_http_404') || String(err).startsWith('llm_http_400')) return '模型 id 或端点路径不对，换个模型再试';
  if (err === 'llm_timeout') return '端点无响应（超时）';
  if (err === 'llm_error') return '网络失败，检查端点可达性';
  return '';
}

async function ping(body) {
  // 与审查侧同一解析规则：端点/key 只来自 ZCode 第三方服务商（非官方、OpenAI 兼容、齐备），
  // 表单里改了服务商/模型还没保存时优先用表单值，未给则回退已存配置。
  const envLike = Object.assign({}, process.env);
  const cfg = loadConfig(PLUGIN_ROOT, envLike);
  const wantProvider = String(body.zcodeProvider || cfg.zcodeProvider || '').trim();
  const wantModel = String(body.model || cfg.model || '').trim();
  const t = resolveProviderTarget(readZcodeProviders(envLike), wantProvider, wantModel);
  if (!t.ok) {
    const hints = {
      zcode_provider_missing: 'ZCode 里没有可用的第三方服务商（需 OpenAI 兼容且已填端点与 key）',
      zcode_provider_not_found: 'ZCode 配置里找不到所选服务商，请刷新页面后重新选择',
      zcode_provider_official: 'ZCode 官方内置通道不用于审查，请选择第三方服务商',
      zcode_provider_ineligible: '该服务商协议非 OpenAI 兼容，审查通道不可用',
      zcode_provider_incomplete: '服务商的端点/key 缺一，Ping 已中止',
      zcode_no_model: '该服务商未登记模型，请在 ZCode 设置里添加'
    };
    return { ok: false, error: t.problem.split(':')[0], hint: hints[t.problem.split(':')[0]] || t.problem };
  }
  const t0 = Date.now();
  const res = await callReviewer({
    baseUrl: t.baseUrl, model: t.model, apiKey: t.apiKey,
    systemPrompt: 'You are a health check.',
    userContent: 'ping',
    maxTokens: 1,
    temperature: 0,
    timeoutMs: 20000
  });
  if (!res.error || res.error === 'llm_empty_response') {
    return { ok: true, ms: Date.now() - t0, provider: t.provider.name || t.provider.id, model: t.model, note: res.error === 'llm_empty_response' ? '；响应体为空是 max_tokens=1 下的正常现象' : '' };
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
        // 锁超时必须以失败态呈现：fillMissingOnly/覆盖语义都不会「下次再补」，
        // 静默 ok:true 会让用户以为存上了（配置 panel 前端按 ok 分红绿条）。
        if (r.lockTimeout) {
          send(503, { ok: false, error: '配置文件正被其他进程写入，请等几秒重试；若持续出现，删除 ~/.zcode/advisor.config.json.lock 后再试' });
          return;
        }
        send(200, { ok: true, file: r.file });
      } catch (err) {
        send(500, { ok: false, error: String(err).slice(0, 200) });
      }
    });
    return;
  }
  // 清除历史遗留的手动 apiKey（0.2.17 起本插件不再维护 key；保留此端点用于清理旧配置残留）。
  // 注意：页面上**没有**对应按钮（0.2.17 已移除「清除 key」UI），这是有意保留的无 UI 端点——
  // 升级用户盘上可能还有 0.2.16 写入的明文 key，脚本/curl 可一键清掉；幂等、且只删这一个键。
  if (req.method === 'POST' && req.url === '/api/clear-key') {
    if (!isLocalRequest(req)) { send(403, { ok: false, error: '非本机来源，已拒绝' }); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        let parsed;
        try {
          parsed = JSON.parse(body || '{}');
        } catch (err) {
          send(400, { ok: false, error: '请求体不是合法 JSON：' + String(err).slice(0, 160) });
          return;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          send(400, { ok: false, error: '请求体必须是 JSON 对象' });
          return;
        }
        const r = removeUserConfigKeys(['apiKey'], USER_CONFIG);
        if (r.error) { send(400, { ok: false, error: r.error }); return; }
        if (r.lockTimeout) {
          send(503, { ok: false, lockTimeout: true, error: '配置文件正被其他进程写入，请等几秒重试' });
          return;
        }
        send(200, { ok: true, removed: r.removed });
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
  // 指定服务商的模型清单与端点（页面切换服务商时用；只回传模型 id/baseURL，不含 apiKey）
  if (req.method === 'POST' && req.url === '/api/zcode-models') {
    if (!isLocalRequest(req)) { send(403, { ok: false, error: '非本机来源，已拒绝' }); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        const p = JSON.parse(body || '{}');
        const prov = findZcodeProvider(listZcodeProvidersSafe(), p.providerId);
        if (!prov || !prov.eligible) { send(200, { ok: false, error: 'provider_missing' }); return; }
        send(200, { ok: true, models: prov.models, baseURL: prov.baseURL, name: prov.name });
      } catch (err) {
        send(500, { ok: false, error: String(err).slice(0, 200) });
      }
    });
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
