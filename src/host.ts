/* 与宿主（Rust）之间的通道。
 *
 * 只走 Tauri 的 invoke。M0 试过用本地回环 HTTP 端口做「独立于 IPC」的上报通道，
 * 实测被 WKWebView 的 App Transport Security 静默拦掉，已弃用。
 *
 * 库文件的字节走 base64 而不是数字数组：Tauri 的 IPC 会把 `Vec<u8>` 序列化成
 * JSON 数组，几十 KB 的库要膨胀成四倍长的文本再逐字符解析。
 * Rust 侧的理由见 src-tauri/src/vault.rs 顶部。 */

import { invoke } from '@tauri-apps/api/core';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { revealItemInDir } from '@tauri-apps/plugin-opener';

export const IN_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** 把启动读数交给 Rust 打印到 stdout，便于自动化采集（配 VAULT_PERF_EXIT=1 会自动退出） */
export async function reportBoot(report: string): Promise<void> {
    if (!IN_TAURI) {
        console.log('[boot] 非 Tauri 环境，读数如下：\n' + report);
        return;
    }
    try {
        await invoke('report_boot', { report });
    } catch (err) {
        console.error('启动读数上报失败', err);
    }
}

/** 前端异常也送一份到 stdout，避免「页面没跑起来」这类问题只能靠猜 */
export function reportError(message: string): void {
    if (!IN_TAURI) {
        console.error('[前端]', message);
        return;
    }
    void invoke('report_error', { message }).catch(() => {
        /* 连错误上报都失败时不再递归 */
    });
}

/** 等宿主确认收下的上报。给验收当**进度标记**用。
 *
 *  验收卡住时，`reportError` 那种「发了就不管」的写法靠不住：进程被看门狗杀掉时，
 *  还压在 IPC 队列里的那几条就永远到不了 stdout，日志里看不出停在哪一条。
 *  验收脚本自己出问题时，这份进度是唯一能定位的线索。 */
export async function reportErrorSync(message: string): Promise<void> {
    if (!IN_TAURI) {
        console.error('[前端]', message);
        return;
    }
    try {
        await invoke('report_error', { message });
    } catch {
        /* 上报失败不该影响正事 */
    }
}

/** 界面要跑真实链路就得有宿主；浏览器预览里明确说清楚，而不是抛一个看不懂的 IPC 错误 */
function requireHost(action: string): void {
    if (!IN_TAURI) throw new Error(`${action}需要应用环境，浏览器预览里不可用`);
}

// ------------------------------------------------------------------ 开发标记

/** 开发开关，由 `VAULT_DEV` 环境变量给出，逗号分隔。见 Rust 侧 `dev_flags` 的注释。
 *
 *  也接受 URL 查询串 `?dev=unlocked,settings`。浏览器里跑同一份前端做界面评审时
 *  没有 Tauri 环境，读不到环境变量，这条回退让同一个直通开关在两种环境下都能用。 */
export async function devFlags(): Promise<string[]> {
    const fromUrl = new URLSearchParams(window.location.search).get('dev') ?? '';
    const extra = fromUrl
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

    if (!IN_TAURI) return extra;

    try {
        const raw = await invoke<string>('dev_flags');
        const fromEnv = raw
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        return [...new Set([...fromEnv, ...extra])];
    } catch {
        return extra;
    }
}

/** 开发期的库主密码（`VAULT_DEV_PASSWORD`）。
 *
 *  自动化验收要跑真实的 KDF + 解密，绕不开一个密码。走环境变量取，
 *  而不是在代码里开一条「跳过校验」的分支 —— 后者会让验收测到一条
 *  与用户实际路径不同的代码路径，那就失去意义了。 */
export async function devPassword(): Promise<string> {
    if (!IN_TAURI) return '';
    try {
        return await invoke<string>('dev_password');
    } catch {
        return '';
    }
}

// ------------------------------------------------------------------ 库文件

export interface VaultInfo {
    path: string;
    exists: boolean;
    size: number;
    /** epoch 毫秒；文件不存在时为 null */
    modifiedAt: number | null;
    /** 这个位置来自配置（走过一次「打开其他库」），不是默认位置 */
    configured: boolean;
}

export async function vaultInfo(path?: string): Promise<VaultInfo> {
    requireHost('读取库文件信息');
    return invoke<VaultInfo>('vault_info', { path: path ?? null });
}

