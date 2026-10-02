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
<<<<<<< HEAD
const { writeUserConfig, USER_CONFIG } = require('./config-bridge');
const { loadConfig, resolveApiKey, gate, configWarnings, maskKey, isPlaceholderKey, readZcodeProviders, findZcodeProvider } = require('../hooks/lib/config');
=======
const { writeUserConfig, removeUserConfigKeys, USER_CONFIG } = require('./config-bridge');
const { loadConfig, resolveApiKey, gate, configWarnings, maskKey, isPlaceholderKey } = require('../hooks/lib/config');
>>>>>>> origin/main
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

// 面板可保存的字符串键。apiSource 单独校验（只认 manual/zcode）。
const SAVE_STRING_KEYS = ['apiKey', 'model', 'baseUrl', 'reviewMode', 'zcodeProvider', 'zcodeModel'];

function saveUserConfig(patch) {
  const allowed = {};
  for (const k of SAVE_STRING_KEYS) {
    const v = String(patch[k] || '').trim();
    // 占位符判定只针对 apiKey：isPlaceholderKey 会丢弃含中文或 test*/your* 开头的值，
    // 那对服务商 id / 模型名 / 端点是合法内容（中文 provider 名还能被 findZcodeProvider 按 name 命中）。
    const placeholder = k === 'apiKey' && isPlaceholderKey(v);
    if (v && !placeholder) allowed[k] = v;
  }
  const src = String(patch.apiSource || '').trim().toLowerCase();
  if (src === 'manual' || src === 'zcode') allowed.apiSource = src;
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
  return writeUserConfig(allowed);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function page() {
  const cfg = readUserConfig();
  const keyMasked = cfg.apiKey ? maskKey(cfg.apiKey) : '（未设置）';
  const src = cfg.apiSource === 'zcode' ? 'zcode' : 'manual';
  // 状态栏按来源展示实际生效值：zcode 模式下审查走服务商端点/key，
  // 显示手动 key 的掩码（常为「未设置」）会误导用户以为没配好。
  let statusKey = keyMasked;
  let statusModel = cfg.model || '（默认 glm-5.3-flash）';
  if (src === 'zcode') {
    const prov = findZcodeProvider(listZcodeProvidersSafe(), cfg.zcodeProvider);
    statusKey = prov && prov.apiKey ? '服务商 key' : '（服务商未配置 key）';
    statusModel = cfg.zcodeModel || (prov && prov.models && prov.models[0]) || '（服务商默认）';
  }
  // 服务商下拉在服务端直接渲染（页面打开即可见，无需额外请求）
  const providers = listZcodeProvidersSafe();
  const eligible = providers.filter((p) => p.eligible);
  const providerOpts = eligible.length === 0
    ? '<option value="">（ZCode 里暂无 OpenAI 兼容服务商）</option>'
    : eligible.map((p) => `<option value="${esc(p.id)}"${cfg.zcodeProvider === p.id ? ' selected' : ''}>${esc(p.name || p.id)}（${p.models.length} 模型）</option>`).join('');
  const selProvider = eligible.find((p) => p.id === cfg.zcodeProvider) || eligible[0] || null;
  const modelOpts = selProvider
    ? selProvider.models.map((m) => `<option value="${esc(m)}"${cfg.zcodeModel === m ? ' selected' : ''}>${esc(m)}</option>`).join('')
    : '';
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<title>zcode-advisor 配置面板</title>
<style>
<<<<<<< HEAD
 body{font-family:"Microsoft YaHei",system-ui,sans-serif;max-width:640px;margin:24px auto;padding:0 16px 40px;color:#222;background:#f6f7f9}
 h1{font-size:18px;margin:18px 0 12px}
 .card{background:#fff;border:1px solid #e4e7ec;border-radius:10px;padding:14px 16px;margin-bottom:12px;box-shadow:0 1px 2px rgba(16,24,40,.04)}
 .card h2{font-size:14px;margin:0 0 10px;color:#111}
 label{display:block;margin:8px 0 3px;font-weight:600;font-size:13px}
 input,select{width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid #d0d5dd;border-radius:7px;font-size:13px;background:#fff}
 input:focus,select:focus{outline:none;border-color:#2563eb}
 .seg{display:flex;gap:0;border:1px solid #d0d5dd;border-radius:8px;overflow:hidden;width:fit-content;margin-top:2px}
 .seg button{padding:7px 16px;border:0;background:#fff;color:#475467;font-size:13px;cursor:pointer}
 .seg button.on{background:#2563eb;color:#fff}
 small{color:#667085;font-size:12px} code{background:#eef2f6;padding:1px 5px;border-radius:4px;font-size:12px}
 .btnrow{margin-top:12px;display:flex;gap:8px}
 button.act{padding:8px 18px;border:0;border-radius:7px;background:#2563eb;color:#fff;font-size:13px;cursor:pointer}
 button.act.alt{background:#fff;color:#344054;border:1px solid #d0d5dd}
 #msg{margin-top:10px;padding:9px 11px;border-radius:7px;display:none;white-space:pre-wrap;font-size:13px}
 .ok{background:#ecfdf3;border:1px solid #abefc6;color:#067647} .bad{background:#fef3f2;border:1px solid #fecdca;color:#b42318}
 .hintline{color:#667085;font-size:12px;margin-top:4px;word-break:break-all}
 #hist{font-size:13px;color:#344054;max-height:260px;overflow:auto}
 #hist div{margin:5px 0}
</style></head><body>
<h1>🛡️ zcode-advisor 配置面板</h1>
<div class="card"><h2>当前状态</h2>
<div style="font-size:13px">配置文件：<code>${esc(USER_CONFIG)}</code></div>
<div style="font-size:13px;margin-top:4px">API key：<code>${esc(statusKey)}</code> ｜ 模型：<code>${esc(statusModel)}</code> ｜ 模式：<code>${esc(cfg.reviewMode || 'async')}</code> ｜ 来源：<code>${src === 'zcode' ? 'ZCode 已维护' : '手动维护'}</code></div>
=======
 body{font-family:"Microsoft YaHei",system-ui,sans-serif;max-width:720px;margin:32px auto;padding:0 16px;color:#222}
 h1{font-size:20px} fieldset{border:1px solid #ddd;border-radius:8px;margin-bottom:16px;padding:12px 16px}
 label{display:block;margin:10px 0 4px;font-weight:600} input,select{width:100%;box-sizing:border-box;padding:8px;border:1px solid #ccc;border-radius:6px;font-size:14px}
 button{padding:8px 18px;margin:12px 8px 0 0;border:0;border-radius:6px;background:#2563eb;color:#fff;font-size:14px;cursor:pointer}
 button.alt{background:#64748b} button.danger{background:#fff;color:#b91c1c;box-shadow:inset 0 0 0 1px #fca5a5}
 #msg{margin-top:12px;padding:10px;border-radius:6px;display:none;white-space:pre-wrap}
 .ok{background:#ecfdf5;border:1px solid #a7f3d0} .bad{background:#fef2f2;border:1px solid #fecaca}
 small{color:#666} code{background:#f1f5f9;padding:1px 5px;border-radius:4px}
</style></head><body>
<h1>zcode-advisor 配置面板</h1>
<fieldset><legend>当前状态</legend>
<div>配置文件：<code>${USER_CONFIG}</code></div>
<div>API key：<code id="st-key">${keyMasked}</code> ｜ 模型：<code>${cfg.model || '（默认 glm-5.3-flash）'}</code> ｜ 模式：<code>${cfg.reviewMode || 'async'}</code></div>
>>>>>>> origin/main
<small>保存后**下一轮审查即生效**，无需重启 ZCode；新建会话后斜杠命令（/advisor-status 等）可用。</small>
</div>
<div class="card"><h2>审查副模型</h2>
<label>启用</label>
<select id="startEnabled">
 <option value="true"${cfg.startEnabled !== false ? ' selected' : ''}>启用（新会话自动开启审查）</option>
 <option value="false"${cfg.startEnabled === false ? ' selected' : ''}>停用（新会话不开启）</option>
</select>
<label>API 来源</label>
<div class="seg">
 <button type="button" id="src-zcode"${src === 'zcode' ? ' class="on"' : ''}>ZCode 已维护</button>
 <button type="button" id="src-manual"${src === 'manual' ? ' class="on"' : ''}>手动维护</button>
</div>
<small>「ZCode 已维护」= 直接使用 ZCode 设置里配置的第三方 API（服务商 + 模型），改 ZCode 设置无需同步本插件；「手动维护」= 用下面单独填写的端点 / key / 模型。</small>
<div id="zcodeSec" style="display:${src === 'zcode' ? 'block' : 'none'}">
 <label>服务商</label>
 <select id="zcodeProvider">${providerOpts}</select>
 <label>模型</label>
 <select id="zcodeModel">${modelOpts || '<option value="">（该服务商未配置模型）</option>'}</select>
 <div class="hintline" id="zcodeEndpoint">${selProvider ? esc(`端点：${selProvider.baseURL || '（该服务商未配置 baseURL）'}`) : '先在 ZCode 设置里添加 OpenAI 兼容服务商'}</div>
</div>
<div id="manualSec" style="display:${src === 'manual' ? 'block' : 'none'}">
 <label>API key（智谱 BigModel / Z.ai 或第三方）</label>
 <input id="apiKey" placeholder="留空 = 不修改已保存的 key">
 <label>审查模型</label>
 <input id="model" list="models" value="${esc(cfg.model || 'glm-5.3-flash')}">
 <datalist id="models">${MODEL_SUGGESTIONS.map((m) => `<option value="${m}">`).join('')}</datalist>
 <small>建议与主对话模型形成能力差；思考型模型请把 max_tokens 提到 4096</small>
 <label>端点（OpenAI 兼容）</label>
 <input id="baseUrl" value="${esc(cfg.baseUrl || 'https://open.bigmodel.cn/api/paas/v4/chat/completions')}">
</div>
<label>审查模式</label>
<select id="reviewMode">
 <option value="async"${(cfg.reviewMode || 'async') === 'async' ? ' selected' : ''}>async（默认：零体感延迟，意见随下一条消息送达）</option>
 <option value="sync"${cfg.reviewMode === 'sync' ? ' selected' : ''}>sync（当轮打断：concern/blocker 立即送达，每轮收尾等待审查）</option>
</select>
<label>max_tokens（引擎默认 4096；越界会被钳到 64–16384）</label>
<input id="maxTokens" type="number" min="64" max="16384" value="${cfg.maxTokens || 4096}">
<<<<<<< HEAD
<div class="btnrow">
 <button class="act" onclick="save()">保存配置</button>
 <button class="act alt" onclick="ping()">Ping 测试（验证 key 与模型）</button>
</div>
=======
<button onclick="save()">保存配置</button>
<button class="alt" onclick="ping()">Ping 测试（验证 key 与模型）</button>
<button class="danger" id="clearBtn" onclick="clearKey()">清除 API key</button>
<small>清除只移除本机配置文件里的 key；要作废已泄露的 key 请到智谱/Z.ai 控制台吊销。</small>
>>>>>>> origin/main
<div id="msg"></div>
</div>
<div class="card"><h2>📜 顾问意见记录（最近 50 条）</h2>
<div id="hist">载入中…</div>
<script>
// 自带请求函数且走 GET：服务端 /api/history 只收 GET（POST 会 404），
// 且本 IIFE 先于底部主脚本执行，引用主脚本的 post 会 ReferenceError（实测截图抓到）
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
      //（note 一直走 textContent）。本页能改写 baseUrl/apiKey，不可给注入留口。
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
let apiSource='${src}';
function msg(t,ok){const m=$('msg');m.textContent=t;m.style.display='block';m.className=ok?'ok':'bad';}
async function post(url,body){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});return r.json();}
function setSource(s){
 apiSource=s;
 $('src-zcode').className=s==='zcode'?'on':'';
 $('src-manual').className=s==='manual'?'on':'';
 $('zcodeSec').style.display=s==='zcode'?'block':'none';
 $('manualSec').style.display=s==='manual'?'block':'none';
}
$('src-zcode').onclick=()=>setSource('zcode');
$('src-manual').onclick=()=>setSource('manual');
$('zcodeProvider').addEventListener('change',async()=>{
 // 服务商切换：从服务端取该服务商的模型清单与端点提示（apiKey 不出进程）
 const r=await post('/api/zcode-models',{providerId:$('zcodeProvider').value});
 const sel=$('zcodeModel');sel.innerHTML='';
 for(const m of (r&&r.ok&&Array.isArray(r.models))?r.models:[]){const o=document.createElement('option');o.value=m;o.textContent=m;sel.appendChild(o);}
 if(!sel.children.length){const o=document.createElement('option');o.value='';o.textContent='（该服务商未配置模型）';sel.appendChild(o);}
 $('zcodeEndpoint').textContent=(r&&r.ok)?('端点：'+(r.baseURL||'（该服务商未配置 baseURL）')):'服务商读取失败';
});
function formBody(){
 const body={apiSource,startEnabled:$('startEnabled').value==='true'};
 if(apiSource==='zcode'){
  if($('zcodeProvider').value)body.zcodeProvider=$('zcodeProvider').value;
  if($('zcodeModel').value)body.zcodeModel=$('zcodeModel').value;
 }else{
  for(const k of['apiKey','model','baseUrl']){const v=$(k).value.trim();if(v)body[k]=v;}
 }
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
 msg(r.ok?('Ping OK（'+r.ms+'ms）— 端点可达、认证与模型有效'+(r.note||'')):('Ping 失败 → '+r.error+(r.hint?('：'+r.hint):'')),r.ok);
}
async function clearKey(){
 if(!confirm('确定清除已保存的 API key？\\n清除后顾问将无 key 可用（状态显示 missing:apiKey，静默跳过审查）。\\n如 key 已泄露，清除本地副本不等于作废——请到智谱/Z.ai 控制台吊销。'))return;
 const btn=$('clearBtn');btn.disabled=true;
 try{
  const r=await post('/api/clear-key',{});
  const cleared=r.ok&&r.removed&&r.removed.length;
  // 只有真删了才把状态行置为未设置：env key（ZCODE_ADVISOR_API_KEY 等）不在配置文件里，
  // 清除不影响它——无差别写「未设置」会让用户以为 env key 也没了，而审查/Ping 其实照常。
  msg(r.ok?(cleared?('已清除 API key（'+r.removed.join('、')+'）；若环境变量仍配了 key，审查与 Ping 仍会成功'):'配置里没有已保存的 API key（环境变量 key 不受影响）'):(r.lockTimeout?'清除失败：配置文件正被其他进程写入，请稍后重试':('清除失败：'+r.error)),r.ok);
  if(cleared)$('st-key').textContent='（未设置）';
 }catch(e){msg('清除失败：'+e,false);}finally{btn.disabled=false;}
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
  const envLike = Object.assign({}, process.env);
  let cfg = loadConfig(PLUGIN_ROOT, envLike);
  let model = body.model || cfg.model;
  let baseUrl = body.baseUrl || cfg.baseUrl;
  let apiKey = body.apiKey || cfg.apiKey;
  // zcode 模式：表单里可能改了服务商/模型还没保存——优先用表单选择现解析，
  // 未给则回退已存配置（loadConfig 已按 apiSource 解析过一轮）。
  if ((body.apiSource || cfg.apiSource) === 'zcode') {
    const prov = findZcodeProvider(readZcodeProviders(envLike), body.zcodeProvider || cfg.zcodeProvider);
    if (!prov) {
      return { ok: false, error: 'provider_missing', hint: 'ZCode 配置里找不到所选的 OpenAI 兼容服务商' };
    }
    if (!prov.eligible) {
      return { ok: false, error: 'provider_ineligible', hint: '该服务商协议非 OpenAI 兼容，审查通道不可用' };
    }
    // 与审查侧 applyZcodeSource 同一成对规则：缺端点或缺 key 都整段不用——
    // 只取其一会把手动 key 发往服务商端点，或把服务商 key 发往手动端点。
    if (!prov.baseURL || !prov.apiKey) {
      const missing = [!prov.baseURL && 'baseURL', !prov.apiKey && 'apiKey'].filter(Boolean).join('/');
      return { ok: false, error: 'provider_incomplete', hint: `provider 缺少 ${missing}，为避免密钥与端点交叉使用，Ping 已中止` };
    }
    baseUrl = prov.baseURL;
    apiKey = prov.apiKey;
    model = body.zcodeModel || cfg.zcodeModel || prov.models[0] || cfg.model;
  }
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
  // 清除已保存的 apiKey：与保存同源防护、同一把锁。错误一律 JSON（前端按 ok 分红绿条），
  // 非 JSON 错误体会让 clearKey 的 r.error 变成 undefined，用户只看到"清除失败：undefined"。
  if (req.method === 'POST' && req.url === '/api/clear-key') {
    if (!isLocalRequest(req)) { send(403, { ok: false, error: '非本机来源，已拒绝' }); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        // 解析与落盘分开包 try：文件系统错误（权限/磁盘/rename）不能伪装成
        // 「请求体不是合法 JSON」的 400——那是两个不同性质的失败。
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
