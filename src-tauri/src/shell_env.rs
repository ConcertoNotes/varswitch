//! Unix 环境变量持久化。只解释自己生成的赋值，不执行用户的 shell 配置。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const MARKER: &str = " # VarSwitch-managed";
static ENV_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Debug, PartialEq)]
enum Syntax {
    Posix,
    Fish,
}

fn targets(
    home: &Path,
    shell: &Path,
    zdotdir: Option<PathBuf>,
    xdg: Option<PathBuf>,
) -> Result<Vec<(PathBuf, Syntax)>, String> {
    let paths = match shell.file_name().and_then(|s| s.to_str()).unwrap_or("zsh") {
        "zsh" => vec![(
            zdotdir.unwrap_or_else(|| home.to_path_buf()).join(".zshrc"),
            Syntax::Posix,
        )],
        "bash" => {
            // macOS Terminal 默认启动 login shell；Linux 终端通常读取 .bashrc。
            let login = [".bash_profile", ".bash_login", ".profile"]
                .into_iter()
                .map(|name| home.join(name))
                .find(|p| p.exists())
                .unwrap_or_else(|| home.join(".bash_profile"));
            vec![
                (home.join(".bashrc"), Syntax::Posix),
                (login, Syntax::Posix),
            ]
        }
        "fish" => vec![(
            xdg.unwrap_or_else(|| home.join(".config"))
                .join("fish/config.fish"),
            Syntax::Fish,
        )],
        "sh" | "dash" | "ksh" => vec![(home.join(".profile"), Syntax::Posix)],
        other => {
            return Err(format!(
                "暂不支持 {other} 的环境变量持久化，请使用 zsh、bash 或 fish"
            ))
        }
    };
    Ok(paths)
}

fn current_targets() -> Result<Vec<(PathBuf, Syntax)>, String> {
    let nonempty = |name: &str| {
        std::env::var_os(name)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    };
    let home = nonempty("HOME").ok_or("无法获取 HOME 目录")?;
    let shell = nonempty("SHELL").unwrap_or_else(|| {
        PathBuf::from(if cfg!(target_os = "macos") {
            "/bin/zsh"
        } else {
            "/bin/sh"
        })
    });
    targets(
        &home,
        &shell,
        nonempty("ZDOTDIR"),
        nonempty("XDG_CONFIG_HOME"),
    )
}

fn validate(name: &str, value: Option<&str>) -> Result<(), String> {
    let mut chars = name.chars();
    if !chars
        .next()
        .is_some_and(|c| c == '_' || c.is_ascii_alphabetic())
        || !chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
    {
        return Err("非法的环境变量名".into());
    }
    if value.is_some_and(|v| v.contains(['\0', '\n', '\r'])) {
        return Err(format!("环境变量 {name} 不能包含换行或 NUL"));
    }
    Ok(())
}

fn quote(value: &str, syntax: Syntax) -> String {
    match syntax {
        Syntax::Posix => format!("'{}'", value.replace('\'', "'\\''")),
        Syntax::Fish => format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'")),
    }
}

// Some(None) 表示显式 unset，不能再回退到应用启动时继承的旧值。
fn managed_value(line: &str, name: &str, syntax: Syntax) -> Option<Option<String>> {
    let body = line.trim().strip_suffix(MARKER)?;
    if body == format!("unset {name}") || body == format!("set -e {name}") {
        return Some(None);
    }
    let prefix = match syntax {
        Syntax::Posix => format!("export {name}="),
        Syntax::Fish => format!("set -gx {name} "),
    };
    let raw = body.strip_prefix(&prefix)?;
    let value = if let Some(single) = raw.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')) {
        match syntax {
            Syntax::Posix => single.replace("'\\''", "'"),
            Syntax::Fish => {
                let mut out = String::new();
                let mut chars = single.chars();
                while let Some(c) = chars.next() {
                    if c == '\\' {
                        out.push(chars.next()?);
                    } else {
                        out.push(c);
                    }
                }
                out
            }
        }
    } else {
        // 兼容旧版本 export NAME="value" 的持久化格式。
        raw.strip_prefix('"')?.strip_suffix('"')?.to_string()
    };
    Some(Some(value))
}

