use super::*;
use std::cell::{Cell, RefCell};

struct TestConfigDir(PathBuf);

impl TestConfigDir {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("varswitch-codex-switch-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for TestConfigDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn profile() -> CodexProfile {
    CodexProfile {
        id: "test-profile".into(),
        name: "Test profile".into(),
        api_key: "test-key".into(),
        base_url: "https://api.example.test/v1".into(),
        auth_mode: default_codex_auth_mode(),
        wire_api: default_codex_wire_api(),
        model: "test-model".into(),
        provider_name: "custom".into(),
        image_api_key: String::new(),
        image_base_url: String::new(),
        is_active: false,
        created_at: String::new(),
    }
}

#[test]
fn successful_sync_requests_one_restart_after_both_files_and_profile_state_are_saved() {
    let dir = TestConfigDir::new();
    let profile = profile();
    let events = RefCell::new(Vec::new());

    complete_codex_profile_switch(
        || {
            write_codex_config_at(&profile, &profile.base_url, &dir.0)?;
            write_private_file(&dir.0.join("profiles.json"), r#"{"active":"test-profile"}"#)?;
            events.borrow_mut().push("saved");
            Ok(())
        },
        || {
            let auth: serde_json::Value =
                serde_json::from_str(&fs::read_to_string(dir.0.join("auth.json")).unwrap())
                    .unwrap();
            assert_eq!(auth["OPENAI_API_KEY"], profile.api_key);
            let config = fs::read_to_string(dir.0.join("config.toml")).unwrap();
            assert_eq!(toml_line_value(&config, "model"), profile.model);
            assert_eq!(
                toml_section_value(&config, "model_providers.custom", "base_url"),
                profile.base_url
            );
            assert!(dir.0.join("profiles.json").is_file());
            events.borrow_mut().push("restart");
        },
    )
    .unwrap();

    assert_eq!(*events.borrow(), ["saved", "restart"]);
}

#[test]
fn failure_writing_either_runtime_file_never_requests_restart() {
    for failing_file in ["auth.json", "config.toml"] {
        let dir = TestConfigDir::new();
        let profile = profile();
        // 同名目录使原子替换确定失败；不依赖当前用户权限或只读位。
        fs::create_dir(dir.0.join(failing_file)).unwrap();
        let restarts = Cell::new(0);

        let result = complete_codex_profile_switch(
            || write_codex_config_at(&profile, &profile.base_url, &dir.0),
            || restarts.set(restarts.get() + 1),
        );

        assert!(result.unwrap_err().contains(failing_file));
        assert_eq!(restarts.get(), 0);
        if failing_file == "config.toml" {
            assert!(
                dir.0.join("auth.json").is_file(),
                "even a partial write must not restart"
            );
        }
    }
}

#[test]
fn failure_after_runtime_sync_never_requests_restart() {
    let dir = TestConfigDir::new();
    let profile = profile();
    let restarts = Cell::new(0);
    fs::create_dir(dir.0.join("profiles.json")).unwrap();

    let result = complete_codex_profile_switch(
        || {
            write_codex_config_at(&profile, &profile.base_url, &dir.0)?;
            write_private_file(&dir.0.join("profiles.json"), "{}")
        },
        || restarts.set(restarts.get() + 1),
    );

    assert!(result.is_err());
    assert!(dir.0.join("auth.json").is_file());
    assert!(dir.0.join("config.toml").is_file());
    assert_eq!(restarts.get(), 0);
}

#[test]
fn official_account_profile_keeps_existing_auth() {
    let dir = TestConfigDir::new();
    let mut profile = profile();
    profile.auth_mode = "official_account_api_quota".into();
    let existing_auth = r#"{"tokens":{"access_token":"test-account-token"}}"#;
    fs::write(dir.0.join("auth.json"), existing_auth).unwrap();

    complete_codex_profile_switch(
        || write_codex_config_at(&profile, &profile.base_url, &dir.0),
        || {
            assert_eq!(
                fs::read_to_string(dir.0.join("auth.json")).unwrap(),
                existing_auth
            )
        },
    )
    .unwrap();
}

#[cfg(target_os = "macos")]
#[test]
fn verification_failure_prevents_restart_and_never_includes_file_contents() {
    let dir = TestConfigDir::new();
    for name in ["auth.json", "config.toml"] {
        let path = dir.0.join(name);
        fs::write(&path, "actual-test-secret").unwrap();
        let result = complete_codex_profile_switch(
            || verify_codex_config_file(&path, "expected-test-secret", name),
            || panic!("verification failure must not restart"),
        );
        assert_eq!(
            result.unwrap_err(),
            format!("校验 Codex {name} 失败：写入内容不一致")
        );

        fs::remove_file(&path).unwrap();
        assert_eq!(
            verify_codex_config_file(&path, "expected-test-secret", name).unwrap_err(),
            format!("校验 Codex {name} 失败：无法读取已写入文件")
        );
    }
}

#[cfg(target_os = "macos")]
#[test]
fn restart_uses_login_zsh_with_all_standard_streams_discarded() {
    let dir = TestConfigDir::new();
    let mut command = codex_daemon_restart_command();
    assert_eq!(command.get_program(), "/bin/zsh");
    assert_eq!(
        command.get_args().collect::<Vec<_>>(),
        ["-lic", "codex app-server daemon restart"]
    );

    // 用隔离的启动文件提供 codex 替身，避免读取用户 zsh 配置或重启真实后台。
    // zprofile / zshrc 分别验证登录与交互初始化（fnm 通常依赖后者）。
    fs::write(dir.0.join(".zshenv"), "function codex() { return 93; }\n").unwrap();
    fs::write(
        dir.0.join(".zprofile"),
        "export VARSWITCH_TEST_LOGIN=ready\n",
    )
    .unwrap();
    fs::write(
        dir.0.join(".zshrc"),
        r#"function codex() {
  [[ "$VARSWITCH_TEST_LOGIN" == ready ]] || return 90
  [[ "$*" == 'app-server daemon restart' ]] || return 91
  [[ /dev/fd/0 -ef /dev/null && /dev/fd/1 -ef /dev/null && /dev/fd/2 -ef /dev/null ]] || return 92
  print -r -- called >> "$ZDOTDIR/restart-calls"
}
"#,
    )
    .unwrap();
    command.env("ZDOTDIR", &dir.0);
    let mut child = command.spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("login zsh did not exit within 5 seconds; check terminal job control");
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    assert!(status.success(), "login zsh failed: {status}");
    assert_eq!(
        fs::read_to_string(dir.0.join("restart-calls")).unwrap(),
        "called\n"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn background_restart_runs_once_without_waiting_or_propagating_command_failures() {
    use std::os::unix::process::ExitStatusExt;
    use std::sync::Arc;

    // 包含命令成功、zsh 中找不到 codex (127)、重启失败及无法启动进程。
    for outcome in [
        Ok(std::process::ExitStatus::from_raw(0)),
        Ok(std::process::ExitStatus::from_raw(127 << 8)),
        Ok(std::process::ExitStatus::from_raw(1 << 8)),
        Err(std::io::Error::from(std::io::ErrorKind::NotFound)),
    ] {
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (finished_tx, finished_rx) = mpsc::channel();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let worker_calls = calls.clone();
        let result = complete_codex_profile_switch(
            || Ok(()),
            || {
                spawn_codex_daemon_restart(move || {
                    worker_calls.fetch_add(1, Ordering::SeqCst);
                    started_tx.send(()).unwrap();
                    release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                    finished_tx.send(()).unwrap();
                    outcome
                })
            },
        );

        assert_eq!(
            result,
            Ok(()),
            "switch must finish before the restart is released"
        );
        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(finished_rx.try_recv(), Err(mpsc::TryRecvError::Empty));
        release_tx.send(()).unwrap();
        finished_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
