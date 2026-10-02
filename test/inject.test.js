'use strict';

// inject.js（页面注入脚本）的行为测试。
//
// 为什么需要这份测试：inject.js 此前只被"是否存在于发行包"这类结构测试覆盖，
// 没有任何行为验证。结果一个致命缺陷逃逸到了用户手上——脚本定义了 css 常量却
// **从未把样式插入文档**，角标渲染成 position:static 的裸 div（铺满视口底部的文字条），
// 用户看到的现象是"装了但角标没出现"。
//
// 这里用最小 DOM 桩执行脚本，断言"样式确实被注入且角标用了正确的 class"。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const INJECT_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'tools', 'companion', 'inject.js'),
  'utf8'
);

// ---- 最小 DOM 桩（只实现 inject.js 用到的能力） ----
function makeDom() {
  const byId = new Map();
  const created = [];

  class El {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = [];
      this.attributes = {};
      this.style = {};
      this.textContent = '';
      this.value = '';   // input/option 的取值（真实 DOM 中始终是字符串）
      this.className = '';
      this._id = '';
      this._listeners = {};
      this.innerHTML = '';
    }
    // 真实 DOM 中设置 id 后即可被 getElementById 找到；
    // el() 工厂正是"先 createElement，再赋 .id"的顺序，桩必须复刻。
    get id() { return this._id; }
    set id(v) { this._id = v; if (v) byId.set(v, this); }
    setAttribute(k, v) {
      this.attributes[k] = v;
      if (k === 'id') this.id = v;
      if (k === 'class') this.className = v;
    }
    getAttribute(k) {
      // 真实 DOM：未设置过的属性返回 null；class 也能通过 getAttribute 取到
      if (k === 'class') return this.className || null;
      return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null;
    }
    // classList：脚本用 add/remove/contains 管理悬浮兜底类名
    get classList() {
      const self = this;
      const read = () => String(self.className || '').split(/\s+/).filter(Boolean);
      const write = (list) => { self.className = list.join(' '); };
      return {
        add(...names) { const l = read(); for (const n of names) if (!l.includes(n)) l.push(n); write(l); },
        remove(...names) { write(read().filter((n) => !names.includes(n))); },
        contains(name) { return read().includes(name); },
        toggle(name, force) {
          const has = read().includes(name);
          const want = force === undefined ? !has : !!force;
          if (want) this.add(name); else this.remove(name);
          return want;
        }
      };
    }

    // 面板内容走 innerHTML。桩不做完整 HTML 解析，只把其中的标签名 + id="..." 抽成子元素
    // 并登记到 byId，使脚本随后的 querySelector('#id') / getElementById 能拿到同一节点。
    // 标签名必须保真：脚本会按 tagName 判断控件类型（如 SELECT vs INPUT）。
    set innerHTML(html) {
      this._html = String(html);
      const re = /<(\w+)([^>]*\bid="([^"]+)"[^>]*)>/g;
      let m;
      while ((m = re.exec(this._html)) !== null) {
        const tag = m[1];
        const id = m[3];
        if (!byId.has(id)) {
          const child = new El(tag);
          child.id = id;
          child._parent = this;
          this.children.push(child);
          byId.set(id, child);
        }
      }
    }
    get innerHTML() { return this._html || ''; }
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
    appendChild(c) {
      this.children.push(c);
      if (c && c.id) byId.set(c.id, c);
      if (c) c._parent = this;   // 供 remove() 脱离父节点
      return c;
    }
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      return c;
    }
    // 真实 DOM 的 insertBefore / firstChild：脚本用它们把「当前模型」插到首位
    insertBefore(node, ref) {
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i >= 0) this.children.splice(i, 0, node);
      else this.children.unshift(node);
      if (node && node.id) byId.set(node.id, node);
      if (node) node._parent = this;
      return node;
    }
    get firstChild() { return this.children[0] || null; }
    // 真实 DOM 的 parentNode；桩内部用 _parent 保存，这里提供标准属性名。
    // （脚本与断言都会读 parentNode，用别名而非两套字段避免不一致）
    get parentNode() { return this._parent || null; }
    // 令牌变化时脚本会移除旧元素；真实 DOM 中 remove() 会同时脱离父节点，
    // 桩必须复刻该行为（从父 children 摘除 + 清 id 索引），
    // 否则「清理旧角标」的逻辑在测试里看不出效果。
    remove() {
      for (const [k, v] of byId) if (v === this) byId.delete(k);
      if (this._parent && Array.isArray(this._parent.children)) {
        const i = this._parent.children.indexOf(this);
        if (i >= 0) this._parent.children.splice(i, 1);
      }
      return this;
    }
    // 面板用 innerHTML 生成内容，再用 querySelector('#id') 取子元素绑定事件。
    // 真实 DOM 中同一选择器每次返回**同一节点**，因此这里按 id 复用（否则
    // 脚本绑定的事件会落在每次新建的临时元素上，后续读取状态也拿不到）。
    // 类名选择器（锚点查找用）在 document 上统一处理，元素级只支持 #id。
    querySelector(sel) {
      if (typeof sel === 'string' && sel.startsWith('#')) {
        const id = sel.slice(1);
        return byId.get(id) || null;
      }
      return null;
    }
    querySelectorAll() { return []; }
  }

  const body = new El('body');
  const head = new El('head');

  // 锚点容器：脚本会把角标挂到 .chat-composer-input-surface 内的工具栏上。
  // 桩提供最小可用的类名索引，使「锚定到工具栏」这条路径可被测试（含兜底分支）。
  const anchorEls = new Map();   // selector -> element
  const registerAnchor = (selector, el) => { anchorEls.set(selector, el); return el; };

  const document = {
    body,
    head,
    documentElement: head,
    readyState: 'complete',
    createElement: (t) => { const e = new El(t); created.push(e); return e; },
    getElementById: (id) => byId.get(id) || null,
    querySelector: (sel) => anchorEls.get(sel) || null,
    querySelectorAll: () => [],
    addEventListener: () => {}
  };

  return { document, window: {}, byId, created, body, head, registerAnchor, anchorEls };
}

