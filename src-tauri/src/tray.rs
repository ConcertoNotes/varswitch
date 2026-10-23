//! 托盘快速切换菜单（从 lib.rs 拆分，逻辑未改动）。

use crate::*;

// ── 托盘快速切换菜单 ─────────────────────────────────

/// 托盘图标固定 id，供 refresh_tray_menu 用 tray_by_id 找回句柄
pub(crate) const TRAY_ICON_ID: &str = "main";

/// 汇总某个应用的全部配置，统一成 (id, 名称, 是否激活) 供托盘菜单使用
pub(crate) fn tray_profile_entries(app: &tauri::AppHandle, kind: &str) -> Vec<(String, String, bool)> {
    match kind {
        "claude" => read_profiles(app)
            .profiles
            .iter()
            .map(|p| (p.id.clone(), p.name.clone(), p.is_active))
            .collect(),
        "codex" => read_codex_profiles(app)
            .profiles
            .iter()
            .map(|p| (p.id.clone(), p.name.clone(), p.is_active))
            .collect(),
        "gemini" => read_gemini_profiles(app)
            .profiles
            .iter()
            .map(|p| (p.id.clone(), p.name.clone(), p.is_active))
            .collect(),
        "grok" => read_grok_profiles(app)
            .profiles
            .iter()
            .map(|p| (p.id.clone(), p.name.clone(), p.is_active))
            .collect(),
        "opencode" => opencode::read_opencode_profiles(app)
            .profiles
            .iter()
            .map(|p| (p.id.clone(), p.name.clone(), p.is_active))
            .collect(),
        _ => Vec::new(),
    }
}

/// 构建单个应用的托盘子菜单：标题带当前激活配置名（如 `Claude · 宝宝静`），
/// 菜单项为该应用全部配置（CheckMenuItem，激活项勾选），无配置时放一个禁用占位项
pub(crate) fn build_tray_submenu(
    app: &tauri::AppHandle,
    kind: &str,
    display: &str,
) -> tauri::Result<tauri::menu::Submenu<tauri::Wry>> {
    let entries = tray_profile_entries(app, kind);
    let title = match entries.iter().find(|(_, _, active)| *active) {
        Some((_, name, _)) => format!("{display} · {name}"),
        None => display.to_string(),
    };
    let mut builder = SubmenuBuilder::new(app, title);
    if entries.is_empty() {
        let placeholder = MenuItemBuilder::with_id(format!("tray-empty:{kind}"), "暂无配置")
            .enabled(false)
            .build(app)?;
        builder = builder.item(&placeholder);
    } else {
        for (id, name, is_active) in &entries {
            let item = CheckMenuItemBuilder::with_id(format!("tray-switch:{kind}:{id}"), name)
                .checked(*is_active)
                .build(app)?;
            builder = builder.item(&item);
        }
    }
    builder.build()
}

/// 构建完整托盘菜单：Claude / Codex / Gemini / Grok / OpenCode 五个快速切换子菜单
/// + 分隔线 + 显示主窗口 + 退出（后两项保持既有行为）
pub(crate) fn build_tray_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let claude = build_tray_submenu(app, "claude", "Claude")?;
    let codex = build_tray_submenu(app, "codex", "Codex")?;
    let gemini = build_tray_submenu(app, "gemini", "Gemini")?;
    let grok = build_tray_submenu(app, "grok", "Grok")?;
    let opencode = build_tray_submenu(app, "opencode", "OpenCode")?;
    let show_item = MenuItemBuilder::with_id("show", "显示主窗口").build(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", "退出").build(app)?;
    MenuBuilder::new(app)
        .items(&[&claude, &codex, &gemini, &grok, &opencode])
        .separator()
        .items(&[&show_item, &quit_item])
        .build()
}

/// profiles 数据变化后重建托盘菜单，保证激活勾选与配置列表始终新鲜。
/// setup 早期托盘尚未创建时 tray_by_id 拿不到句柄，静默跳过即可。
pub(crate) fn refresh_tray_menu(app: &tauri::AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ICON_ID) else {
        return;
    };
    match build_tray_menu(app) {
        Ok(menu) => {
            if let Err(e) = tray.set_menu(Some(menu)) {
                log_warn!("[tray] 更新托盘菜单失败: {e}");
            }
        }
        Err(e) => log_warn!("[tray] 构建托盘菜单失败: {e}"),
    }
}

/// 托盘菜单点击切换配置。切换会写注册表/多份配置文件，较慢，
/// 放到后台线程执行避免阻塞托盘事件；完成后刷新菜单同步勾选状态。
pub(crate) fn handle_tray_switch(app: &tauri::AppHandle, kind: String, profile_id: String) {
    let app = app.clone();
    std::thread::spawn(move || {
        let result = match kind.as_str() {
            "claude" => {
                let state_handle = app.clone();
                let state = state_handle.state::<AppState>();
                switch_profile_blocking(app.clone(), state, profile_id.clone()).and_then(|result| {
                    if !result.success {
                        return Err(result.errors.join("; "));
                    }
                    Ok(())
                })
            }
            "codex" => switch_codex_profile(app.clone(), profile_id.clone()),
            "gemini" => switch_gemini_profile(app.clone(), profile_id.clone()),
            "grok" => switch_grok_profile(app.clone(), profile_id.clone()),
            "opencode" => opencode::switch_opencode_profile(app.clone(), profile_id.clone()),
            _ => Err(format!("未知的托盘切换类型: {kind}")),
        };
        match result {
            Ok(()) => log_info!("[tray] 已通过托盘切换 {kind} 配置 {profile_id}"),
            Err(e) => log_error!("[tray] 托盘切换 {kind} 配置 {profile_id} 失败: {e}"),
        }
        // 成功与否都刷新一次，让勾选状态回到与磁盘数据一致
        refresh_tray_menu(&app);
    });
}
