//! API Key 等敏感字段的本机加密存储。
//!
//! ── 方案 ────────────────────────────────────────────────────────────────────
//!
//! 1. 主密钥（32 字节随机）存放在系统凭据库：Windows 凭据管理器 / macOS 钥匙串
//!    （keyring crate）。密钥本身从不落盘到数据目录。
//! 2. 配置文件里的敏感字段用 AES-256-GCM 加密，写成 `enc:v1:<base64(nonce||密文)>`。
//!    带前缀是为了能区分明文与密文：老配置里的明文原样读取（渐进迁移），
//!    解不开的密文也能被识别出来并给出明确提示，而不是把乱码当成 Key 用。
//!
//! ── 已知取舍 ────────────────────────────────────────────────────────────────
//!
//! 主密钥绑定当前设备的凭据库，因此把数据目录放在网盘上做多设备同步时，
//! **另一台设备解不开这份密文**。这是选择系统凭据库方案的固有代价（换成主密码
//! 派生密钥才能跨设备）。为此解密失败绝不静默返回空串，而是保留原值并标记失败，
//! 让上层把「本机无法解密，请重新填写」如实告诉用户，避免用空 Key 覆盖掉好数据。

use crate::*;
use aes_gcm::aead::{Aead, Generate, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
#[cfg(not(test))]
use aes_gcm::Key;

/// 系统凭据库中的条目标识
#[cfg(not(test))]
const KEYRING_SERVICE: &str = "VarSwitch";
#[cfg(not(test))]
const KEYRING_USER: &str = "data-encryption-key";

/// 密文前缀：版本号便于日后换算法时平滑升级
const CIPHER_PREFIX: &str = "enc:v1:";
const NONCE_LEN: usize = 12;

/// 进程内缓存主密钥，避免每次读写配置都去敲一次系统凭据库。
/// None 表示凭据库不可用，此时全部退回明文存储（功能可用性优先）。
#[cfg(not(test))]
static MASTER_KEY: OnceLock<Option<[u8; 32]>> = OnceLock::new();

#[cfg(test)]
fn master_key() -> Option<&'static [u8; 32]> {
    static TEST_MASTER_KEY: [u8; 32] = [0x56; 32];
    Some(&TEST_MASTER_KEY)
}

#[cfg(not(test))]
/// 读取或创建主密钥。凭据库不可用时返回 None，调用方据此退回明文。
fn master_key() -> Option<&'static [u8; 32]> {
    MASTER_KEY.get_or_init(load_or_create_master_key).as_ref()
}

#[cfg(not(test))]
fn load_or_create_master_key() -> Option<[u8; 32]> {
    let entry = match keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER) {
        Ok(entry) => entry,
        Err(error) => {
            log_warn!("[secret] 系统凭据库不可用，API Key 将以明文存储：{error}");
            return None;
        }
    };
    match entry.get_password() {
        Ok(encoded) => match decode_key(&encoded) {
            Some(key) => return Some(key),
            None => {
                // 凭据存在但内容不是合法密钥，重建会让既有密文永久解不开，
                // 因此保持明文模式并要求人工介入，绝不覆盖
                log_error!("[secret] 系统凭据库中的主密钥格式非法，为避免旧密文丢失，本次以明文模式运行");
                return None;
            }
        },
        Err(keyring::Error::NoEntry) => {}
        Err(error) => {
            log_warn!("[secret] 读取主密钥失败，API Key 将以明文存储：{error}");
            return None;
        }
    }

    let mut key = [0u8; 32];
    key.copy_from_slice(Key::<Aes256Gcm>::generate().as_slice());
    let encoded = base64::engine::general_purpose::STANDARD.encode(key);
    if let Err(error) = entry.set_password(&encoded) {
        log_warn!("[secret] 写入主密钥失败，API Key 将以明文存储：{error}");
        return None;
    }
    log_info!("[secret] 已在系统凭据库中创建 VarSwitch 主密钥");
    Some(key)
}

#[cfg(not(test))]
fn decode_key(encoded: &str) -> Option<[u8; 32]> {
    let raw = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .ok()?;
    if raw.len() != 32 {
        return None;
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&raw);
    Some(key)
}

/// 该字符串是否为本模块产出的密文
pub(crate) fn is_encrypted(value: &str) -> bool {
    value.starts_with(CIPHER_PREFIX)
}

