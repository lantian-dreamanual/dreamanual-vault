//! 自动锁定。
//!
//! 两条来源：
//!   - 无操作计时（默认 5 分钟，可选 1 / 5 / 15 / 30 / 从不）
//!   - 系统锁屏、快速用户切换或睡过一觉（PRD Q5 已定为「要」）
//!
//! 为什么放在 Rust 侧而不是前端的 `setTimeout`：窗口失焦时前端的定时器会被
//! WKWebView 节流，锁定会晚于设定时间，甚至完全不触发（PRD R4）。实测还有更极端的一例 ——
//! 锁屏之后整个页面进程会被 WebKit 挂起，那里连 `setTimeout` 都不再触发
//! （排查记录见 PRD 附录 K5）。Rust 侧的线程不受这套调度影响。
//!
//! **判定与取值分开。** `decide()` 是纯函数，三条来源都能在单测里断言；
//! 只有 `session_away_raw()` 碰系统 API。合在一起写就只能靠手工锁屏来验，
//! 而「锁屏之后应该锁定」恰恰是这段代码的主要目的。
//!
//! 系统事件要听的是「系统锁屏 / 会话切走」，不是 webview 的 `visibilitychange` ——
//! 后者在窗口被别的应用盖住时也会触发，而那时用户就在屏幕前面。

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

/// 后台线程的检查节奏。锁定判定的粒度就是它 —— 1 秒足够，
/// 而「睡过一觉」的判据正是「两次 tick 之间的间隔远大于这个值」。
const TICK: Duration = Duration::from_secs(1);

/// 两次 tick 的间隔超过基准的多少倍，就算机器睡过。
///
/// 取 30 是刻意放宽的：这条判据想抓的是**休眠**（间隔是分钟量级），
/// 而系统在窗口不可见时会给进程降频、把定时器往后挪，几秒的抖动是正常的。
/// 阈值卡在 5 秒上会把这种抖动误判成「睡过」——用户只是切走了一会儿，
/// 回来发现保险箱锁了。宁可漏掉「只睡了十几秒」这种少见情形，
/// 因为锁屏与无操作那两条会兜住它。
const SLEEP_GAP_FACTOR: u32 = 30;

/// 已经报过锁定之后，每隔多久重发一次。
///
/// 只发一次的风险：前端进程当时正被挂起（锁屏就是这样），事件收不到，
/// 而「已经报过」的标记已置位，于是再也锁不上。前端对这条事件是幂等的 ——
/// 已经关掉的会话再关一次什么也不做。
const REPEAT: Duration = Duration::from_secs(5);

/// 无操作阈值走环境变量覆盖，给自动化验收用。
///
/// 设置的合法取值最小是 1 分钟，验收等不起；而把合法取值本身改小会让界面上的档位失真。
/// 覆盖只发生在这一层，与 `VAULT_DEV_PASSWORD` 的做法一致。
const DEV_IDLE_SECONDS: &str = "VAULT_AUTOLOCK_SECONDS";

/// 发给前端的事件名。前端收到即关掉会话（`store.close()`），回到解锁页。
pub const LOCK_EVENT: &str = "vault://lock";

/// 为什么锁的。前端拿它拼提示语，验收拿它断来源。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockReason {
    /// 无操作达到设定时长
    Idle,
    /// 两次 tick 之间的间隔远超基准 —— 机器睡过
    Slept,
    /// 系统已锁屏，或当前会话已不在前台控制台上（快速用户切换）
    Session,
}

impl LockReason {
    pub fn as_str(self) -> &'static str {
        match self {
            LockReason::Idle => "idle",
            LockReason::Slept => "slept",
            LockReason::Session => "session",
        }
    }

    /// 给界面用的一句话
    pub fn label(self) -> &'static str {
        match self {
            LockReason::Idle => "长时间未操作，已锁定",
            LockReason::Slept => "电脑休眠过，已锁定",
            LockReason::Session => "系统已锁屏，保险箱随之锁定",
        }
    }
}

// ------------------------------------------------------------------ 判定

