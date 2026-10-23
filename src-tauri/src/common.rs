//! 跨域基础设施：路径与数据目录、原子写入、日志、时间、系统环境变量、HTTP / 下载辅助与共享状态类型（从 lib.rs 拆分，逻辑未改动）。

use crate::*;

// Windows 常量：CREATE_NO_WINDOW 标志，用于隐藏子进程窗口
#[cfg(target_os = "windows")]
pub(crate) const CREATE_NO_WINDOW: u32 = 0x08000000;

pub(crate) const ENDPOINT_TEST_DEFAULT_TIMEOUT_SECS: u64 = 8;
pub(crate) const ENDPOINT_TEST_MIN_TIMEOUT_SECS: u64 = 2;
pub(crate) const ENDPOINT_TEST_MAX_TIMEOUT_SECS: u64 = 30;

// ── Data Structures ─────────────────────────────────


/// 各应用官方 API 默认地址：Base URL 留空时回退到官方端点（与 cc-switch 行为一致）。
pub(crate) const DEFAULT_ANTHROPIC_BASE_URL: &str = "https://api.anthropic.com";
pub(crate) const DEFAULT_OPENAI_BASE_URL: &str = "https://api.openai.com/v1";
pub(crate) const DEFAULT_GEMINI_BASE_URL: &str = "https://generativelanguage.googleapis.com";

/// trim 后为空则使用默认地址，否则去掉尾部斜杠。
pub(crate) fn resolve_base_url_or_default(raw: &str, default_url: &str) -> String {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        default_url.to_string()
    } else {
        trimmed.to_string()
    }
}


#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocationStatus {
    pub(crate) api_key: String,
    pub(crate) base_url: String,
    pub(crate) model: String,
    pub(crate) image_api_key: String,
    pub(crate) image_base_url: String,
    pub(crate) image_skill_installed: bool,
}


#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EndpointLatency {
    pub(crate) url: String,
    pub(crate) latency: Option<u128>,
    pub(crate) status: Option<u16>,
    pub(crate) error: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AvailableModel {
    pub(crate) id: String,
}


#[derive(Serialize, Clone)]
pub(crate) struct ProgressEvent {
    pub(crate) step: u32,
    pub(crate) total: u32,
    pub(crate) label: String,
}

pub(crate) struct AppState {
    pub(crate) cancel_flag: AtomicBool,
}

// ── Helpers ─────────────────────────────────────────

// ── 数据目录重定向（多设备同步）──────────────────────
// 指针文件方案：默认数据目录下的 data_dir_override.txt 内容为自定义目录的绝对路径。
// 用户可把数据目录指到 OneDrive / Dropbox / 坚果云 / NAS 等网盘同步文件夹，
// 多台设备共享 profiles、prompt_presets 等 json 配置，实现轻量云同步。

/// 指针文件名，永远存放在「默认」数据目录下（重定向目标目录里不会再放一份）
pub(crate) const DATA_DIR_POINTER_FILE: &str = "data_dir_override.txt";

/// 数据目录重定向缓存。
/// 外层 OnceLock 保证指针文件只在进程内首次访问时读一次磁盘；
/// 内层 Mutex<Option<PathBuf>> 支持 set_data_dir_override 运行期更新。
/// data_dir 被全项目高频调用，缓存命中后只有一次锁开销、零磁盘 IO。
pub(crate) static DATA_DIR_OVERRIDE: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

/// 默认数据目录（不做指针重定向解析）。
/// app_data_dir 理论上不会失败，但若系统异常返回错误，
/// 退回到 用户主目录/.varswitch，避免直接 panic 崩溃整个应用。
pub(crate) fn default_data_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap_or_else(|_| {
        let fallback = home_dir().join(".varswitch");
        eprintln!("[data_dir] app_data_dir 不可用，退回到 {fallback:?}");
        fallback
    })
}

/// 惰性初始化重定向缓存：首次调用读取指针文件，此后只读内存。
pub(crate) fn data_dir_override_cell(app: &tauri::AppHandle) -> &'static Mutex<Option<PathBuf>> {
    DATA_DIR_OVERRIDE.get_or_init(|| {
        let pointer = default_data_dir(app).join(DATA_DIR_POINTER_FILE);
        let target = fs::read_to_string(&pointer)
            .ok()
            .map(|raw| raw.trim().to_string())
            .filter(|raw| !raw.is_empty())
            .map(PathBuf::from)
            // 指针失效（网盘未挂载 / 目录被删 / 相对路径）时静默回落默认目录，
            // 宁可暂时读到旧数据也不能让应用启动失败
            .filter(|path| {
                let usable = path.is_absolute() && path.is_dir();
                if !usable {
                    eprintln!("[data_dir] 指针文件指向的目录不可用，回落默认目录：{path:?}");
                }
                usable
            });
        Mutex::new(target)
    })
}

