//! Codex 配置域：档案存取、config.toml / auth.json 读写、诊断、图片 Skill（从 lib.rs 拆分，逻辑未改动）。

use crate::*;

pub(crate) const CODEX_IMAGE_API_KEY_ENV: &str = "VARSWITCH_IMAGE_API_KEY";
pub(crate) const CODEX_IMAGE_BASE_URL_ENV: &str = "VARSWITCH_IMAGE_BASE_URL";
pub(crate) const CODEX_IMAGE_MODEL_ENV: &str = "VARSWITCH_IMAGE_MODEL";
pub(crate) const CODEX_IMAGE_MODEL: &str = "gpt-image-2";
pub(crate) const CODEX_IMAGE_SKILL_ID: &str = "varswitch-imagegen";
pub(crate) const CODEX_DEEPSEEK_MODEL_CATALOG_FILE: &str = "models.json";
pub(crate) const CODEX_IMAGE_PRIORITY_START: &str = "<!-- VARSWITCH:IMAGE-SKILL-PRIORITY:START -->";
pub(crate) const CODEX_IMAGE_PRIORITY_END: &str = "<!-- VARSWITCH:IMAGE-SKILL-PRIORITY:END -->";
pub(crate) const CODEX_IMAGE_PRIORITY_INSTRUCTIONS: &str = r#"<!-- VARSWITCH:IMAGE-SKILL-PRIORITY:START -->
## VarSwitch image generation routing

- For image creation or rendering requests, prefer `varswitch-imagegen` and read its `SKILL.md` before selecting an image-generation path.
- Keep the built-in `imagegen` available as fallback. Use it when `varswitch-imagegen` is missing, not configured, or fails, or when the user explicitly requests the built-in path.
<!-- VARSWITCH:IMAGE-SKILL-PRIORITY:END -->"#;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexProfile {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) api_key: String,
    pub(crate) base_url: String,
    #[serde(default = "default_codex_auth_mode")]
    pub(crate) auth_mode: String,
    /// 上游协议：responses（OpenAI Responses，默认）| chat（OpenAI Chat Completions）
    #[serde(default = "default_codex_wire_api")]
    pub(crate) wire_api: String,
    #[serde(default)]
    pub(crate) model: String,
    #[serde(default)]
    pub(crate) provider_name: String,
    #[serde(default)]
    pub(crate) image_api_key: String,
    #[serde(default)]
    pub(crate) image_base_url: String,
    pub(crate) is_active: bool,
    pub(crate) created_at: String,
}

#[derive(Serialize, Deserialize, Default, Clone)]
pub(crate) struct CodexProfilesData {
    pub(crate) profiles: Vec<CodexProfile>,
    /// 首次读取旧档案时清理历史默认图片地址；迁移完成后保留用户手动填写的 URL。
    #[serde(default)]
    pub(crate) image_base_url_migrated: bool,
}

pub(crate) fn default_codex_auth_mode() -> String {
    "auth_json".to_string()
}

pub(crate) fn default_codex_wire_api() -> String {
    "responses".to_string()
}

/// 规范化 Codex 上游协议，只允许 responses / chat 两种取值。
pub(crate) fn normalize_codex_wire_api(raw: &str) -> String {
    match raw.trim() {
        "chat" => "chat".to_string(),
        _ => default_codex_wire_api(),
    }
}

pub(crate) fn is_codex_official_account_api_quota(auth_mode: &str) -> bool {
    auth_mode == "official_account_api_quota"
}

pub(crate) fn codex_profiles_path(app: &tauri::AppHandle) -> PathBuf {
    data_dir(app).join("codex_profiles.json")
}

pub(crate) fn read_codex_profiles(app: &tauri::AppHandle) -> CodexProfilesData {
    let path = codex_profiles_path(app);
    if !path.exists() {
        return CodexProfilesData {
            image_base_url_migrated: true,
            ..CodexProfilesData::default()
        };
    }
    let mut data: CodexProfilesData = fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    for p in data.profiles.iter_mut() {
        let label = format!("Codex 配置「{}」", p.name);
        p.api_key = decrypt_secret_or_keep(&p.api_key, &label);
        p.image_api_key = decrypt_secret_or_keep(&p.image_api_key, &label);
    }
    // 图片 Base URL 不设默认值。旧档案只在首次读取时清理一次，确保历史默认值
    // 为空；迁移完成后用户主动填写的自定义 URL 可以正常保留。
    let migrated = if data.image_base_url_migrated {
        false
    } else {
        let _ = clear_codex_image_base_urls(&mut data);
        data.image_base_url_migrated = true;
        true
    };
    if migrated {
        let _ = write_codex_profiles(app, &data);
    }
    data
}

pub(crate) fn clear_codex_image_base_urls(data: &mut CodexProfilesData) -> bool {
    let mut changed = false;
    for profile in &mut data.profiles {
        if !profile.image_base_url.is_empty() {
            profile.image_base_url.clear();
            changed = true;
        }
    }
    changed
}

pub(crate) fn write_codex_profiles(app: &tauri::AppHandle, data: &CodexProfilesData) -> Result<(), String> {
    let path = codex_profiles_path(app);
    let mut encrypted = data.clone();
    for p in encrypted.profiles.iter_mut() {
        p.api_key = encrypt_secret(&p.api_key);
        p.image_api_key = encrypt_secret(&p.image_api_key);
    }
    let json = serde_json::to_string_pretty(&encrypted).map_err(|e| e.to_string())?;
    write_private_file(&path, &json)?;
    refresh_tray_menu(app);
    Ok(())
}

pub(crate) fn codex_config_dir() -> PathBuf {
    home_dir().join(".codex")
}

pub(crate) fn codex_auth_path() -> PathBuf {
    codex_config_dir().join("auth.json")
}

pub(crate) fn codex_config_path() -> PathBuf {
    codex_config_dir().join("config.toml")
}

pub(crate) fn codex_deepseek_model_catalog_path() -> PathBuf {
    codex_config_dir().join(CODEX_DEEPSEEK_MODEL_CATALOG_FILE)
}

pub(crate) fn is_deepseek_native_base_url(base_url: &str) -> bool {
    let lower = base_url.trim().to_ascii_lowercase();
    let without_scheme = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
        .unwrap_or(&lower);
    let authority = without_scheme.split('/').next().unwrap_or_default();
    let host = authority.rsplit('@').next().unwrap_or_default();

    matches!(host, "api.deepseek.com" | "api.deepseek.com:443")
}

pub(crate) fn uses_deepseek_native_model_catalog(provider: &str, base_url: &str) -> bool {
    provider.trim() == "deepseek" && is_deepseek_native_base_url(base_url)
}

