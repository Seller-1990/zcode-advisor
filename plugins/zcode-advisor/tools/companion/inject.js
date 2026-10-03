// zcode-advisor 输入框角标 + 设置面板（页面注入脚本）。
// 由 companion controller 经 CDP 注入 ZCode 桌面版页面；不依赖 ZCode 内部 DOM 结构：
// 角标与面板均为固定定位悬浮层（输入框区域右下角），DOM 变化不影响。
// 通信：直接 fetch 本机 controller API（127.0.0.1，CORS 已放行）。
(() => {
  const TOKEN = '__TOKEN__';
  const API = `http://127.0.0.1:${window.__ZCODE_ADVISOR_API_PORT || __API_PORT__}`;

  // 幂等守卫带**令牌版本**：
  // 早期实现只检查 __zcodeAdvisorInjected 布尔量，导致 controller 重启后
  // （新令牌、可能新端口）新脚本被旧标记挡在门外——页面继续用**过期令牌**调 API，
  // 一律 403 bad_token，面板显示"无法连接本机 controller（外挂未运行？）"，
  // 用户必须手动刷新页面才能恢复。
  // 现在：令牌一致才跳过；不一致则清理旧注入并用新令牌重建。
  if (window.__zcodeAdvisorInjected && window.__zcodeAdvisorToken === TOKEN) return;
  if (window.__zcodeAdvisorInjected && window.__zcodeAdvisorToken !== TOKEN) {
    // 清理上一次注入留下的元素与样式，避免叠加出多个角标
    for (const id of ['zca-badge', 'zca-panel', 'zca-style']) {
      const old = document.getElementById(id);
      if (old) old.remove();
    }
    // 旧脚本的健康轮询用的是过期令牌（一律 403 → unknown），会与新脚本的新令牌轮询
    // 互相打架（灯在 ok/未知间闪）；清掉旧定时器，只留新脚本的。
    if (window.__zcaHealthTimer) { clearInterval(window.__zcaHealthTimer); window.__zcaHealthTimer = null; }
    // observer 与定时器同等对待：旧一代不断开会在轮换后叠加并回写旧状态
    if (window.__zcaObserver) { try { window.__zcaObserver.disconnect(); } catch (_) {} window.__zcaObserver = null; }
  }
  window.__zcodeAdvisorInjected = true;
  window.__zcodeAdvisorToken = TOKEN;

  const css = `
/* 角标：锚定在输入框工具栏右侧，与 zcode+ 的 ✨ 并列，而非悬浮遮挡内容。
   内联到工具栏容器里，尺寸与原生图标按钮一致（28px 高），视觉更精简。 */
.zca-badge{display:inline-flex;align-items:center;justify-content:center;position:relative;
 width:28px;height:28px;padding:0;margin:0;border-radius:8px;cursor:pointer;
 background:transparent;color:currentColor;border:1px solid transparent;opacity:.72;
 transition:opacity .15s,background-color .15s,transform .12s;user-select:none;flex:0 0 auto}
.zca-badge:hover{opacity:1;background:rgba(127,127,127,.16);transform:scale(1.06)}
.zca-badge:active{transform:scale(.94)}
/* 兜底：找不到锚点时退回右下角悬浮（不遮挡输入框） */
.zca-badge.zca-floating{position:fixed;right:18px;bottom:96px;width:36px;height:36px;border-radius:50%;
 background:rgba(30,41,59,.92);color:#e2e8f0;box-shadow:0 4px 14px rgba(0,0,0,.35);opacity:.9;z-index:2147483000}
/* topbar 模式：角标做成顶部常驻条，贴在应用主区域上沿 */
.zca-topbar{display:flex;align-items:center;justify-content:flex-end;gap:8px;
 padding:2px 10px;flex:0 0 auto;pointer-events:none}
.zca-topbar > *{pointer-events:auto}
.zca-badge.zca-topbar-badge{width:auto;height:28px;padding:0 10px;border-radius:8px;gap:6px;
 border:1px solid rgba(127,127,127,.28);background:rgba(127,127,127,.10);opacity:.9;font-size:12px}
.zca-badge.zca-topbar-badge .zca-label-text{font-weight:500;letter-spacing:.2px}
/* 健康指示点（M1）：角标上的状态灯。颜色由 /api/health 轮询结果决定。
   默认灰=未知；**代码里不存在"取不到数据就显示绿"的分支**——
   指示器失效必须显示未知，否则用户会把"灯坏了"误读成"顾问健康"。 */
.zca-hdot{position:absolute;top:-2px;right:-2px;width:12px;height:12px;border-radius:50%;
 background:#8b94a3;flex:0 0 auto;transition:background .2s;
 display:flex;align-items:center;justify-content:center;
 font-size:8px;line-height:1;font-weight:700;color:#0b1220}
.zca-badge.zca-topbar-badge .zca-hdot{position:static;top:auto;right:auto}
.zca-badge.zca-h-ok .zca-hdot{background:#10b981}
.zca-badge.zca-h-degraded .zca-hdot{background:#f59e0b;color:#3a2500}
.zca-badge.zca-h-down .zca-hdot{background:#ef4444;color:#fff;animation:zca-pulse 1.6s ease-out infinite}
.zca-badge.zca-h-unknown .zca-hdot{background:#8b94a3;opacity:.55;color:#0b1220}
/* 异常态整体染色：顶部 tab 一眼可见（用户诉求"出问题 tab 变红"） */
.zca-badge.zca-h-down{border-color:rgba(239,68,68,.65);background:rgba(239,68,68,.14);opacity:1;color:#fca5a5}
.zca-badge.zca-h-degraded{border-color:rgba(245,158,11,.55);background:rgba(245,158,11,.12);opacity:1;color:#fcd34d}
@keyframes zca-pulse{0%{box-shadow:0 0 0 0 rgba(239,68,68,.55)}70%{box-shadow:0 0 0 7px rgba(239,68,68,0)}100%{box-shadow:0 0 0 0 rgba(239,68,68,0)}}
/* 尊重系统「减弱动态效果」：脉冲降为静态红，避免持续动画打扰 */
@media (prefers-reduced-motion: reduce){
 .zca-badge.zca-h-down .zca-hdot{animation:none}
 .zca-hdot{transition:none}
}
.zca-panel{position:fixed;width:320px;max-height:76vh;overflow:auto;z-index:2147483001;
 right:16px;bottom:140px;
 background:#1c1f26;color:#e6e8ec;border:1px solid #333842;border-radius:14px;padding:12px 14px 14px;
 box-shadow:0 14px 40px rgba(0,0,0,.45);font:12.5px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.zca-panel h3{margin:0 0 8px;font-size:13.5px;font-weight:600;display:flex;justify-content:space-between;align-items:center}
.zca-close{cursor:pointer;color:#8b94a3;font-size:15px;line-height:1;padding:4px 6px;border-radius:6px;
 background:transparent;border:0;font-family:inherit}
.zca-close:hover{background:rgba(127,127,127,.16);color:#e6e8ec}
.zca-close:focus-visible{outline:2px solid #3b82f6;outline-offset:1px}
.zca-history-head:focus-visible{outline:2px solid #3b82f6;outline-offset:2px;border-radius:6px}
.zca-label{display:block;margin:8px 0 3px;color:#8b94a3;font-size:12px}
.zca-panel input,.zca-panel select{width:100%;box-sizing:border-box;padding:6px 8px;border-radius:8px;
 border:1px solid #333842;background:#242833;color:#e6e8ec;font-size:12.5px;outline:none}
.zca-panel input:focus,.zca-panel select:focus{border-color:#3b82f6}
.zca-panel select option{background:#242833;color:#e6e8ec}
.zca-row{display:flex;gap:8px;margin-top:12px}
.zca-btn{flex:1;padding:7px 0;border:1px solid transparent;border-radius:8px;cursor:pointer;font-size:12.5px;
 background:#2563eb;color:#fff;transition:filter .15s}
.zca-btn:hover{filter:brightness(1.08)}
.zca-btn.alt{background:#2c313c;color:#e6e8ec;border-color:#3a4049}
.zca-msg{margin-top:8px;padding:7px 9px;border-radius:8px;display:none;white-space:pre-wrap;font-size:12px}
.zca-ok{background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.35);color:#6ee7b7}
.zca-bad{background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.35);color:#fca5a5}
.zca-status{margin:0 0 8px;padding:6px 9px;background:#242833;border-radius:8px;color:#8b94a3;font-size:12px;word-break:break-all}
/* 启用开关：面板正文第一行的独立控件。曾在标题栏里挤着——难点中、又像关闭按钮的邻居（位置不对的来源） */
.zca-toggle-row{display:flex;align-items:center;justify-content:space-between;
 padding:7px 10px;background:#242833;border-radius:8px}
.zca-switch{display:inline-flex;align-items:center;gap:8px;cursor:pointer;user-select:none}
.zca-switch input{position:absolute;opacity:0;width:0;height:0}
.zca-track{width:30px;height:17px;border-radius:9px;background:#4a5160;position:relative;transition:background .15s;flex:0 0 auto}
.zca-thumb{position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:#e6e8ec;transition:left .15s}
.zca-switch input:checked ~ .zca-track{background:#2563eb}
.zca-switch input:checked ~ .zca-track .zca-thumb{left:15px}
.zca-switch-text{font-size:12.5px;font-weight:500;color:#e6e8ec}
/* API 来源分段切换：ZCode 已维护 / 手动维护 */
.zca-seg{display:flex;background:#242833;border-radius:8px;padding:2px;gap:2px;margin-top:2px}
.zca-seg button{flex:1;padding:6px 0;border:0;border-radius:6px;background:transparent;color:#8b94a3;
 font-size:12px;cursor:pointer;transition:background .12s,color .12s}
.zca-seg button.on{background:#2563eb;color:#fff}
.zca-seg button:not(.on):hover{color:#e6e8ec;background:rgba(127,127,127,.12)}
/* 高级区折叠：审查模式/max_tokens 低频项，折起以压缩默认占地 */
.zca-adv{margin-top:10px;border-top:1px solid #333842;padding-top:6px}
.zca-adv summary{cursor:pointer;color:#8b94a3;font-size:12px;user-select:none;list-style:none}
.zca-adv summary::-webkit-details-marker{display:none}
.zca-adv summary::before{content:'▸ ';}
.zca-adv[open] summary::before{content:'▾ ';}
.zca-adv summary:hover{color:#e6e8ec}
/* 历史记录区：折叠展示，展开后只读最近若干条 */
.zca-history{margin-top:10px;border-top:1px solid #333842;padding-top:8px}
.zca-history-head{display:flex;justify-content:space-between;align-items:center;cursor:pointer;color:#8b94a3;font-size:12px;user-select:none}
.zca-history-head:hover{color:#e6e8ec}
.zca-history-body{margin-top:6px;display:none;max-height:200px;overflow:auto}
.zca-history-item{padding:6px 8px;border-radius:6px;background:#242833;margin-bottom:6px}
.zca-history-item .h-ts{color:#6b7280;font-size:11px}
.zca-history-item .h-sev{font-weight:600;font-size:11px;margin-right:6px}
.zca-history-item .h-note{color:#c8cdd6;font-size:12px;white-space:pre-wrap;word-break:break-all}
.zca-history-item.ev-delivered .h-sev{color:#6ee7b7}
.zca-history-item.ev-queued .h-sev{color:#93c5fd}
.zca-history-item[class*="ev-dropped"] .h-sev{color:#fca5a5}
.zca-history-empty{color:#6b7280;font-size:12px;padding:4px 0}
.zca-hint{color:#6b7280;font-size:11px;margin-top:8px}
/* 健康图例：状态含义常驻可见，不让用户靠 hover 才知道灯的意思 */
.zca-legend{display:flex;flex-wrap:wrap;gap:2px 10px;margin:0 0 8px}
.zca-leg-item{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;color:#5f6774}
.zca-leg-item.on{color:#e6e8ec}
.zca-leg-dot{width:7px;height:7px;border-radius:50%;background:#8b94a3;opacity:.55;flex:0 0 auto}
.zca-leg-ok .zca-leg-dot{background:#10b981;opacity:1}
.zca-leg-degraded .zca-leg-dot{background:#f59e0b;opacity:1}
.zca-leg-down .zca-leg-dot{background:#ef4444;opacity:1}
/* 面板在窗口较矮时上移到输入框上方，避免被裁掉 */
@media (max-height: 620px){.zca-panel{bottom:auto;top:64px;max-height:calc(100vh - 96px)}}
`;

  // ────────────────────────────────────────────────────────────────
  // 角标放置位置：**单一配置点**（用户可二选一，切换只改这一处）
  //
  // 两种模式：
  //   'composer' — 固定在「输入框提示词优化图标右侧」：角标内联到输入框工具栏的
  //                右侧按钮组，与 zcode+ 的 ✨ 并列，随输入框区域布局。
  //   'topbar'   — 固定在「任务窗口上边」：角标做成顶部常驻的窄条/按钮，
  //                贴在应用主区域上沿，始终可见、不随输入框滚动。
  //
  // 可通过 window.__ZCODE_ADVISOR_ANCHOR 覆盖（便于不改代码试另一种位置），
  // 或在 controller 注入时替换 __ANCHOR_MODE__ 占位符（按配置文件统一下发）。
  // ────────────────────────────────────────────────────────────────
  const ANCHOR_MODE = (window.__ZCODE_ADVISOR_ANCHOR === 'topbar' || window.__ZCODE_ADVISOR_ANCHOR === 'composer')
    ? window.__ZCODE_ADVISOR_ANCHOR
    : '__ANCHOR_MODE__';   // 未覆盖时用注入期替换的值（默认 composer）

  // 按模式给出锚点候选（按优先级）。ZCode 用 Tailwind，类名相对稳定。
  const ANCHOR_SELECTORS = ANCHOR_MODE === 'topbar'
    ? [
      // 顶部区：优先主内容区上沿，其次整个应用根容器
      'main > header', 'header', '[class*="titlebar"]', '[class*="top-bar"]',
      'main', '#root', 'body'
    ]
    : [
      // 输入框工具栏右侧按钮组 → 工具栏行 → 输入框外框（追加在末尾）
      '.chat-composer-input-surface .ml-auto.flex.shrink-0.items-center.justify-end',
      '.chat-composer-input-surface .flex.items-center.justify-between',
      '.chat-composer-input-surface'
    ];

  // topbar 模式用于标记容器（角标需要包一层，才能作为常驻条显示）
  const TOPBAR_WRAPPER_ID = 'zca-topbar';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // 注入样式表。**必须显式注入**：早期实现只定义了 css 常量却没有插入文档，
  // 结果角标是无样式的裸 div——position:static 让它铺成视口底部的全宽文字条，
  // 看上去"角标没出现"。此处的幂等守卫保证重复注入不产生多个 style 元素。
  function ensureStyles() {
    if (document.getElementById('zca-style')) return;
    const style = document.createElement('style');
    style.id = 'zca-style';
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
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

  // 时间戳格式化：历史里存的是 UTC ISO（new Date().toISOString()），直接 slice 显示
  // 会与用户本地时间差一个时区（实测差 8 小时）。这里转成本地时区再显示成 MM-DD HH:MM。
  function fmtTs(iso) {
    const d = new Date(String(iso || ''));
    if (isNaN(d.getTime())) return String(iso || '').replace('T', ' ').slice(5, 16); // 非法值原样兜底
    const p2 = (n) => String(n).padStart(2, '0');
    return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  }

  // 顾问意见历史：读 controller 的 /api/history（JSONL 追加日志，新的在前）。
  // 数据侧写入点在 hooks/lib/history（入队/丢弃/送达三个事件），此处只读。
  async function fetchHistory() {
    const box = document.getElementById('zca-history-body');
    if (!box) return;
    try {
      const r = await api('/api/history');
      const items = (r && r.ok && Array.isArray(r.history)) ? r.history : [];
      if (items.length === 0) {
        box.innerHTML = '<div class="zca-history-empty">暂无记录——顾问意见产生后会出现在这里</div>';
        return;
      }
      // 正文取用顺序：note 正文 > delivered 计数占位 > 事件名。
      const noteOf = (it) => String(it.note || (it.event === 'delivered' ? `已送达 ${it.count || ''} 条意见` : it.event || ''));
      // ts/sev 也做 HTML 转义（不只 note）：二者虽来自本地 controller 固定产出，
      // 但既然走 innerHTML 拼接，就不该默认「来源一定干净」——注入链防线应一致。
      const escHtml = (v) => String(v).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      box.innerHTML = items.map((it) => {
        const ts = escHtml(fmtTs(it.ts));
        const sev = escHtml(it.severity || it.event || '-');
        const cls = it.event === 'delivered' ? 'ev-delivered' : (String(it.event).startsWith('dropped') ? 'ev-dropped' : 'ev-queued');
        return `<div class="zca-history-item ${cls}">`
          + `<span class="h-ts">${ts}</span> <span class="h-sev">${sev}</span>`
          + `<div class="h-note"></div></div>`;
      }).join('');
      // 用 textContent 填正文，避免把模型产出当作 HTML 注入（注入链防线的一部分）
      const nodes = box.querySelectorAll('.h-note');
      items.forEach((it, i) => {
        const full = noteOf(it);
        if (nodes[i]) {
          nodes[i].textContent = full.slice(0, 200);
          // 悬浮显示完整意见：列表里截断到 200 字，悬停看全文（delivered 事件现已带正文）。
          nodes[i].setAttribute('title', full.slice(0, 1000));
        }
      });
    } catch (e) {
      box.innerHTML = `<div class="zca-history-empty">读取失败：${String(e).slice(0, 80)}</div>`;
    }
  }

  // 健康轮询（M1）：读 controller 的 /api/health（信标派生）给角标状态灯着色。
  // 纪律：**只有明确收到 'ok' 才显绿**；网络失败/无信标/陈旧一律 unknown（灰）。
  // 绝不写「取不到数据就当健康」的分支——那会让灯坏了被误读成顾问正常。
  const HEALTH_STATES = { ok: 1, degraded: 1, down: 1, unknown: 1 };
  const HEALTH_TEXT = {
    ok: '顾问正常', degraded: '顾问降级（部分审查由备用模型完成）',
    down: '顾问异常：审查未成功返回', unknown: '顾问状态未知（尚未运行或数据过期）'
  };
  // 非颜色编码：给每种状态一个字形，色觉障碍用户不依赖红/绿也能分辨。
  const HEALTH_GLYPH = { ok: '✓', degraded: '!', down: '✕', unknown: '?' };
  // 短标签（图例用）：一个词的量级，比 HEALTH_TEXT 长句省地方
  const HEALTH_SHORT = { ok: '正常', degraded: '降级', down: '异常', unknown: '未知' };
  let healthState = 'unknown';
  let healthDetail = '';

  // 可见图例：把状态含义常驻在面板里，而不是只藏在角标 title（键盘/触屏用户拿不到 tooltip）。
  // 当前态高亮，其余保持暗色——既解释「这盏灯什么意思」，又不喧宾夺主。
  function paintLegend(state) {
    const box = document.getElementById('zca-legend');
    if (!box) return;
    const s = HEALTH_STATES[state] ? state : 'unknown';
    box.innerHTML = Object.keys(HEALTH_STATES).map((k) =>
      `<span class="zca-leg-item${k === s ? ' on' : ''} zca-leg-${k}">`
      + `<span class="zca-leg-dot"></span>${HEALTH_GLYPH[k]} ${HEALTH_SHORT[k]}</span>`
    ).join('');
    box.setAttribute('aria-label', `健康状态图例；当前：${HEALTH_SHORT[s]}`);
  }

  function paintHealth(state, detail) {
    const b = document.getElementById('zca-badge');
    if (!b) return;
    const s = HEALTH_STATES[state] ? state : 'unknown';
    healthState = s;
    healthDetail = detail || '';
    for (const k of Object.keys(HEALTH_STATES)) b.classList.toggle('zca-h-' + k, k === s);
    // 状态字形：非颜色渠道，避免仅靠红/绿（色盲不友好）
    const dot = document.getElementById('zca-hdot');
    if (dot) dot.textContent = HEALTH_GLYPH[s] || '';
    // 顶部条模式下角标自带文字，把健康态写成 title 提示；图标模式也写 title
    b.title = `ZCode Advisor｜${HEALTH_TEXT[s]}${healthDetail ? '｜' + healthDetail : ''}（点击打开设置）`;
    // 辅助技术：aria-label 必须携带健康态，否则屏幕阅读器用户对本次功能全无感知。
    b.setAttribute('aria-label', `ZCode Advisor 设置；健康状态：${HEALTH_TEXT[s]}${healthDetail ? '，' + healthDetail : ''}`);
    // 面板内可见图例同步当前态（面板未开时为空操作）
    paintLegend(s);
  }

  async function pollHealth() {
    try {
      const r = await api('/api/health');
      if (!r) { paintHealth('unknown', ''); return; }
      // 明确区分失败类型，别把「版本过旧/令牌失效」吞成安静的灰灯（用户会去查不存在的故障）
      if (!r.ok) {
        if (r.error === 'not_found') { paintHealth('unknown', '外挂版本过旧，不支持健康检查，请更新'); return; }
        if (r.error === 'bad_token') { paintHealth('unknown', '令牌已失效，刷新 ZCode 页面即可恢复'); return; }
        paintHealth('unknown', ''); return;
      }
      const b = r.beacon || null;
      let detail = '';
      if (b && b.lastSuccessAt) {
        detail = '上次成功 ' + String(b.lastSuccessAt).replace('T', ' ').slice(5, 16);
      } else if (b && b.lastAttemptAt) {
        detail = '上次尝试 ' + String(b.lastAttemptAt).replace('T', ' ').slice(5, 16) + '（未成功）';
      }
      if (b && b.reason) detail += '｜' + String(b.reason).slice(0, 40);
      // 会话归属：controller 返回的是「最近活动的会话」，不是「当前会话」——
      // 不标注会让用户把另一个会话的灯读成自己会话的灯（多会话下的假绿/假红）。
      const sid = b && b.sessionId ? String(b.sessionId) : '';
      const cand = Number.isFinite(r.candidates) ? r.candidates : 0;
      if (sid) {
        const short = sid.replace(/^sess_/, '').slice(0, 8);
        detail += `｜最近活动会话 ${short}${cand > 1 ? `（共 ${cand} 个）` : ''}`;
      }
      paintHealth(r.state, detail);
    } catch (_) {
      // 外挂未运行 / 网络错误：不能装作正常，显示未知
      paintHealth('unknown', '');
    }
  }

  // 面板运行期状态：
  // curCfg — refreshStatus 拉到的已存配置（zcode 模式下服务商/模型预选的依据）
  // zcodeProviders — /api/zcode-providers 缓存；null = 尚未拉取
  // apiSource — 当前「API 来源」分段选择（manual | zcode）
  let curCfg = null;
  let zcodeProviders = null;
  let apiSource = 'manual';

  function setApiSource(mode) {
    apiSource = mode === 'zcode' ? 'zcode' : 'manual';
    const segZ = document.getElementById('zca-src-zcode');
    const segM = document.getElementById('zca-src-manual');
    if (segZ) { segZ.className = apiSource === 'zcode' ? 'on' : ''; segZ.setAttribute('aria-pressed', String(apiSource === 'zcode')); }
    if (segM) { segM.className = apiSource === 'manual' ? 'on' : ''; segM.setAttribute('aria-pressed', String(apiSource === 'manual')); }
    const zsec = document.getElementById('zca-zcode-sec');
    const msec = document.getElementById('zca-manual-sec');
    if (zsec) zsec.style.display = apiSource === 'zcode' ? 'block' : 'none';
    if (msec) msec.style.display = apiSource === 'manual' ? 'block' : 'none';
    const modelsBtn = document.getElementById('zca-models');
    if (modelsBtn) modelsBtn.style.display = apiSource === 'manual' ? '' : 'none';
    // zcode 模式首次进入才拉服务商列表（之后用缓存；切回再进也不重复请求）
    if (apiSource === 'zcode' && !zcodeProviders) loadProviders();
  }

  async function loadProviders() {
    const sel = document.getElementById('zca-zcode-provider');
    if (!sel) return;
    try {
      const r = await api('/api/zcode-providers');
      const list = (r && r.ok && Array.isArray(r.providers)) ? r.providers : [];
      zcodeProviders = list;
      const eligible = list.filter((p) => p.eligible);
      sel.innerHTML = '';
      if (list.length === 0) {
        const o = document.createElement('option');
        o.value = '';
        o.textContent = '（ZCode 里暂无服务商）';
        sel.appendChild(o);
      } else {
        // 列出**全部**服务商（含非 OpenAI 兼容）——此前只列 eligible 的会让人以为
        // "我维护的模型少了很多"（实测 40 个模型只显示 24 个）。不可用的标灰并注明原因，
        // 让用户看到全貌、理解为什么某些不能选，而不是静默消失。
        for (const p of list) {
          const o = document.createElement('option');
          o.value = p.id;
          const md = `${p.models.length} 模型`;
          if (p.eligible) {
            o.textContent = p.name ? `${p.name}（${md}）` : `${p.id}（${md}）`;
          } else {
            o.textContent = `${p.name || p.id}（${md} · 不支持：${p.kind || '未知协议'}）`;
            o.disabled = true;   // 不可选：审查通道仅支持 OpenAI 兼容端点
          }
          sel.appendChild(o);
        }
      }
      const want = curCfg && curCfg.zcodeProvider;
      if (want && eligible.some((p) => p.id === want)) {
        sel.value = want;
      } else if (want && list.some((p) => p.id === want)) {
        // 已存 provider 存在但非 OpenAI 兼容（被改成不支持协议）：提示但不静默改选。
        sel.value = '';
        msg('已存服务商在 ZCode 里不是 OpenAI 兼容协议，审查通道用不了。未替你改选；'
          + '请重新选择服务商，或切回「手动维护」。', false);
      } else if (want) {
        // 已存 provider 不在 eligible 列表（被改成非兼容协议/已删除/仅 name 命中）：
        // 保留空选项并提示，绝不静默改选别的服务商——否则用户只想改个模式，
        // 保存时 formValues() 就会把新 provider 写回覆盖原选择。审查侧此时
        // 会按 applyZcodeSource 回退手动配置，两边口径一致。
        sel.value = '';
        msg('已存服务商在 ZCode 里不可用（非 OpenAI 兼容或已删除）。未替你改选；'
          + '请手动选择服务商，或切回「手动维护」。', false);
      } else {
        sel.value = eligible.length > 0 ? eligible[0].id : '';
      }
      fillZcodeModels();
    } catch (e) {
      msg(`服务商列表载入失败：${e && e.message ? e.message : e}`, false);
    }
  }

  function selectedProvider() {
    const sel = document.getElementById('zca-zcode-provider');
    const id = sel ? String(sel.value || '').trim() : '';
    return (zcodeProviders || []).find((p) => p.id === id) || null;
  }

  function fillZcodeModels() {
    const msel = document.getElementById('zca-zcode-model');
    const hint = document.getElementById('zca-zcode-endpoint');
    if (!msel) return;
    const p = selectedProvider();
    msel.innerHTML = '';
    for (const id of (p ? p.models : [])) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = id;
      msel.appendChild(o);
    }
    if (!p || p.models.length === 0) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = '（该服务商未配置模型）';
      msel.appendChild(o);
    }
    const want = curCfg && curCfg.zcodeModel;
    if (want && p && p.models.includes(want)) msel.value = want;
    else if (p && p.models.length > 0) msel.value = p.models[0]; // 显式设首项：真实 DOM 会自动选中，但显式赋值让行为不依赖该默认
    if (hint) hint.textContent = p ? `端点：${p.baseURL || '（该服务商未配置 baseURL）'}` : '先在 ZCode 设置里添加 OpenAI 兼容服务商';
  }

  async function refreshStatus() {
    try {
      const r = await api('/api/config');
      if (!r.ok) {
        // 403/bad_token 的典型成因：controller 重启过（新令牌），而本页脚本还是旧令牌。
        // 早期实现对此**静默 return**，面板永久停在"读取中…"，用户看不到任何线索。
        const st = document.getElementById('zca-status');
        if (st) st.textContent = `本机 controller 拒绝了本次请求（${r.error || '未知'}）`;
        msg(
          r.error === 'bad_token'
            ? '令牌已失效（controller 重启过）。刷新 ZCode 页面即可恢复，或重新打开「ZCode Advisor」应用。'
            : `无法连接本机 controller：${r.error || '未知错误'}`,
          false
        );
        return;
      }
      const c = r.config;
      curCfg = c;
      const st = document.getElementById('zca-status');
      // zcode 模式下实际生效的是服务商端点/模型/key（审查通道按 apiSource 解析），
      // 展示手动字段会误导（手动 key 常为「未设置」，但审查照样能用服务商 key）。
      if (st) {
        const zcode = c.apiSource === 'zcode';
        const modelShown = zcode ? (c.zcodeModel || '（服务商默认）') : (c.model || '（默认）');
        const keyShown = zcode ? '服务商 key' : c.keyMasked;
        st.textContent = `模型 ${modelShown} ｜ key ${keyShown} ｜ 模式 ${c.reviewMode || 'async'} ｜ 来源 ${zcode ? 'ZCode' : '手动'}`;
      }
      const f = fill();
      if (f) {
        // 模型值回填到下拉框：若 select 里没有该 id（尚未拉取或列表不含它），
        // 就补一个条目，保证当前配置可见且保存时不会被静默改掉。
        if (c.model) {
          const sel = f.model;
          if (sel && !Array.from(sel.options || []).some((o) => o.value === c.model)) {
            const o = document.createElement('option');
            o.value = c.model;
            o.textContent = c.model;
            sel.appendChild(o);
          }
          if (sel) sel.value = c.model;
        }
        if (c.baseUrl) f.baseUrl.value = c.baseUrl;
        if (c.reviewMode) f.reviewMode.value = c.reviewMode;
        if (c.maxTokens) f.maxTokens.value = c.maxTokens;
        // 回填顾问总开关：**必须回填**——checkbox 默认未勾选，
        // 若不回填，用户打开面板看到"未启用"、一点保存就把顾问静默关掉。
        const enEl = document.getElementById('zca-enabled');
        if (enEl) enEl.checked = c.enabled !== false;
      }
      // API 来源分段 + zcode 服务商/模型预选（loadProviders 异步取 curCfg，先赋值再切换）
      setApiSource(c.apiSource === 'zcode' ? 'zcode' : 'manual');
    } catch (err) {
      // 网络层失败才可能是"外挂未运行"；此时把原因也带上，便于排查
      msg(`无法连接本机 controller（外挂未运行？）：${err && err.message ? err.message : err}`, false);
    }
  }

  function fill() {
    const g = (id) => document.getElementById(id);
    if (!g('zca-baseUrl')) return null;
    return { baseUrl: g('zca-baseUrl'), apiKey: g('zca-apiKey'), model: g('zca-model'),
      reviewMode: g('zca-reviewMode'), maxTokens: g('zca-maxTokens') };
  }

  // 当前选中的审查模型 id：以下拉框为准，回落到手动输入框。
  // 两个控件并存是因为 <select> 只能列出已拉取到的模型，而用户也可能想手填
  // 一个列表里没有的 id（该端点不支持 /models 时只能手填）。
  function currentModelId() {
    const sel = document.getElementById('zca-model');
    const manual = document.getElementById('zca-model-manual');
    const fromSelect = sel && sel.value ? String(sel.value).trim() : '';
    const fromManual = manual && manual.value ? String(manual.value).trim() : '';
    return fromSelect || fromManual;
  }

  function formValues() {
    const out = { apiSource };
    const f = fill();
    // 审查模式 / max_tokens 与 API 来源无关：两个模式下都保存
    if (f) {
      const mt = parseInt(f.maxTokens.value, 10);
      if (Number.isFinite(mt)) out.maxTokens = mt;
      const rm = String(f.reviewMode.value || '').trim();
      if (rm) out.reviewMode = rm;
    }
    if (apiSource === 'manual') {
      if (f) {
        const baseUrl = f.baseUrl.value.trim();
        if (baseUrl) out.baseUrl = baseUrl;
        const key = f.apiKey.value.trim();
        if (key) out.apiKey = key;
        // 模型取自 select（或手动输入兜底）
        const model = currentModelId();
        if (model) out.model = model;
      }
    } else {
      // zcode 模式：不回传手动字段（保留既有手动配置，回切时仍可用）
      const pv = document.getElementById('zca-zcode-provider');
      const mv = document.getElementById('zca-zcode-model');
      if (pv && String(pv.value || '').trim()) out.zcodeProvider = String(pv.value).trim();
      if (mv && String(mv.value || '').trim()) out.zcodeModel = String(mv.value).trim();
    }
    const en = document.getElementById('zca-enabled');
    if (en) out.startEnabled = en.checked;
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
    // zcode 模式的模型清单来自服务商数据（打开分段时已填充），不请求端点 /models
    if (apiSource === 'zcode') return;
    try {
      msg('拉取模型列表…', true);
      const f = fill();
      // fill() 在所有面板字段缺失时返回 null；任一字段缺失也会让后续 .value 抛错。
      // 早期实现直接展开使用，一旦面板被宿主部分重置就报 "Cannot read properties of undefined"。
      if (!f || !f.baseUrl || !f.apiKey) {
        msg('拉取失败：面板未正确初始化，请关闭后重新打开设置面板', false);
        return;
      }
      const r = await api('/api/models', { baseUrl: f.baseUrl.value.trim(), apiKey: f.apiKey.value.trim() });
      if (!r.ok) {
        msg(`拉取失败：${r.error} —— 该端点可能不提供 /models，请在下方“或手动输入”里填写模型 id`, false);
        return;
      }
      // 模型控件是原生 <select>。为什么不用 <input list=datalist>：
      // 实测 Chromium 对 datalist 的下拉只能由**真实用户手势**触发
      // （程序化 input.showPicker() 报 NotAllowedError: requires a user gesture），
      // 且下拉提示很弱，用户表现为"点不动/拉不下来"。原生 select 点击必定展开。
      const sel = document.getElementById('zca-model');
      if (!sel) {
        msg('拉取失败：模型控件缺失（面板未正确初始化）', false);
        return;
      }
      const current = currentModelId();
      sel.innerHTML = '';
      for (const id of r.models) {
        const o = document.createElement('option');
        o.value = id;
        o.textContent = id;
        sel.appendChild(o);
      }
      // 当前模型不在拉取到的列表里（例如手动填过、或端点的 /models 不含它）时：
      // 把它作为首项保留并**选中它**，不能改用列表首项——否则用户已配置的模型
      // 会被静默替换掉（保存后审查模型就变了）。此时也不清空手动输入，避免两边不一致。
      const preserved = current && !r.models.includes(current);
      if (preserved) {
        const o = document.createElement('option');
        o.value = current;
        o.textContent = `${current}（当前，不在列表中）`;
        sel.insertBefore(o, sel.firstChild);
      }
      sel.value = preserved ? current : (r.models.includes(current) ? current : (r.models[0] || ''));
      if (!preserved) {
        const manual = document.getElementById('zca-model-manual');
        if (manual) manual.value = '';
      }
      msg(
        preserved
          ? `已拉取 ${r.models.length} 个模型，但当前模型 ${current} 不在列表中，已保留原选择`
          : `已拉取 ${r.models.length} 个模型，请在上方下拉框中选择`,
        true
      );
    } catch (e) { msg('拉取失败：' + e, false); }
  }

  function buildPanel() {
    // 面板可能在样式被外部清除后重建（页面导航、宿主重置 DOM）：这里兜底一次
    ensureStyles();
    const p = el('div', 'zca-panel');
    p.id = 'zca-panel';
    p.style.display = 'none';
    // 对话框语义：屏幕阅读器需要知道这是设置面板，且 Esc 可关闭、打开时焦点进入。
    // 不用 aria-modal="true"：本面板无遮罩、无焦点陷阱、背景仍可交互，宣称模态会误导 AT 用户。
    p.setAttribute('role', 'dialog');
    p.setAttribute('aria-label', 'ZCode Advisor 顾问设置');
    p.innerHTML = `
      <h3><span>顾问设置</span><button type="button" class="zca-close" id="zca-close" aria-label="关闭">✕</button></h3>
      <div class="zca-status" id="zca-status" role="status" aria-live="polite">读取中…</div>
      <div class="zca-legend" id="zca-legend" title="健康灯含义"></div>
      <div class="zca-toggle-row">
        <label class="zca-switch" title="新会话是否自动启用审查">
          <input type="checkbox" id="zca-enabled">
          <span class="zca-track"><span class="zca-thumb"></span></span>
          <span class="zca-switch-text">启用顾问</span>
        </label>
      </div>
      <label class="zca-label" title="顾问用哪个 API 做审查：复用 ZCode 里已维护的，或在本面板单独填">API 来源</label>
      <div class="zca-seg" id="zca-apiSource" role="group" aria-label="API 来源">
        <button type="button" id="zca-src-zcode" aria-pressed="false" title="复用 ZCode 设置里已维护的服务商，一处维护两处生效">ZCode 已维护</button>
        <button type="button" id="zca-src-manual" aria-pressed="false" title="在本面板单独填写端点 / key / 模型">手动维护</button>
      </div>
      <div id="zca-zcode-sec" style="display:none">
        <label class="zca-label" title="来自 ZCode 设置里已维护的服务商">服务商</label>
        <select id="zca-zcode-provider"><option value="">（载入中…）</option></select>
        <label class="zca-label">模型</label>
        <select id="zca-zcode-model"><option value="">（选择服务商后填充）</option></select>
        <div class="zca-hint" id="zca-zcode-endpoint"></div>
      </div>
      <div id="zca-manual-sec">
        <label class="zca-label" title="服务商给你的 OpenAI 兼容接口地址">端点</label>
        <input id="zca-baseUrl" placeholder="https://…/v1 或 …/chat/completions">
        <label class="zca-label">API key</label>
        <input id="zca-apiKey" type="password" placeholder="留空 = 不修改已保存的 key">
        <label class="zca-label" title="点「拉取模型」自动列出；拉不到就手动填">审查模型</label>
        <select id="zca-model">
          <option value="">（尚未拉取，请在下方手动输入）</option>
        </select>
        <input id="zca-model-manual" placeholder="模型 id（拉不到列表时手填）" style="margin-top:6px">
      </div>
      <details class="zca-adv" id="zca-adv">
        <summary>高级</summary>
        <label class="zca-label" title="意见何时送达：下一轮附带，或当轮立即打断">审查模式</label>
        <select id="zca-reviewMode" title="async：意见随下一条消息送达（默认）｜sync：concern/blocker 当轮立即打断">
          <option value="async">async</option>
          <option value="sync">sync</option>
        </select>
        <div class="zca-hint">async：随下一条消息送达（默认）｜sync：concern/blocker 当轮打断</div>
        <label class="zca-label" title="单次审查输出的上限；思考型模型建议 4096">max_tokens</label>
        <input id="zca-maxTokens" type="number" min="64" max="16384">
        <div class="zca-hint">清除已保存的 key 不在此面板：请用项目里的「配置面板」（macOS：node tools/setup-server.js），再点「清除 API key」</div>
      </details>
      <div class="zca-row">
        <button class="zca-btn" id="zca-save">保存</button>
        <button class="zca-btn alt" id="zca-ping" title="测一下当前配置的端点能否正常返回">测试连接</button>
        <button class="zca-btn alt" id="zca-models">拉取模型</button>
      </div>
      <div class="zca-msg" id="zca-msg" role="status" aria-live="polite"></div>
      <div class="zca-history" id="zca-history">
        <div class="zca-history-head" id="zca-history-head" role="button" tabindex="0" aria-expanded="false" title="展开/收起最近的顾问意见">
          <span>顾问意见记录</span><span id="zca-history-arrow">▸</span>
        </div>
        <div class="zca-history-body" id="zca-history-body"></div>
      </div>
      <div class="zca-hint" style="margin-top:8px" title="意见会以下一条消息附带的形式送达，供参考">保存后下一轮生效</div>
    `;
    document.body.appendChild(p);
    const closePanel = () => { p.style.display = 'none'; };
    p.querySelector('#zca-close').addEventListener('click', closePanel);
    // Esc 关闭（对话框惯例）：键盘用户不必去够右上角小叉
    p.addEventListener('keydown', (ev) => { if (ev && ev.key === 'Escape') closePanel(); });
    p.querySelector('#zca-save').addEventListener('click', save);
    p.querySelector('#zca-ping').addEventListener('click', ping);
    p.querySelector('#zca-models').addEventListener('click', fetchModels);
    p.querySelector('#zca-src-zcode').addEventListener('click', () => setApiSource('zcode'));
    p.querySelector('#zca-src-manual').addEventListener('click', () => setApiSource('manual'));
    p.querySelector('#zca-zcode-provider').addEventListener('change', fillZcodeModels);

    // 历史区：默认折叠；首次展开才拉取（后续展开用缓存，点头部可强制刷新）
    const head = p.querySelector('#zca-history-head');
    const body = p.querySelector('#zca-history-body');
    const arrow = p.querySelector('#zca-history-arrow');
    let historyLoaded = false;
    const toggleHistory = () => {
      const open = body.style.display === 'block';
      body.style.display = open ? 'none' : 'block';
      arrow.textContent = open ? '▸' : '▾';
      head.setAttribute('aria-expanded', String(!open));
      if (!open && !historyLoaded) { historyLoaded = true; fetchHistory(); }
    };
    head.addEventListener('click', toggleHistory);
    // 键盘可达：头部是 role=button + tabindex=0，Enter/Space 必须等价于点击（否则键盘用户开不了历史）
    head.addEventListener('keydown', (ev) => {
      if (ev && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); toggleHistory(); }
    });
    return p;
  }

  // 找到当前可用的锚点。ZCode 是 React 应用，容器会在切换任务/会话时重建，
  // 因此必须每次挂载时重新查找，不能缓存节点。
  function findAnchor() {
    for (const sel of ANCHOR_SELECTORS) {
      try {
        const el2 = document.querySelector(sel);
        if (el2) return el2;
      } catch (_) { /* 选择器不兼容时跳过 */ }
    }
    return null;
  }

  // topbar 模式下，角标需要包一层容器才能作为常驻条布局（并避免污染宿主 flex 结构）
  function ensureTopbarWrapper() {
    const existing = document.getElementById(TOPBAR_WRAPPER_ID);
    if (existing) return existing;
    const w = el('div', 'zca-topbar');
    w.id = TOPBAR_WRAPPER_ID;
    return w;
  }

  // 把角标挂到锚点上；找不到锚点时退回悬浮模式（仍可用，只是位置不同）。
  function mountBadge(b) {
    const anchor = findAnchor();
    if (!anchor) {
      if (b.parentNode !== document.body) document.body.appendChild(b);
      b.classList.add('zca-floating');
      return;
    }

    if (ANCHOR_MODE === 'topbar') {
      // 顶部常驻：插入 wrapper 作为锚点的首个/末个子元素，形成一条窄条
      const wrapper = ensureTopbarWrapper();
      if (wrapper.parentNode !== anchor) anchor.insertBefore(wrapper, anchor.firstChild);
      if (b.parentNode !== wrapper) wrapper.appendChild(b);
    } else {
      if (b.parentNode !== anchor) anchor.appendChild(b);
    }
    b.classList.remove('zca-floating');
  }

  function buildBadge() {
    // 已存在则复用（重注入场景），避免出现多个角标
    const existing = document.getElementById('zca-badge');
    if (existing) { mountBadge(existing); return existing; }

    const b = el('div', 'zca-badge');
    b.id = 'zca-badge';
    b.title = 'ZCode Advisor 顾问设置（审查副模型）';
    b.setAttribute('role', 'button');
    b.setAttribute('aria-label', 'ZCode Advisor 设置');
    b.tabIndex = 0;

    const svg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" '
      + 'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>';
    const dot = el('span', 'zca-hdot');
    dot.id = 'zca-hdot';
    if (ANCHOR_MODE === 'topbar') {
      // 顶部模式带宽高，可带文字标签，比纯图标更好认
      b.classList.add('zca-topbar-badge');
      b.innerHTML = `${svg}<span class="zca-label-text">顾问</span>`;
      b.appendChild(dot);
    } else {
      // 输入框工具栏模式：只放图标，与相邻的原生图标按钮尺寸一致
      b.innerHTML = svg;
      b.appendChild(dot);
    }
    // 初始态默认灰（未知）：不能在建角标时就假定健康
    b.classList.add('zca-h-unknown');

    let panel = null;
    const toggle = () => {
      if (!panel || !document.getElementById('zca-panel')) panel = buildPanel();
      const show = panel.style.display === 'none';
      panel.style.display = show ? 'block' : 'none';
      if (show) {
        refreshStatus();
        // 打开面板时把已知健康态同步到图例（图例元素此时才存在）
        paintLegend(healthState);
        // 焦点管理：打开时把焦点移入面板首个可聚焦控件，键盘用户不必 Tab 穿越宿主 UI
        const first = panel.querySelector('#zca-enabled') || panel.querySelector('#zca-close');
        if (first && typeof first.focus === 'function') { try { first.focus(); } catch (_) {} }
      }
    };
    b.addEventListener('click', toggle);
    b.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); }
    });

    mountBadge(b);
    return b;
  }

  // 输入框容器会被 React 重建（切换会话/任务），重建后角标会随旧节点一起消失。
  // 用 MutationObserver 监听并重新挂载——比定时轮询更省资源且响应更快。
  function watchComposer() {
    if (typeof MutationObserver !== 'function' || !document.body) return;
    // 跨代清理：旧一代 observer 若不 disconnect，令牌轮换后会叠加，其回调仍闭包引用旧
    // TOKEN/healthState，可能把新一代刚拉到的正确态踹回旧值。挂到 window 供清理块断开。
    if (window.__zcaObserver) { try { window.__zcaObserver.disconnect(); } catch (_) {} }
    const observer = new MutationObserver(() => {
      const b = document.getElementById('zca-badge');
      if (!b) {
        // 角标被整体移除（容器重建）：重新创建
        buildBadge();
        // 重建后立刻恢复上一次已知健康态，避免灯在下一个轮询周期前闪回灰色
        paintHealth(healthState, healthDetail);
        return;
      }
      // 角标还在但已脱离锚点（如父容器被替换）：重挂
      const anchor = findAnchor();
      if (anchor && b.parentNode !== anchor) mountBadge(b);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.__zcaObserver = observer;
  }

  function boot() {
    if (!document.body) {
      setTimeout(boot, 300);
      return;
    }
    // 先注入样式再建角标：顺序颠倒会让角标短暂以无样式形态出现
    ensureStyles();
    buildBadge();
    watchComposer();
    // 健康轮询（M1）：角标状态灯必须**持续**反映后端，而不是只在打开面板时拉一次。
    // 首次立即拉，之后每 5s；单次失败不改变其它逻辑，只把灯置未知。
    pollHealth();
    if (!window.__zcaHealthTimer) {
      window.__zcaHealthTimer = setInterval(pollHealth, 5000);
    }
  }
  boot();
})();