export async function vaultRead(path?: string): Promise<ArrayBuffer> {
    requireHost('读取库文件');
    const encoded = await invoke<string>('vault_read', { path: path ?? null });
    return b64ToBytes(encoded);
}

/** 导出到指定路径。返回写入的字节数。
 *
 *  用的是 `vault_write` 而不是 `vault_save`：导出件是给用户拿走的一份副本，
 *  不该在它旁边留下 `.bak`，也不该被镜像进备份目录。 */
export async function vaultWrite(bytes: ArrayBuffer, path?: string): Promise<number> {
    requireHost('写入库文件');
    return invoke<number>('vault_write', {
        data: bytesToB64(new Uint8Array(bytes)),
        path: path ?? null
    });
}

/** 保存主库。
 *
 *  与 `vaultWrite` 的区别是它附带两件只有主库才该做的事：覆盖前存一份本地历史版本，
 *  写完之后镜像到备份目录。返回值里的 `backup` 描述备份那一步的结果 ——
 *  它有 `error` 时**不代表保存失败**，库在那个时点已经写进磁盘了。 */
export async function vaultSave(bytes: ArrayBuffer, path?: string): Promise<SaveResult> {
    requireHost('保存库文件');
    return invoke<SaveResult>('vault_save', {
        data: bytesToB64(new Uint8Array(bytes)),
        path: path ?? null
    });
}

/** 换库：把路径记为当前库，写入应用配置（F1.3）。
 *  传 null 表示回到默认位置。只写配置，不动库文件。 */
export async function vaultSetPath(path: string | null): Promise<VaultInfo> {
    requireHost('切换库文件');
    return invoke<VaultInfo>('vault_set_path', { path });
}

/** 默认位置。配置里记着别处的库也不影响它 —— 这正是它存在的理由：
 *  建库要知道「本来该放哪」，而 `vault_info()` 给的是「当前库在哪」。 */
export async function vaultDefaultPath(): Promise<string> {
    requireHost('读取默认位置');
    return invoke<string>('vault_default_path');
}

/** 在访达中选中这个文件。
 *
 *  库文件放在 `~/Library/Application Support/` 下，而 Finder 默认隐藏 `~/Library`，
 *  所以光给一行路径不足以让人找到它 —— 这一条是「找不到我的库」那个问题的正面解法。 */
export async function revealInFinder(path: string): Promise<void> {
    requireHost('在访达中显示');
    await revealItemInDir(path);
}

// ------------------------------------------------------------------ 文件选择器

const KDBX_FILTER = [{ name: 'KeePass 数据库', extensions: ['kdbx'] }];

/** 原生「打开」对话框，挑一个 `.kdbx`。取消时返回 null。
 *
 *  插件只回传路径，读文件仍然走 `vault_read` —— capabilities 里没放 fs 权限，
 *  所以「用户选了什么」和「应用能读写什么」是两件事。 */
export async function pickVaultFile(): Promise<string | null> {
    if (!IN_TAURI) return null;
    const picked = await openDialog({
        title: '打开其他库',
        multiple: false,
        directory: false,
        filters: KDBX_FILTER
    });
    return typeof picked === 'string' ? picked : null;
}

/** 原生「另存为」对话框。取消时返回 null。 */
export async function pickSavePath(defaultName: string): Promise<string | null> {
    if (!IN_TAURI) return null;
    const picked = await saveDialog({
        title: '导出库文件',
        defaultPath: defaultName,
        filters: KDBX_FILTER
    });
    return picked ?? null;
}

/** 给新建的库挑保存位置。取消时返回 null。
 *
 *  `defaultPath` 传默认位置的完整路径，这样对话框一打开就停在应用数据目录，
 *  文件名也预填好了 —— 不想挑位置的人直接回车即可。 */
export async function pickNewVaultPath(defaultPath: string): Promise<string | null> {
    if (!IN_TAURI) return null;
    const picked = await saveDialog({
        title: '库文件保存到',
        defaultPath,
        filters: KDBX_FILTER
    });
    if (!picked) return null;
    // 手打文件名时可能没带扩展名。补上 —— 扩展名决定以后能不能双击打开，
    // 也是「在访达里找库」这件事一致的锚点。
    return picked.toLowerCase().endsWith('.kdbx') ? picked : `${picked}.kdbx`;
}

