//! OpenCode（sst/opencode，开源 AI 编程 CLI/TUI）多套 API 配置管理与一键切换。
//!
//! ── 配置兼容性（2026-10 官方源码 + macOS OpenCode 2.1.4 实测）──────────────
//!
//! 1. 全局配置文件：`~/.config/opencode/opencode.json`（同目录 `opencode.jsonc` 亦可，支持注释）。
//!    文档：https://opencode.ai/docs/config/#global
//!    OpenCode 用 xdg-basedir 语义解析目录，该实现在 Windows 上同样落在用户主目录下的
//!    `.config`（而非 %APPDATA%），本机实测确认存在 `C:\Users\<user>\.config\opencode\opencode.json`。
//!    同目录 JSONC 后加载，优先于 JSON；`OPENCODE_CONFIG` 是额外覆盖层。
//!    文档：https://opencode.ai/docs/config/#custom-path
//!
//! 2. 认证凭据：TUI 的 `/connect`（旧版 `opencode auth login`）把 API Key 写入
//!    `~/.local/share/opencode/auth.json`，格式为
//!    `{ "<providerID>": { "type": "api", "key": "sk-..." } }`（OAuth 则是 type=oauth + access/refresh）。
//!    文档：https://opencode.ai/docs/providers/#credentials
//!    源码：packages/opencode/src/auth/index.ts
//!
//! 3. 切换 API Key 写哪里 → **写全局配置的 provider options，不动 auth.json**。理由：
//!    provider.ts 的加载顺序是 env → auth.json → 插件 → config「最后再合并一次」，
//!    并且组装模型请求参数时是
//!    `if (options["apiKey"] === undefined && provider.key) options["apiKey"] = provider.key`
//!    —— 即 config 里的 `options.apiKey` 优先级高于 auth.json 与环境变量。
//!    因此无需覆盖用户 auth.json 里的 OAuth 登录态
//!    （例如 ChatGPT Plus / Claude Pro 订阅），对用户最无感也最不具破坏性。
//!    源码：https://github.com/sst/opencode/blob/dev/packages/opencode/src/provider/provider.ts
//!
//! 4. V1 字段为 `provider.<id>.options.{apiKey,baseURL}`，model 为 `provider/model`。
//!    V2 原生字段为 `providers.<id>.settings.{apiKey,baseURL}`，model 也可为
//!    `{ "providerID": "...", "model": "..." }`。已有原生 providers 时必须更新它，
//!    因为 V2 归一化时原生 provider 会覆盖同 id 的整个 V1 provider。
//!    自定义模型必须同时在该 provider 的 models 中声明，否则不会进入可选模型列表。
//!    文档：https://opencode.ai/docs/config/#models、https://opencode.ai/docs/providers/#base-url
//!
//! 5. provider id 采用 models.dev 命名：anthropic / openai / deepseek / moonshotai / zhipuai / opencode(Zen) …
//!    文档：https://opencode.ai/docs/providers/
//!
//! 写入策略：更新 provider 的凭据、地址、默认模型与必要的模型声明；
//! 其余用户配置（其他 provider、已有模型定义、npm、mcp、permission 等）保留；文件与目录不存在则创建；
//! 全部走 `crate::write_file_atomic` 原子写入。

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

/// OpenCode 官方 JSON Schema 地址，新建配置文件时写入，方便编辑器补全校验。
const OPENCODE_SCHEMA_URL: &str = "https://opencode.ai/config.json";

/// 未指定 provider 时的兜底 id（models.dev 命名）。
const DEFAULT_PROVIDER_ID: &str = "anthropic";

fn default_provider_id() -> String {
    DEFAULT_PROVIDER_ID.to_string()
}

/// OpenCode API 配置档案。base_url 留空表示使用该 provider 的官方地址。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenCodeProfile {
    pub id: String,
    pub name: String,
    pub api_key: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
    #[serde(default = "default_provider_id")]
    pub provider_id: String,
    #[serde(default)]
    pub is_active: bool,
    pub created_at: String,
}

#[derive(Serialize, Deserialize, Default, Clone)]
pub(crate) struct OpenCodeProfilesData {
    pub profiles: Vec<OpenCodeProfile>,
}

