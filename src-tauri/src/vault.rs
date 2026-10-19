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

// ------------------------------------------------------------------ 移动库文件

/// 一次移动做了什么
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveReport {
    /// 搬完之后库在哪
    pub path: String,
    /// 一起搬过去的历史版本份数
    pub versions: usize,
}

/// 选完目标文件夹之后的即时校验。
///
/// 界面按 `block` 决定显示哪条提示，文案在前端 —— 后端只说「为什么不行」，
/// 不写给人看的话。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveCheck {
    /// 目标目录（取真实路径）
    pub dir: String,
    /// 目标文件的完整路径
    pub target: String,
    /// 文件名。搬动不改名 —— 历史版本按 `<文件名>.YYYYMMDD-HHmm.bak` 认亲，
    /// 备份镜像按文件名对齐，改名会同时断掉这两条链。
    pub file_name: String,
    /// 拦下的原因码：`same-dir` / `missing` / `conflict` / `readonly`。
    /// 可移动时为 None。
    pub block: Option<String>,
    /// `conflict` 时那份同名文件在哪
    pub conflict: Option<String>,
    /// 目标在另一块盘上（那一趟要走复制 + 校验 + 删源）
    pub cross_disk: bool,
    /// 目标在云盘同步目录里。只提醒、不拦 —— 库放 SynologyDrive 是正当用法
    pub cloud: bool,
    /// 会一起搬走的历史版本份数
    pub versions: usize,
}

/// 拦下原因对应的一句话。只做后端报错的兜底 —— 普通流程里界面先拦住了，
/// 走不到这里。措辞与前端 `move-dialog.ts` 的 `blockStrip()` 保持一致：
/// 同一个原因在两处说成两句话，用户看不出这是同一件事。
fn block_text(code: &str, file_name: &str, conflict: Option<&str>) -> String {
    match code {
        "same-dir" => "库文件已经在这个文件夹里。请选择其他文件夹。".to_string(),
        "missing" => "这个文件夹打不开。请选择其他文件夹。".to_string(),
        "conflict" => format!(
            "这个文件夹里已有同名文件 {}。请选择其他文件夹，或先重命名该文件。",
            conflict.unwrap_or(file_name)
        ),
        "readonly" => "这个文件夹不能写入。请选择其他文件夹。".to_string(),
        _ => "这个文件夹不能用来放库文件。请选择其他文件夹。".to_string(),
    }
}

/// 云盘同步目录。按挂载点的路径特征认：第三方云盘都在 `~/Library/CloudStorage/`，
/// iCloud Drive 在 `~/Library/Mobile Documents/`。
fn is_cloud_dir(dir: &Path) -> bool {
    let path = dir.to_string_lossy();
    path.contains("/Library/CloudStorage/") || path.contains("/Library/Mobile Documents/")
}

/// 两个路径在不在同一块盘上。`dev()` 是文件所在文件系统的设备号。
fn same_volume(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (fs::metadata(a), fs::metadata(b)) {
        (Ok(x), Ok(y)) => x.dev() == y.dev(),
        _ => false,
    }
}

/// 目录能不能写。
///
/// `metadata().permissions().readonly()` 看不出这件事 —— 目录的可写性由 ACL 和
/// 上层的只读挂载决定，权限位只说明 owner 那一格有没有 w。唯一的判据是真的写一下：
/// 建一个隐藏临时文件，成不成立刻删掉。
fn writable(dir: &Path) -> bool {
    let probe = dir.join(".dreamanual-write-probe");
    match fs::File::create(&probe) {
        Ok(_) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// 移动前的校验。先于任何写入跑完，界面就是靠它一次给出五种结果。
fn preflight(source: &Path, target_dir: &Path) -> Result<MoveCheck, String> {
    let file_name = source
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| format!("路径没有文件名：{}", source.display()))?;
    let src_dir = source
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| format!("路径没有父目录：{}", source.display()))?
        .to_path_buf();

    // 真实路径只用来比对（判「同一个文件夹」「同一块盘」）。
    // **写进目标的路径用用户选的那串** —— `/Volumes` 与 `~/Library/CloudStorage`
    // 里满是符号链接，把解析结果记进配置，设置页会显示一条用户没见过的路径。
    let dir = target_dir.to_path_buf();
    let dir_real = dir.canonicalize().unwrap_or_else(|_| dir.clone());
    let src_real = src_dir.canonicalize().unwrap_or(src_dir);
    let target = dir.join(&file_name);

    let mut check = MoveCheck {
        dir: dir.to_string_lossy().into_owned(),
        target: target.to_string_lossy().into_owned(),
        file_name: file_name.clone(),
        block: None,
        conflict: None,
        cross_disk: false,
        cloud: is_cloud_dir(&dir) || is_cloud_dir(&dir_real),
        versions: crate::backup::list_versions(&src_real, &file_name).len(),
    };

    // 顺序有讲究：同目录要排在「同名冲突」前面 —— 同一个文件夹里那份同名文件
    // 就是库自己，报成「已有同名文件」等于让人去改名改自己。
    if src_real == dir_real {
        check.block = Some("same-dir".to_string());
        return Ok(check);
    }
    if !dir.is_dir() {
        check.block = Some("missing".to_string());
        return Ok(check);
    }
    if target.exists() {
        check.conflict = Some(target.to_string_lossy().into_owned());
        check.block = Some("conflict".to_string());
        return Ok(check);
    }
    if !writable(&dir) {
        check.block = Some("readonly".to_string());
        return Ok(check);
    }

    check.cross_disk = !same_volume(&src_real, &dir_real);
    Ok(check)
}