/// 加密敏感字段。空值原样返回；凭据库不可用时退回明文，保证功能不中断。
pub(crate) fn encrypt_secret(plain: &str) -> String {
    if plain.is_empty() || is_encrypted(plain) {
        return plain.to_string();
    }
    let Some(key) = master_key() else {
        return plain.to_string();
    };
    let cipher = match Aes256Gcm::new_from_slice(key) {
        Ok(cipher) => cipher,
        Err(error) => {
            log_warn!("[secret] 初始化加密器失败，本次以明文存储：{error}");
            return plain.to_string();
        }
    };
    let nonce = Nonce::generate();
    match cipher.encrypt(&nonce, plain.as_bytes()) {
        Ok(ciphertext) => {
            let mut payload = Vec::with_capacity(NONCE_LEN + ciphertext.len());
            payload.extend_from_slice(nonce.as_slice());
            payload.extend_from_slice(&ciphertext);
            format!(
                "{CIPHER_PREFIX}{}",
                base64::engine::general_purpose::STANDARD.encode(payload)
            )
        }
        Err(error) => {
            log_warn!("[secret] 加密失败，本次以明文存储：{error}");
            plain.to_string()
        }
    }
}

/// 解密敏感字段。
/// 明文原样返回（兼容尚未迁移的旧配置）；密文解不开时返回 Err，
/// 由调用方决定如何提示，绝不返回空串——那会让上层拿空 Key 覆盖掉正确数据。
pub(crate) fn decrypt_secret(value: &str) -> Result<String, String> {
    let Some(encoded) = value.strip_prefix(CIPHER_PREFIX) else {
        return Ok(value.to_string());
    };
    let key = master_key().ok_or_else(|| {
        "系统凭据库不可用，无法解密本机保存的 API Key".to_string()
    })?;
    let payload = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|e| format!("密文格式非法：{e}"))?;
    if payload.len() <= NONCE_LEN {
        return Err("密文长度异常".to_string());
    }
    let (nonce_bytes, ciphertext) = payload.split_at(NONCE_LEN);
    let nonce = Nonce::try_from(nonce_bytes).map_err(|_| "密文 nonce 长度异常".to_string())?;
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|e| format!("初始化解密器失败：{e}"))?;
    let plain = cipher
        .decrypt(&nonce, ciphertext)
        .map_err(|_| {
            // 最常见的原因是换了设备：数据目录经网盘同步过来，但主密钥在原设备的凭据库里
            "无法解密（该配置可能来自另一台设备，请重新填写 API Key）".to_string()
        })?;
    String::from_utf8(plain).map_err(|e| format!("解密结果不是合法文本：{e}"))
}

/// 解密失败时的兜底：保留原始密文并记录日志。
/// 上层拿到的仍是 `enc:v1:` 开头的串，界面上能看出「这条需要重填」，
/// 而后续写回也不会把好数据覆盖成空值。
pub(crate) fn decrypt_secret_or_keep(value: &str, context: &str) -> String {
    match decrypt_secret(value) {
        Ok(plain) => plain,
        Err(error) => {
            log_warn!("[secret] {context} 解密失败：{error}");
            value.to_string()
        }
    }
}

/// 切换前校验：值仍是本机解不开的密文时必须拦下。
/// 否则会把 `enc:v1:...` 原样写进环境变量与 CLI 配置，用户只会看到上游返回一个
/// 莫名其妙的鉴权错误，很难联想到是换设备导致的解密失败。
pub(crate) fn ensure_secret_usable(value: &str, label: &str) -> Result<(), String> {
    if is_encrypted(value) {
        return Err(format!(
            "{label}的 API Key 无法在本机解密（该配置可能来自另一台设备），请重新填写后再切换"
        ));
    }
    Ok(())
}

