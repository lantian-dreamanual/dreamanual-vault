//! 镜像备份与版本轮转。**M3 实装。**
//!
//! 契约（三条，都是决议已经定下的）：
//!
//! 1. **只接参数，不读全局配置。** 备份目录由调用方从 `config` 取来传入。
//!    这样开发期可以把目标指向本地临时目录，整条链路照常验收，不依赖 NAS 挂载点。
//!
//! 2. **不做原子写。** 备份目录在 File Provider 下，tmp 会被同步上去、rename 也走
//!    provider 语义。改成一次性 copy，且保持「先写 `vault.kdbx.tmp`、再改名到目标名」
//!    的顺序，避免 NAS 上留下半个文件（见 `fileio::copy_via_tmp`）。
//!
//! 3. **失败不阻塞保存。** 备份失败只在界面顶部给提示，并把原因写回 `config` 的
//!    `last_backup_error`；成功则更新 `last_backup_at`。
//!    调用前必须先校验目标目录是否存在 —— Synology Drive 客户端没运行或没登录时
//!    挂载点是直接消失的，这时备份会一直失败，而设置页的「上次备份成功时间」
//!    是发现这件事的唯一信号。
//!
//! 另有一条部署侧的前置条件（不属于代码）：Synology Drive 客户端里要把备份目录
//! 设为「仅上传」。在 Q3 落值后再做。
//!
//! ## 两个方向，两处历史版本
//!
//! PRD §5.3 说的是「每次覆盖主库前，先把旧版本另存为 `vault.kdbx.<YYYYMMDD-HHmm>.bak`，
//! 本地保留最近 10 份；备份目录同样保留 10 份」—— 所以这里有两条独立的链路：
//!
//! - [`snapshot_local`]：**主库自己要写新内容之前**，先把现有的那份存成历史版本。
//!   调用点在写入路径上（`vault.rs`），不在本模块里。
//! - [`mirror`]：**把主库镜像到备份目录**。目的盘里已有的那份先存成历史版本，
//!   再放入新内容。于是备份目录里始终有一份「和主库当前一致」的镜像 + 若干历史版本。
//!
//! 两处共用 [`rotate_existing`]，`base` 都取**源文件的文件名**而不是写死 `vault.kdbx` ——
//! 走「打开其他库」打开别的库时，备份目录里也应该看得出备份的是哪一份。

#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Serialize;

use crate::fileio;

/// 历史版本的时间戳格式。定宽，所以按文件名排序就等于按时间排序。
pub const STAMP_FORMAT: &str = "%Y%m%d-%H%M";
const STAMP_LEN: usize = 13; // 20260921-1355
const STAMP_DASH: usize = 8;
const VERSION_SUFFIX: &str = ".bak";

/// 一次备份做了些什么。给界面与验收用。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupOutcome {
    /// 镜像写到哪
    pub dest: String,
    /// 镜像文件的字节数
    pub bytes: u64,
    /// 内容与目的盘上那份一致，直接跳过 —— 没有产生新的历史版本
    pub unchanged: bool,
    /// 这次轮转出来的历史版本文件名
    pub rotated: Option<String>,
    /// 裁掉了几份旧版本
    pub pruned: usize,
}

// ------------------------------------------------------------------ 时间戳

/// 本地时间的 `YYYYMMDD-HHmm`。
///
/// 用本地时间而不是 UTC：文件名是给人看的，和日志对不上就失去意义了。
pub fn stamp_at(now: SystemTime) -> String {
    let local: chrono::DateTime<chrono::Local> = now.into();
    local.format(STAMP_FORMAT).to_string()
}

/// 现在
pub fn stamp_now() -> String {
    stamp_at(SystemTime::now())
}

/// 备份记账用的时间戳，RFC3339（带本地时区偏移）。
///
/// `config.last_backup_at` 存的就是它。用 RFC3339 而不是 epoch 数字：
/// 这个值会出现在 `config.json` 里，人打开看的时候要能直接读懂。
pub fn now_rfc3339() -> String {
    chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, false)
}