// ── 路径解析 ────────────────────────────────────────────────────────────────

/// 档案列表存放在应用数据目录（支持用户自定义覆盖）。
fn opencode_profiles_path(app: &tauri::AppHandle) -> PathBuf {
    crate::data_dir(app).join("opencode_profiles.json")
}

/// OpenCode 全局配置目录：优先 XDG_CONFIG_HOME，否则 ~/.config/opencode（Windows 同样如此）。
fn opencode_config_dir() -> PathBuf {
    if let Ok(raw) = std::env::var("XDG_CONFIG_HOME") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed).join("opencode");
        }
    }
    crate::home_dir().join(".config").join("opencode")
}

/// 实际要读写的配置文件：OPENCODE_CONFIG > 已存在的 opencode.jsonc > 默认 opencode.json。
fn opencode_config_path() -> PathBuf {
    if let Ok(raw) = std::env::var("OPENCODE_CONFIG") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    preferred_config_path(&opencode_config_dir())
}

fn preferred_config_path(dir: &Path) -> PathBuf {
    let jsonc = dir.join("opencode.jsonc");
    if jsonc.exists() {
        return jsonc;
    }
    dir.join("opencode.json")
}

/// 配置来源标识，前端状态卡展示用。
fn opencode_config_source() -> &'static str {
    match std::env::var("OPENCODE_CONFIG") {
        Ok(raw) if !raw.trim().is_empty() => "env:OPENCODE_CONFIG",
        _ => "global",
    }
}

/// 检测 opencode CLI 是否安装：先扫 PATH，再看官方安装脚本的默认落点。
fn opencode_installed() -> bool {
    let candidates = if cfg!(windows) {
        vec![
            "opencode.exe",
            "opencode.cmd",
            "opencode.ps1",
            "opencode.bat",
        ]
    } else {
        vec!["opencode"]
    };
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            if candidates.iter().any(|name| dir.join(name).is_file()) {
                return true;
            }
        }
    }
    let home = crate::home_dir();
    let fallbacks = [
        home.join(".opencode").join("bin").join("opencode"),
        home.join(".opencode").join("bin").join("opencode.exe"),
        home.join(".local")
            .join("share")
            .join("opencode")
            .join("bin")
            .join("opencode"),
        home.join(".local")
            .join("share")
            .join("opencode")
            .join("bin")
            .join("opencode.exe"),
    ];
    fallbacks.iter().any(|path| path.is_file())
}

// ── JSON / JSONC 读写 ───────────────────────────────────────────────────────

/// 去掉 JSONC 的行注释、块注释与尾随逗号，使其能被 serde_json 解析。
/// 字符串字面量内的内容原样保留（含转义），避免把 URL 里的 `//` 当注释。
pub(crate) fn sanitize_jsonc(raw: &str) -> String {
    let chars: Vec<char> = raw.chars().collect();
    let mut out = String::with_capacity(raw.len());
    let mut i = 0usize;
    let mut in_string = false;
    while i < chars.len() {
        let c = chars[i];
        if in_string {
            out.push(c);
            if c == '\\' && i + 1 < chars.len() {
                out.push(chars[i + 1]);
                i += 2;
                continue;
            }
            if c == '"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        if c == '"' {
            in_string = true;
            out.push(c);
            i += 1;
            continue;
        }
        if c == '/' && i + 1 < chars.len() && chars[i + 1] == '/' {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' && i + 1 < chars.len() && chars[i + 1] == '*' {
            out.push(' ');
            i += 2;
            while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                i += 1;
            }
            i = (i + 2).min(chars.len());
            continue;
        }
        out.push(c);
        i += 1;
    }
    // 先去掉全部注释，再判断尾随逗号；逗号后面可能还有注释。
    let chars: Vec<char> = out.chars().collect();
    let mut out = String::with_capacity(chars.len());
    i = 0;
    in_string = false;
    while i < chars.len() {
        let c = chars[i];
        if in_string && c == '\\' && i + 1 < chars.len() {
            out.push(c);
            out.push(chars[i + 1]);
            i += 2;
            continue;
        }
        if c == '"' {
            in_string = !in_string;
        }
        if !in_string && c == ',' {
            let mut j = i + 1;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            if j < chars.len() && (chars[j] == '}' || chars[j] == ']') {
                i += 1;
                continue;
            }
        }
        out.push(c);
        i += 1;
    }
    out
}

