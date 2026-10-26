//! 用量监控统计（迁移自 cc-switch 的会话日志解析方案）
//!
//! 无代理模式下，直接解析各 CLI 工具的本地会话日志，得到精确 token 用量：
//! - Claude Code: `~/.claude/projects/**/*.jsonl`（assistant 消息的 usage 字段，按 message.id 去重）
//! - Codex:      `~/.codex/sessions/YYYY/MM/DD/*.jsonl` + `archived_sessions/*.jsonl`
//!               （token_count 事件，优先 last_token_usage 精确值，否则累计值高水位差分；
//!               fork/子代理会话按父线程 token 签名去除回放前缀，避免双算）
//! - Gemini CLI: `~/.gemini/tmp/*/chats/session-*.json`（逐消息独立 tokens，thoughts 并入 output 计费）
//! - Grok CLI:   `~/.grok/{sessions,archived_sessions}/**/updates.jsonl`
//!               （turn_completed 事件为逐轮独立总量，按面值入账；CLI 自报 costUsdTicks 优先）
//!
//! 统计口径与 cc-switch 一致：
//! - Claude 的 input_tokens 已是"新增输入"（不含缓存）；Codex/Gemini/Grok 的 input 含缓存，
//!   展示与计费时先扣除 cache_read / cache_creation 归一化为 fresh input。
//! - 真实消耗 tokens = fresh_input + output + cache_creation + cache_read
//! - 缓存命中率 = cache_read / (fresh_input + cache_creation + cache_read)
//! - 费用 = 各分项 token × 每百万参考单价（价格快照优先，内置旧型号价格兜底）

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, Once, OnceLock};
use std::time::SystemTime;

// ---------------------------------------------------------------------------
// 时间工具（无 chrono 依赖）
// ---------------------------------------------------------------------------

/// 公历日期 → 自 1970-01-01 起的天数（Howard Hinnant 算法）
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// 天数 → 公历日期
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m as u32, d as u32)
}

