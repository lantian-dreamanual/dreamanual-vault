//! 窗口几何：记住上次的尺寸与位置。对应 PRD §7.2「默认 1080×720，最小 860×560，
//! 记住上次尺寸与位置」。
//!
//! 为什么不用官方的 `tauri-plugin-window-state`：它把状态固定写进应用的
//! config 目录，而本项目有一条硬约定 —— 开发与验收一律走 `VAULT_HOME`
//! 指向的仓库内目录，绝不碰 `~/Library/Application Support/Dreamanual密码管理/`
//! （那里放真实凭据）。验收会反复起几十次应用，用插件等于每次都在正式目录里
//! 留一份窗口状态。存进 `config.json` 就自然落在 `VAULT_HOME` 下。
//!
//! 判定与取值分开：`decide()` 是纯函数、可单测；只有 `screens()` / `current()`
//! 碰窗口。这样「上次那块屏不在了」这类情形不用真去拔显示器就能测。

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewWindow};

use crate::config;
use crate::vault;

/// 外壳窗口的 label，与 `tauri.conf.json` 一致。
pub const SHELL_LABEL: &str = "main";

/// 与 `tauri.conf.json` 的 `minWidth` / `minHeight` 必须一致 ——
/// 恢复一个比最小尺寸还小的窗口，用户会得到一个拽不动也放不大的窗口。
/// `scripts/m2-acceptance.sh` 里有一条断言拿这两对数比配置文件。
pub const MIN_WIDTH: f64 = 860.0;
pub const MIN_HEIGHT: f64 = 560.0;

/// 恢复位置时，窗口标题栏那一带至少要有这么宽落在某块屏里才算「能拖回来」。
/// 取 120 是因为 macOS 的标题栏拖拽区被红绿灯按钮占掉一截，
/// 剩下的可抓宽度小于这个数就很难点中。
const MIN_VISIBLE_WIDTH: f64 = 120.0;
/// 标题栏本身的高度量级。
const MIN_VISIBLE_HEIGHT: f64 = 40.0;

/// 存进 `config.json` 的窗口几何。全部用**逻辑坐标** ——
/// 物理像素会随显示器缩放变，在外接屏上存的 2160 高度带回笔记本屏就装不下了。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Geometry {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// 一块屏的可用范围，同样是逻辑坐标。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Screen {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// 只带尺寸的那份
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}

/// 恢复方案
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Outcome {
    /// 上次那块屏还在：位置与尺寸都恢复
    Full(Geometry),
    /// 屏对不上了（拔了外接屏、分辨率变了、标题栏跑到屏幕外）：
    /// 只恢复尺寸，位置不碰 —— 窗口本来就是居中的
    SizeOnly(Size),
    /// 保存的值不像话，整条忽略
    Ignore,
}

/// 两个区间重叠的长度，不重叠时为 0。
fn overlap(a_start: f64, a_len: f64, b_start: f64, b_len: f64) -> f64 {
    let lo = a_start.max(b_start);
    let hi = (a_start + a_len).min(b_start + b_len);
    (hi - lo).max(0.0)
}

/// 标题栏那一带是否落在某块屏里。
///
/// 判据取「窗口顶部往下一小段」，而不是「两块矩形有没有相交」：
/// 外接屏拔掉之后，残留的 x 常常只比主屏宽出一点点，矩形相交会判成「还在」，
/// 于是窗口被恢复到一个只露出左侧百分之一的位置 —— 那个位置用户既看不到内容，
/// 也抓不到标题栏。判标题栏能落在屏内，才是「这个位置还能用」。
fn titlebar_usable(g: &Geometry, screens: &[Screen]) -> bool {
    screens.iter().any(|s| {
        overlap(g.x, g.width, s.x, s.width) >= MIN_VISIBLE_WIDTH
            && g.y >= s.y
            && g.y + MIN_VISIBLE_HEIGHT <= s.y + s.height
    })
}