pub(crate) fn data_dir(app: &tauri::AppHandle) -> PathBuf {
    let overridden = data_dir_override_cell(app)
        .lock()
        .ok()
        .and_then(|guard| guard.clone());
    let dir = overridden.unwrap_or_else(|| default_data_dir(app));
    fs::create_dir_all(&dir).ok();
    dir
}

/// 判断两个目录是否指向同一位置（canonicalize 失败时退化为原样比较）
pub(crate) fn same_directory(a: &Path, b: &Path) -> bool {
    let ca = fs::canonicalize(a).unwrap_or_else(|_| a.to_path_buf());
    let cb = fs::canonicalize(b).unwrap_or_else(|_| b.to_path_buf());
    ca == cb
}

/// 递归复制目录（目标已存在同名文件时跳过，绝不覆盖）。
/// prefix 用于生成展示用相对路径，copied / skipped 收集结果供前端展示摘要。
pub(crate) fn copy_dir_no_overwrite(
    source: &Path,
    target: &Path,
    prefix: &str,
    copied: &mut Vec<String>,
    skipped: &mut Vec<String>,
) -> Result<(), String> {
    if !source.is_dir() {
        return Ok(());
    }
    fs::create_dir_all(target).map_err(|e| format!("创建目录 {prefix} 失败：{e}"))?;
    let entries = fs::read_dir(source).map_err(|e| format!("读取目录 {prefix} 失败：{e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()).map(String::from) else {
            continue;
        };
        let rel = format!("{prefix}/{name}");
        if path.is_dir() {
            copy_dir_no_overwrite(&path, &target.join(&name), &rel, copied, skipped)?;
        } else {
            let dest = target.join(&name);
            if dest.exists() {
                skipped.push(rel);
            } else {
                fs::copy(&path, &dest).map_err(|e| format!("复制 {rel} 失败：{e}"))?;
                copied.push(rel);
            }
        }
    }
    Ok(())
}

/// 把数据目录中的 *.json 与 backups 子目录复制到目标目录。
/// 只在目标不存在同名文件时复制——目标目录可能已有另一台设备同步来的更新数据，绝不覆盖。
pub(crate) fn copy_data_dir_payload(
    source: &Path,
    target: &Path,
    copied: &mut Vec<String>,
    skipped: &mut Vec<String>,
) -> Result<(), String> {
    let entries = fs::read_dir(source).map_err(|e| format!("读取当前数据目录失败：{e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !name.to_ascii_lowercase().ends_with(".json") {
            continue;
        }
        let dest = target.join(name);
        if dest.exists() {
            skipped.push(name.to_string());
        } else {
            fs::copy(&path, &dest).map_err(|e| format!("复制 {name} 失败：{e}"))?;
            copied.push(name.to_string());
        }
    }
    // 自动备份快照也带过去，换目录后依然可以回滚
    copy_dir_no_overwrite(
        &source.join("backups"),
        &target.join("backups"),
        "backups",
        copied,
        skipped,
    )?;
    Ok(())
}


// ── 日志模块 ─────────────────────────────────────────
// 统一日志：同时输出到控制台和文件 app_data_dir/logs/varswitch.log。
// 打包后 stdout/stderr 用户看不到，日志文件方便用户截图反馈或自行排查。

/// 全局日志文件路径，在 app 启动时 init_logging 设置一次。
pub(crate) static LOG_FILE_PATH: OnceLock<PathBuf> = OnceLock::new();
/// 日志文件滚动阈值：超过 5MB 转存为 .old。
pub(crate) const LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;

/// 在应用启动时初始化日志文件路径（setup 阶段调用一次）。
pub(crate) fn init_logging(app: &tauri::AppHandle) {
    let dir = data_dir(app).join("logs");
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join("varswitch.log");
    let _ = LOG_FILE_PATH.set(path);
    app_log("INFO", "VarSwitch 启动，日志系统已就绪");
}

