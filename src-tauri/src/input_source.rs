//! 输入源：密码框拿到焦点时把输入法切到 ASCII 布局，离开还原。
//!
//! 前端（WebView）拿不到 TIS（Text Input Source Services，属于 HIToolbox），
//! 所以由这一层代劳。口径与 NAS 助手 `Core/InputSource.swift` 保持一致：
//!   - 进字段切成 ASCII 键盘，离开字段还原成用户原来那个
//!   - 已经是 ASCII 时什么都不做（否则会把「还原目标」记成 ASCII，中文输入法就真丢了）
//!   - 嵌套进入（主密码 → 复核密码）只记最外层那一次
//!   - 不替用户改系统里的输入源顺序与默认输入法
//!
//! 为什么必须做：中文输入法下打 `!` 得到全角「！」（U+FF01），长度一样、内容
//! 差一位，主密码校验只会回「密码不对」，用户无从看出差别（NAS 登录 2026-10-17
//! 真机踩过，卡了两轮）。
//!
//! TIS 的符号都在 Carbon.framework 里（HIToolbox），四个函数 + 一个常量即可；
//! 指针按 CF 的 create/get 规则管理：`TISCopy*` 返回的由我们持有、用完 CFRelease，
//! `TISGetInputSourceProperty` 返回的是借用的，不释放。

use std::ffi::{c_void, CStr};
use std::os::raw::c_char;
use std::sync::Mutex;

#[link(name = "Carbon", kind = "framework")]
extern "C" {
    fn TISCopyCurrentKeyboardInputSource() -> *const c_void;
    fn TISCopyCurrentASCIICapableKeyboardInputSource() -> *const c_void;
    fn TISGetInputSourceProperty(source: *const c_void, key: *const c_void) -> *mut c_void;
    fn TISSelectInputSource(source: *const c_void) -> i32;
    static kTISPropertyInputSourceID: *const c_void;
    static kTISPropertyInputSourceIsASCIICapable: *const c_void;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: *const c_void);
    fn CFBooleanGetValue(boolean: *const c_void) -> u8;
    fn CFStringGetCString(
        string: *const c_void,
        buffer: *mut c_char,
        buffer_size: isize,
        encoding: u32,
    ) -> u8;
}

/// `kCFStringEncodingUTF8`
const UTF8: u32 = 0x0800_0100;

/// 切到 ASCII 之前的那一个输入源（CF 引用，由我们持有）。
/// 跨线程：命令在 Tauri 的工作线程上进来，实际调用被切到主线程执行，
/// 这个锁只保护「记着谁」这一件事。
static RESTORE_TARGET: Mutex<Option<usize>> = Mutex::new(None);

/// 当前输入源的标识（`com.apple.keylayout.ABC` 之类）。诊断与冒烟打印用。
pub fn current_identifier() -> String {
    let source = unsafe { TISCopyCurrentKeyboardInputSource() };
    if source.is_null() {
        return String::new();
    }
    let id = identifier(source);
    unsafe { CFRelease(source) };
    id
}

/// 切到 ASCII 键盘。返回是否真的切了（已经是 ASCII 或没有可用 ASCII 源时为 false）。
pub fn enter_ascii() -> bool {
    let current = unsafe { TISCopyCurrentKeyboardInputSource() };
    if current.is_null() {
        return false;
    }
    // 已经在 ASCII 布局上：不动，也不记还原目标。
    if is_ascii_capable(current) {
        unsafe { CFRelease(current) };
        return false;
    }
    let ascii = unsafe { TISCopyCurrentASCIICapableKeyboardInputSource() };
    if ascii.is_null() {
        unsafe { CFRelease(current) };
        return false;
    }
    if identifier(ascii) == identifier(current) {
        unsafe {
            CFRelease(ascii);
            CFRelease(current);
        }
        return false;
    }
    // 嵌套进入只记最外层：第二层进来时把这次多出来的引用放掉。
    let mut target = RESTORE_TARGET.lock().unwrap();
    if target.is_none() {
        *target = Some(current as usize);
    } else {
        unsafe { CFRelease(current) };
    }
    drop(target);

    let ok = unsafe { TISSelectInputSource(ascii) } == 0;
    unsafe { CFRelease(ascii) };
    if !ok {
        // 没切成功就别留着还原目标，否则下次 restore 会去选一个没意义的源。
        if let Some(ptr) = RESTORE_TARGET.lock().unwrap().take() {
            unsafe { CFRelease(ptr as *const c_void) };
        }
    }
    ok
}

/// 还原成进入字段之前那个输入源。没有记过就什么都不做。
pub fn restore() {
    let target = RESTORE_TARGET.lock().unwrap().take();
    if let Some(ptr) = target {
        unsafe {
            TISSelectInputSource(ptr as *const c_void);
            CFRelease(ptr as *const c_void);
        }
    }
}

fn identifier(source: *const c_void) -> String {
    let raw = unsafe { TISGetInputSourceProperty(source, kTISPropertyInputSourceID) };
    if raw.is_null() {
        return String::new();
    }
    let mut buffer = [0 as c_char; 256];
    let ok = unsafe {
        CFStringGetCString(
            raw as *const c_void,
            buffer.as_mut_ptr(),
            buffer.len() as isize,
            UTF8,
        )
    };
    if ok == 0 {
        return String::new();
    }
    unsafe { CStr::from_ptr(buffer.as_ptr()) }
        .to_string_lossy()
        .into_owned()
}

fn is_ascii_capable(source: *const c_void) -> bool {
    let raw = unsafe { TISGetInputSourceProperty(source, kTISPropertyInputSourceIsASCIICapable) };
    if raw.is_null() {
        return false;
    }
    unsafe { CFBooleanGetValue(raw as *const c_void) != 0 }
}

/// 前端在密码框 focus / blur 时调用。TIS 的选择动作要在主线程上做。
#[tauri::command]
pub fn ascii_input(app: tauri::AppHandle, on: bool) {
    let moved = app.clone();
    let _ = moved.run_on_main_thread(move || {
        if on {
            if !enter_ascii() {
                // 没切成功是常态（已经在英文、或系统只启用了一个中文源），不刷日志。
            }
        } else {
            restore();
        }
    });
}

/// 冒烟：切一次、读回来、再还原。`VAULT_INPUT=switch` 时由 main.rs 调用。
///
/// 每步之间留出停顿：输入源的切换是异步生效的，连续读会读到上一步的旧值
/// （第一版没有停顿，日志里出现「持有时已是 ABC 但 switched=false」这种自相矛盾的读数）。
///
/// 开头先 `restore()`：解锁页会自动聚焦主密码框，前端那条 `focusin` 已经切过一次
/// 并记了还原目标。不清掉的话，这里的 enter 会看到「已经是 ABC」直接返回，
/// 测到的是别人留下的状态。
pub fn smoke() {
    let step = || std::thread::sleep(std::time::Duration::from_millis(400));
    restore();
    step();
    println!("[input] 起始 {}", current_identifier());
    step();
    println!("[input] enter switched={}", enter_ascii());
    step();
    println!("[input] 持有时 {}（有还原目标={}）", current_identifier(), has_target());
    step();
    restore();
    step();
    println!("[input] 还原后 {}", current_identifier());
}

fn has_target() -> bool {
    RESTORE_TARGET.lock().unwrap().is_some()
}
