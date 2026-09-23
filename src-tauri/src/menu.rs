//! 应用菜单（macOS）。对应 PRD §7.2 的「菜单栏：关于 / 设置（⌘,）/ 锁定（⌘L）/ 退出（⌘Q）」。
//!
//! 为什么要自己建一份，而不是用 Tauri 的默认菜单（`Menu::default`）：
//! 默认菜单里有「关于」与「退出」，但本应用真正会被点到的两条 ——「设置」与
//! 「锁定」—— 不在里面。而一旦替换掉默认菜单，它顺带提供的标准项就得自己补齐
//! （服务 / 隐藏 / 显示全部、编辑、窗口）：少了「编辑」子菜单，文本框的
//! 撤销 / 剪切 / 粘贴会从菜单栏里整个消失，用户会以为这功能没有。
//!
//! 「设置」与「锁定」走**事件**回前端，不在 Rust 侧直接动手。理由是这两件事
//! 都有「当前停在哪一屏」的前置条件 —— 解锁页上按 ⌘, 不该翻出设置面板，
//! 库没打开时 ⌘L 不该有动作。判断留在前端一处，才不会出现两套守卫各判各的。
//!
//! 快捷键只写在菜单里（`accelerator`），前端不再自己判 ⌘, 与 ⌘L：
//! macOS 上菜单的 key equivalent 先于网页拿到按键，两边都写会变成
//! 「按一次、触发两下」—— 而这两个动作都是开关语义，触发两下等于没反应。

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Runtime};

/// 菜单事件名。前端 listen 这一个。
pub const MENU_EVENT: &str = "vault://menu";

/// 「设置…」菜单项 id
pub const ID_SETTINGS: &str = "settings";
/// 「锁定」菜单项 id
pub const ID_LOCK: &str = "lock";

/// 两条的加速键。写成常量是为了能被单测直接解析一遍 ——
/// 见 `tests::accelerators_resolve_to_the_documented_keys` 里那段说明：
/// Tauri 把解析失败**静默丢掉**，写错一个字符只会让快捷键消失，不报任何错。
pub const ACCEL_SETTINGS: &str = "CmdOrCtrl+,";
pub const ACCEL_LOCK: &str = "CmdOrCtrl+L";

/// 菜单 id → 前端要执行的动作。
///
/// 系统预定义项（关于 / 退出 / 撤销 …）由 AppKit 自己处理，本来就不会进
/// `on_menu_event`；认不出来的 id 一律返回 `None` 而不是猜一个动作。
pub fn action_for(id: &str) -> Option<&'static str> {
    match id {
        ID_SETTINGS => Some("settings"),
        ID_LOCK => Some("lock"),
        _ => None,
    }
}

/// 建整份菜单，在 `Builder::menu` 里调用。
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let info = app.package_info();
    let about = AboutMetadata {
        name: Some(info.name.clone()),
        version: Some(info.version.to_string()),
        comments: Some("本地加密的 KeePass 密码库".to_string()),
        ..Default::default()
    };

    // macOS 上第一个子菜单是「应用菜单」，它显示的标题由系统取进程名决定，
    // 这里传的名字只在调试与非 macOS 目标下看得到。仍然传产品名，保持一致。
    let app_menu = Submenu::with_items(
        app,
        info.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, ID_SETTINGS, "设置…", true, Some(ACCEL_SETTINGS))?,
            &MenuItem::with_id(app, ID_LOCK, "锁定", true, Some(ACCEL_LOCK))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        "编辑",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        app,
        "窗口",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    Menu::with_items(app, &[&app_menu, &edit_menu, &window_menu])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 只认自己定义的两条。别的 id（包括系统预定义项的 id）不该被当成动作 ——
    /// 猜一个动作出去，后果是在用户没点那个菜单的情况下锁定或翻出设置页。
    #[test]
    fn only_own_ids_map_to_actions() {
        assert_eq!(action_for(ID_SETTINGS), Some("settings"));
        assert_eq!(action_for(ID_LOCK), Some("lock"));
        assert_eq!(action_for("quit"), None);
        assert_eq!(action_for("about"), None);
        assert_eq!(action_for(""), None);
        assert_eq!(action_for("settings "), None, "不做去空白这类宽容匹配");
    }

    /// 加速键必须解析得动，而且落到文档里写的那个键上。
    ///
    /// 这条不是形式主义：`tauri::menu::MenuItem::with_id` 内部是
    /// `accelerator.and_then(|s| s.as_ref().parse().ok())` —— **解析失败会被
    /// 静默换成 `None`**。于是把 `"CmdOrCtrl+,"` 写成 `"Cmd+Comma"` 之类，
    /// 菜单项照样在、标题照样对，只是快捷键没了，而且没有任何一处会报错。
    /// 这里把两个字符串自己解析一遍，改坏时先红在这一条上。
    #[test]
    fn accelerators_resolve_to_the_documented_keys() {
        use muda::accelerator::{Accelerator, Code, Modifiers};

        let settings: Accelerator = ACCEL_SETTINGS.parse().expect("设置项加速键解析不了");
        assert!(
            settings.matches(Modifiers::SUPER, Code::Comma),
            "设置项应为 ⌘,"
        );

        let lock: Accelerator = ACCEL_LOCK.parse().expect("锁定项加速键解析不了");
        assert!(lock.matches(Modifiers::SUPER, Code::KeyL), "锁定项应为 ⌘L");
    }
}
