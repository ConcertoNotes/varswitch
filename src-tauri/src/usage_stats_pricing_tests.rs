use super::*;

fn record(app: &str, model: &str) -> UsageRecord {
    UsageRecord {
        request_id: format!("{app}:{model}"),
        app: app.into(),
        model: model.into(),
        input_tokens: 1_000,
        output_tokens: 100,
        cache_read_tokens: 600,
        cache_creation_tokens: 300,
        cache_creation_1h_tokens: 0,
        created_at: parse_rfc3339_to_unix("2026-10-25T00:00:00Z").unwrap(),
        reported_cost: None,
        cost_partial: false,
        project: None,
        session_id: None,
    }
}

fn assert_cost(record: &UsageRecord, expected: f64) {
    let actual = record_cost(record).expect("record should have a price");
    assert!(
        (actual - expected).abs() < 1e-9,
        "{}: {actual} != {expected}",
        record.model
    );
}

#[test]
fn current_models_use_models_dev_rates_and_cache_write_costs() {
    for (model, expected) in [
        ("claude-opus-5-5", 0.00762),
        // Opus 5.5 / Sonnet 5.5 缓存读取为基础输入价的 0.05 倍
        ("claude-sonnet-5-5", 0.00381),
        ("claude-fable-5-1", 0.01890),
        ("claude-haiku-5-5", 0.0001935),
    ] {
        assert_cost(&record("claude", model), expected);
    }
    assert_cost(&record("codex", "gpt-6.1-sol"), 0.00201);
    assert_cost(&record("codex", "gpt-6-astra"), 0.01035);
    assert_cost(&record("codex", "gpt-5.6-sol"), 0.00414);
    let mut claude = record("claude", "claude-opus-5-5");
    claude.cache_creation_1h_tokens = 200;
    assert_cost(&claude, 0.00822);
    assert_eq!(real_total_tokens(&claude), 2_000);
    assert_eq!(real_total_tokens(&record("codex", "gpt-6.1-sol")), 1_100);
}

#[test]
fn aliases_keep_model_identity_and_reference_prices_override_legacy_dates() {
    for model in [
        "anthropic/claude-opus-5.5-20261001",
        "us.anthropic.claude-opus-5-5-v1:0",
        "claude-opus-5-5[1m]",
    ] {
        assert_cost(&record("claude", model), 0.00762);
    }
    assert_cost(&record("codex", "openai/gpt-6.1-sol-ultra"), 0.00201);
    assert_cost(&record("claude", "claude-sonnet-4-5-20250929"), 0.005805);
    // 快照未收录的旧型号仍由内置兼容价兜底
    assert!(find_model_pricing("claude-sonnet-4-20250514").is_some());
    // 裸名只允许匹配同型号的日期后缀，不能猜测一个更贵/更便宜的变体。
    assert!(find_model_pricing("claude-opus-4-5").is_some());
    assert!(find_model_pricing("gpt-6").is_none());
    assert!(find_model_pricing("claude-opus-99").is_none());
    assert!(find_model_pricing("gpt-6.1-sol-unrecognized").is_none());
}

#[test]
fn context_tiers_switch_only_above_threshold_on_total_prompt_length() {
    // 提示长度 = 新增输入 + 缓存读取 + 缓存写入；Codex 的 input 已含缓存。
    let mut r = record("codex", "gpt-6.1-sol");
    let pricing = find_model_pricing(&r.model).unwrap();
    r.input_tokens = 272_000;
    assert_eq!(pricing.rates_for(&r).input, 2.0);
    r.input_tokens += 1;
    assert_eq!(pricing.rates_for(&r).input, 4.0);
    assert_eq!(pricing.rates_for(&r).cache_read, Some(0.2));

    // Claude 的 input 不含缓存：99_100 + 600 + 300 = 100_000，恰好不超过档位。
    let mut r = record("claude", "claude-haiku-5-5");
    let pricing = find_model_pricing(&r.model).unwrap();
    r.input_tokens = 99_100;
    assert_eq!(pricing.rates_for(&r).output, 0.5);
    r.input_tokens += 1;
    let long = pricing.rates_for(&r);
    assert_eq!((long.input, long.output, long.cache_creation_1h), (0.5, 2.5, Some(1.0)));
}

