//! 设置页与 Rust 侧之间的命令。**M3 起可用。**
//!
//! 只做三件事：把配置读出来、把补丁写回去、把备份跑起来。
//! 真正的逻辑在 `config`（怎么改才安全）与 `backup`（怎么备才不丢东西）里，
//! 这层只负责把它们接上 IPC。

use serde::Serialize;

use crate::backup::{self, BackupRun, BackupStatus};
use crate::config::{self, AppConfig};
use crate::vault;

/// 设置页打开时把整份配置读走。
///
/// 读到的值已经过 `normalized()` —— 磁盘上被手改成越界值时，
/// 界面拿到的与它将要显示的是同一份，不会出现「下拉落在第一项、配置里是别的数」。
#[tauri::command]
pub fn settings_get() -> AppConfig {
    config::load_from(&vault::app_dir())
}

/// 按补丁改配置，返回落盘之后的那份。
///
/// 前端改一项就只传那一项（`{"autoLockMinutes": 15}`），不要把手里的整份传回来：
/// 前端那份是打开设置页时读的，而备份成功后 Rust 会写 `lastBackupAt` ——
/// 整份覆盖会把刚写的时间戳冲掉，而那个时间是发现备份坏了的第一信号。
///
/// 返回值一定要用上：`normalized()` 可能把越界值收回到合法档位，
/// 界面照返回值重新渲染才不会和磁盘不一致。
#[tauri::command]
pub fn settings_update(patch: serde_json::Value) -> Result<AppConfig, String> {
    config::merge_patch(&vault::app_dir(), &patch)
}

/// 备份状态。设置页每次打开、每次保存后都重新问一次。
#[tauri::command]
pub fn backup_status() -> BackupStatus {
    backup::status_of(&config::load_from(&vault::app_dir()))
}

/// 跑一次备份。
///
/// 两个调用点：
/// - 每次保存之后（`manual = false`，会看「保存后自动镜像」这个开关）
/// - 设置页的「立即备份」按钮（`manual = true`，忽略那个开关）
///
/// 返回的 `error` 是**备份**的错误，不是保存的错误 —— 备份失败不阻塞保存，
/// 库在那个时点已经写进磁盘了。调用方按这个语义展示提示。
#[tauri::command]
pub fn backup_run(manual: bool) -> BackupRun {
    let dir = vault::app_dir();
    backup::run_from_config(&dir, &vault::vault_path(), manual)
}

/// 配置层认得的合法取值。
///
/// 存在的理由是验收要拿它和设置页 `<option>` 一一对比：界面给出一个值、
/// 配置层的 `normalized()` 不认，用户点完保存、下次打开发现又变回去了，
/// 而界面上没有任何地方说过这件事。这个命令把「配置层认什么」变成可读的，
/// 断言才能量它。前端平时不用它 —— 面板渲染走 `settings_get`。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsChoices {
    pub auto_lock_minutes: Vec<u32>,
    pub clipboard_clear_seconds: Vec<u32>,
    pub kdf_presets: Vec<String>,
    pub keep_versions_min: u32,
    pub keep_versions_max: u32,
}

#[tauri::command]
pub fn settings_choices() -> SettingsChoices {
    use config::{
        AUTO_LOCK_MINUTES, CLIPBOARD_SECONDS, KDF_PRESETS, KEEP_VERSIONS_MAX, KEEP_VERSIONS_MIN,
    };
    SettingsChoices {
        auto_lock_minutes: AUTO_LOCK_MINUTES.to_vec(),
        clipboard_clear_seconds: CLIPBOARD_SECONDS.to_vec(),
        kdf_presets: KDF_PRESETS.iter().map(|s| s.to_string()).collect(),
        keep_versions_min: KEEP_VERSIONS_MIN,
        keep_versions_max: KEEP_VERSIONS_MAX,
    }
}

/// 主库旁边的历史版本，从新到旧。设置页与验收都用它看轮转有没有在跑。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    pub path: String,
    pub name: String,
    pub size: u64,
    /// epoch 毫秒
    pub modified_at: Option<u64>,
}

/// 列出某个库文件旁边的历史版本。
///
/// `path` 不给就是当前库。传它是因为验收要用它看 `.dev-home/` 里的轮转，
/// 而那个目录不等于进程启动时的「当前库」。
#[tauri::command]
pub fn vault_versions(path: Option<String>) -> Vec<VersionInfo> {
    let target = match path.as_deref().map(str::trim) {
        Some(p) if !p.is_empty() => std::path::PathBuf::from(p),
        _ => vault::vault_path(),
    };
    let Some(dir) = target.parent() else {
        return Vec::new();
    };
    let Some(base) = target.file_name().map(|n| n.to_string_lossy().into_owned()) else {
        return Vec::new();
    };

    backup::list_versions(dir, &base)
        .into_iter()
        .map(|p| {
            let meta = std::fs::metadata(&p).ok();
            VersionInfo {
                name: p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                modified_at: meta
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64),
                path: p.to_string_lossy().into_owned(),
            }
        })
        .collect()
}
