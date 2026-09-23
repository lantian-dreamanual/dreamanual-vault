//! Dreamanual 密码管理 · Rust 侧。
//!
//! 模块划分见 PRD §8.2。M2 起 `vault` / `fileio` / `config` 可用；
//! M3 起 `backup` / `lock` / `clipboard` 实装、设置相关命令落在 `settings`；
//! M4 起 `menu`（应用菜单栏）与 `window`（窗口几何）实装。
//!
//! 三条与 M0/M1 有关的约定保留了下来：
//!   - 启动读数经 `report_boot` 打印到 stdout，配 `VAULT_PERF_EXIT=1` 打印完即退出，
//!     这样性能采集不依赖肉眼看秒表
//!   - 曾试过用本地回环 HTTP 端口做「独立于 IPC」的上报通道，被 WKWebView 的
//!     App Transport Security 静默拦掉，已弃用，只走 invoke
//!   - 开发期库文件写进 `VAULT_HOME` 指向的目录，不碰正式位置（见 vault.rs）

mod backup;
mod clipboard;
mod config;
mod fileio;
mod lock;
mod menu;
mod settings;
mod update;
mod vault;
mod window;

use std::io::Write;
use std::sync::OnceLock;
use std::time::Instant;

use tauri::{Emitter, Manager};

static PROCESS_START: OnceLock<Instant> = OnceLock::new();

fn elapsed_ms() -> u128 {
    PROCESS_START
        .get()
        .map(|t| t.elapsed().as_millis())
        .unwrap_or(0)
}

/// 收到前端启动自检的读数
#[tauri::command]
fn report_boot(report: String) -> String {
    println!("================================================================");
    println!("进程启动到读数送达：{} ms", elapsed_ms());
    println!("----------------------------------------------------------------");
    println!("{report}");
    println!("================================================================");
    let _ = std::io::stdout().flush();

    if std::env::var("VAULT_PERF_EXIT").is_ok() {
        std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_millis(250));
            std::process::exit(0);
        });
    }

    "ok".to_string()
}

/// 前端的阶段标记与异常，用于定位「页面没跑起来」这类问题
///
/// 带上进程内时刻：验收卡住或变慢时，「停在哪一条」与「哪一段慢」都能一眼看出来。
/// 只打印相对启动的毫秒数，不引入任何时间依赖。
#[tauri::command]
fn report_error(message: String) -> String {
    println!("[前端 {:>8} ms] {message}", elapsed_ms());
    let _ = std::io::stdout().flush();
    "ok".to_string()
}

/// 开发开关。用 `VAULT_DEV` 传逗号分隔的标记，前端据此跳过需要人工交互的步骤。
///
/// 存在的理由：界面要能自动截图，解锁链路要能自动跑一遍，
/// 而这两件事都卡在「输主密码」这一步上。用环境变量而不是改代码，
/// 是为了同一份前端既能在开发直通模式下跑，也能在真实模式下跑。
///
/// 当前识别的标记：
///   `unlocked`  启动后直接进应用壳，跳过解锁页（界面截图用）
///   `settings`  直开设置面板
///   `settings:data`  直开设置并滚到「数据」那一组（主库位置与导出在那里）
///   `seed`      新建库时灌入演示条目（对照 M1 的界面形态、做 500 条基准）
///   `editor`    打开第一条目的编辑弹窗（改动落在弹窗里时截图用）
///   `accept`    跑一遍完整的自动化验收链路，结果打到 stdout
#[tauri::command]
fn dev_flags() -> String {
    std::env::var("VAULT_DEV").unwrap_or_default()
}

/// 开发期的库主密码。
///
/// 自动化验收要跑真实的 KDF + 解密，绕不开给一个密码。走环境变量传，
/// 而不是写进代码或做成「跳过校验」的分支 —— 后者会让验收测到一条
/// 与用户实际路径不同的代码路径，那就失去意义了。
///
/// 只在开发与验收时设置；正式运行时不设这个变量，返回空串。
#[tauri::command]
fn dev_password() -> String {
    std::env::var("VAULT_DEV_PASSWORD").unwrap_or_default()
}