#[test]
fn multiple_tiers_pick_the_highest_exceeded_threshold() {
    let rates = |input| Pricing {
        input,
        output: input,
        cache_read: None,
        cache_creation: None,
        cache_creation_1h: None,
    };
    // 档位顺序不影响选择
    let pricing = ModelPricing {
        rates: rates(1.0),
        tiers: vec![
            PricingTier { above: 128_000, rates: rates(3.0) },
            PricingTier { above: 32_000, rates: rates(2.0) },
        ],
    };
    let mut r = record("claude", "any");
    r.cache_read_tokens = 0;
    r.cache_creation_tokens = 0;
    for (input, expected) in [(32_000, 1.0), (32_001, 2.0), (128_000, 2.0), (128_001, 3.0)] {
        r.input_tokens = input;
        assert_eq!(pricing.rates_for(&r).input, expected, "{input}");
    }
}

#[test]
fn missing_rates_are_unknown_but_reported_zero_and_lower_bounds_are_preserved() {
    let mut r = record("grok", "unknown-model");
    assert_eq!(record_cost(&r), None);
    r.reported_cost = Some(0.0);
    assert_eq!(record_cost(&r), Some(0.0));
    r.reported_cost = Some(0.5);
    r.cost_partial = true;
    assert_eq!(record_cost(&r), Some(0.5));
    assert!(record_cost_is_partial(&r));
    r.model = "gpt-6.1-sol".into();
    assert_cost(&r, 0.5);
    assert!(record_cost_is_partial(&r));
    r.reported_cost = Some(0.001);
    assert_cost(&r, 0.00201);
    assert!(!record_cost_is_partial(&r));
    r.reported_cost = Some(f64::NAN);
    r.model = "unknown-model".into();
    assert_eq!(record_cost(&r), None);

    // models.dev 未给 gpt-5.5 缓存写入价，不能自动按 0 或套其它型号。
    r = record("codex", "gpt-5.5");
    assert_eq!(record_cost(&r), None);
    r.cache_creation_tokens = 0;
    assert_cost(&r, 0.0053);
}

#[test]
fn dashboard_totals_and_pricing_coverage_agree_across_every_view() {
    let priced = record("codex", "gpt-6.1-sol");
    let unknown = record("claude", "unlisted-model");
    let mut partial = record("grok", "custom-model");
    partial.reported_cost = Some(0.5);
    partial.cost_partial = true;
    let ts = priced.created_at;
    let dashboard = aggregate_usage_dashboard(
        CollectOutcome {
            records: vec![priced.clone(), unknown, partial, priced],
            files_scanned: 4,
            deferred_files: 0,
            errors: vec![],
        },
        Some(ts),
        Some(ts + 3_600),
        None,
        None,
        Some(-480),
    );
    let s = &dashboard.summary;
    assert_eq!(s.total_requests, 3); // 重复请求只计一次
    assert_eq!(s.unpriced_requests, 1);
    assert_eq!(s.partial_cost_requests, 1);
    assert!((s.total_cost - 0.50201).abs() < 1e-9);
    assert_eq!(s.real_total_tokens, 4_200);
    assert_eq!(
        dashboard
            .by_app
            .iter()
            .map(|x| x.summary.real_total_tokens)
            .sum::<u64>(),
        s.real_total_tokens
    );
    assert_eq!(
        dashboard.daily.iter().map(|x| x.total_tokens).sum::<u64>(),
        s.real_total_tokens
    );
    assert_eq!(
        dashboard.hourly.iter().map(|x| x.total_tokens).sum::<u64>(),
        s.real_total_tokens
    );
    assert_eq!(
        dashboard.models.iter().map(|x| x.total_tokens).sum::<u64>(),
        s.real_total_tokens
    );
    assert_eq!(
        dashboard.recent.iter().map(|x| x.total_tokens).sum::<u64>(),
        s.real_total_tokens
    );
    assert_eq!(dashboard.daily[0].unpriced_requests, 1);
    assert_eq!(dashboard.hourly[0].partial_cost_requests, 1);
    let json = serde_json::to_value(&dashboard).unwrap();
    assert_eq!(json["summary"]["unpricedRequests"], 1);
    let unknown_json = json["recent"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["model"] == "unlisted-model")
        .unwrap();
    assert!(unknown_json["cost"].is_null());
}

