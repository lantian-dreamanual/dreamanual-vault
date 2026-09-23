//! 剪贴板定时清除。
//!
//! 为什么放在 Rust 侧：同 `lock.rs` 的理由 —— 前端的定时器在窗口失焦时会被
//! WKWebView 节流，而「复制密码后 30 秒清空剪贴板」这件事恰恰最可能发生在用户
//! 切到别的应用之后；锁屏时整个页面进程还会被挂起（排查记录见 PRD 附录 K5）。
//! Rust 侧的线程不受这套调度影响。
//!
//! **只清自己写进去的那一份。** 这是这个模块最容易写错的地方：用户在别处复制了
//! 新内容之后，剪贴板里已经是我们那份密码的「替代品」—— 这时再去 `clearContents`
//! 就是删掉用户刚复制的东西。判定靠 `NSPasteboard.changeCount`：任何一次写入
//! （别人复制的、我们自己清的）都会让它 +1，所以「当前计数还等于 `arm` 时读到的
//! 那次」就等价于「剪贴板里还是我们写的那一份」。
//!
//! **只读计数，不读内容。** `stringForType` 一类读内容的方法会触发 macOS 的剪贴板
//! 访问提示（「xxx 想访问其他 App 粘贴的内容」），而 `changeCount` 不会。
//!
//! 判定与取值分开：`decide()` 是纯函数，只有 `change_count()` 与
//! `clear_pasteboard()` 碰系统 API。

use std::sync::Mutex;
use std::time::{Duration, Instant};

use objc2::rc::autoreleasepool;
use objc2_app_kit::NSPasteboard;
use tauri::{AppHandle, Manager};

/// 后台线程的检查节奏。清除的粒度就是它 —— 1 秒足够，
/// 设置里最小的一档是 15 秒。
const TICK: Duration = Duration::from_secs(1);

// ------------------------------------------------------------------ 判定

/// 秒数换算成清除延迟。`0` = 从不自动清除。
///
/// 纯函数，单测直接断言 —— 与 `lock::idle_limit` 同一条约定。
pub fn clear_limit(seconds: u32) -> Option<Duration> {
    match seconds {
        0 => None,
        n => Some(Duration::from_secs(u64::from(n))),
    }
}

/// 一次 tick 该做什么。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// 什么都不做：没在计时、还没到点，或者这次读不到计数
    Wait,
    /// 到点了：把剪贴板清掉
    Clear,
    /// 剪贴板已经被改写 —— 停表，并且**绝不去动它**
    Superseded,
}

/// 一次 tick 能拿到的全部信号。
#[derive(Debug, Clone, Copy)]
pub struct Signals {
    /// 已经 `arm` 过（复制过密码）且在计时
    pub armed: bool,
    /// 清除延迟。`None` = 从不
    pub limit: Option<Duration>,
    /// 距上一次复制的时长
    pub elapsed: Duration,
    /// 剪贴板计数是否仍等于复制时读到的那次。`None` = 这次没读到
    pub unchanged: Option<bool>,
}

/// 该不该清。
///
/// 「内容已被替换」排在「到点」前面是有意的：用户在别处复制了新东西之后，
/// 剪贴板里的密码早就不在了，这时唯一正确的动作是停表走开 ——
/// 按时间判的话我们会把用户刚复制的内容删掉。
pub fn decide(s: &Signals) -> Action {
    if !s.armed {
        return Action::Wait;
    }
    match s.unchanged {
        Some(true) => {}
        // 读不到计数时不下判断：宁可少清一次，也不要清错
        None => return Action::Wait,
        Some(false) => return Action::Superseded,
    }
    match s.limit {
        Some(limit) if s.elapsed >= limit => Action::Clear,
        _ => Action::Wait,
    }
}

