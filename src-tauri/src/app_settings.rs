//! 应用设置域：AppSettings 读写、编辑器路径、数据目录命令、更新检查与配置导入导出（从 lib.rs 拆分，逻辑未改动）。

use crate::*;

pub(crate) const APP_DOWNLOAD_PAGE_URL: &str = "https://download.varswitch.strova.top/";

// ── 应用设置数据结构 ──

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct AppSettings {
    /// 语言: "zh" | "en"
    pub(crate) language: String,
    /// 主题: "light" | "dark"
    pub(crate) theme: String,
    /// 开机自启
    pub(crate) auto_start: bool,
    /// 静默启动（启动时最小化到托盘）
    pub(crate) silent_startup: bool,
    /// 关闭窗口时最小化到托盘
    pub(crate) minimize_to_tray: bool,
    pub(crate) never_show_usage_guide: bool,
    /// 全局快捷键（如 "Ctrl+Alt+V"），空字符串表示禁用。
    /// 默认禁用：全局热键会抢占其他程序的组合键，必须由用户主动开启。
    pub(crate) global_shortcut: String,
    pub(crate) editor_paths: HashMap<String, String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            language: "zh".into(),
            theme: "light".into(),
            auto_start: false,
            silent_startup: false,
            minimize_to_tray: true,
            never_show_usage_guide: false,
            global_shortcut: String::new(),
            editor_paths: HashMap::new(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateCheckResult {
    pub(crate) current_version: String,
    pub(crate) latest_version: String,
    pub(crate) has_update: bool,
    pub(crate) release_url: String,
    pub(crate) release_notes: String,
    pub(crate) published_at: String,
    pub(crate) asset_name: Option<String>,
    pub(crate) can_auto_update: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateDownloadResult {
    pub(crate) latest_version: String,
    pub(crate) file_name: String,
    pub(crate) file_path: String,
    pub(crate) release_url: String,
}

#[derive(Clone, Debug)]
pub(crate) struct DownloadPageRelease {
    pub(crate) version: String,
    pub(crate) file_name: String,
    pub(crate) download_url: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EditorPathInfo {
    pub(crate) id: String,
    pub(crate) display_name: String,
    pub(crate) settings_path: String,
    pub(crate) default_path: String,
    pub(crate) customized: bool,
    pub(crate) detected: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppPaths {
    pub(crate) config_dir: String,
    pub(crate) profiles_path: String,
    pub(crate) claude_settings: String,
    pub(crate) codex_settings: String,
    /// 动态编辑器路径: key = 编辑器 id, value = settings.json 路径
    pub(crate) editor_settings: Vec<EditorPathInfo>,
    pub(crate) claude_md: String,
    pub(crate) claude_mcp: String,
}

/// 返回数据目录信息：当前生效目录、默认目录、是否处于自定义重定向状态
#[tauri::command]
pub(crate) fn get_data_dir_info(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let default_dir = default_data_dir(&app);
    let current = data_dir(&app);
    let overridden = data_dir_override_cell(&app)
        .lock()
        .map(|guard| guard.is_some())
        .unwrap_or(false);
    Ok(serde_json::json!({
        "current": current.to_string_lossy(),
        "default": default_dir.to_string_lossy(),
        "overridden": overridden,
    }))
}

/// 弹系统文件夹选择框让用户挑选数据目录。
/// 必须是 async 命令：blocking_pick_folder 不能在主线程调用（会与事件循环死锁），
/// async 命令由 tauri 调度到异步运行时线程执行。
#[tauri::command]
pub(crate) async fn pick_data_dir(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app.dialog().file().blocking_pick_folder();
    Ok(picked
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string()))
}

/// 设置 / 清除数据目录重定向。
/// path = None：恢复默认（删指针文件）；
/// path = Some(p)：校验可写 → 把当前数据目录的 *.json 与 backups 复制过去
/// （目标已有同名文件一律跳过）→ 原子写指针文件 → 更新内存缓存。
/// 返回 { copied, skipped, needsRestart }，部分模块（日志路径、代理状态）需重启才能完全生效。
#[tauri::command]
pub(crate) fn set_data_dir_override(
    app: tauri::AppHandle,
    path: Option<String>,
) -> Result<serde_json::Value, String> {
    let default_dir = default_data_dir(&app);
    let pointer = default_dir.join(DATA_DIR_POINTER_FILE);

    // 恢复默认：删除指针文件并清空内存缓存
    let Some(raw) = path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty()) else {
        if pointer.exists() {
            fs::remove_file(&pointer).map_err(|e| format!("删除指针文件失败：{e}"))?;
        }
        if let Ok(mut guard) = data_dir_override_cell(&app).lock() {
            *guard = None;
        }
        // 此处位于日志宏定义之前，直接调用 app_log（函数不受源码顺序限制）
        app_log(
            "INFO",
            &format!("[data-dir] 已恢复默认数据目录：{}", default_dir.display()),
        );
        return Ok(serde_json::json!({
            "copied": [],
            "skipped": [],
            "needsRestart": true,
        }));
    };

    let target = PathBuf::from(&raw);
    if !target.is_absolute() {
        return Err("数据目录必须是绝对路径".into());
    }
    fs::create_dir_all(&target).map_err(|e| format!("目标目录不可用：{e}"))?;

    // 试写临时文件确认可写（网盘目录常见只读 / 未挂载问题）
    let probe = target.join(format!(".varswitch-write-test-{}", std::process::id()));
    fs::write(&probe, b"varswitch").map_err(|e| format!("目标目录不可写：{e}"))?;
    let _ = fs::remove_file(&probe);

    // 复制要在更新缓存之前做：此时 data_dir 仍解析到旧目录
    let source = data_dir(&app);
    let mut copied: Vec<String> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    if !same_directory(&source, &target) {
        copy_data_dir_payload(&source, &target, &mut copied, &mut skipped)?;
    }

    if same_directory(&target, &default_dir) {
        // 选回默认目录等价于恢复默认，不留一个"指向自己"的指针文件
        if pointer.exists() {
            fs::remove_file(&pointer).map_err(|e| format!("删除指针文件失败：{e}"))?;
        }
        if let Ok(mut guard) = data_dir_override_cell(&app).lock() {
            *guard = None;
        }
        app_log("INFO", "[data-dir] 目标为默认目录，已清除重定向");
    } else {
        fs::create_dir_all(&default_dir).ok();
        write_file_atomic(&pointer, &target.to_string_lossy())?;
        if let Ok(mut guard) = data_dir_override_cell(&app).lock() {
            *guard = Some(target.clone());
        }
        app_log(
            "INFO",
            &format!(
                "[data-dir] 数据目录已重定向到 {}（复制 {} 项 / 跳过 {} 项）",
                target.display(),
                copied.len(),
                skipped.len()
            ),
        );
    }

    Ok(serde_json::json!({
        "copied": copied,
        "skipped": skipped,
        "needsRestart": true,
    }))
}

/// 编辑器信息
pub(crate) struct EditorDef {
    /// 唯一标识 (如 "vscode", "cursor")
    pub(crate) id: &'static str,
    /// 显示名称
    pub(crate) display_name: &'static str,
    /// Windows 下 %APPDATA% 内的子目录名
    #[cfg(target_os = "windows")]
    pub(crate) win_appdata_dir: &'static str,
    #[cfg(target_os = "windows")]
    pub(crate) win_program_dirs: &'static [&'static str],
    /// macOS 下 ~/Library/Application Support/ 内的子目录名
    #[cfg(target_os = "macos")]
    pub(crate) mac_app_support_dir: &'static str,
    /// Linux 下 ~/.config/ 内的子目录名
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    pub(crate) linux_config_dir: &'static str,
}

/// 所有支持的编辑器定义
#[cfg(target_os = "windows")]
pub(crate) const KNOWN_EDITORS: &[EditorDef] = &[
    EditorDef {
        id: "vscode",
        display_name: "VS Code",
        win_appdata_dir: "Code",
        win_program_dirs: &["Microsoft VS Code"],
    },
    EditorDef {
        id: "cursor",
        display_name: "Cursor",
        win_appdata_dir: "Cursor",
        win_program_dirs: &["Cursor"],
    },
];

#[cfg(target_os = "macos")]
pub(crate) const KNOWN_EDITORS: &[EditorDef] = &[
    EditorDef {
        id: "vscode",
        display_name: "VS Code",
        mac_app_support_dir: "Code",
    },
    EditorDef {
        id: "cursor",
        display_name: "Cursor",
        mac_app_support_dir: "Cursor",
    },
];

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub(crate) const KNOWN_EDITORS: &[EditorDef] = &[
    EditorDef {
        id: "vscode",
        display_name: "VS Code",
        linux_config_dir: "Code",
    },
    EditorDef {
        id: "cursor",
        display_name: "Cursor",
        linux_config_dir: "Cursor",
    },
];

/// 获取编辑器 settings.json 的路径
pub(crate) fn default_editor_settings_path(editor: &EditorDef) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var("APPDATA").unwrap_or_default();
        PathBuf::from(appdata)
            .join(editor.win_appdata_dir)
            .join("User")
            .join("settings.json")
    }
    #[cfg(target_os = "macos")]
    {
        home_dir()
            .join("Library")
            .join("Application Support")
            .join(editor.mac_app_support_dir)
            .join("User")
            .join("settings.json")
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        home_dir()
            .join(".config")
            .join(editor.linux_config_dir)
            .join("User")
            .join("settings.json")
    }
}