pub(crate) fn deepseek_codex_model_catalog() -> String {
    let base_instructions = "You are Codex, an agent that collaborates with the user in the current workspace until the requested work is complete.";
    let catalog_model = |slug: &str, display_name: &str| {
        serde_json::json!({
            "slug": slug,
            "prefer_websockets": false,
            "support_verbosity": true,
            "default_verbosity": "low",
            "apply_patch_tool_type": "freeform",
            "web_search_tool_type": "text",
            "input_modalities": ["text"],
            "supports_image_detail_original": false,
            "truncation_policy": { "mode": "tokens", "limit": 10000 },
            "supports_parallel_tool_calls": true,
            "tool_mode": null,
            "multi_agent_version": "v2",
            "use_responses_lite": false,
            "include_skills_usage_instructions": false,
            "auto_review_model_override": null,
            "context_window": 1_048_576,
            "max_context_window": 1_048_576,
            "effective_context_window_percent": 95,
            "auto_compact_token_limit": null,
            "comp_hash": "3000",
            "reasoning_summary_format": "experimental",
            "default_reasoning_summary": "none",
            "display_name": display_name,
            "description": "DeepSeek agentic coding model.",
            "default_reasoning_level": "high",
            "supported_reasoning_levels": [
                { "effort": "low", "description": "Fast responses with lighter reasoning" },
                { "effort": "high", "description": "Extra reasoning depth for complex problems" },
                { "effort": "max", "description": "Maximum reasoning depth for the hardest problems" }
            ],
            "shell_type": "shell_command",
            "visibility": "list",
            "minimal_client_version": "0.144.0",
            "supported_in_api": true,
            "availability_nux": null,
            "upgrade": null,
            "priority": 1,
            "model_messages": {
                "instructions_template": base_instructions,
                "instructions_variables": {},
                "approvals": null
            },
            "experimental_supported_tools": [],
            "supports_search_tool": true,
            "default_service_tier": null,
            "supports_reasoning_summaries": true,
            "base_instructions": base_instructions
        })
    };
    serde_json::to_string_pretty(&serde_json::json!({
        "models": [
            catalog_model("deepseek-v4-flash", "DeepSeek-V4-Flash"),
            catalog_model("deepseek-v4-pro", "DeepSeek-V4-Pro")
        ]
    }))
    .expect("DeepSeek model catalog serialization should not fail")
}

pub(crate) fn codex_global_agents_path() -> PathBuf {
    codex_config_dir().join("AGENTS.md")
}

pub(crate) fn codex_sessions_root() -> PathBuf {
    codex_config_dir().join("sessions")
}

pub(crate) fn codex_session_index_path() -> PathBuf {
    codex_config_dir().join("session_index.jsonl")
}

#[cfg(test)]
pub(crate) fn codex_config_toml_content(
    provider: &str,
    model: &str,
    base_url: &str,
    api_key: &str,
    official_account_mode: bool,
) -> String {
    codex_config_toml_content_with_image(
        provider,
        model,
        base_url,
        api_key,
        "responses",
        official_account_mode,
        "",
        "",
    )
}

pub(crate) fn codex_image_skill_dir() -> PathBuf {
    codex_config_dir().join("skills").join(CODEX_IMAGE_SKILL_ID)
}

pub(crate) fn codex_image_skill_script_path() -> PathBuf {
    codex_image_skill_dir()
        .join("scripts")
        .join("generate-image.ps1")
}