/// 退出收尾该不该动剪贴板：`arm` 过、且计数仍是我们那次。
///
/// 与 `decide` 里那条「Superseded」是同一条判据的正面表述，单独抽出来是为了能在
/// 单测里断言 —— `flush` 本身会碰真实剪贴板，不该在单测里走到那一步。
pub fn should_flush(armed: bool, unchanged: Option<bool>) -> bool {
    armed && unchanged == Some(true)
}

// ------------------------------------------------------------------ 取剪贴板

/// 剪贴板的写入计数。
///
/// 每一次写入都会让它 +1，包括我们自己的 `clearContents`。读它不需要任何权限，
/// 也不会触发 macOS 的剪贴板访问提示 —— 这正是选它做判据的原因。
///
/// 返回 `None` 只会在取不到剪贴板时发生。
///
/// `generalPasteboard` 返回的是一个 autoreleased 对象，所以整段要包在自动释放池里 ——
/// 后台线程里没有别人给建池，不包的话每次调用都会漏一点。
fn change_count() -> Option<isize> {
    autoreleasepool(|_| Some(NSPasteboard::generalPasteboard().changeCount()))
}

/// 清空剪贴板。
///
/// 用 `clearContents` 而不是写入空字符串：前者让剪贴板里**什么都没有**，
/// 后者会留下一个空的文本项，粘贴时拿到一个空串 ——「粘出来是空的」和
/// 「粘不出东西」在用户看来不是一回事。
fn clear_pasteboard() {
    autoreleasepool(|_| {
        let pb = NSPasteboard::generalPasteboard();
        pb.clearContents();
    });
}

// ------------------------------------------------------------------ 状态

struct Inner {
    armed: bool,
    seconds: u32,
    /// `arm` 时读到的 changeCount
    baseline: isize,
    /// `arm` 的时刻，也就是用户按下「复制」的时刻
    started: Instant,
    /// 已经清过的那一次（`arm` 与 `disarm` 都清掉它）
    cleared: bool,
}

/// 剪贴板清除的状态。放在 Tauri 的 `manage` 里，命令与后台线程共用。
pub struct Clipboard {
    inner: Mutex<Inner>,
}

impl Default for Clipboard {
    fn default() -> Self {
        Self::new()
    }
}

impl Clipboard {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                armed: false,
                // 与 `config::AppConfig::default().clipboard_clear_seconds` 一致。
                // 实际每次复制都会把当时的档位传进来，这个值只在极端情形下用得上。
                seconds: 30,
                baseline: 0,
                started: Instant::now(),
                cleared: false,
            }),
        }
    }

    /// 复制之后开始计时。
    ///
    /// 读一次当前计数作为基准 —— 这一次读到的就是「我们刚写进去的那一份」。
    /// **读不到时不计时**：没有基准就没法判断剪贴板有没有被替换，而误清比不清更糟
    /// （会删掉用户刚复制的东西）。
    ///
    /// 档位不从这里传：它由 `configure` 维护（启动时同步一次、设置页改动时再同步）。
    /// 让前端在每次复制时读一遍配置的话，读到的可能是过期的那份 —— 用户刚把 30 秒
    /// 改成 15 秒，这次复制却按 30 秒计时，界面上看不出任何异样。
    pub fn arm(&self) -> Status {
        {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner.cleared = false;
            match change_count() {
                Some(count) => {
                    inner.armed = true;
                    inner.baseline = count;
                    inner.started = Instant::now();
                }
                None => inner.armed = false,
            }
        }
        self.status()
    }

    /// 停表，不再清除。
    pub fn disarm(&self) -> Status {
        {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner.armed = false;
            inner.cleared = false;
        }
        self.status()
    }

    /// 设置页改了「剪贴板清除」档位。
    ///
    /// 只换档位、**不重置起点**：起点是「用户上次复制的时刻」，改完档位之后已经过掉的
    /// 时间照样要算进去。从 60 秒缩到 15 秒、而复制已经过去 20 秒时，就该立刻清掉，
    /// 否则用户以为改完马上生效，实际还要再等一轮旧档位。
    pub fn configure(&self, seconds: u32) -> Status {
        {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner.seconds = seconds;
        }
        self.status()
    }

    /// 一轮检查。返回要执行的动作；`Clear` 的副作用由调用方去做。
    pub fn tick(&self, now: Instant, current: Option<isize>) -> Action {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let signals = Signals {
            armed: inner.armed,
            limit: clear_limit(inner.seconds),
            elapsed: now.saturating_duration_since(inner.started),
            unchanged: current.map(|count| count == inner.baseline),
        };

        match decide(&signals) {
            Action::Clear => {
                inner.armed = false;
                inner.cleared = true;
                Action::Clear
            }
            Action::Superseded => {
                inner.armed = false;
                Action::Superseded
            }
            Action::Wait => Action::Wait,
        }
    }

