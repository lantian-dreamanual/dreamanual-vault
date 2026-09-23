//! 应用配置的持久化。
//!
//! 与 PRD §5.2 的 Q3 决议对应：**备份目录是配置项，不是常量**。
//! 本模块只负责读写；备份目录从哪来、什么时候用，由界面与 `backup` 决定。
//!
//! 这里刻意不依赖 Tauri 的路径解析，调用方把目录传进来即可 ——
//! 这样单元测试不需要起一个 AppHandle。
//!
//! 当前被真正读写的只有两处：`last_opened_vault`（F1.3 换库，见 `vault.rs`）
//! 与备份相关的字段（M3 起由设置页与 `backup` 调用）。
//! 主题 / 自动锁定这些前端有自己的一份即时状态，落盘时统一走这里。

#![allow(dead_code)]

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 与 `.kdbx` 放在同一个应用数据目录下
pub const FILE_NAME: &str = "config.json";

// 没有 `Eq`：窗口几何是 f64 的逻辑坐标，浮点数本来就不满足 Eq。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    /// 0 表示从不自动锁定
    pub auto_lock_minutes: u32,
    /// 0 表示不自动清除剪贴板
    pub clipboard_clear_seconds: u32,
    /// 流畅 | 均衡 | 安全，见 src/vault/kdf.ts
    pub kdf_preset: String,
    /// 未设置时为 None —— 首次启动就是这个状态（PRD §5.2）
    pub backup_dir: Option<String>,
    pub backup_auto: bool,
    pub keep_versions: u32,
    /// 系统锁屏 / 休眠时锁定
    pub lock_on_sleep: bool,
    /// 「打开其他库」选中的路径，为空表示用默认主库
    pub last_opened_vault: Option<String>,
    /// RFC3339。判断备份是否真的在工作就靠它（PRD F7.8）
    pub last_backup_at: Option<String>,
    pub last_backup_error: Option<String>,
    /// 上次退出时的窗口位置与尺寸（PRD §7.2）。由 `window.rs` 自己维护，
    /// 不在 `PATCHABLE_KEYS` 里 —— 设置页没有理由去写它。
    pub window: Option<crate::window::Geometry>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            auto_lock_minutes: 5,
            clipboard_clear_seconds: 30,
            kdf_preset: "均衡".to_string(),
            backup_dir: None,
            backup_auto: true,
            keep_versions: 10,
            lock_on_sleep: true,
            last_opened_vault: None,
            last_backup_at: None,
            last_backup_error: None,
            window: None,
        }
    }
}

/// 配置文件路径
pub fn path_in(dir: &Path) -> PathBuf {
    dir.join(FILE_NAME)
}

// ------------------------------------------------------------------ 合法取值

/// 下面三组常量与设置页 `<option>` 里那几项**必须一一对应**。
/// 界面给出一个值、配置层不认，结果就是用户点完保存、下次打开又变回去了。
/// `scripts/m2-acceptance.sh` 里有一条断言拿 `index.html` 的选项和这几组比。
/// 0 表示从不自动锁定
pub const AUTO_LOCK_MINUTES: [u32; 5] = [0, 1, 5, 15, 30];
/// 0 表示不自动清除剪贴板
pub const CLIPBOARD_SECONDS: [u32; 4] = [0, 15, 30, 60];
pub const KDF_PRESETS: [&str; 3] = ["流畅", "均衡", "安全"];
pub const KEEP_VERSIONS_MIN: u32 = 1;
pub const KEEP_VERSIONS_MAX: u32 = 50;

/// 离 `value` 最近的合法值，并列时取小的那个。
fn nearest(legal: &[u32], value: u32) -> u32 {
    legal
        .iter()
        .copied()
        .min_by_key(|v| (v.abs_diff(value), *v))
        .unwrap_or(value)
}