// 执行注入脚本，返回 DOM 桩。
// 注意：真实 controller 会对源码做字符串替换（__API_PORT__ / __TOKEN__），
// 因此这里也复刻替换，避免测试与生产路径不一致。
// opts.reuse：复用已有 DOM 桩（模拟"同一页面被重新注入"），此时 window 与元素索引都沿用。
function runInject(opts) {
  const o = opts || {};
  const dom = o.reuse || makeDom();
  const win = dom.window;
  const port = o.port != null ? o.port : 9420;
  const token = o.token != null ? o.token : 'test-token';

  const source = INJECT_SRC
    .replace(/__API_PORT__/g, String(port))
    .replace(/__TOKEN__/g, token)
    // 复刻 controller 的锚定模式替换（默认 composer）
    .replace(/__ANCHOR_MODE__/g, o.anchorMode === 'topbar' ? 'topbar' : 'composer');

  const fn = new Function(
    'document', 'window', 'setTimeout', 'console', 'fetch', '__API_PORT__', '__TOKEN__',
    'MutationObserver', 'requestAnimationFrame',
    source
  );
  const fetchStub = o.fetch || (async () => ({ json: async () => ({ ok: false }) }));
  // MutationObserver 桩：记录 observe 调用但不真正触发回调（行为由测试显式驱动）
  const observers = [];
  class MOStub {
    constructor(cb) { this.cb = cb; this.observed = null; observers.push(this); }
    observe(target, opts) { this.observed = { target, opts }; }
    disconnect() { this.observed = null; }
  }
  fn(dom.document, win, (f) => f(), console, fetchStub, port, token, MOStub, (f) => f());
  dom.fetch = fetchStub;
  dom.observers = observers;
  return dom;
}

// ---------------- 核心回归：样式必须被注入 ----------------

test('inject.js：样式表被真实注入文档（回归：曾只定义 css 常量而不插入）', () => {
  const dom = runInject();
  const styles = dom.created.filter((e) => e.tagName === 'STYLE');
  assert.ok(styles.length > 0, '必须创建 <style> 元素——否则角标是无样式裸 div，用户看不到');

  const zca = styles.find((s) => s.id === 'zca-style') || styles[0];
  assert.ok(zca.textContent.includes('.zca-badge'), '样式内容应含 .zca-badge 规则');
  // 新设计：角标锚定在输入框工具栏内（不是悬浮球），因此断言内联布局规则；
  // 仅在找不到锚点时才退回 .zca-floating 的 fixed 兜底。
  assert.ok(zca.textContent.includes('align-items:center'), '角标应为内联 flex 布局');
  assert.ok(zca.textContent.includes('.zca-floating'), '应保留找不到锚点时的悬浮兜底样式');
  assert.ok(zca.textContent.includes('z-index:2147483001'), '面板必须有高层级 z-index');

  // 必须挂到 head（而非游离节点）
  assert.ok(
    dom.head.children.includes(zca) || dom.body.children.includes(zca),
    'style 元素必须挂到 head 或 body 上'
  );
});