/// 把 Unix 毫秒时间戳格式化为本地时间字符串（UTC+8，面向中国用户）。
pub(crate) fn format_log_time(millis: u128) -> String {
    let total_secs = (millis / 1000) as i64 + 8 * 3600; // 东八区偏移
    let ms = (millis % 1000) as u64;
    let days = total_secs.div_euclid(86400);
    let secs_of_day = total_secs.rem_euclid(86400);
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}.{ms:03}")
}

/// 把"从 1970-01-01 起的天数"转成 (年, 月, 日)。
/// 采用 Howard Hinnant 的 civil_from_days 算法，正确处理闰年。
pub(crate) fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as i64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 把 Unix 毫秒时间戳格式化为紧凑的本地时间字符串（用于备份文件名，无非法字符）。
/// 例如 "20260624-143025"（UTC+8）。
pub(crate) fn format_compact_time(millis: u128) -> String {
    let total_secs = (millis / 1000) as i64 + 8 * 3600;
    let secs_of_day = total_secs.rem_euclid(86400);
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;
    let (year, month, day) = civil_from_days(total_secs.div_euclid(86400));
    format!("{year:04}{month:02}{day:02}-{hour:02}{minute:02}{second:02}")
}

/// 写一条日志：同时输出到控制台（开发期可见）和日志文件（打包后可查）。
pub(crate) fn app_log(level: &str, msg: &str) {
    let msg = redact_log_message(msg);
    let line = format!(
        "[{}] [{level}] {msg}",
        format_log_time(chrono_timestamp_millis())
    );
    // 控制台输出（dev 模式可见）
    eprintln!("{line}");
    // 文件输出
    if let Some(path) = LOG_FILE_PATH.get() {
        // 简单滚动：超过阈值就把当前日志转存为 .old
        if let Ok(meta) = fs::metadata(path) {
            if meta.len() > LOG_MAX_BYTES {
                let old = path.with_file_name("varswitch.log.old");
                let _ = fs::rename(path, &old);
            }
        }
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = writeln!(file, "{line}");
        }
    }
}

/// 日志可能包含平台网关地址或错误原文。统一隐藏 URL 查询参数和常见凭据赋值，
/// 避免后续新增日志点时意外写入 token、secret 或临时授权票据。
pub(crate) fn redact_log_message(msg: &str) -> String {
    let mut output = String::with_capacity(msg.len());
    let mut remainder = msg;
    loop {
        let http = remainder.find("http://");
        let https = remainder.find("https://");
        let start = match (http, https) {
            (Some(a), Some(b)) => a.min(b),
            (Some(a), None) | (None, Some(a)) => a,
            (None, None) => {
                output.push_str(remainder);
                break;
            }
        };
        output.push_str(&remainder[..start]);
        let url_and_rest = &remainder[start..];
        let end = url_and_rest
            .find(char::is_whitespace)
            .unwrap_or(url_and_rest.len());
        let url = &url_and_rest[..end];
        if let Some(query_start) = url.find('?') {
            output.push_str(&url[..query_start]);
            output.push_str("?[query-redacted]");
        } else {
            output.push_str(url);
        }
        remainder = &url_and_rest[end..];
    }

    const SENSITIVE_MARKERS: [&str; 11] = [
        "access_key=",
        "ticket=",
        "token=",
        "secret=",
        "authorization=",
        "app_secret=",
        "bot_token=",
        "appsecret=",
        "bottoken=",
        "api_key=",
        "apikey=",
    ];
    for marker in SENSITIVE_MARKERS {
        let mut search_from = 0;
        loop {
            let lower = output[search_from..].to_ascii_lowercase();
            let Some(relative) = lower.find(marker) else {
                break;
            };
            let value_start = search_from + relative + marker.len();
            let value_end = output[value_start..]
                .find(|c: char| {
                    c.is_whitespace() || matches!(c, '&' | ',' | ';' | ']' | '}' | '"' | '\'')
                })
                .map(|offset| value_start + offset)
                .unwrap_or(output.len());
            output.replace_range(value_start..value_end, "***");
            search_from = value_start + 3;
        }
    }
    output
}

/// 原子写入文本文件：先在同目录写临时文件，再 rename 替换目标文件，
/// 避免进程崩溃 / 断电时把配置写坏（写一半或清空）。
/// Windows 的 std::fs::rename 会覆盖已存在的目标文件；Unix 下临时文件先设 0600，
/// rename 后权限随文件保留到目标。rename 失败时清理临时文件并返回错误。
pub(crate) fn write_file_atomic(path: &Path, contents: &str) -> Result<(), String> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("非法的文件路径: {}", path.display()))?;
    let tmp_path = path.with_file_name(format!("{file_name}.tmp-{}", uuid::Uuid::new_v4()));
    if let Err(e) = fs::write(&tmp_path, contents) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("写入临时文件失败: {e}"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(0o600));
    }
    fs::rename(&tmp_path, path).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        format!("原子替换文件失败: {e}")
    })
}