/// 决定这次要恢复成什么样。
///
/// 纯函数：只吃「保存的值」与「当前有哪些屏」。
pub fn decide(saved: Option<Geometry>, screens: &[Screen]) -> Outcome {
    let Some(g) = saved else {
        return Outcome::Ignore;
    };

    // NaN / 无穷 / 零尺寸都可能来自手改的 config.json。
    // 拿它们去 set_size 会让窗口变成一条线或者直接不显示。
    if !(g.x.is_finite() && g.y.is_finite() && g.width.is_finite() && g.height.is_finite()) {
        return Outcome::Ignore;
    }
    if g.width <= 0.0 || g.height <= 0.0 {
        return Outcome::Ignore;
    }

    // 尺寸先收回可用范围：下限对齐配置里的最小尺寸，上限对齐现有屏幕上最大的那一块。
    // 上限这条对应「在外接 4K 上存的尺寸，回到笔记本屏」—— 不夹的话窗口会比屏幕还大，
    // 底部与右侧的内容永远够不到，而 macOS 不会自动帮你缩回去。
    //
    // 一块屏都没读到时不设上限：「读不到屏」与「屏很小」是两件事，
    // 前者是显示器正在重配这种瞬时状态，按它把窗口缩到最小尺寸是错的。
    let (cap_w, cap_h) = if screens.is_empty() {
        (f64::INFINITY, f64::INFINITY)
    } else {
        (
            screens.iter().map(|s| s.width).fold(MIN_WIDTH, f64::max),
            screens.iter().map(|s| s.height).fold(MIN_HEIGHT, f64::max),
        )
    };
    let size = Size {
        width: g.width.clamp(MIN_WIDTH, cap_w),
        height: g.height.clamp(MIN_HEIGHT, cap_h),
    };

    if titlebar_usable(&g, screens) {
        Outcome::Full(Geometry {
            x: g.x,
            y: g.y,
            width: size.width,
            height: size.height,
        })
    } else {
        Outcome::SizeOnly(size)
    }
}

/// 当前窗口的几何。读不到就返回 `None`（不写坏值进配置）。
///
/// 最小化时不返回 —— 最小化状态下 `outer_position()` 常常是屏外的哨兵值，
/// 存下来下次就会恢复到一个看不见的位置。这时保留上一次的值更合理。
pub fn current(win: &WebviewWindow) -> Option<Geometry> {
    if win.is_minimized().unwrap_or(false) {
        return None;
    }
    let scale = win.scale_factor().ok()?;
    let pos = win.outer_position().ok()?.to_logical::<f64>(scale);
    let size = win.inner_size().ok()?.to_logical::<f64>(scale);

    let g = Geometry {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
    };
    if !(g.x.is_finite() && g.y.is_finite() && g.width.is_finite() && g.height.is_finite()) {
        return None;
    }
    Some(g)
}

/// 当前有哪些屏，连同各自的可用范围（逻辑坐标）。
pub fn screens(win: &WebviewWindow) -> Vec<Screen> {
    let Ok(list) = win.available_monitors() else {
        return Vec::new();
    };
    list.into_iter()
        .map(|m| {
            let scale = m.scale_factor();
            let pos = m.position().to_logical::<f64>(scale);
            let size = m.size().to_logical::<f64>(scale);
            Screen {
                x: pos.x,
                y: pos.y,
                width: size.width,
                height: size.height,
            }
        })
        .collect()
}

/// 把方案落到窗口上。
pub fn apply(win: &WebviewWindow, outcome: Outcome) {
    match outcome {
        Outcome::Full(g) => {
            // 先尺寸后位置：反过来的话，窗口先移过去、再长大，
            // 中间那一帧可能越过屏幕边缘。
            let _ = win.set_size(LogicalSize::new(g.width, g.height));
            let _ = win.set_position(LogicalPosition::new(g.x, g.y));
        }
        Outcome::SizeOnly(s) => {
            let _ = win.set_size(LogicalSize::new(s.width, s.height));
        }
        Outcome::Ignore => {}
    }
}