/// 一次 tick 能拿到的全部信号。
///
/// 用结构体而不是六个位置参数：调用点写得清楚，单测里也只需要填关心的那几项。
#[derive(Debug, Clone, Copy)]
pub struct Signals {
    /// 无操作阈值。`None` = 不按无操作锁定（设置里的「从不」）
    pub idle_limit: Option<Duration>,
    /// 距上一次前端上报的活动
    pub since_activity: Duration,
    /// 距上一次 tick
    pub since_tick: Duration,
    pub tick_interval: Duration,
    /// 系统层面已经离开：锁屏，或会话不在前台控制台上
    pub session_away: bool,
    /// 设置里的「锁屏与休眠时锁定」
    pub lock_on_sleep: bool,
}

/// 该不该锁定、以及为什么。
///
/// 顺序是有意的：睡过与锁屏排在无操作前面 —— 前两者说明用户已经离开这台机器，
/// 而「没碰键盘鼠标」还可能只是在看别的东西。
pub fn decide(s: &Signals) -> Option<LockReason> {
    if s.lock_on_sleep {
        if s.since_tick > s.tick_interval * SLEEP_GAP_FACTOR {
            return Some(LockReason::Slept);
        }
        if s.session_away {
            return Some(LockReason::Session);
        }
    }

    match s.idle_limit {
        Some(limit) if s.since_activity >= limit => Some(LockReason::Idle),
        _ => None,
    }
}

/// 分钟数换算成阈值。`0` = 从不。
///
/// 纯函数，不读环境变量 —— 覆盖发生在 `AutoLock` 那一层（见 `dev_idle_override`），
/// 这样这条换算本身在单测里就是确定的，不受跑测试时环境的影响。
pub fn idle_limit(minutes: u32) -> Option<Duration> {
    match minutes {
        0 => None,
        n => Some(Duration::from_secs(u64::from(n) * 60)),
    }
}

/// 开发档位：把阈值压到秒级，给自动化验收用。
///
/// 设置的合法取值最小是 1 分钟，验收等不起；而把合法取值本身改小会让界面上的档位失真。
/// 覆盖只影响换算这一步，与 `VAULT_DEV_PASSWORD` 的做法一致。
/// 返回 `Some(None)` 表示「覆盖成从不」，`Some(Some(n))` 表示覆盖成 n 秒，`None` 表示不覆盖。
fn dev_idle_override() -> Option<Option<u64>> {
    let raw = std::env::var(DEV_IDLE_SECONDS).ok()?;
    match raw.trim().parse::<u64>() {
        Ok(0) => Some(None),
        Ok(n) => Some(Some(n)),
        Err(_) => None,
    }
}

// ------------------------------------------------------------------ 取信号

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGSessionCopyCurrentDictionary() -> core_foundation::base::CFTypeRef;
}

/// 当前会话是不是「已经离开了」。
///
/// 读 `CGSessionCopyCurrentDictionary` 的两个键：
///   - `CGSSessionScreenIsLocked` 为真 → 已锁屏
///   - `kCGSSessionOnConsoleKey` 为假 → 当前会话不在前台控制台上（快速用户切换）
///
/// 返回 `None` 表示这次没读到（返回值是空指针，或键的取值不是布尔）。
/// **读不到时按「没离开」处理** —— 宁可少锁一次，也不要因为读不到值
/// 就把用户反复踢回解锁页。
///
/// 取的是一个 CFDictionary，调用方持有它（create 规则），
/// `wrap_under_create_rule` 负责在这次查询结束时释放。
fn session_away_raw() -> Option<bool> {
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::boolean::{CFBoolean, CFBooleanRef};
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::string::CFString;

    fn bool_at(dict: &CFDictionary<CFString, CFType>, key: &str) -> Option<bool> {
        let item = dict.find(&CFString::new(key))?;
        let value: &CFType = &item;
        // 字典的泛型参数只是标记，不做运行时检查；取值不是布尔就直接放弃这一条。
        if !value.instance_of::<CFBoolean>() {
            return None;
        }
        let raw: CFBooleanRef = value.as_concrete_TypeRef() as CFBooleanRef;
        Some(bool::from(unsafe { CFBoolean::wrap_under_get_rule(raw) }))
    }

    unsafe {
        let raw = CGSessionCopyCurrentDictionary();
        if raw.is_null() {
            return None;
        }
        let dict: CFDictionary<CFString, CFType> =
            CFDictionary::wrap_under_create_rule(raw as CFDictionaryRef);

        let locked = bool_at(&dict, "CGSSessionScreenIsLocked");
        let on_console = bool_at(&dict, "kCGSSessionOnConsoleKey");
        if locked.is_none() && on_console.is_none() {
            return None;
        }
        Some(locked.unwrap_or(false) || !on_console.unwrap_or(true))
    }
}

