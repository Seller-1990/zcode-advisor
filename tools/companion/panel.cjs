'use strict';

// 完整配置面板（全局配置的 GUI 载体），由 companion controller 在 GET /panel 时返回。
//
// 定位（0.2.17 起）：审查通道**只**使用 ZCode 里已维护的第三方服务商
// （~/.zcode/v2/config.json 的 provider.*，排除 builtin: 官方内置通道）。
// 本面板负责：选服务商 / 选模型 / 刷新 / 从端点拉取实时模型清单 / Ping / 审查模式 / max_tokens。
// 会话级覆盖（本会话用哪个服务商/模型）在角标面板——这里只管全局默认。
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
.row{display:flex;gap:8px;margin-top:14px}
.row.tight{margin-top:0}
.btn{flex:1;padding:8px 0;border:1px solid transparent;border-radius:8px;cursor:pointer;font-size:13px;
 background:#2563eb;color:#fff;transition:filter .15s}
.btn:hover{filter:brightness(1.08)}
.btn.alt{background:#2c313c;color:#e6e8ec;border-color:#3a4049}
.btn[disabled]{opacity:.55;cursor:default;filter:none}
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
/* 人工跟进（issue #9）：用户自己的动作事件用紫色，与机器事件（绿/蓝/红）一眼可分 */
.hitem.ev-user .sev{color:#c4b5fd}
.hmark{display:inline-block;padding:0 6px;border-radius:999px;font-size:10px;
 border:1px solid rgba(139,92,246,.55);color:#c4b5fd;vertical-align:middle}
.hmark:empty{display:none}
.hact{display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin-top:6px}
.hbtn{font-size:11px;line-height:1.6;padding:1px 8px;border-radius:6px;
 border:1px solid #3b4150;background:#2b303b;color:#c8cdd6;cursor:pointer}
.hbtn:hover{border-color:#4b5563;color:#e6e8ec}
.hinput{flex:1 1 110px;min-width:0;font-size:11px;padding:1px 6px;border-radius:6px;
 border:1px solid #3b4150;background:#1f232b;color:#e6e8ec}
</style></head><body><div class="wrap">
<h3><span>ZCode Advisor · 完整配置</span></h3>
<div class="status" id="st">读取中…</div>

<label class="label" title="审查用哪个 ZCode 服务商：只列非官方、协议受支持（OpenAI 兼容或 Anthropic）且已配端点与 key 的">服务商</label>
<div class="row tight">
  <select id="zprovider" style="flex:1"><option value="">（载入中…）</option></select>
  <button type="button" class="btn alt" id="zrefresh" style="flex:0 0 auto;padding:7px 12px" title="重新读取 ZCode 配置（~/.zcode/v2/config.json）——在 ZCode 里改过服务商后点这里">刷新</button>
</div>
<label class="label" title="默认显示 ZCode 里登记的模型；点「从端点拉取」获取服务商实际可用的完整清单">模型</label>
<div class="row tight">
  <select id="zmodel" style="flex:1"><option value="">（选择服务商后填充）</option></select>
  <button type="button" class="btn alt" id="zfetch" style="flex:0 0 auto;padding:7px 12px" title="直接请求该服务商的 /models 拿实时全量清单（登记清单可能只有少数几个模型）">从端点拉取</button>
</div>
<input id="modelManual" placeholder="模型 id（端点清单里没有时手填）" style="margin-top:6px">
<div class="hint" id="zendpoint"></div>
<div class="hint">端点与 key 由 ZCode 服务商统一维护（本插件不单独保存）；官方内置通道（BigModel/Z.ai）不用于审查。</div>

<details>
  <summary>高级</summary>
  <label class="label" title="意见何时送达：下一轮附带，或当轮立即打断">审查模式</label>
  <select id="reviewMode">
    <option value="async">async（随下一条消息送达，零体感延迟）</option>
    <option value="sync">sync（concern/blocker 当轮立即打断）</option>
  </select>
  <label class="label" title="单次审查输出的上限；思考型模型建议 4096">max_tokens</label>
  <input id="maxTokens" type="number" min="64" max="16384">
  <div class="hint">本会话临时换服务商/模型在 ZCode 角标面板（「本会话的审查模型」），或用命令 /advisor-model</div>
</details>

<div class="row">
  <button type="button" class="btn" id="save">保存</button>
  <button type="button" class="btn alt" id="ping" title="测一下所选服务商能否正常返回">测试连接</button>
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
  let curCfg = null, providers = null;

  // 服务商列表：每次都从 controller 现读（不像角标面板做缓存）——用户在 ZCode 里
  // 改过服务商后，打开/刷新本页面即是新列表；另有「刷新」按钮强制重拉。
  // 只列可用项（非官方 + 协议受支持 + 端点/key 齐备）：看得见的都能用。
  async function loadProviders(force) {
    try {
      const r = await api('/api/zcode-providers');
      const all = (r && r.ok && Array.isArray(r.providers)) ? r.providers : [];
      providers = all.filter(p => !p.official && p.eligible && p.baseURL && p.hasApiKey);
      const sel = $('zprovider');
      sel.innerHTML = '';
      if (providers.length === 0) {
        const o = document.createElement('option'); o.value = ''; o.textContent = '（ZCode 里暂无可用第三方服务商）'; sel.appendChild(o);
      } else {
        for (const p of providers) {
          const o = document.createElement('option');
          o.value = p.id;
          o.textContent = (p.name || p.id) + '（' + p.models.length + ' 模型）';
          sel.appendChild(o);
        }
      }
      const want = curCfg && curCfg.zcodeProvider;
      if (want && providers.some(p => p.id === want)) sel.value = want;
      else sel.value = providers.length ? providers[0].id : '';
      if (force) msg('已刷新：ZCode 里可用第三方服务商 ' + providers.length + ' 个' + (all.length !== providers.length ? '（另有 ' + (all.length - providers.length) + ' 个官方/不兼容项未列出）' : ''), true);
      fillModels();
    } catch (e) { msg('服务商列表载入失败：' + (e && e.message || e), false); }
  }

  function selectedProvider() {
    const id = String($('zprovider').value || '').trim();
    return (providers || []).find(p => p.id === id) || null;
  }

  function fillModels(models) {
    const p = selectedProvider();
    const sel = $('zmodel');
    const list = Array.isArray(models) && models.length ? models : ((p && p.models) || []);
    sel.innerHTML = '';
    for (const id of list) { const o = document.createElement('option'); o.value = id; o.textContent = id; sel.appendChild(o); }
    if (!list.length) { const o = document.createElement('option'); o.value = ''; o.textContent = '（无登记模型——点「从端点拉取」试试）'; sel.appendChild(o); }
    const want = curCfg && curCfg.model;
    if (want && list.includes(want)) sel.value = want;
    else if (list.length) sel.value = list[0];
    // 模型清单刚被换过（切服务商 / 拉取实时清单）：手填框里的旧值不再代表用户意图，
    // 不清空会盖住用户接下来在下拉里的选择（currentModelId 手填优先）。
    const manual = $('modelManual');
    if (manual && manual.value && !list.includes(String(manual.value).trim())) manual.value = '';
    $('zendpoint').textContent = p ? ('端点：' + (p.baseURL || '（该服务商未配置 baseURL）')) : '先在 ZCode 设置里添加 OpenAI 兼容或 Anthropic 服务商';
  }

  async function fetchZcodeModels() {
    const p = selectedProvider();
    if (!p) { msg('先选择服务商', false); return; }
    msg('向端点拉取模型…', true);
    try {
      const r = await api('/api/models', { zcodeProvider: p.id, zcodeFetch: true });
      if (!r.ok) { msg('拉取失败 → ' + r.error + (r.hint ? '：' + r.hint : ''), false); return; }
      fillModels(r.models);
      msg('已拉取 ' + r.models.length + ' 个模型（实时清单，保存后生效）', true);
    } catch (e) { msg('拉取失败：' + (e && e.message || e), false); }
  }

  // 当前选中的模型：手填框**优先于**下拉，因为手填是「清单里没有」时的显式意图。
  // 但手填框必须在下拉变化时清空——否则用户先手填过一个、之后又在下拉里选了别的，
  // 保存的仍会是那个陈旧的手填值（静默忽略用户刚做的选择）。
  function currentModelId() {
    const fromSel = $('zmodel').value ? String($('zmodel').value).trim() : '';
    const fromManual = $('modelManual').value ? String($('modelManual').value).trim() : '';
    return fromManual || fromSel;
  }

  // 用户主动改下拉（选模型 / 切服务商）时，手填框里的旧值不再代表意图，清掉。
  // 只靠 fillModels 里「不在新清单里才清」不够：旧值恰好也在新清单里时会被保留，
  // 于是它继续压过用户刚选的那一项（静默忽略刚做的选择）。
  // 注：**不需要**区分"程序回填 vs 用户操作"——按 DOM 规范，程序化赋值 select.value
  // 不会派发 change 事件（jsdom 实测：赋值 0 次、dispatchEvent 1 次），所以下面的
  // 处理器只会被真实用户交互触发，回填不会误清手填值。
  function clearManualIfPicked() {
    const m = $('modelManual');
    if (m && m.value) m.value = '';
  }

  async function refreshStatus() {
    try {
      const r = await api('/api/config');
      if (!r || !r.ok) { $('st').textContent = '读取失败：' + (r && r.error || '未知'); return; }
      const c = r.config; curCfg = c;
      $('st').textContent = '服务商 ' + (c.providerName || '（未解析出）') + (c.providerAuto ? '（自动选择）' : '')
        + ' ｜ 模型 ' + (c.model || '（服务商默认）')
        + ' ｜ 模式 ' + (c.reviewMode || 'async')
        + (c.providerUsable === false ? ' ｜ ⚠ 目标不可用：' + (c.providerError || '') : '');
      $('reviewMode').value = c.reviewMode || 'async';
      $('maxTokens').value = c.maxTokens || 4096;
      await loadProviders(false);
    } catch (e) { $('st').textContent = '无法连接 controller：' + (e && e.message || e); }
  }

  function formValues() {
    const out = {};
    const mt = parseInt($('maxTokens').value, 10);
    if (Number.isFinite(mt)) out.maxTokens = mt;
    const rm = String($('reviewMode').value || '').trim();
    if (rm) out.reviewMode = rm;
    const pv = String($('zprovider').value || '').trim();
    const mv = currentModelId();
    if (pv) out.zcodeProvider = pv;
    if (mv) out.model = mv;
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
      msg(r.ok ? ('Ping OK（' + r.ms + 'ms）— ' + (r.provider || '') + ' / ' + (r.model || '') + ' 可用' + (r.note || '')) : ('Ping 失败 → ' + r.error + (r.hint ? '：' + r.hint : '')), r.ok);
    } catch (e) { msg('Ping 失败：' + (e && e.message || e), false); }
  }

  // 人工动作三种语义（issue #9）：与角标面板、controller 侧 USER_ACTIONS 的 label 一致。
  const USER_ACTION_LABELS = { ack: '认同并转达', note: '补充说明', dismiss: '驳回' };
  // 最近渲染的条目：按钮处理器按索引回查（索引由按钮 id 末位给出），不用闭包捕获——
  // 重新渲染后处理器取到的始终是当前列表里的那一条。
  let histItems = [];

  // 「已被人工跟进」判定：user_followup 事件与原意见的 (severity, note) 配对。
  // 历史是 JSONL 追加日志、由两个进程先后写入，没有可共享的自增 id，内容键是唯一共有的关联。
  function followupOf(items, it) {
    const sev = String(it.severity || '');
    const note = String(it.note || '');
    if (!sev || !note) return null;
    return items.find(x => x && x.event === 'user_followup'
      && String(x.severity || '') === sev && String(x.note || '') === note) || null;
  }

  async function loadHistory() {
    try {
      const r = await api('/api/history');
      const items = (r && r.ok && Array.isArray(r.history)) ? r.history : [];
      histItems = items;
      const box = $('hist');
      if (!items.length) { box.innerHTML = '<div class="hitem">暂无记录</div>'; return; }
      box.innerHTML = items.slice(0, 12).map((it, i) => {
        const ts = esc(String(it.ts || '').replace('T', ' ').slice(5, 16));
        const sev = esc(it.severity || it.event || '-');
        // 用户自己的动作事件用 ev-user（紫），与机器事件（绿/蓝/红）区分
        const cls = it.event === 'user_followup' ? 'ev-user'
          : (it.event === 'delivered' ? 'ev-delivered'
            : (String(it.event).startsWith('dropped') ? 'ev-dropped' : 'ev-queued'));
        // 动作行只挂在「顾问意见」条目上：需同时有 severity 与正文，且不是用户自己的跟进事件。
        const actionable = it.event !== 'user_followup' && Boolean(it.severity) && Boolean(it.note);
        const fu = actionable ? followupOf(items, it) : null;
        const mark = fu
          ? '<span class="hmark" title="已人工跟进">已跟进·' + esc(USER_ACTION_LABELS[fu.action] || fu.action || '') + '</span>'
          : '';
        // 输入框而非 window.prompt：Electron 渲染进程不实现 window.prompt（返回 null）。
        const act = actionable
          ? '<div class="hact">'
            + '<button type="button" class="hbtn" id="hact-ack-' + i + '" aria-label="认同并转达这条意见">' + USER_ACTION_LABELS.ack + '</button>'
            + '<input type="text" class="hinput" id="hinput-' + i + '" aria-label="补充说明内容" placeholder="补充说明…">'
            + '<button type="button" class="hbtn" id="hact-note-' + i + '" aria-label="连同补充说明一起转达">' + USER_ACTION_LABELS.note + '</button>'
            + '<button type="button" class="hbtn" id="hact-dismiss-' + i + '" aria-label="驳回这条意见">' + USER_ACTION_LABELS.dismiss + '</button>'
            + '</div>'
          : '';
        return '<div class="hitem ' + cls + '"><span class="ts">' + ts + '</span><span class="sev">' + sev + '</span>' + mark
          + '<div>' + esc(String(it.note || it.event || '').slice(0, 200)) + '</div>' + act + '</div>';
      }).join('');
      items.slice(0, 12).forEach((it, i) => {
        if (it.event === 'user_followup' || !it.severity || !it.note) return;
        bindAction('hact-ack-' + i, 'ack');
        bindAction('hact-note-' + i, 'note');
        bindAction('hact-dismiss-' + i, 'dismiss');
      });
    } catch (e) { $('hist').innerHTML = '<div class="hitem">读取失败</div>'; }
  }

  // 动作按钮绑定（幂等：重复渲染同一 id 不重复绑）
  function bindAction(id, action) {
    const btn = $(id);
    if (!btn || btn.getAttribute('data-zca-wired') === '1') return;
    btn.setAttribute('data-zca-wired', '1');
    btn.addEventListener('click', () => {
      // 索引从自身 id 末位解析，而非闭包捕获——列表重排后仍指向当前那一条。
      const m = /(\d+)$/.exec(String(btn.id || ''));
      submitUserAction(m ? parseInt(m[1], 10) : -1, action);
    });
  }

  // 提交人工动作（issue #9）：三种动作写的是**同一个** pendingNotes 队列，区别只在注回文案。
  // 必须如实告知「下一轮生效」——本面板没有送达能力，送达发生在 hook 的 UserPromptSubmit 边界。
  async function submitUserAction(idx, action) {
    const it = histItems[idx];
    if (!it) { msg('这条意见已不在列表中，请重新展开历史', false); return; }
    const inp = $('hinput-' + idx);
    const text = inp ? String(inp.value || '').trim() : '';
    if (action === 'note' && !text) { msg('「补充说明」需要先填写内容', false); return; }
    const label = USER_ACTION_LABELS[action] || action;
    try {
      const r = await api('/api/note', {
        action, severity: String(it.severity || ''), note: String(it.note || ''), text
      });
      if (r && r.ok) {
        msg(label + '已入队（' + r.pending + '/' + r.cap + '）——下一轮对话开始时随顾问意见一起送达', true);
        loadHistory();   // 重新读历史：跟进标记与队列占用立刻可见
      } else {
        msg('提交失败：' + ((r && (r.hint || r.error)) || '未知'), false);
      }
    } catch (e) { msg('提交失败：' + (e && e.message || e), false); }
  }

  $('zprovider').addEventListener('change', () => { clearManualIfPicked(); fillModels(); });
  // 用户亲手选模型 = 明确意图，清掉可能压倒它的手填旧值。
  $('zmodel').addEventListener('change', clearManualIfPicked);
  $('zrefresh').addEventListener('click', () => loadProviders(true));
  $('zfetch').addEventListener('click', fetchZcodeModels);
  $('save').addEventListener('click', save);
  $('ping').addEventListener('click', ping);
  $('hist-details').addEventListener('toggle', function () { if (this.open && $('hist').childElementCount <= 1) loadHistory(); });
  refreshStatus();
})();
</script>
</body></html>
`;

module.exports = PANEL_HTML;
