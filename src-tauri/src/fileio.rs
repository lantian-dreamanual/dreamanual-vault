//! 文件读写。
//!
//! 原子写 = 写临时文件 → `fsync` 文件 → `rename` 覆盖 → `fsync` 目录。
//! `rename` 同一文件系统内是原子的，所以断电或崩溃只会留下完整的旧文件或完整的新文件。
//!
//! ⚠️ 这套流程只对本地文件系统成立。Synology Drive 的挂载点由 macOS File Provider
//!    托管（目录里的 `.SynologyWorkingDirectory` 是佐证），在那里：
//!      - 写进去的 tmp 文件本身会被同步到 NAS
//!      - `rename` 走 provider 语义，不再是本地文件系统的原子替换
//!    所以备份目录不走 `write_atomic`，只用 `copy_via_tmp` 做一次性 copy（见 backup.rs）。
//!
//! M1 阶段本模块尚未接到界面上，M2 起由 kdbx 的读写路径调用。

#![allow(dead_code)]

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::Path;

pub fn read(path: &Path) -> io::Result<Vec<u8>> {
    fs::read(path)
}

pub fn exists(path: &Path) -> bool {
    path.exists()
}

/// 原子写。目标目录不存在会自动创建。
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = parent_dir(path)?;
    fs::create_dir_all(dir)?;

    let tmp = tmp_path_of(path);
    {
        let mut file = File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }

    fs::rename(&tmp, path)?;

    // 目录项本身也要落盘，否则 rename 还停留在缓存里
    if let Ok(handle) = File::open(dir) {
        let _ = handle.sync_all();
    }
    Ok(())
}

/// 跨目录复制。用于备份：先把内容写进目标的 `*.tmp`，再改名到正式名，
/// 这样 NAS 上不会留下半个文件。调用前应自行确认目标目录存在（PRD §5.2 的可达性校验）。
pub fn copy_via_tmp(src: &Path, dst: &Path) -> io::Result<()> {
    let bytes = fs::read(src)?;
    let tmp = tmp_path_of(dst);

    {
        let mut file = File::create(&tmp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
    }

    fs::rename(&tmp, dst)?;
    Ok(())
}

fn parent_dir(path: &Path) -> io::Result<&Path> {
    path.parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "路径没有父目录"))
}

fn tmp_path_of(path: &Path) -> std::path::PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "unnamed".to_string());
    path.with_file_name(format!("{name}.tmp"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn write_atomic_does_not_leave_tmp_behind() {
        let dir = temp_dir("dreamanual-io-atomic");
        let target = dir.join("vault.kdbx");

        write_atomic(&target, b"first").unwrap();
        write_atomic(&target, b"second").unwrap();

        assert_eq!(fs::read(&target).unwrap(), b"second");
        assert!(!dir.join("vault.kdbx.tmp").exists(), "临时文件必须被改名掉");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_atomic_creates_missing_directories() {
        let dir = temp_dir("dreamanual-io-nested");
        let target = dir.join("a/b/c/vault.kdbx");

        write_atomic(&target, b"x").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"x");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn copy_via_tmp_replaces_existing_target() {
        let dir = temp_dir("dreamanual-io-copy");
        let src = dir.join("src.kdbx");
        let dst = dir.join("dst.kdbx");

        write_atomic(&src, b"new-content").unwrap();
        write_atomic(&dst, b"old-content").unwrap();

        copy_via_tmp(&src, &dst).unwrap();

        assert_eq!(fs::read(&dst).unwrap(), b"new-content");
        assert!(!dir.join("dst.kdbx.tmp").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