/// 搬一个文件。同盘 rename，跨盘复制 + 校验 + 删源。
///
/// 跨盘那一趟必须校验：写入是整份复制，长度对上内容也可能不同，而库文件写坏的
/// 后果是整库打不开。校验不过就把目标删掉、源留着 —— 失败的移动不能留下半份库。
fn move_one(from: &Path, to: &Path, same_volume: bool) -> Result<(), String> {
    if same_volume {
        return fs::rename(from, to).map_err(|e| format!("移动失败：{}（{}）", to.display(), e));
    }

    let bytes = fs::read(from).map_err(|e| format!("读取失败：{}（{}）", from.display(), e))?;
    crate::fileio::write_atomic(to, &bytes)
        .map_err(|e| format!("写入失败：{}（{}）", to.display(), e))?;

    let back = fs::read(to).map_err(|e| format!("校验失败：{}（{}）", to.display(), e))?;
    if back != bytes {
        let _ = fs::remove_file(to);
        return Err(format!("校验失败：{}", to.display()));
    }

    fs::remove_file(from).map_err(|e| format!("删除原文件失败：{}（{}）", from.display(), e))
}

/// 把已经搬过去的文件按相反顺序退回去。
///
/// 认输的路径留在原地，但会写进错误串 —— 那时用户至少要能看到「哪一份没回去」，
/// 自己去访达里找得到。
fn rollback(moved: &mut Vec<(PathBuf, PathBuf)>, error: String) -> String {
    let mut stuck: Vec<String> = Vec::new();
    while let Some((now, back)) = moved.pop() {
        if fs::rename(&now, &back).is_err() && move_one(&now, &back, false).is_err() {
            stuck.push(now.to_string_lossy().into_owned());
        }
    }
    if stuck.is_empty() {
        error
    } else {
        format!("{error}；{} 没能退回原处", stuck.join("、"))
    }
}