/** 挑备份目录。取消时返回 null。
 *
 *  用 `open` 的 `directory: true` —— capabilities 里 `dialog:allow-open` 已经覆盖，
 *  不需要为「选目录」再加一条权限。 */
export async function pickBackupDir(): Promise<string | null> {
    if (!IN_TAURI) return null;
    const picked = await openDialog({
        title: '选择备份目录',
        multiple: false,
        directory: true
    });
    return typeof picked === 'string' ? picked : null;
}

// ------------------------------------------------------------------ 设置与备份

/** 应用配置。字段名与 Rust 侧 `AppConfig` 一一对应（那边是 camelCase 序列化）。 */
export interface AppConfig {
    theme: string;
    /** 0 表示从不自动锁定 */
    autoLockMinutes: number;
    /** 0 表示不自动清除剪贴板 */
    clipboardClearSeconds: number;
    kdfPreset: string;
    /** null 表示还没设置 —— 首次启动就是这个状态 */
    backupDir: string | null;
    backupAuto: boolean;
    keepVersions: number;
    lockOnSleep: boolean;
    lastOpenedVault: string | null;
    /** RFC3339 */
    lastBackupAt: string | null;
    lastBackupError: string | null;
}

export interface BackupStatus {
    configured: boolean;
    auto: boolean;
    dir: string | null;
    keepVersions: number;
    lastAt: string | null;
    lastError: string | null;
    /** 上次成功超过 24 小时 */
    stale: boolean;
}

export interface BackupOutcome {
    dest: string;
    bytes: number;
    /** 内容与目的盘上那份一致，跳过了，没产生新的历史版本 */
    unchanged: boolean;
    rotated: string | null;
    pruned: number;
}

export interface BackupRun {
    status: BackupStatus;
    /** 真的镜像了 */
    outcome: BackupOutcome | null;
    /** 没做，以及为什么 */
    skipped: string | null;
    /** 做了但失败了。这是**备份**的错误，不是保存的错误 */
    error: string | null;
}

export interface SaveResult {
    bytes: number;
    /** 这次轮转出来的本地历史版本文件名 */
    localVersion: string | null;
    backup: BackupRun;
}

export async function settingsGet(): Promise<AppConfig> {
    requireHost('读取设置');
    return invoke<AppConfig>('settings_get');
}

/** 只传改动的那几项。
 *
 *  不要把手里的整份配置传回来：那份是打开设置页时读的，而备份成功后 Rust 会写
 *  `lastBackupAt` —— 整份覆盖会把刚写的时间戳冲掉，而那个时间是发现备份坏了的第一信号。
 *
 *  返回值要用上：Rust 侧可能把越界值收回到合法档位，按返回值重新渲染才不会和磁盘不一致。 */
export async function settingsUpdate(patch: Record<string, unknown>): Promise<AppConfig> {
    requireHost('保存设置');
    return invoke<AppConfig>('settings_update', { patch });
}

export async function backupStatus(): Promise<BackupStatus> {
    requireHost('读取备份状态');
    return invoke<BackupStatus>('backup_status');
}

/** 跑一次备份。`manual` 为真时忽略「保存后自动镜像」那个开关（「立即备份」按钮用它）。 */
export async function backupRun(manual: boolean): Promise<BackupRun> {
    requireHost('执行备份');
    return invoke<BackupRun>('backup_run', { manual });
}

export interface VersionInfo {
    path: string;
    name: string;
    size: number;
    modifiedAt: number | null;
}

/** 某个库文件旁边的历史版本，从新到旧。不传路径就是当前库。 */
export async function vaultVersions(path?: string): Promise<VersionInfo[]> {
    requireHost('读取历史版本');
    return invoke<VersionInfo[]>('vault_versions', { path: path ?? null });
}

/** 配置层认得的合法取值。给验收用 —— 它拿这份和设置页的 `<option>` 对比。 */
export interface SettingsChoices {
    autoLockMinutes: number[];
    clipboardClearSeconds: number[];
    kdfPresets: string[];
    keepVersionsMin: number;
    keepVersionsMax: number;
}

export async function settingsChoices(): Promise<SettingsChoices> {
    requireHost('读取设置项的可选值');
    return invoke<SettingsChoices>('settings_choices');
}

// ------------------------------------------------------------------ 自动锁定