test('inject.js：样式注入幂等（重复执行不产生多个 style）', () => {
  const dom = runInject();
  // 模拟脚本被再次注入：重置标志后重跑
  const fn = new Function(
    'document', 'window', 'setTimeout', 'console', 'fetch', '__API_PORT__', '__TOKEN__', INJECT_SRC
  );
  dom.window.__zcodeAdvisorInjected = false;
  fn(dom.document, dom.window, dom.setTimeout, dom.console, dom.fetch, 9420, 't');
  const styles = dom.created.filter((e) => e.tagName === 'STYLE' && e.id === 'zca-style');
  assert.strictEqual(styles.length, 1, '同一文档只应有一个 zca-style');
});

// ---------------- 角标本身 ----------------

test('inject.js：角标元素存在、带 zca-badge class、可点击', () => {
  const dom = runInject();
  const badge = dom.byId.get('zca-badge');
  assert.ok(badge, '应创建 #zca-badge');
  assert.ok(String(badge.className).split(/\s+/).includes('zca-badge'),
    `必须带 zca-badge class（否则样式不生效），实际 className=${badge.className}`);
  // 图标改为内联 SVG（与 ZCode 原生图标风格一致），不再是 emoji 文本
  assert.match(badge.innerHTML, /<svg/, '角标应含内联 SVG 图标');
  assert.strictEqual(badge.getAttribute('role'), 'button', '应有 button 语义（可访问性）');
  assert.ok((badge._listeners.click || []).length > 0, '角标应绑定点击事件');
  assert.ok((badge._listeners.keydown || []).length > 0, '应支持键盘激活');
});

test('inject.js：点击角标创建面板，面板带 zca-panel class', () => {
  const dom = runInject();
  const badge = dom.byId.get('zca-badge');
  badge._listeners.click[0]();
  const panel = dom.byId.get('zca-panel');
  assert.ok(panel, '点击后应创建 #zca-panel');
  assert.strictEqual(panel.className, 'zca-panel', '面板必须带 zca-panel class');
});

test('inject.js：面板含配置字段与操作按钮（端点/key/模型/模式/max_tokens + 保存/Ping/拉取）', () => {
  const dom = runInject();
  dom.byId.get('zca-badge')._listeners.click[0]();
  const panel = dom.byId.get('zca-panel');
  const html = panel.innerHTML;
  for (const id of ['zca-baseUrl', 'zca-apiKey', 'zca-model', 'zca-reviewMode', 'zca-maxTokens',
    'zca-save', 'zca-ping', 'zca-models', 'zca-msg', 'zca-status', 'zca-close']) {
    assert.ok(html.includes(id), `面板应包含 #${id}`);
  }
});

// ---------------- 注入防护 ----------------

test('inject.js：重复注入时立即返回（同令牌幂等）', () => {
  const dom = runInject();
  const before = dom.body.children.length;
  assert.ok(dom.window.__zcodeAdvisorInjected, '首次执行应置位守卫标志');
  assert.strictEqual(dom.window.__zcodeAdvisorToken, 'test-token', '应记录令牌版本');

  // 第二次执行：同一 window + 同一令牌 → 守卫应直接返回
  runInject({ reuse: dom, port: 9420, token: 'test-token' });
  assert.strictEqual(dom.body.children.length, before, '同令牌下守卫应阻止重复插入');
});

test('inject.js：令牌变化时重建注入（回归：controller 重启后面板 403）', () => {
  // 回归背景：controller 重启会生成新令牌，而旧脚本的守卫（只看布尔量）会挡住新脚本，
  // 页面继续用过期令牌调 API → 403 bad_token → 面板显示"无法连接本机 controller"。
  const dom = runInject({ token: 'token-1' });
  const firstBadge = dom.byId.get('zca-badge');
  assert.ok(firstBadge, '首次应创建角标');
  assert.strictEqual(dom.window.__zcodeAdvisorToken, 'token-1');

  // 用新令牌再次注入（模拟 controller 重启后重新注入，复用同一 window）
  const dom2 = runInject({ reuse: dom, port: 9421, token: 'token-2' });

  assert.strictEqual(dom.window.__zcodeAdvisorToken, 'token-2', '令牌应更新为新值');
  // 旧元素应被清理，新角标应存在且唯一
  const badges = dom.body.children.filter((c) => c.id === 'zca-badge');
  assert.strictEqual(badges.length, 1, '不应叠加出多个角标');
  assert.notStrictEqual(badges[0], firstBadge, '应是新建的角标（旧令牌的实例已被移除）');

  // 样式唯一性要看**实际挂载的节点**（byId / head.children），
  // 而不是 created 数组——后者累积了两次执行的创建记录，不代表当前 DOM 状态。
  const mountedStyles = dom.head.children.filter((c) => c.id === 'zca-style');
  assert.strictEqual(mountedStyles.length, 1, 'DOM 中应只有一个 zca-style');
  assert.strictEqual(dom.byId.get('zca-badge'), badges[0], 'byId 应指向当前角标');
  assert.ok(dom.byId.get('zca-style'), 'byId 应有 zca-style');
});

