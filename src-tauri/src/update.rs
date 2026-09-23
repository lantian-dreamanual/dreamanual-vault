//! 版本信息，以及唯一一个能把用户带出应用的入口。
//!
//! # 这个应用的联网面
//!
//! 由应用自己发起的网络请求**只有一个**：用户点「检查更新」时拉一次官网的
//! `vault-version.json`。拉取走前端的 `fetch`（见 `src/ui/update.ts`），
//! 域名逐个写在 `tauri.conf.json` 的 CSP `connect-src` 里 ——
//! 「这个应用能连到哪」因此是一行可审计的配置，而不是散在代码里的某个常量。
//!
//! 没有自动检查：不在启动时联网、不在后台轮询。这一点是刻意的，密码管理器
//! 「什么时候往外发请求」应当是用户按下去的那一刻。
//!
//! # 两处白名单各管一段
//!
//! `open_external` 是唯一能唤起系统浏览器的入口，域名在这里再过一道白名单。
//! CSP 管的是「WebView 自己能往哪发请求」，白名单管的是「能把用户带到哪」。
//! 少任何一道，前端一旦被注入就是一个任意跳板 —— 一个能打开任意 URL 的
//! 密码管理器，可以被拿去拼 `file://` 或某个自定义协议。

use tauri_plugin_opener::OpenerExt;

/// 允许唤起浏览器的前缀。用前缀而不是完整 URL：发版时下载页路径可能变，
/// 域名不会。三个域对应三件事 —— 下载页、赞赏、GitHub Release。
const ALLOWED_PREFIXES: &[&str] = &[
    "https://dreamanual.com/",
    "https://afdian.com/",
    "https://github.com/lantian-dreamanual/",
];

/// 当前版本号。
///
/// 取自 `tauri.conf.json` 的 `version`（`package_info()` 读的就是它），
/// 界面不另存一份 —— 设置页上显示的版本与实际二进制永远是同一个来源。
/// 前端若自己写一个 `const VERSION = '1.0.0'`，发版时漏改一处就会出现
/// 「装了新版，界面还说是旧版，于是更新检查永远判定为有新版本」。
#[tauri::command]
pub fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/// 用系统默认浏览器打开一个链接。不在白名单里的地址直接拒绝。
#[tauri::command]
pub fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if !ALLOWED_PREFIXES.iter().any(|p| url.starts_with(p)) {
        return Err(format!("不允许打开的地址：{url}"));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|err| format!("打开链接失败：{err}"))
}

#[cfg(test)]
mod tests {
    use super::ALLOWED_PREFIXES;

    fn allowed(url: &str) -> bool {
        ALLOWED_PREFIXES.iter().any(|p| url.starts_with(p))
    }

    #[test]
    fn accepts_the_three_intended_hosts() {
        assert!(allowed("https://dreamanual.com/works/vault.html"));
        assert!(allowed("https://dreamanual.com/works/downloads/vault-version.json"));
        assert!(allowed("https://afdian.com/a/wuyifa001"));
        assert!(allowed("https://github.com/lantian-dreamanual/vault/releases"));
    }

    #[test]
    fn rejects_everything_else() {
        // 同域但换协议：http 不该被放行 —— 明文传输的下载页等于可被中间人替换
        assert!(!allowed("http://dreamanual.com/works/vault.html"));
        // 后缀混淆：dreamanual.com.evil.example 以 `dreamanual.com` 开头，但不以
        // `https://dreamanual.com/` 开头。前缀比较里的那个斜杠就是为它留的。
        assert!(!allowed("https://dreamanual.com.evil.example/x"));
        assert!(!allowed("https://evil.example/https://dreamanual.com/"));
        // 自定义协议与本地文件
        assert!(!allowed("file:///etc/passwd"));
        assert!(!allowed("javascript:alert(1)"));
        assert!(!allowed(""));
    }
}
