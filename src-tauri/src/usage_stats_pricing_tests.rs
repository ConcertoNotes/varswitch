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
fn current_models_use_reference_rates_and_cache_write_costs() {
    for (model, expected) in [
        ("claude-opus-5-5", 0.00762),
        ("claude-sonnet-5-5", 0.00387),
        ("claude-fable-5-1", 0.01890),
    ] {
        assert_cost(&record("claude", model), expected);
    }
    assert_cost(&record("codex", "gpt-6.1-sol"), 0.00201);
    assert_cost(&record("codex", "gpt-6-astra"), 0.01035);
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
    // 裸名只允许匹配同型号的日期后缀，不能猜测一个更贵/更便宜的变体。
    assert!(find_model_pricing("claude-opus-4-5").is_some());
    assert!(find_model_pricing("gpt-6").is_none());
    assert!(find_model_pricing("claude-opus-99").is_none());
    assert!(find_model_pricing("gpt-6.1-sol-unrecognized").is_none());
}

#[test]
fn tier_thresholds_respect_inclusive_boundary_and_fresh_vs_total_input() {
    let mut r = record("codex", "gpt-6-sol");
    let pricing = find_model_pricing(&r.model).unwrap();
    r.input_tokens = 199_999;
    assert_eq!(pricing.rates_for(&r).input, 2.0);
    r.input_tokens = 200_000;
    assert_eq!(pricing.rates_for(&r).input, 4.0);

    r.model = "gpt-6-astra".into();
    let pricing = find_model_pricing(&r.model).unwrap();
    r.input_tokens = 272_000;
    assert_eq!(pricing.rates_for(&r).input, 10.0);
    r.input_tokens += 1;
    assert_eq!(pricing.rates_for(&r).input, 20.0);

    r.model = "gpt-6.1-sol".into();
    let pricing = find_model_pricing(&r.model).unwrap();
    // 该站此型号的阈值是 p（新增输入），并非包含缓存的 len。
    r.input_tokens = 272_899;
    assert_eq!(pricing.rates_for(&r).input, 2.0);
    r.input_tokens += 1;
    assert_eq!(pricing.rates_for(&r).input, 4.0);
}

#[test]
fn peak_prices_use_historical_shanghai_weekday_and_hour() {
    let mut r = record("codex", "deepseek-v4.1-flash");
    let pricing = find_model_pricing(&r.model).unwrap();
    for (timestamp, input_rate) in [
        ("2026-10-23T00:59:59Z", 1.0), // Friday 08:59
        ("2026-10-23T01:00:00Z", 2.0),
        ("2026-10-23T04:00:00Z", 1.0), // lunch break
        ("2026-10-23T06:00:00Z", 2.0),
        ("2026-10-23T10:00:00Z", 1.0),
        ("2026-10-25T01:00:00Z", 1.0), // Sunday
    ] {
        r.created_at = parse_rfc3339_to_unix(timestamp).unwrap();
        assert_eq!(pricing.rates_for(&r).input, input_rate, "{timestamp}");
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

    // 参考站未提供 gpt-6-luna 的缓存价格，不能自动按0或套其它型号。
    r = record("codex", "gpt-6-luna");
    assert_eq!(record_cost(&r), None);
    r.cache_read_tokens = 0;
    r.cache_creation_tokens = 0;
    assert_cost(&r, 0.09);
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
fn bundled_reference_prices_have_valid_rates_and_explicit_conditions() {
    let reference = reference_pricing();
    assert_eq!(reference.source, "https://code.strova.top/pricing");
    let mut names = HashSet::new();
    for entry in &reference.models {
        assert!(
            names.insert(&entry.model),
            "duplicate model {}",
            entry.model
        );
        let p = entry.pricing;
        assert_eq!(
            p.condition.is_some(),
            p.alternate.is_some(),
            "{}",
            entry.model
        );
        for rates in std::iter::once(p.rates).chain(p.alternate) {
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