/// 移动库文件与同目录的历史版本，最后把新位置记进配置。
///
/// 三步的顺序不能换：
///  1. 先搬文件 —— 文件真到了新位置，配置里那条路径才成立
///  2. 再搬历史版本 —— 主库先走，历史版本跟着走；反过来的话中途失败会留下
///     一个「主库还在原地、几份历史版本已经走了」的夹生状态
///  3. 最后写配置 —— 先写配置再搬文件，中途失败会让应用指向一个空位置，
///     界面上就是「库不见了」
///
/// 任一步失败都把已经搬过去的退回去（见 [`rollback`]），配置不写。
///
/// `on_progress(已搬, 总数)` 每搬完一个文件响一次 —— 跨盘那一趟要几秒，界面靠它
/// 显示「（7/11）」；同盘 rename 快到人来不及看，多响几次也无妨。
pub fn move_vault(
    source: &Path,
    target_dir: &Path,
    app_dir: &Path,
    on_progress: &dyn Fn(usize, usize),
) -> Result<MoveReport, String> {
    if !source.exists() {
        return Err(format!("库文件不存在：{}", source.display()));
    }

    let check = preflight(source, target_dir)?;
    if let Some(code) = check.block.as_deref() {
        return Err(block_text(code, &check.file_name, check.conflict.as_deref()));
    }

    let dir = PathBuf::from(&check.dir);
    let target = PathBuf::from(&check.target);
    let src_dir = source
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("/"));
    let rename = !check.cross_disk;
    let total = 1 + check.versions;

    // (现在在哪, 原来在哪)
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();

    if let Err(e) = move_one(source, &target, rename) {
        return Err(rollback(&mut moved, e));
    }
    moved.push((target.clone(), source.to_path_buf()));
    on_progress(1, total);

    let mut versions = 0;
    for version in crate::backup::list_versions(&src_dir, &check.file_name) {
        let Some(name) = version.file_name().map(|n| n.to_os_string()) else {
            continue;
        };
        let dest = dir.join(&name);
        if let Err(e) = move_one(&version, &dest, rename) {
            return Err(rollback(&mut moved, e));
        }
        moved.push((dest, version));
        versions += 1;
        on_progress(1 + versions, total);
    }

    // 落到默认位置时清掉配置项：`configured` 的语义是「库不在默认位置」，
    // 留着一条指向默认位置的记录，界面会以为这个库是「打开的其他库」。
    let record = if target == default_vault_path(app_dir) {
        None
    } else {
        Some(target.to_string_lossy().into_owned())
    };
    if let Err(e) = set_configured_path(app_dir, record.as_deref()) {
        return Err(rollback(&mut moved, format!("记下新位置失败：{e}")));
    }

    Ok(MoveReport {
        path: target.to_string_lossy().into_owned(),
        versions,
    })
}

/// 移动进度：每搬完一个文件发一次（`{ done, total }`）
pub const MOVE_PROGRESS_EVENT: &str = "vault-move-progress";

/// 移动前的即时校验。选完目标文件夹就调一次，把「同目录 / 不存在 / 同名 /
/// 不可写」以及「跨盘 / 云盘 / 历史版本份数」一次问清。
#[tauri::command]
pub fn vault_move_check(dir: String) -> Result<MoveCheck, String> {
    preflight(&vault_path(), Path::new(dir.trim()))
}

