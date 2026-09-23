//! 库文件（`.kdbx`）的定位与读写。
//!
//! 分工：`fileio` 管「怎么写才不会写坏」，本模块管「库在哪、怎么和前端换字节」。
//!
//! 字节走 base64 而不是 `Vec<u8>`：Tauri 的 IPC 会把 `Vec<u8>` 序列化成 JSON 数字
//! 数组，几十 KB 的库要膨胀成四倍长的文本再逐字符解析。base64 是 4/3，且前端的
//! `atob` 是原生的。
//!
//! ## VAULT_HOME 覆盖
//!
//! 正式位置是 `~/Library/Application Support/Dreamanual密码管理/`。
//! 开发与自动化验收要反复建库、改库、重开库，这些都不该落在正式目录上 ——
//! 那里放的是真实凭据。有了这个环境变量，「开发期不碰正式库」就是一条默认成立的
//! 约束，不必靠人记得。
//!
//! ## 为什么路径是参数而不是全局状态
//!
//! `vault_read` / `vault_write` 都接受可选的 `path`。默认传 `None` 用当前库，
//! 传了就用指定的 —— F1.3「打开其他库」与 F6.1「导出」走的是同一条通道，
//! 接它们时后端零改动。前端把「当前库在哪」记在会话里。
//!
//! ## 「当前库」是什么
//!
//! 默认是 `app_dir()/vault.kdbx`。走一次「打开其他库」（F1.3）之后，
//! 选中的路径会写进 `config.json` 的 `last_opened_vault`，此后它**就是**当前库
//! （PRD §5.1：路径记入应用配置，成为后续保存的目标）。所以换库不需要前端
//! 记住任何东西 —— 前端照旧传 `None`，路径由这里解析。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde::Serialize;

pub const VAULT_FILE: &str = "vault.kdbx";
pub const APP_DIR_NAME: &str = "Dreamanual密码管理";
/// 覆盖应用数据目录的环境变量，仅开发与验收使用
pub const HOME_OVERRIDE: &str = "VAULT_HOME";

// ------------------------------------------------------------------ 路径

/// 正式位置在某个 home 下会长成什么样。抽成纯函数是为了能直接测，
/// 不必去改进程级的环境变量（测试并行跑，改 env 会互相串）。
pub fn dir_in(home: &Path) -> PathBuf {
    home.join("Library/Application Support").join(APP_DIR_NAME)
}

/// 实际使用的目录。`override_dir` 非空时优先，对应 `VAULT_HOME`。
pub fn resolve_dir(override_dir: Option<&str>, home: &Path) -> PathBuf {
    match override_dir.map(str::trim) {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => dir_in(home),
    }
}

fn env_home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string()))
}

/// 应用数据目录
pub fn app_dir() -> PathBuf {
    resolve_dir(std::env::var(HOME_OVERRIDE).ok().as_deref(), &env_home())
}

/// 主库的默认位置。配置里没指定其他库时用它。
pub fn default_vault_path(dir: &Path) -> PathBuf {
    dir.join(VAULT_FILE)
}

/// 配置里记着的库路径。空白串当作没设置 —— 手改配置文件时容易留下这种值。
pub fn configured_path_in(dir: &Path) -> Option<String> {
    crate::config::load_from(dir)
        .last_opened_vault
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
}

/// 该用哪个库文件。纯函数 —— 测试不必去改进程级的环境变量
/// （测试并行跑，改 env 会互相串）。
pub fn path_from(configured: Option<&str>, dir: &Path) -> PathBuf {
    match configured.map(str::trim) {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => default_vault_path(dir),
    }
}

/// 实际使用的库文件路径：配置优先，没有配置就是默认位置。
pub fn vault_path() -> PathBuf {
    let dir = app_dir();
    path_from(configured_path_in(&dir).as_deref(), &dir)
}

/// `None` 或空串 → 当前库；否则用给定的路径
fn resolve(path: Option<&str>) -> PathBuf {
    match path.map(str::trim) {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => vault_path(),
    }
}

// ------------------------------------------------------------------ 元信息

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfo {
    pub path: String,
    pub exists: bool,
    pub size: u64,
    /// epoch 毫秒。文件不存在时为 None —— 界面据此决定显示「解锁」还是「新建」
    pub modified_at: Option<u64>,
    /// 这个位置来自配置（即走过一次「打开其他库」），不是默认位置。
    /// 设置页据此给出「用默认位置」这个出口。
    pub configured: bool,
}

