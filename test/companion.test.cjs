'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { modelsUrl, parseModels } = require('../tools/companion/lib.cjs');

test('modelsUrl：从 chat/completions、裸 v1、Anthropic messages 推导 /models', () => {
  assert.strictEqual(modelsUrl('https://x.com/v1/chat/completions'), 'https://x.com/v1/models');
  assert.strictEqual(modelsUrl('https://x.com/v1'), 'https://x.com/v1/models');
  assert.strictEqual(modelsUrl('https://open.bigmodel.cn/api/paas/v4/chat/completions'), 'https://open.bigmodel.cn/api/paas/v4/models');
  assert.strictEqual(modelsUrl('https://gw.example.com/api/anthropic/messages'), 'https://gw.example.com/api/anthropic/models');
  assert.strictEqual(modelsUrl('https://x.com/v1/chat/completions/'), 'https://x.com/v1/models'); // 尾斜杠
  assert.strictEqual(modelsUrl(''), '');
});

test('parseModels：OpenAI 信封', () => {
  const r = parseModels({ data: [{ id: 'glm-5.3' }, { id: 'glm-5.3-flash' }, { id: 'glm-5.3' }] });
  assert.deepStrictEqual(r, { ok: true, models: ['glm-5.3', 'glm-5.3-flash'] }); // 去重+排序
});

test('parseModels：字符串数组与 models 信封', () => {
  assert.deepStrictEqual(parseModels(['b', 'a']).models, ['a', 'b']);
  assert.deepStrictEqual(parseModels({ models: [{ name: 'm1' }, { model: 'm2' }] }).models, ['m1', 'm2']);
});

test('parseModels：空列表与未知信封降级（调用方提示手动输入）', () => {
  assert.strictEqual(parseModels({ data: [] }).ok, false);
  assert.strictEqual(parseModels({ error: 'nope' }).error, 'unexpected_envelope');
  assert.strictEqual(parseModels(null).error, 'unexpected_envelope');
});