fn rewrite(content: &str, name: &str, value: Option<&str>, syntax: Syntax) -> String {
    let mut output = String::new();
    for line in content.lines() {
        if managed_value(line, name, syntax).is_none() {
            output.push_str(line);
            output.push('\n');
        }
    }
    let command = match (syntax, value) {
        (Syntax::Posix, Some(v)) => format!("export {name}={}", quote(v, syntax)),
        (Syntax::Fish, Some(v)) => format!("set -gx {name} {}", quote(v, syntax)),
        (Syntax::Posix, None) => format!("unset {name}"),
        (Syntax::Fish, None) => format!("set -e {name}"),
    };
    output.push_str(&format!("{command}{MARKER}\n"));
    output
}

pub(crate) fn get(name: &str) -> Option<String> {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if let Ok(paths) = current_targets() {
        // bash login 文件在 .bashrc 之后写入；按最终生效顺序读取。
        for (path, syntax) in paths.iter().rev() {
            if let Ok(content) = fs::read_to_string(path) {
                if let Some(value) = content
                    .lines()
                    .rev()
                    .find_map(|line| managed_value(line, name, *syntax))
                {
                    return value;
                }
            }
        }
    }
    std::env::var(name).ok()
}

fn persist(
    paths: &[(PathBuf, Syntax)],
    name: &str,
    value: Option<&str>,
    publish: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    validate(name, value)?;
    let mut originals = Vec::new();
    for (path, syntax) in paths {
        // 保留用户通过 dotfiles 管理的符号链接，替换真实目标文件。
        let path = if path.is_symlink() {
            path.canonicalize()
                .map_err(|e| format!("解析 Shell 配置链接失败: {e}"))?
        } else {
            path.clone()
        };
        let content = match fs::read_to_string(&path) {
            Ok(text) => Some(text),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(format!("读取 Shell 配置 {} 失败: {e}", path.display())),
        };
        originals.push((path, *syntax, content));
    }
    let result = (|| {
        for (path, syntax, content) in &originals {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            crate::write_file_atomic(
                path,
                &rewrite(content.as_deref().unwrap_or(""), name, value, *syntax),
            )?;
        }
        publish()
    })();
    if let Err(error) = result {
        let mut failures = Vec::new();
        for (path, _, content) in &originals {
            let restored = match content {
                Some(text) => crate::write_file_atomic(path, text),
                None if path.exists() => fs::remove_file(path).map_err(|e| e.to_string()),
                None => Ok(()),
            };
            if let Err(e) = restored {
                failures.push(e);
            }
        }
        return Err(if failures.is_empty() {
            error
        } else {
            format!("{error}；恢复 Shell 配置失败: {}", failures.join("; "))
        });
    }
    Ok(())
}