fn main() {
    PROCESS_START.set(Instant::now()).ok();
    println!("[boot] rust 主函数已启动");
    if let Ok(dir) = std::env::var(vault::HOME_OVERRIDE) {
        println!("[boot] VAULT_HOME={dir}");
    }
    let _ = std::io::stdout().flush();

    tauri::Builder::default()
        // F1.3 / F6.1 的原生文件选择器。插件只返回路径，读写仍归 vault.rs。
        .plugin(tauri_plugin_dialog::init())
        // 「在访达中显示」。capabilities 里只放了 reveal 一条，
        // 没放 open-url / open-path —— 这个应用不需要打开外部链接或文件。
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            report_boot,
            report_error,
            dev_flags,
            dev_password,
            vault::vault_info,
            vault::vault_read,
            vault::vault_write,
            vault::vault_save,
            vault::vault_set_path,
            vault::vault_default_path,
            settings::settings_get,
            settings::settings_update,
            settings::backup_status,
            settings::backup_run,
            settings::settings_choices,
            settings::vault_versions,
            lock::lock_activity,
            lock::lock_arm,
            lock::lock_disarm,
            lock::lock_configure,
            lock::lock_status,
            lock::lock_label,
            clipboard::clipboard_arm,
            clipboard::clipboard_disarm,
            clipboard::clipboard_configure,
            clipboard::clipboard_clear_now,
            clipboard::clipboard_status,
            update::app_version,
            update::open_external
        ])
        .manage(lock::AutoLock::new())
        .manage(clipboard::Clipboard::new())
        // 应用菜单栏（PRD §7.2）。菜单里「设置」与「锁定」两条经事件交给前端，
        // 因为那两件事都有「当前停在哪一屏」的前置条件，判断只留前端一处。
        .menu(menu::build)
        .on_menu_event(|app, event| {
            if let Some(action) = menu::action_for(event.id().as_ref()) {
                // 打一行：菜单栏这条链路在外面看不到（macOS 的辅助功能权限在自动化
                // 环境里通常拿不到，读不到也点不动菜单），留一行日志至少能用手按一次验证。
                println!("[boot] 菜单：{action}");
                let _ = std::io::stdout().flush();
                let _ = app.emit(menu::MENU_EVENT, action);
            }
        })
        .setup(|app| {
            println!("[boot] 窗口已建立，等待页面");
            // 窗口几何在这里恢复：`setup` 跑在页面加载之前，用户看不到中间那一帧。
            if let Some(win) = app.get_webview_window(window::SHELL_LABEL) {
                println!("[boot] 窗口几何：{}", window::restore(&win));
                // 侧栏材质只认 NSWindow 的外观，不钉就跟着系统走 —— 理由见 window.rs。
                // 打一行是因为「材质跟了系统」从界面上看不出来源（内容是深色、侧栏是浅色，
                // 判据只有那一片的颜色），出问题时有这行能直接排除掉这一段。
                match window::pin_dark_appearance(&win) {
                    Ok(()) => println!("[boot] 窗口外观：已钉成深色"),
                    Err(e) => eprintln!("[boot] 钉窗口外观失败：{e}"),
                }
            }
            let _ = std::io::stdout().flush();
            // 两个计时线程都放在 Rust 侧：前端的定时器会被 WKWebView 节流，
            // 锁屏时更是整个页面进程被挂起（PRD 附录 K5）。见 lock.rs / clipboard.rs。
            lock::spawn(app.handle().clone());
            clipboard::spawn(app.handle().clone());
            Ok(())
        })
        .on_page_load(|_webview, payload| {
            println!(
                "[boot] 页面加载事件: {:?} url={}（进程内 {} ms）",
                payload.event(),
                payload.url(),
                elapsed_ms()
            );
            let _ = std::io::stdout().flush();
        })
        .build(tauri::generate_context!())
        .expect("构建 Tauri 应用失败")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                // 退出前把剪贴板收一下：进程一没，计时线程也跟着没了，刚复制的那份密码
                // 会一直留在剪贴板里。`flush` 只清「还是我们写的那一份」——
                // 用户在别处复制的内容、以及我们没动过的剪贴板，都不动。
                app.state::<clipboard::Clipboard>().flush();
                // 窗口几何也只在这一个时机写盘。放在「移动/缩放」事件里写的话，
                // 拖窗口的过程中会连续触发几十次写盘。
                window::save(app);
            }
        });
}