/// 立即收尾：剪贴板里若还是我们写的那一份，清掉；顺带停表。
///
/// 两个调用点，对应 PRD §4.4 的「锁定 / 退出时立即清除」：
///   - 会话关掉（锁定、换库）—— 前端收到会话状态变化时调 `clipboard_clear_now`
///   - 应用退出 —— `RunEvent::Exit` 里调它。进程一退计时线程就跟着没了，
///     用户复制密码之后直接关掉应用的话，那份密码会一直留在剪贴板里
///
/// 不做无条件清空：用户在别处复制的东西、以及我们没动过的剪贴板，
/// 都不该因为「这个应用退出」而被清掉。
    pub fn flush(&self) {
        let (armed, baseline) = {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let armed = inner.armed;
            let baseline = inner.baseline;
            inner.armed = false;
            inner.cleared = false;
            (armed, baseline)
        };

        if !armed {
            return;
        }
        let unchanged = change_count().map(|count| count == baseline);
        if should_flush(armed, unchanged) {
            clear_pasteboard();
        }
    }

    /// 给界面与验收看的快照。
    pub fn status(&self) -> Status {
        // 取计数要碰系统 API，放在锁外面
        let current = change_count();
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());

        Status {
            armed: inner.armed,
            seconds: inner.seconds,
            elapsed_ms: inner.started.elapsed().as_millis() as u64,
            fired: inner.cleared,
            baseline: inner.baseline as i64,
            change_count: current.map(|c| c as i64),
            unchanged: current.map(|c| c == inner.baseline).unwrap_or(false),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// 正在计时。复制之后为真，清完/被替换/停表之后为假
    pub armed: bool,
    /// 当前档位（秒）。0 = 从不
    pub seconds: u32,
    /// 距上一次复制的时长
    pub elapsed_ms: u64,
    /// 这一次复制之后已经清过了
    pub fired: bool,
    /// `arm` 时读到的计数
    pub baseline: i64,
    /// 现在的计数。`null` = 这次没读到
    pub change_count: Option<i64>,
    /// 现在的计数是否仍等于 `baseline`，即「剪贴板里还是我们写的那一份」
    pub unchanged: bool,
}

// ------------------------------------------------------------------ IPC

#[tauri::command]
pub fn clipboard_arm(state: tauri::State<'_, Clipboard>) -> Status {
    state.arm()
}

#[tauri::command]
pub fn clipboard_disarm(state: tauri::State<'_, Clipboard>) -> Status {
    state.disarm()
}

#[tauri::command]
pub fn clipboard_configure(seconds: u32, state: tauri::State<'_, Clipboard>) -> Status {
    state.configure(seconds)
}

#[tauri::command]
pub fn clipboard_clear_now(state: tauri::State<'_, Clipboard>) -> Status {
    state.flush();
    state.status()
}

#[tauri::command]
pub fn clipboard_status(state: tauri::State<'_, Clipboard>) -> Status {
    state.status()
}

// ------------------------------------------------------------------ 后台线程

