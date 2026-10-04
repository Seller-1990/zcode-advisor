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
/* 会话级模型行：label + 输入框 + 保存按钮同行，紧贴启用开关下方 */
.zca-session-model-row{display:flex;align-items:center;gap:8px;margin-top:8px;
 padding:7px 10px;background:#242833;border-radius:8px}
.zca-session-model-row .zca-label{flex:0 0 auto}
.zca-session-model-row input{flex:1 1 auto;padding:4px 8px;font-size:12px}
.zca-session-model-row .zca-btn{font-size:12px}
.zca-switch{display:inline-flex;align-items:center;gap:8px;cursor:pointer;user-select:none}
.zca-switch input{position:absolute;opacity:0;width:0;height:0}
.zca-track{width:30px;height:17px;border-radius:9px;background:#4a5160;position:relative;transition:background .15s;flex:0 0 auto}
.zca-thumb{position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:#e6e8ec;transition:left .15s}
.zca-switch input:checked ~ .zca-track{background:#2563eb}
.zca-switch input:checked ~ .zca-track .zca-thumb{left:15px}
.zca-switch-text{font-size:12.5px;font-weight:500;color:#e6e8ec}
/* API 来源分段（zca-seg）与高级折叠（zca-adv）样式已随全局配置控件移入
   tools/companion/panel.cjs（0.2.15 角标瘦身）——本页只保留会话级控制。 */
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
      // 版本差异兜底：宿主改类名前缀时（如 chat-composer → xxx-composer），
      // 子串匹配仍能锚进输入框工具栏——全部落空才会退回右下角悬浮，
      // 而「悬浮在右下角」正是不同机器上角标位置不一致的来源。
      '[class*="composer-input-surface"] .ml-auto.flex.shrink-0.items-center.justify-end',
      '[class*="composer-input-surface"] .flex.items-center.justify-between',
      '[class*="composer-input-surface"]'
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
      const items = (r && r.ok && Array.isArray(r.history)) ? r.history.slice(0, 10) : []; // 0.2.15 精简：只看最近 10 条
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

  // 面板运行期状态（0.2.15 瘦身后只保留会话级控制）：
  // curCfg — /api/config 的已存**全局**配置（状态行展示用，不再提供编辑控件）
  // session — /api/session 的最近活动会话快照（enabled / sessionModel）
  let curCfg = null;
  let session = null;

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
      curCfg = r.config;
      // 会话快照失败不阻断状态行（旧版 controller 无此接口时按未知处理）
      try {
        const s = await api('/api/session');
        session = (s && s.ok) ? s : null;
      } catch (_) { session = null; }
      const c = curCfg;
      const st = document.getElementById('zca-status');
      // 状态行只读展示：当前生效模型 + 归属（会话覆盖 > 全局）+ API 来源 + 会话标注。
      // 多会话并行的归属语义：session 是「最近活动的会话」，controller 感知不到焦点，
      // 必须把会话 id 短码亮出来，避免用户把别的会话的开关/模型当成自己的。
      if (st) {
        const zcode = c.apiSource === 'zcode';
        const globalModel = zcode ? (c.zcodeModel || '（服务商默认）') : (c.model || '（默认）');
        const sessionModel = session && session.hasSession ? String(session.sessionModel || '') : '';
        const modelShown = sessionModel ? `${sessionModel}（本会话覆盖）` : globalModel;
        const srcShown = zcode ? 'ZCode 已维护' : '手动';
        const sid = session && session.hasSession && session.sessionId
          ? ` ｜ 会话 ${String(session.sessionId).replace(/^sess_/, '').slice(0, 8)}` : '';
        st.textContent = `模型 ${modelShown} ｜ 模式 ${c.reviewMode || 'async'} ｜ 来源 ${srcShown}${sid}`;
      }
      // 会话启用开关初始态：必须回填，否则用户打开面板看到"未启用"、一点就静默停用
      const en = document.getElementById('zca-session-enabled');
      if (en) en.checked = session ? session.enabled !== false : true;
      // 会话级模型输入框回填当前覆盖值（空 = 跟随全局）
      const sm = document.getElementById('zca-session-model');
      if (sm && session) sm.value = String(session.sessionModel || '');
      // 开关旁的会话标注：无会话数据时置灰提示
      const hint = document.getElementById('zca-session-hint');
      if (hint) {
        hint.textContent = (!session || !session.hasSession)
          ? '暂无活动会话（先在 ZCode 里跑一轮对话）'
          : '保存后自下一轮审查生效；模型可从「完整配置」的模型列表里复制';
      }
    } catch (err) {
      // 网络层失败才可能是"外挂未运行"；此时把原因也带上，便于排查
      msg(`无法连接本机 controller（外挂未运行？）：${err && err.message ? err.message : err}`, false);
    }
  }

  // 保存/重置会话级模型（写 state.sessionModel，与 /advisor-model set|reset 同一落点）
  async function saveSessionModel() {
    const input = document.getElementById('zca-session-model');
    if (!input) return;
    const model = String(input.value || '').trim();
    try {
      const r = await api('/api/session-model', { model });
      if (r && r.ok) {
        msg(model
          ? `本会话模型已设为 ${model}（自下一轮审查生效；不影响其他会话）`
          : '已恢复跟随全局模型（自下一轮审查生效）', true);
        refreshStatus();
      } else {
        msg('设置失败：' + (r && (r.hint || r.error) || '未知'), false);
      }
    } catch (e) {
      msg('设置失败：' + (e && e.message ? e.message : e), false);
    }
  }

  async function toggleSession(checked) {
    try {
      const r = await api('/api/session-toggle', { enabled: checked });
      if (r && r.ok) {
        msg(checked
          ? '本会话已启用（自下一轮审查起生效）'
          : '本会话已停用（不影响其他会话；重新开启用本开关或 /advisor-on）', true);
      } else {
        msg('切换失败：' + (r && (r.hint || r.error) || '未知'), false);
        // 失败回滚开关到真实状态
        const en = document.getElementById('zca-session-enabled');
        if (en) en.checked = !checked;
      }
    } catch (e) {
      msg('切换失败：' + (e && e.message ? e.message : e), false);
      const en = document.getElementById('zca-session-enabled');
      if (en) en.checked = !checked;
    }
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
      <h3><span>顾问</span><button type="button" class="zca-close" id="zca-close" aria-label="关闭">✕</button></h3>
      <div class="zca-status" id="zca-status" role="status" aria-live="polite">读取中…</div>
      <div class="zca-legend" id="zca-legend" title="健康灯含义"></div>
      <div class="zca-toggle-row">
        <label class="zca-switch" title="只作用于最近活动的会话，不影响其他会话">
          <input type="checkbox" id="zca-session-enabled">
          <span class="zca-track"><span class="zca-thumb"></span></span>
          <span class="zca-switch-text">启用顾问（本会话）</span>
        </label>
      </div>
      <div class="zca-session-model-row">
        <label class="zca-label" for="zca-session-model" style="margin:0" title="留空并保存 = 恢复全局模型；仅当前会话生效，优先于全局">本会话模型</label>
        <input id="zca-session-model" placeholder="（使用全局模型）" title="填模型 id 覆盖本会话审查模型；留空 = 跟随全局">
        <button type="button" class="zca-btn alt" id="zca-session-model-save" style="flex:0 0 auto;padding:5px 10px">保存</button>
      </div>
      <div class="zca-hint" id="zca-session-hint" style="margin-top:6px"></div>
      <div class="zca-row">
        <button class="zca-btn" id="zca-fullpanel" title="全局配置（API 来源 / 端点 / key / 全局模型 / 拉取模型 / Ping）在浏览器中打开">完整配置…</button>
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
    p.querySelector('#zca-session-enabled').addEventListener('change', (ev) => toggleSession(!!(ev && ev.target && ev.target.checked)));
    p.querySelector('#zca-session-model-save').addEventListener('click', saveSessionModel);
    // Enter 直接送出（与保存按钮等价）
    p.querySelector('#zca-session-model').addEventListener('keydown', (ev) => {
      if (ev && ev.key === 'Enter') { ev.preventDefault(); saveSessionModel(); }
    });
    // 完整配置：全局配置的唯一 GUI 载体（宿主不渲染插件设置表单，见 panel.cjs 头注释）。
    // 令牌经 URL hash 传递：不进服务器日志、不落 referer（GET /panel 本身不含敏感数据）。
    p.querySelector('#zca-fullpanel').addEventListener('click', () => {
      try { window.open(`${API}/panel#${encodeURIComponent(TOKEN)}`); } catch (_) {}
    });

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
  // 候选必须**可见**（rect 有面积）：子串选择器可能命中隐藏预渲染树/失活会话容器，
  // 挂进去角标会消失、而「找到了锚点」会封死悬浮兜底（复审前端击穿点）。
  // 不可见候选一律跳过；全部不可见时返回 null → mountBadge 走 zca-floating 悬浮
  // （可见可用的降级路径，优于不可见的错误挂载）。
  function anchorVisible(el) {
    try {
      const r = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
      return !!(r && r.width > 0 && r.height > 0);
    } catch (_) {
      return false;
    }
  }

  function findAnchor() {
    const hasQSA = typeof document.querySelectorAll === 'function';
    for (const sel of ANCHOR_SELECTORS) {
      try {
        const list = hasQSA ? Array.from(document.querySelectorAll(sel) || []) : [];
        const hit = list.find(anchorVisible);
        if (hit) return hit;
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
        const first = panel.querySelector('#zca-session-enabled') || panel.querySelector('#zca-close');
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
