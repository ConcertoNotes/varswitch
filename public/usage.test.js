const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Exercise the actual usage renderer with lightweight DOM nodes, without app startup.
const appSource = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
const usageSource = appSource.slice(appSource.indexOf('let usageRange = "7d";'), appSource.indexOf("function applyUsagePanelLanguage()"));
function usageView(lang = "zh") {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: "", textContent: "", title: "" });
    return nodes.get(id);
  };
  const context = vm.createContext({
    currentLang: lang,
    $: node,
    setText: (id, text) => { node(id).textContent = text; },
  });
  vm.runInContext(usageSource, context);
  return { context, node };
}

const summary = (extra = {}) => ({
  totalRequests: 2, totalCost: 0, unpricedRequests: 0, partialCostRequests: 0,
  inputTokens: 20, outputTokens: 10, cacheReadTokens: 100, cacheCreationTokens: 30,
  realTotalTokens: 160, cacheHitRate: 2 / 3, ...extra,
});

test("usage costs distinguish missing prices, partial amounts and real zero", () => {
  const { context: c } = usageView();
  assert.equal(c.formatUsageCost(null), "—");
  assert.equal(c.formatUsageCost(0), "$0.00");
  assert.equal(c.usageCostState(0, summary({ unpricedRequests: 2 })).value, "待定价");
  assert.equal(c.usageCostState(0, summary()).value, "$0.00");
  const mixed = c.usageCostState(1.5, summary({ unpricedRequests: 1 }));
  assert.equal(mixed.value, "≥ $1.50");
  assert.match(mixed.detail, /1 次请求待定价/);
  assert.equal(c.usageCostState(0.2, { costPartial: true }).value, "≥ $0.200");
  assert.equal(c.usageCostState(null).value, "待定价");
  assert.equal(usageView("en").context.usageCostState(null).value, "Unpriced");
});

test("unknown prices remain visible across hero, apps, models, recent records and trends", () => {
  const { context: c, node } = usageView();
  const s = summary({ unpricedRequests: 2 });
  c.renderUsageHero(s, summary({ totalCost: 3 }), [], { pricingSource: "https://models.dev", pricingDate: "2026-10-26" });
  const heroCost = node("usageHeroGrid").innerHTML.split("usage-accent-tokens")[0];
  assert.match(heroCost, /待定价/);
  assert.doesNotMatch(heroCost, /\$0\.00|usage-hero-delta/);
  assert.match(heroCost, /https:\/\/models\.dev/);
  c.renderUsageApps([{ app: "codex", summary: s }], s);
  assert.match(node("usageAppGrid").innerHTML, /待定价/);
  assert.doesNotMatch(node("usageAppGrid").innerHTML, /N\/A|\$0\.00/);
  assert.match(node("usageAppGrid").innerHTML, /30 tokens/);
  const m = { model: "new-model", app: "codex", requests: 2, cost: 0, unpricedRequests: 2, totalTokens: 160, cacheHitRate: 0.5 };
  c.renderUsageModels([m]);
  assert.match(node("usageModelTableBody").innerHTML, /待定价/);
  assert.doesNotMatch(node("usageModelTableBody").innerHTML, /usage-share-fill|\$0\.00/);
  c.renderUsageRecent([{ model: "new-model", app: "codex", cost: null, totalTokens: 160, cacheCreationTokens: 30 }]);
  assert.match(node("usageRecentTableBody").innerHTML, /待定价/);
  assert.match(node("usageRecentTableBody").innerHTML, /title="30">30<\/td>/);
  assert.doesNotMatch(node("usageRecentTableBody").innerHTML, /\$0\.00/);
  c.renderUsageTrend({ daily: [{ date: "2026-10-25", ...m }] });
  assert.match(node("usageTrendChart").innerHTML, /待定价/);
  assert.match(node("usageTrendFooter").textContent, /合计 待定价/);
  assert.doesNotMatch(node("usageTrendFooter").textContent, /\$0\.00/);
});