/// 只允许设置页改这些键。
///
/// `lastOpenedVault` / `lastBackupAt` / `lastBackupError` 由后端自己维护，
/// 开放给前端整份覆盖的话，一次「保存设置」就会把备份成功时间冲成旧值 ——
/// 而那个时间是判断备份到底有没有在工作的唯一信号。
pub const PATCHABLE_KEYS: [&str; 7] = [
    "autoLockMinutes",
    "clipboardClearSeconds",
    "kdfPreset",
    "backupDir",
    "backupAuto",
    "keepVersions",
    "lockOnSleep",
];

impl AppConfig {
    /// 把不认识的值收回最近的合法值，路径类字段去空白。
    ///
    /// `config.json` 是给人看、也允许手改的。读到 `"autoLockMinutes": 999` 时，
    /// 界面上的下拉会落到第一项（从不锁定）—— 显示的和配置里的不一致，
    /// 而用户没有任何办法看出这件事。宁可退回最近的合法值。
    pub fn normalized(self) -> Self {
        let AppConfig {
            auto_lock_minutes,
            clipboard_clear_seconds,
            kdf_preset,
            backup_dir,
            backup_auto,
            keep_versions,
            lock_on_sleep,
            last_opened_vault,
            last_backup_at,
            last_backup_error,
            window,
        } = self;

        let clean = |v: Option<String>| v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());

        // 窗口几何里出现 NaN / 无穷就不能留：`serde_json` 会把它们写成 `null`，
        // 而 `null` 再读回来的时候 `from_str` 会**整份配置解析失败**，
        // 于是所有设置一起退回默认值 —— 一个坏掉的窗口坐标不该有这种后果。
        let window = window.filter(|g| {
            g.x.is_finite()
                && g.y.is_finite()
                && g.width.is_finite()
                && g.height.is_finite()
                && g.width > 0.0
                && g.height > 0.0
        });

        Self {
            auto_lock_minutes: if AUTO_LOCK_MINUTES.contains(&auto_lock_minutes) {
                auto_lock_minutes
            } else {
                nearest(&AUTO_LOCK_MINUTES, auto_lock_minutes)
            },
            clipboard_clear_seconds: if CLIPBOARD_SECONDS.contains(&clipboard_clear_seconds) {
                clipboard_clear_seconds
            } else {
                nearest(&CLIPBOARD_SECONDS, clipboard_clear_seconds)
            },
            kdf_preset: if KDF_PRESETS.contains(&kdf_preset.as_str()) {
                kdf_preset
            } else {
                AppConfig::default().kdf_preset
            },
            backup_dir: clean(backup_dir),
            backup_auto,
            keep_versions: keep_versions.clamp(KEEP_VERSIONS_MIN, KEEP_VERSIONS_MAX),
            lock_on_sleep,
            last_opened_vault: clean(last_opened_vault),
            last_backup_at: clean(last_backup_at),
            last_backup_error: clean(last_backup_error),
            window,
        }
    }
}

/// 读配置。文件不存在或损坏时返回默认值 —— 配置丢失不该让应用起不来。
pub fn load_from(dir: &Path) -> AppConfig {
    let path = path_in(dir);
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text)
            .map(AppConfig::normalized)
            .unwrap_or_default(),
        Err(_) => AppConfig::default(),
    }
}

/// 按 JSON 补丁改配置，返回改完之后的那份。
///
/// 为什么是「读—改—写」而不是让前端把整份 `AppConfig` 传回来覆盖：
/// 备份成功后 Rust 会写 `lastBackupAt`，而前端手里那份是打开设置页时拿到的。
/// 整份覆盖会把刚写的时间戳冲掉。
///
/// 只认 [`PATCHABLE_KEYS`]；出现别的键就报错，而不是默默忽略 ——
/// 前端拼错一个字段名、或者试图改后端自己维护的字段，都应该当场看得见。
pub fn merge_patch(dir: &Path, patch: &serde_json::Value) -> Result<AppConfig, String> {
    let obj = patch
        .as_object()
        .ok_or_else(|| "设置补丁必须是一个 JSON 对象".to_string())?;

    for key in obj.keys() {
        if !PATCHABLE_KEYS.contains(&key.as_str()) {
            return Err(format!("不能通过设置页修改这一项：{key}"));
        }
    }

    let mut base = serde_json::to_value(load_from(dir)).unwrap_or_else(|_| serde_json::json!({}));
    if let Some(map) = base.as_object_mut() {
        for (k, v) in obj {
            map.insert(k.clone(), v.clone());
        }
    }

    let merged: AppConfig =
        serde_json::from_value(base).map_err(|e| format!("设置的值类型不对：{e}"))?;
    let merged = merged.normalized();

    save_to(dir, &merged).map_err(|e| format!("保存设置失败：{e}"))?;
    Ok(merged)
}