test('inject.js：API 地址与令牌由占位符注入（与 controller 的替换路径一致）', () => {
  assert.ok(INJECT_SRC.includes('__API_PORT__'), '源码应含 __API_PORT__ 占位符');
  assert.ok(INJECT_SRC.includes('__TOKEN__'), '源码应含 __TOKEN__ 占位符');

  // 替换后不得残留占位符，且令牌要能透出到 window（用于版本判断）
  const dom = runInject({ port: 9999, token: 'abc123' });
  assert.strictEqual(dom.window.__zcodeAdvisorToken, 'abc123');
  assert.ok(dom.byId.get('zca-badge'), '脚本应执行完毕并挂载角标');
});

// ---------------- 模型下拉（datalist）回归 ----------------

test('inject.js：fetchModels 把候选写入原生 select（回归：下拉拉不下来）', async () => {
  // 回归背景一：早期实现把 <option> 塞进 <input list=datalist> 的 input 自身
  //   —— input 不渲染子元素，候选从未生效。
  // 回归背景二：改用 datalist 后仍不可用——实测 Chromium 对 datalist 的下拉
  //   只能由真实用户手势触发（程序化 input.showPicker() 报
  //   NotAllowedError: requires a user gesture），用户表现为"点不动"。
  // 最终方案：原生 <select>（点击必定展开）+ 手动输入兜底。
  const models = ['deepseek-v4.1-flash', 'glm-5.3'];
  const fetchStub = async (url) => ({
    json: async () => (String(url).includes('/api/models')
      ? { ok: true, models }
      : { ok: false })
  });

  const dom = runInject({ fetch: fetchStub });
  dom.byId.get('zca-badge')._listeners.click[0]();
  const panel = dom.byId.get('zca-panel');

  const btn = panel.querySelector('#zca-models');
  assert.ok(btn, '面板应有拉取按钮');
  await btn._listeners.click[0]();

  // 关键断言：select 被填充为可选项，且是 SELECT 元素
  const sel = dom.byId.get('zca-model');
  assert.ok(sel, '应存在 #zca-model');
  assert.strictEqual(sel.tagName, 'SELECT', '模型控件必须是原生 SELECT（datalist 下拉不可靠）');
  const options = sel.children.filter((c) => c.tagName === 'OPTION');
  assert.strictEqual(options.length, models.length, '候选应写入 select 的 option');
  assert.deepStrictEqual(options.map((o) => o.value), models);

  // 选中值应为候选之一
  assert.ok(models.includes(sel.value), `select 值应为候选之一，实际 ${sel.value}`);

  // 手动输入框应被清空（避免两个来源冲突）
  const manual = dom.byId.get('zca-model-manual');
  assert.ok(manual, '应保留手动输入兜底控件');
  assert.strictEqual(manual.value, '', '拉取成功后手动输入应清空');
});

test('inject.js：手动输入的模型 id 会进入保存载荷（端点不支持 /models 时的兜底）', async () => {
  const saved = [];
  // 直接注入带记录能力的 fetch：保存请求走 /api/config
  const fetchStub = async (url, opt) => {
    if (String(url).includes('/api/config')) {
      saved.push(JSON.parse(opt.body));
      return { json: async () => ({ ok: true, file: '/tmp/x.json' }) };
    }
    return { json: async () => ({ ok: false, error: 'http_404' }) };
  };

  const dom = runInject({ fetch: fetchStub });
  dom.byId.get('zca-badge')._listeners.click[0]();   // 打开面板
  const panel = dom.byId.get('zca-panel');

  // 模拟"端点不支持 /models"：手动填写模型 id
  dom.byId.get('zca-model-manual').value = 'my-custom-model';

  const saveBtn = panel.querySelector('#zca-save');
  assert.ok(saveBtn, '应有保存按钮');
  await saveBtn._listeners.click[0]();

  assert.ok(saved.length > 0, '应发出保存请求');
  assert.strictEqual(saved[0].model, 'my-custom-model', '手动输入的模型 id 应进入保存载荷');
});