/// 解析 OpenCode 配置文本为顶层对象；先按标准 JSON 解析，失败再按 JSONC 兜底。
fn parse_opencode_config(raw: &str) -> Result<Map<String, Value>, String> {
    if raw.trim().is_empty() {
        return Ok(Map::new());
    }
    let parsed: Value = match serde_json::from_str(raw) {
        Ok(value) => value,
        Err(_) => serde_json::from_str(&sanitize_jsonc(raw))
            .map_err(|e| format!("解析 OpenCode 配置失败（不是合法的 JSON/JSONC）: {e}"))?,
    };
    match parsed {
        Value::Object(map) => Ok(map),
        _ => Err("OpenCode 配置根节点必须是 JSON 对象".into()),
    }
}

/// 读取全局配置；文件不存在时返回空对象（首次切换会创建）。
fn read_opencode_config(path: &Path) -> Result<Map<String, Value>, String> {
    if !path.exists() {
        return Ok(Map::new());
    }
    let raw = fs::read_to_string(path).map_err(|e| format!("读取 OpenCode 配置失败: {e}"))?;
    parse_opencode_config(&raw)
}

fn write_opencode_config(path: &Path, config: &Map<String, Value>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建 OpenCode 配置目录失败: {e}"))?;
    }
    let json = serde_json::to_string_pretty(&Value::Object(config.clone()))
        .map_err(|e| format!("序列化 OpenCode 配置失败: {e}"))?;
    crate::write_file_atomic(path, &format!("{json}\n"))
}

// ── 档案列表存取 ────────────────────────────────────────────────────────────

pub(crate) fn read_opencode_profiles(app: &tauri::AppHandle) -> OpenCodeProfilesData {
    let path = opencode_profiles_path(app);
    if !path.exists() {
        return OpenCodeProfilesData::default();
    }
    let mut data: OpenCodeProfilesData = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    for p in data.profiles.iter_mut() {
        p.api_key =
            crate::decrypt_secret_or_keep(&p.api_key, &format!("OpenCode 配置「{}」", p.name));
    }
    data
}

fn write_opencode_profiles(
    app: &tauri::AppHandle,
    data: &OpenCodeProfilesData,
) -> Result<(), String> {
    let mut encrypted = data.clone();
    for p in encrypted.profiles.iter_mut() {
        p.api_key = crate::encrypt_secret(&p.api_key);
    }
    let json = serde_json::to_string_pretty(&encrypted).map_err(|e| e.to_string())?;
    crate::write_file_atomic(&opencode_profiles_path(app), &json)?;
    // 与其他四个应用保持一致：列表变化后刷新托盘快速切换菜单
    crate::refresh_tray_menu(app);
    Ok(())
}

// ── 纯函数：字段归一化与配置合并 ────────────────────────────────────────────

/// provider id 归一化：去空白、转小写，空值回落默认 provider。
fn normalize_provider_id(raw: &str) -> String {
    let trimmed = raw.trim().to_lowercase();
    if trimmed.is_empty() {
        default_provider_id()
    } else {
        trimmed
    }
}

/// 组装 OpenCode 顶层 model 字段：`provider/model`。
/// 用户已经把 provider 前缀写进模型名时不再重复拼接。
fn compose_model_ref(provider_id: &str, model: &str) -> String {
    let model = model.trim();
    if model.is_empty() {
        return String::new();
    }
    if model.starts_with(&format!("{provider_id}/")) {
        return model.to_string();
    }
    format!("{provider_id}/{model}")
}

/// API Key 打码：保留前 6 后 4；长度不足 12 时整体打码，避免短 key 泄漏。
fn mask_api_key(key: &str) -> String {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let chars: Vec<char> = trimmed.chars().collect();
    if chars.len() < 12 {
        return "*".repeat(chars.len());
    }
    let head: String = chars[..6].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head}****{tail}")
}