/// 把库文件与同目录的历史版本一起搬到 `dir`。
///
/// **不锁库。** 搬的是同一个文件，内容没变，主密码也不用重输 —— 调用方在搬之前
/// 把内存里的改动落盘（`store.moveTo`），搬完之后会话与界面照旧。
#[tauri::command]
pub fn vault_move(dir: String, app: tauri::AppHandle) -> Result<MoveReport, String> {
    use tauri::Emitter as _;
    move_vault(
        &vault_path(),
        Path::new(dir.trim()),
        &app_dir(),
        &|done, total| {
            // 发不出去也不影响搬 —— 进度只是一行字
            let _ = app.emit(
                MOVE_PROGRESS_EVENT,
                serde_json::json!({ "done": done, "total": total }),
            );
        },
    )
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

    // ---------------------------------------------------------- 移动库文件

    /// 搬库要连带同目录的历史版本，且新位置要写进配置 —— 否则下次启动
    /// 会回到一个空文件上，界面上就是「库不见了」。
    #[test]
    fn move_takes_the_versions_along_and_records_the_new_path() {
        let root = temp_dir("dreamanual-vault-move");
        let home = root.join("home");
        let old = root.join("旧文件夹");
        let new = root.join("新文件夹");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&old).unwrap();
        fs::create_dir_all(&new).unwrap();

        let vault = old.join("蓝添.kdbx");
        fs::write(&vault, b"vault-bytes").unwrap();
        for stamp in ["20260921-0900", "20260922-1000"] {
            fs::write(
                old.join(crate::backup::version_name("蓝添.kdbx", stamp)),
                stamp.as_bytes(),
            )
            .unwrap();
        }

        let report = move_vault(&vault, &new, &home, &|_, _| {}).unwrap();

        assert_eq!(report.versions, 2, "同目录的两份历史版本要一起走");
        assert_eq!(fs::read(new.join("蓝添.kdbx")).unwrap(), b"vault-bytes");
        assert!(!vault.exists(), "原位置不该还留着库");
        assert!(
            new.join(crate::backup::version_name("蓝添.kdbx", "20260921-0900"))
                .exists(),
            "历史版本要跟到新文件夹"
        );
        assert_eq!(
            crate::backup::list_versions(&old, "蓝添.kdbx").len(),
            0,
            "旧文件夹里不该剩下历史版本"
        );

        assert_eq!(
            configured_path_in(&home).as_deref(),
            Some(report.path.as_str()),
            "新位置必须记进配置"
        );

        let _ = fs::remove_dir_all(&root);
    }

    /// 搬回默认位置等于「不在别处了」，配置项要清掉 —— 留着的话设置页会把
    /// 默认库当成「打开的其他库」。
    #[test]
    fn moving_back_to_the_default_dir_clears_the_config_entry() {
        let root = temp_dir("dreamanual-vault-move-back");
        let home = root.join("home");
        let old = root.join("旧文件夹");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&old).unwrap();

        let vault = old.join(VAULT_FILE);
        fs::write(&vault, b"x").unwrap();

        let report = move_vault(&vault, &home, &home, &|_, _| {}).unwrap();

        assert_eq!(PathBuf::from(&report.path), default_vault_path(&home));
        assert_eq!(configured_path_in(&home), None, "回到默认位置就不该留配置");

        let _ = fs::remove_dir_all(&root);
    }

    /// 同名冲突要拦在写入之前，且一个字都不动
    #[test]
    fn conflict_blocks_the_move_and_touches_nothing() {
        let root = temp_dir("dreamanual-vault-move-conflict");
        let old = root.join("旧文件夹");
        let new = root.join("新文件夹");
        fs::create_dir_all(&old).unwrap();
        fs::create_dir_all(&new).unwrap();

        let vault = old.join("蓝添.kdbx");
        fs::write(&vault, b"mine").unwrap();
        let occupied = new.join("蓝添.kdbx");
        fs::write(&occupied, b"theirs").unwrap();

        let check = preflight(&vault, &new).unwrap();
        assert_eq!(check.block.as_deref(), Some("conflict"));
        assert_eq!(check.conflict.as_deref(), Some(occupied.to_string_lossy().as_ref()));

        assert!(move_vault(&vault, &new, &root, &|_, _| {}).is_err());
        assert_eq!(fs::read(&vault).unwrap(), b"mine", "原库要原样留着");
        assert_eq!(fs::read(&occupied).unwrap(), b"theirs", "不覆盖别人的那份");

        let _ = fs::remove_dir_all(&root);
    }

    /// 同目录要单独报，不能报成「已有同名文件」—— 那句会让人去改名改自己
    #[test]
    fn same_dir_is_reported_before_conflict() {
        let root = temp_dir("dreamanual-vault-move-same");
        fs::create_dir_all(&root).unwrap();
        let vault = root.join("vault.kdbx");
        fs::write(&vault, b"x").unwrap();

        let check = preflight(&vault, &root).unwrap();
        assert_eq!(check.block.as_deref(), Some("same-dir"));
        assert_eq!(check.conflict, None);

        let _ = fs::remove_dir_all(&root);
    }

    /// 目标文件夹不存在时不该顺手把它建出来
    #[test]
    fn missing_target_dir_blocks_without_creating_it() {
        let root = temp_dir("dreamanual-vault-move-missing");
        let vault = root.join("vault.kdbx");
        fs::write(&vault, b"x").unwrap();

        let gone = root.join("这个文件夹不在");
        let check = preflight(&vault, &gone).unwrap();
        assert_eq!(check.block.as_deref(), Some("missing"));
        assert!(!gone.exists());

        let _ = fs::remove_dir_all(&root);
    }

    /// 校验会顺带报出「会一起搬几份历史版本」，界面的副标题与弹窗都用它
    #[test]
    fn check_counts_the_versions_beside_the_vault() {
        let root = temp_dir("dreamanual-vault-move-count");
        let old = root.join("old");
        let new = root.join("new");
        fs::create_dir_all(&old).unwrap();
        fs::create_dir_all(&new).unwrap();

        let vault = old.join("vault.kdbx");
        fs::write(&vault, b"x").unwrap();
        for stamp in ["20260921-0900", "20260922-1000", "20260923-1100"] {
            fs::write(old.join(crate::backup::version_name("vault.kdbx", stamp)), b"v").unwrap();
        }
        // 别家的历史版本不跟着走
        fs::write(old.join(crate::backup::version_name("别的库.kdbx", "20260921-0900")), b"v").unwrap();

        let check = preflight(&vault, &new).unwrap();
        assert_eq!(check.versions, 3);
        assert!(check.block.is_none());
        assert!(!check.cross_disk, "同一个临时目录当然同盘");
        assert!(!check.cloud);

        let _ = fs::remove_dir_all(&root);
    }
}