test('inject.js：refreshStatus 在 403 bad_token 时给出可操作提示（回归：卡在"读取中…"）', async () => {
  // 回归背景：r.ok===false 被静默 return，面板永久停在"读取中…"，用户毫无线索。
  const fetchStub = async (url) => ({
    json: async () => (String(url).includes('/api/config')
      ? { ok: false, error: 'bad_token' }
      : { ok: false })
  });

  const dom = runInject({ fetch: fetchStub });
  dom.byId.get('zca-badge')._listeners.click[0]();   // 打开面板会触发 refreshStatus
  await new Promise((r) => setTimeout(r, 30));

  const msgEl = dom.byId.get('zca-msg');
  assert.ok(msgEl, '应有消息元素');
  assert.match(msgEl.textContent, /刷新/, 'bad_token 应提示刷新页面这一可操作动作');
  assert.strictEqual(msgEl.className, 'zca-msg zca-bad', '应以错误样式展示');

  const st = dom.byId.get('zca-status');
  assert.ok(!/读取中/.test(st.textContent), '不应停留在"读取中"，应给出失败原因');
});

test('inject.js：当前模型不在拉取列表时保留原选择（不静默改成列表首项）', async () => {
  // 回归（advisor 指出）：早期实现插入「（当前）」条目后却把 sel.value 设为 r.models[0]，
  // 并把手动输入清空——用户已配置的模型被静默替换，保存后审查模型就变了。
  const models = ['aaa-flash', 'bbb-flash'];   // 不含用户当前模型
  const fetchStub = async (url) => ({
    json: async () => (String(url).includes('/api/models')
      ? { ok: true, models }
      : { ok: false })
  });

  const dom = runInject({ fetch: fetchStub });
  dom.byId.get('zca-badge')._listeners.click[0]();
  const panel = dom.byId.get('zca-panel');

  // 用户先手动填一个不在列表里的模型
  dom.byId.get('zca-model-manual').value = 'my-special-model';

  await panel.querySelector('#zca-models')._listeners.click[0]();

  const sel = dom.byId.get('zca-model');
  assert.strictEqual(sel.value, 'my-special-model', '应保留用户当前模型，而不是改成列表首项');
  assert.strictEqual(dom.byId.get('zca-model-manual').value, 'my-special-model',
    '保留选择时不应清空手动输入（否则两边不一致）');
  // 保留项应作为首项出现且标注
  const first = sel.children[0];
  assert.strictEqual(first.value, 'my-special-model');
  assert.match(first.textContent, /当前/);
});

test('inject.js：当前模型在列表内时正常选中该模型并清空手动输入', async () => {
  const models = ['aaa-flash', 'bbb-flash'];
  const fetchStub = async (url) => ({
    json: async () => (String(url).includes('/api/models')
      ? { ok: true, models }
      : { ok: false })
  });

  const dom = runInject({ fetch: fetchStub });
  dom.byId.get('zca-badge')._listeners.click[0]();
  const panel = dom.byId.get('zca-panel');

  dom.byId.get('zca-model-manual').value = 'bbb-flash';   // 当前模型在列表内
  await panel.querySelector('#zca-models')._listeners.click[0]();

  const sel = dom.byId.get('zca-model');
  assert.strictEqual(sel.value, 'bbb-flash');
  assert.strictEqual(dom.byId.get('zca-model-manual').value, '', '在列表内时应清空手动输入');
  assert.strictEqual(sel.children.length, models.length, '不应额外插入保留项');
});

// ---------------- UI 锚定（本次 UI/UX 优化） ----------------

test('inject.js：角标锚定到输入框工具栏（而非悬浮），命中锚点时无 floating 类', () => {
  const dom = makeDom();
  // 注册锚点容器
  const toolbar = dom.document.createElement('div');
  toolbar.className = 'ml-auto';
  dom.registerAnchor('.chat-composer-input-surface .ml-auto.flex.shrink-0.items-center.justify-end', toolbar);

  runInject({ reuse: dom });
  const badge = dom.byId.get('zca-badge');
  assert.ok(badge, '应创建角标');
  assert.strictEqual(badge.parentNode, toolbar, '角标应挂到工具栏锚点内（这就是"固定在图标右侧"）');
  assert.ok(!String(badge.className).includes('zca-floating'), '命中锚点时不应加悬浮兜底类');
});