/// 启动时恢复。返回打印用的一句话（验收会读它）。
pub fn restore(win: &WebviewWindow) -> String {
    let saved = config::load_from(&vault::app_dir()).window;
    let outcome = decide(saved, &screens(win));

    let line = match outcome {
        Outcome::Full(g) => format!(
            "恢复上次的位置 {:.0},{:.0} 与尺寸 {:.0}×{:.0}",
            g.x, g.y, g.width, g.height
        ),
        Outcome::SizeOnly(s) => {
            format!("上次的位置已不可用，只恢复尺寸 {:.0}×{:.0}", s.width, s.height)
        }
        Outcome::Ignore => "没有可用的保存值".to_string(),
    };
    apply(win, outcome);
    line
}

/// 退出前把当前几何写回配置。
///
/// 失败只打印 —— 记不住窗口位置是件小事，不该拦住退出。
pub fn save(app: &AppHandle) {
    let Some(win) = app.get_webview_window(SHELL_LABEL) else {
        return;
    };
    let Some(g) = current(&win) else {
        return;
    };

    let dir = vault::app_dir();
    let mut cfg = config::load_from(&dir);
    if cfg.window == Some(g) {
        return;
    }
    cfg.window = Some(g);
    match config::save_to(&dir, &cfg) {
        Ok(()) => println!(
            "[boot] 窗口几何已记下 {:.0},{:.0} {:.0}×{:.0}",
            g.x, g.y, g.width, g.height
        ),
        Err(e) => eprintln!("[boot] 保存窗口几何失败：{e}"),
    }
}

// ------------------------------------------------------------------ 窗口外观