fn session_away() -> bool {
    session_away_raw().unwrap_or(false)
}

// ------------------------------------------------------------------ 状态

struct Inner {
    /// 库开着才计时。解锁页上没什么可锁的。
    armed: bool,
    idle_minutes: u32,
    lock_on_sleep: bool,
    /// 开发档位（秒）。`Some(None)` = 覆盖成从不。见 `dev_idle_override`。
    idle_override: Option<Option<u64>>,
    last_activity: Instant,
    last_tick: Instant,
    /// 已经发出的那一次（原因 + 发出时刻），`disarm` 时清掉
    fired: Option<(LockReason, Instant)>,
}

impl Inner {
    fn idle_limit(&self) -> Option<Duration> {
        match self.idle_override {
            Some(Some(secs)) => Some(Duration::from_secs(secs)),
            Some(None) => None,
            None => idle_limit(self.idle_minutes),
        }
    }
}

/// 自动锁定的状态。放在 Tauri 的 `manage` 里，命令与后台线程共用。
pub struct AutoLock {
    inner: Mutex<Inner>,
}

impl Default for AutoLock {
    fn default() -> Self {
        Self::new()
    }
}

impl AutoLock {
    /// 读取一次开发档位。单测走 `with_override`，不受跑测试时的环境影响。
    pub fn new() -> Self {
        Self::with_override(dev_idle_override())
    }

    fn with_override(idle_override: Option<Option<u64>>) -> Self {
        let now = Instant::now();
        Self {
            inner: Mutex::new(Inner {
                armed: false,
                idle_minutes: 5,
                lock_on_sleep: true,
                idle_override,
                last_activity: now,
                last_tick: now,
                fired: None,
            }),
        }
    }