test('inject.js：找不到锚点时退回悬浮兜底（仍可用）', () => {
  const dom = makeDom();   // 不注册任何锚点
  runInject({ reuse: dom });
  const badge = dom.byId.get('zca-badge');
  assert.ok(badge, '应创建角标');
  assert.strictEqual(badge.parentNode, dom.body, '无锚点时应挂到 body');
  assert.ok(String(badge.className).includes('zca-floating'), '应加浮动兜底类，保证仍可见可用');
});

test('inject.js：注册了 MutationObserver 监听容器重建（角标被移除后自动重建）', () => {
  const dom = makeDom();
  const toolbar = dom.document.createElement('div');
  dom.registerAnchor('.chat-composer-input-surface', toolbar);
  runInject({ reuse: dom });

  assert.ok(dom.observers.length > 0, '应注册 MutationObserver');
  const obs = dom.observers[0];
  assert.ok(obs.observed, '应调用 observe');
  assert.strictEqual(obs.observed.opts.childList, true, '需监听子树变化');
  assert.strictEqual(obs.observed.opts.subtree, true, '需监听深层子树（React 重建容器）');

  // 模拟容器重建：角标被移除 → 触发回调 → 应重建角标
  dom.byId.get('zca-badge').remove();
  assert.strictEqual(dom.byId.get('zca-badge'), undefined, '角标应已被移除（模拟重建）');
  obs.cb();   // 手动触发观察回调
  assert.ok(dom.byId.get('zca-badge'), '回调后应自动重建角标');
});

// ---------------- 锚定位置可切换（单一配置点） ----------------

test('inject.js：默认模式为输入框工具栏（composer），角标为纯图标', () => {
  const dom = makeDom();
  const toolbar = dom.document.createElement('div');
  dom.registerAnchor('.chat-composer-input-surface .ml-auto.flex.shrink-0.items-center.justify-end', toolbar);
  runInject({ reuse: dom, anchorMode: 'composer' });

  const badge = dom.byId.get('zca-badge');
  assert.ok(badge, '应创建角标');
  assert.strictEqual(badge.parentNode, toolbar, 'composer 模式应挂到工具栏');
  assert.ok(!String(badge.className).includes('zca-topbar-badge'), 'composer 模式不应带 topbar 样式');
  assert.ok(!badge.innerHTML.includes('zca-label-text'), 'composer 模式只放图标（与相邻原生图标一致）');
});

test('inject.js：topbar 模式把角标钉在窗口上边（带文字标签 + 包裹容器）', () => {
  const dom = makeDom();
  const header = dom.document.createElement('header');
  dom.registerAnchor('main > header', header);
  runInject({ reuse: dom, anchorMode: 'topbar' });

  const badge = dom.byId.get('zca-badge');
  assert.ok(badge, '应创建角标');
  // 应包一层 wrapper 并挂在 header 里
  const wrapper = dom.byId.get('zca-topbar');
  assert.ok(wrapper, '应创建 topbar 包裹容器');
  assert.strictEqual(wrapper.parentNode, header, '包裹容器应挂在顶部锚点内');
  assert.strictEqual(badge.parentNode, wrapper, '角标应在包裹容器内');
  assert.ok(String(badge.className).includes('zca-topbar-badge'), '应带 topbar 样式');
  assert.ok(badge.innerHTML.includes('zca-label-text'), 'topbar 模式带文字标签，便于识别');
});

test('inject.js：window.__ZCODE_ADVISOR_ANCHOR 可覆盖模式（便于试用另一种位置）', () => {
  const dom = makeDom();
  const header = dom.document.createElement('header');
  dom.registerAnchor('main > header', header);
  // 注入前在 window 上声明覆盖
  dom.window.__ZCODE_ADVISOR_ANCHOR = 'topbar';
  runInject({ reuse: dom, anchorMode: 'composer' });   // 注入期值是 composer，但运行时覆盖为 topbar

  const badge = dom.byId.get('zca-badge');
  assert.ok(badge, '应创建角标');
  assert.ok(dom.byId.get('zca-topbar'), '运行时覆盖应优先于注入期默认值');
});

