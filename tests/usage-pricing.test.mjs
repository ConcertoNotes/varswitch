import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDERS, buildPricingSnapshot } from '../scripts/update-usage-pricing.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function api(overrides) {
  const base = Object.fromEntries(PROVIDERS.map(([id]) => [id, { models: {} }]));
  for (const [id, models] of Object.entries(overrides)) base[id] = { models };
  return base;
}

test('models.dev snapshot keeps first-party prices, tiers and unknown cache rates', () => {
  const snapshot = buildPricingSnapshot(api({
    anthropic: {
      'claude-haiku-5-5': {
        canonical_model_id: 'anthropic/claude-haiku-5-5',
        cost: {
          input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125,
          tiers: [{ input: 0.5, output: 2.5, cache_read: 0.05, cache_write: 0.625, tier: { type: 'context', size: 100000 } }],
        },
      },
    },
    openai: { 'gpt-5.5': { cost: { input: 5, output: 30, cache_read: 0.5 } } },
    minimax: { 'MiniMax-M3': { cost: { input: 0.3, output: 1.2 } } },
    alibaba: {
      // 托管别家模型按托管价计费，不能顶替原厂价
      'kimi-k3': { canonical_model_id: 'moonshotai/kimi-k3', cost: { input: 9, output: 9 } },
      // 已由前面的厂商收录，先到先得
      'gpt-5.5': { cost: { input: 99, output: 99 } },
      'qwen-max': { canonical_model_id: 'alibaba/qwen-max', cost: { input: 1.6, output: 6.4 } },
      'no-price': {},
    },
    volcengine: {
      'doubao-seed-2-1-pro-260628': { canonical_model_id: 'bytedance-seed/seed-2.1-pro', cost: { input: 0.5, output: 2 } },
      'deepseek-v4-pro-ga-260813': { canonical_model_id: 'deepseek/deepseek-v4-pro-0813', cost: { input: 1, output: 1 } },
    },
  }), { date: '2026-10-26' });

  assert.equal(snapshot.source, 'https://models.dev');
  assert.equal(snapshot.date, '2026-10-26');
  const byId = Object.fromEntries(snapshot.models.map((m) => [m.model, m]));
  assert.deepEqual(Object.keys(byId).sort(), ['claude-haiku-5-5', 'doubao-seed-2-1-pro-260628', 'gpt-5.5', 'minimax-m3', 'qwen-max']);
  assert.deepEqual(byId['claude-haiku-5-5'].rates, { input: 0.1, output: 0.5, cacheRead: 0.01, cacheCreation: 0.125, cacheCreation1h: 0.2 });
  assert.deepEqual(byId['claude-haiku-5-5'].tiers, [{ above: 100000, rates: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheCreation: 0.625, cacheCreation1h: 1 } }]);
  assert.equal(byId['gpt-5.5'].provider, 'openai');
  assert.equal(byId['gpt-5.5'].rates.input, 5);
  assert.equal(byId['gpt-5.5'].rates.cacheCreation, null);
  assert.equal(byId['gpt-5.5'].rates.cacheCreation1h, null);
  assert.equal(byId['minimax-m3'].rates.cacheRead, null);
});

test('models.dev snapshot rejects missing providers and unknown tier kinds', () => {
  const missing = api({});
  delete missing.openai;
  assert.throws(() => buildPricingSnapshot(missing), /缺少厂商 openai/);
  assert.throws(() => buildPricingSnapshot(api({
    openai: { 'gpt-x': { cost: { input: 1, output: 1, tiers: [{ input: 2, output: 2, tier: { type: 'time', size: 9 } }] } } },
  })), /无法识别的分档/);
});

test('bundled usage pricing is the generated models.dev snapshot', () => {
  const bundled = JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri/src/usage-pricing.json'), 'utf8'));
  assert.equal(bundled.source, 'https://models.dev');
  assert.deepEqual(bundled.providers, PROVIDERS.map(([id]) => id));
  assert.match(bundled.sourceSha256, /^[0-9a-f]{64}$/);
  for (const model of bundled.models) {
    assert.equal(model.model, model.model.toLowerCase());
    assert.ok(PROVIDERS.some(([id]) => id === model.provider), model.model);
  }
});
