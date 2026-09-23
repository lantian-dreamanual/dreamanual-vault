/* 版本检查。
 *
 * 只做**手动**检查：应用不在启动时联网、不在后台轮询。用户点一下「立即检查」，
 * 拉一次官网的版本文件，比对版本号，然后停。这是应用自己发起的唯一一个网络请求。
 *
 * 拉取用 `fetch` 而不是走 Rust 命令，域名在 `tauri.conf.json` 的 CSP
 * `connect-src` 里逐个列出 —— 「这个应用能连到哪」是一行配置，不是隐藏行为。
 *
 * 文件里的 `download_url` 指向 DMG，但**发现新版本时不直接下 DMG**：
 * 那会绕开下载页上的说明（首次打开会被 Gatekeeper 拦，页面上写了怎么处理）。
 * 所以统一打开下载页。 */

/** 官网上的版本文件。名字带 `vault-` 前缀是为了与同目录下投资监控那份区分开 ——
 *  两个应用共用 `works/downloads/`，各自的 app 里都写死了自己的那一份，
 *  改名会让已经发出去的旧版本收不到更新提示。 */
export const UPDATE_JSON_URL = 'https://dreamanual.com/works/downloads/vault-version.json';

/** 下载页。发现新版本时把人送到这里，而不是直接下载。 */
export const DOWNLOAD_PAGE_URL = 'https://dreamanual.com/works/vault.html';

/** 赞赏。与官网页脚、投资监控设置页用的是同一个地址。 */
export const DONATE_URL = 'https://afdian.com/a/wuyifa001';

/** 版本文件的结构。字段名与官网那份 JSON 一致。 */
export interface UpdateInfo {
    version: string;
    notes?: string;
    download_url?: string;
    release_url?: string;
}

export type CheckState =
    | { kind: 'checking' }
    | { kind: 'latest' }
    | { kind: 'available'; version: string; notes: string; url: string }
    | { kind: 'failed' };

/** 语义化版本比较：`a` 比 `b` 新则为真。
 *
 *  逐段比数字，缺位按 0 算（`1.0` 与 `1.0.0` 视为同版）。非数字段按 0 处理 ——
 *  `Number.isFinite('x') === false`，于是 `v1.x` 这类脏数据不会抛异常，
 *  只会被判成旧版，也就是「不提示更新」，这是这个方向更安全的一侧。
 *
 *  写成导出的纯函数是为了能在验收里直接喂三组输入，不依赖网络。 */
export function isNewer(a: string, b: string): boolean {
    const pa = a.split('.').map((s) => Number.parseInt(s, 10));
    const pb = b.split('.').map((s) => Number.parseInt(s, 10));
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i += 1) {
        const x = Number.isFinite(pa[i]) ? pa[i] : 0;
        const y = Number.isFinite(pb[i]) ? pb[i] : 0;
        if (x > y) return true;
        if (x < y) return false;
    }
    return false;
}

/** 拉一次版本文件并与当前版本比对。
 *
 *  超时 4 秒：官网在境外时可能慢，但不该让按钮一直转。任何失败都收敛成
 *  `failed` —— 界面上「检查失败」与「已是最新」必须能分开，前者不该
 *  被说成后者，那等于告诉用户可以放心。 */
export async function checkUpdate(current: string): Promise<CheckState> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);

    let info: UpdateInfo;
    try {
        const res = await fetch(UPDATE_JSON_URL, {
            cache: 'no-cache',
            signal: controller.signal
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        info = (await res.json()) as UpdateInfo;
    } catch {
        return { kind: 'failed' };
    } finally {
        clearTimeout(timer);
    }

    if (!info || typeof info.version !== 'string' || !info.version) {
        return { kind: 'failed' };
    }
    if (!isNewer(info.version, current)) return { kind: 'latest' };

    return {
        kind: 'available',
        version: info.version,
        notes: typeof info.notes === 'string' ? info.notes : '',
        // 优先用文件里给的地址（以后换下载入口不必重发 app），
        // 但它同样要过一个「是不是本站」的判断 —— 版本文件是外部输入，
        // 让它决定打开哪个域等于把白名单交给服务端。
        url: safeDownloadUrl(info.download_url)
    };
}

function safeDownloadUrl(raw: unknown): string {
    return typeof raw === 'string' && raw.startsWith('https://dreamanual.com/')
        ? raw
        : DOWNLOAD_PAGE_URL;
}