pub fn info_of(path: &Path, configured: bool) -> VaultInfo {
    let meta = fs::metadata(path).ok();
    VaultInfo {
        path: path.to_string_lossy().into_owned(),
        exists: meta.is_some(),
        size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
        modified_at: meta
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64),
        configured,
    }
}

// ------------------------------------------------------------------ 命令

/// 库文件在哪、有多大、什么时候改的。界面用它决定进「解锁」还是「新建」。
///
/// 注意这里不创建目录也不创建文件 —— 首次启动时库就是不存在，
/// 这是正常状态而不是错误。
#[tauri::command]
pub fn vault_info(path: Option<String>) -> VaultInfo {
    let dir = app_dir();
    let explicit = matches!(path.as_deref().map(str::trim), Some(p) if !p.is_empty());

    let target = if explicit {
        PathBuf::from(path.as_deref().unwrap().trim())
    } else {
        path_from(configured_path_in(&dir).as_deref(), &dir)
    };

    // 明确传了路径时，configured 说的是「默认位置这件事」，与那个路径无关
    info_of(&target, !explicit && configured_path_in(&dir).is_some())
}

/// 读出整个库文件，base64 编码
#[tauri::command]
pub fn vault_read(path: Option<String>) -> Result<String, String> {
    let p = resolve(path.as_deref());
    let bytes = crate::fileio::read(&p).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!("库文件不存在：{}", p.display())
        } else {
            format!("读取库文件失败：{}（{}）", p.display(), e)
        }
    })?;
    Ok(B64.encode(bytes))
}

/// 原子写入整个库文件，返回写入字节数。
///
/// 全量覆盖而不是增量 —— KDBX 是整体加密的，没有增量写入这回事。
/// 「先写临时文件再改名」由 `fileio::write_atomic` 保证，
/// 所以写一半崩掉只会留下完整的旧文件。
#[tauri::command]
pub fn vault_write(data: String, path: Option<String>) -> Result<u64, String> {
    let p = resolve(path.as_deref());
    let bytes = B64
        .decode(data.as_bytes())
        .map_err(|e| format!("数据不是合法的 base64：{e}"))?;
    crate::fileio::write_atomic(&p, &bytes)
        .map_err(|e| format!("写入库文件失败：{}（{}）", p.display(), e))?;
    Ok(bytes.len() as u64)
}

/// 保存主库。与 `vault_write` 的分工是「谁负责副作用」。
///
/// `vault_write` 是裸操作：把字节写到某个路径，仅此而已。导出（F6.1）用它 ——
/// 导出件是给用户拿走的一份副本，不该在它旁边留下 `.bak`，也不该被镜像进备份目录。
///
/// `vault_save` 是「保存我这一个库」，附带两件只有主库才该做的事：
///
/// 1. **覆盖前**把现有的那份存成历史版本（PRD §5.3）。放在写入之前，
///    因为写入之后旧内容就没了。
/// 2. 写完之后镜像到备份目录（PRD §5.2 / Q4「每次保存后自动镜像」）。
///
/// ⚠️ **备份失败不让这个函数失败。** 库在那个时点已经写进磁盘了，
/// 报错会让界面显示「保存失败」，而实际上用户刚做的改动一个字都没丢 ——
/// 那种提示会让人以为要重做一遍。备份的结果单独放在 `backup` 里，
/// 由调用方决定怎么提示。
#[tauri::command]
pub fn vault_save(data: String, path: Option<String>) -> Result<SaveResult, String> {
    let dir = app_dir();
    let keep = crate::config::load_from(&dir).keep_versions as usize;
    let p = resolve(path.as_deref());

    let bytes = B64
        .decode(data.as_bytes())
        .map_err(|e| format!("数据不是合法的 base64：{e}"))?;

    let local_version = crate::backup::snapshot_local(&p, keep)?;

    crate::fileio::write_atomic(&p, &bytes)
        .map_err(|e| format!("写入库文件失败：{}（{}）", p.display(), e))?;

    let backup = crate::backup::run_from_config(&dir, &p, false);

    Ok(SaveResult {
        bytes: bytes.len() as u64,
        local_version,
        backup,
    })
}

/// 一次保存做了什么
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub bytes: u64,
    /// 这次轮转出来的本地历史版本文件名
    pub local_version: Option<String>,
    /// 备份这一步的结果。`skipped` 有值表示没配备份目录/开关关着；
    /// `error` 有值表示备了但失败了 —— 两者都不是保存失败。
    pub backup: crate::backup::BackupRun,
}