/// 超过这个小时数没成功备份就算「不新鲜」（PRD F7.8）
pub const STALE_HOURS: i64 = 24;

/// 距上次成功备份是否已超过 24 小时。
///
/// 两种取值都**不算** stale：
/// - `None`：从来没成功过。这与「成功过但过期了」是两种状态，
///   界面上要分开说 —— 刚设好备份目录还没触发第一次保存时，
///   立刻提示「超 24 小时未成功」是在吓人。
/// - 解析不出来：那说明这个值被手改过或写坏了。这里按**坏**算，
///   因为它是发现备份失效的第一信号，宁可多提醒一次。
pub fn is_stale(last_at: Option<&str>, now: SystemTime) -> bool {
    let Some(raw) = last_at else {
        return false;
    };
    let Ok(then) = chrono::DateTime::parse_from_rfc3339(raw) else {
        return true;
    };
    let now_secs = now
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    now_secs - then.timestamp() > STALE_HOURS * 3600
}

/// 历史版本的文件名：`<基名>.<YYYYMMDD-HHmm>.bak`
pub fn version_name(base: &str, stamp: &str) -> String {
    format!("{base}.{stamp}{VERSION_SUFFIX}")
}

/// 从文件名反认「这是不是 `base` 的历史版本」，是则给出时间戳。
///
/// 判据要严：`prune_versions` 会**删文件**，认宽了就会误删用户自己放进备份目录的东西。
/// 所以除了前后缀，中间那段还必须是 `YYYYMMDD-HHmm` 的形状。
pub fn version_stamp(file_name: &str, base: &str) -> Option<String> {
    let rest = file_name.strip_prefix(base)?.strip_prefix('.')?;
    let stamp = rest.strip_suffix(VERSION_SUFFIX)?;

    // 先挡非 ASCII：下面按下标切片，遇到多字节字符会 panic。
    // 手滑放进来的 `vault.kdbx.备份.bak` 要在这里被安静地判成「不是历史版本」。
    if !stamp.is_ascii() || stamp.len() != STAMP_LEN {
        return None;
    }
    let bytes = stamp.as_bytes();
    if bytes[STAMP_DASH] != b'-' {
        return None;
    }
    let digits_ok = bytes[..STAMP_DASH].iter().all(u8::is_ascii_digit)
        && bytes[STAMP_DASH + 1..].iter().all(u8::is_ascii_digit);
    digits_ok.then(|| stamp.to_string())
}

/// 目录下 `base` 的全部历史版本，**从新到旧**。
///
/// 定宽时间戳让字典序等于时间序，不需要解析成日期再比。
pub fn list_versions(dir: &Path, base: &str) -> Vec<PathBuf> {
    let mut found: Vec<(String, PathBuf)> = match fs::read_dir(dir) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                let stamp = version_stamp(&name, base)?;
                Some((stamp, e.path()))
            })
            .collect(),
        Err(_) => Vec::new(),
    };
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().map(|(_, p)| p).collect()
}

