//! Claude 配置域：Profile 增删改查与切换、系统环境变量与编辑器 settings 同步、角色模型映射、快照与备份恢复（从 lib.rs 拆分，逻辑未改动）。

use crate::*;

pub(crate) const AUTH_TOKEN_ENV: &str = "ANTHROPIC_AUTH_TOKEN";
pub(crate) const AUTH_KEY_ENV: &str = "ANTHROPIC_AUTH_KEY";
pub(crate) const LEGACY_AUTH_ENV: &str = "ANTHROPIC_API_KEY";
pub(crate) const BASE_URL_ENV: &str = "ANTHROPIC_BASE_URL";
/// Claude Code 角色模型映射（sonnet/opus/haiku 各自使用的实际模型）
pub(crate) const SONNET_MODEL_ENV: &str = "ANTHROPIC_DEFAULT_SONNET_MODEL";
pub(crate) const OPUS_MODEL_ENV: &str = "ANTHROPIC_DEFAULT_OPUS_MODEL";
pub(crate) const HAIKU_MODEL_ENV: &str = "ANTHROPIC_DEFAULT_HAIKU_MODEL";
pub(crate) const SWITCH_TOTAL_STEPS: u32 = 6;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Profile {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) api_key: String,
    pub(crate) base_url: String,
    #[serde(default)]
    pub(crate) model_id: String,
    /// 角色模型映射：sonnet/opus/haiku 各自映射到的实际模型 ID，
    /// 留空表示不写对应的 ANTHROPIC_DEFAULT_*_MODEL 变量（并清理旧值）
    #[serde(default)]
    pub(crate) sonnet_model: String,
    #[serde(default)]
    pub(crate) opus_model: String,
    #[serde(default)]
    pub(crate) haiku_model: String,
    /// anthropic（默认，直连 Anthropic Messages 端点）
    /// | openai_chat（上游仅有 OpenAI Chat Completions 接口，经本地代理转换协议）
    #[serde(default = "default_claude_api_format")]
    pub(crate) api_format: String,
    /// 是否加入本地代理故障转移备用池（激活配置故障时按列表顺序自动切到池内配置）
    #[serde(default)]
    pub(crate) proxy_failover: bool,
    /// Anthropic 直连配置是否交由本地代理接管（透传模式）。
    /// 接管后同样享受故障转移与熔断，代价是 VarSwitch 必须保持运行，
    /// 否则指向 127.0.0.1 的 ANTHROPIC_BASE_URL 会连不上。
    /// openai_chat 配置本就必经代理，此开关对其无意义。
    #[serde(default)]
    pub(crate) proxy_takeover: bool,
    pub(crate) is_active: bool,
    pub(crate) created_at: String,
}

pub(crate) fn default_claude_api_format() -> String {
    "anthropic".to_string()
}

pub(crate) fn normalize_claude_api_format(raw: &str) -> String {
    match raw.trim() {
        "openai_chat" => "openai_chat".to_string(),
        _ => default_claude_api_format(),
    }
}

/// 该配置的请求是否经本地代理。openai_chat 必经代理（要翻译协议），
/// anthropic 仅在用户勾选接管时经代理（透传，为的是故障转移与热切换）。
pub(crate) fn profile_uses_proxy(profile: &Profile) -> bool {
    profile.api_format == "openai_chat" || profile.proxy_takeover
}

/// 配置在代理里对应的协议模式
pub(crate) fn profile_proxy_mode(profile: &Profile) -> claude_proxy::UpstreamMode {
    claude_proxy::UpstreamMode::from_api_format(&profile.api_format)
}

fn profile_as_proxy_target(profile: &Profile) -> claude_proxy::ProxyTarget {
    claude_proxy::ProxyTarget {
        upstream: claude_proxy::ProxyUpstream {
            base_url: profile.base_url.clone(),
            api_key: profile.api_key.clone(),
            model: profile.model_id.clone(),
        },
        mode: profile_proxy_mode(profile),
    }
}

