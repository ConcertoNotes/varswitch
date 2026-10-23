mod claude_proxy;
mod claude_desktop;
mod claude_desktop_gateway;
mod claude_desktop_localization;
mod claude_desktop_provider;
mod usage_stats;
mod opencode;

// ── 领域模块（由 lib.rs 拆分而来，通过下方通配 re-export 保持原有扁平命名空间）──
mod app_settings;
mod balance;
mod claude;
mod codex;
mod codex_toolbox;
mod common;
#[cfg(not(target_os = "windows"))]
mod shell_env;
mod deeplink;
mod gemini;
mod grok;
mod health;
mod mcp;
mod prompts;
mod secret_store;
mod sessions;
mod skills;
mod tray;

pub(crate) use app_settings::*;
pub(crate) use balance::*;
pub(crate) use claude::*;
pub(crate) use codex::*;
pub(crate) use codex_toolbox::*;
pub(crate) use common::*;
pub(crate) use deeplink::*;
pub(crate) use gemini::*;
pub(crate) use grok::*;
pub(crate) use health::*;
pub(crate) use mcp::*;
pub(crate) use prompts::*;
pub(crate) use secret_store::*;
pub(crate) use sessions::*;
pub(crate) use skills::*;
pub(crate) use tray::*;

use base64::Engine;
use image::{DynamicImage, Luma};
use qrcode::{EcLevel, QrCode};
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::cmp::Ordering as CmpOrdering;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::OnceLock;
use std::sync::{mpsc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::{
    menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, State,
};
use tauri_plugin_updater::UpdaterExt;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
use winreg::enums::HKEY_CURRENT_USER;
#[cfg(target_os = "windows")]
use winreg::RegKey;

/// 便捷日志宏，用法同 println!：log_info!("xxx {}", v)。
macro_rules! log_info {
    ($($arg:tt)*) => { app_log("INFO", &format!($($arg)*)) };
}
macro_rules! log_warn {
    ($($arg:tt)*) => { app_log("WARN", &format!($($arg)*)) };
}
macro_rules! log_error {
    ($($arg:tt)*) => { app_log("ERROR", &format!($($arg)*)) };
}

// 拆分后的领域模块通过 use crate::* 复用这三个日志宏
pub(crate) use log_error;
pub(crate) use log_info;
pub(crate) use log_warn;


// ── App Entry ───────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn claude_model_is_read_from_the_root_settings_field() {
        let settings = json!({ "model": "  claude-sonnet-4-5  ", "env": {} });

        assert_eq!(claude_model_from_settings(&settings), "claude-sonnet-4-5");
        assert_eq!(claude_model_from_settings(&json!({ "env": {} })), "");
    }

    #[test]
    fn switching_to_default_model_clears_previous_cli_and_editor_models() {
        let mut settings = json!({"model": "old-model", "claudeCode.selectedModel": "old-model", "unrelated": true});
        apply_claude_model(&mut settings, "model", "");
        apply_claude_model(&mut settings, "claudeCode.selectedModel", "  ");
        assert_eq!(settings, json!({"unrelated": true}));
        apply_claude_model(&mut settings, "model", "  new-model  ");
        assert_eq!(settings["model"], "new-model");
    }

    #[test]
    fn switching_reads_jsonc_without_losing_settings_and_rejects_invalid_files() {
        let dir = std::env::temp_dir().join(format!("varswitch-jsonc-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        assert_eq!(read_config_object(&path, true).unwrap(), json!({}));
        fs::write(&path, "{\n// editor setting\n\"editor.fontSize\": 16,\n\"url\": \"https://example.test\", // trailing comment\n}").unwrap();
        let config = read_config_object(&path, true).unwrap();
        assert_eq!(config["editor.fontSize"], 16);
        assert_eq!(config["url"], "https://example.test");
        assert!(read_config_object(&path, false).is_err());
        for raw in ["not json", "[]", "null", "{\"incomplete\":"] {
            fs::write(&path, raw).unwrap();
            assert!(read_config_object(&path, true).is_err());
            assert_eq!(fs::read_to_string(&path).unwrap(), raw);
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn upsert_env_array_deduplicates_same_name() {
        let mut arr = vec![
            json!({ "name": "ANTHROPIC_AUTH_TOKEN", "value": "old-1" }),
            json!({ "name": "ANTHROPIC_AUTH_TOKEN", "value": "old-2" }),
        ];

        upsert_env_array(&mut arr, "ANTHROPIC_AUTH_TOKEN", "new");

        let count = arr
            .iter()
            .filter(|v| v.get("name").and_then(|n| n.as_str()) == Some("ANTHROPIC_AUTH_TOKEN"))
            .count();
        assert_eq!(count, 1, "should keep only one ANTHROPIC_AUTH_TOKEN");
    }

    #[test]
    fn apply_auth_to_env_array_removes_non_selected_auth_key() {
        let mut arr = vec![
            json!({ "name": "ANTHROPIC_AUTH_TOKEN", "value": "old-token" }),
            json!({ "name": "ANTHROPIC_AUTH_KEY", "value": "old-key" }),
        ];

        let selected = apply_auth_to_env_array(&mut arr, "new-token", "https://example.test");

        let has_key = arr
            .iter()
            .any(|v| v.get("name").and_then(|n| n.as_str()) == Some("ANTHROPIC_AUTH_KEY"));
        assert!(
            !has_key,
            "ANTHROPIC_AUTH_KEY should be removed when token is used"
        );
        assert_eq!(selected, "ANTHROPIC_AUTH_TOKEN");
    }

    #[test]
    fn apply_auth_to_env_array_converts_auth_key_to_auth_token() {
        let mut arr = vec![json!({ "name": "ANTHROPIC_AUTH_KEY", "value": "old-key" })];

        let selected = apply_auth_to_env_array(&mut arr, "new-key", "https://example.test");

        let has_key = arr
            .iter()
            .any(|v| v.get("name").and_then(|n| n.as_str()) == Some("ANTHROPIC_AUTH_KEY"));
        let token_value = arr
            .iter()
            .find(|v| v.get("name").and_then(|n| n.as_str()) == Some("ANTHROPIC_AUTH_TOKEN"))
            .and_then(|v| v.get("value"))
            .and_then(|v| v.as_str());

        assert!(
            !has_key,
            "ANTHROPIC_AUTH_KEY should be removed and converted to TOKEN"
        );
        assert_eq!(token_value, Some("new-key"));
        assert_eq!(selected, "ANTHROPIC_AUTH_TOKEN");
    }

    #[test]
    fn app_settings_defaults_keep_usage_guide_enabled() {
        let settings = AppSettings::default();

        assert_eq!(settings.language, "zh");
        assert_eq!(settings.theme, "light");
        assert!(!settings.auto_start);
        assert!(!settings.silent_startup);
        assert!(settings.minimize_to_tray);
        assert!(
            !settings.never_show_usage_guide,
            "usage guide should show by default until the user disables it"
        );
    }

    #[test]
    fn remove_all_plugin_marketplace_sections_keeps_other_config() {
        let config = r#"model = "gpt-5"

[marketplaces.old]
source = "https://example.test/old.git"
source_type = "git"

[model_providers.customer]
name = "customer"

[marketplaces.openai-bundled]
source = "C:\\bundle"
source_type = "local"
"#;

        let cleaned = remove_all_plugin_marketplace_sections(config);

        assert!(cleaned.contains(r#"model = "gpt-5""#));
        assert!(cleaned.contains("[model_providers.customer]"));
        assert!(!cleaned.contains("[marketplaces."));
    }

    // ── 统一 MCP：Codex config.toml 解析 / 写回 ─────────────

    #[test]
    fn parse_codex_mcp_servers_reads_inline_env_and_env_subtable() {
        let config = r#"model = "gpt-5"

[mcp_servers.context7]
command = "npx"
args = [
    "-y",
    "@upstash/context7-mcp@latest",
]
env = { API_KEY = "inline-key", DEBUG = "1" }

[model_providers.customer]
name = "customer"

[mcp_servers."my.github"]
command = "docker"
args = ["run", "-i", "ghcr.io/github/github-mcp-server"]

[mcp_servers."my.github".env]
GITHUB_TOKEN = "sub-table-token"

[mcp_servers.remote]
url = "https://mcp.example.test/mcp"
"#;

        let servers = parse_codex_mcp_servers(config);
        assert_eq!(servers.len(), 3);

        let (name, ctx7) = &servers[0];
        assert_eq!(name, "context7");
        assert_eq!(ctx7["command"], "npx");
        assert_eq!(ctx7["args"], json!(["-y", "@upstash/context7-mcp@latest"]));
        assert_eq!(ctx7["env"]["API_KEY"], "inline-key");
        assert_eq!(ctx7["env"]["DEBUG"], "1");

        let (name, github) = &servers[1];
        assert_eq!(name, "my.github");
        assert_eq!(github["command"], "docker");
        assert_eq!(github["env"]["GITHUB_TOKEN"], "sub-table-token");

        let (name, remote) = &servers[2];
        assert_eq!(name, "remote");
        assert_eq!(remote["url"], "https://mcp.example.test/mcp");
    }

    #[test]
    fn upsert_codex_mcp_server_section_replaces_in_place_and_keeps_other_content() {
        let config = r#"model = "gpt-5"

[mcp_servers.old]
command = "old-cmd"

[mcp_servers.old.env]
TOKEN = "stale-sub-table"

[marketplaces.community]
source = "https://example.test/repo.git"
"#;

        let next = upsert_codex_mcp_server_section(
            config,
            "old",
            &json!({
                "command": "npx",
                "args": ["-y", "pkg"],
                "env": { "K": "v\"quoted\\path" }
            }),
        );

        // 无关内容原样保留
        assert!(next.contains(r#"model = "gpt-5""#));
        assert!(next.contains("[marketplaces.community]"));
        assert!(next.contains("https://example.test/repo.git"));
        // 旧段与其 env 子表一起被替换
        assert!(!next.contains("old-cmd"));
        assert!(!next.contains("stale-sub-table"));
        assert_eq!(next.matches("[mcp_servers.old]").count(), 1);

        // round-trip：写回后再解析，转义内容不失真
        let parsed = parse_codex_mcp_servers(&next);
        let (_, cfg) = parsed
            .iter()
            .find(|(server_name, _)| server_name == "old")
            .expect("server should exist");
        assert_eq!(cfg["command"], "npx");
        assert_eq!(cfg["args"], json!(["-y", "pkg"]));
        assert_eq!(cfg["env"]["K"], "v\"quoted\\path");
    }

    #[test]
    fn upsert_codex_mcp_server_section_appends_new_server_with_quoted_name() {
        let config = "model = \"gpt-5\"\n";
        let next =
            upsert_codex_mcp_server_section(config, "my server", &json!({ "command": "uvx" }));

        assert!(next.contains(r#"model = "gpt-5""#));
        assert!(next.contains(r#"[mcp_servers."my server"]"#));

        let parsed = parse_codex_mcp_servers(&next);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].0, "my server");
        assert_eq!(parsed[0].1["command"], "uvx");

        // 空文件也能直接写出合法段落
        let fresh = upsert_codex_mcp_server_section("", "fresh", &json!({ "command": "npx" }));
        assert!(fresh.starts_with("[mcp_servers.fresh]"));
    }

    #[test]
    fn remove_codex_mcp_server_section_only_removes_target_sections() {
        let config = r#"model = "gpt-5"

[mcp_servers.keep]
command = "keep-cmd"

[mcp_servers.gone]
command = "gone-cmd"

[mcp_servers.gone.env]
TOKEN = "gone-token"

[plugins]
"browser@openai-bundled" = { enabled = true }
"#;

        let next = remove_codex_mcp_server_section(config, "gone");
        assert!(!next.contains("gone-cmd"));
        assert!(!next.contains("gone-token"));
        assert!(next.contains("[mcp_servers.keep]"));
        assert!(next.contains("keep-cmd"));
        assert!(next.contains("[plugins]"));
        assert!(next.contains("browser@openai-bundled"));

        // 不存在的段：原样返回（调用侧据此跳过写盘）
        let unchanged = remove_codex_mcp_server_section(config, "missing");
        assert_eq!(unchanged, config);
    }

    #[test]
    fn invalid_local_plugin_marketplaces_are_removed_without_touching_git_sources() {
        let config = r#"model = "gpt-5"

[marketplaces.invalid-cache]
source = "C:\\definitely-missing-varswitch-marketplace"
source_type = "local"

[marketplaces.community]
source = "https://github.com/example/community-plugins.git"
source_type = "git"

[plugins]
"browser@openai-bundled" = { enabled = true }
"#;

        let cleaned = remove_invalid_local_plugin_marketplace_sections(config);

        assert!(!cleaned.contains("[marketplaces.invalid-cache]"));
        assert!(cleaned.contains("[marketplaces.community]"));
        assert!(cleaned.contains("https://github.com/example/community-plugins.git"));
        assert!(cleaned.contains("browser@openai-bundled"));
    }

    #[test]
    fn normalize_toolbox_state_adds_mobile_channels() {
        let state = normalize_toolbox_state(ToolboxState::default());

        for channel in ["lark", "wechat", "qq"] {
            assert!(
                state
                    .mobile_channels
                    .iter()
                    .any(|item| item.channel == channel),
                "{channel} channel should be present"
            );
        }
        assert_eq!(
            state.plugin_marketplace_input,
            default_plugin_marketplace_url()
        );
        assert_eq!(state.mobile_remote.mode, "platform_bot");
    }

    // Toolbox 页每秒刷新一次快照，插件市场发现在 Windows 上要起 PowerShell 进程并遍历
    // WindowsApps，没有缓存就会每秒重来一遍。用哨兵值确认 TTL 内确实走缓存、过期后重扫。
    #[test]
    fn plugin_marketplace_discovery_reuses_cache_within_ttl() {
        let sentinel = vec![(
            "sentinel-marketplace".to_string(),
            PathBuf::from("sentinel-root"),
        )];
        let now = chrono_timestamp_millis() as u64;
        if let Ok(mut guard) = PLUGIN_MARKETPLACE_CACHE.lock() {
            *guard = Some((now, sentinel.clone()));
        }
        assert_eq!(
            discover_codex_plugin_marketplaces(),
            sentinel,
            "TTL 内应直接复用缓存，不再扫描"
        );

        if let Ok(mut guard) = PLUGIN_MARKETPLACE_CACHE.lock() {
            *guard = Some((now.saturating_sub(PLUGIN_MARKETPLACE_TTL_MS + 1), sentinel.clone()));
        }
        assert_ne!(
            discover_codex_plugin_marketplaces(),
            sentinel,
            "缓存过期后必须重新扫描"
        );
        invalidate_plugin_marketplace_cache();
    }

    // 单次探测超时就有 1.5 秒，每秒轮询必须复用结果；换了后端地址则不能复用
    #[test]
    fn smart_control_probe_reuses_cache_only_for_same_backend() {
        let backend = "http://127.0.0.1:65535".to_string();
        set_smart_control_status_cache(SmartControlStatus {
            available: true,
            connected: true,
            backend_url: backend.clone(),
            status: "sentinel-status".into(),
            detail: String::new(),
            checked_at: chrono_now(),
        });
        assert_eq!(
            probe_smart_control_backend_cached(&backend).status,
            "sentinel-status",
            "同一地址在 TTL 内应复用缓存"
        );
        assert_ne!(
            probe_smart_control_backend_cached("http://127.0.0.1:65534").status,
            "sentinel-status",
            "地址变了必须重新探测"
        );
        invalidate_smart_control_probe_cache();
    }

    #[test]
    fn default_plugin_marketplace_uses_varswitch_gitcode_mirror() {
        assert_eq!(default_plugin_marketplace_name(), "varswitch-plugins");
        assert_eq!(
            default_plugin_marketplace_url(),
            "https://gitcode.com/2301_79703673/codex-plugins.git"
        );
    }

    #[test]
    fn enabling_plugin_updates_existing_plugin_table_without_duplicate_inline_key() {
        let config = r#"[plugins."chrome-devtools@varswitch-plugins"]
enabled = false

[plugins]
"browser@openai-bundled" = { enabled = true }
"#;

        let updated =
            write_enabled_codex_plugin_config(config, "chrome-devtools@varswitch-plugins");

        assert!(updated.contains("[plugins.\"chrome-devtools@varswitch-plugins\"]"));
        assert!(updated.contains("enabled = true"));
        assert!(!updated.contains("\"chrome-devtools@varswitch-plugins\" = { enabled = true }"));
        assert!(updated.contains("\"browser@openai-bundled\" = { enabled = true }"));
    }

    #[test]
    fn enabling_plugin_deduplicates_inline_key_when_plugin_table_exists() {
        let config = r#"[plugins."chrome-devtools@varswitch-plugins"]
enabled = false

[plugins]
"chrome-devtools@varswitch-plugins" = { enabled = true }
"browser@openai-bundled" = { enabled = true }
"#;

        let updated =
            write_enabled_codex_plugin_config(config, "chrome-devtools@varswitch-plugins");

        assert_eq!(
            updated.matches("chrome-devtools@varswitch-plugins").count(),
            1
        );
        assert!(updated.contains("[plugins.\"chrome-devtools@varswitch-plugins\"]"));
        assert!(updated.contains("enabled = true"));
        assert!(updated.contains("\"browser@openai-bundled\" = { enabled = true }"));
    }
    #[test]
    fn supported_plugin_marketplace_normalizes_known_sources() {
        assert_eq!(
            supported_plugin_marketplace_source("git@github.com:ConcertoNotes/codex-plugins.git"),
            varswitch_github_plugin_marketplace_url()
        );
        assert_eq!(
            supported_plugin_marketplace_source(
                "git@github.com:hashgraph-online/awesome-codex-plugins.git"
            ),
            awesome_plugin_marketplace_url()
        );
        assert_eq!(
            supported_plugin_marketplace_source("https://example.test/custom.git"),
            default_plugin_marketplace_url()
        );
    }

    #[test]
    fn normalize_toolbox_state_sets_mobile_channel_defaults() {
        let state = normalize_toolbox_state(ToolboxState::default());
        let lark = state
            .mobile_channels
            .iter()
            .find(|item| item.channel == "lark")
            .expect("lark channel");
        let wechat = state
            .mobile_channels
            .iter()
            .find(|item| item.channel == "wechat")
            .expect("wechat channel");

        assert_eq!(lark.base_url, "https://open.feishu.cn");
        assert_eq!(wechat.base_url, "https://ilinkai.weixin.qq.com");
    }

    #[test]
    fn normalize_toolbox_state_clears_stale_text_qr_cache() {
        let mut state = ToolboxState::default();
        let mut qq = default_mobile_channel("qq");
        qq.qr_url = "raw-internal-token".into();
        qq.qr_data_url = String::new();
        qq.qr_started_at = chrono_timestamp_millis().to_string();
        state.mobile_channels.push(qq);
        let mut wechat = default_mobile_channel("wechat");
        wechat.qr_device_code = "device-code".into();
        wechat.qr_data_url = "data:image/svg+xml;base64,abc".into();
        wechat.qr_started_at = chrono_timestamp_millis().to_string();
        state.mobile_channels.push(wechat);

        let state = normalize_toolbox_state(state);
        let qq = state
            .mobile_channels
            .iter()
            .find(|item| item.channel == "qq")
            .expect("qq channel");
        let wechat = state
            .mobile_channels
            .iter()
            .find(|item| item.channel == "wechat")
            .expect("wechat channel");

        assert!(qq.qr_data_url.is_empty());
        assert!(qq.qr_url.is_empty());
        assert!(wechat.qr_data_url.is_empty());
        assert!(wechat.qr_device_code.is_empty());
    }

    #[test]
    fn normalize_toolbox_state_keeps_fresh_platform_qr_cache() {
        let mut state = ToolboxState::default();
        let mut qq = default_mobile_channel("qq");
        qq.qr_url = "https://bots.qq.com/connect/abc".into();
        qq.qr_data_url = "data:image/png;base64,abc".into();
        qq.qr_started_at = chrono_timestamp_millis().to_string();
        state.mobile_channels.push(qq);

        let state = normalize_toolbox_state(state);
        let qq = state
            .mobile_channels
            .iter()
            .find(|item| item.channel == "qq")
            .expect("qq channel");

        assert_eq!(qq.qr_url, "https://bots.qq.com/connect/abc");
        assert_eq!(qq.qr_data_url, "data:image/png;base64,abc");
    }

    #[test]
    fn normalize_toolbox_state_keeps_fresh_qq_image_qr_even_without_openable_url() {
        let mut state = ToolboxState::default();
        let mut qq = default_mobile_channel("qq");
        qq.qr_url = "internal-connector-token".into();
        qq.qr_data_url = "data:image/png;base64,abc".into();
        qq.qr_started_at = chrono_timestamp_millis().to_string();
        state.mobile_channels.push(qq);

        let state = normalize_toolbox_state(state);
        let qq = state
            .mobile_channels
            .iter()
            .find(|item| item.channel == "qq")
            .expect("qq channel");

        assert_eq!(qq.qr_data_url, "data:image/png;base64,abc");
        assert_eq!(qq.qr_url, "internal-connector-token");
    }

    #[test]
    fn normalize_toolbox_state_clears_invalid_qr_started_at() {
        let mut state = ToolboxState::default();
        let mut qq = default_mobile_channel("qq");
        qq.qr_url = "https://bots.qq.com/connect/abc".into();
        qq.qr_data_url = "data:image/png;base64,abc".into();
        qq.qr_started_at = "2026-06-28 12:00:00".into();
        state.mobile_channels.push(qq);

        let state = normalize_toolbox_state(state);
        let qq = state
            .mobile_channels
            .iter()
            .find(|item| item.channel == "qq")
            .expect("qq channel");

        assert!(qq.qr_data_url.is_empty());
        assert!(qq.qr_url.is_empty());
    }

    #[test]
    fn mobile_channel_credentials_require_platform_specific_fields() {
        let mut lark = default_mobile_channel("lark");
        assert!(!mobile_channel_has_credentials(&lark));
        lark.app_id = "cli_xxx".into();
        lark.app_secret = "secret".into();
        assert!(mobile_channel_has_credentials(&lark));

        let mut wechat = default_mobile_channel("wechat");
        assert!(!mobile_channel_has_credentials(&wechat));
        wechat.bot_token = "token".into();
        assert!(mobile_channel_has_credentials(&wechat));
    }

    #[test]
    fn normalize_smart_control_backend_url_adds_scheme_and_trims_slashes() {
        assert_eq!(
            normalize_smart_control_backend_url("127.0.0.1:3847/"),
            "http://127.0.0.1:3847"
        );
        assert_eq!(
            normalize_smart_control_backend_url("https://localhost:3847/backend-api/"),
            "https://localhost:3847/backend-api"
        );
        assert_eq!(
            normalize_smart_control_backend_url(""),
            default_smart_control_backend_url()
        );
    }

    #[test]
    fn smart_control_json_response_contains_cors_and_content_length() {
        let response = smart_control_json_response(json!({ "ok": true }));
        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert!(response.contains("Access-Control-Allow-Origin: *"));
        assert!(response.contains("Content-Type: application/json; charset=utf-8"));
        assert!(response.ends_with(r#"{"ok":true}"#));
    }

    #[test]
    fn codex_config_toml_content_points_chatgpt_base_url_to_local_control() {
        let content = codex_config_toml_content(
            "custom",
            "gpt-test",
            "https://api.example.com",
            "sk-test",
            false,
        );
        assert!(content.contains(r#"chatgpt_base_url = "http://127.0.0.1:3847/backend-api""#));
        assert!(content.contains(r#"model_provider = "custom""#));
        assert!(content.contains(r#"model = "gpt-test""#));

        let official = codex_config_toml_content(
            "customer",
            "gpt-5.5",
            "https://api.example.com",
            "sk-test",
            true,
        );
        assert!(official.contains(r#"chatgpt_base_url = "http://127.0.0.1:3847/backend-api""#));
        assert!(official.contains(r#"preferred_auth_method = "apikey""#));
        assert!(official.contains(r#"experimental_bearer_token = "sk-test""#));
    }

    #[test]
    fn deepseek_codex_config_uses_responses_and_custom_model_catalog() {
        let content = codex_config_toml_content_with_image(
            "deepseek",
            "deepseek-v4-pro",
            "https://api.deepseek.com/",
            "sk-test",
            "chat",
            false,
            "",
            "",
        );

        assert!(content.contains(r#"wire_api = "responses""#));
        assert!(content.contains(r#"model_reasoning_effort = "high""#));
        assert!(content.contains(r#"model_catalog_json = "models.json""#));
    }

    #[test]
    fn deepseek_codex_model_catalog_exposes_both_v4_models() {
        let catalog: serde_json::Value = serde_json::from_str(&deepseek_codex_model_catalog())
            .expect("DeepSeek model catalog should be valid JSON");
        let models = catalog["models"]
            .as_array()
            .expect("DeepSeek model catalog should contain a models array");
        let slugs = models
            .iter()
            .filter_map(|model| model["slug"].as_str())
            .collect::<Vec<_>>();

        assert_eq!(slugs, vec!["deepseek-v4-flash", "deepseek-v4-pro"]);
        assert!(models.iter().all(|model| model["context_window"] == 1_048_576));
        assert!(models.iter().all(|model| model["apply_patch_tool_type"] == "freeform"));
    }

    #[test]
    fn codex_runtime_status_includes_model_from_config() {
        let config = r#"
model_provider = "custom"
model = "gpt-5.6-sol"

[model_providers.custom]
base_url = "https://code.example.test/v1"
"#;

        let status = codex_status_from_config(
            config,
            "sk-test".into(),
            String::new(),
            String::new(),
            false,
        );
        let serialized = serde_json::to_value(&status).expect("status should serialize");

        assert_eq!(status.model, "gpt-5.6-sol");
        assert_eq!(serialized["model"], "gpt-5.6-sol");
        assert_eq!(serialized["baseUrl"], "https://code.example.test/v1");
    }

    #[test]
    fn codex_config_merge_preserves_unmanaged_sections() {
        let existing = r#"
model_provider = "old"
approval_policy = "never"

[model_providers.old]
name = "old"
base_url = "https://old.example.com"

[projects."H:/variable-switching"]
trust_level = "trusted"

[marketplaces.varswitch-plugins]
source = "https://example.com/plugins.git"
source_type = "git"

[plugins]
"chrome@openai-bundled".enabled = true
"#;
        let generated = codex_config_toml_content(
            "custom",
            "gpt-5-codex",
            "https://api.example.com/v1",
            "sk-test",
            false,
        );

        let merged = merge_codex_config_with_preserved_sections(&generated, existing);

        assert!(merged.contains(r#"model_provider = "custom""#));
        assert!(merged.contains(r#"approval_policy = "never""#));
        assert!(merged.contains(r#"[projects."H:/variable-switching"]"#));
        assert!(merged.contains("[marketplaces.varswitch-plugins]"));
        assert!(merged.contains("[plugins]"));
        assert!(!merged.contains("[model_providers.old]"));
    }

    #[test]
    fn codex_config_does_not_write_unknown_gpt_image_2_section() {
        let generated = codex_config_toml_content_with_image(
            "custom",
            "gpt-5-codex",
            "https://api.example.com/v1",
            "sk-chat",
            "responses",
            false,
            "sk-image",
            "",
        );

        assert!(!generated.contains("[gpt_image_2]"));
        assert!(!generated.contains("sk-image"));
    }

    #[test]
    fn codex_profile_image_base_url_defaults_to_empty() {
        let profile: CodexProfile = serde_json::from_value(json!({
            "id": "profile-1",
            "name": "Test",
            "apiKey": "sk-test",
            "baseUrl": "https://api.example.test/v1",
            "isActive": false,
            "createdAt": "1"
        }))
        .expect("profile JSON should deserialize");

        assert!(profile.image_base_url.is_empty());
    }

    #[test]
    fn existing_codex_profiles_clear_all_image_base_urls() {
        let mut data = CodexProfilesData {
            profiles: vec![CodexProfile {
                id: "profile-1".into(),
                name: "Test".into(),
                api_key: "sk-test".into(),
                base_url: "https://api.example.test/v1".into(),
                auth_mode: default_codex_auth_mode(),
                wire_api: default_codex_wire_api(),
                model: String::new(),
                provider_name: String::new(),
                image_api_key: "image-key".into(),
                image_base_url: "https://image.example.test/v1".into(),
                is_active: false,
                created_at: "1".into(),
            }],
            image_base_url_migrated: true,
        };

        assert!(clear_codex_image_base_urls(&mut data));
        assert!(data.profiles[0].image_base_url.is_empty());
        assert_eq!(data.profiles[0].image_api_key, "image-key");
        assert!(!clear_codex_image_base_urls(&mut data));
    }

    #[test]
    fn log_redaction_hides_url_queries_and_key_values() {
        let redacted = redact_log_message(
            "gateway=https://gateway.example.test/ws?access_key=secret-key&ticket=temporary appSecret=app-secret bot_token=bot-secret",
        );

        assert!(redacted.contains("https://gateway.example.test/ws?[query-redacted]"));
        assert!(redacted.contains("appSecret=***"));
        assert!(redacted.contains("bot_token=***"));
        for secret in ["secret-key", "temporary", "app-secret", "bot-secret"] {
            assert!(!redacted.contains(secret));
        }
    }

    #[test]
    fn codex_config_merge_removes_legacy_gpt_image_2_section() {
        let existing = r#"
model_provider = "old"

[gpt_image_2]
api_key = "old-image"
base_url = "https://old.example.com/v1"

[projects."H:/variable-switching"]
trust_level = "trusted"
"#;
        let generated = codex_config_toml_content_with_image(
            "custom",
            "gpt-5-codex",
            "https://api.example.com/v1",
            "sk-chat",
            "responses",
            false,
            "sk-new-image",
            "https://image.example.com/v1/",
        );

        let merged = merge_codex_config_with_preserved_sections(&generated, existing);

        assert!(!merged.contains("[gpt_image_2]"));
        assert!(!merged.contains("old-image"));
        assert!(!merged.contains("sk-new-image"));
        assert!(merged.contains(r#"[projects."H:/variable-switching"]"#));
    }

    #[test]
    fn codex_image_skill_routes_generation_requests_to_the_bundled_script() {
        let script_path =
            Path::new(r"C:\Users\Test\.codex\skills\varswitch-imagegen\scripts\generate-image.ps1");
        let manifest = codex_image_skill_manifest(script_path);
        let script = codex_image_skill_script();

        assert!(manifest.contains("name: varswitch-imagegen"));
        assert!(manifest.contains("preferred image-generation Skill"));
        assert!(manifest.contains("built-in `imagegen`"));
        assert!(manifest.contains("missing, not configured, or fails"));
        assert!(manifest.contains("generate-image.ps1"));
        assert!(manifest.contains("powershell.exe"));
        assert!(script.contains("VARSWITCH_IMAGE_API_KEY"));
        assert!(script.contains("VARSWITCH_IMAGE_BASE_URL"));
        assert!(script.contains("VARSWITCH_IMAGE_MODEL"));
        assert!(script.contains("/images/generations"));
        assert!(script.contains("b64_json"));
        assert!(script.contains("Invoke-WebRequest"));
    }

    #[test]
    fn codex_image_priority_instructions_are_idempotent_and_preserve_user_content() {
        let existing = "Keep my own global instruction.\n";

        let enabled_once = merge_codex_image_priority_instructions(existing, true);
        let enabled_twice = merge_codex_image_priority_instructions(&enabled_once, true);

        assert_eq!(enabled_once, enabled_twice);
        assert!(enabled_once.contains("Keep my own global instruction."));
        assert!(enabled_once.contains(CODEX_IMAGE_PRIORITY_START));
        assert!(enabled_once.contains("prefer `varswitch-imagegen`"));
        assert!(enabled_once.contains("built-in `imagegen`"));
        assert_eq!(enabled_once.matches(CODEX_IMAGE_PRIORITY_START).count(), 1);

        let disabled = merge_codex_image_priority_instructions(&enabled_once, false);
        assert_eq!(disabled, existing);
        assert!(!disabled.contains(CODEX_IMAGE_PRIORITY_START));
    }

    #[test]
    fn codex_image_priority_instructions_preserve_windows_line_endings() {
        let existing = "First instruction.\r\nSecond instruction.\r\n";

        let enabled = merge_codex_image_priority_instructions(existing, true);
        assert!(!enabled.replace("\r\n", "").contains('\n'));

        let disabled = merge_codex_image_priority_instructions(&enabled, false);
        assert_eq!(disabled, existing);
    }

    #[test]
    fn codex_image_priority_instructions_can_follow_non_ascii_content() {
        let existing = "保留用户指令。";

        let enabled = merge_codex_image_priority_instructions(existing, true);
        let disabled = merge_codex_image_priority_instructions(&enabled, false);

        assert_eq!(disabled, existing);
    }

    #[test]
    fn imported_codex_profile_preserves_detected_image_configuration() {
        let status = LocationStatus {
            api_key: "sk-chat".into(),
            base_url: "https://chat.example.test/v1".into(),
            model: "gpt-test".into(),
            image_api_key: "sk-image".into(),
            image_base_url: "https://image.example.test/v1".into(),
            image_skill_installed: true,
        };

        let profile = build_imported_codex_profile("Imported".into(), status, "auth_json".into());

        assert_eq!(profile.image_api_key, "sk-image");
        assert_eq!(profile.image_base_url, "https://image.example.test/v1");
        assert!(profile.is_active);
    }

    #[test]
    fn codex_image_skill_installer_writes_a_complete_skill_directory() {
        let skill_dir = std::env::temp_dir().join(format!(
            "varswitch-image-skill-test-{}",
            uuid::Uuid::new_v4()
        ));

        install_codex_image_skill_at(&skill_dir).expect("skill install should succeed");
        let manifest = fs::read_to_string(skill_dir.join("SKILL.md")).unwrap();
        let script = fs::read_to_string(skill_dir.join("scripts/generate-image.ps1")).unwrap();

        assert!(manifest.contains("varswitch-imagegen"));
        assert!(manifest.contains("generate-image.ps1"));
        assert!(script.contains("/images/generations"));
        assert!(!script.contains("sk-image"));

        fs::remove_dir_all(skill_dir).unwrap();
    }

    #[test]
    fn legacy_gpt_image_2_values_remain_readable_for_migration() {
        let config = r#"
model_provider = "custom"

[model_providers.custom]
base_url = "https://chat.example.com/v1"

[gpt_image_2]
api_key = "sk-image"
base_url = "https://image.example.com/v1"
model = "gpt-image-2"
"#;

        assert_eq!(
            toml_section_value(config, "gpt_image_2", "api_key"),
            "sk-image"
        );
        assert_eq!(
            toml_section_value(config, "gpt_image_2", "base_url"),
            "https://image.example.com/v1"
        );
    }

    #[test]
    fn toml_section_value_reads_provider_base_without_image_base_conflict() {
        let config = r#"
model_provider = "custom"

[gpt_image_2]
base_url = "https://image.example.com/v1"

[model_providers.custom]
base_url = "https://chat.example.com/v1"
"#;

        let provider_name = toml_line_value(config, "model_provider");
        assert_eq!(
            toml_section_value(
                config,
                &format!("model_providers.{provider_name}"),
                "base_url"
            ),
            "https://chat.example.com/v1"
        );
    }

    #[test]
    fn visible_codex_threads_filters_toolbox_trash_only() {
        let mut state = ToolboxState::default();
        state.synced_codex_threads = vec![
            CodexThreadRecord {
                id: "keep".into(),
                thread_name: "Keep".into(),
                ..CodexThreadRecord::default()
            },
            CodexThreadRecord {
                id: "hidden".into(),
                thread_name: "Hidden".into(),
                ..CodexThreadRecord::default()
            },
        ];
        state
            .trashed_codex_threads
            .push(codex_thread_to_trash_record(
                state.synced_codex_threads[1].clone(),
                "2026-07-03 00:00:00",
            ));

        let visible = visible_codex_threads(&state);

        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].id, "keep");
        assert_eq!(state.synced_codex_threads.len(), 2);
    }

    #[test]
    fn websocket_accept_key_matches_rfc_example() {
        assert_eq!(
            websocket_accept_key("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );
    }

    #[test]
    fn smart_control_preview_truncates_long_text() {
        assert_eq!(smart_control_preview("abcdef", 10), "abcdef");
        assert_eq!(smart_control_preview("abcdef", 3), "abc…");
    }

    #[test]
    fn try_smart_control_dispatch_returns_none_when_not_connected() {
        SMART_CONTROL_REMOTE_CONNECTED.store(false, Ordering::SeqCst);
        let result =
            try_smart_control_dispatch("thread", "hello").expect("dispatch should not fail");
        assert!(result.is_none());
    }

    #[test]
    fn smart_control_turn_start_message_has_expected_shape() {
        let message = smart_control_turn_start_message(42, "thread-1", " hello ");
        assert_eq!(message.get("id").and_then(|v| v.as_u64()), Some(42));
        assert_eq!(
            message.get("method").and_then(|v| v.as_str()),
            Some("turn/start")
        );
        assert_eq!(
            message
                .get("params")
                .and_then(|v| v.get("threadId"))
                .and_then(|v| v.as_str()),
            Some("thread-1")
        );
        assert_eq!(
            message
                .get("params")
                .and_then(|v| v.get("input"))
                .and_then(|v| v.as_array())
                .and_then(|items| items.first())
                .and_then(|v| v.get("text"))
                .and_then(|v| v.as_str()),
            Some("hello")
        );
    }

    #[test]
    fn smart_control_wraps_client_message_with_envelope_identity() {
        smart_control_reset_client_state();
        let message = smart_control_initialize_message(7);
        let envelope = smart_control_wrap_client_message(message);
        assert_eq!(
            envelope.get("type").and_then(|v| v.as_str()),
            Some("client_message")
        );
        assert!(envelope.get("client_id").and_then(|v| v.as_str()).is_some());
        assert!(envelope.get("stream_id").and_then(|v| v.as_str()).is_some());
        assert_eq!(envelope.get("seq_id").and_then(|v| v.as_u64()), Some(1));
        assert_eq!(
            envelope
                .get("message")
                .and_then(|v| v.get("method"))
                .and_then(|v| v.as_str()),
            Some("initialize")
        );
    }

    #[test]
    fn smart_control_reassembles_server_message_chunk() {
        smart_control_reset_client_state();
        let message = json!({"id": 9, "result": {"text": "chunked"}});
        let raw = serde_json::to_vec(&message).unwrap();
        let mid = raw.len() / 2;
        let first = base64::engine::general_purpose::STANDARD.encode(&raw[..mid]);
        let second = base64::engine::general_purpose::STANDARD.encode(&raw[mid..]);
        let base = json!({
            "type": "server_message_chunk",
            "client_id": "c",
            "stream_id": "s",
            "seq_id": 3,
            "segment_count": 2,
            "message_size_bytes": raw.len(),
        });
        let mut chunk1 = base.clone();
        chunk1["segment_id"] = json!(0);
        chunk1["message_chunk_base64"] = json!(first);
        assert!(smart_control_reassemble_server_chunk(&chunk1).is_none());
        let mut chunk2 = base;
        chunk2["segment_id"] = json!(1);
        chunk2["message_chunk_base64"] = json!(second);
        assert_eq!(
            smart_control_reassemble_server_chunk(&chunk2)
                .and_then(|v| v.get("result").and_then(|r| r.get("text")).cloned())
                .and_then(|v| v.as_str().map(str::to_string)),
            Some("chunked".into())
        );
    }

    #[test]
    fn smart_control_extracts_approval_request() {
        let value = json!({
            "type": "server_message",
            "client_id": "c",
            "stream_id": "s",
            "seq_id": 1,
            "message": {
                "id": "approval-1",
                "method": "approval/request",
                "params": {
                    "title": "Run command",
                    "body": "Allow command?",
                    "options": [{"label": "approve"}, {"label": "deny"}]
                }
            }
        });
        let approval = smart_control_extract_approval(&value).expect("approval");
        assert_eq!(approval.request_id, "approval-1");
        assert_eq!(approval.title, "Run command");
        assert_eq!(approval.options, vec!["approve", "deny"]);
    }

    #[test]
    fn smart_control_turn_accumulator_completes_pending() {
        let request_id = 777;
        smart_control_register_pending(request_id);
        smart_control_observe_turn_item(&json!({
            "id": request_id,
            "delta": {"text": "hello "}
        }));
        smart_control_observe_turn_item(&json!({
            "id": request_id,
            "delta": {"text": "world"},
            "status": "completed"
        }));
        let result = smart_control_wait_pending(request_id, Duration::from_millis(50))
            .expect("pending result");
        assert_eq!(result.text, "hello world");
    }

    #[test]
    fn smart_control_delta_does_not_complete_pending_before_done() {
        let request_id = 778;
        smart_control_register_pending(request_id);
        smart_control_maybe_complete_pending(&json!({
            "id": request_id,
            "delta": {"text": "partial "}
        }));
        let pending_done = smart_control_pending_store()
            .0
            .lock()
            .ok()
            .and_then(|pending| pending.get(&request_id).map(|result| result.done))
            .unwrap_or(true);
        assert!(!pending_done);
        smart_control_maybe_complete_pending(&json!({
            "id": request_id,
            "delta": {"text": "done"},
            "status": "completed"
        }));
        let result = smart_control_wait_pending(request_id, Duration::from_millis(50))
            .expect("pending result");
        assert_eq!(result.text, "partial done");
    }

    #[test]
    fn codex_inject_script_does_not_force_scroll_layout() {
        let script = codex_inject_send_script("\"hello\"");
        assert!(
            !script.contains("scrollIntoView"),
            "CDP compatibility injection must not force-scroll the Codex window"
        );
    }

    #[test]
    fn codex_debug_port_probe_relaunches_app_when_port_is_missing() {
        let source = include_str!("lib.rs");
        let marker = "fn codex_debug_port_or_relaunch()";
        let start = source.find(marker).expect("function exists");
        let tail = &source[start..];
        let open = tail.find('{').expect("function body starts");
        let mut depth = 0i32;
        let mut end = tail.len();
        for (idx, ch) in tail[open..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = open + idx + 1;
                        break;
                    }
                }
                _ => {}
            }
        }
        let body = &tail[..end];
        assert!(body.contains("relaunch_codex_with_debug_port"));
        assert!(body.contains("CODEX_PREFERRED_DEBUG_PORT"));
    }

    #[test]
    fn packaged_codex_activation_casts_com_object_inside_csharp() {
        let source = include_str!("lib.rs");
        assert!(source.contains("public static class PackagedAppActivator"));
        assert!(source.contains(
            "var manager = (IApplicationActivationManager)new ApplicationActivationManager();"
        ));
        assert!(source.contains("[VarSwitch.PackagedAppActivator]::Activate"));
    }

    #[test]
    fn smart_control_extracts_text_from_response_shapes() {
        assert_eq!(
            smart_control_extract_text(&json!({"id": 1, "result": {"text": "hello"}})),
            "hello"
        );
        assert_eq!(
            smart_control_extract_text(&json!({"id": 1, "delta": {"text": "world"}})),
            "world"
        );
        assert_eq!(
            smart_control_extract_error(&json!({"id": 1, "error": {"message": "bad"}})),
            "bad"
        );
    }

    #[test]
    fn push_smart_control_event_keeps_ring_buffer_bounded() {
        for idx in 0..90 {
            push_smart_control_event(SmartControlEvent {
                received_at: idx.to_string(),
                event_type: "test".into(),
                message_id: idx.to_string(),
                method: "noop".into(),
                raw_preview: "x".into(),
            });
        }
        let snapshot = smart_control_debug_snapshot();
        assert!(snapshot.events.len() <= 80);
        assert_eq!(
            snapshot
                .last_event
                .as_ref()
                .map(|event| event.message_id.as_str()),
            Some("89")
        );
    }

    #[test]
    fn app_settings_deserialize_old_files_without_usage_guide_field() {
        let settings: AppSettings = serde_json::from_value(json!({
            "language": "en",
            "theme": "dark",
            "autoStart": true,
            "silentStartup": true,
            "minimizeToTray": false
        }))
        .expect("old settings json should still deserialize");

        assert_eq!(settings.language, "en");
        assert_eq!(settings.theme, "dark");
        assert!(settings.auto_start);
        assert!(settings.silent_startup);
        assert!(!settings.minimize_to_tray);
        assert!(!settings.never_show_usage_guide);
        assert!(
            settings.editor_paths.is_empty(),
            "old settings json should default editor path overrides to empty"
        );
    }

    #[test]
    fn sanitize_endpoint_timeout_clamps_values() {
        assert_eq!(
            sanitize_endpoint_timeout(Some(1)),
            ENDPOINT_TEST_MIN_TIMEOUT_SECS
        );
        assert_eq!(
            sanitize_endpoint_timeout(Some(999)),
            ENDPOINT_TEST_MAX_TIMEOUT_SECS
        );
        assert_eq!(sanitize_endpoint_timeout(Some(10)), 10);
        assert_eq!(
            sanitize_endpoint_timeout(None),
            ENDPOINT_TEST_DEFAULT_TIMEOUT_SECS
        );
    }

    #[test]
    fn normalize_endpoint_url_trims_and_removes_trailing_slashes() {
        let normalized = normalize_endpoint_url(" https://api.example.com/v1/// ")
            .expect("valid endpoint should normalize");

        assert_eq!(normalized, "https://api.example.com/v1");
    }

    #[test]
    fn normalize_endpoint_url_rejects_invalid_values() {
        assert!(normalize_endpoint_url("").is_err());
        assert!(normalize_endpoint_url("not a url").is_err());
        assert!(normalize_endpoint_url("file:///tmp/config.json").is_err());
    }

    #[test]
    fn models_endpoint_candidates_support_v1_and_plain_base_urls() {
        assert_eq!(
            models_endpoint_candidates("https://api.example.com/v1").unwrap(),
            vec!["https://api.example.com/v1/models"]
        );
        assert_eq!(
            models_endpoint_candidates("https://api.example.com").unwrap(),
            vec![
                "https://api.example.com/v1/models",
                "https://api.example.com/models"
            ]
        );
    }

    #[test]
    fn extract_model_ids_handles_openai_and_custom_shapes() {
        let ids = extract_model_ids(&json!({
            "data": [
                {"id": "gpt-5.5"},
                {"id": "gpt-5.5"},
                {"name": "claude-opus-4.8"},
                ""
            ]
        }));

        assert_eq!(ids, vec!["claude-opus-4.8", "gpt-5.5"]);
        assert_eq!(
            extract_model_ids(&json!({"models": ["kimi-k2.7", {"id": "glm-5.1"}]})),
            vec!["glm-5.1", "kimi-k2.7"]
        );
    }

    #[test]
    fn known_editors_only_include_primary_supported_editors() {
        let editor_ids: Vec<&str> = KNOWN_EDITORS.iter().map(|editor| editor.id).collect();
        assert!(
            editor_ids.contains(&"vscode") && editor_ids.contains(&"cursor"),
            "primary supported editors should be present"
        );
        assert!(
            !editor_ids.contains(&"vscode-insiders")
                && !editor_ids.contains(&"windsurf")
                && !editor_ids.contains(&"trae")
                && !editor_ids.contains(&"vscodium"),
            "VS Code Insiders, Windsurf, Trae, and VSCodium should not be shown in settings editor paths"
        );
    }

    #[test]
    fn normalize_editor_path_value_appends_settings_json_for_directory_paths() {
        let directory = PathBuf::from("Editors").join("Cursor").join("User");
        let normalized =
            normalize_editor_path_value(&directory.to_string_lossy()).expect("path should normalize");

        assert!(
            PathBuf::from(&normalized) == directory.join("settings.json"),
            "directory overrides should resolve to settings.json, got {}",
            normalized
        );
    }

    #[test]
    fn normalize_editor_path_value_preserves_explicit_settings_file_path() {
        let normalized = normalize_editor_path_value(r"C:\Editors\Cursor\User\settings.json")
            .expect("path should normalize");

        assert_eq!(normalized, r"C:\Editors\Cursor\User\settings.json");
    }

    #[test]
    fn resolved_editor_settings_path_prefers_saved_override() {
        let editor = KNOWN_EDITORS
            .iter()
            .find(|candidate| candidate.id == "vscode")
            .expect("vscode should be supported");
        let mut settings = AppSettings::default();
        settings
            .editor_paths
            .insert(editor.id.to_string(), PathBuf::from("Custom").join("VSCode").join("User").to_string_lossy().to_string());

        let resolved = resolved_editor_settings_path(editor, &settings);

        assert_eq!(
            resolved,
            PathBuf::from("Custom").join("VSCode").join("User").join("settings.json")
        );
    }

    #[test]
    fn detect_installed_editors_includes_manual_override_even_without_default_install_path() {
        let mut settings = AppSettings::default();
        settings.editor_paths.insert(
            "cursor".to_string(),
            r"C:\PortableApps\Cursor\User".to_string(),
        );

        let detected = detect_installed_editors(&settings);

        assert!(
            detected.iter().any(|editor| editor.id == "cursor"),
            "manual editor path overrides should count as detected editors"
        );
    }

    #[test]
    fn is_remote_version_newer_handles_optional_v_prefix() {
        assert!(is_remote_version_newer("v1.2.0", "1.1.9"));
        assert!(is_remote_version_newer("1.0.1", "v1.0.0"));
        assert!(!is_remote_version_newer("v1.0.0", "1.0.0"));
        assert!(!is_remote_version_newer("v0.9.9", "1.0.0"));
    }

    #[test]
    fn extract_latest_version_from_download_page_uses_newest_installer_version() {
        let html = r#"
            <a href="./releases/VarSwitch_1.0.0_x64-setup.exe">VarSwitch_1.0.0_x64-setup.exe</a>
            <a href="./releases/VarSwitch_1.2.3_x64-setup.exe">VarSwitch_1.2.3_x64-setup.exe</a>
            <a href="./releases/VarSwitch_1.0.0_aarch64.dmg">macOS</a>
            <a href="./releases/VarSwitch_1.2.3_aarch64.dmg">macOS</a>
            <a href="./releases/VarSwitch_1.0.0_amd64.AppImage">Linux</a>
            <a href="./releases/VarSwitch_1.2.3_amd64.AppImage">Linux</a>
        "#;

        assert_eq!(
            extract_latest_version_from_download_page(html),
            Some("v1.2.3".into())
        );
    }

    #[test]
    fn resolve_proxy_url_ignores_disabled_loopback_proxy() {
        let proxy = resolve_proxy_url_from_values(&[
            Some("http://127.0.0.1:9"),
            Some("http://127.0.0.1:9"),
            None,
            None,
        ]);

        assert_eq!(
            proxy, None,
            "discard-style loopback proxy should be ignored instead of breaking update requests"
        );
    }

    #[test]
    fn resolve_proxy_url_keeps_real_proxy_values() {
        let proxy = resolve_proxy_url_from_values(&[
            Some("http://proxy.example.com:8080"),
            None,
            None,
            None,
        ]);

        assert_eq!(proxy.as_deref(), Some("http://proxy.example.com:8080"));
    }

    #[test]
    fn tauri_config_does_not_define_static_tray_icon_when_tray_is_built_in_setup() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("valid tauri.conf.json");

        let static_tray_icon = config.get("app").and_then(|app| app.get("trayIcon"));

        assert!(
            static_tray_icon.is_none(),
            "tauri.conf.json should not also define app.trayIcon when setup() builds the tray icon"
        );
    }
}

/// 启动时把主窗口收进当前显示器的可视范围。
///
/// tauri.conf.json 里的默认尺寸是按大屏设计的；在 1080p 屏幕、或者系统缩放
/// 125% / 150% 的机器上，窗口会比屏幕还高，底部直接跑到屏幕外面。
/// 表现就是：弹窗（新增配置向导等）右下角的「保存 / 保存并启用」按钮看不见，
/// 只有最大化 / 全屏时才出现。这里统一按显示器工作区做一次收缩 + 重新居中。
fn fit_window_to_work_area(window: &tauri::WebviewWindow) {
    let monitor = match window.current_monitor() {
        Ok(Some(m)) => Some(m),
        _ => match window.primary_monitor() {
            Ok(Some(m)) => Some(m),
            _ => None,
        },
    };
    let monitor = match monitor {
        Some(m) => m,
        None => {
            log_info!("[window] 未能获取显示器信息，跳过窗口尺寸收缩");
            return;
        }
    };

    // work_area 已经排除了任务栏 / Dock 占用的区域
    let work_area = monitor.work_area();
    let area_size = work_area.size;
    let area_pos = work_area.position;
    if area_size.width == 0 || area_size.height == 0 {
        return;
    }

    // 再留一点余量给窗口阴影和边框
    let max_width = area_size.width.saturating_sub(16).max(640);
    let max_height = area_size.height.saturating_sub(16).max(480);

    let current = match window.outer_size() {
        Ok(size) => size,
        Err(error) => {
            log_error!("[window] 读取窗口尺寸失败: {error}");
            return;
        }
    };

    let target_width = current.width.min(max_width).max(1);
    let target_height = current.height.min(max_height).max(1);

    if target_width != current.width || target_height != current.height {
        if let Err(error) = window.set_size(tauri::PhysicalSize::new(target_width, target_height)) {
            log_error!("[window] 调整窗口尺寸失败: {error}");
            return;
        }
        log_info!(
            "[window] 窗口尺寸超出屏幕，已从 {}x{} 收缩到 {}x{}",
            current.width,
            current.height,
            target_width,
            target_height
        );
    }

    // 收缩后重新居中，避免窗口标题栏或底部仍然在屏幕外
    let offset_x = area_size.width.saturating_sub(target_width) / 2;
    let offset_y = area_size.height.saturating_sub(target_height) / 2;
    let x = area_pos.x + offset_x as i32;
    let y = area_pos.y + offset_y as i32;
    if let Err(error) = window.set_position(tauri::PhysicalPosition::new(x, y)) {
        log_error!("[window] 重新居中窗口失败: {error}");
    }
}

/// 把主窗口从托盘/最小化状态恢复并聚焦。
/// 托盘菜单、托盘点击、单实例二次启动都复用这一段逻辑。
fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    } else {
        log_error!("[window] 未找到主窗口 main，无法聚焦");
    }
}

/// 全局快捷键的窗口显隐切换：可见且聚焦时隐藏，其余情况恢复并聚焦。
/// （可见但被其他窗口盖住时，用户的意图显然是「把它调出来」而不是隐藏）
pub(crate) fn toggle_main_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        log_error!("[window] 未找到主窗口 main，无法切换显隐");
        return;
    };
    let visible = window.is_visible().unwrap_or(false);
    let minimized = window.is_minimized().unwrap_or(false);
    let focused = window.is_focused().unwrap_or(false);
    if visible && focused && !minimized {
        let _ = window.hide();
    } else {
        focus_main_window(app);
    }
}

/// 注册 / 更新全局快捷键。accel 为空表示禁用（仅注销现有快捷键）。
/// 解析失败或系统注册失败（例如与其他程序冲突）时返回错误，交给前端提示；
/// 应用内只注册这一个快捷键，所以直接 unregister_all 再重注册即可。
pub(crate) fn apply_global_shortcut(app: &tauri::AppHandle, accel: &str) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let manager = app.global_shortcut();
    manager
        .unregister_all()
        .map_err(|e| format!("注销旧快捷键失败: {e}"))?;
    let trimmed = accel.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    let shortcut: tauri_plugin_global_shortcut::Shortcut = trimmed
        .parse()
        .map_err(|e| format!("快捷键格式无效（{trimmed}）: {e}"))?;
    manager
        .register(shortcut)
        .map_err(|e| format!("注册全局快捷键失败（可能与其他程序冲突）: {e}"))?;
    log_info!("[hotkey] 已注册全局快捷键: {trimmed}");
    Ok(())
}


pub fn run() {
    tauri::Builder::default()
        // 单实例插件必须最先注册：第二个进程启动时会把参数转发给已运行的实例并自行退出。
        // 已启用 deep-link feature：Windows 深链会拉起第二个进程，插件在进入本回调前
        // 会先把 argv 里匹配 varswitch:// 的 URL 自动转发给 deep-link 插件（触发 on_open_url），
        // 因此这里保持原有聚焦逻辑即可，无需手动解析 argv。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            log_info!("[single-instance] 检测到重复启动，聚焦已有窗口");
            focus_main_window(app);
        }))
        // deep-link 插件：注册 varswitch:// 协议（安装包写注册表；开发模式靠 register_all 兜底）
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // 全局快捷键：应用内只注册「显示/隐藏主窗口」这一个快捷键，
        // 处理器无需区分触发的是哪一个
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        toggle_main_window(app);
                    }
                })
                .build(),
        )
        .manage(AppState {
            cancel_flag: AtomicBool::new(false),
        })
        .setup(|app| {
            // 初始化日志系统（写入 app_data_dir/logs/varswitch.log）
            init_logging(&app.handle());

            // ── Deep Link：varswitch:// 一键导入 ──────────────
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                // 开发模式 / 免安装绿色版兜底注册协议（NSIS 安装包会自动写注册表）。
                // best-effort：失败只记日志，不阻断启动。
                #[cfg(any(windows, target_os = "linux"))]
                if let Err(e) = app.deep_link().register_all() {
                    log_error!("[deep-link] register_all 失败（不影响已安装版本）：{e}");
                }
                // 运行中收到深链：包括 Windows 第二进程经 single-instance 自动转发的场景
                let deep_link_handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        handle_deep_link_url(&deep_link_handle, url.as_str());
                    }
                });
                // 冷启动场景：应用本身由深链拉起时，URL 在插件初始化阶段就已捕获，
                // 但此刻前端还没加载、事件会丢，延迟几秒再转发给前端确认框
                match app.deep_link().get_current() {
                    Ok(Some(urls)) if !urls.is_empty() => {
                        let startup_handle = app.handle().clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(Duration::from_millis(2500));
                            for url in urls {
                                handle_deep_link_url(&startup_handle, url.as_str());
                            }
                        });
                    }
                    Ok(_) => {}
                    Err(e) => log_error!("[deep-link] 读取启动深链失败：{e}"),
                }
            }

            // 当前激活的 Claude 配置若经本地代理（OpenAI 协议转换，或勾选了接管的
            // Anthropic 透传），重启后必须恢复代理，否则系统环境变量里指向
            // 127.0.0.1 的地址会连不上。
            {
                let profiles = read_profiles(&app.handle());
                if let Some(active) = profiles
                    .profiles
                    .iter()
                    .find(|p| p.is_active && profile_uses_proxy(p))
                {
                    claude_proxy::set_upstream_with_mode(
                        Some(claude_proxy::ProxyUpstream {
                            base_url: active.base_url.clone(),
                            api_key: active.api_key.clone(),
                            model: active.model_id.clone(),
                        }),
                        profile_proxy_mode(active),
                    );
                    match claude_proxy::ensure_server() {
                        Ok(_) => log_info!(
                            "[claude-proxy] 启动恢复：{} → {}",
                            active.name,
                            active.base_url
                        ),
                        Err(e) => log_error!("[claude-proxy] 启动恢复失败：{e}"),
                    }
                    // 主上游恢复后同步故障转移备用池（进程内存态，重启即丢，须重建）
                    sync_claude_proxy_failover_pool(&profiles);
                }
            }

            // Claude Desktop 使用独立上游与故障转移池；仅复用监听进程，不能覆盖
            // 上面的 Claude Code 运行态。恢复失败只记状态，不阻断其他应用启动。
            if let Err(error) =
                claude_desktop_provider::restore_claude_desktop_runtime(&app.handle())
            {
                log_error!("[claude-desktop-gateway] 启动恢复失败：{error}");
            }

            // 把历史遗留的明文 API Key 转成本机加密存储（内部会先备份、无明文则跳过）
            migrate_plaintext_secrets(&app.handle());

            // 读取应用设置
            let settings = read_app_settings(&app.handle());
            let silent_startup = settings.silent_startup;

            // 按设置注册全局快捷键（失败只记日志，不阻断启动）
            if let Err(e) = apply_global_shortcut(&app.handle(), &settings.global_shortcut) {
                log_warn!("[hotkey] 启动时注册全局快捷键失败：{e}");
            }

            // B10: 上次退出时手机远程是开启状态，本次启动自动恢复连接。
            // 延迟 1.5 秒等窗口和前端就绪，再在后台线程拉起各通道，不阻塞启动。
            let startup_state = read_toolbox_state(&app.handle());
            if startup_state.mobile_remote.enabled {
                log_info!("[startup] 检测到 mobile_remote.enabled，自动恢复手机通道连接");
                let app_for_restore = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(1500));
                    MOBILE_REMOTE_CANCEL_REQUESTED.store(false, Ordering::SeqCst);
                    if MOBILE_REMOTE_START_ACTIVE.swap(true, Ordering::SeqCst) {
                        log_info!("[startup] 已有启动流程在跑，跳过自动恢复");
                        return;
                    }
                    run_mobile_remote_start(app_for_restore);
                });
            }

            // Build tray menu（Claude/Codex/Gemini/Grok 快速切换子菜单 + 显示主窗口 + 退出）
            let menu = build_tray_menu(app.handle())?;

            // Build tray icon（固定 id，供后续 tray_by_id 刷新菜单）
            let tray_builder = TrayIconBuilder::with_id(TRAY_ICON_ID)
                .tooltip("VarSwitch")
                .menu(&menu);
            // 图标不可用时不阻断启动，仅无图标显示
            let tray_builder = if let Some(icon) = app.default_window_icon() {
                tray_builder.icon(icon.clone())
            } else {
                tray_builder
            };
            tray_builder
                .on_menu_event(|app, event| {
                    let menu_id = event.id().as_ref();
                    // 快速切换项 id 格式：tray-switch:<app>:<profileId>
                    if let Some(rest) = menu_id.strip_prefix("tray-switch:") {
                        if let Some((kind, profile_id)) = rest.split_once(':') {
                            handle_tray_switch(app, kind.to_string(), profile_id.to_string());
                        }
                        return;
                    }
                    match menu_id {
                        "show" => {
                            focus_main_window(app);
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        focus_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            // 把窗口收缩到当前显示器的可用工作区内。
            // 配置里的默认尺寸偏大，在 1080p 或开了缩放的屏幕上会超出可视范围，
            // 导致弹窗底部（保存 / 保存并启用按钮）落到屏幕外，只有最大化才看得见。
            if let Some(window) = app.get_webview_window("main") {
                fit_window_to_work_area(&window);
            }

            // 窗口关闭行为：根据设置决定隐藏到托盘还是退出
            if let Some(window) = app.get_webview_window("main") {
                let window_clone = window.clone();
                let app_handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        // 运行时重新读取设置，以便用户更改后立即生效
                        let current_settings = read_app_settings(&app_handle);
                        if current_settings.minimize_to_tray {
                            api.prevent_close();
                            let _ = window_clone.hide();
                        }
                        // 否则不阻止关闭，正常退出
                    }
                });
            } else {
                log_error!("[setup] 未找到主窗口 main，跳过窗口事件绑定");
            }

            // 静默启动：启动时隐藏窗口到托盘
            if silent_startup {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_profiles,
            test_api_endpoints,
            fetch_available_models,
            add_profile,
            update_profile,
            delete_profile,
            get_claude_proxy_status,
            claude_desktop_provider::get_claude_desktop_profiles,
            claude_desktop_provider::add_claude_desktop_profile,
            claude_desktop_provider::update_claude_desktop_profile,
            claude_desktop_provider::delete_claude_desktop_profile,
            claude_desktop_provider::reorder_claude_desktop_profiles,
            claude_desktop_provider::import_claude_profiles_to_desktop,
            claude_desktop_provider::switch_claude_desktop_profile,
            claude_desktop_provider::sync_claude_desktop_profile,
            claude_desktop_provider::get_claude_desktop_provider_status,
            claude_desktop_gateway::get_claude_desktop_gateway_health,
            claude_desktop_gateway::claude_desktop_gateway_reset_breaker,
            claude_desktop_localization::run_claude_desktop_localization,
            switch_profile,
            get_status,
            get_detected_editors,
            import_current,
            snapshot_config,
            restore_config,
            list_config_backups,
            restore_config_backup,
            open_backups_folder,
            cancel_switch,
            get_codex_profiles,
            add_codex_profile,
            update_codex_profile,
            delete_codex_profile,
            switch_codex_profile,
            switch_codex_to_account_login,
            import_codex_current,
            get_codex_status,
            get_grok_profiles,
            add_grok_profile,
            update_grok_profile,
            delete_grok_profile,
            switch_grok_profile,
            import_grok_current,
            get_grok_status,
            get_grok_diagnostics,
            backup_grok_runtime,
            open_grok_config_folder,
            get_gemini_profiles,
            add_gemini_profile,
            update_gemini_profile,
            delete_gemini_profile,
            switch_gemini_profile,
            import_gemini_current,
            get_gemini_status,
            get_codex_diagnostics,
            backup_codex_runtime,
            get_codex_toolbox,
            start_smart_control,
            get_smart_control_debug,
            submit_smart_control_approval,
            repair_openai_bundled_plugins,
            enable_codex_builtin_plugin,
            enable_important_codex_builtin_plugins,
            apply_plugin_marketplace,
            sync_codex_sessions,
            trash_codex_sessions,
            restore_codex_sessions,
            list_cli_sessions,
            resume_cli_session,
            select_mobile_thread,
            configure_mobile_channel,
            start_lark_bot_registration,
            poll_lark_bot_registration,
            open_lark_bot_launcher,
            clear_mobile_channel_binding,
            start_qq_qr_binding,
            cancel_qq_qr_binding,
            start_wechat_qr_binding,
            poll_wechat_qr_binding,
            bind_codex_thread,
            unbind_codex_thread,
            start_mobile_remote,
            stop_mobile_remote,
            get_app_settings,
            save_app_settings,
            apply_deep_link_import,
            get_data_dir_info,
            pick_data_dir,
            set_data_dir_override,
            opencode::get_opencode_profiles,
            opencode::add_opencode_profile,
            opencode::update_opencode_profile,
            opencode::delete_opencode_profile,
            opencode::switch_opencode_profile,
            opencode::get_opencode_runtime_status,
            opencode::reorder_opencode_profiles,
            get_app_paths,
            open_folder,
            open_logs_folder,
            open_external_target,
            check_app_update,
            install_app_update,
            download_and_open_update,
            export_profiles,
            import_profiles,
            get_skills,
            save_skill,
            delete_skill,
            get_claude_md,
            save_claude_md,
            get_prompt_templates,
            get_prompt_presets,
            save_prompt_preset,
            delete_prompt_preset,
            activate_prompt_preset,
            get_mcp_servers_list,
            save_mcp_server,
            delete_mcp_server_entry,
            get_unified_mcp_servers,
            save_unified_mcp_server,
            delete_unified_mcp_server,
            claude_desktop::get_claude_desktop_mcp,
            claude_desktop::set_claude_desktop_mcp_server,
            claude_desktop::remove_claude_desktop_mcp_server,
            get_mcp_presets,
            get_skill_repos,
            add_skill_repo,
            remove_skill_repo,
            get_catalog_skills,
            install_skill_from_url,
            pick_skill_zip,
            install_skill_from_zip,
            search_github_skills,
            search_github_mcp,
            reorder_profiles,
            reorder_codex_profiles,
            reorder_gemini_profiles,
            reorder_grok_profiles,
            claude_proxy::claude_proxy_health,
            claude_proxy::claude_proxy_reset_breaker,
            usage_stats::get_usage_dashboard,
            query_provider_balance,
            get_site_balance_tokens,
            save_site_balance_token,
            delete_site_balance_token,
            check_profiles_health,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
