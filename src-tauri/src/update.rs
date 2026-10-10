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
//!
//! 例外是条目网址（`open_entry_url`）：用户存的网址是任意站（官网、内网
//! 服务、裸域 IP），域名白名单天然不适用。校验换成「仅限 http/https 协议」
//! —— 跳板攻击真正依赖的 `file://`、`javascript:` 与自定义协议依然全部
//! 挡在宿主这一侧，威胁模型没有被扩大。

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

/// 条目网址是否放行：仅限 http/https 协议。
///
/// 判定用小写比较（用户存 `HTTPS://EXAMPLE.COM` 也该能开）；协议之后的部分
/// 不做检查 —— 域名是用户自己存的，宿主没有资格替他审。
fn entry_url_allowed(url: &str) -> bool {
    let lower = url.to_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// 用系统默认浏览器打开一个条目网址。与 `open_external` 的校验口径见模块注释。
///
/// 裸域的 `https://` 补全在前端做（`vault.ts`），这一层只做协议终审 ——
/// 校验留在宿主一侧才有意义：前端可以被注入，Rust 不会。
#[tauri::command]
pub fn open_entry_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if !entry_url_allowed(&url) {
        return Err(format!("不允许打开的地址：{url}"));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|err| format!("打开链接失败：{err}"))
}

#[cfg(test)]
mod tests {
    use super::{ALLOWED_PREFIXES, entry_url_allowed};

    fn allowed(url: &str) -> bool {
        ALLOWED_PREFIXES.iter().any(|p| url.starts_with(p))
    }

    #[test]
    fn accepts_the_three_intended_hosts() {
        assert!(allowed("https://dreamanual.com/works/vault.html"));
        assert!(allowed("https://dreamanual.com/works/downloads/vault-version.json"));
        assert!(allowed("https://afdian.com/a/wuyifa001"));
        assert!(allowed("https://github.com/lantian-dreamanual/dreamanual-vault/releases"));
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

    #[test]
    fn entry_url_accepts_http_and_https() {
        assert!(entry_url_allowed("https://example.com/login"));
        assert!(entry_url_allowed("http://192.0.2.1:8080/admin"));
        // 大写协议：用户手存的值不因为大小写被拒
        assert!(entry_url_allowed("HTTPS://EXAMPLE.COM"));
    }

    #[test]
    fn entry_url_rejects_everything_else() {
        // 跳板攻击真正依赖的入口，一个都不能过
        assert!(!entry_url_allowed("file:///etc/passwd"));
        assert!(!entry_url_allowed("javascript:alert(1)"));
        assert!(!entry_url_allowed("ftp://example.com/pub"));
        assert!(!entry_url_allowed("ssh://git@example.com/repo"));
        assert!(!entry_url_allowed(""));
        assert!(!entry_url_allowed("example.com")); // 裸域由前端补协议后再来
        assert!(!entry_url_allowed("https:example.com")); // 缺 //
    }
}
