#!/usr/bin/env node
// 从 models.dev 生成用量监控内置价格快照 src-tauri/src/usage-pricing.json。
// 用法：node scripts/update-usage-pricing.mjs [本地 api.json 路径]
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(ROOT, 'src-tauri', 'src', 'usage-pricing.json');
export const MODELS_DEV_API = 'https://models.dev/api.json';

// 只取厂商第一方定价，按顺序先到先得。第二列是允许的 canonical_model_id 厂商前缀：
// 厂商托管别家模型（如阿里云上的 kimi-k3）时 canonical 指向原厂，按托管价计费不可取。
export const PROVIDERS = [
  ['anthropic', ['anthropic']],
  ['openai', ['openai']],
  ['google', ['google']],
  ['xai', ['xai']],
  ['deepseek', ['deepseek']],
  ['moonshotai', ['moonshotai']],
  ['zhipuai', ['zhipuai']],
  ['minimax', ['minimax']],
  ['mistral', ['mistral']],
  ['alibaba', ['alibaba']],
  ['stepfun', ['stepfun']],
  ['xiaomi', ['xiaomi']],
  ['volcengine', ['bytedance-seed']],
  ['cohere', ['cohere']],
];

const NOTES = [
  'Prices are models.dev first-party provider list prices in USD per million tokens; no reseller multiplier, account discount, tax or historical price change is applied.',
  'input is fresh input only; cacheRead and cacheCreation are billed separately. Missing cache prices are null (unknown), never zero.',
  'models.dev does not list 1-hour cache writes; for anthropic entries cacheCreation1h = 2 x input, per Anthropic pricing. Other providers keep null.',
  'tiers come from cost.tiers with tier.type = context: a request whose prompt (fresh input + cache read + cache write) is greater than above uses that tier. The highest exceeded tier wins.',
  'Not applied: reasoning (thinking tokens are billed as output), audio prices, fast/priority modes, regional surcharges.',
];

const price = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);

function toRates(cost, providerId) {
  const input = price(cost.input);
  const output = price(cost.output);
  if (input == null || output == null) return null;
  return {
    input,
    output,
    cacheRead: price(cost.cache_read),
    cacheCreation: price(cost.cache_write),
    cacheCreation1h: providerId === 'anthropic' ? input * 2 : null,
  };
}

export function buildPricingSnapshot(api, { date, sha256 } = {}) {
  const models = [];
  const seen = new Set();
  for (const [providerId, vendors] of PROVIDERS) {
    const provider = api[providerId];
    if (!provider?.models) throw new Error(`models.dev 缺少厂商 ${providerId}`);
    const entries = Object.entries(provider.models).sort(([a], [b]) => a.localeCompare(b));
    for (const [rawId, model] of entries) {
      const id = rawId.trim().toLowerCase();
      const vendor = model.canonical_model_id?.split('/')[0];
      if (!model.cost || !id || id.includes('/') || seen.has(id)) continue;
      if (vendor && !vendors.includes(vendor)) continue;
      const rates = toRates(model.cost, providerId);
      if (!rates) continue;
      const tiers = (model.cost.tiers || []).map((tier) => {
        const size = tier?.tier?.size;
        if (tier?.tier?.type !== 'context' || !Number.isInteger(size) || size <= 0) {
          throw new Error(`${providerId}/${rawId}: 无法识别的分档 ${JSON.stringify(tier?.tier)}`);
        }
        const tierRates = toRates(tier, providerId);
        if (!tierRates) throw new Error(`${providerId}/${rawId}: 分档缺少输入或输出单价`);
        return { above: size, rates: tierRates };
      }).sort((a, b) => a.above - b.above);
      seen.add(id);
      models.push({ model: id, provider: providerId, rates, ...(tiers.length ? { tiers } : {}) });
    }
  }
  return {
    source: 'https://models.dev',
    api: MODELS_DEV_API,
    license: 'MIT',
    date,
    ...(sha256 ? { sourceSha256: sha256 } : {}),
    currency: 'USD',
    unit: 'perMillionTokens',
    providers: PROVIDERS.map(([providerId]) => providerId),
    notes: NOTES,
    models,
  };
}

function localDate() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

async function main() {
  const localFile = process.argv[2];
  const body = localFile
    ? fs.readFileSync(localFile, 'utf8')
    : await fetch(MODELS_DEV_API).then((res) => {
      if (!res.ok) throw new Error(`下载 ${MODELS_DEV_API} 失败：HTTP ${res.status}`);
      return res.text();
    });
  const snapshot = buildPricingSnapshot(JSON.parse(body), {
    date: localDate(),
    sha256: createHash('sha256').update(body).digest('hex'),
  });
  fs.writeFileSync(OUTPUT, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`已写入 ${path.relative(ROOT, OUTPUT)}：${snapshot.models.length} 个模型，日期 ${snapshot.date}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