#[derive(Serialize, Deserialize, Default, Clone)]
pub(crate) struct ProfilesData {
    pub(crate) profiles: Vec<Profile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SwitchResult {
    pub(crate) success: bool,
    pub(crate) results: SwitchDetails,
    pub(crate) errors: Vec<String>,
    pub(crate) profile_name: String,
    pub(crate) cancelled: bool,
    pub(crate) rolled_back: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SwitchDetails {
    pub(crate) env_vars: bool,
    /// 动态编辑器结果: key = 编辑器 id (如 "vscode", "cursor"), value = 是否成功
    pub(crate) editors: HashMap<String, bool>,
    pub(crate) claude: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StatusResult {
    pub(crate) env_vars: Option<LocationStatus>,
    /// 动态编辑器状态: key = 编辑器 id, value = 状态
    pub(crate) editors: HashMap<String, LocationStatus>,
    pub(crate) claude: Option<LocationStatus>,
    pub(crate) claude_model: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConfigSnapshot {
    pub(crate) env_auth_token: Option<String>,
    pub(crate) env_auth_key: Option<String>,
    pub(crate) env_api_key: Option<String>,
    pub(crate) env_base_url: Option<String>,
    /// 角色模型映射变量快照（旧快照缺失时按 None 处理，还原即清理）
    #[serde(default)]
    pub(crate) env_sonnet_model: Option<String>,
    #[serde(default)]
    pub(crate) env_opus_model: Option<String>,
    #[serde(default)]
    pub(crate) env_haiku_model: Option<String>,
    /// 动态编辑器快照: key = 编辑器 id, value = 文件内容
    pub(crate) editor_contents: HashMap<String, String>,
    #[serde(default)]
    pub(crate) missing_editor_ids: Vec<String>,
    pub(crate) claude_content: Option<String>,
    #[serde(default)]
    pub(crate) onboarding_file: Option<OnboardingSnapshot>,
}

#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct OnboardingSnapshot {
    pub(crate) content: Option<String>,
}

pub(crate) fn profiles_path(app: &tauri::AppHandle) -> PathBuf {
    data_dir(app).join("profiles.json")
}

pub(crate) fn read_profiles(app: &tauri::AppHandle) -> ProfilesData {
    let path = profiles_path(app);
    if !path.exists() {
        return ProfilesData::default();
    }
    let mut data: ProfilesData = fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    // 落盘的 API Key 是密文，读出后立即还原成明文，内存与前端始终拿明文
    for p in data.profiles.iter_mut() {
        p.api_key = decrypt_secret_or_keep(&p.api_key, &format!("Claude 配置「{}」", p.name));
    }
    // 修复空 id/createdAt 的历史数据
    let mut fixed = false;
    for p in data.profiles.iter_mut() {
        if p.id.is_empty() {
            p.id = uuid::Uuid::new_v4().to_string();
            fixed = true;
        }
        if p.created_at.is_empty() {
            p.created_at = chrono_now();
            fixed = true;
        }
    }
    if fixed {
        let _ = write_profiles_to_path(&path, &data);
    }
    data
}

pub(crate) fn write_profiles_to_path(path: &PathBuf, data: &ProfilesData) -> Result<(), String> {
    let mut encrypted = data.clone();
    for p in encrypted.profiles.iter_mut() {
        p.api_key = encrypt_secret(&p.api_key);
    }
    let json = serde_json::to_string_pretty(&encrypted).map_err(|e| e.to_string())?;
    write_private_file(path, &json)
}

pub(crate) fn write_profiles(app: &tauri::AppHandle, data: &ProfilesData) -> Result<(), String> {
    let path = profiles_path(app);
    write_profiles_to_path(&path, data)?;
    // 配置增删改/切换/导入后同步刷新托盘快速切换菜单
    refresh_tray_menu(app);
    // 同步本地代理故障转移备用池：任何落盘路径（增删改/排序/导入/切换）
    // 都可能影响池成员或顺序，统一在此收口
    sync_claude_proxy_failover_pool(data);
    Ok(())
}

/// 依据配置列表重算本地代理的故障转移备用池：
/// 激活配置经代理时（openai_chat，或勾选了接管的 anthropic），
/// 池 = 列表顺序中其他勾选了 proxy_failover 且填了 Base URL 的配置（排除激活项）；
/// 激活配置直连时清空池。每个备用各自带协议模式，两种协议可混在同一个池里。
/// 池内容与当前一致时跳过下发，避免 set_failover_targets 无谓重置熔断统计。
pub(crate) fn sync_claude_proxy_failover_pool(data: &ProfilesData) {
    let pool: Vec<claude_proxy::ProxyTarget> = match data.profiles.iter().find(|p| p.is_active) {
        Some(active) if profile_uses_proxy(active) => data
            .profiles
            .iter()
            .filter(|p| {
                p.id != active.id && p.proxy_failover && !p.base_url.trim().is_empty()
            })
            .map(profile_as_proxy_target)
            .collect(),
        _ => Vec::new(),
    };
    let current = claude_proxy::failover_targets();
    let unchanged = current.len() == pool.len()
        && current.iter().zip(pool.iter()).all(|(a, b)| {
            a.upstream.base_url == b.upstream.base_url
                && a.upstream.api_key == b.upstream.api_key
                && a.upstream.model == b.upstream.model
                && a.mode == b.mode
        });
    if unchanged {
        return;
    }
    log_info!("[claude-proxy] 故障转移备用池已同步：{} 个备用上游", pool.len());
    claude_proxy::set_failover_targets(pool);
}

pub(crate) fn claude_settings_path() -> PathBuf {
    home_dir().join(".claude").join("settings.json")
}

/// 在 ~/.claude.json 中把 hasCompletedOnboarding 标记为 true。
///
/// Claude Code CLI 与 IDE 插件用这个字段判断是否需要展示首次使用引导。
/// 切换 API Key / Base URL 之后如果它不是 true，用户下次打开就会被引导页拦住，
/// 所以每次切换 Claude 配置时都顺带补齐。已经是 true 时不重写文件。
pub(crate) fn mark_claude_onboarding_completed() -> Result<(), String> {
    let path = claude_mcp_path(); // ~/.claude.json

    let mut config = read_config_object(&path, false)?;

    if config
        .get("hasCompletedOnboarding")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return Ok(());
    }

    config["hasCompletedOnboarding"] = serde_json::json!(true);
    write_json(&path, &config).map_err(|e| format!("写入 ~/.claude.json 失败: {e}"))?;
    log_info!("[claude] 已将 ~/.claude.json 的 hasCompletedOnboarding 置为 true");
    Ok(())
}

pub(crate) fn upsert_env_array(arr: &mut Vec<serde_json::Value>, name: &str, value: &str) {
    arr.retain(|v| v.get("name").and_then(|n| n.as_str()) != Some(name));
    arr.push(serde_json::json!({ "name": name, "value": value }));
}

pub(crate) fn remove_env_array_key(arr: &mut Vec<serde_json::Value>, name: &str) {
    arr.retain(|v| v.get("name").and_then(|n| n.as_str()) != Some(name));
}

pub(crate) fn get_env_array_value(arr: &[serde_json::Value], name: &str) -> Option<String> {
    arr.iter()
        .find(|v| v.get("name").and_then(|n| n.as_str()) == Some(name))
        .and_then(|v| v.get("value"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

pub(crate) fn has_env_array_key(arr: &[serde_json::Value], name: &str) -> bool {
    arr.iter()
        .any(|v| v.get("name").and_then(|n| n.as_str()) == Some(name))
}

pub(crate) fn pick_auth_name(_has_token: bool, _has_key: bool) -> &'static str {
    AUTH_TOKEN_ENV
}

pub(crate) fn read_auth_from_env_array(arr: &[serde_json::Value]) -> String {
    get_env_array_value(arr, AUTH_TOKEN_ENV)
        .or_else(|| get_env_array_value(arr, AUTH_KEY_ENV))
        .or_else(|| get_env_array_value(arr, LEGACY_AUTH_ENV))
        .unwrap_or_default()
}

pub(crate) fn apply_auth_to_env_array(
    arr: &mut Vec<serde_json::Value>,
    api_key: &str,
    base_url: &str,
) -> &'static str {
    let auth_name = pick_auth_name(
        has_env_array_key(arr, AUTH_TOKEN_ENV),
        has_env_array_key(arr, AUTH_KEY_ENV),
    );
    upsert_env_array(arr, auth_name, api_key);
    upsert_env_array(arr, BASE_URL_ENV, base_url);
    remove_env_array_key(
        arr,
        if auth_name == AUTH_TOKEN_ENV {
            AUTH_KEY_ENV
        } else {
            AUTH_TOKEN_ENV
        },
    );
    remove_env_array_key(arr, LEGACY_AUTH_ENV);
    auth_name
}

pub(crate) fn read_auth_from_env_object(env: &serde_json::Map<String, serde_json::Value>) -> String {
    env.get(AUTH_TOKEN_ENV)
        .and_then(|v| v.as_str())
        .or_else(|| env.get(AUTH_KEY_ENV).and_then(|v| v.as_str()))
        .or_else(|| env.get(LEGACY_AUTH_ENV).and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string()
}

pub(crate) fn apply_auth_to_env_object(
    env: &mut serde_json::Map<String, serde_json::Value>,
    api_key: &str,
    base_url: &str,
) -> &'static str {
    let auth_name = pick_auth_name(
        env.contains_key(AUTH_TOKEN_ENV),
        env.contains_key(AUTH_KEY_ENV),
    );
    env.insert(
        auth_name.to_string(),
        serde_json::Value::String(api_key.to_string()),
    );
    env.insert(
        BASE_URL_ENV.to_string(),
        serde_json::Value::String(base_url.to_string()),
    );
    env.remove(if auth_name == AUTH_TOKEN_ENV {
        AUTH_KEY_ENV
    } else {
        AUTH_TOKEN_ENV
    });
    env.remove(LEGACY_AUTH_ENV);
    auth_name
}

pub(crate) fn read_auth_from_system_env() -> String {
    reg_get_env_opt(AUTH_TOKEN_ENV)
        .or_else(|| reg_get_env_opt(AUTH_KEY_ENV))
        .or_else(|| reg_get_env_opt(LEGACY_AUTH_ENV))
        .unwrap_or_default()
}

pub(crate) fn apply_auth_to_system_env(api_key: &str, base_url: &str) -> Result<&'static str, String> {
    let auth_name = pick_auth_name(
        reg_get_env_opt(AUTH_TOKEN_ENV).is_some(),
        reg_get_env_opt(AUTH_KEY_ENV).is_some(),
    );
    reg_set_env(auth_name, api_key)?;
    reg_set_env(BASE_URL_ENV, base_url)?;

    let other = if auth_name == AUTH_TOKEN_ENV {
        AUTH_KEY_ENV
    } else {
        AUTH_TOKEN_ENV
    };
    if reg_get_env_opt(other).is_some() {
        reg_delete_env(other)?;
    }
    if reg_get_env_opt(LEGACY_AUTH_ENV).is_some() {
        reg_delete_env(LEGACY_AUTH_ENV)?;
    }

    Ok(auth_name)
}

/// 配置的角色模型映射（sonnet/opus/haiku → 实际模型 ID），统一 trim 后使用
pub(crate) fn claude_role_model_envs(profile: &Profile) -> [(&'static str, &str); 3] {
    [
        (SONNET_MODEL_ENV, profile.sonnet_model.trim()),
        (OPUS_MODEL_ENV, profile.opus_model.trim()),
        (HAIKU_MODEL_ENV, profile.haiku_model.trim()),
    ]
}

/// 把角色模型映射写入系统环境变量；字段为空时删除旧变量，避免残留误导 Claude Code
pub(crate) fn apply_role_models_to_system_env(profile: &Profile) -> Result<(), String> {
    for (name, value) in claude_role_model_envs(profile) {
        if value.is_empty() {
            if reg_get_env_opt(name).is_some() {
                reg_delete_env(name)?;
            }
        } else {
            reg_set_env(name, value)?;
        }
    }
    Ok(())
}

/// 把角色模型映射写入编辑器 claudeCode.environmentVariables 数组；空字段清理旧值
pub(crate) fn apply_role_models_to_env_array(arr: &mut Vec<serde_json::Value>, profile: &Profile) {
    for (name, value) in claude_role_model_envs(profile) {
        if value.is_empty() {
            remove_env_array_key(arr, name);
        } else {
            upsert_env_array(arr, name, value);
        }
    }
}

/// 把角色模型映射写入 ~/.claude/settings.json 的 env 对象；空字段清理旧值
pub(crate) fn apply_role_models_to_env_object(
    env: &mut serde_json::Map<String, serde_json::Value>,
    profile: &Profile,
) {
    for (name, value) in claude_role_model_envs(profile) {
        if value.is_empty() {
            env.remove(name);
        } else {
            env.insert(
                name.to_string(),
                serde_json::Value::String(value.to_string()),
            );
        }
    }
}

pub(crate) fn restore_system_env_var(name: &str, value: &Option<String>) -> Result<(), String> {
    match value {
        Some(v) => reg_set_env(name, v),
        None => {
            if reg_get_env_opt(name).is_some() {
                reg_delete_env(name)?;
            }
            Ok(())
        }
    }
}

pub(crate) fn emit_switch_progress(app: &tauri::AppHandle, step: u32, label: &str) {
    let _ = app.emit(
        "switch-progress",
        ProgressEvent {
            step,
            total: SWITCH_TOTAL_STEPS,
            label: label.to_string(),
        },
    );
}

// ── Tauri Commands ──────────────────────────────────

#[tauri::command]
pub(crate) fn get_profiles(app: tauri::AppHandle) -> ProfilesData {
    read_profiles(&app)
}

/// 主线程会 join 所有测速线程，最坏等到最慢的那个超时（可达 30 秒），
/// 因此整体放到阻塞线程池
#[tauri::command]
pub(crate) async fn test_api_endpoints(
    urls: Vec<String>,
    timeout_secs: Option<u64>,
) -> Result<Vec<EndpointLatency>, String> {
    tauri::async_runtime::spawn_blocking(move || test_api_endpoints_blocking(urls, timeout_secs))
        .await
        .map_err(|e| format!("接口测速失败: {e}"))?
}

fn test_api_endpoints_blocking(
    urls: Vec<String>,
    timeout_secs: Option<u64>,
) -> Result<Vec<EndpointLatency>, String> {
    if urls.is_empty() {
        return Ok(Vec::new());
    }

    let timeout = Duration::from_secs(sanitize_endpoint_timeout(timeout_secs));
    let client = reqwest::blocking::Client::builder()
        .user_agent("VarSwitch endpoint speed test")
        .timeout(timeout)
        .build()
        .map_err(|e| e.to_string())?;

    let mut results: Vec<Option<EndpointLatency>> = vec![None; urls.len()];
    let mut handles = Vec::new();

    for (idx, raw_url) in urls.into_iter().enumerate() {
        match normalize_endpoint_url(&raw_url) {
            Ok(url) => {
                let client = client.clone();
                handles.push((
                    idx,
                    std::thread::spawn(move || measure_endpoint_latency(client, url, timeout)),
                ));
            }
            Err(error) => {
                results[idx] = Some(EndpointLatency {
                    url: raw_url,
                    latency: None,
                    status: None,
                    error: Some(error),
                });
            }
        }
    }

    for (idx, handle) in handles {
        results[idx] = Some(handle.join().map_err(|_| "测速线程异常退出".to_string())?);
    }

    Ok(results.into_iter().flatten().collect())
}

/// 逐个候选地址试探，单次超时最长 30 秒，因此放到阻塞线程池执行，
/// 否则点一次「拉取模型」窗口就会僵住
#[tauri::command]
pub(crate) async fn fetch_available_models(
    base_url: String,
    api_key: String,
    timeout_secs: Option<u64>,
    protocol: Option<String>,
) -> Result<Vec<AvailableModel>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        fetch_available_models_blocking(base_url, api_key, timeout_secs, protocol)
    })
    .await
    .map_err(|e| format!("拉取模型列表失败: {e}"))?
}