pub(crate) fn normalize_editor_path_value(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    let path = PathBuf::from(trimmed);
    let normalized = if path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("json"))
        .unwrap_or(false)
    {
        path
    } else {
        path.join("settings.json")
    };

    Some(normalized.to_string_lossy().to_string())
}

pub(crate) fn normalize_app_settings(mut settings: AppSettings) -> AppSettings {
    let mut normalized_paths = HashMap::new();
    for (editor_id, raw_path) in settings.editor_paths {
        if let Some(path) = normalize_editor_path_value(&raw_path) {
            normalized_paths.insert(editor_id, path);
        }
    }
    settings.editor_paths = normalized_paths;
    settings.global_shortcut = settings.global_shortcut.trim().to_string();
    settings
}

pub(crate) fn editor_override_path(settings: &AppSettings, editor_id: &str) -> Option<PathBuf> {
    settings
        .editor_paths
        .get(editor_id)
        .and_then(|raw| normalize_editor_path_value(raw))
        .map(PathBuf::from)
}

pub(crate) fn resolved_editor_settings_path(editor: &EditorDef, settings: &AppSettings) -> PathBuf {
    editor_override_path(settings, editor.id)
        .unwrap_or_else(|| default_editor_settings_path(editor))
}

pub(crate) fn editor_has_custom_path(settings: &AppSettings, editor_id: &str) -> bool {
    editor_override_path(settings, editor_id).is_some()
}