    /// 库打开之后开始计时。`minutes` 与 `lock_on_sleep` 来自当次配置。
    pub fn arm(&self, minutes: u32, lock_on_sleep: bool) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        inner.armed = true;
        inner.idle_minutes = minutes;
        inner.lock_on_sleep = lock_on_sleep;
        inner.last_activity = now;
        inner.last_tick = now;
        inner.fired = None;
    }

    /// 库关掉（锁定、或者用户主动锁定）之后停表。
    pub fn disarm(&self) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.armed = false;
        inner.fired = None;
    }

    /// 设置页改了配置。库没开着也照样记下来，下次 `arm` 用得上。
    pub fn configure(&self, minutes: u32, lock_on_sleep: bool) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let was = inner.idle_limit();
        inner.idle_minutes = minutes;
        inner.lock_on_sleep = lock_on_sleep;
        // 阈值被放宽（例如从 1 分钟改成 30 分钟）时，把「刚还被判超时」的状态收回，
        // 否则用户改完设置回到界面，下一轮 tick 仍然按旧阈值把他锁掉。
        let now = inner.idle_limit();
        if matches!((was, now), (Some(a), Some(b)) if b > a) {
            inner.last_activity = Instant::now();
        }
    }

    /// 前端上报「用户还在操作」。
    pub fn touch(&self) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.last_activity = Instant::now();
    }

    /// 一轮检查。返回 `Some` 表示「现在该发一次锁定事件」。
    ///
    /// 已发出的那一次不会每轮都报，但每隔 `REPEAT` 重报一次 ——
    /// 理由见 `REPEAT` 的注释。
    pub fn tick(&self, now: Instant, session_away: bool) -> Option<LockReason> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let since_tick = now.saturating_duration_since(inner.last_tick);
        inner.last_tick = now;

        if !inner.armed {
            // 没开库时也把活动时间往前推，免得下次 arm 时带着一个很旧的时间戳
            return None;
        }

        if let Some((reason, at)) = inner.fired {
            if now.saturating_duration_since(at) >= REPEAT {
                inner.fired = Some((reason, now));
                return Some(reason);
            }
            return None;
        }

        let signals = Signals {
            idle_limit: inner.idle_limit(),
            since_activity: now.saturating_duration_since(inner.last_activity),
            since_tick,
            tick_interval: TICK,
            session_away,
            lock_on_sleep: inner.lock_on_sleep,
        };

        match decide(&signals) {
            Some(reason) => {
                inner.fired = Some((reason, now));
                Some(reason)
            }
            None => None,
        }
    }

    /// 给界面与验收看的快照。
    pub fn status(&self) -> Status {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let limit = inner.idle_limit();
        Status {
            armed: inner.armed,
            idle_minutes: inner.idle_minutes,
            lock_on_sleep: inner.lock_on_sleep,
            idle_seconds: limit.map(|d| d.as_secs()).unwrap_or(0),
            since_activity_ms: inner.last_activity.elapsed().as_millis() as u64,
            fired: inner.fired.map(|(r, _)| r.as_str().to_string()),
            session_away: session_away_raw(),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub armed: bool,
    pub idle_minutes: u32,
    pub lock_on_sleep: bool,
    /// 无操作阈值（秒）。0 = 从不。开发期被环境变量覆盖时，这里读到的是覆盖后的值。
    pub idle_seconds: u64,
    pub since_activity_ms: u64,
    /// 已发出的锁定原因，没有则为 null
    pub fired: Option<String>,
    /// 系统层面是否已离开。`null` = 这次没读到（取不到值时按「没离开」处理）
    pub session_away: Option<bool>,
}

// ------------------------------------------------------------------ IPC

#[tauri::command]
pub fn lock_activity(state: tauri::State<'_, AutoLock>) -> Status {
    state.touch();
    state.status()
}

#[tauri::command]
pub fn lock_arm(
    minutes: u32,
    lock_on_sleep: bool,
    state: tauri::State<'_, AutoLock>,
) -> Status {
    state.arm(minutes, lock_on_sleep);
    state.status()
}

#[tauri::command]
pub fn lock_disarm(state: tauri::State<'_, AutoLock>) -> Status {
    state.disarm();
    state.status()
}

#[tauri::command]
pub fn lock_configure(
    minutes: u32,
    lock_on_sleep: bool,
    state: tauri::State<'_, AutoLock>,
) -> Status {
    state.configure(minutes, lock_on_sleep);
    state.status()
}

#[tauri::command]
pub fn lock_status(state: tauri::State<'_, AutoLock>) -> Status {
    state.status()
}

/// 锁定原因对应的一句话，给界面直接用。前端不必自己维护一份对照表。
#[tauri::command]
pub fn lock_label(reason: String) -> String {
    match reason.as_str() {
        "idle" => LockReason::Idle.label().to_string(),
        "slept" => LockReason::Slept.label().to_string(),
        "session" => LockReason::Session.label().to_string(),
        _ => "已锁定".to_string(),
    }
}

// ------------------------------------------------------------------ 后台线程

/// 起一个每秒醒一次的线程。
///
/// 它同时也是「机器睡过一觉」的探测器：线程跟着机器一起停摆，醒来后
/// 第一轮 tick 就能从间隔里看出这个缺口，不需要注册任何系统通知。
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(TICK);
        let away = session_away();
        let hit = {
            let state = app.state::<AutoLock>();
            state.tick(Instant::now(), away)
        };
        if let Some(reason) = hit {
            let _ = app.emit(LOCK_EVENT, reason.as_str());
        }
    });
}