fn fetch_available_models_blocking(
    base_url: String,
    api_key: String,
    timeout_secs: Option<u64>,
    protocol: Option<String>,
) -> Result<Vec<AvailableModel>, String> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("API Key 不能为空".into());
    }

    let timeout = Duration::from_secs(sanitize_endpoint_timeout(timeout_secs));
    let client = reqwest::blocking::Client::builder()
        .user_agent("VarSwitch model fetch")
        .timeout(timeout)
        .build()
        .map_err(|e| e.to_string())?;

    let is_gemini = protocol.as_deref() == Some("gemini");
    let urls = if is_gemini {
        let normalized = normalize_endpoint_url(&base_url)?;
        if normalized.ends_with("/models") {
            vec![normalized]
        } else if normalized.ends_with("/v1beta") {
            vec![format!("{normalized}/models")]
        } else {
            vec![format!("{normalized}/v1beta/models")]
        }
    } else {
        models_endpoint_candidates(&base_url)?
    };

    let is_anthropic = matches!(protocol.as_deref(), Some("claude") | Some("anthropic"));
    let mut last_error = String::new();
    for url in urls {
        let mut request = client
            .get(&url)
            .header("Accept", "application/json")
            .timeout(timeout);
        request = if is_gemini {
            request.header("x-goog-api-key", api_key)
        } else if is_anthropic {
            // Anthropic 官方要求 x-api-key + anthropic-version；
            // 同时附带 Bearer 以兼容仅支持 OpenAI 风格鉴权的中转网关。
            request
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01")
                .bearer_auth(api_key)
        } else {
            request.bearer_auth(api_key)
        };
        match request.send() {
            Ok(resp) => {
                let status = resp.status();
                let body = resp.text().map_err(|e| e.to_string())?;
                if !status.is_success() {
                    last_error = format!("{url} 返回 HTTP {}", status.as_u16());
                    continue;
                }
                let value: serde_json::Value = serde_json::from_str(&body)
                    .map_err(|e| format!("模型列表 JSON 解析失败: {e}"))?;
                let models: Vec<AvailableModel> = extract_model_ids(&value)
                    .into_iter()
                    .map(|id| AvailableModel {
                        id: if is_gemini {
                            id.strip_prefix("models/").unwrap_or(&id).to_string()
                        } else {
                            id
                        },
                    })
                    .collect();
                if models.is_empty() {
                    last_error = format!("{url} 没有返回可识别的模型 ID");
                    continue;
                }
                return Ok(models);
            }
            Err(e) => {
                last_error = if e.is_timeout() {
                    format!("{url} 请求超时")
                } else if e.is_connect() {
                    format!("{url} 连接失败")
                } else {
                    format!("{url} 请求失败: {e}")
                };
            }
        }
    }

    Err(if last_error.is_empty() {
        "未能获取模型列表".into()
    } else {
        last_error
    })
}