pub(crate) fn codex_image_skill_manifest(script_path: &Path) -> String {
    format!(
        r#"---
name: varswitch-imagegen
description: Use when the user asks to create, generate, or render an image and VarSwitch image settings are available. This is the preferred image-generation Skill over the built-in imagegen path while configured.
---

# VarSwitch Image Generation

Use the configured image endpoint through the bundled script as the first choice for image generation. Keep the built-in `imagegen` as fallback only when this Skill is missing, not configured, or fails, or when the user explicitly requests the built-in path. Never print or copy image API credentials into chat, commands, logs, or generated files.

Run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{script_path}" -Prompt "<prompt>" -OutputPath "<absolute-output-path.png>" -Size "1024x1024"
```

- Use an absolute output path inside the current workspace unless the user requests another location.
- Supported default sizes are `1024x1024`, `1536x1024`, and `1024x1536`; pass through another size only when the configured provider supports it.
- After the script succeeds, inspect the saved image with the available image viewing tool before handing it off.
- If configuration is missing, tell the user to configure and enable the Codex Image Skill in VarSwitch, then restart Codex.
"#,
        script_path = script_path.display()
    )
}

pub(crate) fn codex_image_skill_script() -> &'static str {
    r##"param(
  [Parameter(Mandatory = $true)][string]$Prompt,
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [string]$Size = "1024x1024"
)

$ErrorActionPreference = "Stop"

function Get-VarSwitchImageSetting([string]$Name) {
  $value = [Environment]::GetEnvironmentVariable($Name, "Process")
  if ([string]::IsNullOrWhiteSpace($value)) {
    $value = [Environment]::GetEnvironmentVariable($Name, "User")
  }
  return $value
}

$apiKey = Get-VarSwitchImageSetting "VARSWITCH_IMAGE_API_KEY"
$baseUrl = Get-VarSwitchImageSetting "VARSWITCH_IMAGE_BASE_URL"
$model = Get-VarSwitchImageSetting "VARSWITCH_IMAGE_MODEL"

if ([string]::IsNullOrWhiteSpace($apiKey) -or [string]::IsNullOrWhiteSpace($baseUrl)) {
  throw "VarSwitch image generation is not configured. Enable a Codex profile with image settings and restart Codex."
}
if ([string]::IsNullOrWhiteSpace($model)) {
  $model = "gpt-image-2"
}

$endpoint = $baseUrl.TrimEnd('/') + "/images/generations"
$headers = @{ Authorization = "Bearer $apiKey" }
$payload = @{
  model = $model
  prompt = $Prompt
  size = $Size
} | ConvertTo-Json -Compress

$response = Invoke-RestMethod -Method Post -Uri $endpoint -Headers $headers -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes($payload))
if (-not $response.data -or $response.data.Count -lt 1) {
  throw "The image API returned no image data."
}

$resolvedPath = [IO.Path]::GetFullPath($OutputPath)
$parent = Split-Path -Parent $resolvedPath
if ($parent -and -not (Test-Path -LiteralPath $parent)) {
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
}

$image = $response.data[0]
if (-not [string]::IsNullOrWhiteSpace($image.b64_json)) {
  [IO.File]::WriteAllBytes($resolvedPath, [Convert]::FromBase64String($image.b64_json))
} elseif (-not [string]::IsNullOrWhiteSpace($image.url)) {
  Invoke-WebRequest -UseBasicParsing -Uri $image.url -OutFile $resolvedPath
} else {
  throw "The image API response contains neither b64_json nor url."
}

@{ success = $true; path = $resolvedPath; model = $model } | ConvertTo-Json -Compress
"##
}

pub(crate) fn install_codex_image_skill_at(skill_dir: &Path) -> Result<(), String> {
    let script_path = skill_dir.join("scripts").join("generate-image.ps1");
    let scripts_dir = script_path
        .parent()
        .ok_or("无法确定 Codex 图片 Skill 脚本目录")?;
    fs::create_dir_all(scripts_dir).map_err(|e| format!("创建 Codex 图片 Skill 目录失败: {e}"))?;
    write_file_atomic(
        &skill_dir.join("SKILL.md"),
        &codex_image_skill_manifest(&script_path),
    )
    .map_err(|e| format!("写入 Codex 图片 Skill 说明失败: {e}"))?;
    write_file_atomic(&script_path, codex_image_skill_script())
        .map_err(|e| format!("写入 Codex 图片生成脚本失败: {e}"))?;
    Ok(())
}

pub(crate) fn install_codex_image_skill() -> Result<(), String> {
    install_codex_image_skill_at(&codex_image_skill_dir())
}

pub(crate) fn remove_codex_image_skill() -> Result<(), String> {
    let dir = codex_image_skill_dir();
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("移除 Codex 图片 Skill 失败: {e}"))?;
    }
    Ok(())
}

pub(crate) fn merge_codex_image_priority_instructions(existing: &str, enabled: bool) -> String {
    let mut output = existing.to_string();

    while let Some(start) = output.find(CODEX_IMAGE_PRIORITY_START) {
        let Some(relative_end) = output[start..].find(CODEX_IMAGE_PRIORITY_END) else {
            break;
        };
        let end = start + relative_end + CODEX_IMAGE_PRIORITY_END.len();
        let removal_start =
            if output.as_bytes().get(start.saturating_sub(2)..start) == Some(b"\r\n") {
                start - 2
            } else if start > 0 && output.as_bytes()[start - 1] == b'\n' {
                start - 1
            } else {
                start
            };
        output.replace_range(removal_start..end, "");
    }

    if !enabled {
        return output;
    }
    if output.is_empty() {
        return CODEX_IMAGE_PRIORITY_INSTRUCTIONS.to_string();
    }

    let newline = if existing.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    output.push_str(newline);
    if newline == "\r\n" {
        output.push_str(&CODEX_IMAGE_PRIORITY_INSTRUCTIONS.replace('\n', "\r\n"));
    } else {
        output.push_str(CODEX_IMAGE_PRIORITY_INSTRUCTIONS);
    }
    output
}

pub(crate) fn configure_codex_image_priority_instructions(enabled: bool) -> Result<(), String> {
    let path = codex_global_agents_path();
    if !enabled && !path.exists() {
        return Ok(());
    }

    let existing = fs::read_to_string(&path).unwrap_or_default();
    let updated = merge_codex_image_priority_instructions(&existing, enabled);
    if updated == existing {
        return Ok(());
    }

    fs::create_dir_all(codex_config_dir()).map_err(|e| format!("创建 Codex 配置目录失败: {e}"))?;
    write_file_atomic(&path, &updated).map_err(|e| format!("写入 Codex 全局指令失败: {e}"))
}

pub(crate) fn configure_codex_image_skill(profile: &CodexProfile) -> Result<(), String> {
    // 图片 Skill 只有在 Key 与 URL 都由用户明确填写时才启用。绝不回退到内置地址。
    if profile.image_api_key.trim().is_empty() || profile.image_base_url.trim().is_empty() {
        for name in [
            CODEX_IMAGE_API_KEY_ENV,
            CODEX_IMAGE_BASE_URL_ENV,
            CODEX_IMAGE_MODEL_ENV,
        ] {
            if reg_get_env_opt(name).is_some() {
                reg_delete_env(name)?;
            }
        }
        remove_codex_image_skill()?;
        configure_codex_image_priority_instructions(false)?;
        broadcast_env_change();
        return Ok(());
    }

    let base_url = profile
        .image_base_url
        .trim()
        .trim_end_matches('/')
        .to_string();
    reg_set_env(CODEX_IMAGE_API_KEY_ENV, profile.image_api_key.trim())?;
    reg_set_env(CODEX_IMAGE_BASE_URL_ENV, &base_url)?;
    reg_set_env(CODEX_IMAGE_MODEL_ENV, CODEX_IMAGE_MODEL)?;
    install_codex_image_skill()?;
    configure_codex_image_priority_instructions(true)?;
    broadcast_env_change();
    Ok(())
}

pub(crate) fn codex_config_toml_content_with_image(
    provider: &str,
    model: &str,
    base_url: &str,
    api_key: &str,
    wire_api: &str,
    official_account_mode: bool,
    _image_api_key: &str,
    _image_base_url: &str,
) -> String {
    if official_account_mode {
        let content = format!(
            r#"model_provider = "customer"
model = "gpt-5.5"
review_model = "gpt-5.5"
model_reasoning_effort = "xhigh"
disable_response_storage = true
preferred_auth_method = "apikey"
chatgpt_base_url = "{chatgpt_base_url}"

[model_providers.customer]
name = "customer"
wire_api = "responses"
requires_openai_auth = true
base_url = "{base_url}"
experimental_bearer_token = "{api_key}"
"#,
            base_url = base_url,
            api_key = api_key,
            chatgpt_base_url = smart_control_backend_api_url(),
        );
        content
    } else {
        let use_deepseek_catalog = uses_deepseek_native_model_catalog(provider, base_url);
        let model_catalog_json = if use_deepseek_catalog {
            format!(
                "model_reasoning_effort = \"high\"\nmodel_catalog_json = \"{}\"\n",
                CODEX_DEEPSEEK_MODEL_CATALOG_FILE
            )
        } else {
            String::new()
        };
        let effective_wire_api = if use_deepseek_catalog {
            "responses".to_string()
        } else {
            normalize_codex_wire_api(wire_api)
        };
        let content = format!(
            r#"model_provider = "{provider}"
model = "{model}"
{model_catalog_json}chatgpt_base_url = "{chatgpt_base_url}"

[model_providers.{provider}]
name = "{provider}"
base_url = "{base_url}"
wire_api = "{wire_api}"
requires_openai_auth = true
"#,
            provider = provider,
            model = model,
            model_catalog_json = model_catalog_json,
            base_url = base_url,
            wire_api = effective_wire_api,
            chatgpt_base_url = smart_control_backend_api_url(),
        );
        content
    }
}

/// 写入 Codex 配置文件。
/// 默认写入 ~/.codex/auth.json 和 ~/.codex/config.toml；
/// 官方账号登录/API 额度模式只写 ~/.codex/config.toml，不改动 auth.json。
pub(crate) fn write_codex_config(profile: &CodexProfile) -> Result<(), String> {
    write_codex_config_with_base_url(profile, &profile.base_url)
}

pub(crate) fn write_codex_config_with_base_url(profile: &CodexProfile, base_url: &str) -> Result<(), String> {
    let dir = codex_config_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("创建 ~/.codex 目录失败: {}", e))?;
    let existing_config = fs::read_to_string(codex_config_path()).unwrap_or_default();

    // 写入 config.toml
    let official_account_mode = is_codex_official_account_api_quota(&profile.auth_mode);
    let provider = if official_account_mode {
        "customer".to_string()
    } else if profile.provider_name.is_empty() {
        "custom".to_string()
    } else {
        profile.provider_name.clone()
    };
    let model = if official_account_mode {
        "gpt-5.5".to_string()
    } else if profile.model.is_empty() {
        "default".to_string()
    } else {
        profile.model.clone()
    };
    if !official_account_mode && uses_deepseek_native_model_catalog(&provider, base_url) {
        write_file_atomic(
            &codex_deepseek_model_catalog_path(),
            &deepseek_codex_model_catalog(),
        )
        .map_err(|e| format!("写入 Codex DeepSeek 模型目录失败: {}", e))?;
    }
    let toml_content = if official_account_mode {
        codex_config_toml_content_with_image(
            &provider,
            &model,
            base_url,
            &profile.api_key,
            &profile.wire_api,
            true,
            &profile.image_api_key,
            &profile.image_base_url,
        )
    } else {
        let auth_path = codex_auth_path();
        let mut auth = if auth_path.exists() {
            fs::read_to_string(&auth_path)
                .ok()
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                .filter(|value| value.is_object())
                .unwrap_or_else(|| serde_json::json!({}))
        } else {
            serde_json::json!({
                "OPENAI_API_KEY": profile.api_key
            })
        };
        if let Some(obj) = auth.as_object_mut() {
            obj.insert(
                "OPENAI_API_KEY".to_string(),
                serde_json::Value::String(profile.api_key.clone()),
            );
        }
        let auth_str = serde_json::to_string_pretty(&auth).map_err(|e| e.to_string())?;
        write_private_file(&auth_path, &auth_str)
            .map_err(|e| format!("写入 codex auth.json 失败: {}", e))?;

        codex_config_toml_content_with_image(
            &provider,
            &model,
            base_url,
            &profile.api_key,
            &profile.wire_api,
            false,
            &profile.image_api_key,
            &profile.image_base_url,
        )
    };
    let final_toml = merge_codex_config_with_preserved_sections(&toml_content, &existing_config);
    write_file_atomic(&codex_config_path(), &final_toml)
        .map_err(|e| format!("写入 codex config.toml 失败: {}", e))?;

    Ok(())
}

pub(crate) fn codex_status_from_config(
    config_str: &str,
    api_key: String,
    image_api_key: String,
    image_base_url: String,
    image_skill_installed: bool,
) -> LocationStatus {
    let provider_name = toml_line_value(config_str, "model_provider");
    let provider_base_url = if provider_name.trim().is_empty() {
        String::new()
    } else {
        toml_section_value(
            config_str,
            &format!("model_providers.{}", provider_name.trim()),
            "base_url",
        )
    };
    let base_url = if !provider_base_url.trim().is_empty() {
        provider_base_url
    } else {
        toml_line_value(config_str, "base_url")
    };

    LocationStatus {
        api_key,
        base_url,
        model: toml_line_value(config_str, "model"),
        image_api_key,
        image_base_url,
        image_skill_installed,
    }
}

/// 读取当前 Codex 配置状态
pub(crate) fn read_codex_status() -> Option<LocationStatus> {
    let config_str = fs::read_to_string(codex_config_path()).unwrap_or_default();
    let auth_api_key = fs::read_to_string(codex_auth_path())
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|auth| {
            auth.get("OPENAI_API_KEY")
                .and_then(|v| v.as_str())
                .map(|value| value.to_string())
        })
        .unwrap_or_default();
    let bearer_token = config_str
        .lines()
        .find(|l| l.trim().starts_with("experimental_bearer_token"))
        .and_then(|l| l.split('=').nth(1))
        .map(|v| v.trim().trim_matches('"').to_string())
        .unwrap_or_default();
    let api_key = if auth_api_key.is_empty() {
        bearer_token
    } else {
        auth_api_key
    };

    let image_api_key = reg_get_env_opt(CODEX_IMAGE_API_KEY_ENV)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| toml_section_value(&config_str, "gpt_image_2", "api_key"));
    let image_base_url = reg_get_env_opt(CODEX_IMAGE_BASE_URL_ENV)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| toml_section_value(&config_str, "gpt_image_2", "base_url"));

    Some(codex_status_from_config(
        &config_str,
        api_key,
        image_api_key,
        image_base_url,
        codex_image_skill_dir().join("SKILL.md").exists()
            && codex_image_skill_script_path().exists(),
    ))
}

pub(crate) fn parse_toml_string_value(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.len() >= 2 {
        let bytes = trimmed.as_bytes();
        if (bytes[0] == b'"' && bytes[trimmed.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[trimmed.len() - 1] == b'\'')
        {
            return trimmed[1..trimmed.len() - 1].to_string();
        }
    }
    trimmed.to_string()
}

pub(crate) fn escape_toml_string_value(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

pub(crate) fn toml_section_value(config: &str, section: &str, key: &str) -> String {
    let target_header = format!("[{section}]");
    let prefix = format!("{key} =");
    let mut in_target = false;
    for line in config.lines() {
        let trimmed = line.trim();
        if is_toml_section_header(trimmed) {
            in_target = trimmed == target_header;
            continue;
        }
        if in_target && trimmed.starts_with(&prefix) {
            return trimmed
                .split_once('=')
                .map(|(_, value)| parse_toml_string_value(value))
                .unwrap_or_default();
        }
    }
    String::new()
}

pub(crate) fn is_managed_gpt_image_2_section(header: &str) -> bool {
    matches!(header.trim(), "[gpt_image_2]")
}

pub(crate) fn is_toml_section_header(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.starts_with('[') && trimmed.ends_with(']')
}

pub(crate) fn toml_root_key(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('[') {
        return None;
    }
    trimmed
        .split_once('=')
        .map(|(key, _)| key.trim().trim_matches('"').to_string())
        .filter(|key| !key.is_empty())
}

pub(crate) fn split_codex_config_root_and_sections(config_text: &str) -> (String, String) {
    const MANAGED_ROOT_KEYS: &[&str] = &[
        "model_provider",
        "model",
        "review_model",
        "model_reasoning_effort",
        "disable_response_storage",
        "preferred_auth_method",
        "forced_login_method",
        "model_catalog_json",
        "chatgpt_base_url",
    ];
    let lines: Vec<&str> = config_text.lines().collect();
    let mut index = 0usize;
    let mut root_lines = Vec::new();
    let mut sections = Vec::new();

    while index < lines.len() {
        let line = lines[index];
        let trimmed = line.trim();
        if is_toml_section_header(trimmed) {
            break;
        }
        if let Some(key) = toml_root_key(line) {
            if !MANAGED_ROOT_KEYS.contains(&key.as_str()) {
                root_lines.push(line.to_string());
            }
        } else if !trimmed.is_empty() {
            root_lines.push(line.to_string());
        }
        index += 1;
    }

    while index < lines.len() {
        let header = lines[index].trim();
        if !is_toml_section_header(header) {
            index += 1;
            continue;
        }
        let skip_managed_provider =
            header.starts_with("[model_providers.") || is_managed_gpt_image_2_section(header);
        let mut block = vec![lines[index].to_string()];
        index += 1;
        while index < lines.len() {
            let current = lines[index].trim();
            if is_toml_section_header(current) {
                break;
            }
            block.push(lines[index].to_string());
            index += 1;
        }
        if !skip_managed_provider {
            sections.push(block.join("\n").trim().to_string());
        }
    }

    (
        root_lines.join("\n").trim().to_string(),
        sections.join("\n\n").trim().to_string(),
    )
}

pub(crate) fn merge_codex_config_with_preserved_sections(generated: &str, existing: &str) -> String {
    let (preserved_root, preserved_sections) = split_codex_config_root_and_sections(existing);
    let mut output = generated.trim_end().to_string();

    if !preserved_root.trim().is_empty() {
        if let Some(pos) = output.find("\n[model_providers.") {
            output.insert_str(pos, &format!("\n{}", preserved_root.trim()));
        } else {
            output.push('\n');
            output.push_str(preserved_root.trim());
        }
    }

    if !preserved_sections.trim().is_empty() {
        output.push_str("\n\n");
        output.push_str(preserved_sections.trim());
    }

    output.push('\n');
    output
}

#[tauri::command]
pub(crate) fn reorder_codex_profiles(
    app: tauri::AppHandle,
    ids: Vec<String>,
) -> Result<CodexProfilesData, String> {
    let mut data = read_codex_profiles(&app);
    data.profiles = reorder_by_ids(std::mem::take(&mut data.profiles), &ids, |p| &p.id);
    write_codex_profiles(&app, &data)?;
    Ok(data)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexConfigDiagnostics {
    pub(crate) config_path: String,
    pub(crate) auth_path: String,
    pub(crate) config_exists: bool,
    pub(crate) auth_exists: bool,
    pub(crate) has_model_provider: bool,
    pub(crate) has_model: bool,
    pub(crate) has_base_url: bool,
    pub(crate) has_api_key: bool,
    pub(crate) provider_name: String,
    pub(crate) model: String,
    pub(crate) base_url: String,
    pub(crate) auth_mode: String,
    pub(crate) active_profile_name: String,
    pub(crate) plugin_marketplaces: Vec<String>,
    pub(crate) issues: Vec<String>,
    pub(crate) suggestions: Vec<String>,
    pub(crate) last_checked_at: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexConfigBackupResult {
    pub(crate) config_backup: Option<String>,
    pub(crate) auth_backup: Option<String>,
    pub(crate) created_at: String,
}

pub(crate) fn backup_codex_runtime_files(app: &tauri::AppHandle) -> CodexConfigBackupResult {
    let dir = backups_dir(app).join("codex-runtime");
    let _ = fs::create_dir_all(&dir);
    let stamp = format_compact_time(chrono_timestamp_millis());
    let config_backup =
        backup_one_file_with_ext(&dir, &codex_config_path(), "config", &stamp, "toml");
    let auth_backup = backup_one_file_with_ext(&dir, &codex_auth_path(), "auth", &stamp, "json");
    CodexConfigBackupResult {
        config_backup,
        auth_backup,
        created_at: chrono_now(),
    }
}

pub(crate) fn toml_line_value(config: &str, key: &str) -> String {
    let prefix = format!("{key} =");
    config
        .lines()
        .find(|line| line.trim().starts_with(&prefix))
        .and_then(|line| line.split_once('=').map(|(_, value)| value))
        .map(|value| value.trim().trim_matches('"').to_string())
        .unwrap_or_default()
}

pub(crate) fn detect_codex_plugin_marketplaces(config: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut in_marketplace = false;
    let mut current = String::new();
    for line in config.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("[marketplaces.") {
            in_marketplace = true;
            current.clear();
            continue;
        }
        if trimmed.starts_with('[') {
            if in_marketplace && !current.is_empty() {
                out.push(current.clone());
            }
            in_marketplace = false;
            current.clear();
            continue;
        }
        if in_marketplace && trimmed.starts_with("source") {
            if let Some((_, value)) = trimmed.split_once('=') {
                current = value.trim().trim_matches('"').to_string();
            }
        }
    }
    if in_marketplace && !current.is_empty() {
        out.push(current);
    }
    out.sort();
    out.dedup();
    out
}

pub(crate) fn read_codex_config_diagnostics(app: &tauri::AppHandle) -> CodexConfigDiagnostics {
    let config_path = codex_config_path();
    let auth_path = codex_auth_path();
    let config = fs::read_to_string(&config_path).unwrap_or_default();
    let status = read_codex_status().unwrap_or(LocationStatus {
        api_key: String::new(),
        base_url: String::new(),
        model: String::new(),
        image_api_key: String::new(),
        image_base_url: String::new(),
        image_skill_installed: false,
    });
    let model_provider = toml_line_value(&config, "model_provider");
    let model = toml_line_value(&config, "model");
    let provider_name = if model_provider.is_empty() {
        toml_line_value(&config, "name")
    } else {
        model_provider.clone()
    };
    let auth_mode = if config
        .lines()
        .any(|l| l.trim().starts_with("experimental_bearer_token"))
    {
        "official_account_api_quota".to_string()
    } else if auth_path.exists() {
        "auth_json".to_string()
    } else {
        "unknown".to_string()
    };
    let active_profile_name = read_codex_profiles(app)
        .profiles
        .into_iter()
        .find(|profile| profile.is_active)
        .map(|profile| profile.name)
        .unwrap_or_default();
    let plugin_marketplaces = detect_codex_plugin_marketplaces(&config);
    let config_exists = config_path.exists();
    let auth_exists = auth_path.exists();
    let has_model_provider = !model_provider.is_empty() || config.contains("[model_providers.");
    let has_model = !model.is_empty();
    let has_base_url = !status.base_url.is_empty();
    let has_api_key = !status.api_key.is_empty();
    let mut issues = Vec::new();
    let mut suggestions = Vec::new();
    if !config_exists {
        issues.push("未找到 ~/.codex/config.toml".into());
        suggestions.push("在 Codex CLI 页面添加并切换一个配置".into());
    }
    if !has_model_provider {
        issues.push("config.toml 缺少 model_provider 或 model_providers 配置".into());
        suggestions.push("重新切换当前 Codex 配置，让 VarSwitch 写入完整 provider".into());
    }
    if !has_model {
        issues.push("config.toml 缺少 model 字段".into());
        suggestions.push("在 Codex 配置中填写模型名后重新保存".into());
    }
    if !has_base_url {
        issues.push("未检测到 Codex Base URL".into());
        suggestions.push("检查 provider 的 base_url 是否存在".into());
    }
    if !has_api_key {
        issues.push("未检测到 Codex API Key".into());
        suggestions.push(
            "检查 auth.json 的 OPENAI_API_KEY 或 config.toml 的 experimental_bearer_token".into(),
        );
    }
    if auth_mode == "auth_json" && !auth_exists {
        issues.push("当前看起来需要 auth.json，但文件不存在".into());
    }
    if !status.image_api_key.is_empty() && !status.image_skill_installed {
        issues.push("图片 API 已配置，但 Codex 图片生成 Skill 尚未安装".into());
        suggestions.push("重新同步当前 Codex 配置，然后重启 Codex".into());
    }
    if plugin_marketplaces.is_empty() {
        suggestions.push("可在 Toolbox 安装 Codex 插件市场".into());
    }
    issues.sort();
    issues.dedup();
    suggestions.sort();
    suggestions.dedup();
    CodexConfigDiagnostics {
        config_path: config_path.to_string_lossy().to_string(),
        auth_path: auth_path.to_string_lossy().to_string(),
        config_exists,
        auth_exists,
        has_model_provider,
        has_model,
        has_base_url,
        has_api_key,
        provider_name,
        model,
        base_url: status.base_url,
        auth_mode,
        active_profile_name,
        plugin_marketplaces,
        issues,
        suggestions,
        last_checked_at: chrono_now(),
    }
}

#[tauri::command]
pub(crate) fn get_codex_diagnostics(app: tauri::AppHandle) -> CodexConfigDiagnostics {
    read_codex_config_diagnostics(&app)
}

#[tauri::command]
pub(crate) fn backup_codex_runtime(app: tauri::AppHandle) -> CodexConfigBackupResult {
    backup_codex_runtime_files(&app)
}

// ── Codex Profile Commands ──────────────────────────

#[tauri::command]
pub(crate) fn get_codex_profiles(app: tauri::AppHandle) -> CodexProfilesData {
    read_codex_profiles(&app)
}

#[tauri::command]
pub(crate) fn add_codex_profile(
    app: tauri::AppHandle,
    name: String,
    api_key: String,
    base_url: String,
    auth_mode: Option<String>,
    wire_api: Option<String>,
    model: Option<String>,
    provider_name: Option<String>,
    image_api_key: Option<String>,
    image_base_url: Option<String>,
) -> Result<CodexProfile, String> {
    if name.trim().is_empty() || api_key.trim().is_empty() {
        return Err("配置名称和 API Key 都必须填写".into());
    }
    let mut data = read_codex_profiles(&app);
    let profile = CodexProfile {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.trim().to_string(),
        api_key: api_key.trim().to_string(),
        base_url: resolve_base_url_or_default(&base_url, DEFAULT_OPENAI_BASE_URL),
        auth_mode: auth_mode.unwrap_or_else(default_codex_auth_mode),
        wire_api: normalize_codex_wire_api(&wire_api.unwrap_or_default()),
        model: model.unwrap_or_default().trim().to_string(),
        provider_name: provider_name.unwrap_or_default().trim().to_string(),
        image_api_key: image_api_key.unwrap_or_default().trim().to_string(),
        image_base_url: image_base_url
            .unwrap_or_default()
            .trim()
            .trim_end_matches('/')
            .to_string(),
        is_active: false,
        created_at: chrono_now(),
    };
    data.profiles.push(profile.clone());
    write_codex_profiles(&app, &data)?;
    Ok(profile)
}

#[tauri::command]
pub(crate) fn update_codex_profile(
    app: tauri::AppHandle,
    id: String,
    name: String,
    api_key: String,
    base_url: String,
    auth_mode: Option<String>,
    wire_api: Option<String>,
    model: Option<String>,
    provider_name: Option<String>,
    image_api_key: Option<String>,
    image_base_url: Option<String>,
) -> Result<CodexProfile, String> {
    let mut data = read_codex_profiles(&app);
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
    p.base_url = resolve_base_url_or_default(&base_url, DEFAULT_OPENAI_BASE_URL);
    if let Some(mode) = auth_mode {
        if !mode.trim().is_empty() {
            p.auth_mode = mode.trim().to_string();
        }
    }
    if let Some(wire) = wire_api {
        p.wire_api = normalize_codex_wire_api(&wire);
    }
    p.model = model.unwrap_or_default().trim().to_string();
    p.provider_name = provider_name.unwrap_or_default().trim().to_string();
    p.image_api_key = image_api_key.unwrap_or_default().trim().to_string();
    p.image_base_url = image_base_url
        .unwrap_or_default()
        .trim()
        .trim_end_matches('/')
        .to_string();
    let updated = p.clone();
    write_codex_profiles(&app, &data)?;
    Ok(updated)
}

#[tauri::command]
pub(crate) fn delete_codex_profile(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let mut data = read_codex_profiles(&app);
    data.profiles.retain(|x| x.id != id);
    write_codex_profiles(&app, &data)
}

#[tauri::command]
pub(crate) fn switch_codex_profile(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let mut data = read_codex_profiles(&app);
    let profile = data
        .profiles
        .iter()
        .find(|x| x.id == id)
        .ok_or("配置未找到")?
        .clone();
    ensure_secret_usable(&profile.api_key, &format!("Codex 配置「{}」", profile.name))?;

    // 切换前自动备份当前配置
    auto_backup_configs(&app);

    write_codex_config(&profile)?;
    configure_codex_image_skill(&profile)?;

    for p in data.profiles.iter_mut() {
        p.is_active = p.id == profile.id;
    }
    write_codex_profiles(&app, &data)?;
    Ok(())
}

pub(crate) fn build_imported_codex_profile(
    name: String,
    status: LocationStatus,
    auth_mode: String,
) -> CodexProfile {
    CodexProfile {
        id: uuid::Uuid::new_v4().to_string(),
        name: if name.is_empty() {
            "导入的 Codex 配置".into()
        } else {
            name
        },
        api_key: status.api_key,
        base_url: status.base_url,
        auth_mode,
        wire_api: default_codex_wire_api(),
        model: String::new(),
        provider_name: String::new(),
        image_api_key: status.image_api_key,
        image_base_url: status.image_base_url,
        is_active: true,
        created_at: chrono_now(),
    }
}

#[tauri::command]
pub(crate) fn import_codex_current(app: tauri::AppHandle, name: String) -> Result<CodexProfile, String> {
    let status = read_codex_status().ok_or("未检测到当前 Codex 配置")?;
    if status.api_key.is_empty() {
        return Err("未检测到当前 Codex 配置".into());
    }
    let config_str = fs::read_to_string(codex_config_path()).unwrap_or_default();
    let auth_mode = if config_str
        .lines()
        .any(|l| l.trim().starts_with("experimental_bearer_token"))
    {
        "official_account_api_quota".to_string()
    } else {
        default_codex_auth_mode()
    };

    let mut data = read_codex_profiles(&app);
    if data
        .profiles
        .iter()
        .any(|x| x.api_key == status.api_key && x.base_url == status.base_url)
    {
        return Err("该配置已存在".into());
    }

    let profile = build_imported_codex_profile(name, status, auth_mode);

    configure_codex_image_skill(&profile)?;

    for p in data.profiles.iter_mut() {
        p.is_active = false;
    }
    data.profiles.push(profile.clone());
    write_codex_profiles(&app, &data)?;
    Ok(profile)
}

/// 只改动账号登录相关配置，保留模型、MCP、项目设置等原有内容。
pub(crate) fn codex_account_login_config(existing: &str) -> Result<String, String> {
    const LEGACY_COMMENT: &str = "# 兼容旧聊天，不改变新聊天默认提供商";
    let newline = if existing.contains("\r\n") { "\r\n" } else { "\n" };
    let mut section = Vec::<String>::new();
    let mut multiline_quote = None;
    let mut skip_multiline_value = false;
    let mut preserved = Vec::new();
    for line in existing.lines() {
        let in_string = multiline_quote.is_some();
        update_codex_toml_multiline_quote(line, &mut multiline_quote);
        if skip_multiline_value {
            skip_multiline_value = multiline_quote.is_some();
            continue;
        }
        if !in_string {
            if let Some(path) = parse_toml_header_path(line) {
                section = path;
            }
        }
        if section.len() >= 2 && section[0] == "model_providers" && section[1] == "custom" {
            continue;
        }
        if !in_string {
            if line.trim() == LEGACY_COMMENT {
                continue;
            }
            if let Some((raw_key, raw_value)) = line.split_once('=') {
                if let Some(path) = parse_toml_header_path(&format!("[{}]", raw_key.trim())) {
                    if section.is_empty() && path.len() == 1
                        && matches!(path[0].as_str(), "model_provider" | "forced_login_method" | "chatgpt_base_url" | "preferred_auth_method")
                    {
                        skip_multiline_value = multiline_quote.is_some();
                        continue;
                    }
                    let mut full_path = section.clone();
                    full_path.extend(path);
                    if full_path == ["model_providers"] {
                        return Err("当前 model_providers 使用内联父表，无法安全转换；请先改为 [model_providers.<名称>] 表格式，原配置未修改".into());
                    }
                    if full_path.len() >= 2 && full_path[0] == "model_providers" && full_path[1] == "custom" {
                        if raw_value.trim_start().starts_with('{') && parse_toml_section_body(line).is_empty() {
                            return Err("当前 custom 使用跨行内联表，无法安全转换；请先改为 [model_providers.custom] 表格式，原配置未修改".into());
                        }
                        skip_multiline_value = multiline_quote.is_some();
                        continue;
                    }
                }
            }
        }
        preserved.push(line);
    }
    let body = preserved.join("\n");
    let mut output = String::from("model_provider = \"openai\"\nforced_login_method = \"chatgpt\"\n");
    if !body.trim().is_empty() {
        output.push_str(body.trim_matches('\n'));
        output.push('\n');
    }
    output.push_str(&format!("\n{LEGACY_COMMENT}\n[model_providers.custom]\nname = \"OpenAI (legacy custom)\"\nbase_url = \"https://chatgpt.com/backend-api/codex\"\nwire_api = \"responses\"\nrequires_openai_auth = true\n"));
    Ok(output.replace('\n', newline))
}

// 表头与键名可能出现在多行说明文字内，不能把字符串内容当作配置修改。
fn update_codex_toml_multiline_quote(line: &str, multiline: &mut Option<u8>) {
    let bytes = line.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if let Some(quote) = *multiline {
            if quote == b'"' && bytes[index] == b'\\' {
                index += 2;
            } else if bytes[index..].starts_with(&[quote; 3]) {
                *multiline = None;
                index += 3;
            } else {
                index += 1;
            }
        } else if bytes[index] == b'#' {
            break;
        } else if matches!(bytes[index], b'"' | b'\'') {
            let quote = bytes[index];
            if bytes[index..].starts_with(&[quote; 3]) {
                *multiline = Some(quote);
                index += 3;
            } else {
                index += 1;
                while index < bytes.len() {
                    if quote == b'"' && bytes[index] == b'\\' {
                        index += 2;
                    } else if bytes[index] == quote {
                        index += 1;
                        break;
                    } else {
                        index += 1;
                    }
                }
            }
        } else {
            index += 1;
        }
    }
}

#[tauri::command]
pub(crate) fn switch_codex_to_account_login(app: tauri::AppHandle) -> Result<(), String> {
    let path = codex_config_path();
    let existing = match fs::read_to_string(&path) {
        Ok(config) => Some(config),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("读取 codex config.toml 失败: {error}")),
    };
    let updated = codex_account_login_config(existing.as_deref().unwrap_or_default())?;
    let backup = backup_codex_runtime_files(&app);
    if existing.is_some() && backup.config_backup.is_none() {
        return Err("备份 codex config.toml 失败，未切换登录方式".into());
    }
    let mut profiles = read_codex_profiles(&app);
    for profile in &mut profiles.profiles {
        profile.is_active = false;
    }
    fs::create_dir_all(codex_config_dir()).map_err(|e| format!("创建 ~/.codex 目录失败: {e}"))?;
    write_file_atomic(&path, &updated).map_err(|e| format!("写入 codex config.toml 失败: {e}"))?;
    if let Err(error) = write_codex_profiles(&app, &profiles) {
        let rollback = match existing {
            Some(config) => write_file_atomic(&path, &config),
            None => fs::remove_file(&path).map_err(|error| error.to_string()),
        };
        return match rollback {
            Ok(()) => Err(format!("保存 Codex 档案状态失败，已还原配置: {error}")),
            Err(rollback_error) => Err(format!("保存 Codex 档案状态失败: {error}；还原配置失败: {rollback_error}")),
        };
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexRuntimeStatus {
    #[serde(flatten)]
    runtime: LocationStatus,
    account_login: bool,
}

#[tauri::command]
pub(crate) fn get_codex_status() -> Option<CodexRuntimeStatus> {
    let config = fs::read_to_string(codex_config_path()).unwrap_or_default();
    read_codex_status().map(|runtime| CodexRuntimeStatus {
        runtime,
        account_login: toml_line_value(&config, "model_provider") == "openai"
            && toml_line_value(&config, "forced_login_method") == "chatgpt",
    })
}

#[cfg(test)]
mod account_login_tests {
    use super::*;

    #[test]
    fn codex_account_login_replaces_api_settings_and_preserves_other_config() {
        let existing = r#"model_provider = "custom"
forced_login_method = "api"
preferred_auth_method = "apikey"
chatgpt_base_url = "http://127.0.0.1:3847/backend-api"
model = "gpt-5.5"
approval_policy = "on-request"

[model_providers."custom"] # old API provider
base_url = "https://api.example.test/v1"
env_key = "OLD_KEY"
experimental_bearer_token = "old-token"
[model_providers.custom.http_headers]
Authorization = "old-token"

[model_providers.other]
base_url = "https://other.example.test/v1"
[mcp_servers.demo]
command = "node"
[projects.'H:/demo']
trust_level = "trusted"
"#;
        let output = codex_account_login_config(existing).unwrap();
        assert!(output.starts_with("model_provider = \"openai\"\nforced_login_method = \"chatgpt\"\n"));
        assert!(!output.contains("chatgpt_base_url"));
        assert!(!output.contains("preferred_auth_method"));
        assert!(!output.contains("old-token"));
        assert!(!output.contains("OLD_KEY"));
        assert!(output.contains("model = \"gpt-5.5\""));
        assert!(output.contains("approval_policy = \"on-request\""));
        assert!(output.contains("[mcp_servers.demo]\ncommand = \"node\""));
        assert!(output.contains("[projects.'H:/demo']\ntrust_level = \"trusted\""));
        assert!(output.contains("[model_providers.other]\nbase_url = \"https://other.example.test/v1\""));
        assert!(output.contains("# 兼容旧聊天，不改变新聊天默认提供商\n[model_providers.custom]\nname = \"OpenAI (legacy custom)\"\nbase_url = \"https://chatgpt.com/backend-api/codex\"\nwire_api = \"responses\"\nrequires_openai_auth = true"));
        assert_eq!(codex_account_login_config(&output).unwrap(), output);
    }

    #[test]
    fn codex_account_login_preserves_multiline_strings_and_windows_line_endings() {
        let existing = "model_provider = 'custom'\r\nmodel_instructions = '''\r\n[model_providers.custom]\r\nmodel_provider = 'example'\r\n'''\r\n[mcp_servers.demo]\r\ncommand = 'node'\r\n";
        let output = codex_account_login_config(existing).unwrap();
        assert!(output.contains("model_instructions = '''\r\n[model_providers.custom]\r\nmodel_provider = 'example'\r\n'''"));
        assert!(!output.replace("\r\n", "").contains('\n'));
        assert_eq!(codex_account_login_config(&output).unwrap(), output);
    }

    #[test]
    fn codex_account_login_handles_empty_config_and_switching_back_to_api() {
        let account = codex_account_login_config("").unwrap();
        assert_eq!(toml_line_value(&account, "model_provider"), "openai");
        assert_eq!(toml_line_value(&account, "forced_login_method"), "chatgpt");
        let api = codex_config_toml_content("custom", "gpt-5.5", "https://api.example.test/v1", "test-key", false);
        let restored = merge_codex_config_with_preserved_sections(&api, &account);
        assert!(!restored.contains("forced_login_method"));
        assert_eq!(toml_line_value(&restored, "model_provider"), "custom");
    }

    #[test]
    fn codex_account_login_replaces_quoted_root_and_dotted_provider_keys() {
        let existing = r#"'model_provider' = 'custom'
'forced_login_method' = 'api'
"chatgpt_base_url" = "http://127.0.0.1:3847/backend-api"
"model_providers"."custom" = { base_url = "https://api.example.test/v1" }
"#;
        let output = codex_account_login_config(existing).unwrap();
        assert!(!output.contains("'model_provider'"));
        assert!(!output.contains("'forced_login_method'"));
        assert!(!output.contains("chatgpt_base_url"));
        assert!(!output.contains("https://api.example.test/v1"));
    }

    #[test]
    fn codex_account_login_rejects_inline_parent_tables_before_writing() {
        let existing = "model_providers = { custom = { base_url = 'https://api.example.test/v1' }, other = { name = 'Keep' } }";
        let error = codex_account_login_config(existing).unwrap_err();
        assert!(error.contains("内联父表"));
        assert!(error.contains("原配置未修改"));
        let multiline_inline = "model_providers.custom = {\nbase_url = 'https://api.example.test/v1'\n}\n";
        assert!(codex_account_login_config(multiline_inline).is_err());
    }

    #[test]
    fn codex_account_login_removes_complete_multiline_auth_values() {
        let existing = "model_provider = '''\ncustom'''\nforced_login_method = '''api'''\nmodel = 'gpt-5.5'\n";
        let output = codex_account_login_config(existing).unwrap();
        assert!(!output.contains("'''"));
        assert!(output.contains("model = 'gpt-5.5'"));
    }
}