/// 只保留最新的 `keep` 份，返回删掉了几份。
///
/// 只认 [`version_stamp`] 认得出来的文件 —— 主库镜像本身（`vault.kdbx`）与
/// 用户自己放进来的东西都不在范围内。
pub fn prune_versions(dir: &Path, base: &str, keep: usize) -> usize {
    let versions = list_versions(dir, base);
    let mut removed = 0;
    for path in versions.into_iter().skip(keep) {
        if fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

// ------------------------------------------------------------------ 轮转

/// 把 `target` 现有内容另存为一份历史版本，并把历史版本裁到 `keep` 份。
///
/// 返回 `(新版本的文件名, 裁掉的数量)`。`target` 不存在时不产生新版本（返回 `None`），
/// 但**裁剪照做** —— 第一次写库、第一次备份都会走到这里，那时没有旧版本可存，
/// 而上限仍然要生效。
///
/// 这两件事绑在一起是有意的：每次调用都可能多出一份历史版本，裁剪就必须跟着走。
/// 拆成两个各自可调的函数，只会让人漏掉后一半，然后备份目录悄悄涨到几百份。
pub fn rotate_existing(target: &Path, keep: usize) -> Result<(Option<String>, usize), String> {
    let dir = parent_of(target)?;
    let base = base_name(target)?;

    let rotated = if target.exists() {
        let name = version_name(&base, &stamp_now());
        let version = dir.join(&name);
        fileio::copy_via_tmp(target, &version)
            .map_err(|e| format!("存历史版本失败：{}（{}）", version.display(), e))?;
        Some(name)
    } else {
        None
    };

    // 裁剪与「有没有东西可轮转」无关。把上限从 10 改小之后，下一次备份就该把
    // 多出来的清掉；写成「只在轮转成功时裁」的话，那个上限会变成有条件的 ——
    // 备份目录里恰好没有镜像文件（用户手动挪走、或只留下了历史版本）就永远不生效。
    let pruned = prune_versions(&dir, &base, keep);
    Ok((rotated, pruned))
}

// ------------------------------------------------------------------ 主库旁的快照

/// 覆盖主库**之前**调用：把现有的那份存成历史版本（PRD §5.3）。
///
/// 与 [`mirror`] 的区别是这里不复制新内容 —— 新内容由紧接着的写入带进去。
pub fn snapshot_local(vault: &Path, keep: usize) -> Result<Option<String>, String> {
    let (version, _) = rotate_existing(vault, keep)?;
    Ok(version)
}

// ------------------------------------------------------------------ 镜像

/// 把 `src` 镜像到 `backup_dir`，并把历史版本裁到 `keep` 份。
///
/// 步骤（顺序不能换）：
///   1. 校验 `backup_dir` 存在且是目录 —— 挂载点消失时在这里就返回，不去动任何文件
///   2. 内容与目的盘上那份一致就直接跳过，不产生历史版本
///   3. 目的盘上那份先轮转成历史版本
///   4. `copy_via_tmp` 写入新内容
///
/// 第 2 步不只是省一次写：库文件每次保存后都会镜像，内容没变还照轮转的话，
/// 备份目录里会堆出一串一模一样的 `.bak`，真正有用的那几份被顶掉。
pub fn mirror(src: &Path, backup_dir: &Path, keep: usize) -> Result<BackupOutcome, String> {
    if !src.exists() {
        return Err(format!("主库文件不存在，无法备份：{}", src.display()));
    }
    if !backup_dir.is_dir() {
        return Err(format!(
            "备份目录不可用（Synology Drive 客户端可能没运行或没登录）：{}",
            backup_dir.display()
        ));
    }

    let base = base_name(src)?;
    let dest = backup_dir.join(&base);
    let bytes = fs::read(src).map_err(|e| format!("读主库失败：{}（{}）", src.display(), e))?;

    if let Ok(existing) = fs::read(&dest) {
        if existing == bytes {
            return Ok(BackupOutcome {
                dest: dest.to_string_lossy().into_owned(),
                bytes: bytes.len() as u64,
                unchanged: true,
                rotated: None,
                pruned: 0,
            });
        }
    }

    let (rotated, pruned) = rotate_existing(&dest, keep)?;

    fileio::copy_via_tmp(src, &dest)
        .map_err(|e| format!("写入备份失败：{}（{}）", dest.display(), e))?;

    Ok(BackupOutcome {
        dest: dest.to_string_lossy().into_owned(),
        bytes: bytes.len() as u64,
        unchanged: false,
        rotated,
        pruned,
    })
}

// ------------------------------------------------------------------ 小工具

fn parent_of(path: &Path) -> Result<PathBuf, String> {
    path.parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .ok_or_else(|| format!("路径没有父目录：{}", path.display()))
}

fn base_name(path: &Path) -> Result<String, String> {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| format!("路径没有文件名：{}", path.display()))
}

// ------------------------------------------------------------------ 编排

/// 设置页要显示的备份状态。**全部字段都从盘上现读**，不在内存里另存一份 ——
/// 这份状态的价值就在于它反映的是「备份到底有没有在工作」，
/// 缓存一份之后，正好是它该反映真实情况的时候不反映。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupStatus {
    pub configured: bool,
    /// 保存后自动镜像
    pub auto: bool,
    pub dir: Option<String>,
    pub keep_versions: u32,
    /// RFC3339
    pub last_at: Option<String>,
    pub last_error: Option<String>,
    /// 上次成功超过 24 小时（PRD F7.8）。`last_at` 为空时是 false ——
    /// 「从来没成功过」与「成功过但过期了」在界面上要分开说。
    pub stale: bool,
}