#[tauri::command]
pub(crate) fn add_profile(
    app: tauri::AppHandle,
    name: String,
    api_key: String,
    base_url: String,
    model_id: Option<String>,
    api_format: Option<String>,
    sonnet_model: Option<String>,
    opus_model: Option<String>,
    haiku_model: Option<String>,
    proxy_failover: Option<bool>,
    proxy_takeover: Option<bool>,
) -> Result<Profile, String> {
    if name.trim().is_empty() || api_key.trim().is_empty() {
        return Err("配置名称和 API Key 都必须填写".into());
    }
    let api_format = normalize_claude_api_format(&api_format.unwrap_or_default());
    if api_format == "openai_chat" && base_url.trim().is_empty() {
        return Err("OpenAI 格式必须填写上游 Base URL".into());
    }
    let proxy_takeover = proxy_takeover.unwrap_or(false);
    if proxy_takeover && base_url.trim().is_empty() {
        return Err("启用代理接管必须填写 Base URL".into());
    }
    let mut data = read_profiles(&app);
    let profile = Profile {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.trim().to_string(),
        api_key: api_key.trim().to_string(),
        base_url: resolve_base_url_or_default(&base_url, DEFAULT_ANTHROPIC_BASE_URL),
        model_id: model_id.unwrap_or_default().trim().to_string(),
        sonnet_model: sonnet_model.unwrap_or_default().trim().to_string(),
        opus_model: opus_model.unwrap_or_default().trim().to_string(),
        haiku_model: haiku_model.unwrap_or_default().trim().to_string(),
        api_format,
        proxy_failover: proxy_failover.unwrap_or(false),
        proxy_takeover,
        is_active: false,
        created_at: chrono_now(),
    };
    data.profiles.push(profile.clone());
    write_profiles(&app, &data)?;
    Ok(profile)
}

#[tauri::command]
pub(crate) fn update_profile(
    app: tauri::AppHandle,
    id: String,
    name: String,
    api_key: String,
    base_url: String,
    model_id: Option<String>,
    api_format: Option<String>,
    sonnet_model: Option<String>,
    opus_model: Option<String>,
    haiku_model: Option<String>,
    proxy_failover: Option<bool>,
    proxy_takeover: Option<bool>,
) -> Result<Profile, String> {
    let mut data = read_profiles(&app);
    let p = data
        .profiles
        .iter_mut()
        .find(|x| x.id == id)
        .ok_or("配置未找到")?;
    if !name.is_empty() {
        p.name = name.trim().to_string();
    }
    if !api_key.is_empty() {
        p.api_key = api_key.trim().to_string();
    }
    p.base_url = resolve_base_url_or_default(&base_url, DEFAULT_ANTHROPIC_BASE_URL);
    p.model_id = model_id.map(|m| m.trim().to_string()).unwrap_or_default();
    p.sonnet_model = sonnet_model.map(|m| m.trim().to_string()).unwrap_or_default();
    p.opus_model = opus_model.map(|m| m.trim().to_string()).unwrap_or_default();
    p.haiku_model = haiku_model.map(|m| m.trim().to_string()).unwrap_or_default();
    p.api_format = normalize_claude_api_format(&api_format.unwrap_or_default());
    p.proxy_failover = proxy_failover.unwrap_or(false);
    // Base URL 为空时无法透传，静默关掉接管而不是留一个必然失败的配置
    p.proxy_takeover = proxy_takeover.unwrap_or(false) && !p.base_url.trim().is_empty();
    let updated = p.clone();
    write_profiles(&app, &data)?;
    Ok(updated)
}

#[tauri::command]
pub(crate) fn delete_profile(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let mut data = read_profiles(&app);
    data.profiles.retain(|x| x.id != id);
    write_profiles(&app, &data)
}

// ── 配置排序持久化 ───────────────────────────────────

/// 按 ids 顺序重排列表：ids 中不存在的 id 忽略；
/// 未被 ids 覆盖的项按原相对顺序追加到末尾。
pub(crate) fn reorder_by_ids<T>(items: Vec<T>, ids: &[String], id_of: impl Fn(&T) -> &str) -> Vec<T> {
    let mut remaining: Vec<Option<T>> = items.into_iter().map(Some).collect();
    let mut ordered: Vec<T> = Vec::with_capacity(remaining.len());
    for id in ids {
        let slot = remaining.iter_mut().find(|slot| {
            slot.as_ref()
                .map(|item| id_of(item) == id)
                .unwrap_or(false)
        });
        if let Some(slot) = slot {
            if let Some(item) = slot.take() {
                ordered.push(item);
            }
        }
    }
    ordered.extend(remaining.into_iter().flatten());
    ordered
}