// ---------------- 端点归一化：controller 与 hook 两端规则一致 ----------------
// 用户实测报告 Ping 404：配置 baseUrl 填 `http://host:port/v1`（面板 placeholder 就是这么引导的），
// controller.ping() 直接 POST 该地址 → 打到 /v1 本身 → 404。
// 这里锁住两端规则一致，避免只修一处造成行为漂移。

test('controller / reviewer 的端点归一化规则一致（修复 Ping 404）', () => {
  const ctrl = require('../tools/companion/controller.cjs');
  const { normalizeChatEndpoint: hookNorm } = require('../hooks/lib/reviewer.js');
  const ctrlNorm = ctrl.normalizeChatEndpoint;

  const cases = [
    'http://192.168.50.139:8788/v1',
    'http://192.168.50.139:8788/v1/chat/completions',
    'https://open.bigmodel.cn/api/paas/v4',
    'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    'https://x.com/v1/',
    ''
  ];
  for (const c of cases) {
    assert.strictEqual(ctrlNorm(c), hookNorm(c), `两端对 ${JSON.stringify(c)} 的归一化应一致`);
  }
  // 关键行为：基地址必须补全
  assert.strictEqual(ctrlNorm('http://192.168.50.139:8788/v1'),
    'http://192.168.50.139:8788/v1/chat/completions', '基地址应补全路径');
});

// ---------------- 顾问总开关（startEnabled 往返） ----------------

test('inject.js：面板含顾问开关，且随保存载荷提交 startEnabled', async () => {
  const saved = [];
  const fetchStub = async (url, opt) => {
    if (String(url).includes('/api/config')) {
      saved.push(JSON.parse((opt && opt.body) || '{}'));
      return { json: async () => ({ ok: true, file: '/tmp/x.json' }) };
    }
    return { json: async () => ({ ok: false }) };
  };
  const dom = runInject({ fetch: fetchStub });
  dom.byId.get('zca-badge')._listeners.click[0]();
  const panel = dom.byId.get('zca-panel');

  const en = dom.byId.get('zca-enabled');
  assert.ok(en, '面板应有顾问开关 #zca-enabled');
  en.checked = false;   // 关闭
  await panel.querySelector('#zca-save')._listeners.click[0]();
  // /api/config 会被多次调用（refreshStatus 与 save 都走它），
  // 带非空 body 的那次才是保存请求——不能断言 saved[0]。
  const savePayloads = saved.filter((p) => Object.keys(p).length > 0);
  assert.ok(savePayloads.length > 0, '应发出保存请求');
  assert.strictEqual(savePayloads[savePayloads.length - 1].startEnabled, false, '关闭状态应进入保存载荷');
});

test('inject.js：发行包 payload 与 auto-enable 脚本就位（自动启用载体）', () => {
  const fs2 = require('fs');
  const path2 = require('path');
  const root = path2.join(__dirname, '..');
  // auto-enable 脚本存在
  assert.ok(fs2.existsSync(path2.join(root, 'tools/companion/auto-enable.cjs')), 'auto-enable.cjs 应存在');
  // build-installer 会把 plugin payload 打进发行包（stagePluginPayload 条目清单）
  const bi = fs2.readFileSync(path2.join(root, 'tools/companion/build-installer.cjs'), 'utf8');
  assert.match(bi, /stagePluginPayload/, '构建脚本应调用 stagePluginPayload');
  assert.match(bi, /auto-enable\.cjs/, '构建脚本应打包 auto-enable');
  // NSIS 安装后自动执行（ExecWait 在 packagers 的 NSIS 模板里）
  const pk = fs2.readFileSync(path2.join(root, 'tools/companion/packagers.cjs'), 'utf8');
  assert.match(pk, /ExecWait/, 'NSIS 应在安装后执行自动启用');
});

// ---------------- API 来源（zcode / manual）与面板结构重构 ----------------

test('inject.js：启用开关在面板正文首行（不在 h3 标题栏内），API 来源分段与高级折叠区齐备', () => {
  const dom = runInject();
  dom.byId.get('zca-badge')._listeners.click[0]();
  const html = dom.byId.get('zca-panel').innerHTML;
  // 回归：旧版把启用 checkbox 嵌在 h3 里，紧挨关闭按钮——难点中、位置不对
  const h3 = html.slice(html.indexOf('<h3'), html.indexOf('</h3>'));
  assert.ok(!h3.includes('zca-enabled'), 'h3 标题栏不应包含启用开关');
  assert.ok(html.includes('zca-toggle-row'), '启用开关应有独立行容器');
  assert.ok(html.indexOf('zca-toggle-row') < html.indexOf('zca-apiSource'), '开关行应位于 API 来源分段之前');
  for (const id of ['zca-apiSource', 'zca-src-zcode', 'zca-src-manual', 'zca-zcode-provider',
    'zca-zcode-model', 'zca-zcode-sec', 'zca-manual-sec', 'zca-zcode-endpoint', 'zca-adv']) {
    assert.ok(html.includes(id), `面板应包含 #${id}`);
  }
});

