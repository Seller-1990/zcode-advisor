'use strict';

// 完整配置面板（全局配置的 GUI 载体），由 companion controller 在 GET /panel 时返回。
//
// 背景与定位（0.2.15 角标瘦身配套）：
//   - ZCode 3.14.4 宿主不渲染插件 userConfig 表单（实测），「插件详情页设全局模型」
//     没有宿主载体；全局配置的 GUI 落点是本面板（浏览器打开）与本地配置面板
//     （tools/setup-server.js，8789 端口，双击 cmd/sh 的老入口）。
//   - 角标面板只保留会话级控制（启用开关/当前模型展示），全局配置一律引导到这里。
//
// 令牌：页面从 URL hash 读取（controller 的「完整配置」按钮 window.open('/panel#<token>')）。
// hash 不进服务器日志、不落 referer；GET /panel 本身不含敏感数据。
// API 全部对齐 controller 的 /api/*（与 setup-server 的 8789 独立实现互不依赖）。

const PANEL_HTML = `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZCode Advisor · 完整配置</title>
<style>
:root{color-scheme:dark}
body{margin:0;padding:20px;background:#14161c;color:#e6e8ec;
 font:13px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.wrap{max-width:560px;margin:0 auto}
h3{margin:0 0 10px;font-size:16px;display:flex;justify-content:space-between;align-items:center}
.status{padding:8px 10px;background:#242833;border-radius:8px;color:#8b94a3;font-size:12.5px;
 word-break:break-all;margin-bottom:10px}
.label{display:block;margin:12px 0 4px;color:#8b94a3;font-size:12px}
input,select{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;
 border:1px solid #333842;background:#242833;color:#e6e8ec;font-size:13px;outline:none}
input:focus,select:focus{border-color:#3b82f6}
select option{background:#242833;color:#e6e8ec}
.seg{display:flex;background:#242833;border-radius:8px;padding:2px;gap:2px;margin-top:2px}
.seg button{flex:1;padding:7px 0;border:0;border-radius:6px;background:transparent;color:#8b94a3;
 font-size:12.5px;cursor:pointer;transition:background .12s,color .12s}
.seg button.on{background:#2563eb;color:#fff}
.seg button:not(.on):hover{color:#e6e8ec;background:rgba(127,127,127,.12)}
.row{display:flex;gap:8px;margin-top:14px}
.btn{flex:1;padding:8px 0;border:1px solid transparent;border-radius:8px;cursor:pointer;font-size:13px;
 background:#2563eb;color:#fff;transition:filter .15s}
.btn:hover{filter:brightness(1.08)}
.btn.alt{background:#2c313c;color:#e6e8ec;border-color:#3a4049}
.btn.danger{background:#3c2c2c;color:#fca5a5;border-color:#5a3a3a}
.msg{margin-top:10px;padding:8px 10px;border-radius:8px;display:none;white-space:pre-wrap;font-size:12.5px}
.ok{background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.35);color:#6ee7b7}
.bad{background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.35);color:#fca5a5}
.hint{color:#6b7280;font-size:11.5px;margin-top:8px}
details{margin-top:14px;border-top:1px solid #333842;padding-top:8px}
summary{cursor:pointer;color:#8b94a3;font-size:12px;user-select:none;list-style:none}
summary::-webkit-details-marker{display:none}
summary::before{content:'▸ '}
details[open] summary::before{content:'▾ '}
details summary:hover{color:#e6e8ec}
#hist{margin-top:8px;max-height:220px;overflow:auto}
.hitem{padding:6px 8px;border-radius:6px;background:#242833;margin-bottom:6px;font-size:12px}
.hitem .ts{color:#6b7280;font-size:11px;margin-right:6px}
.hitem .sev{font-weight:600;font-size:11px;margin-right:6px}
.hitem.ev-delivered .sev{color:#6ee7b7}
.hitem.ev-queued .sev{color:#93c5fd}
.hitem[class*="ev-dropped"] .sev{color:#fca5a5}
</style></head><body><div class="wrap">
<h3><span>ZCode Advisor · 完整配置</span></h3>
<div class="status" id="st">读取中…</div>

<label class="label" title="顾问用哪个 API 做审查：复用 ZCode 里已维护的服务商，或在本页单独填">API 来源</label>
<div class="seg" id="seg" role="group" aria-label="API 来源">
  <button type="button" id="src-zcode" aria-pressed="false" title="复用 ZCode 设置里已维护的服务商，一处维护两处生效">ZCode 已维护</button>
  <button type="button" id="src-manual" aria-pressed="false" title="在本页单独填写端点 / key / 模型">手动维护</button>
</div>

<div id="sec-zcode" style="display:none">
  <label class="label" title="来自 ZCode 设置里已维护的服务商">服务商</label>
  <div class="row" style="margin-top:0">
    <select id="zprovider" style="flex:1"><option value="">（载入中…）</option></select>
    <button type="button" class="btn alt" id="zrefresh" style="flex:0 0 auto;padding:7px 12px" title="重新读取 ZCode 配置（~/.zcode/v2/config.json）——在 ZCode 里改过服务商后点这里">刷新</button>
  </div>
  <label class="label" title="默认显示 ZCode 里登记的模型；点「从端点拉取」获取服务商实际可用的完整清单">模型</label>
  <div class="row" style="margin-top:0">
    <select id="zmodel" style="flex:1"><option value="">（选择服务商后填充）</option></select>
    <button type="button" class="btn alt" id="zfetch" style="flex:0 0 auto;padding:7px 12px" title="直接请求该服务商的 /models 拿实时全量清单（登记清单可能只有少数几个模型）">从端点拉取</button>
  </div>
  <div class="hint" id="zendpoint"></div>
</div>

<div id="sec-manual">
  <label class="label" title="服务商给你的 OpenAI 兼容接口地址">端点</label>
  <input id="baseUrl" placeholder="https://…/v1 或 …/chat/completions">
  <label class="label">API key</label>
  <input id="apiKey" type="password" placeholder="留空 = 不修改已保存的 key">
  <label class="label" title="点「拉取模型」自动列出；拉不到就手动填">审查模型</label>
  <select id="model"><option value="">（尚未拉取，请在下方手动输入）</option></select>
  <input id="modelManual" placeholder="模型 id（拉不到列表时手填）" style="margin-top:6px">
  <button type="button" class="btn alt" id="fetchModels" style="margin-top:8px;width:100%" title="请求该端点的 /models 获取实时清单">拉取模型</button>
</div>

<details>
  <summary>高级</summary>
  <label class="label" title="意见何时送达：下一轮附带，或当轮立即打断">审查模式</label>
  <select id="reviewMode">
    <option value="async">async（随下一条消息送达，零体感延迟）</option>
    <option value="sync">sync（concern/blocker 当轮立即打断）</option>
  </select>
  <label class="label" title="单次审查输出的上限；思考型模型建议 4096">max_tokens</label>
  <input id="maxTokens" type="number" min="64" max="16384">
  <div class="hint">会话级临时换模型 / 会话级开关在 ZCode 角标面板，或用命令 /advisor-model、/advisor-on、/advisor-off</div>
</details>

<div class="row">
  <button type="button" class="btn" id="save">保存</button>
  <button type="button" class="btn alt" id="ping" title="测一下当前配置的端点能否正常返回">测试连接</button>
  <button type="button" class="btn danger" id="removeKey" title="从本机配置文件移除已保存的 API key（模型/端点等其余配置保留）">清除 key</button>
</div>
<div class="msg" id="msg" role="status" aria-live="polite"></div>

<details id="hist-details">
  <summary>顾问意见记录</summary>
  <div id="hist"><div class="hitem">（展开后加载）</div></div>
</details>
<div class="hint">保存后下一轮审查即生效，无需重启会话。全局配置文件：~/.zcode/advisor.config.json</div>
</div>
<script>
(function(){
  const TOKEN = decodeURIComponent((location.hash || '').replace(/^#/, ''));
  const api = (path, body) => {
    const opt = body !== undefined
      ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Advisor-Token': TOKEN }, body: JSON.stringify(body) }
      : { headers: { 'X-Advisor-Token': TOKEN } };
    return fetch(path, opt).then(r => r.json());
  };
  const $ = (id) => document.getElementById(id);
  const msg = (text, ok) => { const m = $('msg'); m.textContent = text; m.style.display = 'block'; m.className = 'msg ' + (ok ? 'ok' : 'bad'); };
  const esc = (v) => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let curCfg = null, zcodeProviders = null, apiSource = 'manual';

  function setSource(mode) {
    apiSource = mode === 'zcode' ? 'zcode' : 'manual';
    $('src-zcode').className = apiSource === 'zcode' ? 'on' : '';
    $('src-manual').className = apiSource === 'manual' ? 'on' : '';
    $('src-zcode').setAttribute('aria-pressed', String(apiSource === 'zcode'));
    $('src-manual').setAttribute('aria-pressed', String(apiSource === 'manual'));
    $('sec-zcode').style.display = apiSource === 'zcode' ? 'block' : 'none';
    $('sec-manual').style.display = apiSource === 'manual' ? 'block' : 'none';
    if (apiSource === 'zcode' && !zcodeProviders) loadProviders();
  }

  // 服务商列表：每次都从 controller 现读（不像角标面板做缓存）——用户在 ZCode 里
  // 改过服务商后，打开/刷新本页面即是新列表；另有「刷新」按钮强制重拉。
  async function loadProviders(force) {
    try {
      const r = await api('/api/zcode-providers');
      const list = (r && r.ok && Array.isArray(r.providers)) ? r.providers : [];
      zcodeProviders = list;
      const sel = $('zprovider');
      sel.innerHTML = '';
      if (list.length === 0) {
        const o = document.createElement('option'); o.value = ''; o.textContent = '（ZCode 里暂无服务商）'; sel.appendChild(o);
      } else {
        for (const p of list) {
          const o = document.createElement('option');
          o.value = p.id;
          o.textContent = p.eligible
            ? (p.name || p.id) + '（' + p.models.length + ' 模型）'
            : (p.name || p.id) + '（' + p.models.length + ' 模型 · 不支持：' + (p.kind || '未知协议') + '）';
          if (!p.eligible) o.disabled = true;
          sel.appendChild(o);
        }
      }
      const want = curCfg && curCfg.zcodeProvider;
      const eligible = list.filter(p => p.eligible);
      if (force) msg('已刷新：ZCode 里共 ' + list.length + ' 个服务商（OpenAI 兼容 ' + eligible.length + ' 个）', true);
      if (want && list.some(p => p.id === want && p.eligible)) sel.value = want;
      else sel.value = eligible.length > 0 ? eligible[0].id : '';
      fillZcodeModels();
    } catch (e) { msg('服务商列表载入失败：' + (e && e.message || e), false); }
  }

  function selectedProvider() {
    const id = String($('zprovider').value || '').trim();
    return (zcodeProviders || []).find(p => p.id === id) || null;
  }

  function fillZcodeModels(models) {
    const p = selectedProvider();
    const sel = $('zmodel');
    const list = Array.isArray(models) && models.length ? models : ((p && p.models) || []);
    sel.innerHTML = '';
    for (const id of list) { const o = document.createElement('option'); o.value = id; o.textContent = id; sel.appendChild(o); }
    if (!list.length) { const o = document.createElement('option'); o.value = ''; o.textContent = '（无模型——点「从端点拉取」试试）'; sel.appendChild(o); }
    const want = curCfg && curCfg.zcodeModel;
    if (want && list.includes(want)) sel.value = want;
    else if (list.length) sel.value = list[0];
    $('zendpoint').textContent = p ? ('端点：' + (p.baseURL || '（该服务商未配置 baseURL）')) : '先在 ZCode 设置里添加 OpenAI 兼容服务商';
  }

  async function fetchZcodeModels() {
    const p = selectedProvider();
    if (!p) { msg('先选择服务商', false); return; }
    msg('向端点拉取模型…', true);
    try {
      const r = await api('/api/models', { apiSource: 'zcode', zcodeProvider: p.id, zcodeFetch: true });
      if (!r.ok) { msg('拉取失败 → ' + r.error + (r.hint ? '：' + r.hint : ''), false); return; }
      fillZcodeModels(r.models);
      msg('已拉取 ' + r.models.length + ' 个模型（实时清单，保存后生效）', true);
    } catch (e) { msg('拉取失败：' + (e && e.message || e), false); }
  }

  function currentModelId() {
    const fromSel = $('model').value ? String($('model').value).trim() : '';
    const fromManual = $('modelManual').value ? String($('modelManual').value).trim() : '';
    return fromSel || fromManual;
  }

  function fill(c) {
    $('baseUrl').value = c.baseUrl || '';
    $('reviewMode').value = c.reviewMode || 'async';
    $('maxTokens').value = c.maxTokens || 4096;
    if (c.model) {
      const sel = $('model');
      if (!Array.from(sel.options).some(o => o.value === c.model)) {
        const o = document.createElement('option'); o.value = c.model; o.textContent = c.model; sel.appendChild(o);
      }
      sel.value = c.model;
    }
  }

  async function refreshStatus() {
    try {
      const r = await api('/api/config');
      if (!r || !r.ok) { $('st').textContent = '读取失败：' + (r && r.error || '未知'); return; }
      const c = r.config; curCfg = c;
      const zcode = c.apiSource === 'zcode';
      $('st').textContent = '模型 ' + (zcode ? (c.zcodeModel || '（服务商默认）') : (c.model || '（默认）'))
        + ' ｜ key ' + (zcode ? '服务商 key' : c.keyMasked)
        + ' ｜ 模式 ' + (c.reviewMode || 'async') + ' ｜ 来源 ' + (zcode ? 'ZCode 已维护' : '手动');
      fill(c);
      setSource(zcode ? 'zcode' : 'manual');
      if (apiSource === 'zcode') loadProviders(false);
    } catch (e) { $('st').textContent = '无法连接 controller：' + (e && e.message || e); }
  }

  function formValues() {
    const out = { apiSource };
    const mt = parseInt($('maxTokens').value, 10);
    if (Number.isFinite(mt)) out.maxTokens = mt;
    const rm = String($('reviewMode').value || '').trim();
    if (rm) out.reviewMode = rm;
    if (apiSource === 'manual') {
      const baseUrl = $('baseUrl').value.trim();
      if (baseUrl) out.baseUrl = baseUrl;
      const key = $('apiKey').value.trim();
      if (key) out.apiKey = key;
      const model = currentModelId();
      if (model) out.model = model;
    } else {
      const pv = String($('zprovider').value || '').trim();
      const mv = String($('zmodel').value || '').trim();
      if (pv) out.zcodeProvider = pv;
      if (mv) out.zcodeModel = mv;
    }
    return out;
  }

  async function save() {
    try {
      const r = await api('/api/config', formValues());
      if (r && r.ok) { msg('已保存（' + r.file + '）—— 下一轮审查即生效', true); refreshStatus(); }
      else msg('保存失败：' + (r && r.error || '未知'), false);
    } catch (e) { msg('保存失败：' + (e && e.message || e), false); }
  }

  async function ping() {
    try {
      msg('Ping 中…', true);
      const r = await api('/api/ping', formValues());
      msg(r.ok ? ('Ping OK（' + r.ms + 'ms）— 端点可达、认证与模型有效' + (r.note || '')) : ('Ping 失败 → ' + r.error + (r.hint ? '：' + r.hint : '')), r.ok);
    } catch (e) { msg('Ping 失败：' + (e && e.message || e), false); }
  }

  async function fetchManualModels() {
    try {
      msg('拉取模型列表…', true);
      const r = await api('/api/models', { apiSource: 'manual', baseUrl: $('baseUrl').value.trim(), apiKey: $('apiKey').value.trim() });
      if (!r.ok) { msg('拉取失败：' + r.error + (r.hint ? ' —— ' + r.hint : ''), false); return; }
      const sel = $('model');
      const current = currentModelId();
      sel.innerHTML = '';
      for (const id of r.models) { const o = document.createElement('option'); o.value = id; o.textContent = id; sel.appendChild(o); }
      const preserved = current && !r.models.includes(current);
      if (preserved) {
        const o = document.createElement('option'); o.value = current; o.textContent = current + '（当前，不在列表中）';
        sel.insertBefore(o, sel.firstChild);
      }
      sel.value = preserved ? current : (r.models.includes(current) ? current : (r.models[0] || ''));
      if (!preserved) $('modelManual').value = '';
      msg('已拉取 ' + r.models.length + ' 个模型' + (r.models.length <= 3 ? '——若远少于预期，确认 baseUrl 是否含 /v1、key 是否为同一分组' : ''), true);
    } catch (e) { msg('拉取失败：' + (e && e.message || e), false); }
  }

  async function removeKey() {
    if (!confirm('确定从本机配置文件移除已保存的 API key？（模型/端点等其余配置保留）')) return;
    try {
      const r = await api('/api/remove-key', {});
      if (r && r.ok) { msg(r.changed ? '已清除本机保存的 API key' : '本机配置里本就没有 API key', true); refreshStatus(); }
      else msg('清除失败：' + (r && r.error || '未知'), false);
    } catch (e) { msg('清除失败：' + (e && e.message || e), false); }
  }

  async function loadHistory() {
    try {
      const r = await api('/api/history');
      const items = (r && r.ok && Array.isArray(r.history)) ? r.history : [];
      const box = $('hist');
      if (!items.length) { box.innerHTML = '<div class="hitem">暂无记录</div>'; return; }
      box.innerHTML = items.slice(0, 12).map(it => {
        const ts = esc(String(it.ts || '').replace('T', ' ').slice(5, 16));
        const sev = esc(it.severity || it.event || '-');
        const cls = it.event === 'delivered' ? 'ev-delivered' : (String(it.event).startsWith('dropped') ? 'ev-dropped' : 'ev-queued');
        return '<div class="hitem ' + cls + '"><span class="ts">' + ts + '</span><span class="sev">' + sev + '</span>'
          + '<div>' + esc(String(it.note || it.event || '').slice(0, 200)) + '</div></div>';
      }).join('');
    } catch (e) { $('hist').innerHTML = '<div class="hitem">读取失败</div>'; }
  }

  $('src-zcode').addEventListener('click', () => setSource('zcode'));
  $('src-manual').addEventListener('click', () => setSource('manual'));
  $('zprovider').addEventListener('change', () => fillZcodeModels());
  $('zrefresh').addEventListener('click', () => loadProviders(true));
  $('zfetch').addEventListener('click', fetchZcodeModels);
  $('save').addEventListener('click', save);
  $('ping').addEventListener('click', ping);
  $('removeKey').addEventListener('click', removeKey);
  $('fetchModels').addEventListener('click', fetchManualModels);
  $('hist-details').addEventListener('toggle', function () { if (this.open && $('hist').childElementCount <= 1) loadHistory(); });
  refreshStatus();
})();
</script>
</body></html>
`;

module.exports = PANEL_HTML;