pub fn status_of(cfg: &crate::config::AppConfig) -> BackupStatus {
    BackupStatus {
        configured: cfg.backup_dir.is_some(),
        auto: cfg.backup_auto,
        dir: cfg.backup_dir.clone(),
        keep_versions: cfg.keep_versions,
        last_at: cfg.last_backup_at.clone(),
        last_error: cfg.last_backup_error.clone(),
        stale: is_stale(cfg.last_backup_at.as_deref(), SystemTime::now()),
    }
}

/// 一次备份尝试的结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupRun {
    pub status: BackupStatus,
    /// 真的镜像了
    pub outcome: Option<BackupOutcome>,
    /// 没做，以及为什么（没设备份目录 / 自动镜像已关）
    pub skipped: Option<String>,
    /// 做了但失败了
    pub error: Option<String>,
}

/// 按配置跑一次备份。
///
/// **这是唯一读配置的地方** —— [`mirror`] 本身仍然只接参数，开发期把目标指向
/// 本地临时目录就能整条验收，不依赖 NAS 挂载点。
///
/// `manual` 为真时忽略「保存后自动镜像」这个开关：那是「立即备份」按钮走的路径，
/// 用户在开关关着的时候按它，意图是明确的。
pub fn run_from_config(dir: &Path, src: &Path, manual: bool) -> BackupRun {
    let cfg = crate::config::load_from(dir);

    let skipped = if cfg.backup_dir.is_none() {
        Some("还没有设置备份目录".to_string())
    } else if !manual && !cfg.backup_auto {
        Some("「保存后自动镜像」已关闭".to_string())
    } else {
        None
    };
    if let Some(reason) = skipped {
        return BackupRun {
            status: status_of(&cfg),
            outcome: None,
            skipped: Some(reason),
            error: None,
        };
    }

    let backup_dir = cfg.backup_dir.clone().unwrap_or_default();
    match mirror(src, Path::new(&backup_dir), cfg.keep_versions as usize) {
        Ok(outcome) => {
            let after = crate::config::note_backup_success(dir, now_rfc3339()).unwrap_or(cfg);
            BackupRun {
                status: status_of(&after),
                outcome: Some(outcome),
                skipped: None,
                error: None,
            }
        }
        Err(error) => {
            // 失败不往上抛：调用方是保存路径，备份坏了不该让保存看起来也坏了
            let after = crate::config::note_backup_failure(dir, error.clone()).unwrap_or(cfg);
            BackupRun {
                status: status_of(&after),
                outcome: None,
                skipped: None,
                error: Some(error),
            }
        }
    }
}