/// 以「仅所有者可读写」的权限写入含敏感信息（API Key / token 等）的文件。
/// Unix 下 0600 由 write_file_atomic 在临时文件上设置；Windows 依赖 AppData 默认 ACL（仅当前用户可访问）。
pub(crate) fn write_private_file(path: &Path, contents: &str) -> Result<(), String> {
    write_file_atomic(path, contents)
}


pub(crate) fn home_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    let primary = "USERPROFILE";
    #[cfg(not(target_os = "windows"))]
    let primary = "HOME";
    let home = std::env::var_os(primary).filter(|value| !value.is_empty()).unwrap_or_default();
    PathBuf::from(home)
}


pub(crate) fn read_json(path: &PathBuf) -> Result<serde_json::Value, String> {
    let s = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&s).map_err(|e| e.to_string())
}

/// 读取 JSON 文件，如果不存在则返回默认值
pub(crate) fn read_json_or_default(path: &PathBuf, default: serde_json::Value) -> serde_json::Value {
    read_json(path).unwrap_or(default)
}

/// 仅文件不存在时使用空对象；无效配置必须报错，避免切换时覆盖用户设置。
pub(crate) fn read_config_object(path: &Path, allow_jsonc: bool) -> Result<serde_json::Value, String> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(serde_json::json!({})),
        Err(e) => return Err(format!("读取配置 {} 失败: {e}", path.display())),
    };
    let parsed: serde_json::Value = serde_json::from_str(&raw)
        .or_else(|error| {
            if allow_jsonc { serde_json::from_str(&crate::opencode::sanitize_jsonc(&raw)) }
            else { Err(error) }
        })
        .map_err(|e| format!("解析配置 {} 失败，未覆盖原文件: {e}", path.display()))?;
    if !parsed.is_object() {
        return Err(format!("配置 {} 的根节点必须是 JSON 对象，未覆盖原文件", path.display()));
    }
    Ok(parsed)
}


pub(crate) fn write_json(path: &PathBuf, val: &serde_json::Value) -> Result<(), String> {
    // 自动创建父目录
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let s = serde_json::to_string_pretty(val).map_err(|e| e.to_string())?;
    write_file_atomic(path, &s)
}

// ── Registry-based env var operations (fast, no PowerShell) ──