/// 起一个每秒醒一次的线程。
///
/// 清除是本地同步操作，不需要像锁定那样重发 —— 线程若在到点时正好被系统挂起，
/// 醒来后第一轮 tick 会从 `elapsed` 里看出早已过期，照样清掉。
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(TICK);
        let current = change_count();
        let action = {
            let state = app.state::<Clipboard>();
            state.tick(Instant::now(), current)
        };
        if matches!(action, Action::Clear) {
            clear_pasteboard();
        }
    });
}

// ------------------------------------------------------------------ 单测

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Signals {
        Signals {
            armed: true,
            limit: Some(Duration::from_secs(30)),
            elapsed: Duration::ZERO,
            unchanged: Some(true),
        }
    }

    #[test]
    fn an_idle_clipboard_is_left_alone() {
        let s = Signals {
            armed: false,
            elapsed: Duration::from_secs(86_400),
            ..base()
        };
        assert_eq!(decide(&s), Action::Wait);
    }

    #[test]
    fn nothing_happens_before_the_deadline() {
        let s = Signals {
            elapsed: Duration::from_secs(29),
            ..base()
        };
        assert_eq!(decide(&s), Action::Wait);
    }

    #[test]
    fn the_deadline_clears_it() {
        let s = Signals {
            elapsed: Duration::from_secs(30),
            ..base()
        };
        assert_eq!(decide(&s), Action::Clear);
    }

    #[test]
    fn never_means_never() {
        let s = Signals {
            limit: None,
            elapsed: Duration::from_secs(86_400),
            ..base()
        };
        assert_eq!(decide(&s), Action::Wait);
    }

    /// 这是整个模块最容易写错的一条：内容已被替换时，哪怕早就过了时间也不能清 ——
    /// 那时剪贴板里装的是**用户刚复制的东西**。
    #[test]
    fn a_replaced_clipboard_is_never_touched() {
        let s = Signals {
            elapsed: Duration::from_secs(86_400),
            unchanged: Some(false),
            ..base()
        };
        assert_eq!(decide(&s), Action::Superseded);
    }

    #[test]
    fn an_unreadable_count_waits() {
        let s = Signals {
            limit: Some(Duration::from_secs(15)),
            elapsed: Duration::from_secs(600),
            unchanged: None,
            ..base()
        };
        assert_eq!(decide(&s), Action::Wait, "读不到计数时不下判断");
    }

    #[test]
    fn clear_limit_converts() {
        assert_eq!(clear_limit(0), None);
        assert_eq!(clear_limit(15), Some(Duration::from_secs(15)));
        assert_eq!(clear_limit(60), Some(Duration::from_secs(60)));
    }

    #[test]
    fn flushing_only_happens_when_the_clipboard_is_still_ours() {
        assert!(should_flush(true, Some(true)));
        assert!(!should_flush(true, Some(false)), "已被改写：不能动");
        assert!(!should_flush(true, None), "读不到：宁可不动");
        assert!(!should_flush(false, Some(true)), "本来就没在计时");
    }

    // ---------------------------------------------------------- 状态机

    #[test]
    fn arming_starts_the_clock() {
        let c = idle();
        let now = Instant::now();
        arm_at(&c, 30, now);

        assert_eq!(c.tick(now + Duration::from_secs(29), Some(BASE)), Action::Wait);
        assert_eq!(c.tick(now + Duration::from_secs(30), Some(BASE)), Action::Clear);
    }

    #[test]
    fn a_changed_count_stops_the_clock() {
        let c = idle();
        let now = Instant::now();
        arm_at(&c, 30, now);

        // 用户在别处复制了别的东西
        assert_eq!(
            c.tick(now + Duration::from_secs(5), Some(BASE + 1)),
            Action::Superseded
        );
        assert!(!c.status().armed, "停表");
        // 之后再也不清，即使早就过了 30 秒
        assert_eq!(
            c.tick(now + Duration::from_secs(600), Some(BASE + 1)),
            Action::Wait
        );
    }

    #[test]
    fn clearing_marks_fired_and_stops_the_clock() {
        let c = idle();
        let now = Instant::now();
        arm_at(&c, 15, now);

        assert_eq!(c.tick(now + Duration::from_secs(15), Some(BASE)), Action::Clear);
        let s = c.status();
        assert!(s.fired);
        assert!(!s.armed);
        // 不会反复清
        assert_eq!(c.tick(now + Duration::from_secs(16), Some(BASE)), Action::Wait);
    }

    #[test]
    fn copying_again_restarts_the_clock() {
        let c = idle();
        let now = Instant::now();
        arm_at(&c, 15, now);
        assert_eq!(c.tick(now + Duration::from_secs(15), Some(BASE)), Action::Clear);

        // 又复制了一次：计时重来，上一次的「已清」标记要落下去
        arm_at(&c, 15, now + Duration::from_secs(20));
        assert!(!c.status().fired);
        // 新基准是 BASE + 2（arm 之后又写了一次剪贴板）
        assert_eq!(
            c.tick(now + Duration::from_secs(21), Some(BASE + 3)),
            Action::Superseded,
            "换了基准之后，旧计数的缓存不该被当成我们的内容"
        );
    }

    #[test]
    fn shortening_the_window_takes_effect_at_once() {
        let c = idle();
        let now = Instant::now();
        arm_at(&c, 60, now);

        assert_eq!(c.tick(now + Duration::from_secs(20), Some(BASE)), Action::Wait);
        c.configure(15);
        // 复制已经过去 20 秒，比新档位 15 秒长
        assert_eq!(c.tick(now + Duration::from_secs(20), Some(BASE)), Action::Clear);
    }

    #[test]
    fn switching_to_never_stops_clearing() {
        let c = idle();
        let now = Instant::now();
        arm_at(&c, 15, now);
        c.configure(0);
        assert_eq!(
            c.tick(now + Duration::from_secs(86_400), Some(BASE)),
            Action::Wait
        );
    }

    #[test]
    fn disarming_clears_the_fired_marker() {
        let c = idle();
        let now = Instant::now();
        arm_at(&c, 15, now);
        assert_eq!(c.tick(now + Duration::from_secs(15), Some(BASE)), Action::Clear);

        c.disarm();
        assert!(!c.status().fired);
    }

    #[test]
    fn an_unarmed_clipboard_ignores_ticks() {
        let c = idle();
        assert_eq!(
            c.tick(Instant::now() + Duration::from_secs(86_400), Some(BASE)),
            Action::Wait
        );
    }

    #[test]
    fn the_status_snapshot_reports_what_it_should() {
        let c = idle();
        let now = Instant::now();
        arm_at(&c, 45, now);

        let s = c.status();
        assert!(s.armed);
        assert_eq!(s.seconds, 45);
        assert!(!s.fired);
        // 这条顺带证明取值那一段没崩：真实剪贴板的计数是读得到的
        assert!(s.change_count.is_some(), "changeCount 读不到");
    }

    /// 未计时时的收尾不该碰剪贴板 —— 用户没在这个应用里复制过东西，
    /// 退出时把他的剪贴板清掉是说不通的。
    #[test]
    fn flushing_an_idle_clipboard_does_not_wait_or_touch_it() {
        let c = idle();
        c.flush();
        assert!(!c.status().armed);
    }

    const BASE: isize = 42;

    /// 没在计时的实例。
    fn idle() -> Clipboard {
        let c = Clipboard::new();
        c.disarm();
        c
    }

    /// 把起点对齐到测试手里的 `now`，基准固定成 `BASE`。
    ///
    /// `arm` 内部取的是它自己的 `Instant::now()`、基准是那一刻的真实计数 ——
    /// 两者都随机器状态而变，按时间推演的断言没法写。同模块能碰私有字段。
    fn arm_at(c: &Clipboard, seconds: u32, at: Instant) {
        c.configure(seconds);
        c.arm();
        let mut inner = c.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.armed = true;
        inner.baseline = BASE;
        inner.started = at;
        inner.cleared = false;
    }
}