// ------------------------------------------------------------------ 测试

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, content: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    // ---------------------------------------------------------- 版本名

    #[test]
    fn version_stamp_accepts_only_real_versions() {
        let base = "vault.kdbx";

        assert_eq!(
            version_stamp("vault.kdbx.20260921-1355.bak", base).as_deref(),
            Some("20260921-1355")
        );

        // 主库镜像本身、原子写留下的 tmp、别人家的库、缺一段的、位数不对的
        for name in [
            "vault.kdbx",
            "vault.kdbx.tmp",
            "vault.kdbx.tmp.bak",
            "other.kdbx.20260921-1355.bak",
            "vault.kdbx.2026092-1355.bak",
            "vault.kdbx.20260921-135.bak",
            "vault.kdbx.2026092a-1355.bak",
            "vault.kdbx.20260921-1355.bak.bak",
            "",
        ] {
            assert_eq!(version_stamp(name, base), None, "不该认成历史版本：{name}");
        }
    }

    /// 非 ASCII 那段要能被安静判掉。按下标切片遇上多字节字符会 panic，
    /// 而 `prune_versions` 手里拿的是真文件、会去删 —— 这条挡住的是崩溃。
    #[test]
    fn version_stamp_survives_non_ascii_names() {
        assert_eq!(version_stamp("vault.kdbx.备份.bak", "vault.kdbx"), None);
        assert_eq!(version_stamp("vault.kdbx.二〇二六.bak", "vault.kdbx"), None);
        // 长度凑巧对上也一样
        assert_eq!(version_stamp("vault.kdbx.一二三四五六.bak", "vault.kdbx"), None);
    }

    #[test]
    fn version_name_is_fixed_width_so_lexical_order_is_time_order() {
        let a = version_name("vault.kdbx", "20260921-1355");
        let b = version_name("vault.kdbx", "20260921-1400");
        let c = version_name("vault.kdbx", "20260922-0900");

        assert_eq!(a, "vault.kdbx.20260921-1355.bak");
        assert!(a < b && b < c, "定宽时间戳的字典序必须等于时间序");
    }

    /// 时间戳按**本地时间**出，且形状固定
    #[test]
    fn stamp_now_has_the_expected_shape() {
        let s = stamp_now();
        assert_eq!(s.len(), STAMP_LEN, "实际是：{s}");
        assert_eq!(
            version_stamp(&version_name("v.kdbx", &s), "v.kdbx").as_deref(),
            Some(s.as_str())
        );
    }

    #[test]
    fn now_rfc3339_roundtrips() {
        let s = now_rfc3339();
        assert!(chrono::DateTime::parse_from_rfc3339(&s).is_ok(), "实际是：{s}");
    }

    // ---------------------------------------------------------- 新鲜度

    /// 24 小时的判据。这条是 F7.8 的全部内容：设置页靠它决定「上次备份成功」
    /// 那一格要不要变色，而备份坏掉时它是唯一的信号。
    #[test]
    fn staleness_is_measured_against_24_hours() {
        let now = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_800_000_000);
        let at = |secs_ago: i64| {
            let t = 1_800_000_000i64 - secs_ago;
            chrono::DateTime::from_timestamp(t, 0)
                .unwrap()
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
        };

        assert!(!is_stale(Some(&at(60)), now), "一分钟前");
        assert!(!is_stale(Some(&at(23 * 3600)), now), "23 小时前还不算");
        assert!(is_stale(Some(&at(25 * 3600)), now), "25 小时前就算了");
    }

    /// 从来没成功过与「成功过但过期了」是两种状态，界面上要分开说
    #[test]
    fn never_backed_up_is_not_reported_as_stale() {
        let now = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_800_000_000);
        assert!(!is_stale(None, now));
    }

    /// 值被手改坏时按「坏」算 —— 宁可多提醒一次
    #[test]
    fn unparsable_timestamp_counts_as_stale() {
        let now = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_800_000_000);
        assert!(is_stale(Some("昨天下午"), now));
    }

    // ---------------------------------------------------------- 轮转与裁剪

    #[test]
    fn rotate_on_missing_target_is_a_noop() {
        let dir = temp_dir("dreamanual-bak-noop");
        let target = dir.join("vault.kdbx");

        let (version, pruned) = rotate_existing(&target, 10).unwrap();
        assert_eq!(version, None, "没有旧内容时不该造出一个历史版本");
        assert_eq!(pruned, 0);
        assert!(list_versions(&dir, "vault.kdbx").is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    /// 时间戳精确到分钟，同一分钟内连着轮转只会留一份 ——
    /// 靠时间戳本身做不到「十份不同的历史版本」，所以裁剪测试手工造文件。
    #[test]
    fn prune_keeps_the_newest_and_never_touches_the_mirror() {
        let dir = temp_dir("dreamanual-bak-prune");
        let base = "vault.kdbx";

        write(&dir.join(base), b"mirror");
        for stamp in ["20260921-0900", "20260921-1000", "20260921-1100", "20260921-1200"] {
            write(&dir.join(version_name(base, stamp)), stamp.as_bytes());
        }
        // 用户自己放进来的东西，谁都别动
        write(&dir.join("我的笔记.txt"), b"do not touch");

        let removed = prune_versions(&dir, base, 2);

        assert_eq!(removed, 2);
        assert!(dir.join(version_name(base, "20260921-1200")).exists());
        assert!(dir.join(version_name(base, "20260921-1100")).exists());
        assert!(!dir.join(version_name(base, "20260921-1000")).exists(), "该删最旧的两份");
        assert!(!dir.join(version_name(base, "20260921-0900")).exists());
        assert!(dir.join(base).exists(), "镜像本身不在裁剪范围内");
        assert!(dir.join("我的笔记.txt").exists(), "不认得的文件一个都不该动");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_versions_is_newest_first() {
        let dir = temp_dir("dreamanual-bak-list");
        let base = "vault.kdbx";
        for stamp in ["20260921-1000", "20260922-0900", "20260921-0900"] {
            write(&dir.join(version_name(base, stamp)), stamp.as_bytes());
        }

        let names: Vec<String> = list_versions(&dir, base)
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            names,
            vec![
                version_name(base, "20260922-0900"),
                version_name(base, "20260921-1000"),
                version_name(base, "20260921-0900"),
            ]
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_with_keep_zero_removes_every_version() {
        let dir = temp_dir("dreamanual-bak-keep0");
        let base = "vault.kdbx";
        write(&dir.join(base), b"mirror");
        for stamp in ["20260921-0900", "20260921-1000"] {
            write(&dir.join(version_name(base, stamp)), b"x");
        }

        assert_eq!(prune_versions(&dir, base, 0), 2);
        assert!(list_versions(&dir, base).is_empty());
        assert!(dir.join(base).exists());

        let _ = fs::remove_dir_all(&dir);
    }

    // ---------------------------------------------------------- 镜像

    #[test]
    fn mirror_of_missing_source_says_so() {
        let dir = temp_dir("dreamanual-bak-nosrc");
        let backup = dir.join("backup");
        fs::create_dir_all(&backup).unwrap();

        let err = mirror(&dir.join("nope.kdbx"), &backup, 10).unwrap_err();
        assert!(err.contains("主库文件不存在"), "实际是：{err}");

        let _ = fs::remove_dir_all(&dir);
    }

    /// 挂载点消失是这套机制里最要紧的一种失败 —— 报错要能让人看出该去查什么
    #[test]
    fn mirror_without_backup_dir_does_not_touch_anything() {
        let dir = temp_dir("dreamanual-bak-nodir");
        let src = dir.join("vault.kdbx");
        write(&src, b"secret");

        let missing = dir.join("挂载点不在了");
        let err = mirror(&src, &missing, 10).unwrap_err();
        assert!(err.contains("备份目录不可用"), "实际是：{err}");
        assert!(err.contains("Synology Drive"), "要指出最可能的原因：{err}");
        assert!(!missing.exists(), "校验失败时不该顺手把目录建出来");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn mirror_copies_then_rotates_on_the_next_change() {
        let dir = temp_dir("dreamanual-bak-mirror");
        let src = dir.join("vault.kdbx");
        let backup = dir.join("backup");
        fs::create_dir_all(&backup).unwrap();

        write(&src, b"v1");
        let first = mirror(&src, &backup, 10).unwrap();
        assert!(!first.unchanged);
        assert_eq!(first.bytes, 2);
        assert_eq!(first.rotated, None, "目的盘上还没有东西可轮转");
        assert_eq!(fs::read(backup.join("vault.kdbx")).unwrap(), b"v1");
        assert!(list_versions(&backup, "vault.kdbx").is_empty());

        write(&src, b"v2");
        let second = mirror(&src, &backup, 10).unwrap();
        assert!(!second.unchanged);
        assert!(second.rotated.is_some(), "上一份要留成历史版本");
        assert_eq!(fs::read(backup.join("vault.kdbx")).unwrap(), b"v2");

        let versions = list_versions(&backup, "vault.kdbx");
        assert_eq!(versions.len(), 1);
        assert_eq!(fs::read(&versions[0]).unwrap(), b"v1", "历史版本装的是改动前的内容");
        assert!(!backup.join("vault.kdbx.tmp").exists(), "tmp 必须被改名掉");

        let _ = fs::remove_dir_all(&dir);
    }

    /// 内容没变就不要造历史版本 —— 否则每次保存都镜像，有效的那几份会被顶掉
    #[test]
    fn mirror_skips_when_content_is_identical() {
        let dir = temp_dir("dreamanual-bak-unchanged");
        let src = dir.join("vault.kdbx");
        let backup = dir.join("backup");
        fs::create_dir_all(&backup).unwrap();

        write(&src, b"same");
        mirror(&src, &backup, 10).unwrap();

        let again = mirror(&src, &backup, 10).unwrap();
        assert!(again.unchanged);
        assert_eq!(again.rotated, None);
        assert!(
            list_versions(&backup, "vault.kdbx").is_empty(),
            "没变就不该多出历史版本"
        );
        assert_eq!(again.dest, backup.join("vault.kdbx").to_string_lossy());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn mirror_prunes_the_backup_dir_to_keep() {
        let dir = temp_dir("dreamanual-bak-prune-mirror");
        let src = dir.join("vault.kdbx");
        let backup = dir.join("backup");
        fs::create_dir_all(&backup).unwrap();

        // 先手工铺满历史版本，再镜像一次，看它会不会顺手裁掉
        let base = "vault.kdbx";
        for stamp in ["20260921-0900", "20260921-1000", "20260921-1100"] {
            write(&backup.join(version_name(base, stamp)), b"old");
        }
        write(&src, b"new");

        let outcome = mirror(&src, &backup, 2).unwrap();
        assert_eq!(outcome.pruned, 1, "3 份裁到 2 份");
        assert_eq!(list_versions(&backup, base).len(), 2);
        assert_eq!(fs::read(backup.join(base)).unwrap(), b"new");

        let _ = fs::remove_dir_all(&dir);
    }

    /// 备份的基名跟着源文件走：「打开其他库」打开的库也该看得出备份的是哪一份
    #[test]
    fn mirror_uses_the_source_file_name() {
        let dir = temp_dir("dreamanual-bak-basename");
        let src = dir.join("我的库.kdbx");
        let backup = dir.join("backup");
        fs::create_dir_all(&backup).unwrap();

        write(&src, b"x");
        mirror(&src, &backup, 10).unwrap();

        assert!(backup.join("我的库.kdbx").exists());
        assert!(!backup.join("vault.kdbx").exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn snapshot_local_rotates_beside_the_vault() {
        let dir = temp_dir("dreamanual-bak-snap");
        let vault = dir.join("vault.kdbx");

        assert_eq!(snapshot_local(&vault, 10).unwrap(), None, "还没有库时是空操作");

        write(&vault, b"v1");
        let version = snapshot_local(&vault, 10).unwrap().expect("该轮转出一份历史版本");
        assert_eq!(fs::read(dir.join(&version)).unwrap(), b"v1");

        // 快照只存旧内容，不动主库本身
        assert_eq!(fs::read(&vault).unwrap(), b"v1");
        assert!(!dir.join(format!("{version}.tmp")).exists());

        let _ = fs::remove_dir_all(&dir);
    }

    // ---------------------------------------------------------- 按配置跑一次

    fn cfg_dir(name: &str) -> PathBuf {
        let dir = temp_dir(name);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 默认状态下备份是关着的（PRD §5.2「首次启动时不设置」）
    #[test]
    fn run_without_a_backup_dir_skips_and_says_why() {
        let dir = cfg_dir("dreamanual-bak-run-unset");
        let src = dir.join("vault.kdbx");
        write(&src, b"x");

        let run = run_from_config(&dir, &src, false);
        assert!(run.outcome.is_none());
        assert!(run.error.is_none());
        assert_eq!(run.skipped.as_deref(), Some("还没有设置备份目录"));
        assert!(!run.status.configured);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn run_respects_the_auto_switch_unless_manual() {
        let dir = cfg_dir("dreamanual-bak-run-auto");
        let backup = dir.join("backup");
        fs::create_dir_all(&backup).unwrap();
        let src = dir.join("vault.kdbx");
        write(&src, b"x");

        crate::config::merge_patch(
            &dir,
            &serde_json::json!({
                "backupDir": backup.to_string_lossy(),
                "backupAuto": false
            }),
        )
        .unwrap();

        let auto = run_from_config(&dir, &src, false);
        assert_eq!(auto.skipped.as_deref(), Some("「保存后自动镜像」已关闭"));
        assert!(!backup.join("vault.kdbx").exists());

        // 「立即备份」按钮不受这个开关约束 —— 用户按它的时候意图是明确的
        let manual = run_from_config(&dir, &src, true);
        assert!(manual.skipped.is_none());
        assert!(manual.outcome.is_some());
        assert_eq!(fs::read(backup.join("vault.kdbx")).unwrap(), b"x");

        let _ = fs::remove_dir_all(&dir);
    }

    /// 成功要记时间，失败要记原因，两种都要落盘
    #[test]
    fn run_records_success_and_failure_for_the_settings_page() {
        let dir = cfg_dir("dreamanual-bak-run-record");
        let backup = dir.join("backup");
        fs::create_dir_all(&backup).unwrap();
        let src = dir.join("vault.kdbx");
        write(&src, b"x");

        crate::config::merge_patch(
            &dir,
            &serde_json::json!({ "backupDir": backup.to_string_lossy() }),
        )
        .unwrap();

        let ok = run_from_config(&dir, &src, true);
        assert!(ok.error.is_none());
        assert!(ok.status.last_at.is_some(), "成功要记下时间");
        assert!(ok.status.last_error.is_none());
        assert!(!ok.status.stale, "刚备份完不该是过期状态");
        assert_eq!(
            crate::config::load_from(&dir).last_backup_at,
            ok.status.last_at,
            "记的时间要真的落盘，否则重启就没了"
        );

        // 把备份目录变成普通文件，下一次备份必然失败
        fs::remove_dir_all(&backup).unwrap();
        write(&backup, "我不是目录".as_bytes());

        let bad = run_from_config(&dir, &src, true);
        assert!(bad.outcome.is_none());
        assert!(bad.error.as_deref().unwrap_or("").contains("备份目录不可用"));
        assert_eq!(bad.status.last_error, bad.error, "失败原因要出现在状态里");
        assert_eq!(
            bad.status.last_at, ok.status.last_at,
            "失败不能抹掉上一次的成功时间 —— 那是判断坏了多久的依据"
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