/// 把窗口的 NSAppearance 钉成深色。开机调一次，之后没有地方能改它。
///
/// 为什么必须显式钉：侧栏材质（PRD §7.2）是 `NSVisualEffectView`，它的明暗取自
/// **视图自身的 appearance**，而那个只认 `NSWindow` —— 不钉就跟着系统走。系统是
/// 浅色时，内容区按令牌算出来是深色、侧栏却是一片浅色（实测：内容 248、侧栏 95）。
///
/// 这里原先是 `window_set_appearance` 命令，由前端在每次落主题时调。应用只剩一套
/// 配色之后没有「每次」了 —— 所以从命令降成一个普通函数，挂在 `setup` 里。
pub fn pin_dark_appearance(win: &WebviewWindow) -> Result<(), String> {
    win.set_theme(Some(tauri::Theme::Dark))
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn screen(x: f64, y: f64, width: f64, height: f64) -> Screen {
        Screen {
            x,
            y,
            width,
            height,
        }
    }

    /// 常见情形：单屏 1440×900
    fn main_screen() -> Vec<Screen> {
        vec![screen(0.0, 0.0, 1440.0, 900.0)]
    }

    fn geo(x: f64, y: f64, width: f64, height: f64) -> Geometry {
        Geometry {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn no_saved_value_means_no_restore() {
        assert_eq!(decide(None, &main_screen()), Outcome::Ignore);
    }

    /// 位置与尺寸都在屏内 —— 原样恢复
    #[test]
    fn a_position_on_a_live_screen_is_restored_whole() {
        let saved = geo(120.0, 80.0, 1080.0, 720.0);
        assert_eq!(
            decide(Some(saved), &main_screen()),
            Outcome::Full(saved),
            "屏还在，就不该改动用户摆好的位置"
        );
    }

    /// 外接屏拔掉了：那个位置现在什么都没有。
    /// 这是最容易写错的一条 —— 只判「矩形有相交」会把这类值放过去。
    #[test]
    fn a_position_on_a_removed_display_falls_back_to_size_only() {
        let saved = geo(2500.0, 300.0, 1080.0, 720.0);
        assert_eq!(
            decide(Some(saved), &main_screen()),
            Outcome::SizeOnly(Size {
                width: 1080.0,
                height: 720.0
            }),
            "屏不在了，位置必须放弃、交给系统居中"
        );
    }

    /// 窗口被拖到了主屏下方：横向还重叠着，但标题栏已经完全到屏幕外了。
    /// 只露出窗口右上角一小块不算「能用」—— 那个位置抓不到标题栏。
    #[test]
    fn a_window_whose_titlebar_is_off_screen_is_not_restored() {
        let saved = geo(100.0, 880.0, 1080.0, 720.0);
        assert_eq!(
            decide(Some(saved), &main_screen()),
            Outcome::SizeOnly(Size {
                width: 1080.0,
                height: 720.0
            })
        );
    }

    /// 细长的一条露在屏幕边上也不够 —— 拖拽区要够宽才抓得住
    #[test]
    fn a_sliver_of_a_window_is_not_enough_to_grab() {
        let saved = geo(1400.0, 100.0, 1080.0, 720.0);
        assert_eq!(
            decide(Some(saved), &main_screen()),
            Outcome::SizeOnly(Size {
                width: 1080.0,
                height: 720.0
            })
        );
    }

    /// 多屏：位置落在副屏上，副屏还在，就该恢复
    #[test]
    fn a_position_on_a_second_live_display_is_restored() {
        let screens = vec![
            screen(0.0, 0.0, 1440.0, 900.0),
            screen(1440.0, 0.0, 1920.0, 1080.0),
        ];
        let saved = geo(1500.0, 60.0, 1080.0, 720.0);
        assert_eq!(decide(Some(saved), &screens), Outcome::Full(saved));
    }

    /// 尺寸比最小尺寸还小：抬到最小尺寸，否则用户拿到一个拽不大也看不清的窗口
    #[test]
    fn a_too_small_size_is_lifted_to_the_minimum() {
        let saved = geo(50.0, 50.0, 200.0, 100.0);
        assert_eq!(
            decide(Some(saved), &main_screen()),
            Outcome::Full(geo(50.0, 50.0, MIN_WIDTH, MIN_HEIGHT))
        );
    }

    /// 尺寸比屏幕还大（在外接 4K 上存的，回到笔记本屏）：夹到屏幕大小。
    /// 不夹的话窗口四周都在屏外，底部与右侧永远够不到。
    #[test]
    fn a_size_larger_than_every_screen_is_capped() {
        let saved = geo(0.0, 0.0, 3000.0, 2000.0);
        assert_eq!(
            decide(Some(saved), &main_screen()),
            Outcome::Full(geo(0.0, 0.0, 1440.0, 900.0))
        );
    }

    /// 手改 config.json 能造出来的坏值，一律整条忽略 ——
    /// 拿去 set_size 会让窗口变成一条线
    #[test]
    fn nonsense_values_are_ignored_entirely() {
        for bad in [
            geo(0.0, 0.0, 0.0, 720.0),
            geo(0.0, 0.0, 1080.0, -5.0),
            geo(f64::NAN, 0.0, 1080.0, 720.0),
            geo(0.0, 0.0, f64::INFINITY, 720.0),
        ] {
            assert_eq!(
                decide(Some(bad), &main_screen()),
                Outcome::Ignore,
                "{bad:?} 不该被拿去设置窗口"
            );
        }
    }

    /// 一块屏都读不到时（极端情况：屏正在重配）不能把位置恢复成「屏外」，
    /// 也不该把尺寸夹成 0 —— 这时只保留尺寸的上下限。
    #[test]
    fn with_no_screens_known_the_size_keeps_the_configured_bounds() {
        let saved = geo(10.0, 10.0, 1080.0, 720.0);
        assert_eq!(
            decide(Some(saved), &[]),
            Outcome::SizeOnly(Size {
                width: 1080.0,
                height: 720.0
            })
        );
    }

    /// 坐标原点在左上的屏幕（macOS 主屏）与左上角带负号的副屏
    /// —— 副屏放在主屏左边时 x 是负的，这是合法位置，不该被当成坏值丢掉。
    #[test]
    fn negative_coordinates_are_legal_positions() {
        let screens = vec![
            screen(0.0, 0.0, 1440.0, 900.0),
            screen(-1920.0, 0.0, 1920.0, 1080.0),
        ];
        let saved = geo(-1500.0, 100.0, 1080.0, 720.0);
        assert_eq!(decide(Some(saved), &screens), Outcome::Full(saved));
    }
}