/** 与 Rust 侧 `lock::LOCK_EVENT` 必须一致。跨语言共享不了常量，两边各写一份。 */
const LOCK_EVENT = 'vault://lock';

export interface LockStatus {
    armed: boolean;
    idleMinutes: number;
    lockOnSleep: boolean;
    /** 无操作阈值（秒）。0 = 从不。开发期被环境变量覆盖时读到的是覆盖后的值 */
    idleSeconds: number;
    sinceActivityMs: number;
    /** 已发出的锁定原因，没有则为 null */
    fired: string | null;
    /** 系统层面是否已离开。null = 这次没读到 */
    sessionAway: boolean | null;
}

/** 浏览器预览里没有宿主。返回一份「未启用」的快照，让界面代码不必到处判空。 */
const LOCK_IDLE: LockStatus = {
    armed: false,
    idleMinutes: 0,
    lockOnSleep: false,
    idleSeconds: 0,
    sinceActivityMs: 0,
    fired: null,
    sessionAway: null
};

/** 用户还在操作。前端按节流上报，不必每次移动鼠标都发。 */
export async function lockActivity(): Promise<LockStatus> {
    if (!IN_TAURI) return LOCK_IDLE;
    return invoke<LockStatus>('lock_activity');
}

/** 库打开之后开始计时。`minutes` 是设置里的档位，0 = 从不。 */
export async function lockArm(minutes: number, lockOnSleep: boolean): Promise<LockStatus> {
    if (!IN_TAURI) return LOCK_IDLE;
    return invoke<LockStatus>('lock_arm', { minutes, lockOnSleep });
}

/** 库关掉之后停表。 */
export async function lockDisarm(): Promise<LockStatus> {
    if (!IN_TAURI) return LOCK_IDLE;
    return invoke<LockStatus>('lock_disarm');
}

/** 设置页改了「自动锁定」或「锁屏与休眠时锁定」。库没开着也记下来，下次 arm 用得上。 */
export async function lockConfigure(minutes: number, lockOnSleep: boolean): Promise<LockStatus> {
    if (!IN_TAURI) return LOCK_IDLE;
    return invoke<LockStatus>('lock_configure', { minutes, lockOnSleep });
}

export async function lockStatus(): Promise<LockStatus> {
    if (!IN_TAURI) return LOCK_IDLE;
    return invoke<LockStatus>('lock_status');
}

/** 锁定原因对应的一句话。对照表在 Rust 侧，界面不必自己维护一份。 */
export async function lockLabel(reason: string): Promise<string> {
    if (!IN_TAURI) return '已锁定';
    return invoke<string>('lock_label', { reason });
}

/** 订阅「该锁定了」。返回退订函数。
 *
 *  Rust 侧会按固定间隔重发同一条消息 —— 前端进程在锁屏期间可能正被挂起，
 *  只发一次会丢。所以这里必须做得幂等：已经回到解锁页就什么也不做。 */
export async function listenLock(cb: (reason: string) => void): Promise<() => void> {
    if (!IN_TAURI) return () => undefined;
    try {
        const { listen } = await import('@tauri-apps/api/event');
        return await listen<string>(LOCK_EVENT, (ev) => cb(ev.payload));
    } catch (err) {
        reportError(`订阅锁定事件失败：${String(err)}`);
        return () => undefined;
    }
}

// ------------------------------------------------------------------ 剪贴板

export interface ClipboardStatus {
    /** 正在计时。复制之后为真，清完 / 被替换 / 停表之后为假 */
    armed: boolean;
    /** 当前档位（秒）。0 = 从不 */
    seconds: number;
    /** 距上一次复制的时长 */
    elapsedMs: number;
    /** 这一次复制之后已经清过了 */
    fired: boolean;
    /** 复制时读到的剪贴板计数 */
    baseline: number;
    /** 现在的计数。null = 这次没读到 */
    changeCount: number | null;
    /** 现在是否仍是「我们写进去的那一份」 */
    unchanged: boolean;
}

const CLIPBOARD_IDLE: ClipboardStatus = {
    armed: false,
    seconds: 0,
    elapsedMs: 0,
    fired: false,
    baseline: 0,
    changeCount: null,
    unchanged: false
};