#[test]
fn bundled_models_dev_snapshot_has_valid_rates_and_official_anchors() {
    let reference = reference_pricing();
    assert_eq!(reference.source, "https://models.dev");
    let mut names = HashSet::new();
    for entry in &reference.models {
        assert!(
            names.insert(&entry.model),
            "duplicate model {}",
            entry.model
        );
        let p = &entry.pricing;
        for tier in &p.tiers {
            assert!(tier.above > 0, "{}", entry.model);
        }
        for rates in std::iter::once(p.rates).chain(p.tiers.iter().map(|tier| tier.rates)) {
            for rate in [
                Some(rates.input),
                Some(rates.output),
                rates.cache_read,
                rates.cache_creation,
                rates.cache_creation_1h,
            ]
            .into_iter()
            .flatten()
            {
                assert!(rate.is_finite() && rate >= 0.0, "{}", entry.model);
            }
        }
    }
    // 与厂商官方价格页核对过的锚点，防止快照回归成中转站价格
    let rates = |model: &str| {
        let r = reference_pricing_map()[model].rates;
        (r.input, r.output, r.cache_read, r.cache_creation, r.cache_creation_1h)
    };
    assert_eq!(rates("claude-opus-5-5"), (4.0, 20.0, Some(0.2), Some(5.0), Some(8.0)));
    assert_eq!(rates("claude-sonnet-5-5"), (2.0, 10.0, Some(0.1), Some(2.5), Some(4.0)));
    assert_eq!(rates("claude-haiku-5-5"), (0.1, 0.5, Some(0.01), Some(0.125), Some(0.2)));
    assert_eq!(rates("gpt-5.6-sol"), (4.0, 20.0, Some(0.4), Some(5.0), None));
    assert_eq!(rates("gpt-6-luna"), (0.1, 0.5, Some(0.01), Some(0.125), None));
}

#[test]
fn recent_logs_carry_session_context_and_cost_breakdown() {
    let mut claude = record("claude", "claude-opus-5-5");
    claude.cache_creation_1h_tokens = 200;
    claude.project = Some("/work/varswitch".into());
    claude.session_id = Some("claude-session".into());
    let mut grok = record("grok", "custom-model");
    grok.reported_cost = Some(0.5);
    let ts = claude.created_at;
    let dashboard = aggregate_usage_dashboard(
        CollectOutcome {
            records: vec![claude, grok],
            files_scanned: 2,
            deferred_files: 0,
            errors: vec![],
        },
        Some(ts),
        Some(ts),
        None,
        None,
        Some(-480),
    );
    let log = dashboard.recent.iter().find(|x| x.app == "claude").unwrap();
    assert_eq!(log.project.as_deref(), Some("/work/varswitch"));
    assert_eq!(log.session_id.as_deref(), Some("claude-session"));
    assert_eq!(log.cache_creation_1h_tokens, 200);
    let breakdown = log.cost_breakdown.expect("locally priced records expose components");
    assert!((breakdown.total() - log.cost.unwrap()).abs() < 1e-12);
    assert!((breakdown.cache_read - 600.0 * 0.2 / 1e6).abs() < 1e-12);
    assert!((breakdown.cache_creation - (100.0 * 5.0 + 200.0 * 8.0) / 1e6).abs() < 1e-12);
    // 自报成本无法按 token 拆分
    let reported = dashboard.recent.iter().find(|x| x.app == "grok").unwrap();
    assert!(reported.cost_breakdown.is_none());
    let json = serde_json::to_value(log).unwrap();
    assert!(json["costBreakdown"]["cacheRead"].is_number());
    assert_eq!(json["sessionId"], "claude-session");
}