pub(crate) fn editor_install_markers(editor: &EditorDef) -> Vec<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let mut markers = Vec::new();
        let appdata = std::env::var("APPDATA").unwrap_or_default();
        if !appdata.is_empty() {
            markers.push(PathBuf::from(&appdata).join(editor.win_appdata_dir));
        }
        let local_appdata = std::env::var("LOCALAPPDATA").unwrap_or_default();
        if !local_appdata.is_empty() {
            for dir in editor.win_program_dirs {
                markers.push(PathBuf::from(&local_appdata).join("Programs").join(dir));
            }
        }
        markers
    }
    #[cfg(target_os = "macos")]
    {
        vec![home_dir()
            .join("Library")
            .join("Application Support")
            .join(editor.mac_app_support_dir)]
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        vec![home_dir().join(".config").join(editor.linux_config_dir)]
    }
}

pub(crate) fn editor_is_detected(editor: &EditorDef, settings: &AppSettings) -> bool {
    if editor_has_custom_path(settings, editor.id) {
        return true;
    }

    let default_path = default_editor_settings_path(editor);
    if default_path.exists() {
        return true;
    }

    if default_path
        .parent()
        .map(|parent| parent.exists())
        .unwrap_or(false)
    {
        return true;
    }

    editor_install_markers(editor)
        .into_iter()
        .any(|path| path.exists())
}

pub(crate) fn detect_installed_editors(settings: &AppSettings) -> Vec<&'static EditorDef> {
    KNOWN_EDITORS
        .iter()
        .filter(|editor| editor_is_detected(editor, settings))
        .collect()
}

pub(crate) fn collect_editor_path_infos(settings: &AppSettings) -> Vec<EditorPathInfo> {
    KNOWN_EDITORS
        .iter()
        .map(|editor| EditorPathInfo {
            id: editor.id.to_string(),
            display_name: editor.display_name.to_string(),
            settings_path: resolved_editor_settings_path(editor, settings)
                .to_string_lossy()
                .to_string(),
            default_path: default_editor_settings_path(editor)
                .to_string_lossy()
                .to_string(),
            customized: editor_has_custom_path(settings, editor.id),
            detected: editor_is_detected(editor, settings),
        })
        .collect()
}