#[tauri::command]
pub(crate) fn reorder_profiles(app: tauri::AppHandle, ids: Vec<String>) -> Result<ProfilesData, String> {
    let mut data = read_profiles(&app);
    data.profiles = reorder_by_ids(std::mem::take(&mut data.profiles), &ids, |p| &p.id);
    write_profiles(&app, &data)?;
    Ok(data)
}


#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaudeProxyStatus {
    pub(crate) running: bool,
    pub(crate) port: u16,
    pub(crate) upstream_base_url: String,
}

#[tauri::command]
pub(crate) fn get_claude_proxy_status() -> ClaudeProxyStatus {
    ClaudeProxyStatus {
        running: claude_proxy::is_running(),
        port: claude_proxy::CLAUDE_PROXY_PORT,
        upstream_base_url: claude_proxy::current_upstream()
            .map(|u| u.base_url)
            .unwrap_or_default(),
    }
}

#[tauri::command]
pub(crate) fn snapshot_config(app: tauri::AppHandle) -> Result<ConfigSnapshot, String> {
    let settings = read_app_settings(&app);
    let mut editor_contents = HashMap::new();
    let mut missing_editor_ids = Vec::new();
    for editor in detect_installed_editors(&settings) {
        let path = resolved_editor_settings_path(editor, &settings);
        match fs::read_to_string(&path) {
            Ok(content) => { editor_contents.insert(editor.id.to_string(), content); }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => missing_editor_ids.push(editor.id.to_string()),
            Err(e) => return Err(format!("备份编辑器配置 {} 失败: {e}", path.display())),
        }
    }
    let claude_path = claude_settings_path();
    let claude_content = match fs::read_to_string(&claude_path) {
        Ok(content) => Some(content),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("备份 Claude 配置失败: {e}")),
    };
    let onboarding_content = match fs::read_to_string(claude_mcp_path()) {
        Ok(content) => Some(content),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("备份 Claude 引导配置失败: {e}")),
    };
    Ok(ConfigSnapshot {
        env_auth_token: reg_get_env_opt(AUTH_TOKEN_ENV),
        env_auth_key: reg_get_env_opt(AUTH_KEY_ENV),
        env_api_key: reg_get_env_opt(LEGACY_AUTH_ENV),
        env_base_url: reg_get_env_opt(BASE_URL_ENV),
        env_sonnet_model: reg_get_env_opt(SONNET_MODEL_ENV),
        env_opus_model: reg_get_env_opt(OPUS_MODEL_ENV),
        env_haiku_model: reg_get_env_opt(HAIKU_MODEL_ENV),
        editor_contents,
        missing_editor_ids,
        claude_content,
        onboarding_file: Some(OnboardingSnapshot { content: onboarding_content }),
    })
}

#[tauri::command]
pub(crate) fn restore_config(app: tauri::AppHandle, snapshot: ConfigSnapshot) -> Result<(), String> {
    let settings = read_app_settings(&app);
    let mut errors = Vec::new();
    for (name, value) in [
        (AUTH_TOKEN_ENV, &snapshot.env_auth_token),
        (AUTH_KEY_ENV, &snapshot.env_auth_key),
        (LEGACY_AUTH_ENV, &snapshot.env_api_key),
        (BASE_URL_ENV, &snapshot.env_base_url),
        (SONNET_MODEL_ENV, &snapshot.env_sonnet_model),
        (OPUS_MODEL_ENV, &snapshot.env_opus_model),
        (HAIKU_MODEL_ENV, &snapshot.env_haiku_model),
    ] {
        if let Err(e) = restore_system_env_var(name, value) {
            errors.push(format!("{name}: {e}"));
        }
    }
    broadcast_env_change();

    // 某个位置恢复失败后继续恢复其余位置，最后一次性报告错误。
    for (editor_id, content) in &snapshot.editor_contents {
        if let Some(editor) = KNOWN_EDITORS.iter().find(|e| e.id == editor_id.as_str()) {
            let path = resolved_editor_settings_path(editor, &settings);
            if let Err(e) = restore_config_file(&path, Some(content)) { errors.push(e); }
        }
    }
    for editor_id in &snapshot.missing_editor_ids {
        if let Some(editor) = KNOWN_EDITORS.iter().find(|e| e.id == editor_id.as_str()) {
            if let Err(e) = restore_config_file(&resolved_editor_settings_path(editor, &settings), None) { errors.push(e); }
        }
    }
    if let Err(e) = restore_config_file(&claude_settings_path(), snapshot.claude_content.as_deref()) { errors.push(e); }
    if let Some(onboarding) = &snapshot.onboarding_file {
        if let Err(e) = restore_config_file(&claude_mcp_path(), onboarding.content.as_deref()) { errors.push(e); }
    }

    // 取消后同时恢复旧上游，否则文件虽恢复，仍在运行的本地代理却已切到新供应商。
    let data = read_profiles(&app);
    if let Some(active) = data.profiles.iter().find(|p| p.is_active && profile_uses_proxy(p)) {
        let target = profile_as_proxy_target(active);
        claude_proxy::set_upstream_with_mode(Some(target.upstream), target.mode);
    } else {
        claude_proxy::set_upstream(None);
    }
    sync_claude_proxy_failover_pool(&data);

    if errors.is_empty() { Ok(()) } else { Err(errors.join("; ")) }
}

fn restore_config_file(path: &Path, content: Option<&str>) -> Result<(), String> {
    if let Some(content) = content {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        write_file_atomic(path, content)
    } else {
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("清理切换新建的配置 {} 失败: {e}", path.display())),
        }
    }
}

#[tauri::command]
pub(crate) fn cancel_switch(state: State<'_, AppState>) {
    state.cancel_flag.store(true, Ordering::SeqCst);
}

// ── 配置自动备份 ─────────────────────────────────────
// 切换配置前自动快照各应用的 profiles 文件，误操作可回滚。

/// 返回给前端的备份信息。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConfigBackupInfo {
    pub(crate) name: String,  // 备份文件名
    pub(crate) kind: String,  // "claude" | "codex" | "grok" | "gemini"
    pub(crate) stamp: String, // 紧凑时间戳，如 20260624-143025（前端格式化展示）
}


pub(crate) fn backups_dir(app: &tauri::AppHandle) -> PathBuf {
    let dir = data_dir(app).join("backups");
    fs::create_dir_all(&dir).ok();
    dir
}