/// 取出 map 中的对象字段；不存在或类型不对时重建为空对象，保证后续可安全写入。
fn object_entry<'a>(parent: &'a mut Map<String, Value>, key: &str) -> &'a mut Map<String, Value> {
    let slot = parent
        .entry(key.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !slot.is_object() {
        *slot = Value::Object(Map::new());
    }
    slot.as_object_mut().expect("上一步已保证是对象")
}

/// 同时注册所选模型，保证网关的自定义模型也能在 OpenCode 中选用。
/// 已有模型的元数据与同一 provider 下的其他配置保留。
/// base_url 为空表示用官方地址，此时移除我们之前写入的 baseURL 覆盖。
fn apply_profile_to_config(config: &mut Map<String, Value>, profile: &OpenCodeProfile) {
    let provider_id = normalize_provider_id(&profile.provider_id);
    let has_provider = |key: &str| {
        config
            .get(key)
            .and_then(|map| map.get(&provider_id))
            .is_some()
    };
    let native = has_provider("providers")
        || (!has_provider("provider")
            && (config.contains_key("providers")
                || config.get("model").is_some_and(Value::is_object)));
    let model_ref = compose_model_ref(&provider_id, &profile.model);

    if !config.contains_key("$schema") {
        config.insert(
            "$schema".to_string(),
            Value::String(OPENCODE_SCHEMA_URL.to_string()),
        );
    }

    let providers = object_entry(config, if native { "providers" } else { "provider" });
    let provider = object_entry(providers, &provider_id);
    let options = object_entry(provider, if native { "settings" } else { "options" });

    options.insert(
        "apiKey".to_string(),
        Value::String(profile.api_key.trim().to_string()),
    );
    let base_url = profile.base_url.trim().trim_end_matches('/');
    if base_url.is_empty() {
        options.remove("baseURL");
    } else {
        options.insert("baseURL".to_string(), Value::String(base_url.to_string()));
    }

    if !model_ref.is_empty() {
        let model_id = model_ref.strip_prefix(&format!("{provider_id}/")).unwrap();
        object_entry(provider, "models")
            .entry(model_id.to_string())
            .or_insert_with(|| serde_json::json!({ "name": model_id }));
        let model = if native {
            serde_json::json!({ "providerID": provider_id, "model": model_id })
        } else {
            Value::String(model_ref)
        };
        config.insert("model".to_string(), model);
    }
}

