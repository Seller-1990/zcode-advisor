'use strict';

// companion 纯函数库：模型端点推导与响应解析（供 controller 与单测共用）。

// 由 chat/completions 端点推导 /models 端点：
//   https://x/v1/chat/completions -> https://x/v1/models
//   https://x/v1                  -> https://x/v1/models
//   https://x/api/paas/v4/chat/completions -> https://x/api/paas/v4/models
function modelsUrl(baseUrl) {
  let u = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  u = u.replace(/\/chat\/completions$/i, '');
  u = u.replace(/\/messages$/i, ''); // Anthropic 协议端点
  if (!/\/models$/i.test(u)) u += '/models';
  return u;
}

// 解析模型列表响应，兼容多种信封：
//   OpenAI:   {"data":[{"id":"gpt-x"},...]}
//   数组:     [{"id":"..."},...] 或 ["model-id",...]
//   变体:     {"models":[{"id"/"name"/"model":...}]}
// 解析不出模型数组时返回 {ok:false,error:'unexpected_envelope'}（调用方降级为手动输入）。
function parseModels(payload) {
  let arr = null;
  if (Array.isArray(payload)) arr = payload;
  else if (payload && Array.isArray(payload.data)) arr = payload.data;
  else if (payload && Array.isArray(payload.models)) arr = payload.models;
  if (!arr) return { ok: false, error: 'unexpected_envelope' };

  const ids = [];
  for (const it of arr) {
    const id = typeof it === 'string' ? it : (it && (it.id || it.name || it.model));
    if (typeof id === 'string' && id.trim()) ids.push(id.trim());
  }
  if (ids.length === 0) return { ok: false, error: 'empty_model_list' };
  return { ok: true, models: [...new Set(ids)].sort((a, b) => a.localeCompare(b)) };
}

module.exports = { modelsUrl, parseModels };