test("partial totals suppress misleading cost shares, comparisons and peaks", () => {
  const { context: c, node } = usageView();
  const s = summary({ totalCost: 2, unpricedRequests: 1 });
  c.renderUsageHero(s, summary({ totalCost: 1 }), []);
  assert.doesNotMatch(node("usageHeroGrid").innerHTML.split("usage-accent-tokens")[0], /usage-hero-delta/);
  c.renderUsageApps([{ app: "codex", summary: s }, { app: "claude", summary: summary() }], s);
  assert.doesNotMatch(node("usageAppGrid").innerHTML, /占总成本/);
  c.renderUsageModels([{ model: "m", app: "codex", requests: 2, cost: 2, unpricedRequests: 1 }]);
  assert.doesNotMatch(node("usageModelTableBody").innerHTML, /usage-share-fill/);
  c.renderUsageTrend({ daily: [{ date: "2026-10-25", requests: 2, cost: 2, unpricedRequests: 1 }] });
  assert.match(node("usageTrendFooter").textContent, /合计 ≥ \$2\.00.*1 次请求待定价/);
  assert.doesNotMatch(node("usageTrendChart").innerHTML, /usage-trend-peak/);
  c.renderUsageRecent([{ cost: 0, costPartial: true }]);
  assert.match(node("usageRecentTableBody").innerHTML, /≥ \$0\.00/);
  assert.match(node("usageRecentTableBody").innerHTML, /仅有部分成本/);
});

test("recent records show per-request token columns, project context and cost breakdown", () => {
  const { context: c, node } = usageView();
  c.renderUsageRecent([{
    time: 1793005237, app: "claude", model: "claude-opus-5-5",
    inputTokens: 2, outputTokens: 181, cacheReadTokens: 230265,
    cacheCreationTokens: 12052, cacheCreation1hTokens: 2000, totalTokens: 242500,
    cost: 0.109941,
    costBreakdown: { input: 0.000008, output: 0.00362, cacheRead: 0.046053, cacheCreation: 0.06026 },
    project: "/Users/me/Desktop/varswitch", sessionId: "92e676d1-5ed8-4541-afd0-3a935995df2a",
  }]);
  const html = node("usageRecentTableBody").innerHTML;
  assert.equal(html.match(/<td/g).length, 10);
  assert.match(html, /usage-td-clip">varswitch</);
  assert.match(html, /\/Users\/me\/Desktop\/varswitch\n会话 92e676d1-5ed8/);
  assert.match(html, /usage-td-sub">92e676d1</);
  assert.match(html, />230\.3K</);
  assert.match(html, /其中 1 小时缓存 2,000/);
  assert.match(html, /命中 95\.0%/);
  assert.match(html, /缓存读取 \$0\.046\n缓存写入 \$0\.060/);
  assert.match(html, />\$0\.110</);

  c.renderUsageRecent([{ app: "codex", model: "m", project: "C:\\work\\proj\\", cost: 0 }]);
  assert.match(node("usageRecentTableBody").innerHTML, /usage-td-clip">proj</);
  c.renderUsageRecent([{ app: "gemini", model: "m", cost: 0 }]);
  assert.match(node("usageRecentTableBody").innerHTML, /usage-td-clip">—</);
});

test("trend slots retain missing-price counts for hourly and bounded daily ranges", () => {
  const { context: c } = usageView();
  vm.runInContext("usageResolvedRange = { startTs: 1792886400, endTs: 1792890000 }", c);
  const start = new Date(1792886400 * 1000);
  start.setMinutes(0, 0, 0);
  const hourly = c.buildUsageTrendSlots({ hourly: [{ hourStartTs: start.getTime() / 1000, requests: 2, cost: 1, unpricedRequests: 1, partialCostRequests: 1 }] });
  assert.equal(hourly.mode, "hourly");
  assert.equal(hourly.slots[0].unpricedRequests, 1);
  assert.equal(hourly.slots[0].partialCostRequests, 1);
  vm.runInContext("usageResolvedRange = { startTs: 1767225600, endTs: 1767484800 }", c);
  const date = new Date(1767225600 * 1000);
  const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const daily = c.buildUsageTrendSlots({ daily: [{ date: key, requests: 1, cost: 0, unpricedRequests: 1 }] });
  assert.equal(daily.mode, "daily");
  assert.equal(daily.slots[0].unpricedRequests, 1);
  assert.equal(daily.slots[1].unpricedRequests, 0);
});

test("pricing snapshot metadata states source and estimation basis", () => {
  const { context: c, node } = usageView();
  c.renderUsageMeta({ summary: summary(), filesScanned: 3, pricingSource: "https://models.dev", pricingDate: "2026-10-26" });
  assert.match(node("usageMetaLine").textContent, /models\.dev 价格 2026-10-26/);
  assert.match(node("usageMetaLine").title, /https:\/\/models\.dev/);
  assert.match(node("usageMetaLine").title, /实际账单以服务商为准/);
});