// ------------------------------------------------------------------ 单测

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Signals {
        Signals {
            idle_limit: Some(Duration::from_secs(300)),
            since_activity: Duration::from_secs(0),
            since_tick: TICK,
            tick_interval: TICK,
            session_away: false,
            lock_on_sleep: true,
        }
    }

    #[test]
    fn idle_under_the_limit_is_not_a_lock() {
        let s = Signals {
            since_activity: Duration::from_secs(299),
            ..base()
        };
        assert_eq!(decide(&s), None);
    }

    #[test]
    fn idle_at_the_limit_locks() {
        let s = Signals {
            since_activity: Duration::from_secs(300),
            ..base()
        };
        assert_eq!(decide(&s), Some(LockReason::Idle));
    }

    #[test]
    fn never_idle_means_only_system_signals() {
        let s = Signals {
            idle_limit: None,
            since_activity: Duration::from_secs(86_400),
            ..base()
        };
        assert_eq!(decide(&s), None);
    }

    #[test]
    fn a_sleep_gap_locks_even_with_idle_turned_off() {
        // 「从不按无操作锁定」不等于「永不锁定」——
        // PRD Q5 要的是休眠与锁屏都要锁，这是一条独立的开关。
        let s = Signals {
            idle_limit: None,
            since_activity: Duration::from_secs(0),
            since_tick: TICK * (SLEEP_GAP_FACTOR + 1),
            ..base()
        };
        assert_eq!(decide(&s), Some(LockReason::Slept));
    }

    #[test]
    fn a_sleep_gap_is_not_guessed_from_a_lagging_timer() {
        // 定时器抖动不该被当成睡过一觉
        let s = Signals {
            since_tick: TICK * SLEEP_GAP_FACTOR,
            ..base()
        };
        assert_eq!(decide(&s), None);
    }

    #[test]
    fn a_locked_session_locks_at_once() {
        let s = Signals {
            since_activity: Duration::from_secs(0),
            session_away: true,
            ..base()
        };
        assert_eq!(decide(&s), Some(LockReason::Session));
    }

    #[test]
    fn sleep_and_session_are_ignored_when_the_switch_is_off() {
        let off = Signals {
            lock_on_sleep: false,
            session_away: true,
            since_tick: TICK * 60,
            ..base()
        };
        assert_eq!(decide(&off), None);

        // 关掉系统信号之后，无操作计时照常工作
        let still_idle = Signals {
            since_activity: Duration::from_secs(300),
            ..off
        };
        assert_eq!(decide(&still_idle), Some(LockReason::Idle));
    }

    #[test]
    fn sleeping_outranks_idling() {
        let s = Signals {
            since_activity: Duration::from_secs(86_400),
            since_tick: TICK * 60,
            ..base()
        };
        assert_eq!(decide(&s), Some(LockReason::Slept));
    }

    #[test]
    fn zero_minutes_means_never() {
        assert_eq!(idle_limit(0), None);
        assert_eq!(idle_limit(1), Some(Duration::from_secs(60)));
        assert_eq!(idle_limit(30), Some(Duration::from_secs(1800)));
    }

    #[test]
    fn an_unarmed_lock_stays_quiet() {
        let lock = quiet();
        let now = Instant::now();
        assert_eq!(lock.tick(now + Duration::from_secs(3600), false), None);
        assert!(!lock.status().armed);
    }

    #[test]
    fn arming_starts_the_clock_and_disarming_stops_it() {
        let lock = quiet();
        let now = Instant::now();
        arm_at(&lock, 5, true, now);

        assert_eq!(run_ticks(&lock, now, 299, false), None);
        assert_eq!(lock.tick(now + TICK * 300, false), Some(LockReason::Idle));

        lock.disarm();
        assert_eq!(run_ticks(&lock, now + TICK * 300, 600, false), None);
    }

    #[test]
    fn activity_pushes_the_deadline_back() {
        let lock = quiet();
        let now = Instant::now();
        arm_at(&lock, 5, true, now);

        assert_eq!(run_ticks(&lock, now, 299, false), None);

        // 第 299 秒用户动了一下，倒计时重来
        touch_at(&lock, now + TICK * 299);
        assert_eq!(
            run_ticks(&lock, now + TICK * 299, 300, false),
            Some(LockReason::Idle)
        );
    }

    #[test]
    fn a_fired_lock_repeats_on_a_slow_beat() {
        // 只发一次是不够的：前端那时可能正被挂起。重发要能自愈，
        // 但也不能每轮都发 —— 否则事件通道一直有流量。
        let lock = quiet();
        let now = Instant::now();
        arm_at(&lock, 5, true, now);

        assert_eq!(run_ticks(&lock, now, 300, false), Some(LockReason::Idle));

        // 随后的四秒里不重复
        assert_eq!(run_ticks(&lock, now + TICK * 300, 4, false), None);
        // 距首次 5 秒时重发一次
        assert_eq!(
            lock.tick(now + TICK * 300 + REPEAT, false),
            Some(LockReason::Idle)
        );
    }

    #[test]
    fn rearming_clears_the_fired_marker() {
        let lock = quiet();
        let now = Instant::now();
        arm_at(&lock, 5, true, now);
        assert_eq!(run_ticks(&lock, now, 300, false), Some(LockReason::Idle));

        // 用户重新解锁：计时重新开始，上一次的标记要清掉
        arm_at(&lock, 5, true, now + TICK * 300);
        assert_eq!(lock.status().fired, None);
        assert_eq!(lock.tick(now + TICK * 301, false), None);
    }

    #[test]
    fn a_long_gap_between_ticks_means_the_machine_slept() {
        // 走完整的 AutoLock 而不只是 decide：确认「睡过一觉」这条
        // 在无操作计时关掉时仍然成立。
        let lock = quiet();
        let now = Instant::now();
        arm_at(&lock, 0, true, now);

        assert_eq!(run_ticks(&lock, now, 60, false), None);
        // 线程一整小时没醒
        assert_eq!(lock.tick(now + TICK * 3600, false), Some(LockReason::Slept));
    }

    #[test]
    fn widening_the_window_does_not_leave_a_stale_deadline() {
        // 从 1 分钟放宽到 30 分钟，用户改完设置回到界面不该立刻被锁掉
        let lock = quiet();
        let now = Instant::now();
        arm_at(&lock, 1, true, now);

        assert_eq!(run_ticks(&lock, now, 30, false), None);
        lock.configure(30, true);
        assert_eq!(run_ticks(&lock, now + TICK * 30, 600, false), None);
    }

    #[test]
    fn narrowing_the_window_takes_effect_right_away() {
        // 反向：从 30 分钟收紧到 1 分钟，已经闲置超过 1 分钟 —— 该锁就锁
        let lock = quiet();
        let now = Instant::now();
        arm_at(&lock, 30, true, now);

        assert_eq!(run_ticks(&lock, now, 90, false), None);
        lock.configure(1, true);
        assert_eq!(lock.tick(now + TICK * 91, false), Some(LockReason::Idle));
    }

    #[test]
    fn the_status_snapshot_reports_what_it_should() {
        let lock = quiet();
        lock.arm(15, false);
        let s = lock.status();
        assert!(s.armed);
        assert_eq!(s.idle_minutes, 15);
        assert!(!s.lock_on_sleep);
        assert_eq!(s.idle_seconds, 900);
        assert_eq!(s.fired, None);
    }

    #[test]
    fn reading_the_session_never_panics() {
        // 这条只保证取值这一段不会崩。返回值随机器状态而变：
        // 跑验收时屏幕是解锁的，能读到 `Some(false)`；取不到时是 `None`。
        let _ = session_away_raw();
    }

    /// 不读开发档位的实例。单测必须走这个而不是 `new()` ——
    /// 验收脚本会设 `VAULT_AUTOLOCK_SECONDS`，那时 `new()` 拿到的阈值是秒级，
    /// 这些按分钟推演的断言会莫名其妙地红。
    fn quiet() -> AutoLock {
        AutoLock::with_override(None)
    }

    /// 按后台线程的真实节奏走：每 `TICK` 醒一次，中途命中就停下。
    ///
    /// 不写成「把时间一次跳 300 秒」——那样 `since_tick` 会跟着跳，
    /// 于是先撞上「睡过一觉」那条判据，测不到无操作计时本身。
    fn run_ticks(lock: &AutoLock, from: Instant, secs: u32, away: bool) -> Option<LockReason> {
        let mut last = None;
        for i in 1..=secs {
            last = lock.tick(from + TICK * i, away);
            if last.is_some() {
                return last;
            }
        }
        last
    }

    /// `Instant` 不能被直接构造，所以测试里的时间点都从 `Instant::now()` 起算，
    /// 需要把起点对齐到某个时刻时直接改内部状态。同模块能碰私有字段。
    ///
    /// `arm` 内部取的是它自己的 `Instant::now()`，比测试手里的 `now` 晚几微秒 ——
    /// 差值虽小，卡在阈值上的断言会因此翻面（299.999 秒不算超时）。
    fn arm_at(lock: &AutoLock, minutes: u32, lock_on_sleep: bool, at: Instant) {
        lock.arm(minutes, lock_on_sleep);
        let mut inner = lock.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.last_activity = at;
        inner.last_tick = at;
    }

    fn touch_at(lock: &AutoLock, at: Instant) {
        let mut inner = lock.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.last_activity = at;
    }
}