/// 把单个配置文件复制到备份目录（带时间戳）。
pub(crate) fn backup_one_config(dir: &PathBuf, src: &PathBuf, prefix: &str, stamp: &str) {
    if !src.exists() {
        return;
    }
    let dst = dir.join(format!("{prefix}-{stamp}.json"));
    let _ = fs::copy(src, &dst);
}

pub(crate) fn backup_one_file_with_ext(
    dir: &PathBuf,
    src: &PathBuf,
    prefix: &str,
    stamp: &str,
    ext: &str,
) -> Option<String> {
    if !src.exists() {
        return None;
    }
    let safe_ext = ext.trim_start_matches('.');
    let dst = dir.join(format!("{prefix}-{stamp}.{safe_ext}"));
    match fs::copy(src, &dst) {
        Ok(_) => Some(dst.to_string_lossy().to_string()),
        Err(err) => {
            log_warn!("[backup] 备份文件失败 src={} err={err}", src.display());
            None
        }
    }
}


/// 清理同类备份，只保留最近 keep 个（文件名时间戳字典序==时间序）。
pub(crate) fn prune_backups(dir: &PathBuf, prefix: &str, keep: usize) {
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with(&format!("{prefix}-")))
                .unwrap_or(false)
        })
        .collect();
    if files.len() <= keep {
        return;
    }
    files.sort();
    let remove_count = files.len() - keep;
    for old in files.iter().take(remove_count) {
        let _ = fs::remove_file(old);
    }
}

/// 切换配置前自动备份。失败不阻断切换，仅记录日志。
pub(crate) fn auto_backup_configs(app: &tauri::AppHandle) {
    let dir = backups_dir(app);
    let stamp = format_compact_time(chrono_timestamp_millis());
    backup_one_config(&dir, &profiles_path(app), "profiles", &stamp);
    backup_one_config(&dir, &codex_profiles_path(app), "codex", &stamp);
    backup_one_config(&dir, &grok_profiles_path(app), "grok", &stamp);
    backup_one_config(&dir, &gemini_profiles_path(app), "gemini", &stamp);
    let runtime_backup = backup_codex_runtime_files(app);
    // 同时备份 Grok CLI 运行时配置 ~/.grok/config.toml
    let grok_runtime_dir = dir.join("grok-runtime");
    let _ = fs::create_dir_all(&grok_runtime_dir);
    let grok_config_backup = backup_one_file_with_ext(
        &grok_runtime_dir,
        &grok_config_path(),
        "config",
        &stamp,
        "toml",
    );
    prune_backups(&dir, "profiles", 20);
    prune_backups(&dir, "codex", 20);
    prune_backups(&dir, "grok", 20);
    prune_backups(&dir, "gemini", 20);
    let runtime_dir = dir.join("codex-runtime");
    prune_backups(&runtime_dir, "config", 20);
    prune_backups(&runtime_dir, "auth", 20);
    prune_backups(&grok_runtime_dir, "config", 20);
    log_info!(
        "[backup] 已自动备份配置 stamp={stamp} codex_config={:?} codex_auth={:?} grok_config={:?}",
        runtime_backup.config_backup,
        runtime_backup.auth_backup,
        grok_config_backup
    );
}


/// 列出所有配置备份，最新的在前。
#[tauri::command]
pub(crate) fn list_config_backups(app: tauri::AppHandle) -> Vec<ConfigBackupInfo> {
    let dir = backups_dir(&app);
    let mut out: Vec<ConfigBackupInfo> = Vec::new();
    for entry in fs::read_dir(&dir).into_iter().flatten().flatten() {
        let path = entry.path();
        let Some(fname) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !fname.ends_with(".json") {
            continue;
        }
        let (kind, stamp) = if let Some(rest) = fname.strip_prefix("profiles-") {
            ("claude", rest.trim_end_matches(".json"))
        } else if let Some(rest) = fname.strip_prefix("codex-") {
            ("codex", rest.trim_end_matches(".json"))
        } else if let Some(rest) = fname.strip_prefix("grok-") {
            ("grok", rest.trim_end_matches(".json"))
        } else if let Some(rest) = fname.strip_prefix("gemini-") {
            ("gemini", rest.trim_end_matches(".json"))
        } else {
            continue;
        };
        out.push(ConfigBackupInfo {
            name: fname.to_string(),
            kind: kind.to_string(),
            stamp: stamp.to_string(),
        });
    }
    out.sort_by(|a, b| b.stamp.cmp(&a.stamp));
    out
}

/// 从指定备份恢复配置。恢复前会先备份当前状态，避免回滚错了无法挽回。
#[tauri::command]
pub(crate) fn restore_config_backup(app: tauri::AppHandle, name: String) -> Result<(), String> {
    // 安全校验：防止目录穿越
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("非法的备份名".into());
    }
    let src = backups_dir(&app).join(&name);
    if !src.exists() {
        return Err("备份文件不存在".into());
    }
    let dst = if name.starts_with("profiles-") {
        profiles_path(&app)
    } else if name.starts_with("codex-") {
        codex_profiles_path(&app)
    } else if name.starts_with("grok-") {
        grok_profiles_path(&app)
    } else if name.starts_with("gemini-") {
        gemini_profiles_path(&app)
    } else {
        return Err("无法识别的备份类型".into());
    };
    // 恢复前先备份当前，留一条后悔路
    auto_backup_configs(&app);
    let content = fs::read_to_string(&src).map_err(|e| format!("读取备份失败: {e}"))?;
    write_file_atomic(&dst, &content).map_err(|e| format!("恢复失败: {e}"))?;
    log_info!("[backup] 已从备份恢复配置: {name}");
    // 恢复绕过了 write_*_profiles，手动刷新托盘快速切换菜单
    refresh_tray_menu(&app);
    Ok(())
}