pub(crate) fn set(name: &str, value: Option<&str>) -> Result<(), String> {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    persist(&current_targets()?, name, value, || {
        // Finder / Dock 启动的应用不读取 .zshrc；更新用户 launchd 环境供后续 GUI 进程继承。
        #[cfg(target_os = "macos")]
        {
            let mut command = std::process::Command::new("/bin/launchctl");
            command
                .arg(if value.is_some() {
                    "setenv"
                } else {
                    "unsetenv"
                })
                .arg(name);
            if let Some(value) = value {
                command.arg(value);
            }
            let output = command
                .output()
                .map_err(|e| format!("更新 macOS 用户环境失败: {e}"))?;
            if !output.status.success() {
                return Err(format!(
                    "更新 macOS 用户环境变量 {name} 失败（{}）",
                    output.status
                ));
            }
        }
        Ok(())
    })?;
    // 只有持久化和 launchd 更新成功后，状态页与子进程才使用新值。
    match value {
        Some(value) => std::env::set_var(name, value),
        None => std::env::remove_var(name),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn temp_dir() -> PathBuf {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "varswitch-shell-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn values_survive_real_shells_without_expansion_or_command_execution() {
        let dir = temp_dir();
        let sentinel = dir.join("must-not-exist");
        let value = format!(
            "key'\"$HOME`touch {0}`$(touch {0})\\tail # 中文",
            sentinel.display()
        );
        for shell in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
            if !Path::new(shell).exists() {
                continue;
            }
            let script = format!(
                "{}printf '%s' \"$VS_TEST\"",
                rewrite("", "VS_TEST", Some(&value), Syntax::Posix)
            );
            let output = Command::new(shell)
                .args(["-f", "-c", &script])
                .output()
                .unwrap();
            assert!(output.status.success());
            assert_eq!(String::from_utf8(output.stdout).unwrap(), value);
        }
        assert!(!sentinel.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn replacement_migrates_legacy_lines_preserves_user_content_and_unsets_stale_values() {
        let original = "# user settings\nexport KEEP=ok\nexport KEY=\"old\" # VarSwitch-managed\nexport KEY=\"duplicate\" # VarSwitch-managed\n";
        let updated = rewrite(original, "KEY", Some("new'value"), Syntax::Posix);
        assert_eq!(updated.matches(MARKER).count(), 1);
        assert!(updated.starts_with("# user settings\nexport KEEP=ok\n"));
        assert_eq!(
            updated
                .lines()
                .find_map(|l| managed_value(l, "KEY", Syntax::Posix)),
            Some(Some("new'value".into()))
        );
        assert_eq!(
            rewrite(&updated, "KEY", Some("new'value"), Syntax::Posix),
            updated
        );
        let removed = rewrite(&updated, "KEY", None, Syntax::Posix);
        assert_eq!(
            removed
                .lines()
                .find_map(|l| managed_value(l, "KEY", Syntax::Posix)),
            Some(None)
        );
        let output = Command::new("/bin/sh")
            .args(["-c", &format!("{removed}printf '%s' \"${{KEY-unset}}\"")])
            .env("KEY", "stale")
            .output()
            .unwrap();
        assert_eq!(output.stdout, b"unset");
    }

    #[test]
    fn shell_paths_honor_login_files_zdotdir_and_fish_config() {
        let home = temp_dir();
        let custom = home.join("custom");
        assert_eq!(
            targets(&home, Path::new("/bin/zsh"), Some(custom.clone()), None).unwrap()[0].0,
            custom.join(".zshrc")
        );
        fs::write(home.join(".profile"), "# existing login file").unwrap();
        let bash = targets(&home, Path::new("/bin/bash"), None, None).unwrap();
        assert_eq!(bash[0].0, home.join(".bashrc"));
        assert_eq!(bash[1].0, home.join(".profile"));
        assert_eq!(
            targets(
                &home,
                Path::new("/usr/local/bin/fish"),
                None,
                Some(custom.clone())
            )
            .unwrap()[0],
            (custom.join("fish/config.fish"), Syntax::Fish)
        );
        assert!(targets(&home, Path::new("/bin/tcsh"), None, None).is_err());
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn publish_failure_rolls_back_files_and_success_preserves_symlinks() {
        let dir = temp_dir();
        let real = dir.join("real-rc");
        let link = dir.join(".zshrc");
        fs::write(&real, "# keep me\n").unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let new = dir.join("new-rc");
        let paths = vec![(link.clone(), Syntax::Posix), (new.clone(), Syntax::Posix)];
        assert!(persist(&paths, "KEY", Some("value"), || Err(
            "launchd unavailable".into()
        ))
        .is_err());
        assert_eq!(fs::read_to_string(&real).unwrap(), "# keep me\n");
        assert!(!new.exists());
        persist(&paths, "KEY", Some("value"), || Ok(())).unwrap();
        assert!(link.is_symlink());
        assert!(fs::read_to_string(&real)
            .unwrap()
            .contains("export KEY='value'"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn fish_quoting_round_trips_and_invalid_input_does_not_touch_files() {
        let value = "key'\\$()\"#中文";
        let line = rewrite("", "KEY", Some(value), Syntax::Fish);
        assert_eq!(
            managed_value(line.trim(), "KEY", Syntax::Fish),
            Some(Some(value.into()))
        );
        let dir = temp_dir();
        let path = dir.join(".zshrc");
        for (name, value) in [
            ("BAD;NAME", "ok"),
            ("KEY", "line\nbreak"),
            ("KEY", "nul\0byte"),
        ] {
            assert!(
                persist(&[(path.clone(), Syntax::Posix)], name, Some(value), || Ok(
                    ()
                ))
                .is_err()
            );
            assert!(!path.exists());
        }
        fs::remove_dir_all(dir).unwrap();
    }
}