/// 解析 RFC3339 时间戳为 unix 秒（支持 Z / ±HH:MM / ±HHMM / 小数秒）
fn parse_rfc3339_to_unix(s: &str) -> Option<i64> {
    let s = s.trim();
    let bytes = s.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    if bytes[4] != b'-'
        || bytes[7] != b'-'
        || !(bytes[10] == b'T' || bytes[10] == b't' || bytes[10] == b' ')
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let year: i64 = s.get(0..4)?.parse().ok()?;
    let month: i64 = s.get(5..7)?.parse().ok()?;
    let day: i64 = s.get(8..10)?.parse().ok()?;
    let hour: i64 = s.get(11..13)?.parse().ok()?;
    let minute: i64 = s.get(14..16)?.parse().ok()?;
    let second: i64 = s.get(17..19)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let mut idx = 19;
    if idx < bytes.len() && bytes[idx] == b'.' {
        idx += 1;
        while idx < bytes.len() && bytes[idx].is_ascii_digit() {
            idx += 1;
        }
    }
    let mut offset_secs: i64 = 0;
    if idx < bytes.len() {
        match bytes[idx] {
            b'Z' | b'z' => {}
            b'+' | b'-' => {
                let sign: i64 = if bytes[idx] == b'+' { 1 } else { -1 };
                let rest = s.get(idx + 1..)?;
                let (oh, om) = if let Some((h, m)) = rest.split_once(':') {
                    (h.parse::<i64>().ok()?, m.parse::<i64>().ok()?)
                } else if rest.len() == 4 {
                    (rest[0..2].parse::<i64>().ok()?, rest[2..4].parse::<i64>().ok()?)
                } else {
                    return None;
                };
                offset_secs = sign * (oh * 3600 + om * 60);
            }
            _ => return None,
        }
    }
    Some(days_from_civil(year, month, day) * 86400 + hour * 3600 + minute * 60 + second - offset_secs)
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 文件 mtime 纳秒时间戳（缓存指纹用）
fn metadata_modified_nanos(metadata: &fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// 基础数据结构
// ---------------------------------------------------------------------------

/// 反序列化时校验 app 名称合法（磁盘缓存可能被外部篡改/损坏）。
/// 注意字段类型必须用 String 而不是 &'static str：serde 对 &str 字段会推断
/// "从输入借用"，给派生实现加上 `'de: 'static` 约束，导致包含本结构的
/// 枚举/容器无法通过编译。
fn deserialize_app<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let name = String::deserialize(deserializer)?;
    match name.as_str() {
        "claude" | "codex" | "gemini" | "grok" => Ok(name),
        other => Err(serde::de::Error::custom(format!("未知应用类型: {other}"))),
    }
}

/// 单条用量记录（等价于 cc-switch proxy_request_logs 的一行会话来源数据）
#[derive(Debug, Clone, Serialize, Deserialize)]
struct UsageRecord {
    /// 全局唯一请求 ID（与 cc-switch 同构：session:… / codex_session:… / gemini_session:… / grok_session:…）
    request_id: String,
    /// claude / codex / gemini / grok
    #[serde(deserialize_with = "deserialize_app")]
    app: String,
    model: String,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
    /// 一小时缓存写入，是 cache_creation_tokens 的子集，不重复计入总量。
    #[serde(default)]
    cache_creation_1h_tokens: u64,
    /// unix 秒
    created_at: i64,
    /// Grok CLI 自报的本轮成本（USD），1 tick = 1e-10 USD 已折算
    reported_cost: Option<f64>,
    /// 上游标记自报成本为部分值（下界）
    cost_partial: bool,
    /// 会话工作目录（Claude / Codex 日志自带 cwd，其余应用为空）
    #[serde(default)]
    project: Option<String>,
    /// 来源会话 ID（Codex 为根线程 ID）
    #[serde(default)]
    session_id: Option<String>,
}

/// Codex 会话文件解析结果（保留 token 事件签名以支持 fork 回放去重）
#[derive(Debug, Clone, Serialize, Deserialize)]
struct CodexTokenEvent {
    signature: String,
    ts_unix: Option<i64>,
    /// (input, cached_input, output, cache_write_input) 增量
    delta: (u32, u32, u32, u32),
    /// 非零增量事件的序号（1 起），零增量为 None
    event_index: Option<u32>,
    model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
enum CodexParent {
    None,
    Parent(String),
    Deferred(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ParsedCodexFile {
    root_thread_id: Option<String>,
    root_meta_seen: bool,
    root_ts: Option<i64>,
    parent: CodexParent,
    events: Vec<CodexTokenEvent>,
    has_billable_tokens: bool,
    /// 是否存在缺时间戳的 token 事件（父线程时间线校验用）
    has_token_without_timestamp: bool,
    /// 全部 token 事件的最大时间戳
    max_event_ts: Option<i64>,
    /// root session_meta 记录的工作目录
    #[serde(default)]
    cwd: Option<String>,
}

/// 解析缓存条目
#[derive(Debug, Clone, Serialize, Deserialize)]
enum ParsedFile {
    Records(Vec<UsageRecord>),
    Codex(ParsedCodexFile),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedFile {
    modified_nanos: i64,
    size: u64,
    parsed: ParsedFile,
}

fn usage_cache() -> &'static Mutex<HashMap<PathBuf, CachedFile>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedFile>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 内存缓存自上次落盘后是否有新解析结果
static CACHE_DIRTY: AtomicBool = AtomicBool::new(false);

/// 解析结果结构或语义变化时递增，旧缓存文件自动作废。
/// v2：缺 timestamp 的记录改为跳过（旧缓存可能含回退为扫描时刻的伪时间戳）
/// v3：保留 Codex 缓存写入计数及 Claude 一小时缓存写入计数。
/// v4：记录携带项目目录与会话 ID（最近记录展示用）。
const DISK_CACHE_VERSION: u32 = 4;

#[derive(Serialize, Deserialize)]
struct DiskCache {
    version: u32,
    entries: HashMap<PathBuf, CachedFile>,
}

fn disk_cache_path(data_dir: &Path) -> PathBuf {
    data_dir.join("usage_scan_cache.json")
}

/// 应用生命周期内只从磁盘加载一次；之后以内存缓存为准
fn load_disk_cache_once(data_dir: &Path) {
    static LOADED: Once = Once::new();
    let path = disk_cache_path(data_dir);
    LOADED.call_once(|| {
        let Ok(bytes) = fs::read(&path) else { return };
        let Ok(disk) = serde_json::from_slice::<DiskCache>(&bytes) else {
            // 版本或格式不兼容，丢弃并等待重建
            let _ = fs::remove_file(&path);
            return;
        };
        if disk.version != DISK_CACHE_VERSION {
            let _ = fs::remove_file(&path);
            return;
        }
        if let Ok(mut cache) = usage_cache().lock() {
            for (file, entry) in disk.entries {
                cache.entry(file).or_insert(entry);
            }
        }
    });
}

/// 有新解析结果时把内存缓存写回磁盘（顺带清掉已删除文件的条目）
fn persist_disk_cache(data_dir: &Path, live_paths: &HashSet<PathBuf>) {
    if !CACHE_DIRTY.swap(false, Ordering::SeqCst) {
        return;
    }
    let snapshot = {
        let Ok(mut cache) = usage_cache().lock() else { return };
        cache.retain(|path, _| live_paths.contains(path));
        DiskCache {
            version: DISK_CACHE_VERSION,
            entries: cache.clone(),
        }
    };
    let Ok(json) = serde_json::to_vec(&snapshot) else {
        CACHE_DIRTY.store(true, Ordering::SeqCst);
        return;
    };
    let path = disk_cache_path(data_dir);
    let tmp = path.with_extension("json.tmp");
    // 先写临时文件再原子替换，避免写一半崩溃留下损坏缓存
    if fs::write(&tmp, &json).is_ok() {
        if fs::rename(&tmp, &path).is_err() {
            // Windows 上目标存在时 rename 可能失败，退化为直接覆盖
            let _ = fs::write(&path, &json);
            let _ = fs::remove_file(&tmp);
        }
    } else {
        CACHE_DIRTY.store(true, Ordering::SeqCst);
    }
}

/// 带缓存地解析单个文件：文件 (mtime, size) 未变化时直接复用上次解析结果
fn parse_file_cached<F>(path: &Path, parse: F) -> Result<ParsedFile, String>
where
    F: FnOnce(&Path) -> Result<ParsedFile, String>,
{
    let metadata = fs::metadata(path).map_err(|e| format!("无法读取文件元数据: {e}"))?;
    let stamp = (metadata_modified_nanos(&metadata), metadata.len());
    if let Ok(cache) = usage_cache().lock() {
        if let Some(entry) = cache.get(path) {
            if entry.modified_nanos == stamp.0 && entry.size == stamp.1 {
                return Ok(entry.parsed.clone());
            }
        }
    }
    let parsed = parse(path)?;
    if let Ok(mut cache) = usage_cache().lock() {
        cache.insert(
            path.to_path_buf(),
            CachedFile {
                modified_nanos: stamp.0,
                size: stamp.1,
                parsed: parsed.clone(),
            },
        );
        CACHE_DIRTY.store(true, Ordering::SeqCst);
    }
    Ok(parsed)
}

// ---------------------------------------------------------------------------
// 模型定价：以 usage-pricing.json（models.dev 第一方价格快照）为准；
// 下表迁移自 cc-switch seed_model_pricing，仅兜底快照未收录的旧型号。
// 单位：USD / 1M tokens，(model_id, input, output, cache_read, cache_creation)
// ---------------------------------------------------------------------------

#[rustfmt::skip]
const MODEL_PRICING: &[(&str, f64, f64, f64, f64)] = &[
    // Claude 系列
    ("claude-fable-5", 10.0, 50.0, 1.00, 12.50),
    ("claude-mythos-5", 10.0, 50.0, 1.00, 12.50),
    ("claude-opus-5", 5.0, 25.0, 0.50, 6.25),
    ("claude-opus-4-8", 5.0, 25.0, 0.50, 6.25),
    ("claude-sonnet-5", 3.0, 15.0, 0.30, 3.75),
    ("claude-opus-4-7", 5.0, 25.0, 0.50, 6.25),
    ("claude-opus-4-6", 5.0, 25.0, 0.50, 6.25),
    ("claude-sonnet-4-6", 3.0, 15.0, 0.30, 3.75),
    ("claude-opus-4-6-20260206", 5.0, 25.0, 0.50, 6.25),
    ("claude-sonnet-4-6-20260217", 3.0, 15.0, 0.30, 3.75),
    ("claude-opus-4-5-20251101", 5.0, 25.0, 0.50, 6.25),
    ("claude-sonnet-4-5-20250929", 3.0, 15.0, 0.30, 3.75),
    ("claude-haiku-4-5-20251001", 1.0, 5.0, 0.10, 1.25),
    ("claude-opus-4-20250514", 15.0, 75.0, 1.50, 18.75),
    ("claude-opus-4-1-20250805", 15.0, 75.0, 1.50, 18.75),
    ("claude-sonnet-4-20250514", 3.0, 15.0, 0.30, 3.75),
    ("claude-3-5-haiku-20241022", 0.80, 4.0, 0.08, 1.0),
    ("claude-3-5-sonnet-20241022", 3.0, 15.0, 0.30, 3.75),
    // GPT-5.6 系列
    ("gpt-5.6-sol", 5.0, 30.0, 0.50, 6.25),
    ("gpt-5.6-terra", 2.0, 12.0, 0.20, 2.50),
    ("gpt-5.6-luna", 0.20, 1.20, 0.02, 0.25),
    ("gpt-5.6", 5.0, 30.0, 0.50, 6.25),
    ("gpt-5.6-low", 5.0, 30.0, 0.50, 6.25),
    ("gpt-5.6-medium", 5.0, 30.0, 0.50, 6.25),
    ("gpt-5.6-high", 5.0, 30.0, 0.50, 6.25),
    ("gpt-5.6-xhigh", 5.0, 30.0, 0.50, 6.25),
    ("gpt-5.6-minimal", 5.0, 30.0, 0.50, 6.25),
    // GPT-5.5 系列
    ("gpt-5.5", 5.0, 30.0, 0.50, 0.0),
    ("gpt-5.5-low", 5.0, 30.0, 0.50, 0.0),
    ("gpt-5.5-medium", 5.0, 30.0, 0.50, 0.0),
    ("gpt-5.5-high", 5.0, 30.0, 0.50, 0.0),
    ("gpt-5.5-xhigh", 5.0, 30.0, 0.50, 0.0),
    ("gpt-5.5-minimal", 5.0, 30.0, 0.50, 0.0),
    // GPT-5.4 系列
    ("gpt-5.4", 2.50, 15.0, 0.25, 0.0),
    ("gpt-5.4-mini", 0.75, 4.50, 0.075, 0.0),
    ("gpt-5.4-nano", 0.20, 1.25, 0.02, 0.0),
    // GPT-5.2 系列
    ("gpt-5.2", 1.75, 14.0, 0.175, 0.0),
    ("gpt-5.2-low", 1.75, 14.0, 0.175, 0.0),
    ("gpt-5.2-medium", 1.75, 14.0, 0.175, 0.0),
    ("gpt-5.2-high", 1.75, 14.0, 0.175, 0.0),
    ("gpt-5.2-xhigh", 1.75, 14.0, 0.175, 0.0),
    ("gpt-5.2-codex", 1.75, 14.0, 0.175, 0.0),
    ("gpt-5.2-codex-low", 1.75, 14.0, 0.175, 0.0),
    ("gpt-5.2-codex-medium", 1.75, 14.0, 0.175, 0.0),
    ("gpt-5.2-codex-high", 1.75, 14.0, 0.175, 0.0),
    ("gpt-5.2-codex-xhigh", 1.75, 14.0, 0.175, 0.0),
    // GPT-5.3 Codex 系列
    ("gpt-5.3-codex", 1.75, 14.0, 0.175, 0.0),
    ("gpt-5.3-codex-spark", 1.75, 14.0, 0.175, 0.0),
    ("gpt-5.3-codex-low", 1.75, 14.0, 0.175, 0.0),
    ("gpt-5.3-codex-medium", 1.75, 14.0, 0.175, 0.0),
    ("gpt-5.3-codex-high", 1.75, 14.0, 0.175, 0.0),
    ("gpt-5.3-codex-xhigh", 1.75, 14.0, 0.175, 0.0),
    // GPT-5.1 系列
    ("gpt-5.1", 1.25, 10.0, 0.125, 0.0),
    ("gpt-5.1-low", 1.25, 10.0, 0.125, 0.0),
    ("gpt-5.1-medium", 1.25, 10.0, 0.125, 0.0),
    ("gpt-5.1-high", 1.25, 10.0, 0.125, 0.0),
    ("gpt-5.1-minimal", 1.25, 10.0, 0.125, 0.0),
    ("gpt-5.1-codex", 1.25, 10.0, 0.125, 0.0),
    ("gpt-5.1-codex-mini", 1.25, 10.0, 0.125, 0.0),
    ("gpt-5.1-codex-max", 1.25, 10.0, 0.125, 0.0),
    ("gpt-5.1-codex-max-high", 1.25, 10.0, 0.125, 0.0),
    ("gpt-5.1-codex-max-xhigh", 1.25, 10.0, 0.125, 0.0),
    // GPT-5 系列
    ("gpt-5", 1.25, 10.0, 0.125, 0.0),
    ("gpt-5-low", 1.25, 10.0, 0.125, 0.0),
    ("gpt-5-medium", 1.25, 10.0, 0.125, 0.0),
    ("gpt-5-high", 1.25, 10.0, 0.125, 0.0),
    ("gpt-5-minimal", 1.25, 10.0, 0.125, 0.0),
    ("gpt-5-codex", 1.25, 10.0, 0.125, 0.0),
    ("gpt-5-codex-low", 1.25, 10.0, 0.125, 0.0),
    ("gpt-5-codex-medium", 1.25, 10.0, 0.125, 0.0),
    ("gpt-5-codex-high", 1.25, 10.0, 0.125, 0.0),
    ("gpt-5-codex-mini", 1.25, 10.0, 0.125, 0.0),
    ("gpt-5-codex-mini-medium", 1.25, 10.0, 0.125, 0.0),
    ("gpt-5-codex-mini-high", 1.25, 10.0, 0.125, 0.0),
    ("gpt-5-mini", 0.25, 2.0, 0.025, 0.0),
    ("gpt-5-nano", 0.05, 0.40, 0.005, 0.0),
    // OpenAI Reasoning / 其他
    ("o3", 2.0, 8.0, 0.50, 0.0),
    ("o3-pro", 20.0, 80.0, 0.0, 0.0),
    ("o3-mini", 0.55, 2.20, 0.55, 0.0),
    ("o4-mini", 1.10, 4.40, 0.275, 0.0),
    ("o1", 15.0, 60.0, 7.50, 0.0),
    ("o1-mini", 0.55, 2.20, 0.55, 0.0),
    ("codex-mini", 0.75, 3.0, 0.025, 0.0),
    ("gpt-4.1", 2.0, 8.0, 0.50, 0.0),
    ("gpt-4.1-mini", 0.40, 1.60, 0.10, 0.0),
    ("gpt-4.1-nano", 0.10, 0.40, 0.025, 0.0),
    // Gemini 系列
    ("gemini-3.6-flash", 1.50, 7.50, 0.15, 0.0),
    ("gemini-3.5-flash", 1.50, 9.00, 0.15, 0.0),
    ("gemini-3.5-flash-lite", 0.30, 2.50, 0.03, 0.0),
    ("gemini-3.1-pro-preview", 2.0, 12.0, 0.20, 0.0),
    ("gemini-3.1-flash-lite", 0.25, 1.50, 0.025, 0.0),
    ("gemini-3.1-flash-lite-preview", 0.25, 1.50, 0.025, 0.0),
    ("gemini-3-pro-preview", 2.0, 12.0, 0.2, 0.0),
    ("gemini-3-flash-preview", 0.5, 3.0, 0.05, 0.0),
    ("gemini-2.5-pro", 1.25, 10.0, 0.125, 0.0),
    ("gemini-2.5-flash", 0.3, 2.5, 0.03, 0.0),
    ("gemini-2.5-flash-lite", 0.10, 0.40, 0.01, 0.0),
    ("gemini-2.0-flash", 0.10, 0.40, 0.025, 0.0),
    // StepFun
    ("step-3.7-flash", 0.19, 1.13, 0.04, 0.0),
    ("step-3.5-flash", 0.10, 0.30, 0.02, 0.0),
    ("step-3.5-flash-2603", 0.10, 0.30, 0.02, 0.0),
    // Doubao
    ("doubao-seed-2-1-pro", 0.84, 4.2, 0.17, 0.0),
    ("doubao-seed-2-1-turbo", 0.42, 2.1, 0.08, 0.0),
    ("doubao-seed-code", 0.17, 1.11, 0.02, 0.0),
    ("doubao-seed-2-0-pro", 0.47, 2.37, 0.09, 0.0),
    ("doubao-seed-2-0-code", 0.47, 2.37, 0.09, 0.0),
    ("doubao-seed-2-0-code-preview-latest", 0.47, 2.37, 0.09, 0.0),
    ("doubao-seed-2-0-lite", 0.08, 0.50, 0.017, 0.0),
    ("doubao-seed-2-0-mini", 0.03, 0.31, 0.0056, 0.0),
    // DeepSeek
    ("deepseek-v3.2", 0.28, 0.42, 0.028, 0.0),
    ("deepseek-v3.1", 0.55, 1.67, 0.055, 0.0),
    ("deepseek-v3", 0.28, 1.11, 0.028, 0.0),
    ("deepseek-chat", 0.14, 0.28, 0.0028, 0.0),
    ("deepseek-reasoner", 0.14, 0.28, 0.0028, 0.0),
    ("deepseek-v4-flash", 0.14, 0.28, 0.0028, 0.0),
    ("deepseek-v4-pro", 0.435, 0.87, 0.003625, 0.0),
    // Kimi
    ("kimi-k2-thinking", 0.55, 2.20, 0.10, 0.0),
    ("kimi-k2-0905", 0.55, 2.20, 0.10, 0.0),
    ("kimi-k2-turbo", 1.11, 8.06, 0.14, 0.0),
    ("kimi-k2.5", 0.60, 3.00, 0.10, 0.0),
    ("kimi-k2.6", 0.95, 4.00, 0.16, 0.0),
    ("kimi-k2.7-code", 0.95, 4.00, 0.19, 0.0),
    ("kimi-k2.7-code-highspeed", 1.90, 8.00, 0.38, 0.0),
    ("kimi-k3", 3.00, 15.00, 0.30, 0.0),
    ("k3", 3.00, 15.00, 0.30, 0.0),
    // 腾讯混元
    ("hunyuan-hy3", 0.14, 0.56, 0.035, 0.0),
    ("hy3", 0.14, 0.56, 0.035, 0.0),
    // MiniMax
    ("minimax-m2.1", 0.27, 0.95, 0.03, 0.0),
    ("minimax-m2.1-lightning", 0.27, 2.33, 0.03, 0.0),
    ("minimax-m2", 0.27, 0.95, 0.03, 0.0),
    ("minimax-m2.5", 0.15, 0.95, 0.03, 0.0),
    ("minimax-m2.5-lightning", 0.30, 2.40, 0.03, 0.0),
    ("minimax-m2.7", 0.30, 1.20, 0.06, 0.375),
    ("minimax-m2.7-highspeed", 0.60, 2.40, 0.06, 0.375),
    ("minimax-m3", 0.30, 1.20, 0.06, 0.0),
    // GLM
    ("glm-4.7", 0.6, 2.2, 0.11, 0.0),
    ("glm-4.6", 0.6, 2.2, 0.11, 0.0),
    ("glm-5", 1.0, 3.2, 0.2, 0.0),
    ("glm-5.1", 1.4, 4.4, 0.26, 0.0),
    ("glm-5.2", 1.4, 4.4, 0.26, 0.0),
    ("glm-5-turbo", 1.2, 4.0, 0.24, 0.0),
    ("glm-5v-turbo", 1.2, 4.0, 0.24, 0.0),
    // MiMo
    ("mimo-v2-flash", 0.09, 0.29, 0.009, 0.0),
    ("mimo-v2-pro", 0.435, 0.87, 0.0036, 0.0),
    ("mimo-v2.5", 0.14, 0.29, 0.0028, 0.0),
    ("mimo-v2.5-pro", 0.435, 0.87, 0.0036, 0.0),
    // Qwen
    ("qwen3.8-max", 2.0, 6.0, 0.25, 2.50),
    ("qwen3.7-max", 2.50, 7.50, 0.25, 0.0),
    ("qwen3.7-plus", 0.40, 1.60, 0.08, 0.0),
    ("qwen3.6-plus", 0.325, 1.95, 0.065, 0.0),
    ("qwen3.6-flash", 0.1875, 1.125, 0.0375, 0.0),
    ("qwen3.5-plus", 0.26, 1.56, 0.052, 0.0),
    ("qwen3-max", 0.78, 3.90, 0.0, 0.0),
    ("qwen3-235b-a22b", 0.70, 8.40, 0.0, 0.0),
    ("qwen3-coder-plus", 0.65, 3.25, 0.13, 0.0),
    ("qwen3-coder-480b", 0.65, 3.25, 0.0, 0.0),
    ("qwen3-coder-480b-a35b-instruct", 0.65, 3.25, 0.0, 0.0),
    ("qwen3-coder-flash", 0.195, 0.975, 0.039, 0.0),
    ("qwen3-coder-next", 0.12, 0.75, 0.0, 0.0),
    ("qwq-plus", 0.80, 2.40, 0.0, 0.0),
    ("qwq-32b", 0.20, 0.60, 0.0, 0.0),
    ("qwen3-32b", 0.16, 0.64, 0.0, 0.0),
    // Grok (xAI)
    ("grok-4.5", 2.0, 6.0, 0.50, 0.0),
    ("grok-4.5-build", 2.0, 6.0, 0.30, 0.0),
    ("grok-4.3", 1.25, 2.50, 0.20, 0.0),
    ("grok-4.20-0309-reasoning", 1.25, 2.50, 0.20, 0.0),
    ("grok-4.20-0309-non-reasoning", 1.25, 2.50, 0.20, 0.0),
    ("grok-4-1-fast-reasoning", 0.20, 0.50, 0.05, 0.0),
    ("grok-4-1-fast-non-reasoning", 0.20, 0.50, 0.05, 0.0),
    ("grok-4", 3.0, 15.0, 0.75, 0.0),
    ("grok-code-fast-1", 1.0, 2.0, 0.20, 0.0),
    ("grok-build-0.1", 1.0, 2.0, 0.20, 0.0),
    ("grok-3", 3.0, 15.0, 0.75, 0.0),
    ("grok-3-mini", 0.25, 0.50, 0.075, 0.0),
    // Mistral
    ("mistral-medium-3.5", 1.50, 7.50, 0.0, 0.0),
    ("mistral-small-4", 0.10, 0.30, 0.01, 0.0),
    ("devstral-small-2-2512", 0.10, 0.30, 0.01, 0.0),
    ("magistral-small", 0.50, 1.50, 0.0, 0.0),
    ("codestral-2508", 0.30, 0.90, 0.03, 0.0),
    ("devstral-small-1.1", 0.07, 0.28, 0.01, 0.0),
    ("devstral-2-2512", 0.40, 2.0, 0.04, 0.0),
    ("devstral-medium", 0.40, 2.0, 0.04, 0.0),
    ("mistral-large-3-2512", 0.50, 1.50, 0.05, 0.0),
    ("mistral-medium-3.1", 0.40, 2.0, 0.04, 0.0),
    ("mistral-small-3.2-24b", 0.075, 0.20, 0.01, 0.0),
    ("magistral-medium", 2.0, 5.0, 0.0, 0.0),
    // Cohere
    ("command-a", 2.50, 10.0, 0.0, 0.0),
    ("command-r-plus", 2.50, 10.0, 0.0, 0.0),
    ("command-r", 0.15, 0.60, 0.0, 0.0),
];

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pricing {
    input: f64,
    output: f64,
    cache_read: Option<f64>,
    cache_creation: Option<f64>,
    #[serde(default)]
    cache_creation_1h: Option<f64>,
}

/// 长上下文分档：单条请求的提示长度超过 `above` 时改用该档单价
#[derive(Debug, Clone, Copy, Deserialize)]
struct PricingTier {
    above: u64,
    rates: Pricing,
}

#[derive(Debug, Clone, Deserialize)]
struct ModelPricing {
    rates: Pricing,
    #[serde(default)]
    tiers: Vec<PricingTier>,
}

#[derive(Deserialize)]
struct ReferenceModelPricing {
    model: String,
    #[serde(flatten)]
    pricing: ModelPricing,
}

#[derive(Deserialize)]
struct ReferencePricing {
    source: String,
    date: String,
    models: Vec<ReferenceModelPricing>,
}

fn reference_pricing() -> &'static ReferencePricing {
    static TABLE: OnceLock<ReferencePricing> = OnceLock::new();
    TABLE.get_or_init(|| {
        serde_json::from_str(include_str!("usage-pricing.json"))
            .expect("bundled usage pricing must be valid")
    })
}

fn reference_pricing_map() -> &'static HashMap<String, ModelPricing> {
    static MAP: OnceLock<HashMap<String, ModelPricing>> = OnceLock::new();
    MAP.get_or_init(|| {
        reference_pricing().models.iter()
            .map(|entry| (entry.model.clone(), entry.pricing.clone())).collect()
    })
}

fn pricing_map() -> &'static HashMap<&'static str, ModelPricing> {
    static MAP: OnceLock<HashMap<&'static str, ModelPricing>> = OnceLock::new();
    MAP.get_or_init(|| {
        MODEL_PRICING
            .iter()
            .map(|(id, input, output, cache_read, cache_creation)| {
                (
                    *id,
                    ModelPricing {
                        rates: Pricing {
                            input: *input,
                            output: *output,
                            cache_read: Some(*cache_read),
                            cache_creation: Some(*cache_creation),
                            cache_creation_1h: id.starts_with("claude-").then_some(input * 2.0),
                        },
                        tiers: Vec::new(),
                    },
                )
            })
            .collect()
    })
}

fn is_placeholder_model(model_id: &str) -> bool {
    let normalized = model_id.trim().to_ascii_lowercase();
    normalized.is_empty() || matches!(normalized.as_str(), "unknown" | "null" | "none")
}

/// 清洗模型 ID（对齐 cc-switch clean_model_id_for_pricing）
fn clean_model_id_for_pricing(model_id: &str) -> String {
    let normalized = model_id
        .rsplit_once('/')
        .map_or(model_id, |(_, r)| r)
        .split(':')
        .next()
        .unwrap_or(model_id)
        .trim()
        .replace('@', "-")
        .to_ascii_lowercase();
    normalized.trim_end_matches("[1m]").trim().to_string()
}

fn strip_known_model_namespace(model_id: &str) -> Option<String> {
    if let Some(pos) = model_id.rfind("claude-") {
        if pos > 0 {
            return Some(model_id[pos..].to_string());
        }
    }
    for marker in [
        "openai.", "anthropic.", "google.", "moonshot.", "moonshotai.", "bedrock.", "global.",
    ] {
        if let Some(stripped) = model_id.strip_prefix(marker) {
            return Some(stripped.to_string());
        }
    }
    None
}

fn strip_claude_non_anthropic_prefix(model_id: &str) -> Option<String> {
    const NON_ANTHROPIC_MARKERS: &[&str] = &[
        "abab", "ark-code", "arctic", "astron", "codex", "command-r", "deepseek", "doubao",
        "ernie", "gemini", "gemma", "glm", "gpt", "grok", "hermes", "hy3", "hunyuan", "jamba",
        "kimi", "lfm", "llama", "longcat", "mercury", "mimo", "minimax", "mistral", "mixtral",
        "moonshot", "nemotron", "nova-", "openai", "qianfan", "qwen", "seed-", "solar", "stepfun",
    ];
    let rest = model_id.strip_prefix("claude-")?;
    NON_ANTHROPIC_MARKERS
        .iter()
        .any(|marker| rest.starts_with(marker))
        .then(|| rest.to_string())
}

fn strip_bedrock_version_suffix(model_id: &str) -> Option<String> {
    let (base, suffix) = model_id.rsplit_once("-v")?;
    (!base.is_empty() && !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_digit()))
        .then(|| base.to_string())
}

fn strip_model_date_suffix(model_id: &str) -> Option<String> {
    let bytes = model_id.as_bytes();
    // ISO 日期后缀 -YYYY-MM-DD
    if bytes.len() > 11 {
        let start = bytes.len() - 11;
        let suffix = &bytes[start..];
        let is_iso_date = suffix[0] == b'-'
            && suffix[1..5].iter().all(|b| b.is_ascii_digit())
            && suffix[5] == b'-'
            && suffix[6..8].iter().all(|b| b.is_ascii_digit())
            && suffix[8] == b'-'
            && suffix[9..11].iter().all(|b| b.is_ascii_digit());
        if is_iso_date {
            return Some(model_id[..start].to_string());
        }
    }
    // 紧凑日期后缀 -YYYYMMDD
    let (base, suffix) = model_id.rsplit_once('-')?;
    if base.is_empty() || suffix.len() != 8 || !suffix.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(base.to_string())
}

fn strip_reasoning_effort_suffix(model_id: &str) -> Option<String> {
    let (base, suffix) = model_id.rsplit_once('-')?;
    (!base.is_empty()
        && matches!(suffix, "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"))
    .then(|| base.to_string())
}

/// 生成查价候选列表（对齐 cc-switch model_pricing_candidates）
fn model_pricing_candidates(model_id: &str) -> Vec<String> {
    let cleaned = clean_model_id_for_pricing(model_id);
    if is_placeholder_model(&cleaned) {
        return Vec::new();
    }

    let mut candidates: Vec<String> = Vec::new();
    let mut queue = vec![cleaned];

    while let Some(candidate) = queue.pop() {
        if candidate.is_empty() || candidates.iter().any(|existing| existing == &candidate) {
            continue;
        }
        candidates.push(candidate.clone());

        if let Some(stripped) = strip_known_model_namespace(&candidate) {
            queue.push(stripped);
        }
        if let Some(stripped) = strip_claude_non_anthropic_prefix(&candidate) {
            queue.push(stripped);
        }
        if let Some(stripped) = strip_bedrock_version_suffix(&candidate) {
            queue.push(stripped);
        }
        if let Some(stripped) = strip_model_date_suffix(&candidate) {
            queue.push(stripped);
        }
        if let Some(stripped) = strip_reasoning_effort_suffix(&candidate) {
            queue.push(stripped);
        }
        if candidate.starts_with("claude-") && candidate.contains('.') {
            queue.push(candidate.replace('.', "-"));
        }
    }

    candidates
}

/// 按模型名缓存查价结果：定价表是编译期常量，缓存永不失效。
/// 聚合阶段每条记录都要查价，模糊匹配（候选生成 + 前缀扫描）较贵，
/// 而不同模型名通常只有几十个，缓存后查价从热路径上消失。
fn cached_model_pricing(model_id: &str) -> Option<&'static ModelPricing> {
    static MEMO: OnceLock<Mutex<HashMap<String, Option<&'static ModelPricing>>>> = OnceLock::new();
    let memo = MEMO.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(map) = memo.lock() {
        if let Some(cached) = map.get(model_id) {
            return *cached;
        }
    }
    let pricing = find_model_pricing(model_id);
    if let Ok(mut map) = memo.lock() {
        map.insert(model_id.to_string(), pricing);
    }
    pricing
}

/// models.dev 快照优先，旧表兜底。只移除已知装饰/日期，不能把未知型号猜成同系列变体。
fn find_model_pricing(model_id: &str) -> Option<&'static ModelPricing> {
    let candidates = model_pricing_candidates(model_id);
    if candidates.is_empty() {
        return None;
    }
    let reference = reference_pricing_map();
    for candidate in &candidates {
        if let Some(p) = reference.get(candidate) {
            return Some(p);
        }
    }
    let map = pricing_map();
    for candidate in &candidates {
        if let Some(p) = map.get(candidate.as_str()) {
            return Some(p);
        }
    }
    for candidate in &candidates {
        let mut best: Option<(&str, &'static ModelPricing)> = None;
        for (id, p) in map.iter() {
            if strip_model_date_suffix(id).as_ref() == Some(candidate) {
                match best {
                    Some((best_id, _)) if *id <= best_id => {}
                    _ => best = Some((id, p)),
                }
            }
        }
        if let Some((_, p)) = best {
            return Some(p);
        }
    }
    None
}

/// 输入 token 是否含缓存（Codex/OpenAI、Gemini、Grok 口径 input 含 cache read）
fn is_cache_inclusive_app(app: &str) -> bool {
    matches!(app, "codex" | "gemini" | "grok")
}

/// 新增输入（fresh input）：缓存包含型应用扣除缓存部分
fn fresh_input_tokens(record: &UsageRecord) -> u64 {
    if is_cache_inclusive_app(&record.app) {
        record
            .input_tokens
            .saturating_sub(record.cache_read_tokens)
            .saturating_sub(record.cache_creation_tokens)
    } else {
        record.input_tokens
    }
}

fn real_total_tokens(record: &UsageRecord) -> u64 {
    fresh_input_tokens(record) + record.output_tokens
        + record.cache_creation_tokens + record.cache_read_tokens
}

fn valid_reported_cost(record: &UsageRecord) -> Option<f64> {
    record.reported_cost.filter(|cost| cost.is_finite() && *cost >= 0.0)
}

impl ModelPricing {
    /// 按单条请求的提示长度（新增输入 + 缓存读取 + 缓存写入）选档，取超过的最高档。
    fn rates_for(&self, record: &UsageRecord) -> Pricing {
        let length = fresh_input_tokens(record) + record.cache_read_tokens + record.cache_creation_tokens;
        self.tiers
            .iter()
            .filter(|tier| length > tier.above)
            .max_by_key(|tier| tier.above)
            .map_or(self.rates, |tier| tier.rates)
    }
}

/// 未知价格保留 None，汇总显式记录缺失覆盖率；完整的上游费用优先。
fn record_cost(record: &UsageRecord) -> Option<f64> {
    let reported = valid_reported_cost(record);
    if reported.is_some() && !record.cost_partial {
        return reported;
    }
    match (local_record_cost(record), reported) {
        // 自报下界可能包含参考价无法覆盖的费用，不能被更低估算抹掉。
        (Some(local), Some(lower_bound)) => Some(local.max(lower_bound)),
        (local, reported) => local.or(reported),
    }
}

fn local_record_cost(record: &UsageRecord) -> Option<f64> {
    token_cost_breakdown(cached_model_pricing(&record.model)?, record).map(|b| b.total())
}

/// 按 token 分项估算（USD）；缓存分量有 token 但缺单价时整体为 None。
fn token_cost_breakdown(pricing: &ModelPricing, record: &UsageRecord) -> Option<UsageCostBreakdown> {
    let p = pricing.rates_for(record);
    let one_hour = record.cache_creation_1h_tokens.min(record.cache_creation_tokens);
    let component = |tokens: u64, rate: Option<f64>| {
        if tokens == 0 { Some(0.0) } else { rate.map(|r| tokens as f64 * r / 1e6) }
    };
    Some(UsageCostBreakdown {
        input: fresh_input_tokens(record) as f64 * p.input / 1e6,
        output: record.output_tokens as f64 * p.output / 1e6,
        cache_read: component(record.cache_read_tokens, p.cache_read)?,
        cache_creation: component(record.cache_creation_tokens - one_hour, p.cache_creation)?
            + component(one_hour, p.cache_creation_1h)?,
    })
}

/// 最近记录的成本分项：仅当金额完全来自本地按 token 估算时提供（自报成本无法拆分）。
fn record_cost_breakdown(record: &UsageRecord) -> Option<UsageCostBreakdown> {
    if valid_reported_cost(record).is_some() {
        return None;
    }
    token_cost_breakdown(cached_model_pricing(&record.model)?, record)
}

fn record_cost_is_partial(record: &UsageRecord) -> bool {
    if !record.cost_partial {
        return false;
    }
    let Some(reported) = valid_reported_cost(record) else { return false };
    local_record_cost(record).map_or(true, |local| reported > local)
}

// ---------------------------------------------------------------------------
// Claude Code 会话解析（对齐 cc-switch session_usage.rs）
// ---------------------------------------------------------------------------

fn claude_projects_dir() -> PathBuf {
    crate::home_dir().join(".claude").join("projects")
}

/// 固定深度收集 Claude 会话 JSONL：
/// 项目/*.jsonl、项目/SESSION_ID/subagents/*.jsonl、项目/SESSION_ID/subagents/workflows/wf_*/*.jsonl
fn collect_claude_jsonl_files(projects_dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let entries = match fs::read_dir(projects_dir) {
        Ok(e) => e,
        Err(_) => return files,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if let Ok(sub_entries) = fs::read_dir(&path) {
            for sub_entry in sub_entries.flatten() {
                let sub_path = sub_entry.path();
                if sub_path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                    files.push(sub_path);
                } else if sub_path.is_dir() {
                    let subagents_dir = sub_path.join("subagents");
                    if subagents_dir.is_dir() {
                        push_jsonl_children(&subagents_dir, &mut files);
                        let workflows_dir = subagents_dir.join("workflows");
                        if workflows_dir.is_dir() {
                            if let Ok(wf_entries) = fs::read_dir(&workflows_dir) {
                                for wf_entry in wf_entries.flatten() {
                                    let wf_path = wf_entry.path();
                                    if wf_path.is_dir() {
                                        push_jsonl_children(&wf_path, &mut files);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    files
}

fn push_jsonl_children(dir: &Path, files: &mut Vec<PathBuf>) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                files.push(path);
            }
        }
    }
}

struct ClaudeParsedMessage {
    model: String,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
    cache_creation_1h_tokens: u64,
    stop_reason: Option<String>,
    timestamp: Option<i64>,
    cwd: Option<String>,
    session_id: Option<String>,
}

fn parse_claude_file(path: &Path) -> Result<ParsedFile, String> {
    let file = fs::File::open(path).map_err(|e| format!("无法打开文件: {e}"))?;
    let reader = BufReader::new(file);
    let mut messages: HashMap<String, ClaudeParsedMessage> = HashMap::new();

    for line_result in reader.lines() {
        let line = match line_result {
            Ok(l) => l,
            Err(_) => continue, // 容忍不完整的最后一行
        };
        if line.trim().is_empty() {
            continue;
        }
        // 子串预筛：目标行必然同时含这两个键，其余行（user/tool 消息占大头）
        // 直接跳过，省去大 JSON 的完整解析
        if !line.contains("\"assistant\"") || !line.contains("\"usage\"") {
            continue;
        }
        let value: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if value.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }
        let Some(message) = value.get("message") else { continue };
        let Some(msg_id) = message.get("id").and_then(|v| v.as_str()) else { continue };
        let Some(usage) = message.get("usage") else { continue };

        let get_u64 = |key: &str| usage.get(key).and_then(|v| v.as_u64()).unwrap_or(0);
        let cache_detail = usage.get("cache_creation");
        let cache_5m = cache_detail
            .and_then(|detail| detail.get("ephemeral_5m_input_tokens"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let cache_1h = cache_detail
            .and_then(|detail| detail.get("ephemeral_1h_input_tokens"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let cache_creation_tokens = usage
            .get("cache_creation_input_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or_else(|| cache_5m.saturating_add(cache_1h));
        let parsed = ClaudeParsedMessage {
            model: message
                .get("model")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string(),
            input_tokens: get_u64("input_tokens"),
            output_tokens: get_u64("output_tokens"),
            cache_read_tokens: get_u64("cache_read_input_tokens"),
            cache_creation_tokens,
            cache_creation_1h_tokens: cache_1h.min(cache_creation_tokens),
            stop_reason: message
                .get("stop_reason")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            timestamp: value
                .get("timestamp")
                .and_then(|v| v.as_str())
                .and_then(parse_rfc3339_to_unix),
            cwd: non_empty_string(value.get("cwd")),
            session_id: non_empty_string(value.get("sessionId")),
        };

        // 按 message.id 去重：优先保留有 stop_reason 的条目，同态时取 output 更大者
        let should_replace = match messages.get(msg_id) {
            None => true,
            Some(existing) => {
                if parsed.stop_reason.is_some() && existing.stop_reason.is_none() {
                    true
                } else if parsed.stop_reason.is_some() == existing.stop_reason.is_some() {
                    parsed.output_tokens > existing.output_tokens
                } else {
                    false
                }
            }
        };
        if should_replace {
            messages.insert(msg_id.to_string(), parsed);
        }
    }

    let mut records = Vec::new();
    for (msg_id, msg) in messages {
        // 任一计费维度 > 0 即计入（Anthropic 对 input/cache 在请求受理时即计费）
        let has_billable = msg.input_tokens > 0
            || msg.output_tokens > 0
            || msg.cache_read_tokens > 0
            || msg.cache_creation_tokens > 0;
        if !has_billable {
            continue;
        }
        // 缺 timestamp 的消息无法归期，直接跳过。不能回退为“当前时间”：
        // 伪时间戳会把历史记录标进“今天 / 24 小时”等包含当前时刻的窗口，
        // 且解析结果入缓存后错误的归期会被固化。
        let Some(created_at) = msg.timestamp else { continue };
        records.push(UsageRecord {
            request_id: format!("session:{msg_id}"),
            app: "claude".to_string(),
            model: msg.model,
            input_tokens: msg.input_tokens,
            output_tokens: msg.output_tokens,
            cache_read_tokens: msg.cache_read_tokens,
            cache_creation_tokens: msg.cache_creation_tokens,
            cache_creation_1h_tokens: msg.cache_creation_1h_tokens,
            created_at,
            reported_cost: None,
            cost_partial: false,
            project: msg.cwd,
            session_id: msg.session_id,
        });
    }
    Ok(ParsedFile::Records(records))
}

// ---------------------------------------------------------------------------
// Codex 会话解析（对齐 cc-switch session_usage_codex.rs）
// ---------------------------------------------------------------------------

fn collect_codex_session_files(codex_dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let sessions_dir = codex_dir.join("sessions");
    if sessions_dir.is_dir() {
        collect_jsonl_recursive(&sessions_dir, &mut files, 0, 3);
    }
    let archived_dir = codex_dir.join("archived_sessions");
    if archived_dir.is_dir() {
        if let Ok(entries) = fs::read_dir(&archived_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                    files.push(path);
                }
            }
        }
    }
    files.sort();
    files
}

fn collect_jsonl_recursive(dir: &Path, files: &mut Vec<PathBuf>, depth: u32, max_depth: u32) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && depth < max_depth {
            collect_jsonl_recursive(&path, files, depth + 1, max_depth);
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            files.push(path);
        }
    }
}

/// 从文件名尾部提取线程 UUID（rollout-…-<uuid>.jsonl）
fn codex_thread_id_from_filename(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    let candidate = stem.get(stem.len().checked_sub(36)?..)?;
    let candidate = candidate.to_ascii_lowercase();
    let bytes = candidate.as_bytes();
    if bytes.len() != 36 {
        return None;
    }
    for (i, b) in bytes.iter().enumerate() {
        let ok = match i {
            8 | 13 | 18 | 23 => *b == b'-',
            _ => b.is_ascii_hexdigit(),
        };
        if !ok {
            return None;
        }
    }
    Some(candidate)
}

fn is_valid_uuid(s: &str) -> bool {
    let s = s.to_ascii_lowercase();
    let bytes = s.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(i, b)| match i {
        8 | 13 | 18 | 23 => *b == b'-',
        _ => b.is_ascii_hexdigit(),
    })
}

/// 归一化 Codex 模型名（小写 / 去 provider 前缀 / 去日期后缀）
fn normalize_codex_model(raw: &str) -> String {
    let mut name = raw.to_lowercase();
    if let Some(pos) = name.rfind('/') {
        name = name[pos + 1..].to_string();
    }
    // ISO 日期后缀 -YYYY-MM-DD
    if name.len() > 11 && name.is_char_boundary(name.len() - 11) {
        let suffix = &name[name.len() - 11..];
        if suffix.is_ascii()
            && suffix.as_bytes()[0] == b'-'
            && suffix[1..5].chars().all(|c| c.is_ascii_digit())
            && suffix.as_bytes()[5] == b'-'
            && suffix[6..8].chars().all(|c| c.is_ascii_digit())
            && suffix.as_bytes()[8] == b'-'
            && suffix[9..11].chars().all(|c| c.is_ascii_digit())
        {
            name.truncate(name.len() - 11);
        }
    }
    // 紧凑日期后缀 -YYYYMMDD
    if name.len() > 9 {
        if let Some((base, suffix)) = name.rsplit_once('-') {
            if suffix.len() == 8 && suffix.chars().all(|c| c.is_ascii_digit()) {
                name = base.to_string();
            }
        }
    }
    name
}

/// token 计数器签名（None 与 0 需区分，序列化成字符串便于比较）
fn signature_counters(value: Option<&serde_json::Value>) -> Option<String> {
    let obj = value?.as_object()?;
    let field = |primary: &str, fallback: Option<&str>| -> String {
        obj.get(primary)
            .or_else(|| fallback.and_then(|f| obj.get(f)))
            .and_then(serde_json::Value::as_u64)
            .map(|v| v.to_string())
            .unwrap_or_else(|| "n".to_string())
    };
    Some(format!(
        "{},{},{},{},{},{}",
        field("input_tokens", None),
        field("cached_input_tokens", Some("cache_read_input_tokens")),
        field("output_tokens", None),
        field("reasoning_output_tokens", None),
        field("total_tokens", None),
        field("cache_write_input_tokens", Some("cache_creation_input_tokens")),
    ))
}

fn parse_codex_token_signature(info: &serde_json::Value) -> Option<String> {
    let total = signature_counters(info.get("total_token_usage"));
    let last = signature_counters(info.get("last_token_usage"));
    if total.is_none() && last.is_none() {
        return None;
    }
    Some(format!(
        "T[{}]|L[{}]",
        total.unwrap_or_else(|| "-".to_string()),
        last.unwrap_or_else(|| "-".to_string()),
    ))
}

#[derive(Debug, Clone, Copy, Default)]
struct CodexCumulative {
    input: u64,
    cached_input: u64,
    output: u64,
    cache_write_input: u64,
}

fn parse_codex_cumulative(total_usage: &serde_json::Value) -> Option<CodexCumulative> {
    let fields = total_usage.as_object()?;
    if ![
        "input_tokens",
        "cached_input_tokens",
        "cache_read_input_tokens",
        "cache_write_input_tokens",
        "cache_creation_input_tokens",
        "output_tokens",
        "reasoning_output_tokens",
        "total_tokens",
    ]
    .iter()
    .any(|field| fields.contains_key(*field))
    {
        return None;
    }
    let get = |key: &str| total_usage.get(key).and_then(|v| v.as_u64()).unwrap_or(0);
    Some(CodexCumulative {
        input: get("input_tokens"),
        cached_input: total_usage
            .get("cached_input_tokens")
            .or_else(|| total_usage.get("cache_read_input_tokens"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        output: get("output_tokens"),
        cache_write_input: total_usage
            .get("cache_write_input_tokens")
            .or_else(|| total_usage.get("cache_creation_input_tokens"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
    })
}

fn codex_compute_delta(prev: &Option<CodexCumulative>, current: &CodexCumulative) -> (u32, u32, u32, u32) {
    match prev {
        None => (
            current.input.min(u32::MAX as u64) as u32,
            current.cached_input.min(u32::MAX as u64) as u32,
            current.output.min(u32::MAX as u64) as u32,
            current.cache_write_input.min(u32::MAX as u64) as u32,
        ),
        Some(p) => (
            current.input.saturating_sub(p.input).min(u32::MAX as u64) as u32,
            current
                .cached_input
                .saturating_sub(p.cached_input)
                .min(u32::MAX as u64) as u32,
            current.output.saturating_sub(p.output).min(u32::MAX as u64) as u32,
            current
                .cache_write_input
                .saturating_sub(p.cache_write_input)
                .min(u32::MAX as u64) as u32,
        ),
    }
}

fn non_empty_string(value: Option<&serde_json::Value>) -> Option<String> {
    value
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn codex_parent_from_meta(payload: &serde_json::Value) -> CodexParent {
    let forked_from = non_empty_string(payload.get("forked_from_id"));
    let spawned_from = payload
        .get("source")
        .and_then(|source| source.get("subagent"))
        .and_then(|subagent| subagent.get("thread_spawn"))
        .and_then(|spawn| non_empty_string(spawn.get("parent_thread_id")));

    match (forked_from, spawned_from) {
        (None, None) => CodexParent::None,
        (Some(parent), None) | (None, Some(parent)) => CodexParent::Parent(parent),
        (Some(forked), Some(spawned)) if forked == spawned => CodexParent::Parent(forked),
        (Some(forked), Some(spawned)) => CodexParent::Deferred(format!(
            "forked_from_id ({forked}) 与 thread_spawn.parent_thread_id ({spawned}) 不一致"
        )),
    }
}

fn parse_codex_file(path: &Path) -> Result<ParsedFile, String> {
    let root_thread_id = codex_thread_id_from_filename(path);
    let file = fs::File::open(path).map_err(|e| format!("无法打开文件: {e}"))?;
    let reader = BufReader::new(file);

    let mut root_meta_seen = false;
    let mut root_ts: Option<i64> = None;
    let mut parent = CodexParent::None;
    let mut current_model = "unknown".to_string();
    // total_token_usage 是会话累计值；用高水位差分兜底，优先 last_token_usage 精确值
    let mut total_high_water: Option<CodexCumulative> = None;
    // 限流刷新会以另一 limit_id 重发相同 token 快照；同 source 比最新快照，跨 source 比上一事件
    let mut last_signature_by_source: HashMap<Option<String>, String> = HashMap::new();
    let mut previous_token_signature: Option<String> = None;
    let mut event_index: u32 = 0;
    let mut events: Vec<CodexTokenEvent> = Vec::new();
    let mut has_billable_tokens = false;
    let mut has_token_without_timestamp = false;
    let mut max_event_ts: Option<i64> = None;
    let mut cwd: Option<String> = None;

    for line_result in reader.lines() {
        let line = match line_result {
            Ok(line) => line,
            Err(_) => continue,
        };
        if line.trim().is_empty() {
            continue;
        }
        let is_event_msg = line.contains("\"event_msg\"");
        let is_turn_context = line.contains("\"turn_context\"");
        let is_session_meta = line.contains("\"session_meta\"");
        if !is_event_msg && !is_turn_context && !is_session_meta {
            continue;
        }
        if is_event_msg && !line.contains("\"token_count\"") {
            continue;
        }
        let value: serde_json::Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let Some(event_type) = value.get("type").and_then(serde_json::Value::as_str) else {
            continue;
        };

        match event_type {
            "session_meta" if !root_meta_seen => {
                root_meta_seen = true;
                root_ts = value
                    .get("timestamp")
                    .and_then(|v| v.as_str())
                    .and_then(parse_rfc3339_to_unix);
                let payload = value.get("payload").cloned().unwrap_or(serde_json::Value::Null);
                parent = codex_parent_from_meta(&payload);
                cwd = non_empty_string(payload.get("cwd"));

                let meta_thread_id = non_empty_string(
                    payload
                        .get("id")
                        .or_else(|| payload.get("thread_id"))
                        .or_else(|| payload.get("threadId")),
                );
                if let (Some(filename_id), Some(meta_id)) = (&root_thread_id, meta_thread_id) {
                    if !filename_id.eq_ignore_ascii_case(&meta_id) {
                        parent = CodexParent::Deferred(format!(
                            "文件名线程 ID ({filename_id}) 与 root meta ID ({meta_id}) 不一致"
                        ));
                    }
                }
                parent = match parent {
                    CodexParent::Parent(parent_id) => {
                        if is_valid_uuid(&parent_id) {
                            CodexParent::Parent(parent_id.to_ascii_lowercase())
                        } else {
                            CodexParent::Deferred(format!(
                                "显式 parent_thread_id 不是有效 UUID: {parent_id}"
                            ))
                        }
                    }
                    other => other,
                };
                let parent_is_root = matches!(
                    (&root_thread_id, &parent),
                    (Some(root), CodexParent::Parent(parent_id)) if root == parent_id
                );
                if parent_is_root {
                    parent = CodexParent::Deferred(
                        "parent_thread_id 与 root_thread_id 相同".to_string(),
                    );
                }
            }
            "turn_context" => {
                if let Some(payload) = value.get("payload") {
                    if let Some(model) = payload
                        .get("model")
                        .or_else(|| payload.get("info").and_then(|info| info.get("model")))
                        .and_then(serde_json::Value::as_str)
                    {
                        current_model = normalize_codex_model(model);
                    }
                }
            }
            "event_msg" => {
                let Some(payload) = value.get("payload") else { continue };
                if payload.get("type").and_then(serde_json::Value::as_str) != Some("token_count") {
                    continue;
                }
                let Some(info) = payload.get("info").filter(|info| !info.is_null()) else {
                    continue;
                };
                let Some(signature) = parse_codex_token_signature(info) else {
                    continue;
                };

                if let Some(model) = info
                    .get("model")
                    .or_else(|| info.get("model_name"))
                    .or_else(|| payload.get("model"))
                    .and_then(serde_json::Value::as_str)
                {
                    current_model = normalize_codex_model(model);
                }

                let snapshot_source = payload
                    .get("rate_limits")
                    .and_then(|rate_limits| rate_limits.get("limit_id"))
                    .and_then(serde_json::Value::as_str)
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned);

                let total = info.get("total_token_usage").and_then(parse_codex_cumulative);
                let last = info.get("last_token_usage").and_then(parse_codex_cumulative);
                if total.is_none() && last.is_none() {
                    continue;
                }
                let has_total_snapshot = total.is_some();
                let duplicate_snapshot = has_total_snapshot
                    && (last_signature_by_source.get(&snapshot_source) == Some(&signature)
                        || previous_token_signature.as_ref() == Some(&signature));
                if has_total_snapshot {
                    last_signature_by_source.insert(snapshot_source, signature.clone());
                }
                previous_token_signature = Some(signature.clone());

                let delta: (u32, u32, u32, u32) = if duplicate_snapshot {
                    (0, 0, 0, 0)
                } else if let Some(last) = last {
                    // Codex 提供逐请求精确用量时优先采用（累计快照可能来自多条独立限流通道）
                    (
                        last.input.min(u32::MAX as u64) as u32,
                        last.cached_input.min(u32::MAX as u64) as u32,
                        last.output.min(u32::MAX as u64) as u32,
                        last.cache_write_input.min(u32::MAX as u64) as u32,
                    )
                } else if let Some(total) = total.as_ref() {
                    codex_compute_delta(&total_high_water, total)
                } else {
                    continue;
                };
                if let Some(total) = total {
                    if let Some(high_water) = total_high_water.as_mut() {
                        high_water.input = high_water.input.max(total.input);
                        high_water.cached_input = high_water.cached_input.max(total.cached_input);
                        high_water.output = high_water.output.max(total.output);
                        high_water.cache_write_input =
                            high_water.cache_write_input.max(total.cache_write_input);
                    } else {
                        total_high_water = Some(total);
                    }
                }
                // 缓存读取、写入都是 input 的子集，避免畸形日志扩大总量。
                let cached_read = delta.1.min(delta.0);
                let delta = (
                    delta.0,
                    cached_read,
                    delta.2,
                    delta.3.min(delta.0 - cached_read),
                );
                let nonzero_index = if delta.0 == 0 && delta.1 == 0 && delta.2 == 0 {
                    None
                } else {
                    has_billable_tokens = true;
                    event_index = event_index.saturating_add(1);
                    Some(event_index)
                };

                let ts_unix = value
                    .get("timestamp")
                    .and_then(|v| v.as_str())
                    .and_then(parse_rfc3339_to_unix);
                match ts_unix {
                    Some(ts) => max_event_ts = Some(max_event_ts.map_or(ts, |m: i64| m.max(ts))),
                    None => has_token_without_timestamp = true,
                }

                events.push(CodexTokenEvent {
                    signature,
                    ts_unix,
                    delta,
                    event_index: nonzero_index,
                    model: current_model.clone(),
                });
            }
            _ => {}
        }
    }

    Ok(ParsedFile::Codex(ParsedCodexFile {
        root_thread_id,
        root_meta_seen,
        root_ts,
        parent,
        events,
        has_billable_tokens,
        has_token_without_timestamp,
        max_event_ts,
        cwd,
    }))
}

/// 子会话回放前缀匹配：子文件开头若逐一命中父线程的 token 签名序列，则这些事件是
/// fork 时复制的父线程历史，必须跳过避免双算（对齐 cc-switch matching_replay_prefix）
fn matching_replay_prefix(child: &[CodexTokenEvent], parent: &[String]) -> usize {
    let mut parent_offset = 0usize;
    let mut matched = 0usize;
    for event in child {
        let Some(relative_match) = parent[parent_offset..]
            .iter()
            .position(|signature| signature == &event.signature)
        else {
            break;
        };
        parent_offset += relative_match + 1;
        matched += 1;
    }
    matched
}

// ---------------------------------------------------------------------------
// Gemini CLI 会话解析（对齐 cc-switch session_usage_gemini.rs）
// ---------------------------------------------------------------------------

fn collect_gemini_session_files(gemini_dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let tmp_dir = gemini_dir.join("tmp");
    if !tmp_dir.is_dir() {
        return files;
    }
    let project_dirs = match fs::read_dir(&tmp_dir) {
        Ok(entries) => entries,
        Err(_) => return files,
    };
    for entry in project_dirs.flatten() {
        let chats_dir = entry.path().join("chats");
        if !chats_dir.is_dir() {
            continue;
        }
        let chat_files = match fs::read_dir(&chats_dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for file_entry in chat_files.flatten() {
            let path = file_entry.path();
            let is_session = path
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("session-") && n.ends_with(".json"))
                .unwrap_or(false);
            if is_session {
                files.push(path);
            }
        }
    }
    files
}

const MAX_GEMINI_FILE_BYTES: u64 = 50 * 1024 * 1024;

fn parse_gemini_file(path: &Path) -> Result<ParsedFile, String> {
    // 安全：限制单文件大小，避免超大 JSON 一次性读入内存导致资源耗尽（超限则跳过）。
    let metadata = fs::metadata(path).map_err(|e| format!("无法读取文件元数据: {e}"))?;
    if metadata.len() > MAX_GEMINI_FILE_BYTES {
        return Ok(ParsedFile::Records(Vec::new()));
    }
    let content = fs::read_to_string(path).map_err(|e| format!("无法读取文件: {e}"))?;
    let value: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("JSON 解析失败: {e}"))?;

    let session_id = value
        .get("sessionId")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();

    let mut records = Vec::new();
    let Some(messages) = value.get("messages").and_then(|v| v.as_array()) else {
        return Ok(ParsedFile::Records(records));
    };

    for msg in messages {
        if msg.get("type").and_then(|t| t.as_str()) != Some("gemini") {
            continue;
        }
        let Some(tokens) = msg.get("tokens").filter(|t| t.is_object()) else { continue };
        let get = |key: &str| tokens.get(key).and_then(|v| v.as_u64()).unwrap_or(0);
        let input = get("input");
        let output = get("output");
        let cached = get("cached");
        let thoughts = get("thoughts");
        if input == 0 && output == 0 && thoughts == 0 && cached == 0 {
            continue;
        }
        let message_id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("unknown");
        let model = msg
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();
        // 缺 timestamp 的消息无法归期，跳过（理由同 Claude 解析处）
        let Some(created_at) = msg
            .get("timestamp")
            .and_then(|v| v.as_str())
            .and_then(parse_rfc3339_to_unix)
        else {
            continue;
        };

        records.push(UsageRecord {
            request_id: format!("gemini_session:{session_id}:{message_id}"),
            app: "gemini".to_string(),
            model,
            input_tokens: input,
            // 思考 token 按输出计费（对齐 cc-switch）
            output_tokens: output + thoughts,
            cache_read_tokens: cached,
            cache_creation_tokens: 0,
            cache_creation_1h_tokens: 0,
            created_at,
            reported_cost: None,
            cost_partial: false,
            project: None,
            session_id: (session_id != "unknown").then(|| session_id.clone()),
        });
    }
    Ok(ParsedFile::Records(records))
}

// ---------------------------------------------------------------------------
// Grok CLI 会话解析（对齐 cc-switch session_usage_grokbuild.rs）
// ---------------------------------------------------------------------------

const MAX_GROK_FILE_BYTES: u64 = 50 * 1024 * 1024;
const MAX_GROK_COLLECT_DEPTH: usize = 16;

fn collect_grok_updates_files(grok_dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for root in [grok_dir.join("sessions"), grok_dir.join("archived_sessions")] {
        collect_files_named(&root, "updates.jsonl", &mut files, 0);
    }
    files
}

fn collect_files_named(root: &Path, name: &str, files: &mut Vec<PathBuf>, depth: usize) {
    if depth > MAX_GROK_COLLECT_DEPTH {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // 无条件跳过 symlink，避免目录循环或读入 sessions 根之外的内容
        let metadata = entry.metadata();
        if metadata.as_ref().map(|m| m.is_symlink()).unwrap_or(false) {
            continue;
        }
        let is_dir = metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        if is_dir {
            collect_files_named(&path, name, files, depth + 1);
        } else if path.file_name().and_then(|n| n.to_str()) == Some(name) {
            files.push(path);
        }
    }
}

/// updates.jsonl 顶层 timestamp 是数字 epoch 秒（字符串 RFC3339 兜底）
fn parse_grok_event_timestamp(value: Option<&serde_json::Value>) -> Option<i64> {
    let value = value?;
    if let Some(n) = value.as_i64() {
        return Some(if n > 100_000_000_000 { n / 1000 } else { n });
    }
    value.as_str().and_then(parse_rfc3339_to_unix)
}

#[derive(Debug, Clone, Copy, Default)]
struct GrokCounters {
    input: u64,
    output: u64,
    cached: u64,
    /// 缺失与显式 0 不同：0 也是完整的上游自报成本。
    cost_ticks: Option<u64>,
    cost_partial: bool,
}

fn parse_grok_counters(value: &serde_json::Value) -> GrokCounters {
    let get = |key: &str| value.get(key).and_then(|v| v.as_u64()).unwrap_or(0);
    GrokCounters {
        input: get("inputTokens"),
        output: get("outputTokens"),
        cached: get("cachedReadTokens"),
        cost_ticks: value.get("costUsdTicks").and_then(|v| v.as_u64()),
        cost_partial: value
            .get("costIsPartial")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
    }
}

fn parse_grok_file(path: &Path) -> Result<ParsedFile, String> {
    let metadata = fs::metadata(path).map_err(|e| format!("无法读取文件元数据: {e}"))?;
    if metadata.len() > MAX_GROK_FILE_BYTES {
        return Ok(ParsedFile::Records(Vec::new()));
    }
    let content = fs::read_to_string(path).map_err(|e| format!("无法读取文件: {e}"))?;

    // 会话 ID = 会话目录名（UUIDv7，全局唯一）
    let session_id = path
        .parent()
        .and_then(|dir| dir.file_name())
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    let mut records: Vec<UsageRecord> = Vec::new();
    for (idx, line) in content.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(record) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if record.get("method").and_then(|v| v.as_str()) != Some("_x.ai/session/update") {
            continue;
        }
        let update = record.get("params").and_then(|p| p.get("update"));
        // 只认 turn_completed（逐轮独立总量）；字段缺失时向后兼容放行
        let kind = update
            .and_then(|u| u.get("sessionUpdate"))
            .and_then(|v| v.as_str());
        if kind.is_some() && kind != Some("turn_completed") {
            continue;
        }
        let Some(usage) = update.and_then(|u| u.get("usage")).filter(|u| u.is_object()) else {
            continue;
        };
        let Some(created_at) = parse_grok_event_timestamp(record.get("timestamp")) else {
            continue;
        };
        let prompt_id = update
            .and_then(|u| u.get("prompt_id"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let event_cost_partial = usage
            .get("costIsPartial")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let mut per_model: Vec<(String, GrokCounters)> = usage
            .get("modelUsage")
            .and_then(|m| m.as_object())
            .map(|map| {
                map.iter()
                    .map(|(model, counters)| (model.clone(), parse_grok_counters(counters)))
                    .collect()
            })
            .unwrap_or_default();
        if per_model.is_empty() {
            per_model.push(("unknown".to_string(), parse_grok_counters(usage)));
        }
        per_model.sort_by(|a, b| a.0.cmp(&b.0));

        for (model, turn) in per_model {
            if turn.input == 0 && turn.output == 0 && turn.cached == 0 {
                continue;
            }
            let turn_key = if prompt_id.is_empty() {
                format!("idx{idx}")
            } else {
                prompt_id.clone()
            };
            let reported_cost = turn.cost_ticks
                .map(|ticks| ticks as f64 / 10_000_000_000.0);
            records.push(UsageRecord {
                request_id: format!("grok_session:{session_id}:{turn_key}:{model}"),
                app: "grok".to_string(),
                model,
                input_tokens: turn.input,
                output_tokens: turn.output,
                cache_read_tokens: turn.cached,
                cache_creation_tokens: 0,
                cache_creation_1h_tokens: 0,
                created_at,
                reported_cost,
                cost_partial: event_cost_partial || turn.cost_partial,
                project: None,
                session_id: (session_id != "unknown").then(|| session_id.clone()),
            });
        }
    }
    Ok(ParsedFile::Records(records))
}

// ---------------------------------------------------------------------------
// 汇总输出结构
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub total_requests: u64,
    pub unpriced_requests: u64,
    pub partial_cost_requests: u64,
    pub total_cost: f64,
    /// 新增输入（fresh input，已归一化）
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    /// 真实消耗 = fresh_input + output + cache_creation + cache_read
    pub real_total_tokens: u64,
    /// 缓存命中率 = cache_read / (fresh_input + cache_creation + cache_read)
    pub cache_hit_rate: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUsageSummary {
    pub app: String,
    pub summary: UsageSummary,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyUsage {
    pub date: String,
    pub requests: u64,
    pub unpriced_requests: u64,
    pub partial_cost_requests: u64,
    pub cost: f64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub total_tokens: u64,
}

/// 分时趋势（短时间范围下按本地小时分组，替代粒度过粗的按天视图）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HourlyUsage {
    /// 该小时（本地整点）起点对应的 unix 秒
    pub hour_start_ts: i64,
    pub requests: u64,
    pub unpriced_requests: u64,
    pub partial_cost_requests: u64,
    pub cost: f64,
    pub total_tokens: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsageStat {
    pub model: String,
    pub app: String,
    pub requests: u64,
    pub unpriced_requests: u64,
    pub partial_cost_requests: u64,
    pub total_tokens: u64,
    pub cost: f64,
    /// 该模型自身的缓存命中率；None 表示没有可缓存输入（无法计算）
    pub cache_hit_rate: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentUsageLog {
    pub time: i64,
    pub app: String,
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_creation_1h_tokens: u64,
    pub total_tokens: u64,
    pub cost: Option<f64>,
    pub cost_partial: bool,
    pub cost_breakdown: Option<UsageCostBreakdown>,
    pub project: Option<String>,
    pub session_id: Option<String>,
}

/// 单条请求的成本分项（USD）；缓存写入含一小时缓存
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageCostBreakdown {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_creation: f64,
}

impl UsageCostBreakdown {
    fn total(&self) -> f64 {
        self.input + self.output + self.cache_read + self.cache_creation
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageDashboard {
    pub pricing_source: String,
    pub pricing_date: String,
    pub summary: UsageSummary,
    /// 上一个等长时间窗的汇总（起止均已知时提供，用于环比）
    pub prev_summary: Option<UsageSummary>,
    pub by_app: Vec<AppUsageSummary>,
    pub daily: Vec<DailyUsage>,
    /// 时间窗 ≤ 48 小时时按本地小时分组的趋势，否则为空
    pub hourly: Vec<HourlyUsage>,
    pub models: Vec<ModelUsageStat>,
    pub recent: Vec<RecentUsageLog>,
    /// 当前应用筛选下可选的模型列表（忽略模型筛选，用于级联下拉）
    pub available_models: Vec<String>,
    pub files_scanned: u32,
    pub deferred_files: u32,
    pub parse_errors: Vec<String>,
    pub generated_at: i64,
}

// ---------------------------------------------------------------------------
// 全量收集
// ---------------------------------------------------------------------------

struct CollectOutcome {
    records: Vec<UsageRecord>,
    files_scanned: u32,
    deferred_files: u32,
    errors: Vec<String>,
}

fn collect_all_records(data_dir: &Path) -> CollectOutcome {
    let mut outcome = CollectOutcome {
        records: Vec::new(),
        files_scanned: 0,
        deferred_files: 0,
        errors: Vec::new(),
    };

    // 磁盘缓存：应用重启后无需全量重新解析历史日志
    load_disk_cache_once(data_dir);

    // ---- Claude ----
    let claude_files = collect_claude_jsonl_files(&claude_projects_dir());
    for path in &claude_files {
        outcome.files_scanned += 1;
        match parse_file_cached(path, parse_claude_file) {
            Ok(ParsedFile::Records(records)) => outcome.records.extend(records),
            Ok(_) => {}
            Err(e) => outcome.errors.push(format!("{}: {e}", path.display())),
        }
    }

    // ---- Gemini ----
    let gemini_files = collect_gemini_session_files(&crate::home_dir().join(".gemini"));
    for path in &gemini_files {
        outcome.files_scanned += 1;
        match parse_file_cached(path, parse_gemini_file) {
            Ok(ParsedFile::Records(records)) => outcome.records.extend(records),
            Ok(_) => {}
            Err(e) => outcome.errors.push(format!("{}: {e}", path.display())),
        }
    }

    // ---- Grok ----
    let grok_files = collect_grok_updates_files(&crate::grok_config_dir());
    for path in &grok_files {
        outcome.files_scanned += 1;
        match parse_file_cached(path, parse_grok_file) {
            Ok(ParsedFile::Records(records)) => outcome.records.extend(records),
            Ok(_) => {}
            Err(e) => outcome.errors.push(format!("{}: {e}", path.display())),
        }
    }

    // ---- Codex（需要两阶段：先全部解析，再按父线程去除 fork 回放前缀） ----
    let codex_files = collect_codex_session_files(&crate::codex_config_dir());
    let mut parsed_codex: Vec<(PathBuf, ParsedCodexFile)> = Vec::new();
    for path in &codex_files {
        outcome.files_scanned += 1;
        match parse_file_cached(path, parse_codex_file) {
            Ok(ParsedFile::Codex(parsed)) => parsed_codex.push((path.clone(), parsed)),
            Ok(_) => {}
            Err(e) => outcome.errors.push(format!("{}: {e}", path.display())),
        }
    }

    // rollout 索引：thread_id → 文件（同一线程可能同时存在于 sessions 与 archived）
    let mut rollout_index: HashMap<String, Vec<usize>> = HashMap::new();
    for (idx, (path, _)) in parsed_codex.iter().enumerate() {
        if let Some(thread_id) = codex_thread_id_from_filename(path) {
            rollout_index.entry(thread_id).or_default().push(idx);
        }
    }

    // 父线程时间线：cutoff 之前的签名序列
    let parent_signatures_before = |parent_idx: usize, cutoff: i64| -> Result<Vec<String>, String> {
        let (path, parsed) = &parsed_codex[parent_idx];
        if parsed.has_token_without_timestamp {
            return Err(format!(
                "父 rollout {} 的 token_count 缺少有效 timestamp",
                path.display()
            ));
        }
        // 以事件最大时间戳与文件 mtime 秒的较大者近似「文件已写到的时刻」
        let mtime_secs = fs::metadata(path)
            .ok()
            .map(|m| metadata_modified_nanos(&m) / 1_000_000_000)
            .unwrap_or(0);
        let max_seen = parsed.max_event_ts.unwrap_or(0).max(mtime_secs);
        if max_seen < cutoff {
            return Err(format!(
                "父 rollout {} 尚未写到 child fork 时刻",
                path.display()
            ));
        }
        Ok(parsed
            .events
            .iter()
            .filter(|event| event.ts_unix.map(|ts| ts <= cutoff).unwrap_or(false))
            .map(|event| event.signature.clone())
            .collect())
    };

    for (path, parsed) in &parsed_codex {
        if !parsed.has_billable_tokens {
            continue;
        }
        let Some(root_thread_id) = parsed.root_thread_id.as_deref() else {
            outcome.deferred_files += 1;
            continue;
        };
        if !parsed.root_meta_seen {
            outcome.deferred_files += 1;
            continue;
        }

        let replay_prefix = match &parsed.parent {
            CodexParent::None => 0,
            CodexParent::Deferred(_) => {
                outcome.deferred_files += 1;
                continue;
            }
            CodexParent::Parent(parent_id) => {
                let Some(cutoff) = parsed.root_ts else {
                    outcome.deferred_files += 1;
                    continue;
                };
                let Some(candidates) = rollout_index.get(parent_id) else {
                    outcome.deferred_files += 1;
                    continue;
                };
                // 多个同 thread 文件的快照必须一致，否则延后
                let mut snapshots: Vec<Vec<String>> = Vec::with_capacity(candidates.len());
                let mut failed = false;
                for &candidate_idx in candidates {
                    match parent_signatures_before(candidate_idx, cutoff) {
                        Ok(snapshot) => snapshots.push(snapshot),
                        Err(_) => {
                            failed = true;
                            break;
                        }
                    }
                }
                if failed || snapshots.is_empty() {
                    outcome.deferred_files += 1;
                    continue;
                }
                let first = &snapshots[0];
                if snapshots.iter().skip(1).any(|snapshot| snapshot != first) {
                    outcome.deferred_files += 1;
                    continue;
                }
                matching_replay_prefix(&parsed.events, first)
            }
        };

        for (token_offset, event) in parsed.events.iter().enumerate() {
            let Some(event_index) = event.event_index else { continue };
            if token_offset < replay_prefix {
                continue;
            }
            // 缺 timestamp 的 token 事件无法归期，跳过（理由同 Claude 解析处）
            let Some(created_at) = event.ts_unix else { continue };
            outcome.records.push(UsageRecord {
                request_id: format!("codex_session:thread-v1:{root_thread_id}:{event_index}"),
                app: "codex".to_string(),
                model: event.model.clone(),
                input_tokens: event.delta.0 as u64,
                output_tokens: event.delta.2 as u64,
                cache_read_tokens: event.delta.1 as u64,
                cache_creation_tokens: event.delta.3 as u64,
                cache_creation_1h_tokens: 0,
                created_at,
                reported_cost: None,
                cost_partial: false,
                project: parsed.cwd.clone(),
                session_id: Some(root_thread_id.to_string()),
            });
        }
        let _ = path;
    }

    // 本轮扫描到的全部文件路径，用于剔除缓存里已删除的文件并落盘
    let live_paths: HashSet<PathBuf> = claude_files
        .iter()
        .chain(gemini_files.iter())
        .chain(grok_files.iter())
        .chain(codex_files.iter())
        .cloned()
        .collect();
    persist_disk_cache(data_dir, &live_paths);

    outcome
}

// ---------------------------------------------------------------------------
// 聚合与 Tauri command
// ---------------------------------------------------------------------------

fn summarize(records: &[&UsageRecord]) -> UsageSummary {
    let mut summary = UsageSummary::default();
    for record in records {
        summary.total_requests += 1;
        let cost = record_cost(record);
        summary.total_cost += cost.unwrap_or(0.0);
        summary.unpriced_requests += u64::from(cost.is_none());
        summary.partial_cost_requests += u64::from(record_cost_is_partial(record));
        summary.input_tokens += fresh_input_tokens(record);
        summary.output_tokens += record.output_tokens;
        summary.cache_read_tokens += record.cache_read_tokens;
        summary.cache_creation_tokens += record.cache_creation_tokens;
    }
    summary.real_total_tokens = summary.input_tokens
        + summary.output_tokens
        + summary.cache_creation_tokens
        + summary.cache_read_tokens;
    let cacheable =
        summary.input_tokens + summary.cache_creation_tokens + summary.cache_read_tokens;
    summary.cache_hit_rate = if cacheable > 0 {
        summary.cache_read_tokens as f64 / cacheable as f64
    } else {
        0.0
    };
    summary
}

/// 获取用量监控面板数据。
///
/// - `start_ts` / `end_ts`：unix 秒过滤区间（含端点），None 表示不限制
/// - `app`：claude / codex / gemini / grok，None 表示全部
/// - `model`：精确模型名过滤，None 表示全部
/// - `tz_offset_minutes`：JS `new Date().getTimezoneOffset()` 的值（UTC−本地，分钟），
///   用于按本地日期分组每日趋势
///
/// 必须是 async command：Tauri 同步 command 在主线程执行，全量扫描会话日志
/// 会冻结整个 UI（表现为加载动画永远转圈）。这里转投阻塞线程池。
#[tauri::command]
pub async fn get_usage_dashboard(
    app_handle: tauri::AppHandle,
    start_ts: Option<i64>,
    end_ts: Option<i64>,
    app: Option<String>,
    model: Option<String>,
    tz_offset_minutes: Option<i32>,
) -> Result<UsageDashboard, String> {
    let data_dir = crate::data_dir(&app_handle);
    tauri::async_runtime::spawn_blocking(move || {
        compute_usage_dashboard(&data_dir, start_ts, end_ts, app, model, tz_offset_minutes)
    })
    .await
    .map_err(|e| format!("用量统计任务执行失败: {e}"))?
}

fn compute_usage_dashboard(
    data_dir: &Path,
    start_ts: Option<i64>,
    end_ts: Option<i64>,
    app: Option<String>,
    model: Option<String>,
    tz_offset_minutes: Option<i32>,
) -> Result<UsageDashboard, String> {
    let outcome = collect_all_records(data_dir);
    Ok(aggregate_usage_dashboard(outcome, start_ts, end_ts, app, model, tz_offset_minutes))
}

fn aggregate_usage_dashboard(
    outcome: CollectOutcome,
    start_ts: Option<i64>,
    end_ts: Option<i64>,
    app: Option<String>,
    model: Option<String>,
    tz_offset_minutes: Option<i32>,
) -> UsageDashboard {

    // 全局按 request_id 去重（等价于 cc-switch 的 INSERT OR IGNORE 主键去重）
    let mut seen: HashMap<&str, usize> = HashMap::new();
    let mut deduped: Vec<&UsageRecord> = Vec::with_capacity(outcome.records.len());
    for record in &outcome.records {
        if seen.contains_key(record.request_id.as_str()) {
            continue;
        }
        seen.insert(record.request_id.as_str(), deduped.len());
        deduped.push(record);
    }

    let app_filter = app.as_deref().filter(|s| !s.is_empty() && *s != "all");
    let model_filter = model.as_deref().filter(|s| !s.is_empty() && *s != "all");

    let in_range = |record: &UsageRecord| -> bool {
        if let Some(start) = start_ts {
            if record.created_at < start {
                return false;
            }
        }
        if let Some(end) = end_ts {
            if record.created_at > end {
                return false;
            }
        }
        true
    };

    // 应用 + 时间过滤（不含模型过滤，用于级联模型下拉）
    let app_scoped: Vec<&UsageRecord> = deduped
        .iter()
        .copied()
        .filter(|record| in_range(record))
        .filter(|record| app_filter.map(|a| record.app == a).unwrap_or(true))
        .collect();

    let mut available_models: Vec<String> = Vec::new();
    for record in &app_scoped {
        if !available_models.iter().any(|m| m == &record.model) {
            available_models.push(record.model.clone());
        }
    }
    available_models.sort();

    // 最终过滤集合
    let filtered: Vec<&UsageRecord> = app_scoped
        .iter()
        .copied()
        .filter(|record| model_filter.map(|m| record.model == m).unwrap_or(true))
        .collect();

    let summary = summarize(&filtered);

    // 上一个等长时间窗的汇总（环比基准）：仅起止均已知时可计算
    let prev_summary = match (start_ts, end_ts) {
        (Some(start), Some(end)) if end >= start => {
            let span = end - start + 1;
            let prev_start = start - span;
            let prev_end = start - 1;
            let prev: Vec<&UsageRecord> = deduped
                .iter()
                .copied()
                .filter(|r| r.created_at >= prev_start && r.created_at <= prev_end)
                .filter(|r| app_filter.map(|a| r.app == a).unwrap_or(true))
                .filter(|r| model_filter.map(|m| r.model == m).unwrap_or(true))
                .collect();
            Some(summarize(&prev))
        }
        _ => None,
    };

    // 按应用拆分
    let mut by_app: Vec<AppUsageSummary> = Vec::new();
    for app_name in ["claude", "codex", "gemini", "grok"] {
        let subset: Vec<&UsageRecord> = filtered
            .iter()
            .copied()
            .filter(|record| record.app == app_name)
            .collect();
        if subset.is_empty() {
            continue;
        }
        by_app.push(AppUsageSummary {
            app: app_name.to_string(),
            summary: summarize(&subset),
        });
    }

    // 每日趋势（按本地日期分组）
    let tz_offset_secs = tz_offset_minutes.unwrap_or(0) as i64 * 60;
    let mut daily_map: HashMap<i64, DailyUsage> = HashMap::new();
    for record in &filtered {
        let local_ts = record.created_at - tz_offset_secs;
        let day = local_ts.div_euclid(86400);
        let entry = daily_map.entry(day).or_insert_with(|| {
            let (y, m, d) = civil_from_days(day);
            DailyUsage {
                date: format!("{y:04}-{m:02}-{d:02}"),
                requests: 0,
                unpriced_requests: 0,
                partial_cost_requests: 0,
                cost: 0.0,
                input_tokens: 0,
                output_tokens: 0,
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
                total_tokens: 0,
            }
        });
        let fresh = fresh_input_tokens(record);
        entry.requests += 1;
        let cost = record_cost(record);
        entry.cost += cost.unwrap_or(0.0);
        entry.unpriced_requests += u64::from(cost.is_none());
        entry.partial_cost_requests += u64::from(record_cost_is_partial(record));
        entry.input_tokens += fresh;
        entry.output_tokens += record.output_tokens;
        entry.cache_read_tokens += record.cache_read_tokens;
        entry.cache_creation_tokens += record.cache_creation_tokens;
        entry.total_tokens += real_total_tokens(record);
    }
    let mut daily: Vec<DailyUsage> = {
        let mut pairs: Vec<(i64, DailyUsage)> = daily_map.into_iter().collect();
        pairs.sort_by_key(|(day, _)| *day);
        pairs.into_iter().map(|(_, v)| v).collect()
    };
    // 防御：极端情况下限制返回长度
    if daily.len() > 1000 {
        daily = daily.split_off(daily.len() - 1000);
    }

    // 分时趋势：时间窗 ≤ 48 小时（今天 / 24 小时 / 短自定义）时按本地小时分组。
    // 分组用本地小时对齐半小时时区，hour_start_ts 转回真实 unix 秒供前端格式化。
    let hourly: Vec<HourlyUsage> = match (start_ts, end_ts) {
        (Some(start), Some(end)) if end >= start && end - start <= 48 * 3600 => {
            let mut hour_map: HashMap<i64, HourlyUsage> = HashMap::new();
            for record in &filtered {
                let local_ts = record.created_at - tz_offset_secs;
                let hour = local_ts.div_euclid(3600);
                let entry = hour_map.entry(hour).or_insert_with(|| HourlyUsage {
                    hour_start_ts: hour * 3600 + tz_offset_secs,
                    requests: 0,
                    unpriced_requests: 0,
                    partial_cost_requests: 0,
                    cost: 0.0,
                    total_tokens: 0,
                });
                entry.requests += 1;
                let cost = record_cost(record);
                entry.cost += cost.unwrap_or(0.0);
                entry.unpriced_requests += u64::from(cost.is_none());
                entry.partial_cost_requests += u64::from(record_cost_is_partial(record));
                entry.total_tokens += real_total_tokens(record);
            }
            let mut pairs: Vec<(i64, HourlyUsage)> = hour_map.into_iter().collect();
            pairs.sort_by_key(|(hour, _)| *hour);
            pairs.into_iter().map(|(_, v)| v).collect()
        }
        _ => Vec::new(),
    };

    // 模型统计（逐模型累计缓存分量，给出各模型自身的命中率）
    #[derive(Default)]
    struct ModelAgg {
        requests: u64,
        unpriced_requests: u64,
        partial_cost_requests: u64,
        total_tokens: u64,
        cost: f64,
        cache_read_tokens: u64,
        cacheable_tokens: u64,
    }
    let mut model_map: HashMap<(String, String), ModelAgg> = HashMap::new();
    for record in &filtered {
        let key = (record.model.clone(), record.app.clone());
        let entry = model_map.entry(key).or_default();
        let fresh = fresh_input_tokens(record);
        entry.requests += 1;
        entry.total_tokens += real_total_tokens(record);
        let cost = record_cost(record);
        entry.cost += cost.unwrap_or(0.0);
        entry.unpriced_requests += u64::from(cost.is_none());
        entry.partial_cost_requests += u64::from(record_cost_is_partial(record));
        entry.cache_read_tokens += record.cache_read_tokens;
        entry.cacheable_tokens += fresh + record.cache_creation_tokens + record.cache_read_tokens;
    }
    let mut models: Vec<ModelUsageStat> = model_map
        .into_iter()
        .map(|((model, app), agg)| ModelUsageStat {
            model,
            app,
            requests: agg.requests,
            unpriced_requests: agg.unpriced_requests,
            partial_cost_requests: agg.partial_cost_requests,
            total_tokens: agg.total_tokens,
            cost: agg.cost,
            cache_hit_rate: (agg.cacheable_tokens > 0)
                .then(|| agg.cache_read_tokens as f64 / agg.cacheable_tokens as f64),
        })
        .collect();
    models.sort_by(|a, b| b.cost.partial_cmp(&a.cost).unwrap_or(std::cmp::Ordering::Equal));

    // 最近请求（按时间倒序，最多 100 条）
    let mut recent_refs: Vec<&UsageRecord> = filtered.clone();
    recent_refs.sort_by_key(|record| std::cmp::Reverse(record.created_at));
    let recent: Vec<RecentUsageLog> = recent_refs
        .into_iter()
        .take(100)
        .map(|record| {
            let fresh = fresh_input_tokens(record);
            RecentUsageLog {
                time: record.created_at,
                app: record.app.to_string(),
                model: record.model.clone(),
                input_tokens: fresh,
                output_tokens: record.output_tokens,
                cache_read_tokens: record.cache_read_tokens,
                cache_creation_tokens: record.cache_creation_tokens,
                cache_creation_1h_tokens: record
                    .cache_creation_1h_tokens
                    .min(record.cache_creation_tokens),
                total_tokens: real_total_tokens(record),
                cost: record_cost(record),
                cost_partial: record_cost_is_partial(record),
                cost_breakdown: record_cost_breakdown(record),
                project: record.project.clone(),
                session_id: record.session_id.clone(),
            }
        })
        .collect();

    let mut parse_errors = outcome.errors;
    if parse_errors.len() > 20 {
        parse_errors.truncate(20);
    }

    UsageDashboard {
        pricing_source: reference_pricing().source.clone(),
        pricing_date: reference_pricing().date.clone(),
        summary,
        prev_summary,
        by_app,
        daily,
        hourly,
        models,
        recent,
        available_models,
        files_scanned: outcome.files_scanned,
        deferred_files: outcome.deferred_files,
        parse_errors,
        generated_at: now_unix(),
    }
}

#[cfg(test)]
#[path = "usage_stats_pricing_tests.rs"]
mod pricing_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_rfc3339() {
        assert_eq!(parse_rfc3339_to_unix("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339_to_unix("1970-01-01T00:16:45Z"), Some(1005));
        assert_eq!(
            parse_rfc3339_to_unix("2026-04-05T12:00:00Z"),
            Some(1775390400)
        );
        assert_eq!(
            parse_rfc3339_to_unix("2026-04-05T20:00:00+08:00"),
            Some(1775390400)
        );
        assert_eq!(
            parse_rfc3339_to_unix("2026-04-05T12:00:00.123Z"),
            Some(1775390400)
        );
    }

    #[test]
    fn test_civil_roundtrip() {
        let days = days_from_civil(2026, 8, 11);
        assert_eq!(civil_from_days(days), (2026, 8, 11));
        assert_eq!(days_from_civil(1970, 1, 1), 0);
    }

    #[test]
    fn test_normalize_codex_model() {
        assert_eq!(normalize_codex_model("GLM-4.6"), "glm-4.6");
        assert_eq!(normalize_codex_model("openai/gpt-5.4"), "gpt-5.4");
        assert_eq!(normalize_codex_model("gpt-5.4-2026-03-05"), "gpt-5.4");
        assert_eq!(normalize_codex_model("gpt-5.4-20260305"), "gpt-5.4");
    }

    #[test]
    fn test_pricing_lookup() {
        assert!(find_model_pricing("claude-sonnet-4-5-20250929").is_some());
        // 日期后缀剥离后命中裸名
        assert!(find_model_pricing("claude-opus-4-6-20991231").is_some());
        // provider 前缀剥离
        assert!(find_model_pricing("openai/gpt-5.4").is_some());
        // effort 后缀
        assert!(find_model_pricing("gpt-5.2-high").is_some());
        assert!(find_model_pricing("unknown").is_none());
    }

    #[test]
    fn test_cost_semantics() {
        // Claude：input 不含缓存
        let claude = UsageRecord {
            request_id: "t1".into(),
            app: "claude".into(),
            model: "claude-sonnet-4-5-20250929".into(),
            input_tokens: 1000,
            output_tokens: 500,
            cache_read_tokens: 200,
            cache_creation_tokens: 100,
            cache_creation_1h_tokens: 0,
            created_at: 0,
            reported_cost: None,
            cost_partial: false,
            project: None,
            session_id: None,
        };
        let cost = record_cost(&claude).unwrap();
        // 1000*3/1M + 500*15/1M + 200*0.3/1M + 100*3.75/1M = 0.010935
        assert!((cost - 0.010935).abs() < 1e-9);

        // Codex：input 含缓存，需扣除
        let codex = UsageRecord {
            request_id: "t2".into(),
            app: "codex".into(),
            model: "gpt-5.4".into(),
            input_tokens: 1000,
            output_tokens: 0,
            cache_read_tokens: 600,
            cache_creation_tokens: 0,
            cache_creation_1h_tokens: 0,
            created_at: 0,
            reported_cost: None,
            cost_partial: false,
            project: None,
            session_id: None,
        };
        let cost = record_cost(&codex).unwrap();
        // (1000-600)*2.5/1M + 600*0.25/1M = 0.001 + 0.00015 = 0.00115
        assert!((cost - 0.00115).abs() < 1e-9);
        assert_eq!(fresh_input_tokens(&codex), 400);
    }

    #[test]
    fn test_claude_cache_write_durations_and_missing_total() {
        use serde_json::json;
        let message = |id: &str, usage: serde_json::Value| json!({
            "type": "assistant", "timestamp": "2026-10-25T00:00:00Z",
            "cwd": "/work/varswitch", "sessionId": "claude-session",
            "message": {"id": id, "model": "claude-opus-5-5", "usage": usage}
        });
        let events = [
            message("explicit", json!({
                "cache_creation_input_tokens": 100,
                "cache_creation": {"ephemeral_5m_input_tokens": 60, "ephemeral_1h_input_tokens": 40}
            })),
            message("detail-only", json!({
                "cache_creation": {"ephemeral_5m_input_tokens": 300, "ephemeral_1h_input_tokens": 200}
            })),
            message("bounded", json!({
                "cache_creation_input_tokens": 100,
                "cache_creation": {"ephemeral_1h_input_tokens": 1000}
            })),
        ];
        let path = std::env::temp_dir().join(format!(
            "varswitch-claude-usage-test-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        fs::write(&path, events.iter().map(serde_json::Value::to_string).collect::<Vec<_>>().join("\n")).unwrap();
        let parsed = parse_claude_file(&path);
        let _ = fs::remove_file(path);
        let ParsedFile::Records(records) = parsed.unwrap() else {
            panic!("expected Claude usage records");
        };
        assert_eq!(records.len(), 3);
        let by_id: HashMap<_, _> = records.iter().map(|record| (record.request_id.as_str(), record)).collect();
        assert_eq!(by_id["session:explicit"].cache_creation_tokens, 100);
        assert_eq!(by_id["session:explicit"].cache_creation_1h_tokens, 40);
        assert_eq!(by_id["session:detail-only"].cache_creation_tokens, 500);
        assert_eq!(by_id["session:detail-only"].cache_creation_1h_tokens, 200);
        assert_eq!(by_id["session:bounded"].cache_creation_1h_tokens, 100);
        assert_eq!(by_id["session:bounded"].project.as_deref(), Some("/work/varswitch"));
        assert_eq!(by_id["session:bounded"].session_id.as_deref(), Some("claude-session"));
        // 一小时子计数只影响价格，不能把统计 token 总量再次加一遍。
        assert_eq!(summarize(&records.iter().collect::<Vec<_>>()).real_total_tokens, 700);
    }

    fn parse_codex_fixture(events: &[serde_json::Value]) -> ParsedCodexFile {
        let path = std::env::temp_dir().join(format!(
            "varswitch-usage-test-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        let contents = events
            .iter()
            .map(serde_json::Value::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(&path, contents).unwrap();
        let parsed = parse_codex_file(&path);
        let _ = fs::remove_file(path);
        match parsed.unwrap() {
            ParsedFile::Codex(parsed) => parsed,
            _ => panic!("expected Codex events"),
        }
    }

    #[test]
    fn test_codex_cache_writes_survive_snapshot_deduplication() {
        use serde_json::json;
        let first_usage = json!({
            "input_tokens": 1000, "cached_input_tokens": 600,
            "cache_write_input_tokens": 300, "output_tokens": 20,
            "total_tokens": 1020
        });
        let first = json!({
            "type": "event_msg", "timestamp": "2026-10-25T00:00:00Z",
            "payload": {
                "type": "token_count", "rate_limits": {"limit_id": "primary"},
                "info": {"total_token_usage": first_usage, "last_token_usage": first_usage}
            }
        });
        let mut duplicate = first.clone();
        duplicate["payload"]["rate_limits"]["limit_id"] = json!("secondary");
        let second = json!({
            "type": "event_msg", "timestamp": "2026-10-25T00:01:00Z",
            "payload": {
                "type": "token_count", "rate_limits": {"limit_id": "primary"},
                "info": {
                    "total_token_usage": {
                        "input_tokens": 2100, "cached_input_tokens": 1200,
                        "cache_write_input_tokens": 700, "output_tokens": 50,
                        "total_tokens": 2150
                    },
                    "last_token_usage": {
                        "input_tokens": 1100, "cached_input_tokens": 600,
                        "cache_write_input_tokens": 400, "output_tokens": 30,
                        "total_tokens": 1130
                    }
                }
            }
        });
        let parsed = parse_codex_fixture(&[first, duplicate, second]);
        assert_eq!(parsed.events[0].delta, (1000, 600, 20, 300));
        assert_eq!(parsed.events[1].delta, (0, 0, 0, 0));
        assert_eq!(parsed.events[1].event_index, None);
        assert_eq!(parsed.events[2].delta, (1100, 600, 30, 400));
        let fresh_input: u32 = parsed
            .events
            .iter()
            .map(|event| event.delta.0 - event.delta.1 - event.delta.3)
            .sum();
        assert_eq!(fresh_input, 200);
    }

    #[test]
    fn test_codex_cache_write_cumulative_fallback_and_legacy_logs() {
        use serde_json::json;
        let event = |usage: serde_json::Value| json!({
            "type": "event_msg", "timestamp": "2026-10-25T00:00:00Z",
            "payload": {"type": "token_count", "info": {"total_token_usage": usage}}
        });
        let parsed = parse_codex_fixture(&[
            event(json!({"input_tokens": 1000, "cached_input_tokens": 600,
                "cache_write_input_tokens": 300, "output_tokens": 20})),
            event(json!({"input_tokens": 2100, "cached_input_tokens": 1200,
                "cache_write_input_tokens": 700, "output_tokens": 50})),
        ]);
        assert_eq!(parsed.events[0].delta, (1000, 600, 20, 300));
        assert_eq!(parsed.events[1].delta, (1100, 600, 30, 400));

        let legacy = parse_codex_fixture(&[event(json!({
            "input_tokens": 1000, "cache_read_input_tokens": 600, "output_tokens": 20
        }))]);
        assert_eq!(legacy.events[0].delta, (1000, 600, 20, 0));

        let with_meta = parse_codex_fixture(&[json!({
            "type": "session_meta", "timestamp": "2026-10-25T00:00:00Z",
            "payload": {"id": "thread", "cwd": "/work/codex"}
        })]);
        assert_eq!(with_meta.cwd.as_deref(), Some("/work/codex"));
    }

    #[test]
    fn test_codex_cache_write_signature_and_input_bounds() {
        use serde_json::json;
        let usage = json!({"input_tokens": 1000, "cached_input_tokens": 600,
            "cache_write_input_tokens": 300, "output_tokens": 20});
        let mut changed_write = usage.clone();
        changed_write["cache_write_input_tokens"] = json!(350);
        assert_ne!(signature_counters(Some(&usage)), signature_counters(Some(&changed_write)));
        let alias = json!({"input_tokens": 1000, "cache_read_input_tokens": 600,
            "cache_creation_input_tokens": 300, "output_tokens": 20});
        assert_eq!(signature_counters(Some(&usage)), signature_counters(Some(&alias)));

        let parsed = parse_codex_fixture(&[json!({
            "type": "event_msg", "timestamp": "2026-10-25T00:00:00Z",
            "payload": {"type": "token_count", "info": {"last_token_usage": {
                "input_tokens": 100, "cached_input_tokens": 80,
                "cache_write_input_tokens": 50, "output_tokens": 20
            }}}
        })]);
        assert_eq!(parsed.events[0].delta, (100, 80, 20, 20));
    }

    #[test]
    fn test_grok_parser_preserves_reported_zero_and_distinguishes_missing_cost() {
        use serde_json::json;
        let event = |prompt_id: &str, counters: serde_json::Value| json!({
            "method": "_x.ai/session/update",
            "timestamp": 1792886400,
            "params": {"update": {
                "sessionUpdate": "turn_completed",
                "prompt_id": prompt_id,
                "usage": {"modelUsage": {"grok-4.7": counters}}
            }}
        });
        let counters = json!({"inputTokens": 1000, "outputTokens": 100, "cachedReadTokens": 600});
        let mut zero_cost = counters.clone();
        zero_cost["costUsdTicks"] = json!(0);
        let mut paid = counters.clone();
        paid["costUsdTicks"] = json!(5_000_000_000_u64);
        let events = [event("zero", zero_cost), event("missing", counters), event("paid", paid)];
        let path = std::env::temp_dir().join(format!(
            "varswitch-grok-usage-test-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        fs::write(&path, events.iter().map(serde_json::Value::to_string).collect::<Vec<_>>().join("\n")).unwrap();
        let parsed = parse_grok_file(&path);
        let _ = fs::remove_file(path);
        let ParsedFile::Records(records) = parsed.unwrap() else {
            panic!("expected Grok usage records");
        };
        assert_eq!(records.len(), 3);
        assert_eq!(records[0].reported_cost, Some(0.0));
        assert_eq!(record_cost(&records[0]), Some(0.0));
        assert_eq!(records[1].reported_cost, None);
        assert!(record_cost(&records[1]).unwrap() > 0.0);
        assert_eq!(records[2].reported_cost, Some(0.5));
        assert_eq!(record_cost(&records[2]), Some(0.5));
    }

    #[test]
    fn test_replay_prefix() {
        let make_event = |sig: &str| CodexTokenEvent {
            signature: sig.to_string(),
            ts_unix: Some(0),
            delta: (1, 0, 1, 0),
            event_index: Some(1),
            model: "codex".into(),
        };
        let child = vec![make_event("a"), make_event("b"), make_event("c")];
        let parent = vec!["a".to_string(), "x".to_string(), "b".to_string()];
        // a 命中、b 命中（跳过 x）、c 不命中 → prefix = 2
        assert_eq!(matching_replay_prefix(&child, &parent), 2);
    }
}