/// 从配置对象反推「当前生效」的 provider / model / baseURL / apiKey。
/// 优先用顶层 model 的 provider 前缀定位；没有 model 时，若只配置了一个 provider 就用它。
fn resolve_active_provider(config: &Map<String, Value>) -> (String, String, String, String) {
    let model_ref = config
        .get("model")
        .map(|value| {
            if let Some(model) = value.as_str() {
                return model.to_string();
            }
            match (
                value.get("providerID").and_then(Value::as_str),
                value.get("model").and_then(Value::as_str),
            ) {
                (Some(provider), Some(model)) => compose_model_ref(provider, model),
                _ => String::new(),
            }
        })
        .unwrap_or_default();
    // V2 的原生 provider 优先于同 id 的旧格式 provider，不能只读旧字段。
    let mut providers = config
        .get("provider")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(native) = config.get("providers").and_then(Value::as_object) {
        providers.extend(native.clone());
    }

    let provider_id = model_ref
        .split_once('/')
        .map(|(prefix, _)| prefix.to_string())
        .filter(|prefix| !prefix.is_empty())
        .or_else(|| {
            (providers.len() == 1)
                .then(|| providers.keys().next().cloned())
                .flatten()
        })
        .unwrap_or_default();

    let native = config
        .get("providers")
        .and_then(|map| map.get(&provider_id))
        .is_some();
    let options = providers
        .get(&provider_id)
        .and_then(Value::as_object)
        .and_then(|entry| entry.get(if native { "settings" } else { "options" }))
        .and_then(Value::as_object);
    let api_key = options
        .and_then(|opts| opts.get("apiKey"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let base_url = options
        .and_then(|opts| opts.get("baseURL"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    (provider_id, model_ref, base_url, api_key)
}

// ── Tauri 命令 ──────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_opencode_profiles(app: tauri::AppHandle) -> Result<OpenCodeProfilesData, String> {
    Ok(read_opencode_profiles(&app))
}

#[tauri::command]
pub fn add_opencode_profile(
    app: tauri::AppHandle,
    name: String,
    api_key: String,
    base_url: String,
    model: Option<String>,
    provider_id: Option<String>,
) -> Result<OpenCodeProfile, String> {
    if name.trim().is_empty() || api_key.trim().is_empty() {
        return Err("配置名称和 API Key 都必须填写".into());
    }
    let profile = OpenCodeProfile {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.trim().to_string(),
        api_key: api_key.trim().to_string(),
        base_url: base_url.trim().trim_end_matches('/').to_string(),
        model: model.unwrap_or_default().trim().to_string(),
        provider_id: normalize_provider_id(&provider_id.unwrap_or_default()),
        is_active: false,
        created_at: crate::chrono_now(),
    };
    let mut data = read_opencode_profiles(&app);
    data.profiles.push(profile.clone());
    write_opencode_profiles(&app, &data)?;
    Ok(profile)
}

#[tauri::command]
pub fn update_opencode_profile(
    app: tauri::AppHandle,
    id: String,
    name: String,
    api_key: String,
    base_url: String,
    model: Option<String>,
    provider_id: Option<String>,
) -> Result<OpenCodeProfile, String> {
    let mut data = read_opencode_profiles(&app);
    let profile = data
        .profiles
        .iter_mut()
        .find(|profile| profile.id == id)
        .ok_or("配置未找到")?;
    if !name.trim().is_empty() {
        profile.name = name.trim().to_string();
    }
    // 与 Gemini 一致：留空表示不修改已保存的 Key
    if !api_key.trim().is_empty() {
        profile.api_key = api_key.trim().to_string();
    }
    profile.base_url = base_url.trim().trim_end_matches('/').to_string();
    profile.model = model.unwrap_or_default().trim().to_string();
    profile.provider_id = normalize_provider_id(&provider_id.unwrap_or_default());
    let updated = profile.clone();
    write_opencode_profiles(&app, &data)?;
    Ok(updated)
}

#[tauri::command]
pub fn delete_opencode_profile(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let mut data = read_opencode_profiles(&app);
    data.profiles.retain(|profile| profile.id != id);
    write_opencode_profiles(&app, &data)
}

/// 切换：把选中的档案写进 OpenCode 全局配置，并维护 is_active。
#[tauri::command]
pub fn switch_opencode_profile(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let mut data = read_opencode_profiles(&app);
    let profile = data
        .profiles
        .iter()
        .find(|profile| profile.id == id)
        .ok_or("配置未找到")?
        .clone();
    crate::ensure_secret_usable(
        &profile.api_key,
        &format!("OpenCode 配置「{}」", profile.name),
    )?;

    let path = opencode_config_path();
    let mut config = read_opencode_config(&path)?;
    apply_profile_to_config(&mut config, &profile);
    write_opencode_config(&path, &config)?;

    for item in data.profiles.iter_mut() {
        item.is_active = item.id == profile.id;
    }
    write_opencode_profiles(&app, &data)
}

/// 读取 OpenCode 当前运行时配置，供状态卡与「导入当前配置」使用。
#[tauri::command]
pub fn get_opencode_runtime_status() -> Result<Value, String> {
    let path = opencode_config_path();
    let exists = path.exists();
    let config = read_opencode_config(&path)?;
    let (provider, model, base_url, api_key) = resolve_active_provider(&config);

    Ok(serde_json::json!({
        "installed": opencode_installed(),
        "configPath": path.to_string_lossy(),
        "configExists": exists,
        "provider": provider,
        "model": model,
        "baseUrl": base_url,
        "apiKey": mask_api_key(&api_key),
        "source": opencode_config_source(),
    }))
}

#[tauri::command]
pub fn reorder_opencode_profiles(
    app: tauri::AppHandle,
    ids: Vec<String>,
) -> Result<OpenCodeProfilesData, String> {
    let mut data = read_opencode_profiles(&app);
    data.profiles = crate::reorder_by_ids(std::mem::take(&mut data.profiles), &ids, |p| &p.id);
    write_opencode_profiles(&app, &data)?;
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(provider_id: &str, api_key: &str, base_url: &str, model: &str) -> OpenCodeProfile {
        OpenCodeProfile {
            id: "test-id".into(),
            name: "测试配置".into(),
            api_key: api_key.into(),
            base_url: base_url.into(),
            model: model.into(),
            provider_id: provider_id.into(),
            is_active: false,
            created_at: "0".into(),
        }
    }

    #[test]
    fn apply_profile_preserves_unmanaged_keys() {
        let existing = r#"{
          "$schema": "https://opencode.ai/config.json",
          "autoupdate": false,
          "permission": { "bash": "ask" },
          "provider": {
            "deepseek": { "options": { "apiKey": "sk-other" } },
            "anthropic": {
              "npm": "@ai-sdk/anthropic",
              "name": "公司网关",
              "models": { "claude-sonnet-4-5": { "name": "Sonnet" } },
              "options": { "timeout": 600000, "apiKey": "sk-old" }
            }
          }
        }"#;
        let mut config = parse_opencode_config(existing).expect("配置应能解析");
        apply_profile_to_config(
            &mut config,
            &profile(
                "anthropic",
                "sk-new-key",
                "https://gw.example.com/v1/",
                "claude-sonnet-4-6",
            ),
        );

        // 无关的顶层键与其他 provider 原样保留
        assert_eq!(config.get("autoupdate"), Some(&Value::Bool(false)));
        assert!(config.get("permission").is_some());
        let providers = config["provider"].as_object().unwrap();
        assert_eq!(providers["deepseek"]["options"]["apiKey"], "sk-other");

        // 同一 provider 下我们不管的键也保留
        let anthropic = providers["anthropic"].as_object().unwrap();
        assert_eq!(anthropic["npm"], "@ai-sdk/anthropic");
        assert_eq!(anthropic["name"], "公司网关");
        assert!(anthropic["models"]["claude-sonnet-4-5"].is_object());
        assert_eq!(
            anthropic["models"]["claude-sonnet-4-6"]["name"],
            "claude-sonnet-4-6"
        );
        assert_eq!(anthropic["options"]["timeout"], 600000);

        // 我们管理的键被更新（baseURL 去掉末尾斜杠）
        assert_eq!(anthropic["options"]["apiKey"], "sk-new-key");
        assert_eq!(anthropic["options"]["baseURL"], "https://gw.example.com/v1");
        assert_eq!(config["model"], "anthropic/claude-sonnet-4-6");
    }

    #[test]
    fn switching_is_idempotent_and_empty_base_url_clears_override() {
        let mut config = Map::new();
        let official = profile("moonshotai", "sk-kimi", "", "kimi-k2.5");
        apply_profile_to_config(&mut config, &official);
        let first = serde_json::to_string(&Value::Object(config.clone())).unwrap();
        apply_profile_to_config(&mut config, &official);
        let second = serde_json::to_string(&Value::Object(config.clone())).unwrap();
        assert_eq!(first, second, "重复切换同一配置结果必须一致");

        // 先写入自定义网关，再切回官方（base_url 留空）应移除 baseURL 覆盖
        apply_profile_to_config(
            &mut config,
            &profile(
                "moonshotai",
                "sk-kimi",
                "https://proxy.example.com/v1",
                "kimi-k2.5",
            ),
        );
        assert_eq!(
            config["provider"]["moonshotai"]["options"]["baseURL"],
            "https://proxy.example.com/v1"
        );
        apply_profile_to_config(&mut config, &official);
        assert!(config["provider"]["moonshotai"]["options"]
            .get("baseURL")
            .is_none());
        assert_eq!(config["$schema"], OPENCODE_SCHEMA_URL);
    }

    #[test]
    fn mask_api_key_keeps_head_and_tail_only() {
        assert_eq!(mask_api_key("sk-ant-api03-abcdefgh1234"), "sk-ant****1234");
        assert_eq!(mask_api_key("short"), "*****");
        assert_eq!(mask_api_key("  "), "");
    }

    #[test]
    fn jsonc_config_with_comments_is_readable() {
        let raw = r#"{
          // 行注释：默认模型
          "model": "deepseek/deepseek-v4-pro",
          /* 块注释 */
          "provider": {
            "deepseek": { "options": { "baseURL": "https://api.deepseek.com" } },
          },
        }"#;
        let config = parse_opencode_config(raw).expect("JSONC 应能解析");
        assert_eq!(config["model"], "deepseek/deepseek-v4-pro");
        assert_eq!(
            config["provider"]["deepseek"]["options"]["baseURL"],
            "https://api.deepseek.com"
        );
    }

    #[test]
    fn model_ref_and_provider_id_are_normalized() {
        assert_eq!(
            compose_model_ref("openai", "gpt-5.6-sol"),
            "openai/gpt-5.6-sol"
        );
        // 用户已带前缀时不重复拼接
        assert_eq!(
            compose_model_ref("openai", "openai/gpt-5.6-sol"),
            "openai/gpt-5.6-sol"
        );
        assert_eq!(compose_model_ref("openai", "  "), "");
        assert_eq!(normalize_provider_id("  MoonshotAI "), "moonshotai");
        assert_eq!(normalize_provider_id(""), DEFAULT_PROVIDER_ID);
    }

    #[test]
    fn runtime_status_resolves_active_provider_from_model_prefix() {
        let raw = r#"{
          "model": "zhipuai/glm-5",
          "provider": {
            "anthropic": { "options": { "apiKey": "sk-not-active" } },
            "zhipuai": { "options": { "apiKey": "sk-zhipu-key-1234", "baseURL": "https://open.bigmodel.cn/api/paas/v4" } }
          }
        }"#;
        let config = parse_opencode_config(raw).unwrap();
        let (provider, model, base_url, api_key) = resolve_active_provider(&config);
        assert_eq!(provider, "zhipuai");
        assert_eq!(model, "zhipuai/glm-5");
        assert_eq!(base_url, "https://open.bigmodel.cn/api/paas/v4");
        assert_eq!(mask_api_key(&api_key), "sk-zhi****1234");
    }

    #[test]
    fn switching_registers_custom_gateway_models_without_replacing_metadata() {
        let mut config = parse_opencode_config(r#"{
            "provider": { "anthropic": { "models": {
                "kimi-k3.1-pro": { "name": "My Kimi", "limit": { "context": 128000, "output": 8000 } }
            } } }
        }"#).unwrap();
        apply_profile_to_config(
            &mut config,
            &profile(
                "anthropic",
                "key-one",
                "https://gateway.example",
                "anthropic/kimi-k3.1-pro",
            ),
        );
        let original = config["provider"]["anthropic"]["models"]["kimi-k3.1-pro"].clone();
        assert_eq!(original["name"], "My Kimi");
        assert_eq!(original["limit"]["context"], 128000);
        apply_profile_to_config(
            &mut config,
            &profile(
                "anthropic",
                "key-two",
                "https://gateway.example",
                "custom-next",
            ),
        );
        assert_eq!(config["model"], "anthropic/custom-next");
        assert_eq!(
            config["provider"]["anthropic"]["models"]["custom-next"]["name"],
            "custom-next"
        );
        assert_eq!(
            config["provider"]["anthropic"]["models"]["kimi-k3.1-pro"],
            original
        );
        assert!(config["provider"]["anthropic"]["models"]
            .get("anthropic/kimi-k3.1-pro")
            .is_none());
    }

    #[test]
    fn native_v2_provider_is_updated_instead_of_shadowed_legacy_fields() {
        let mut config = parse_opencode_config(r#"{
            "model": { "providerID": "anthropic", "model": "old" },
            "provider": { "anthropic": { "options": { "apiKey": "legacy" } } },
            "providers": {
                "anthropic": { "package": "anthropic", "settings": { "apiKey": "native-old", "baseURL": "https://old.example", "timeout": 60000 }, "models": { "old": { "name": "Old" } } },
                "openai": { "settings": { "apiKey": "unrelated" } }
            },
            "permissions": []
        }"#).unwrap();
        let selected = profile(
            "anthropic",
            "new-key",
            "https://new.example/",
            "kimi-k3.1-pro",
        );
        apply_profile_to_config(&mut config, &selected);
        let provider = &config["providers"]["anthropic"];
        assert_eq!(provider["settings"]["apiKey"], "new-key");
        assert_eq!(provider["settings"]["baseURL"], "https://new.example");
        assert_eq!(provider["settings"]["timeout"], 60000);
        assert_eq!(provider["package"], "anthropic");
        assert_eq!(provider["models"]["old"]["name"], "Old");
        assert!(provider["models"]["kimi-k3.1-pro"].is_object());
        assert_eq!(
            config["model"],
            serde_json::json!({ "providerID": "anthropic", "model": "kimi-k3.1-pro" })
        );
        assert_eq!(
            resolve_active_provider(&config),
            (
                "anthropic".into(),
                "anthropic/kimi-k3.1-pro".into(),
                "https://new.example".into(),
                "new-key".into()
            )
        );
        assert_eq!(
            config["providers"]["openai"]["settings"]["apiKey"],
            "unrelated"
        );
        apply_profile_to_config(
            &mut config,
            &profile("anthropic", "official", "", "kimi-k3.1-pro"),
        );
        assert!(config["providers"]["anthropic"]["settings"]
            .get("baseURL")
            .is_none());
    }

    #[test]
    fn mixed_format_keeps_legacy_provider_definitions_when_other_providers_are_native() {
        let mut config = parse_opencode_config(
            r#"{
            "providers": { "openai": { "settings": { "apiKey": "native" } } },
            "provider": { "anthropic": {
                "npm": "@ai-sdk/anthropic",
                "models": { "custom": { "name": "Preserved", "options": { "temperature": 0.5 } } },
                "options": { "apiKey": "old" }
            } }
        }"#,
        )
        .unwrap();
        apply_profile_to_config(&mut config, &profile("anthropic", "new-key", "", "custom"));
        assert!(config["providers"].get("anthropic").is_none());
        assert_eq!(config["provider"]["anthropic"]["npm"], "@ai-sdk/anthropic");
        assert_eq!(
            config["provider"]["anthropic"]["models"]["custom"]["name"],
            "Preserved"
        );
        assert_eq!(resolve_active_provider(&config).3, "new-key");
    }

    #[test]
    fn jsonc_wins_and_switch_updates_the_file_opencode_loads_last() {
        let dir =
            std::env::temp_dir().join(format!("varswitch-opencode-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let json = dir.join("opencode.json");
        let jsonc = dir.join("opencode.jsonc");
        write_opencode_config(&json, &parse_opencode_config(r#"{
            "model": "anthropic/json-model", "permission": { "bash": "ask" },
            "provider": { "anthropic": { "options": { "baseURL": "https://old.example" }, "models": { "kept": { "name": "Keep me" } } } }
        }"#).unwrap()).unwrap();
        assert_eq!(preferred_config_path(&dir), json);
        let original_json = fs::read_to_string(&json).unwrap();
        fs::write(&jsonc, r#"{ // Higher priority
            "permission": { "edit": "ask" },
            "model": "anthropic/jsonc-model", "provider": { "anthropic": { "options": { "apiKey": "old" } } },
        }"#).unwrap();
        let target = preferred_config_path(&dir);
        assert_eq!(target, jsonc);
        let mut config = read_opencode_config(&target).unwrap();
        assert_eq!(config["model"], "anthropic/jsonc-model");
        apply_profile_to_config(
            &mut config,
            &profile(
                "anthropic",
                "selected-key",
                "https://new.example",
                "custom-model",
            ),
        );
        write_opencode_config(&target, &config).unwrap();
        let actual = read_opencode_config(&target).unwrap();
        assert_eq!(actual["model"], "anthropic/custom-model");
        assert_eq!(actual["permission"]["edit"], "ask");
        assert_eq!(fs::read_to_string(&json).unwrap(), original_json);
        assert_eq!(
            actual["provider"]["anthropic"]["models"]["custom-model"]["name"],
            "custom-model"
        );
        assert_eq!(resolve_active_provider(&actual).3, "selected-key");
        fs::remove_dir_all(&dir).unwrap();
    }
}