/** 复制之后开始计时。
 *
 *  必须在 `navigator.clipboard.writeText` **成功之后**调 —— Rust 侧读到的那次
 *  `changeCount` 就是「我们刚写进去的那一份」的编号，基准取早了会让第一轮检查
 *  就以为剪贴板被别人改过，于是立刻停表，永远清不掉。
 *
 *  档位不从这里传，由 `clipboardConfigure` 维护。 */
export async function clipboardArm(): Promise<ClipboardStatus> {
    if (!IN_TAURI) return CLIPBOARD_IDLE;
    return invoke<ClipboardStatus>('clipboard_arm');
}

/** 停表，不再清除。 */
export async function clipboardDisarm(): Promise<ClipboardStatus> {
    if (!IN_TAURI) return CLIPBOARD_IDLE;
    return invoke<ClipboardStatus>('clipboard_disarm');
}

/** 立即清除，顺带停表 —— 锁定 / 换库这类「用户已经离开」的时刻用（PRD §4.4）。
 *
 *  与到点自动清除走同一套判断：剪贴板里还是我们写的那一份才动它。
 *  没复制过时什么都不做，不会清掉用户自己的剪贴板。 */
export async function clipboardClearNow(): Promise<ClipboardStatus> {
    if (!IN_TAURI) return CLIPBOARD_IDLE;
    return invoke<ClipboardStatus>('clipboard_clear_now');
}

/** 设置页改了「剪贴板清除」档位。库没开着也记下来，下次复制时用得上。 */
export async function clipboardConfigure(seconds: number): Promise<ClipboardStatus> {
    if (!IN_TAURI) return CLIPBOARD_IDLE;
    return invoke<ClipboardStatus>('clipboard_configure', { seconds });
}

export async function clipboardStatus(): Promise<ClipboardStatus> {
    if (!IN_TAURI) return CLIPBOARD_IDLE;
    return invoke<ClipboardStatus>('clipboard_status');
}

// ------------------------------------------------------------------ 应用菜单

/** 与 Rust 侧 `menu::MENU_EVENT` 必须一致。跨语言共享不了常量，两边各写一份。 */
const MENU_EVENT = 'vault://menu';

/**
 * 菜单栏里「设置」与「锁定」两条的点击（含各自的快捷键 ⌘, 与 ⌘L）。
 *
 * 为什么快捷键也走这条路而不是前端自己判：macOS 上菜单的 key equivalent 先于
 * 网页拿到按键。两边都写的话，一次按键会触发两下 —— 而这两个动作都是开关语义，
 * 触发两下等于什么都没发生。所以 ⌘, 与 ⌘L 只写在菜单里，前端只订阅这个事件。
 *
 * 载荷是动作名（`menu::action_for` 的返回值），不是菜单 id ——
 * 认不出来的 id 在 Rust 侧就被丢掉了，前端不用再判一次。
 */
export async function listenMenu(cb: (action: string) => void): Promise<() => void> {
    if (!IN_TAURI) return () => undefined;
    try {
        const { listen } = await import('@tauri-apps/api/event');
        return await listen<string>(MENU_EVENT, (ev) => cb(ev.payload));
    } catch (err) {
        reportError(`订阅菜单事件失败：${String(err)}`);
        return () => undefined;
    }
}

// ------------------------------------------------------------------ 版本与外链

/** 当前版本号。来自 `tauri.conf.json` 的 `version`（见 `src-tauri/src/update.rs`）。
 *
 *  界面不另存一份 —— 两处各写一个版本号，发版时漏改一处就会出
 *  「装了新版，界面还说是旧版」，而更新检查恰好是拿这个值去比对的，
 *  结果是永远提示有新版本。 */
export async function appVersion(): Promise<string> {
    requireHost('读取版本号');
    return invoke<string>('app_version');
}

/** 用系统浏览器打开链接。
 *
 *  域名白名单在 Rust 侧（`update.rs` 的 `ALLOWED_PREFIXES`）——
 *  这是唯一能把用户带出应用的入口，拦在宿主一侧才有意义。 */
export async function openExternal(url: string): Promise<void> {
    requireHost('打开链接');
    await invoke('open_external', { url });
}

// ------------------------------------------------------------------ base64

function b64ToBytes(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out.buffer;
}

/** 分块拼接。一次性 `String.fromCharCode(...bytes)` 在几十 KB 上会爆调用栈。 */
function bytesToB64(bytes: Uint8Array): string {
    const CHUNK = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}
