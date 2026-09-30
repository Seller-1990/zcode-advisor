// zcode-advisor 输入框角标 + 设置面板（页面注入脚本）。
// 由 companion controller 经 CDP 注入 ZCode 桌面版页面；不依赖 ZCode 内部 DOM 结构：
// 角标与面板均为固定定位悬浮层（输入框区域右下角），DOM 变化不影响。
// 通信：直接 fetch 本机 controller API（127.0.0.1，CORS 已放行）。
(() => {
  if (window.__zcodeAdvisorInjected) return;
  window.__zcodeAdvisorInjected = true;

  const API = `http://127.0.0.1:${window.__ZCODE_ADVISOR_API_PORT || __API_PORT__}`;
  const TOKEN = '__TOKEN__';

  const css = `
.zca-badge{position:fixed;right:18px;bottom:96px;z-index:2147483000;width:44px;height:44px;border-radius:50%;
 background:linear-gradient(135deg,#1e293b,#334155);color:#e2e8f0;border:1px solid #475569;cursor:pointer;
 display:flex;align-items:center;justify-content:center;font-size:20px;box-shadow:0 4px 14px rgba(0,0,0,.35);
 user-select:none;opacity:.88;transition:opacity .15s, transform .15s}
.zca-badge:hover{opacity:1;transform:scale(1.06)}
.zca-panel{position:fixed;right:18px;bottom:148px;z-index:2147483001;width:340px;max-height:72vh;overflow:auto;
 background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:12px;padding:14px 16px;
 box-shadow:0 12px 32px rgba(0,0,0,.5);font:13px/1.5 "Segoe UI","Microsoft YaHei",sans-serif}
.zca-panel h3{margin:0 0 4px;font-size:14px;display:flex;justify-content:space-between;align-items:center}
.zca-close{cursor:pointer;color:#94a3b8;font-size:16px;padding:0 4px}
.zca-label{display:block;margin:10px 0 3px;color:#94a3b8;font-size:12px}
.zca-panel input,.zca-panel select{width:100%;box-sizing:border-box;padding:6px 8px;border-radius:6px;
 border:1px solid #334155;background:#1e293b;color:#e2e8f0;font-size:13px}
.zca-row{display:flex;gap:8px;margin-top:12px}
.zca-btn{flex:1;padding:7px 0;border:0;border-radius:6px;cursor:pointer;font-size:13px;
 background:#2563eb;color:#fff}
.zca-btn.alt{background:#334155}
.zca-msg{margin-top:10px;padding:8px;border-radius:6px;display:none;white-space:pre-wrap;font-size:12px}
.zca-ok{background:#052e1b;border:1px solid #14532d;color:#86efac}
.zca-bad{background:#3f1d1d;border:1px solid #7f1d1d;color:#fca5a5}
.zca-status{margin:6px 0 2px;padding:6px 8px;background:#1e293b;border-radius:6px;color:#94a3b8;font-size:12px;word-break:break-all}
`;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  async function api(path, body) {
    const opt = body !== undefined
      ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Advisor-Token': TOKEN }, body: JSON.stringify(body) }
      : { headers: { 'X-Advisor-Token': TOKEN } };
    const r = await fetch(API + path, opt);
    return r.json();
  }

  function msg(text, ok) {
    const m = document.getElementById('zca-msg');
    if (!m) return;
    m.textContent = text;
    m.style.display = 'block';
    m.className = 'zca-msg ' + (ok ? 'zca-ok' : 'zca-bad');
  }

  async function refreshStatus() {
    try {
      const r = await api('/api/config');
      if (!r.ok) return;
      const c = r.config;
      const st = document.getElementById('zca-status');
      if (st) st.textContent = `模型 ${c.model || '（默认）'} ｜ key ${c.keyMasked} ｜ 模式 ${c.reviewMode || 'async'}`;
      const f = fill();
      if (f) {
        if (f.model.value !== c.model && c.model) f.model.value = c.model;
        if (c.baseUrl) f.baseUrl.value = c.baseUrl;
        if (c.reviewMode) f.reviewMode.value = c.reviewMode;
        if (c.maxTokens) f.maxTokens.value = c.maxTokens;
      }
    } catch (_) {
      msg('无法连接本机 controller（外挂未运行？）', false);
    }
  }

  function fill() {
    const g = (id) => document.getElementById(id);
    if (!g('zca-baseUrl')) return null;
    return { baseUrl: g('zca-baseUrl'), apiKey: g('zca-apiKey'), model: g('zca-model'),
      reviewMode: g('zca-reviewMode'), maxTokens: g('zca-maxTokens') };
  }

  function formValues() {
    const f = fill();
    const out = {};
    if (!f) return out;
    for (const k of ['baseUrl', 'model', 'reviewMode']) {
      const v = f[k].value.trim();
      if (v) out[k] = v;
    }
    const mt = parseInt(f.maxTokens.value, 10);
    if (Number.isFinite(mt)) out.maxTokens = mt;
    const key = f.apiKey.value.trim();
    if (key) out.apiKey = key;
    return out;
  }

  async function save() {
    try {
      const r = await api('/api/config', formValues());
      msg(r.ok ? `已保存（${r.file}）—— 下一轮审查即生效` : `保存失败：${r.error}`, r.ok);
      refreshStatus();
    } catch (e) { msg('保存失败：' + e, false); }
  }

  async function ping() {
    try {
      msg('Ping 中…', true);
      const r = await api('/api/ping', formValues());
      msg(r.ok ? `Ping OK（${r.ms}ms）— 端点可达、认证与模型有效${r.note || ''}` : `Ping 失败 → ${r.error}${r.hint ? '：' + r.hint : ''}`, r.ok);
    } catch (e) { msg('Ping 失败：' + e, false); }
  }

  async function fetchModels() {
    try {
      msg('拉取模型列表…', true);
      const f = fill();
      const r = await api('/api/models', { baseUrl: f.baseUrl.value.trim(), apiKey: f.apiKey.value.trim() });
      if (!r.ok) {
        msg(`拉取失败：${r.error} —— 该端点可能不提供 /models，请直接手动输入模型 id`, false);
        return;
      }
      const sel = document.getElementById('zca-model');
      const current = sel.value;
      sel.innerHTML = '';
      for (const id of r.models) {
        const o = document.createElement('option');
        o.value = id; o.textContent = id;
        sel.appendChild(o);
      }
      if (current && !r.models.includes(current)) {
        const o = document.createElement('option');
        o.value = current; o.textContent = current + '（当前）';
        sel.insertBefore(o, sel.firstChild);
      }
      sel.value = r.models.includes(current) ? current : (r.models[0] || '');
      msg(`已拉取 ${r.models.length} 个模型，下拉选择即可`, true);
    } catch (e) { msg('拉取失败：' + e, false); }
  }

  function buildPanel() {
    const p = el('div', 'zca-panel');
    p.id = 'zca-panel';
    p.style.display = 'none';
    p.innerHTML = `
      <h3><span>🛡️ 顾问设置</span><span class="zca-close" id="zca-close">✕</span></h3>
      <div class="zca-status" id="zca-status">读取中…</div>
      <label class="zca-label">端点（OpenAI 兼容，支持第三方）</label>
      <input id="zca-baseUrl" placeholder="https://…/v1 或 …/chat/completions">
      <label class="zca-label">API key</label>
      <input id="zca-apiKey" type="password" placeholder="留空 = 不修改已保存的 key">
      <label class="zca-label">审查模型（可拉取列表后选择，或手动输入）</label>
      <input id="zca-model" list="zca-model-list">
      <datalist id="zca-model-list"></datalist>
      <label class="zca-label">审查模式</label>
      <select id="zca-reviewMode">
        <option value="async">async（默认：零体感延迟，意见随下一条消息送达）</option>
        <option value="sync">sync（当轮打断：concern/blocker 立即送达）</option>
      </select>
      <label class="zca-label">max_tokens（思考型模型建议 4096）</label>
      <input id="zca-maxTokens" type="number" min="64" max="16384">
      <div class="zca-row">
        <button class="zca-btn" id="zca-save">保存</button>
        <button class="zca-btn alt" id="zca-models">拉取模型</button>
        <button class="zca-btn alt" id="zca-ping">Ping</button>
      </div>
      <div class="zca-msg" id="zca-msg"></div>
      <div class="zca-status" style="margin-top:10px">保存后下一轮审查即生效；意见以 [advisor:*] 前缀随下一条消息送达。</div>
    `;
    document.body.appendChild(p);
    p.querySelector('#zca-close').addEventListener('click', () => { p.style.display = 'none'; });
    p.querySelector('#zca-save').addEventListener('click', save);
    p.querySelector('#zca-ping').addEventListener('click', ping);
    p.querySelector('#zca-models').addEventListener('click', fetchModels);
    return p;
  }

  function buildBadge() {
    const b = el('div', 'zca-badge');
    b.id = 'zca-badge';
    b.title = 'zcode-advisor 顾问设置';
    b.textContent = '🛡️';
    let panel = null;
    b.addEventListener('click', () => {
      if (!panel || !document.getElementById('zca-panel')) panel = buildPanel();
      const show = panel.style.display === 'none';
      panel.style.display = show ? 'block' : 'none';
      if (show) refreshStatus();
    });
    document.body.appendChild(b);
  }

  function boot() {
    if (!document.body) {
      setTimeout(boot, 300);
      return;
    }
    buildBadge();
  }
  boot();
})();