// ------------------------------------------------------------------ 备份记账

/// 备份成功：记下时间，清掉上一次的失败原因。
///
/// 与设置补丁走两条路：这两个字段是后端自己维护的，`PATCHABLE_KEYS` 里没有它们。
pub fn note_backup_success(dir: &Path, at: String) -> io::Result<AppConfig> {
    let mut cfg = load_from(dir);
    cfg.last_backup_at = Some(at);
    cfg.last_backup_error = None;
    save_to(dir, &cfg)?;
    Ok(cfg)
}

/// 备份失败：记下原因，**保留**上一次的成功时间。
///
/// 那个时间不能说没就没 —— 「上次成功是什么时候」正是判断备份坏了多久的依据，
/// 失败一次就抹掉的话，设置页只剩一句错误，看不出已经坏了三天。
pub fn note_backup_failure(dir: &Path, error: String) -> io::Result<AppConfig> {
    let mut cfg = load_from(dir);
    cfg.last_backup_error = Some(error);
    save_to(dir, &cfg)?;
    Ok(cfg)
}

/// 写配置。走原子写，避免掉电留下半个 JSON。
///
/// 落盘前过一遍 [`AppConfig::normalized`]：`serde_json` 会把 NaN / 无穷写成
/// `null`，而 `null` 再读回来时整份 `AppConfig` 的解析会失败、所有设置一起
/// 退回默认值。写坏值的代价太大，宁可在这里统一收一次。
pub fn save_to(dir: &Path, cfg: &AppConfig) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let cfg = cfg.clone().normalized();
    let text = serde_json::to_string_pretty(&cfg).unwrap_or_else(|_| "{}".to_string());
    crate::fileio::write_atomic(&path_in(dir), text.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(name);
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    /// 配置丢失不该让应用起不来
    #[test]
    fn missing_file_falls_back_to_default() {
        let dir = temp_dir("dreamanual-cfg-missing");
        let cfg = load_from(&dir);
        assert_eq!(cfg, AppConfig::default());
        assert!(cfg.backup_dir.is_none(), "首次启动时备份目录必须是未设置");
    }

    #[test]
    fn save_then_load_roundtrips() {
        let dir = temp_dir("dreamanual-cfg-roundtrip");
        let cfg = AppConfig {
            backup_dir: Some("/tmp/vault-backup".to_string()),
            ..AppConfig::default()
        };
        save_to(&dir, &cfg).unwrap();

        assert_eq!(load_from(&dir), cfg);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn broken_file_falls_back_to_default() {
        let dir = temp_dir("dreamanual-cfg-broken");
        fs::create_dir_all(&dir).unwrap();
        fs::write(path_in(&dir), "{ 这不是 json").unwrap();

        assert_eq!(load_from(&dir), AppConfig::default());
        let _ = fs::remove_dir_all(&dir);
    }

    // ---------------------------------------------------------- 收回合法值

    /// 手改出来的越界值要能被收回最近的合法档位。
    /// 收不回的话，界面上的下拉会落到第一项，而配置里还是那个值 —— 用户看不出来。
    #[test]
    fn normalized_pulls_values_back_to_the_nearest_legal_one() {
        let cfg = AppConfig {
            auto_lock_minutes: 999,
            clipboard_clear_seconds: 25,
            kdf_preset: "飞快".to_string(),
            keep_versions: 500,
            backup_dir: Some("   ".to_string()),
            ..AppConfig::default()
        }
        .normalized();

        assert_eq!(cfg.auto_lock_minutes, 30, "999 最近的合法档位是 30");
        assert_eq!(cfg.clipboard_clear_seconds, 30, "25 到 30 比到 15 近");
        assert_eq!(cfg.kdf_preset, "均衡");
        assert_eq!(cfg.keep_versions, KEEP_VERSIONS_MAX);
        assert_eq!(cfg.backup_dir, None, "纯空白的路径等于没设置");
    }

    /// 并列时取小的：7 分钟到 5 与到 15 一样近
    #[test]
    fn normalized_breaks_ties_towards_the_smaller_value() {
        let cfg = AppConfig {
            auto_lock_minutes: 7,
            ..AppConfig::default()
        }
        .normalized();
        assert_eq!(cfg.auto_lock_minutes, 5);
    }

    #[test]
    fn normalized_leaves_legal_values_alone() {
        let cfg = AppConfig::default();
        assert_eq!(cfg.clone().normalized(), cfg);
    }

    /// 磁盘上写着越界值时，读出来就该是收回后的那份
    #[test]
    fn load_normalizes_what_is_on_disk() {
        let dir = temp_dir("dreamanual-cfg-normalize-load");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            path_in(&dir),
            r#"{"autoLockMinutes":999,"clipboardClearSeconds":30,
                "kdfPreset":"均衡","backupDir":null,"backupAuto":true,"keepVersions":10,
                "lockOnSleep":true,"lastOpenedVault":null,"lastBackupAt":null,"lastBackupError":null}"#,
        )
        .unwrap();

        assert_eq!(load_from(&dir).auto_lock_minutes, 30);
        let _ = fs::remove_dir_all(&dir);
    }

    // ---------------------------------------------------------- 设置补丁

    #[test]
    fn merge_patch_changes_only_what_the_patch_names() {
        let dir = temp_dir("dreamanual-cfg-patch");
        let before = AppConfig {
            backup_dir: Some("/tmp/vault-backup".to_string()),
            ..AppConfig::default()
        };
        save_to(&dir, &before).unwrap();

        let after = merge_patch(&dir, &serde_json::json!({ "autoLockMinutes": 15 })).unwrap();

        assert_eq!(after.auto_lock_minutes, 15);
        assert_eq!(after.backup_dir, before.backup_dir, "没点名的字段不该被动");
        assert_eq!(after.keep_versions, before.keep_versions);
        assert_eq!(load_from(&dir), after, "改完要落盘");

        let _ = fs::remove_dir_all(&dir);
    }

    /// 这是 `merge_patch` 存在的理由：备份成功时 Rust 会写 `lastBackupAt`，
    /// 而前端手里那份配置是打开设置页时拿到的。整份覆盖会把它冲掉，
    /// 而「上次备份成功时间」正是发现备份坏了的第一信号。
    #[test]
    fn merge_patch_cannot_clobber_backup_bookkeeping() {
        let dir = temp_dir("dreamanual-cfg-patch-guard");
        let stamped = AppConfig {
            last_backup_at: Some("2026-09-21T18:30:00+08:00".to_string()),
            last_backup_error: Some("上一次的失败原因".to_string()),
            ..AppConfig::default()
        };
        save_to(&dir, &stamped).unwrap();

        // 显式想改它 —— 要报错，而不是默默忽略
        let err = merge_patch(&dir, &serde_json::json!({ "lastBackupAt": null })).unwrap_err();
        assert!(err.contains("不能通过设置页修改"), "实际是：{err}");

        // 顺手把整个对象传回来（前端最容易犯的错）同样要被挡住。
        // 搭子字段用一个**合法**的可改项 —— 否则这条会因为「先撞上不可改的键」而通过，
        // 验不到「有一条不可改的键在，整份补丁就都不生效」这件事。
        let err =
            merge_patch(&dir, &serde_json::json!({ "autoLockMinutes": 15, "lastOpenedVault": null }))
                .unwrap_err();
        assert!(err.contains("lastOpenedVault"), "实际是：{err}");

        // 挡住之后磁盘上一个字节都不该变
        let on_disk = load_from(&dir);
        assert_eq!(on_disk.last_backup_at, stamped.last_backup_at);
        assert_eq!(on_disk.last_backup_error, stamped.last_backup_error);
        assert_eq!(
            on_disk.auto_lock_minutes, stamped.auto_lock_minutes,
            "被拒的那次不该留下半截改动"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn merge_patch_normalizes_and_reports_the_result() {
        let dir = temp_dir("dreamanual-cfg-patch-normalize");
        let after = merge_patch(&dir, &serde_json::json!({ "keepVersions": 999 })).unwrap();
        assert_eq!(after.keep_versions, KEEP_VERSIONS_MAX, "返回的就是落盘的那份");
        assert_eq!(load_from(&dir), after);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn merge_patch_rejects_wrong_types_without_writing() {
        let dir = temp_dir("dreamanual-cfg-patch-type");
        save_to(&dir, &AppConfig::default()).unwrap();

        let err = merge_patch(&dir, &serde_json::json!({ "autoLockMinutes": "十五" })).unwrap_err();
        assert!(err.contains("类型不对"), "实际是：{err}");
        assert_eq!(load_from(&dir), AppConfig::default());

        let err = merge_patch(&dir, &serde_json::json!(["不是对象"])).unwrap_err();
        assert!(err.contains("JSON 对象"), "实际是：{err}");

        let _ = fs::remove_dir_all(&dir);
    }

    /// 备份目录可以被清掉 —— 那是「取消设置」，与「没传这个字段」是两件事
    #[test]
    fn merge_patch_can_clear_the_backup_dir_with_null() {
        let dir = temp_dir("dreamanual-cfg-patch-clear");
        save_to(
            &dir,
            &AppConfig {
                backup_dir: Some("/tmp/somewhere".to_string()),
                ..AppConfig::default()
            },
        )
        .unwrap();

        let after = merge_patch(&dir, &serde_json::json!({ "backupDir": null })).unwrap();
        assert_eq!(after.backup_dir, None);
        assert_eq!(load_from(&dir).backup_dir, None);

        let _ = fs::remove_dir_all(&dir);
    }

    // ---------------------------------------------------------- 窗口几何

    #[test]
    fn window_geometry_survives_a_roundtrip() {
        let dir = temp_dir("dreamanual-cfg-window");
        let g = crate::window::Geometry {
            x: -1200.0,
            y: 40.0,
            width: 1080.0,
            height: 720.0,
        };
        save_to(
            &dir,
            &AppConfig {
                window: Some(g),
                ..AppConfig::default()
            },
        )
        .unwrap();

        assert_eq!(load_from(&dir).window, Some(g));
        let _ = fs::remove_dir_all(&dir);
    }

    /// 坏掉的窗口坐标必须被丢掉，而且**不能牵连别的设置**。
    ///
    /// 这是这一条存在的全部理由：`serde_json` 把 NaN 写成 `null`，而 `null`
    /// 读回来时 `from_str` 会整份解析失败 —— 于是备份目录、自动锁定时间、KDF 档位
    /// 会一起退回默认值，而用户只会看到「我的设置全没了」。
    #[test]
    fn broken_geometry_does_not_take_the_rest_of_the_config_with_it() {
        let dir = temp_dir("dreamanual-cfg-window-bad");
        let cfg = AppConfig {
            auto_lock_minutes: 30,
            backup_dir: Some("/tmp/不该丢".to_string()),
            window: Some(crate::window::Geometry {
                x: f64::NAN,
                y: 0.0,
                width: 1080.0,
                height: 720.0,
            }),
            ..AppConfig::default()
        };
        save_to(&dir, &cfg).unwrap();

        let back = load_from(&dir);
        assert_eq!(back.window, None, "坏掉的几何该被丢掉");
        assert_eq!(back.auto_lock_minutes, 30);
        assert_eq!(
            back.backup_dir.as_deref(),
            Some("/tmp/不该丢"),
            "别的设置不该被一条坏坐标带走"
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