/// 把数据目录里仍是明文的敏感字段就地转成密文。
///
/// 只在检测到明文时才动手，并且**先整体备份一次**，因为一旦密文写坏、
/// 主密钥又丢失，这些 Key 就找不回来了。任何一个文件失败都只记日志、跳过该文件，
/// 不影响其余文件，也不阻断启动。
pub(crate) fn migrate_plaintext_secrets(app: &tauri::AppHandle) {
    let claude = read_profiles(app);
    let claude_desktop =
        claude_desktop_provider::read_stored_claude_desktop_profiles_checked(app);
    let codex = read_codex_profiles(app);
    let grok = read_grok_profiles(app);
    let gemini = read_gemini_profiles(app);
    let opencode = opencode::read_opencode_profiles(app);

    // 读出来已是明文，所以要判断「磁盘上是否还是明文」得看原始文件内容
    let pending: Vec<&str> = [
        (profiles_path(app), "profiles.json"),
        (
            claude_desktop_provider::claude_desktop_profiles_path(app),
            "claude_desktop_profiles.json",
        ),
        (codex_profiles_path(app), "codex_profiles.json"),
        (grok_profiles_path(app), "grok_profiles.json"),
        (gemini_profiles_path(app), "gemini_profiles.json"),
    ]
    .into_iter()
    .filter(|(path, _)| file_has_plaintext_secret(path))
    .map(|(_, name)| name)
    .collect();
    if pending.is_empty() {
        return;
    }

    log_info!("[secret] 检测到明文 API Key，开始迁移为本机加密存储：{}", pending.join(", "));
    // 迁移前留一份完整备份，出问题还能回滚
    auto_backup_configs(app);

    if let Err(error) = write_profiles(app, &claude) {
        log_error!("[secret] 迁移 Claude 配置失败：{error}");
    }
    match claude_desktop {
        Ok(claude_desktop) => {
            if let Err(error) =
                claude_desktop_provider::write_claude_desktop_profiles(app, &claude_desktop)
            {
                log_error!("[secret] 迁移 Claude Desktop 配置失败：{error}");
            }
        }
        Err(error) => {
            log_error!("[secret] 读取 Claude Desktop 配置失败，已跳过迁移且未覆盖原文件：{error}");
        }
    }
    if let Err(error) = write_codex_profiles(app, &codex) {
        log_error!("[secret] 迁移 Codex 配置失败：{error}");
    }
    if let Err(error) = write_grok_profiles(app, &grok) {
        log_error!("[secret] 迁移 Grok 配置失败：{error}");
    }
    if let Err(error) = write_gemini_profiles(app, &gemini) {
        log_error!("[secret] 迁移 Gemini 配置失败：{error}");
    }
    // OpenCode 的写函数在模块内私有，借道一次无变更的重排完成加密落盘
    let ids: Vec<String> = opencode.profiles.iter().map(|p| p.id.clone()).collect();
    if !ids.is_empty() {
        if let Err(error) = opencode::reorder_opencode_profiles(app.clone(), ids) {
            log_error!("[secret] 迁移 OpenCode 配置失败：{error}");
        }
    }
    log_info!("[secret] 明文 API Key 迁移完成");
}

/// 文件里是否存在「非空且未加密」的敏感字段
fn file_has_plaintext_secret(path: &PathBuf) -> bool {
    let Ok(text) = fs::read_to_string(path) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return false;
    };
    let Some(profiles) = value.get("profiles").and_then(|v| v.as_array()) else {
        return false;
    };
    profiles.iter().any(|profile| {
        ["apiKey", "imageApiKey"].iter().any(|field| {
            profile
                .get(*field)
                .and_then(|v| v.as_str())
                .is_some_and(|raw| !raw.is_empty() && !is_encrypted(raw))
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plaintext_passes_through_unchanged() {
        // 尚未迁移的旧配置必须原样可读
        assert_eq!(decrypt_secret("sk-plain-key").unwrap(), "sk-plain-key");
        assert!(!is_encrypted("sk-plain-key"));
    }

    #[test]
    fn empty_value_is_not_encrypted() {
        assert_eq!(encrypt_secret(""), "");
    }

    #[test]
    fn encrypting_twice_does_not_double_wrap() {
        let once = encrypt_secret("sk-secret-value");
        assert!(is_encrypted(&once));
        assert_eq!(encrypt_secret(&once), once, "已加密的值不应再包一层");
    }

    #[test]
    fn round_trip_recovers_original_value() {
        let secret = "sk-round-trip-测试-🔐";
        let encrypted = encrypt_secret(secret);
        assert!(is_encrypted(&encrypted));
        assert_ne!(encrypted, secret, "密文不应等于明文");
        assert!(!encrypted.contains(secret), "密文中不应残留明文");
        assert_eq!(decrypt_secret(&encrypted).unwrap(), secret);
    }

    #[test]
    fn tampered_ciphertext_is_rejected_not_silently_emptied() {
        let encrypted = encrypt_secret("sk-tamper-check");
        assert!(is_encrypted(&encrypted));
        // 改掉 base64 尾部字符模拟损坏/异设备密文
        let mut broken = encrypted[..encrypted.len() - 2].to_string();
        broken.push_str(if encrypted.ends_with("AA") { "BB" } else { "AA" });
        assert!(decrypt_secret(&broken).is_err(), "损坏的密文必须报错");
        // 兜底路径要保留原值，绝不能返回空串
        assert_eq!(decrypt_secret_or_keep(&broken, "测试"), broken);
    }

    #[test]
    fn each_encryption_uses_a_fresh_nonce() {
        let first = encrypt_secret("same-input");
        let second = encrypt_secret("same-input");
        assert!(is_encrypted(&first));
        assert!(is_encrypted(&second));
        assert_ne!(first, second, "相同明文两次加密结果必须不同");
    }
}