test('inject.js：zcode 模式保存载荷带服务商/模型，不回传手动端点字段', async () => {
  const saved = [];
  const providers = [{
    id: 'p1', name: '内网网关', kind: 'openai-compatible',
    baseURL: 'http://10.0.0.8:8088/v1', models: ['m-a', 'm-b'], eligible: true, hasApiKey: true
  }];
  const fetchStub = async (url, opt) => {
    const u = String(url);
    if (u.includes('/api/config')) {
      saved.push(JSON.parse(opt.body));
      return { json: async () => ({ ok: true, file: '/tmp/x.json' }) };
    }
    if (u.includes('/api/zcode-providers')) return { json: async () => ({ ok: true, providers }) };
    return { json: async () => ({ ok: false }) };
  };
  const dom = runInject({ fetch: fetchStub });
  dom.byId.get('zca-badge')._listeners.click[0]();
  await new Promise((r) => setTimeout(r, 10));
  // 切到 zcode 模式 → loadProviders 异步拉取 → 服务商/模型下拉被填充
  dom.byId.get('zca-src-zcode')._listeners.click[0]();
  await new Promise((r) => setTimeout(r, 10));
  const psel = dom.byId.get('zca-zcode-provider');
  assert.strictEqual(psel.value, 'p1', '唯一合格服务商应被选中');
  const msel = dom.byId.get('zca-zcode-model');
  assert.strictEqual(msel.value, 'm-a', '模型默认取列表首项');
  msel.value = 'm-b';
  await dom.byId.get('zca-save')._listeners.click[0]();
  const payload = saved[saved.length - 1];
  assert.strictEqual(payload.apiSource, 'zcode');
  assert.strictEqual(payload.zcodeProvider, 'p1');
  assert.strictEqual(payload.zcodeModel, 'm-b');
  assert.strictEqual(payload.baseUrl, undefined, 'zcode 模式不回传手动端点（保留既有手动配置）');
  assert.strictEqual(payload.model, undefined, 'zcode 模式不回传手动模型字段');
});

test('inject.js：手动模式保存载荷与旧行为一致（apiSource=manual）', async () => {
  const saved = [];
  const fetchStub = async (url, opt) => {
    if (String(url).includes('/api/config')) {
      saved.push(JSON.parse(opt.body));
      return { json: async () => ({ ok: true, file: '/tmp/x.json' }) };
    }
    return { json: async () => ({ ok: false }) };
  };
  const dom = runInject({ fetch: fetchStub });
  dom.byId.get('zca-badge')._listeners.click[0]();
  dom.byId.get('zca-baseUrl').value = 'http://manual.example/v1';
  dom.byId.get('zca-model-manual').value = 'm-manual';
  await dom.byId.get('zca-save')._listeners.click[0]();
  const payload = saved[saved.length - 1];
  assert.strictEqual(payload.apiSource, 'manual');
  assert.strictEqual(payload.baseUrl, 'http://manual.example/v1');
  assert.strictEqual(payload.model, 'm-manual');
  assert.strictEqual(payload.zcodeProvider, undefined);
});

test('inject.js：zcode 服务商列表不含合格项时给出占位提示（不静默空白）', async () => {
  const fetchStub = async (url) => ({
    json: async () => (String(url).includes('/api/zcode-providers')
      ? { ok: true, providers: [{ id: 'ant', name: 'Anthropic 中转', kind: 'anthropic', baseURL: 'https://r', models: ['c'], eligible: false }] }
      : { ok: false })
  });
  const dom = runInject({ fetch: fetchStub });
  dom.byId.get('zca-badge')._listeners.click[0]();
  await new Promise((r) => setTimeout(r, 10));
  dom.byId.get('zca-src-zcode')._listeners.click[0]();
  await new Promise((r) => setTimeout(r, 10));
  const psel = dom.byId.get('zca-zcode-provider');
  assert.match(psel.children[0].textContent, /暂无 OpenAI 兼容服务商/);
  assert.strictEqual(psel.value, '');
});