/// 换库的纯逻辑：写配置，返回改完之后的目标路径。
///
/// 传 `None` 或空白串表示清掉配置、回到默认位置 —— 界面上是「用默认位置」那个出口。
/// 不做存在性校验：这一步只是「记下位置」，那个路径上的库存不存在是下一步的事。
pub fn set_configured_path(dir: &Path, path: Option<&str>) -> std::io::Result<PathBuf> {
    let mut cfg = crate::config::load_from(dir);
    cfg.last_opened_vault = path
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_string);
    crate::config::save_to(dir, &cfg)?;
    Ok(path_from(cfg.last_opened_vault.as_deref(), dir))
}

/// F1.3「打开其他库」：把选中的 `.kdbx` 记为当前库（PRD §5.1）。
///
/// 只写配置、不动任何库文件。返回换完之后的位置，界面据此重新分流
/// 「解锁」还是「新建」，并刷新卡片上的路径与大小。
#[tauri::command]
pub fn vault_set_path(path: Option<String>) -> Result<VaultInfo, String> {
    let dir = app_dir();
    let target =
        set_configured_path(&dir, path.as_deref()).map_err(|e| format!("记下库位置失败：{e}"))?;
    Ok(info_of(&target, configured_path_in(&dir).is_some()))
}

/// 默认位置。配置里记着别处的库也不影响它。
///
/// 与 `vault_info(None)` 的区别正是它存在的理由：那个给的是「当前库在哪」，
/// 这个给的是「本来该放哪」。建库时要的是后者 —— 换过库之后，
/// 「当前库」已经指向别处了，拿它当建库落点会落到上一次打开的那个库里。
#[tauri::command]
pub fn vault_default_path() -> String {
    default_vault_path(&app_dir()).to_string_lossy().into_owned()
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

    #[test]
    fn dir_in_is_application_support_under_home() {
        let dir = dir_in(Path::new("/Users/someone"));
        assert_eq!(
            dir,
            Path::new("/Users/someone/Library/Application Support/Dreamanual密码管理")
        );
        assert_eq!(dir.file_name().unwrap(), APP_DIR_NAME);
    }

    /// 开发期不碰正式库这件事，靠的就是这条
    #[test]
    fn override_wins_over_home() {
        let home = Path::new("/Users/someone");
        let dev = "/tmp/dreamanual-dev";

        assert_eq!(resolve_dir(Some(dev), home), PathBuf::from(dev));
        assert_eq!(resolve_dir(None, home), dir_in(home));
        // 空串与纯空白都当作没设置，回落到正式位置
        assert_eq!(resolve_dir(Some(""), home), dir_in(home));
        assert_eq!(resolve_dir(Some("   "), home), dir_in(home));
    }

    #[test]
    fn missing_file_reports_not_exists_and_zero_size() {
        let dir = temp_dir("dreamanual-vault-info");
        let info = info_of(&dir.join("nope.kdbx"), false);

        assert!(!info.exists);
        assert_eq!(info.size, 0);
        assert!(info.modified_at.is_none());
        assert!(info.path.ends_with("nope.kdbx"));
        assert!(!info.configured);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn info_reports_size_and_mtime_for_existing_file() {
        let dir = temp_dir("dreamanual-vault-info2");
        let path = dir.join("vault.kdbx");
        fs::write(&path, b"0123456789").unwrap();

        let info = info_of(&path, true);
        assert!(info.exists);
        assert_eq!(info.size, 10);
        assert!(info.configured, "配置指定的位置要能被界面认出来");
        assert!(info.modified_at.unwrap() > 1_600_000_000_000, "时间戳应是 epoch 毫秒");
        let _ = fs::remove_dir_all(&dir);
    }

    // -------------------------------------------------------- 当前库是谁

    /// PRD §5.1：打开其他库之后，该路径成为后续保存的目标
    #[test]
    fn set_path_makes_it_the_current_vault() {
        let dir = temp_dir("dreamanual-vault-switch");
        let other = dir.join("别处的库.kdbx");
        let other_str = other.to_string_lossy().into_owned();

        // 没配置时用默认位置
        assert_eq!(configured_path_in(&dir), None);
        assert_eq!(
            path_from(configured_path_in(&dir).as_deref(), &dir),
            default_vault_path(&dir)
        );

        let after = set_configured_path(&dir, Some(&other_str)).unwrap();
        assert_eq!(after, other, "返回值就是换完之后的目标");
        assert_eq!(configured_path_in(&dir).as_deref(), Some(other_str.as_str()));
        assert_eq!(path_from(configured_path_in(&dir).as_deref(), &dir), other);

        // 重新读一次配置（相当于重启应用）仍然是这个库
        assert_eq!(
            crate::config::load_from(&dir).last_opened_vault.as_deref(),
            Some(other_str.as_str())
        );

        // 「用默认位置」：清掉配置
        assert_eq!(
            set_configured_path(&dir, None).unwrap(),
            default_vault_path(&dir)
        );
        assert_eq!(configured_path_in(&dir), None);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn blank_configured_path_is_treated_as_unset() {
        let dir = temp_dir("dreamanual-vault-blank");
        let default = default_vault_path(&dir);

        assert_eq!(path_from(None, &dir), default);
        assert_eq!(path_from(Some(""), &dir), default);
        assert_eq!(path_from(Some("   "), &dir), default);
        assert_eq!(
            path_from(Some("  /tmp/x.kdbx  "), &dir),
            PathBuf::from("/tmp/x.kdbx"),
            "两侧空白要去掉，否则路径会带着空格去 open"
        );

        // 手改 config.json 容易留下空白串，它同样要被当作没设置
        let mut cfg = crate::config::AppConfig::default();
        cfg.last_opened_vault = Some("   ".to_string());
        crate::config::save_to(&dir, &cfg).unwrap();
        assert_eq!(configured_path_in(&dir), None);

        let _ = fs::remove_dir_all(&dir);
    }

    /// 换库之后读写要落到新库上 —— 这是 F1.3 真正的验收点
    #[test]
    fn read_and_write_follow_the_configured_path() {
        let dir = temp_dir("dreamanual-vault-follow");
        let other = dir.join("搬到别处的库.kdbx");
        set_configured_path(&dir, Some(&other.to_string_lossy())).unwrap();

        // vault_read / vault_write 走的是 resolve(None) → vault_path()，
        // 而 vault_path() 读的是 app_dir()；测试里无法安全改进程环境变量，
        // 所以这里直接验证解析函数与其上游一致。
        let resolved = path_from(configured_path_in(&dir).as_deref(), &dir);
        assert_eq!(resolved, other);

        let _ = fs::remove_dir_all(&dir);
    }

    /// base64 这条通道要能原样转运二进制 —— 库文件里全是不可打印字节
    #[test]
    fn base64_roundtrips_binary_bytes() {
        let raw: Vec<u8> = (0u8..=255).collect();
        let encoded = B64.encode(&raw);
        assert_eq!(B64.decode(encoded.as_bytes()).unwrap(), raw);
    }

    /// 走完整的「写 → 读 → 比对」链路，确认写入真的落盘且没有 tmp 残留
    #[test]
    fn write_then_read_via_commands_roundtrips() {
        let dir = temp_dir("dreamanual-vault-io");
        let path = dir.join("vault.kdbx");
        let path_str = path.to_string_lossy().into_owned();

        let payload: Vec<u8> = vec![0x03, 0xd9, 0xa2, 0x9a, 0, 1, 2, 255];
        let written = vault_write(B64.encode(&payload), Some(path_str.clone())).unwrap();
        assert_eq!(written, payload.len() as u64);
        assert!(!dir.join("vault.kdbx.tmp").exists(), "临时文件必须被改名掉");

        let read_back = vault_read(Some(path_str)).unwrap();
        assert_eq!(B64.decode(read_back.as_bytes()).unwrap(), payload);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_of_missing_file_says_so_in_chinese() {
        let dir = temp_dir("dreamanual-vault-missing");
        let err = vault_read(Some(dir.join("nope.kdbx").to_string_lossy().into_owned())).unwrap_err();
        assert!(err.contains("库文件不存在"), "实际是：{err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_rejects_non_base64_payload() {
        let dir = temp_dir("dreamanual-vault-badpayload");
        let path = dir.join("vault.kdbx");
        let path_str = path.to_string_lossy().into_owned();

        let err = vault_write("这不是 base64！！".to_string(), Some(path_str)).unwrap_err();
        assert!(err.contains("base64"), "实际是：{err}");
        assert!(!path.exists(), "解码失败时不应产生任何文件");
        let _ = fs::remove_dir_all(&dir);
    }
}