/// 返回检测到的已安装编辑器列表 (id -> displayName)
#[tauri::command]
pub(crate) fn get_detected_editors(app: tauri::AppHandle) -> HashMap<String, String> {
    let settings = read_app_settings(&app);
    detect_installed_editors(&settings)
        .into_iter()
        .map(|ed| (ed.id.to_string(), ed.display_name.to_string()))
        .collect()
}

pub(crate) fn emit_update_download_progress(app: &tauri::AppHandle, step: u32, total: u32, label: &str) {
    let _ = app.emit(
        "update-download-progress",
        ProgressEvent {
            step,
            total,
            label: label.into(),
        },
    );
}

// ── Settings Helpers ─────────────────────────────────

pub(crate) fn settings_path(app: &tauri::AppHandle) -> PathBuf {
    data_dir(app).join("settings.json")
}

pub(crate) fn read_app_settings(app: &tauri::AppHandle) -> AppSettings {
    let path = settings_path(app);
    if !path.exists() {
        return AppSettings::default();
    }
    normalize_app_settings(
        fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default(),
    )
}

pub(crate) fn write_app_settings(app: &tauri::AppHandle, settings: &AppSettings) -> Result<(), String> {
    let path = settings_path(app);
    let normalized = normalize_app_settings(settings.clone());
    let json = serde_json::to_string_pretty(&normalized).map_err(|e| e.to_string())?;
    write_file_atomic(&path, &json)
}