/// 打开备份文件夹。
#[tauri::command]
pub(crate) fn open_backups_folder(app: tauri::AppHandle) -> Result<(), String> {
    let dir = backups_dir(&app);
    open_folder(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub(crate) async fn switch_profile(app: tauri::AppHandle, id: String) -> Result<SwitchResult, String> {
    // Shell / launchctl 与文件写入在后台执行，macOS 主线程仍可处理取消和窗口事件。
    tauri::async_runtime::spawn_blocking(move || {
        let state_handle = app.clone();
        switch_profile_blocking(app, state_handle.state::<AppState>(), id)
    }).await.map_err(|e| format!("切换任务失败: {e}"))?
}

pub(crate) fn switch_profile_blocking(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<SwitchResult, String> {
    static SWITCH_LOCK: Mutex<()> = Mutex::new(());
    let _guard = SWITCH_LOCK.try_lock().map_err(|_| "正在切换 Claude 配置，请稍后重试")?;
    let snapshot = snapshot_config(app.clone())?;
    let result = switch_profile_inner(app.clone(), state, id);
    finish_claude_switch(result, || restore_config(app, snapshot))
}

fn finish_claude_switch(
    result: Result<SwitchResult, String>,
    rollback: impl FnOnce() -> Result<(), String>,
) -> Result<SwitchResult, String> {
    match result {
        Ok(result) if result.success => Ok(result),
        Ok(mut result) => {
            match rollback() {
                Ok(()) => result.rolled_back = true,
                Err(e) => result.errors.push(format!("恢复之前配置失败: {e}")),
            }
            Ok(result)
        }
        Err(error) => match rollback() {
            Ok(()) => Err(format!("{error}；之前配置已恢复")),
            Err(e) => Err(format!("{error}；恢复之前配置失败: {e}")),
        },
    }
}

fn switch_profile_inner(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<SwitchResult, String> {
    let settings = read_app_settings(&app);
    let mut data = read_profiles(&app);
    let profile = data
        .profiles
        .iter()
        .find(|x| x.id == id)
        .ok_or("配置未找到")?
        .clone();
    ensure_secret_usable(&profile.api_key, &format!("配置「{}」", profile.name))?;

    state.cancel_flag.store(false, Ordering::SeqCst);

    let mut errors: Vec<String> = Vec::new();
    let mut details = SwitchDetails {
        env_vars: false,
        editors: HashMap::new(),
        claude: false,
    };

    emit_switch_progress(&app, 1, "prepare");

    // 切换前只备份配置文件；会话同步不属于切换热路径。
    auto_backup_configs(&app);

    // 先检查全部配置能否解析，再修改环境变量或代理。
    let editors = detect_installed_editors(&settings);
    let mut editor_configs = Vec::new();
    for editor in &editors {
        let path = resolved_editor_settings_path(editor, &settings);
        let config = read_config_object(&path, true)?;
        editor_configs.push((*editor, path, config));
    }
    let cp = claude_settings_path();
    let mut claude_settings = read_config_object(&cp, false)?;
    read_config_object(&claude_mcp_path(), false)?;

    // 经代理的配置：环境变量指向 127.0.0.1，真实上游（base_url / key / 模型）
    // 写入代理状态。openai_chat 由代理翻译协议，勾选接管的 anthropic 由代理透传。
    // 代理起不来时中止切换，避免写入一个连不上的地址。
    let effective_base_url = if profile_uses_proxy(&profile) {
        let target = profile_as_proxy_target(&profile);
        let mode = target.mode;
        claude_proxy::set_upstream_with_mode(Some(target.upstream), mode);
        claude_proxy::ensure_server()?;
        log_info!(
            "[claude-proxy] 配置 {} 走本地代理（{}），转发至 {}",
            profile.name,
            mode.as_str(),
            profile.base_url
        );
        claude_proxy::local_base_url()
    } else {
        // 直连配置生效后清空上游，代理拒绝后续请求，避免旧配置被误用
        claude_proxy::set_upstream(None);
        profile.base_url.clone()
    };

    if state.cancel_flag.load(Ordering::SeqCst) {
        return Ok(SwitchResult {
            success: false,
            results: details,
            errors: vec!["已取消".into()],
            profile_name: profile.name,
            cancelled: true,
            rolled_back: false,
        });
    }

    emit_switch_progress(&app, 2, "system");
    match apply_auth_to_system_env(&profile.api_key, &effective_base_url)
        .and_then(|_| apply_role_models_to_system_env(&profile))
    {
        Ok(_) => {
            broadcast_env_change();
            details.env_vars = true;
        }
        Err(e) => errors.push(format!("系统环境变量: {}", e)),
    }

    if state.cancel_flag.load(Ordering::SeqCst) {
        return Ok(SwitchResult {
            success: false,
            results: details,
            errors: vec!["已取消".into()],
            profile_name: profile.name,
            cancelled: true,
            rolled_back: false,
        });
    }

    emit_switch_progress(&app, 3, "editors");
    // 自动检测已安装的编辑器并逐一写入配置
    for (editor, path, mut settings) in editor_configs {
        if !settings
            .get("claudeCode.environmentVariables")
            .map(|v| v.is_array())
            .unwrap_or(false)
        {
            settings["claudeCode.environmentVariables"] = serde_json::json!([]);
        }
        if let Some(arr) = settings
            .get_mut("claudeCode.environmentVariables")
            .and_then(|v| v.as_array_mut())
        {
            apply_auth_to_env_array(arr, &profile.api_key, &effective_base_url);
            apply_role_models_to_env_array(arr, &profile);
        }
        apply_claude_model(&mut settings, "claudeCode.selectedModel", &profile.model_id);
        match write_json(&path, &settings) {
            Ok(_) => {
                details.editors.insert(editor.id.to_string(), true);
            }
            Err(e) => {
                details.editors.insert(editor.id.to_string(), false);
                errors.push(format!("{}: {}", editor.display_name, e));
            }
        }
    }

    if state.cancel_flag.load(Ordering::SeqCst) {
        return Ok(SwitchResult {
            success: false,
            results: details,
            errors: vec!["已取消".into()],
            profile_name: profile.name,
            cancelled: true,
            rolled_back: false,
        });
    }

    emit_switch_progress(&app, 4, "claude");
    let settings = &mut claude_settings;
    if !settings.get("env").map(|v| v.is_object()).unwrap_or(false) {
        settings["env"] = serde_json::json!({});
    }
    if let Some(env) = settings.get_mut("env").and_then(|v| v.as_object_mut()) {
        apply_auth_to_env_object(env, &profile.api_key, &effective_base_url);
        apply_role_models_to_env_object(env, &profile);
    }
    apply_claude_model(settings, "model", &profile.model_id);
    match write_json(&cp, &settings) {
        Ok(_) => details.claude = true,
        Err(e) => errors.push(format!("Claude: {}", e)),
    }

    // 切换配置后顺带标记引导已完成，避免 Claude Code CLI / IDE 插件
    // 每次换 Key 都重新弹一遍 onboarding 向导。
    if let Err(e) = mark_claude_onboarding_completed() {
        errors.push(format!("Claude onboarding: {}", e));
    }

    if state.cancel_flag.load(Ordering::SeqCst) {
        return Ok(SwitchResult {
            success: false,
            results: details,
            errors: vec!["已取消".into()],
            profile_name: profile.name,
            cancelled: true,
            rolled_back: false,
        });
    }

    emit_switch_progress(&app, 5, "finalize");
    // 所有位置成功同步后才提交活动标记。
    if errors.is_empty() {
        for p in data.profiles.iter_mut() {
            p.is_active = p.id == profile.id;
        }
        write_profiles(&app, &data)?;
    }

    emit_switch_progress(&app, 6, "done");

    Ok(SwitchResult {
        success: errors.is_empty(),
        results: details,
        errors,
        profile_name: profile.name,
        cancelled: false,
        rolled_back: false,
    })
}

pub(crate) fn apply_claude_model(settings: &mut serde_json::Value, key: &str, model: &str) {
    if model.trim().is_empty() {
        if let Some(object) = settings.as_object_mut() { object.remove(key); }
    } else {
        settings[key] = serde_json::json!(model.trim());
    }
}

pub(crate) fn claude_model_from_settings(settings: &serde_json::Value) -> String {
    settings
        .get("model")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .trim()
        .to_string()
}

#[tauri::command]
pub(crate) fn get_status(app: tauri::AppHandle) -> StatusResult {
    let settings = read_app_settings(&app);
    let env_vars = Some(LocationStatus {
        api_key: read_auth_from_system_env(),
        base_url: reg_get_env(BASE_URL_ENV),
        model: String::new(),
        image_api_key: String::new(),
        image_base_url: String::new(),
        image_skill_installed: false,
    });

    // 动态检测已安装的编辑器并读取状态
    let mut editors = HashMap::new();
    for editor in detect_installed_editors(&settings) {
        if let Some(status) = (|| -> Option<LocationStatus> {
            let s = read_json(&resolved_editor_settings_path(editor, &settings)).ok()?;
            let arr = s.get("claudeCode.environmentVariables")?.as_array()?;
            Some(LocationStatus {
                api_key: read_auth_from_env_array(arr),
                base_url: get_env_array_value(arr, BASE_URL_ENV).unwrap_or_default(),
                model: String::new(),
                image_api_key: String::new(),
                image_base_url: String::new(),
                image_skill_installed: false,
            })
        })() {
            editors.insert(editor.id.to_string(), status);
        }
    }

    let claude_settings = read_json(&claude_settings_path()).ok();
    let claude_model = claude_settings
        .as_ref()
        .map(claude_model_from_settings)
        .unwrap_or_default();
    let claude = claude_settings.as_ref().map(|s| {
        let env = s.get("env").and_then(|v| v.as_object());
        LocationStatus {
            api_key: env.map(read_auth_from_env_object).unwrap_or_default(),
            base_url: env
                .and_then(|e| e.get(BASE_URL_ENV))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            model: String::new(),
            image_api_key: String::new(),
            image_base_url: String::new(),
            image_skill_installed: false,
        }
    });

    StatusResult {
        env_vars,
        editors,
        claude,
        claude_model,
    }
}


#[tauri::command]
pub(crate) fn import_current(app: tauri::AppHandle, name: String) -> Result<Profile, String> {
    let settings = read_app_settings(&app);
    let mut api_key = String::new();
    let mut base_url = String::new();

    // 先尝试 Claude settings
    if let Ok(s) = read_json(&claude_settings_path()) {
        if let Some(env) = s.get("env").and_then(|v| v.as_object()) {
            api_key = read_auth_from_env_object(env);
            base_url = env
                .get(BASE_URL_ENV)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
        }
    }

    // 回退到已安装的编辑器配置
    if api_key.is_empty() || base_url.is_empty() {
        for editor in detect_installed_editors(&settings) {
            if let Ok(s) = read_json(&resolved_editor_settings_path(editor, &settings)) {
                if let Some(arr) = s
                    .get("claudeCode.environmentVariables")
                    .and_then(|v| v.as_array())
                {
                    if api_key.is_empty() {
                        api_key = read_auth_from_env_array(arr);
                    }
                    if base_url.is_empty() {
                        base_url = get_env_array_value(arr, BASE_URL_ENV).unwrap_or_default();
                    }
                }
            }
            if !api_key.is_empty() && !base_url.is_empty() {
                break;
            }
        }
    }

    // Fallback to system env vars for any missing field
    if api_key.is_empty() || base_url.is_empty() {
        let env_api_key = read_auth_from_system_env();
        let env_base_url = reg_get_env(BASE_URL_ENV);
        if api_key.is_empty() {
            api_key = env_api_key;
        }
        if base_url.is_empty() {
            base_url = env_base_url;
        }
    }

    if api_key.is_empty() || base_url.is_empty() {
        return Err("未检测到当前配置".into());
    }

    let mut data = read_profiles(&app);
    if data
        .profiles
        .iter()
        .any(|x| x.api_key == api_key && x.base_url == base_url)
    {
        return Err("该配置已存在".into());
    }

    let profile = Profile {
        id: uuid::Uuid::new_v4().to_string(),
        name: if name.is_empty() {
            "导入的配置".into()
        } else {
            name
        },
        api_key,
        base_url,
        model_id: String::new(),
        sonnet_model: String::new(),
        opus_model: String::new(),
        haiku_model: String::new(),
        // 导入的是本机直连环境变量，一律按 Anthropic 直连处理
        api_format: default_claude_api_format(),
        proxy_failover: false,
        proxy_takeover: false,
        is_active: true,
        created_at: chrono_now(),
    };

    for p in data.profiles.iter_mut() {
        p.is_active = false;
    }
    data.profiles.push(profile.clone());
    write_profiles(&app, &data)?;
    Ok(profile)
}

#[cfg(test)]
mod switch_tests {
    use super::*;

    fn result(success: bool, cancelled: bool) -> SwitchResult {
        SwitchResult {
            success,
            cancelled,
            rolled_back: false,
            profile_name: "test".into(),
            errors: if success { vec![] } else { vec!["write failed".into()] },
            results: SwitchDetails { env_vars: true, editors: HashMap::new(), claude: false },
        }
    }

    #[test]
    fn failed_or_cancelled_switch_restores_existing_and_new_files() {
        for cancelled in [false, true] {
            let dir = std::env::temp_dir().join(format!("varswitch-rollback-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&dir).unwrap();
            let existing = dir.join("settings.json");
            let created = dir.join("new-settings.json");
            fs::write(&existing, "new configuration").unwrap();
            fs::write(&created, "new configuration").unwrap();
            let restored = finish_claude_switch(Ok(result(false, cancelled)), || {
                restore_config_file(&existing, Some("old configuration"))?;
                restore_config_file(&created, None)
            }).unwrap();
            assert!(!restored.success);
            assert!(restored.rolled_back);
            assert_eq!(restored.cancelled, cancelled);
            assert_eq!(fs::read_to_string(existing).unwrap(), "old configuration");
            assert!(!created.exists());
            fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn successful_switch_does_not_rollback_and_errors_report_restore_failures() {
        let success = finish_claude_switch(Ok(result(true, false)), || panic!("must not rollback success")).unwrap();
        assert!(success.success);
        let failure = finish_claude_switch(Ok(result(false, false)), || Err("read only".into())).unwrap();
        assert!(!failure.rolled_back);
        assert!(failure.errors.iter().any(|e| e.contains("read only")));
        let error = finish_claude_switch(Err("write failed".into()), || Err("restore failed".into())).err().unwrap();
        assert!(error.contains("write failed") && error.contains("restore failed"));
    }
}