#[cfg(target_os = "windows")]
pub(crate) fn env_reg_key() -> Result<RegKey, String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    hkcu.create_subkey("Environment")
        .map(|(key, _)| key)
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "windows")]
pub(crate) fn reg_set_env(name: &str, value: &str) -> Result<(), String> {
    let key = env_reg_key()?;
    key.set_value(name, &value).map_err(|e| e.to_string())
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn reg_set_env(name: &str, value: &str) -> Result<(), String> {
    crate::shell_env::set(name, Some(value))
}

#[cfg(target_os = "windows")]
pub(crate) fn reg_get_env_opt(name: &str) -> Option<String> {
    let key = env_reg_key().ok()?;
    key.get_value::<String, _>(name).ok()
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn reg_get_env_opt(name: &str) -> Option<String> {
    crate::shell_env::get(name)
}

pub(crate) fn reg_get_env(name: &str) -> String {
    reg_get_env_opt(name).unwrap_or_default()
}

#[cfg(target_os = "windows")]
pub(crate) fn reg_delete_env(name: &str) -> Result<(), String> {
    let key = env_reg_key()?;
    match key.delete_value(name) {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn reg_delete_env(name: &str) -> Result<(), String> {
    crate::shell_env::set(name, None)
}

/// Broadcast WM_SETTINGCHANGE so other apps pick up new env vars immediately
#[cfg(target_os = "windows")]
pub(crate) fn broadcast_env_change() {
    #[link(name = "user32")]
    extern "system" {
        fn SendMessageTimeoutW(
            hwnd: isize,
            msg: u32,
            wparam: usize,
            lparam: *const u16,
            flags: u32,
            timeout: u32,
            result: *mut usize,
        ) -> isize;
    }

    const HWND_BROADCAST: isize = 0xFFFF;
    const WM_SETTINGCHANGE: u32 = 0x001A;
    const SMTO_ABORTIFHUNG: u32 = 0x0002;
    const BROADCAST_TIMEOUT_MS: u32 = 400;

    let env: Vec<u16> = "Environment\0".encode_utf16().collect();
    let mut result: usize = 0;

    unsafe {
        SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            0,
            env.as_ptr(),
            SMTO_ABORTIFHUNG,
            BROADCAST_TIMEOUT_MS,
            &mut result,
        );
    }
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn broadcast_env_change() {}


pub(crate) fn emit_plugin_marketplace_progress(app: &tauri::AppHandle, step: u32, label: &str) {
    let _ = app.emit(
        "plugin-marketplace-progress",
        ProgressEvent {
            step,
            total: 6,
            label: label.to_string(),
        },
    );
}

pub(crate) fn sanitize_endpoint_timeout(timeout_secs: Option<u64>) -> u64 {
    timeout_secs
        .unwrap_or(ENDPOINT_TEST_DEFAULT_TIMEOUT_SECS)
        .clamp(
            ENDPOINT_TEST_MIN_TIMEOUT_SECS,
            ENDPOINT_TEST_MAX_TIMEOUT_SECS,
        )
}

pub(crate) fn normalize_endpoint_url(raw_url: &str) -> Result<String, String> {
    let trimmed = raw_url.trim().trim_end_matches('/').to_string();
    if trimmed.is_empty() {
        return Err("URL 不能为空".to_string());
    }

    let parsed = reqwest::Url::parse(&trimmed).map_err(|e| format!("URL 无效: {}", e))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("仅支持 http 或 https URL".to_string());
    }

    Ok(trimmed)
}

pub(crate) fn measure_endpoint_latency(
    client: reqwest::blocking::Client,
    url: String,
    timeout: Duration,
) -> EndpointLatency {
    let parsed = match reqwest::Url::parse(&url) {
        Ok(parsed) => parsed,
        Err(e) => {
            return EndpointLatency {
                url,
                latency: None,
                status: None,
                error: Some(format!("URL 无效: {}", e)),
            };
        }
    };

    let _ = client.get(parsed.clone()).timeout(timeout).send().ok();

    let start = Instant::now();
    match client.get(parsed).timeout(timeout).send() {
        Ok(resp) => EndpointLatency {
            url,
            latency: Some(start.elapsed().as_millis()),
            status: Some(resp.status().as_u16()),
            error: None,
        },
        Err(e) => EndpointLatency {
            url,
            latency: None,
            status: e.status().map(|status| status.as_u16()),
            error: Some(if e.is_timeout() {
                "请求超时".to_string()
            } else if e.is_connect() {
                "连接失败".to_string()
            } else {
                e.to_string()
            }),
        },
    }
}

pub(crate) fn models_endpoint_candidates(base_url: &str) -> Result<Vec<String>, String> {
    let normalized = normalize_endpoint_url(base_url)?;
    if normalized.ends_with("/models") {
        return Ok(vec![normalized]);
    }
    if normalized.ends_with("/v1") {
        return Ok(vec![format!("{normalized}/models")]);
    }
    Ok(vec![
        format!("{normalized}/v1/models"),
        format!("{normalized}/models"),
    ])
}

pub(crate) fn extract_model_ids(value: &serde_json::Value) -> Vec<String> {
    let data = value
        .get("data")
        .and_then(|data| data.as_array())
        .or_else(|| value.get("models").and_then(|models| models.as_array()));

    let mut ids = Vec::new();
    let mut seen = HashSet::new();
    if let Some(items) = data {
        for item in items {
            let id = item
                .as_str()
                .or_else(|| item.get("id").and_then(|id| id.as_str()))
                .or_else(|| item.get("name").and_then(|name| name.as_str()))
                .unwrap_or("")
                .trim();
            if !id.is_empty() && seen.insert(id.to_string()) {
                ids.push(id.to_string());
            }
        }
    }
    ids.sort();
    ids
}


/// 构建支持系统代理的 HTTP 客户端
pub(crate) fn resolve_proxy_url_from_values(values: &[Option<&str>]) -> Option<String> {
    for value in values {
        let candidate = match value {
            Some(raw) => raw.trim(),
            None => continue,
        };

        if candidate.is_empty() {
            continue;
        }

        let parsed = match reqwest::Url::parse(candidate) {
            Ok(url) => url,
            Err(_) => continue,
        };

        let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
        let port = parsed.port_or_known_default().unwrap_or(0);
        let is_loopback = matches!(host.as_str(), "127.0.0.1" | "localhost" | "::1");
        let is_disabled_proxy = is_loopback && matches!(port, 0 | 9);

        if is_disabled_proxy {
            continue;
        }

        return Some(candidate.to_string());
    }

    None
}

pub(crate) fn resolve_proxy_url_from_env() -> Option<String> {
    let https_upper = std::env::var("HTTPS_PROXY").ok();
    let https_lower = std::env::var("https_proxy").ok();
    let http_upper = std::env::var("HTTP_PROXY").ok();
    let http_lower = std::env::var("http_proxy").ok();

    resolve_proxy_url_from_values(&[
        https_upper.as_deref(),
        https_lower.as_deref(),
        http_upper.as_deref(),
        http_lower.as_deref(),
    ])
}

pub(crate) fn build_http_client(timeout_secs: u64) -> Result<reqwest::blocking::Client, String> {
    let mut builder = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .user_agent("VarSwitch/1.0");

    if let Some(proxy_url) = resolve_proxy_url_from_env() {
        if let Ok(proxy) = reqwest::Proxy::all(&proxy_url) {
            builder = builder.proxy(proxy);
        }
    }

    builder
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))
}


pub(crate) fn open_with_system(target: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // 用 rundll32 url.dll,FileProtocolHandler 打开目标：内部直接调用 ShellExecute，
        // 不经过 cmd/start 的 shell 解析（避免 & 截断与元字符注入），也不用 explorer.exe
        // （explorer 对带查询串/百分号编码的 URL 经常解析失败，退化成打开“文档”文件夹，
        // 表现为点“创建飞书机器人”时莫名弹出资源管理器窗口，授权页面根本没打开）。
        // FileProtocolHandler 是 ANSI 入口，这里把空格、控制字符与非 ASCII 字节按
        // RFC3986 百分号编码后再传入；已编码的 URL 不受影响（% 本身原样保留）。
        let mut encoded = String::with_capacity(target.len());
        for byte in target.as_bytes() {
            match *byte {
                0x21..=0x7E => encoded.push(*byte as char),
                _ => encoded.push_str(&format!("%{byte:02X}")),
            }
        }
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        let mut cmd = std::process::Command::new(format!("{system_root}\\System32\\rundll32.exe"));
        cmd.arg("url.dll,FileProtocolHandler");
        cmd.arg(&encoded);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.spawn().map_err(|e| e.to_string())?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        #[cfg(target_os = "macos")]
        let cmd = "open";
        #[cfg(not(target_os = "macos"))]
        let cmd = "xdg-open";

        std::process::Command::new(cmd)
            .arg(target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

pub(crate) fn open_installer_file(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("安装包不存在: {}", path.to_string_lossy()));
    }

    #[cfg(target_os = "windows")]
    {
        let path_str = path.to_string_lossy().to_string();
        let escaped = path_str.replace('\'', "''");
        let script = format!(
            "Unblock-File -LiteralPath '{}' -ErrorAction SilentlyContinue; Start-Process -FilePath '{}' -Verb Open -WorkingDirectory '{}'",
            escaped,
            escaped,
            path.parent()
                .map(|dir| dir.to_string_lossy().replace('\'', "''"))
                .unwrap_or_default()
        );
        let mut powershell = std::process::Command::new("powershell");
        powershell.args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ]);
        powershell.creation_flags(CREATE_NO_WINDOW);
        match powershell.status() {
            Ok(status) if status.success() => return Ok(()),
            Ok(status) => {
                log_error!(
                    "[update] PowerShell Start-Process failed with status: {:?}",
                    status.code()
                );
            }
            Err(error) => {
                log_error!("[update] PowerShell Start-Process failed: {}", error);
            }
        }

        let mut cmd = std::process::Command::new("cmd");
        cmd.args(["/C", "start", "", &path_str]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        match cmd.spawn() {
            Ok(_) => Ok(()),
            Err(error) => {
                let folder = path
                    .parent()
                    .map(|dir| dir.to_string_lossy().to_string())
                    .unwrap_or_else(|| path_str.clone());
                let _ = open_folder(folder);
                Err(format!(
                    "安装包已下载，但启动安装程序失败：{error}。已打开安装包所在文件夹。"
                ))
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        open_with_system(&path.to_string_lossy())
    }
}

pub(crate) fn chrono_now() -> String {
    let d = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}", d.as_millis())
}

pub(crate) fn chrono_timestamp_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}
