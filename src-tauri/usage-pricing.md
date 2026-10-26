# 用量监控参考价格

`src-tauri/src/usage-pricing.json` 由 `scripts/update-usage-pricing.mjs` 从 [models.dev](https://models.dev)（[公开 API](https://models.dev/api.json)，MIT 许可）生成。当前快照日期为 **2026-10-26**，共 254 个模型；快照记录了来源 API 内容的 SHA-256，便于核对。

这些价格用于按厂商官方标价估算本地日志中的用量，并非用户账户的实际账单。快照不含中转站倍率、加价、账户折扣、税费或历史价格变化；经中转站使用时，实际扣费可能与此不同（例如 Strova 对 `claude-opus-5-5` 按 Opus 5 的 5 / 25 / 0.5 / 6.25 计费）。

## 取哪些价格

只取厂商第一方 provider，不取 OpenRouter 等聚合或中转站：

`anthropic`、`openai`、`google`、`xai`、`deepseek`、`moonshotai`、`zhipuai`、`minimax`、`mistral`、`alibaba`、`stepfun`、`xiaomi`、`volcengine`、`cohere`

- 按上面的顺序先到先得，同一模型 ID 只保留第一个厂商的价格。
- 厂商托管别家模型时（`canonical_model_id` 指向其它厂商，如阿里云上的 `kimi-k3`、Mistral 上的 `glm-5-2`）按托管价计费，跳过不用。`volcengine` 只取 `bytedance-seed`（豆包）系列。
- 没有 `cost`、缺少输入或输出单价的条目跳过；模型 ID 统一转为小写。

## 字段与计费口径

`rates` 与 `tiers[].rates` 的单价均为 **USD / 百万 Tokens**：

| 字段 | models.dev 字段 | 用量 |
| --- | --- | --- |
| `input` | `cost.input` | 新增输入，不含缓存读取或缓存写入 |
| `output` | `cost.output` | 输出（思考 token 计入输出） |
| `cacheRead` | `cost.cache_read` | 缓存读取 |
| `cacheCreation` | `cost.cache_write` | 普通或 5 分钟缓存写入，不含已计入 1 小时写入的部分 |
| `cacheCreation1h` | 无 | 1 小时缓存写入 |

费用为各分项 `token 数 × 单价 / 1_000_000` 之和。

- models.dev 不单列 1 小时缓存写入。`anthropic` 条目按 Anthropic 官方规则取基础输入价的 2 倍，其余厂商为 `null`。
- 缺少缓存单价时为 `null`，不能当作免费。某项 token 数为零时不需要该项单价；非零且单价为 `null` 时，这条记录标为未定价，不计入已知费用合计。
- 未采用：`reasoning`（少数 Qwen 模型单列了更高的思考价，本地日志无法区分思考 token）、音频单价、`experimental.modes` 中的 fast 模式、区域或 US-only 附加费、批处理 / Flex / Priority 档位。

## 长上下文分档

`tiers` 来自 `cost.tiers`，目前只接受 `tier.type = context`，遇到其它类型时生成脚本直接报错：

- 提示长度 = 新增输入 + 缓存读取 + 全部缓存写入，按单条请求判断，不对整段时间的总量套用分档。
- 提示长度**严格大于** `above` 时使用该档；有多档时取超过的最高一档。依据是 models.dev 源数据的 `when = { context = { gt = N } }`，与 Anthropic（"over 100,000 tokens"）和 OpenAI（">272K input tokens"）官方说明一致。

## 兜底与查价

查价时先查 models.dev 快照；快照未收录的旧型号（带日期的旧版 Claude、豆包基础名等）再用 `usage_stats.rs` 中迁移自 cc-switch 的内置兼容价。模型名只剥离已知供应商前缀、日期和推理强度后缀，不猜测未知型号。所有页面的总 Tokens 统一包含新增输入、输出、缓存读取和缓存写入，1 小时写入属于写入总量的子集。

## 更新与核对

```bash
npm run pricing:update                                  # 下载最新 models.dev 数据并重写快照
node scripts/update-usage-pricing.mjs path/to/api.json  # 使用本地文件生成
```

更新后运行 `npm test` 与 `cargo test --lib usage_stats`。`bundled_models_dev_snapshot_has_valid_rates_and_official_anchors` 中的锚点价格已于 2026-10-26 与 Anthropic、OpenAI 官方价格页核对；锚点失败时，先到厂商官方价格页确认是官方调价还是 models.dev 数据有误，再更新锚点。