/// Windows 开机自启：写入/删除注册表 Run 键
#[cfg(target_os = "windows")]
pub(crate) fn set_auto_start(enable: bool) -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let run_key = hkcu
        .open_subkey_with_flags(
            "Software\\Microsoft\\Windows\\CurrentVersion\\Run",
            winreg::enums::KEY_SET_VALUE,
        )
        .map_err(|e| e.to_string())?;

    const APP_NAME: &str = "VarSwitch";

    if enable {
        // 获取当前可执行文件路径
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let exe_str = exe.to_string_lossy().to_string();
        run_key
            .set_value(APP_NAME, &exe_str)
            .map_err(|e| e.to_string())
    } else {
        match run_key.delete_value(APP_NAME) {
            Ok(_) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// macOS 开机自启：通过 LaunchAgent plist 实现
#[cfg(target_os = "macos")]
pub(crate) fn set_auto_start(enable: bool) -> Result<(), String> {
    let home = std::env::var("HOME").map_err(|_| "无法获取 HOME 目录".to_string())?;
    let launch_agents_dir = PathBuf::from(&home).join("Library").join("LaunchAgents");
    let plist_path = launch_agents_dir.join("com.varswitch.app.plist");

    if enable {
        fs::create_dir_all(&launch_agents_dir).map_err(|e| e.to_string())?;
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let exe_str = exe.to_string_lossy();
        let plist_content = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.varswitch.app</string>
    <key>ProgramArguments</key>
    <array>
        <string>{}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>"#,
            exe_str
        );
        write_file_atomic(&plist_path, &plist_content)
    } else {
        match fs::remove_file(&plist_path) {
            Ok(_) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub(crate) fn set_auto_start(_enable: bool) -> Result<(), String> {
    Ok(())
}

// ── Settings Commands ────────────────────────────────

#[tauri::command]
pub(crate) fn get_app_settings(app: tauri::AppHandle) -> AppSettings {
    read_app_settings(&app)
}

#[tauri::command]
pub(crate) fn save_app_settings(app: tauri::AppHandle, settings: AppSettings) -> Result<(), String> {
    let settings = normalize_app_settings(settings);
    // 处理开机自启
    set_auto_start(settings.auto_start)?;
    // 全局快捷键先注册再落盘：解析/注册失败时直接报错，不把坏值写进设置
    crate::apply_global_shortcut(&app, &settings.global_shortcut)?;
    write_app_settings(&app, &settings)
}

#[tauri::command]
pub(crate) fn get_app_paths(app: tauri::AppHandle) -> AppPaths {
    let settings = read_app_settings(&app);
    AppPaths {
        config_dir: data_dir(&app).to_string_lossy().to_string(),
        profiles_path: profiles_path(&app).to_string_lossy().to_string(),
        claude_settings: claude_settings_path().to_string_lossy().to_string(),
        codex_settings: codex_config_path().to_string_lossy().to_string(),
        editor_settings: collect_editor_path_infos(&settings),
        claude_md: claude_md_path().to_string_lossy().to_string(),
        claude_mcp: claude_mcp_path().to_string_lossy().to_string(),
    }
}

#[tauri::command]
pub(crate) fn open_folder(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    // 如果是文件，打开其所在目录
    let dir = if p.is_file() || p.extension().is_some() {
        p.parent().unwrap_or(&p).to_path_buf()
    } else {
        p
    };
    #[cfg(target_os = "windows")]
    {
        let mut cmd = std::process::Command::new("explorer");
        cmd.arg(dir.to_string_lossy().to_string());
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
            .arg(dir.to_string_lossy().to_string())
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn open_external_target(target: String) -> Result<(), String> {
    let trimmed = target.trim();
    if trimmed.is_empty() {
        return Err("Target is required".into());
    }
    // 安全：该目标来自前端，最终会交给系统启动器。拒绝控制字符与引号，
    // 避免任何形式的参数/命令注入（合法的 URL 或自定义 scheme 不含这些字符）。
    if trimmed
        .chars()
        .any(|c| c == '"' || c == '\'' || c == '\0' || c.is_control())
    {
        return Err("目标包含非法字符".into());
    }
    open_with_system(trimmed)
}

/// 打开日志文件夹，方便用户查看/反馈日志。
#[tauri::command]
pub(crate) fn open_logs_folder(app: tauri::AppHandle) -> Result<(), String> {
    let dir = data_dir(&app).join("logs");
    fs::create_dir_all(&dir).map_err(|e| format!("创建日志目录失败: {e}"))?;
    open_folder(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub(crate) async fn check_app_update(app: tauri::AppHandle) -> Result<UpdateCheckResult, String> {
    let current_version = app.package_info().version.to_string();

    tauri::async_runtime::spawn_blocking(move || {
        let release = fetch_latest_download_page_release()?;
        let latest_version = release.version.clone();

        Ok(UpdateCheckResult {
            current_version: current_version.clone(),
            latest_version: latest_version.clone(),
            has_update: is_remote_version_newer(&latest_version, &current_version),
            release_url: APP_DOWNLOAD_PAGE_URL.into(),
            release_notes: String::new(),
            published_at: String::new(),
            asset_name: Some(release.file_name),
            can_auto_update: true,
        })
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
pub(crate) async fn install_app_update(app: tauri::AppHandle) -> Result<UpdateDownloadResult, String> {
    emit_update_download_progress(&app, 5, 100, "prepare");

    let update = app
        .updater()
        .map_err(|e| format!("初始化自动更新失败: {e}"))?
        .check()
        .await
        .map_err(|e| format!("检查自动更新失败: {e}"))?
        .ok_or_else(|| "当前已经是最新版本".to_string())?;

    let latest_version = update.version.clone();
    let file_name = update
        .download_url
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("VarSwitch-update")
        .to_string();
    let release_url = update.download_url.to_string();
    let app_for_progress = app.clone();
    let mut downloaded: u64 = 0;

    emit_update_download_progress(&app, 10, 100, "download");
    update
        .download_and_install(
            move |chunk_len, content_len| {
                downloaded = downloaded.saturating_add(chunk_len as u64);
                let pct = content_len
                    .filter(|total| *total > 0)
                    .map(|total| 10 + ((downloaded.saturating_mul(80) / total).min(80) as u32))
                    .unwrap_or(35);
                emit_update_download_progress(&app_for_progress, pct, 100, "download");
            },
            {
                let app_for_install = app.clone();
                move || {
                    emit_update_download_progress(&app_for_install, 92, 100, "install");
                    // Windows 安装器会拉起新进程，先释放单实例锁。
                    #[cfg(target_os = "windows")]
                    tauri_plugin_single_instance::destroy(&app_for_install);
                }
            },
        )
        .await
        .map_err(|e| format!("自动安装更新失败: {e}"))?;

    emit_update_download_progress(&app, 100, 100, "done");

    // macOS updater 只替换磁盘上的 .app，不会重启正在运行的旧进程。
    // 成功后主动重启，新版本才能立即加载本地更新日志；安装失败时保留旧进程与单实例锁。
    #[cfg(target_os = "macos")]
    {
        tauri_plugin_single_instance::destroy(&app);
        app.request_restart();
    }

    Ok(UpdateDownloadResult {
        latest_version,
        file_name,
        file_path: String::new(),
        release_url,
    })
}

#[tauri::command]
pub(crate) async fn download_and_open_update(app: tauri::AppHandle) -> Result<UpdateDownloadResult, String> {
    let current_version = app.package_info().version.to_string();
    let app_handle = app.clone();

    tauri::async_runtime::spawn_blocking(move || {
        emit_update_download_progress(&app_handle, 5, 100, "prepare");
        let release = fetch_latest_download_page_release()?;
        if !is_remote_version_newer(&release.version, &current_version) {
            return Err("Already on the latest version".into());
        }

        let client = build_http_client(120)?;
        emit_update_download_progress(&app_handle, 10, 100, "download");
        let mut resp = client
            .get(&release.download_url)
            .send()
            .map_err(|e| format!("更新包下载失败: {}", e))?;

        if !resp.status().is_success() {
            return Err(format!("更新包下载返回 {}", resp.status()));
        }

        let update_dir = data_dir(&app_handle).join("updates");
        fs::create_dir_all(&update_dir).map_err(|e| e.to_string())?;
        let file_path = update_dir.join(&release.file_name);
        let mut file = fs::File::create(&file_path).map_err(|e| e.to_string())?;
        let total_size = resp.content_length().unwrap_or(0);
        let mut downloaded: u64 = 0;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let read = resp
                .read(&mut buffer)
                .map_err(|e| format!("读取更新包失败: {}", e))?;
            if read == 0 {
                break;
            }
            file.write_all(&buffer[..read])
                .map_err(|e| format!("写入更新包失败: {}", e))?;
            downloaded += read as u64;
            if total_size > 0 {
                let pct = 10 + ((downloaded.saturating_mul(75) / total_size).min(75) as u32);
                emit_update_download_progress(&app_handle, pct, 100, "download");
            }
        }
        file.flush().map_err(|e| e.to_string())?;

        let file_path_str = file_path.to_string_lossy().to_string();
        emit_update_download_progress(&app_handle, 90, 100, "open");
        open_installer_file(&file_path)?;
        emit_update_download_progress(&app_handle, 100, 100, "done");

        Ok(UpdateDownloadResult {
            latest_version: release.version,
            file_name: release.file_name,
            file_path: file_path_str,
            release_url: APP_DOWNLOAD_PAGE_URL.into(),
        })
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
pub(crate) fn export_profiles(app: tauri::AppHandle, dest: String) -> Result<(), String> {
    let src = profiles_path(&app);
    if !src.exists() {
        return Err("配置文件不存在".into());
    }
    fs::copy(&src, &dest).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn import_profiles(app: tauri::AppHandle, src: String) -> Result<usize, String> {
    let src_path = PathBuf::from(&src);
    if !src_path.exists() {
        return Err("文件不存在".into());
    }
    let content = fs::read_to_string(&src_path).map_err(|e| e.to_string())?;
    let imported: ProfilesData =
        serde_json::from_str(&content).map_err(|_| "文件格式无效".to_string())?;
    let count = imported.profiles.len();
    if count == 0 {
        return Err("文件中没有配置".into());
    }
    // 合并到现有配置（跳过重复的 api_key+base_url）
    let mut data = read_profiles(&app);
    let mut added = 0;
    for mut p in imported.profiles {
        let exists = data
            .profiles
            .iter()
            .any(|x| x.api_key == p.api_key && x.base_url == p.base_url);
        if !exists {
            // 为空的 id 和 createdAt 生成有效值，确保导入的配置可以正常编辑/删除
            if p.id.is_empty() {
                p.id = uuid::Uuid::new_v4().to_string();
            }
            if p.created_at.is_empty() {
                p.created_at = chrono_now();
            }
            data.profiles.push(p);
            added += 1;
        }
    }
    write_profiles(&app, &data)?;
    Ok(added)
}

pub(crate) fn normalize_version_parts(version: &str) -> Vec<u64> {
    version
        .trim()
        .trim_start_matches(['v', 'V'])
        .split('.')
        .map(|part| {
            part.chars()
                .take_while(|ch| ch.is_ascii_digit())
                .collect::<String>()
        })
        .map(|digits| digits.parse::<u64>().unwrap_or(0))
        .collect()
}

pub(crate) fn compare_versions(left: &str, right: &str) -> CmpOrdering {
    let left_parts = normalize_version_parts(left);
    let right_parts = normalize_version_parts(right);
    let len = left_parts.len().max(right_parts.len()).max(3);

    for idx in 0..len {
        let left_num = *left_parts.get(idx).unwrap_or(&0);
        let right_num = *right_parts.get(idx).unwrap_or(&0);
        match left_num.cmp(&right_num) {
            CmpOrdering::Equal => continue,
            other => return other,
        }
    }

    CmpOrdering::Equal
}

pub(crate) fn is_remote_version_newer(remote: &str, local: &str) -> bool {
    compare_versions(remote, local) == CmpOrdering::Greater
}

pub(crate) fn normalize_version_tag(version: &str) -> String {
    let trimmed = version.trim();
    if trimmed.starts_with(['v', 'V']) {
        format!("v{}", &trimmed[1..])
    } else {
        format!("v{trimmed}")
    }
}

#[cfg(test)]
pub(crate) fn extract_latest_version_from_download_page(html: &str) -> Option<String> {
    extract_latest_download_page_release(html).map(|release| release.version)
}

pub(crate) fn installer_name_matches_target(name_lower: &str, target_os: &str) -> bool {
    match target_os {
        "windows" => name_lower.ends_with(".exe") || name_lower.ends_with(".msi"),
        "macos" => name_lower.ends_with(".dmg"),
        "linux" => {
            name_lower.ends_with(".appimage")
                || name_lower.ends_with(".deb")
                || name_lower.ends_with(".rpm")
        }
        _ => false,
    }
}

pub(crate) fn extract_download_page_releases(html: &str) -> Vec<DownloadPageRelease> {
    let marker = "VarSwitch_";
    html.match_indices(marker)
        .filter_map(|(idx, _)| {
            let tail = html.get(idx..)?;
            let file_name = tail
                .chars()
                .take_while(|ch| {
                    ch.is_ascii_alphanumeric() || matches!(*ch, '_' | '-' | '.' | '+' | '(' | ')')
                })
                .collect::<String>();
            if file_name.is_empty() {
                return None;
            }
            let version_tail = file_name.strip_prefix(marker)?;
            let version = version_tail
                .chars()
                .take_while(|ch| ch.is_ascii_digit() || *ch == '.')
                .collect::<String>();
            if version.is_empty() {
                return None;
            }
            let href_before = html[..idx].rfind("href=\"");
            let download_url = href_before
                .and_then(|href_idx| {
                    let start = href_idx + "href=\"".len();
                    let end = html[start..].find('"')? + start;
                    let href = &html[start..end];
                    if href.contains(&file_name) {
                        reqwest::Url::parse(APP_DOWNLOAD_PAGE_URL)
                            .ok()
                            .and_then(|base| base.join(href).ok())
                            .map(|url| url.to_string())
                    } else {
                        None
                    }
                })
                .unwrap_or_else(|| format!("{}releases/{}", APP_DOWNLOAD_PAGE_URL, file_name));
            Some(DownloadPageRelease {
                version: normalize_version_tag(&version),
                file_name,
                download_url,
            })
        })
        .collect()
}

pub(crate) fn extract_latest_download_page_release(html: &str) -> Option<DownloadPageRelease> {
    extract_download_page_releases(html)
        .into_iter()
        .filter(|release| {
            installer_name_matches_target(
                &release.file_name.to_ascii_lowercase(),
                std::env::consts::OS,
            )
        })
        .max_by(|left, right| compare_versions(&left.version, &right.version))
}

pub(crate) fn fetch_latest_download_page_release() -> Result<DownloadPageRelease, String> {
    let client = build_http_client(20)?;
    let resp = client
        .get(APP_DOWNLOAD_PAGE_URL)
        .send()
        .map_err(|e| format!("下载页请求失败: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("下载页返回 {}", resp.status()));
    }

    let body = resp.text().map_err(|e| format!("下载页读取失败: {}", e))?;

    extract_latest_download_page_release(&body).ok_or_else(|| "下载页未找到可用安装包".into())
}
