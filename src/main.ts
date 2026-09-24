/* 应用入口：主题、视图切换、快捷键、启动自检。
 *
 * 三个视图与各自的入口都在这里收敛：解锁页 / 主视图 / 设置面板。
 * 这里也是**快捷键的唯一一张表** —— ⌘N 新建、⌘F 搜索、⌘C 复制当前字段、Esc 取消。
 * ⌘, 与 ⌘L 不在这张表里：它们写在应用菜单栏（src-tauri/src/menu.rs），
 * 理由是 macOS 的菜单 key equivalent 先于网页拿到按键，两边都写会一次按键触发两下。
 *
 * 备份、自动锁定、剪贴板清除在 M3 接通；M4 起菜单栏与窗口几何在 Rust 侧
 * （menu.rs / window.rs）。换 KDF 档位与改主密码（F7.5 / F7.6）在设置页，
 * 重建流程本身在 `vault/store.ts` 的 `rebuild()` —— 它要跑四次 Argon2 派生，
 * 所以那一段时间里视图会冻住，按钮会切到「重建中…」。
 *
 * 开发期的库文件写在 VAULT_HOME 指向的目录，不碰 `~/Library/Application Support/`。 */

import './styles/tokens.css';
import './styles/base.css';
import './styles/views.css';

import { isComposing, must, toast } from './ui/dom';
import { clockTime, vaultDisplayName } from './ui/format';
import { confirmDialog } from './ui/confirm';
import { contextMenu, type MenuItem } from './ui/menu';
import { groupDialog, type GroupDraft } from './ui/palette';
import { argon2SelfTest } from './vault/argon2';
import { describeEngine, installArgon2, isArgon2Installed, type EngineInfo } from './vault/kdbx';
import {
    clipboardClearNow,
    clipboardConfigure,
    devFlags,
    devPassword,
    IN_TAURI,
    listenLock,
    listenMenu,
    lockActivity,
    lockArm,
    lockDisarm,
    lockLabel,
    reportBoot,
    reportError,
    reportErrorSync,
    settingsGet,
    vaultDefaultPath
} from './host';
import { VaultStore } from './vault/store';
import { DOT_COLORS, type VaultEntry } from './vault/model';
import { runAcceptance } from './dev/accept';
import { MemorySession } from './dev/memory';
import { DEMO_ENTRIES, DEMO_GROUPS } from './dev/seed';
import { EntryEditor, NEW_CATEGORY } from './views/editor';
import { SettingsView } from './views/settings';
import { UnlockView } from './views/unlock';
import { ALL_GROUP, VaultView } from './views/vault';

const T_START = performance.now();

window.addEventListener('error', (ev) => reportError(`${ev.message} @ ${ev.filename}:${ev.lineno}`));
window.addEventListener('unhandledrejection', (ev) => reportError(`未处理的拒绝：${String(ev.reason)}`));

// ------------------------------------------------------------------ 视图

const viewUnlock = must('#view-unlock');
const viewApp = must('#view-app');
const paneVault = must('#pane-vault');
const paneSettings = must('#pane-settings');
const btnNewEntry = must<HTMLButtonElement>('#btn-new-entry');
const btnSettings = must<HTMLButtonElement>('#btn-settings');
const btnVault = must<HTMLButtonElement>('#btn-vault');
const vaultNameEl = must('#vault-name');
const saveStateEl = must('#save-state');

let settingsOpen = false;
/** 在下面 `new SettingsView(...)` 时赋值。`setSettingsOpen` 声明在前面，
 *  所以要能容忍它还没被创建 —— 首次渲染路径上可能会先调一次。 */
let settingsView: SettingsView | null = null;

function paintLock(): void {
    viewUnlock.classList.add('is-active');
    viewApp.classList.remove('is-active');
}

function paintApp(): void {
    viewApp.classList.add('is-active');
    viewUnlock.classList.remove('is-active');
}

function setSettingsOpen(open: boolean): void {
    settingsOpen = open;
    paneVault.classList.toggle('is-active', !open);
    paneSettings.classList.toggle('is-active', open);
    // 到这里就完了 —— 侧栏不用管。设置面板是绝对定位铺满**整窗**的（见 views.css
    // 的 `#pane-settings.is-active`），它盖住的区域本来就点不动。
    // 原先这里还给 `.cats` 挂一个 `.is-muted`（灰掉 + `pointer-events: none`），
    // 那是在两栏布局下才需要的补丁：侧栏留在视野里，得主动声明它不可用。
    // 底栏那个齿轮同时是「打开设置」与「回到保险箱」，用点亮态表示后者。
    // 位置固定、图标不变，顺带还是 ⌘, 在界面上的唯一可见提示。
    btnSettings.classList.toggle('is-on', open);
    btnSettings.title = open ? '返回保险箱（⌘,）' : '设置（⌘,）';
    btnSettings.setAttribute('aria-label', open ? '返回保险箱' : '设置');
    btnNewEntry.disabled = open;
    // 面板上的值来自 config.json，而备份状态等在面板关着的时候也会变
    // （每次保存都会镜像一次）。所以要现读一次，而不是拿上次打开时的快照。
    if (open) void settingsView?.refresh();
}

// ------------------------------------------------------------------ 库

const store = new VaultStore();

// ------------------------------------------------------------------ 视图实例

const vault = new VaultView(store, {
    onNewEntry: () => editor.openCreate(),
    onEditEntry: (entry) => editor.openEdit(entry),
    onDeleteEntry: (entry) => void removeEntry(entry),
    onNewGroup: () => void newGroup(),
    onEditGroup: (name) => void editGroup(name),
    onDeleteGroup: (name) => void deleteGroup(name),
    onReorderGroups: (names) => reorderGroups(names)
});

const editor = new EntryEditor({
    defaultGroup: () => vault.preset(),
    groups: () => store.groups(),
    onNewCategory: () => createGroupForEditor(),
    onSave: (entry) => saveEntry(entry),
    onDelete: (entry) => void removeEntry(entry)
});

settingsView = new SettingsView(store, { onVaultSwitched: () => void backToLock() });

const unlock = new UnlockView(store, () => enterApp());

function enterApp(): void {
    vault.refresh();
    setSettingsOpen(false);
    paintApp();
}

/** 换库之后统一回解锁页。会话已由 `store.switchPath` 断开，这里只负责把界面挪回去。 */
async function backToLock(): Promise<void> {
    setSettingsOpen(false);
    paintLock();
    vault.refresh();
    await unlock.prepare();
}

// ------------------------------------------------------------------ 写库

/** 编辑弹窗对「新建」留空 id、「编辑」沿用原 id，所以按 id 有没有值分流 */
function saveEntry(entry: VaultEntry): void {
    try {
        if (entry.id) store.updateEntry(entry);
        else store.addEntry(entry);
    } catch (err) {
        toast(errorText(err), 2600);
    }
    vault.refresh();
}

async function removeEntry(entry: VaultEntry): Promise<void> {
    const ok = await confirmDialog({
        title: '删除条目',
        body: `确定删除「${entry.title}」吗？该条目会移入回收站，可在回收站里恢复。`,
        confirmText: '删除',
        danger: true
    });
    if (!ok) return;

    store.removeEntry(entry.id);
    vault.forget(entry.id);
}

// ------------------------------------------------------------------ 分类

/** 分类面板。三个入口（侧栏的 +、编辑弹窗下拉的末项、右键「编辑分类…」）共用一份 ——
 *  名字与颜色怎么问只该有一处。`from` 为空表示新建。 */
async function askGroup(from: string | null): Promise<GroupDraft | undefined> {
    return groupDialog({
        title: from ? '编辑分类' : '新建分类',
        name: from ?? '',
        color: from ? (store.groupColors()[from] ?? null) : null,
        validate: (value) =>
            value !== from && store.groups().includes(value) ? `分类「${value}」已经存在` : null
    });
}

async function newGroup(): Promise<void> {
    const draft = await askGroup(null);
    if (!draft) return;

    try {
        const created = store.createGroup(draft.name, draft.color);
        vault.selectGroup(created);
        toast(`已新建分类「${created}」`);
    } catch (err) {
        toast(errorText(err), 2600);
    }
}

/** 编辑弹窗里「＋ 新建分类…」。
 *
 *  跟 `newGroup` 的区别只有一个，但这个区别要紧：**不调 `vault.selectGroup`**。
 *  弹窗还开着，把侧栏筛选切到新分类会在背后换掉列表 —— 用户按取消的话，
 *  界面已经跟打开弹窗前不是同一个样子了。 */
async function createGroupForEditor(): Promise<string | null> {
    const draft = await askGroup(null);
    if (!draft) return null;

    try {
        const created = store.createGroup(draft.name, draft.color);
        toast(`已新建分类「${created}」`);
        return created;
    } catch (err) {
        toast(errorText(err), 2600);
        return null;
    }
}

/** 右键「编辑分类…」：名称与颜色在同一个面板里改完。
 *
 *  旧色在打开面板**之前**读，面板关掉之后按「真的改过哪一项」分别提示 ——
 *  只改了颜色却提示「已改名为…」会让人以为名字也被动过。 */
async function editGroup(from: string): Promise<void> {
    const was = store.groupColors()[from] ?? null;
    const draft = await askGroup(from);
    if (!draft) return;

    const renamed = draft.name !== from;
    const recolored = draft.color !== was;
    // 两处都没动就什么都不写、也不提示：打开面板又原样保存不是一次改动。
    if (!renamed && !recolored) return;

    try {
        const final = store.updateGroup(from, draft.name, draft.color);
        if (renamed) vault.selectGroup(final);
        vault.refresh();

        if (renamed && recolored) toast(`已更新分类「${final}」`);
        else if (renamed) toast(`已改名为「${final}」`);
        else if (draft.color) toast('已设置颜色');
        else toast('已改回自动色');
    } catch (err) {
        toast(errorText(err), 2600);
    }
}

async function deleteGroup(name: string): Promise<void> {
    const count = store.groupCounts().get(name) ?? 0;
    const ok = await confirmDialog({
        title: '删除分类',
        body: count
            ? `分类「${name}」里的 ${count} 条会移入「未分类」，不会被删除。`
            : `确定删除空分类「${name}」吗？`,
        confirmText: '删除',
        danger: true
    });
    if (!ok) return;

    try {
        store.removeGroup(name);
        vault.selectGroup(ALL_GROUP);
        toast(`已删除分类「${name}」`);
    } catch (err) {
        toast(errorText(err), 2600);
    }
}

/** 拖拽改序的结果。落库失败时把侧栏拉回真实顺序 —— 界面是照拖动后的样子画的，
 *  不重画的话，用户看到的顺序与库里存的对不上。 */
function reorderGroups(names: string[]): void {
    try {
        store.reorderGroups(names);
    } catch (err) {
        toast(errorText(err), 2600);
    }
    vault.refresh();
}

// ------------------------------------------------------------------ 锁定

async function lock(reason?: string): Promise<void> {
    await store.save(); // 把攒着的改动写下去，别让最后一笔只留在内存里
    store.close();
    setSettingsOpen(false);
    paintLock();
    if (reason) {
        try {
            unlock.notice(await lockLabel(reason));
        } catch {
            /* 提示语拿不到不影响锁定本身 */
        }
    }
    await unlock.prepare();
}

// ------------------------------------------------------------------ 自动锁定

/** 上一次上报活动的时刻。
 *
 *  节流放在事件里做，不用 `setInterval` —— 定时器在窗口失焦时会被 WKWebView 节流，
 *  锁屏时更是完全停掉（PRD 附录 K5）。事件触发不受这套调度影响。 */
let lastActivitySent = 0;
const ACTIVITY_INTERVAL = 2000;

function reportActivity(): void {
    const now = performance.now();
    if (now - lastActivitySent < ACTIVITY_INTERVAL) return;
    lastActivitySent = now;
    void lockActivity();
}

// 只认「用户真的动了」这几类。`scroll` 不算 —— 列表刷新后程序化滚回顶部也会触发它，
// 而那不是用户操作。计时本身在 Rust 侧，这边的上报只负责把「最后一动」的时间往前推。
for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel']) {
    document.addEventListener(type, reportActivity, { passive: true });
}

/** 会话开合与计时挂钩。
 *
 *  挂在订阅上而不是写进各个入口：解锁、新建、换库、验收脚本直接调 `store.open()`，
 *  最后都会走到会话状态变化这一处，散在各入口会漏。
 *
 *  配置是现读的 —— 设置页改了档位之后，要等下一次开库才生效；
 *  改了就想立刻生效的走 `lockConfigure`（见 views/settings.ts）。 */
let lockArmed = false;

store.subscribe(() => {
    const open = store.isOpen();
    if (open === lockArmed) return;
    lockArmed = open;

    if (!open) {
        void lockDisarm();
        // §4.4 的「锁定时立即清除」。会话一关就意味着用户已经离开（手动锁定、
        // 自动锁定、换库都走这里），剪贴板里的凭据不该再等那一档定时。
        //
        // 退出那半在 Rust 侧：`RunEvent::Exit` 里调同一个 `flush`（见 clipboard.rs）。
        // 前端这里补不了退出 —— 那时页面已经拆了。
        void clipboardClearNow();
        return;
    }
    if (!IN_TAURI) return;
    void (async () => {
        try {
            const cfg = await settingsGet();
            await lockArm(cfg.autoLockMinutes, cfg.lockOnSleep);
            // 剪贴板档位也在这里补一次。它由 Rust 侧按「当前档位」计时，而档位只在
            // 设置页改动时才会更新 —— 不补这一次，每次重启应用都会退回默认的 30 秒，
            // 而设置页上显示的还是用户选的那一档。
            await clipboardConfigure(cfg.clipboardClearSeconds);
        } catch (err) {
            // 起不来只是不自动锁，库本身照常可用，不该打扰用户
            reportError(`启用自动锁定失败：${errorText(err)}`);
        }
    })();
});

/** Rust 侧判定该锁了。
 *
 *  必须幂等：进程在锁屏期间可能被挂起，那条事件只发一次会丢，
 *  所以 Rust 会按固定间隔重发同一句。已经回到解锁页就什么也不做。 */
async function onAutoLock(reason: string): Promise<void> {
    if (!store.isOpen()) return;
    await lock(reason);
}

// ------------------------------------------------------------------ 侧栏按钮

// ------------------------------------------------------------------ 侧栏底栏

/**
 * 底栏那行「现在开的是哪个库」。
 *
 * 库名取 KDBX 的 `meta.name`。它可能为空（别处造的库、或从 KeePass 导进来没写库名的
 * 库），兜底与设置页「库名」那行共用 `vaultDisplayName()`。未解锁时 `vaultName()`
 * 本就是空串，不必再判一次 `isOpen()`。
 */
function refreshVaultLabel(): void {
    const status = store.status();
    const label = vaultDisplayName(store.vaultName, status.path);

    vaultNameEl.textContent = label;
    // 库名长过这一行时会被省略号吃掉，title 是唯一还能看到全名的入口
    btnVault.title = status.path ? `${label}\n${status.path}\n点击切换密码库` : '切换密码库';
}

btnNewEntry.addEventListener('click', () => {
    if (!settingsOpen) editor.openCreate();
});
must('#btn-lock').addEventListener('click', () => void lock());
btnSettings.addEventListener('click', () => setSettingsOpen(!settingsOpen));
// 设置面板自己的出口。与上面那个按钮共用 setSettingsOpen(false)，不另开一条路径。
must('#set-close').addEventListener('click', () => setSettingsOpen(false));

/**
 * 换库的三条动作全在 `SettingsView` 里，这里只把菜单摆出来。
 *
 * 换库要先保存当前库、再断开会话、最后回解锁页 —— 这套判断不该有第二份实现。
 * 底栏与设置页共用同一份，区别只是入口位置。
 */
btnVault.addEventListener('click', () => {
    const rect = btnVault.getBoundingClientRect();
    const items: MenuItem[] = [
        { label: '打开其他库…', onPick: () => settingsView?.openOtherVault() },
        { label: '在访达中显示', onPick: () => settingsView?.revealVault() }
    ];
    // 「用默认位置」只在真的指向了别处时才出现，否则它点下去没有任何变化
    if (store.status().configured) {
        items.push({ label: '用默认位置', onPick: () => settingsView?.useDefaultVault() });
    }
    // 底栏贴着窗口下沿，菜单往上开：按每项 30px 估个高度，把底边留在按钮上方 6px。
    // 估不准也不打紧 —— contextMenu 自己会把越界的坐标收回视口内。
    contextMenu({ x: rect.left, y: rect.top - 6 - (items.length * 30 + 12) }, items);
});

// ------------------------------------------------------------------ 保存状态

let lastSaveError: string | null = null;

store.subscribe((status) => {
    saveStateEl.className = 'save-state';
    // 解锁 / 建库 / 换库都会经过这个唯一的漏斗，库名挂在这里就不会漏更新
    refreshVaultLabel();

    if (!store.isOpen()) {
        saveStateEl.textContent = '';
        lastSaveError = null;
        return;
    }

    switch (status.saveState) {
        case 'saving':
            saveStateEl.textContent = '保存中…';
            saveStateEl.classList.add('is-busy');
            break;
        case 'error':
            saveStateEl.textContent = '保存失败，改动暂存在内存里';
            saveStateEl.classList.add('is-error');
            if (status.error && status.error !== lastSaveError) {
                lastSaveError = status.error;
                toast(`保存失败：${status.error}`, 3200);
            }
            break;
        case 'saved': {
            lastSaveError = null;
            saveStateEl.textContent = status.savedAt ? `已保存 ${clockTime(status.savedAt)}` : '已保存';
            break;
        }
        default:
            saveStateEl.textContent = '';
            break;
    }
});

// ------------------------------------------------------------------ 快捷键

/** 菜单栏「设置…」（⌘,）。守卫与快捷键共用这一个。 */
function shellToggleSettings(): void {
    if (viewApp.classList.contains('is-active')) setSettingsOpen(!settingsOpen);
}

/** 菜单栏「锁定」（⌘L）。 */
function shellLock(): void {
    if (store.isOpen()) void lock();
}

document.addEventListener('keydown', (ev) => {
    // 输入法正在选词：这一下回车 / Esc 属于打字过程，不是这里的任何一个快捷键。
    // 排在最前是因为下面有一条「Esc 清空搜索」—— 用户在搜索框里打中文想取消候选词，
    // 会把已经打了一半的搜索词清掉。
    if (isComposing(ev)) return;

    if (editor.isOpen) return; // 弹窗自己处理 Esc 与 ⌘S

    const meta = ev.metaKey || ev.ctrlKey;

    // ⌘, 与 ⌘L 不在这里判：它们写在应用菜单里（src-tauri/src/menu.rs）。
    // macOS 上菜单的 key equivalent 先于网页拿到按键，两边都写会一次按键
    // 触发两下，而这两个动作都是开关语义 —— 触发两下等于按了没反应。
    if (meta && ev.key === 'n') {
        ev.preventDefault();
        if (viewApp.classList.contains('is-active') && !settingsOpen) editor.openCreate();
        return;
    }
    if (meta && ev.key === 'f') {
        ev.preventDefault();
        if (viewApp.classList.contains('is-active') && !settingsOpen) vault.focusSearch();
        return;
    }
    // ⌘C 复制详情栏的当前字段（PRD §7.2）。这一条与上面几条不同 ——
    // 「编辑」菜单里本来就有一个系统提供的 ⌘C（负责复制选中的文字），而 macOS 的
    // 菜单 key equivalent 会先于网页拿到按键。所以这里**不强行拦**：用户自己选了
    // 文字就直接返回，让系统那份去复制；只有「什么都没选」时才由我们接手，
    // 把密码或当前字段放进剪贴板。
    if (meta && !ev.shiftKey && !ev.altKey && ev.key === 'c') {
        if (!viewApp.classList.contains('is-active') || settingsOpen) return;

        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && String(sel).trim()) return;
        if (document.activeElement instanceof HTMLInputElement) return;
        if (document.activeElement instanceof HTMLTextAreaElement) return;

        if (vault.copyCurrentField() !== null) ev.preventDefault();
        return;
    }
    if (ev.key === 'Escape' && viewApp.classList.contains('is-active')) {
        if (settingsOpen) setSettingsOpen(false);
        else vault.clearSearch();
    }
});

// ------------------------------------------------------------------ 启动自检

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function nextFrame(): Promise<number> {
    return new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now())));
    });
}

function costOf(fn: () => void): number {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
}

const round = (n: number): number => Math.round(n * 100) / 100;

/** 截图演示态用的分类配色。取值是 `DOT_COLORS` 的下标，不写十六进制 ——
 *  色板只有一个来源，这里再抄一份就会在色板调整之后与门禁悄悄分叉。
 *  下标越界时 `setGroupColor()` 会抛「不在可选色板里」，是响的，不会静默无色。 */
/** 演示态里每个分类配一个色。**有几个分类就要配几个** —— 漏掉的那个退回
 *  `groupColor()` 的哈希色，撞上已配好的色只是概率问题：第一版漏了「云服务」，
 *  它的自动色恰好也是蓝，侧栏里两个分类看上去一样，像功能出了问题。 */
const DEMO_CAT_COLORS: Array<[string, number]> = [
    ['服务器', 7], // 蓝
    ['数据库', 8], // 紫
    ['办公', 4], // 绿
    ['未分类', 2], // 黄
    ['云服务', 6] // 青
];

/** 截图演示态：给几个分类配上自定义颜色，并给一个与名称序不同的顺序。
 *
 *  走 `store.session()` 直接改，**不用 `store.setGroupColor()`** —— 后者会
 *  `touch()` 进而写盘，而截图用的是 `/Users/Shared` 下那个演示库：
 *  写进去之后下一轮 03 / 04 两张图就会拍到与这一轮不同的颜色，
 *  同一份脚本两次跑出来的图不一致。会话是公开的，绕开写盘正是这里要的。 */
function demoCategories(): void {
    const api = store.session();
    const groups = api.groups();

    for (const [name, index] of DEMO_CAT_COLORS) {
        if (groups.includes(name)) api.setGroupColor(name, DOT_COLORS[index]);
    }

    // 顺序必须是当前分类集合的一个排列，少一个多一个都会让 `reorderGroups()` 抛错
    const first = DEMO_CAT_COLORS.map(([name]) => name).filter((n) => groups.includes(n));
    api.reorderGroups([...first, ...groups.filter((g) => !first.includes(g))]);

    vault.refresh();
}

/** 自检会来回切视图，跑完要还原到「这一次启动本该停在的地方」。
 *
 *  `settings` 标记落在这里。曾经漏了这一步：自检末尾无条件收起面板，
 *  于是 `VAULT_DEV=unlocked,settings` 截出来的始终是主视图 ——
 *  `04-settings.png` 从 M1 起就不是设置页，直到 M2 收尾比对两张截图才发现。 */
function restoreInitialState(flags: string[]): void {
    if (!store.isOpen()) {
        paintLock();
        return;
    }
    paintApp();

    // `editor` 直接打开第一条目的编辑弹窗。改动落在弹窗里的时候，主视图截图
    // 看不见它 —— 分类字段从联想输入框换成下拉，就是这么一处。
    if (flags.includes('editor')) {
        const sample = store.entries()[0];
        if (sample) editor.openEdit(sample);
    }

    // `cats` 换成自定义颜色 + 自定义顺序。分类圆点的颜色与排序都落在侧栏，
    // 不换这一下的话主视图截图里看到的永远是自动色与名称序。
    if (flags.includes('cats')) demoCategories();

    // `palette` 打开分类面板。它盖在窗口中央，主视图截图同样看不见 ——
    // 与 `editor` 标记同一个道理。标记名沿用 `palette`：面板的前身是只选颜色的
    // 取色面板，扩成「名称 + 颜色」之后名字没跟着改，图名也是同一个词。
    if (flags.includes('palette')) {
        const first = store.groups()[0];
        if (first) void editGroup(first);
    }

    // `focus` 给列表第一行挂上焦点环。这张图要证两件事：环画得出来、
    // 而且没被列表这个滚动容器裁掉 —— 第一行贴着 `overflow` 的上边界，
    // 是整屏里最容易被切的位置，所以要拍它而不是中间某一行。
    //
    // **这里不真的去聚焦。** 环靠 `:focus-visible` 画，而 WKWebView 在窗口不是
    // 当前应用时根本不匹配它：`document.activeElement` 明确落在行上、
    // `getComputedStyle` 读出来的 outline 也是 2px solid 强调色，环就是不画。
    // 截图脚本从 shell 里起进程，macOS 不把前台交给它；应用自己
    // `NSApplication.activate()` 也要不到（试过，返回 Ok 而 `hasFocus` 仍是 false）。
    // 而每跑一次截图就把窗口抢到人前面，正在干活的人会被挤下去 —— 为一张图付这个
    // 代价不对等，那条路已经删掉了（见 src-tauri/src/main.rs 里那段说明）。
    //
    // 所以改挂 `[data-ring]`：它与 `:focus-visible` 写在 base.css 的同一份声明块里，
    // 环的规格还是那一份，不新增第二处。**代价要说明白** ——
    // 这张图不再证明「键盘走到这一行会出环」，那件事只能由人按一次 Tab 看：
    // `:focus-visible` 认真实输入事件，合成键盘事件骗不过它。
    //
    // **不能只挂一次。** 列表在启动之后还会再重绘一次，重绘换掉那个元素。
    // 所以挂个 observer：每有一次重绘，就在下一帧重新挂上。重绘停了它也就不再触发。
    //
    // ⚠️ 别拿「这张图与 03-vault 哈希不同」当环画出来的证据。两张图差的是侧栏材质
    // （窗口活跃态不同，`followsWindowActiveState` 会变浅变深），列表那一列可以
    // 逐字节相同而哈希照样不同。判据是 `shots.sh` 收尾那条：数列表列的差异像素。
    if (flags.includes('focus')) {
        const listEl = document.querySelector<HTMLElement>('#list');
        const put = (): void => {
            const row = listEl?.querySelector<HTMLElement>('.item');
            if (row) row.setAttribute('data-ring', '');
        };
        put();
        if (listEl) {
            new MutationObserver(() => requestAnimationFrame(put))
                .observe(listEl, { childList: true, subtree: true });
        }
    }

    const settingsFlag = flags.find((f) => f === 'settings' || f.startsWith('settings:'));
    setSettingsOpen(Boolean(settingsFlag));

    // `settings:data` 额外把面板滚到「数据」那一组。设置面板比窗口高，
    // 主库位置与导出在最下面，不滚的话截图里看不到。
    // 延迟一帧再滚：面板刚由 display:none 变成可见，这一帧的布局还是旧的。
    //
    // 取值是组内某个元素的 id，而不是「第几个 .settings-group」——
    // 在中间插一组也不会静默滚错地方。
    if (settingsFlag === 'settings:data') {
        requestAnimationFrame(() => {
            must('#set-vault-path').closest('.settings-group')?.scrollIntoView({ block: 'start' });
        });
    }
}

async function selfCheck(
    flags: string[],
    engineInfo: EngineInfo | null,
    selfTestMs: number | null
): Promise<void> {
    const report: Record<string, unknown> = {
        environment: IN_TAURI ? 'Tauri（真实 WKWebView）' : '普通浏览器',
        devFlags: flags,
        engine: engineInfo,
        wasmSelfTestMs: selfTestMs === null ? null : round(selfTestMs),
        argon2Injected: isArgon2Installed()
    };

    report.firstPaintMs = round(await nextFrame());

    // 视图切换成本。两次 paint 在同一个同步块里，中间不会发生绘制，
    // 所以这段测量不会让用户看到界面闪一下。
    const toApp = costOf(paintApp);
    const toSettings = costOf(() => setSettingsOpen(true));
    const backToVault = costOf(() => setSettingsOpen(false));
    const toLock = costOf(paintLock);

    report.viewSwitch = {
        '解锁 → 应用壳': round(toApp),
        '保险箱 → 设置': round(toSettings),
        '设置 → 保险箱': round(backToVault),
        '应用壳 → 解锁': round(toLock)
    };

    // 外壳几何。设置面板是唯一内容比窗口高的面板，所以只有它能暴露这一类问题。
    //
    // 判据在本轮改过一次。原先量的是 `#pane-settings.clientHeight <= 视口高` ——
    // 那时面板是 `main.stage` 的 grid 列项，`min-height: auto` 被内容撑开之后
    // 面板可视高会超过视口，这条能咬。现在面板改成绝对定位铺满 `#view-app`
    // （见 views.css），它撑不开任何东西，`clientHeight` 恒等于视口高 ——
    // 留着就是一条不咬的断言。所以换成本轮真正要锁的那件事：**它盖住的是整个窗口**。
    // 判据取左右边界：面板退回 `main.stage` 那一列时，左边界会变成 248（侧栏宽）。
    // 「面板可滚」保留 —— 内容 1100 多、视口 720，滚不动就是坏。
    //
    // 出口量的是**设置面板自己的**关闭按钮。原先量侧栏底栏那个齿轮，现在面板把侧栏
    // 盖住了，「它在视口内」不再说明任何事。
    //
    // 先回到应用壳再量：上面那几行为了让视图切换跑在同一帧里，最后停在了解锁页，
    // 此时 #view-app 是 display:none —— 量什么都是 0，会假通过。
    paintApp();
    setSettingsOpen(true);
    const paneSettings = must('#pane-settings');
    const panelRect = paneSettings.getBoundingClientRect();
    const exitRect = must('#set-close').getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    report.shellGeometry = {
        视口宽: round(vw),
        视口高: round(vh),
        面板可视高: paneSettings.clientHeight,
        面板内容高: paneSettings.scrollHeight,
        面板可滚: paneSettings.scrollHeight > paneSettings.clientHeight,
        面板左边界: round(panelRect.left),
        面板右边界: round(panelRect.right),
        面板覆盖整窗: Math.abs(panelRect.left) <= 0.5 && Math.abs(panelRect.right - vw) <= 0.5,
        出口按钮底边: round(exitRect.bottom),
        出口按钮在视口内: exitRect.bottom <= vh + 0.5 && exitRect.top >= 0
    };

    // 界面入口的可达性。两处都曾经少一个入口：「设置」的出口只有侧栏底栏那个
    // 开关语义的按钮（面板自己没有），「新建分类」只活在右键菜单里 —— 而它下面
    // 的「新建条目」反而是主按钮，容器的创建比内容的创建更难发现。
    //
    // 判据分两段，缺一不可：
    //   ① 尺寸 —— 挡住 `display: none`（`clientRects` 为空）
    //   ② 命中测试 —— 挡住「占着位置但点不到」（祖先 `pointer-events: none`、
    //      被别的东西盖住）。只量尺寸的话「被设置面板盖住的分类」会被判成可用，
    //      而它实际上够不着。
    // 注意别用 `el.click()` 去验这件事：程序化点击天生绕过命中测试，两个档它都点亮。
    const seen = (sel: string): boolean => {
        const el = document.querySelector<HTMLElement>(sel);
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (el.getClientRects().length === 0 || r.width <= 0 || r.height <= 0) return false;
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!hit && el.contains(hit);
    };

    setSettingsOpen(true);
    const closeSeen = seen('#set-close');
    // 分类在设置打开时够不着 —— 设置面板铺满整窗，把它盖在下面（原先靠
    // `.is-muted` 主动灰掉 + `pointer-events: none`，那个类已经删了）。
    // 这条既是产品行为断言，也是 `seen()` 的对照 —— 少了它，上面那个命中测试
    // 是不是真在量东西就没人知道（尺寸判据在两种状态下都返回 true）。
    const catsMuted = !seen('#cats-new');

    // KDF 那一栏（F7.6）。判据成对取，缺一条都不成立：
    //   ① 拨到**与当前档位不同**的一项 → 「应用」可点
    //   ② 拨回当前档位那一项 → 不可点
    // 只留 ① 的话，一个恒可点的实现也绿；只留 ② 则反过来。另外单独读一次
    // 「当前档位」那行 —— 挡住「那行永远停在占位文案」的实现（改完代码忘了调
    // `syncKdf()` 时就是这个样子，界面上什么都不缺）。
    const kdfSel = document.querySelector<HTMLSelectElement>('#set-kdf');
    const kdfBtn = document.querySelector<HTMLButtonElement>('#set-kdf-apply');
    const kdfCurText = document.querySelector<HTMLElement>('#set-kdf-current')?.textContent ?? '';
    const curPreset = store.isOpen() ? store.session().header().preset : null;
    const pokeKdf = (value: string): boolean => {
        kdfSel!.value = value;
        kdfSel!.dispatchEvent(new Event('change', { bubbles: true }));
        return !kdfBtn!.disabled;
    };
    // 拨回来那一次顺带把界面恢复原状 —— 读数不该留下副作用。
    const kdfApplies = curPreset ? pokeKdf(curPreset === '安全' ? '流畅' : '安全') : false;
    const kdfIdle = curPreset ? !pokeKdf(curPreset) : false;

    document.querySelector<HTMLElement>('#set-close')?.click();
    const exitWorks = !settingsOpen && paneVault.classList.contains('is-active');
    const addCat = document.querySelector<HTMLElement>('#cats-new');
    report.uiAffordances = {
        设置页有可见出口: closeSeen,
        点出口回到保险箱: exitWorks,
        分类标题行有新建入口: seen('#cats-new'),
        新建入口在分类标题行内: !!addCat?.closest('.cats-label'),
        设置打开时分类不可点: catsMuted,
        KDF当前档位那行报出实际档位: !!curPreset && kdfCurText.includes(curPreset),
        拨到别的档时应用可点: kdfApplies,
        拨回当前档位时应用不可点: kdfIdle
    };

    // 编辑弹窗里分类字段的选项。这个字段曾经是 `<input list="cat-list">` ——
    // 编辑已有条目时框里带着当前分类名，而浏览器的下拉是**按这个值过滤**的，
    // 于是只剩它自己一项：想换分类得先把文字删干净。这不是「显示错了」，
    // 是「点开只有一项」，所以截图看着永远正常，只能靠读数判。
    //
    // 同时锁住另一件事：当前分类必须在选项里。库里的条目不保证属于某个顶层分组
    // （直接挂根组的、导入库的二级分组），`groups()` 只列顶层 —— 漏掉当前值，
    // `<select>` 会退到第一个选项，用户什么都没改、点保存就把条目挪走了。见 `categoryOptions`。
    const sample = store.isOpen() ? store.entries()[0] : undefined;
    let editorCategory: Record<string, unknown> | null = null;
    if (sample) {
        editor.openEdit(sample);
        const sel = must<HTMLSelectElement>('#f-cat');
        const values = [...sel.options].map((o) => o.value);
        editorCategory = {
            分类数: store.groups().length,
            选项数: values.length,
            条目当前分类: sample.group,
            下拉选中的值: sel.value,
            当前值被选中: sel.value === sample.group,
            当前值在选项里: values.includes(sample.group),
            末项是新建分类: values[values.length - 1] === NEW_CATEGORY
        };
        editor.close();

        // 「＋ 新建分类…」那条路径要叠一层分类面板，而它建的遮罩同样是
        // `.mask`、同样挂在 `document` 上听按键，并且**不拦事件、只收掉自己**。
        // 少了 `isTopmost()` 这道判断，在它上面按 Esc 会连编辑器一起关掉。
        //
        // 两条一起量：只量前一条的话，一个恒返回 false 的守卫也能让它绿；
        // 只量后一条的话，一个恒返回 true 的守卫也能让它绿。
        const pressEsc = (): void => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        };
        const probe = document.createElement('div');
        probe.className = 'mask';
        document.body.append(probe);
        editor.openEdit(sample);
        pressEsc();
        editorCategory['上层有弹窗时 Esc 不关编辑器'] = editor.isOpen;
        probe.remove();
        pressEsc();
        editorCategory['没有上层时 Esc 照常关掉编辑器'] = !editor.isOpen;
    }
    report.editorCategory = editorCategory;

    // 建库卡片的几何。字段最多的一张卡片，也是唯一有可能高过窗口的那张。
    //
    // 高过窗口本身不是缺陷 —— `#view-unlock` 用 flex + `justify-content: safe center`
    // + `overflow-y: auto` 兜住了这件事（见 base.css 的注释）。但「兜住了」和
    // 「碰巧没超」是两回事，量出来才算数：上一次「设置页关不掉」就是布局默认值咬人，
    // 而截图看着正常。
    //
    // 先切到解锁视图再量。为测视图切换耗时，上面最后一步停在了解锁页之前的状态，
    // 那会儿 `#view-unlock` 是 `display: none` —— 量什么都是 0，判据会假通过。
    paintLock();
    await unlock.showCreateCard(true);

    const unlockPane = must('#view-unlock');
    const createCard = must('#lock-create');
    const createRect = createCard.getBoundingClientRect();
    const paneRect = unlockPane.getBoundingClientRect();
    report.unlockGeometry = {
        视口高: round(vh),
        容器可视高: unlockPane.clientHeight,
        容器内容高: unlockPane.scrollHeight,
        容器可滚: unlockPane.scrollHeight > unlockPane.clientHeight,
        卡片高: Math.round(createRect.height),
        卡片顶边: Math.round(createRect.top),
        卡片底边: Math.round(createRect.bottom),
        顶边未越界: createRect.top >= paneRect.top - 0.5,
        底边在容器内: createRect.bottom <= paneRect.bottom + 0.5
    };

    // 卡片高度的分块账。建库卡片是唯一会顶到窗口边界的表单，加了字段之后
    // 「高了多少、高在哪一块」直接读这里，不要按截图估 —— 652 还是 768 看着都像
    // 「大概能装下」。同一次启动里那条「建库卡片在默认窗口里完整可见」的断言
    // 只告诉你红没红，这张表告诉你该砍哪一块。
    report.unlockParts = {
        卡片内边距: getComputedStyle(createCard).padding,
        子块: Array.from(createCard.children).map((el) => {
            const cls = el.className ? `.${String(el.className).split(' ')[0]}` : '';
            const id = el.id ? `#${el.id}` : '';
            return `${el.tagName.toLowerCase()}${id}${cls} = ${Math.round(el.getBoundingClientRect().height)}`;
        })
    };

    // 还原：prepare() 按库在不在重新分流，也就是这一步本该停的状态
    await unlock.prepare();

    const status = store.status();
    report.vault = {
        文件: status.path,
        存在: status.exists,
        字节: status.size,
        位置来源: status.configured ? '配置（打开其他库）' : '默认位置',
        条目: store.entries().length,
        分类: store.groups().length,
        回收站: store.trashCount(),
        解锁耗时: store.lastUnlockMs,
        建库耗时: store.lastCreateMs,
        文件头: store.isOpen() ? store.session().header() : null,
        数据来源: IN_TAURI ? '磁盘' : '内存预览'
    };

    // 测完还原到该有的初始状态
    restoreInitialState(flags);

    report.totalMs = round(performance.now() - T_START);
    report.checkedAt = new Date().toISOString();

    await reportBoot(JSON.stringify(report, null, 2));
}

// ------------------------------------------------------------------ 开发直通

/** `VAULT_DEV=unlocked`：跳过解锁页。
 *  给了 VAULT_DEV_PASSWORD 就走真实的读文件 + 解密；没有就退到内存数据，
 *  后者只为「不装宿主也能看界面」存在。 */
async function enterDevUnlocked(flags: string[]): Promise<void> {
    const password = await devPassword();

    if (IN_TAURI && password) {
        try {
            const info = await store.probe();
            if (info.exists) {
                await store.open(password);
            } else {
                await store.create({
                    password,
                    name: 'Dreamanual 密码管理',
                    groups: flags.includes('seed') ? DEMO_GROUPS : undefined,
                    // 落点显式给默认位置。开发直通也要走跟界面同一条代码路径，
                    // 传 undefined 会让 create 抛错，等于把这条分支测成另一回事。
                    path: await vaultDefaultPath()
                });
                if (flags.includes('seed')) {
                    for (const item of DEMO_ENTRIES) store.addEntry(item);
                    await store.save();
                }
            }
            enterApp();
            return;
        } catch (err) {
            reportError(`开发直通解锁失败，退到内存会话：${errorText(err)}`);
        }
    }

    store.attach(new MemorySession(), '内存预览（数据不落盘）');
    enterApp();
}

// ------------------------------------------------------------------ 启动

void (async () => {
    const flags = await devFlags();

    // 引擎探针与 Argon2 注入必须早于任何一次建库 / 解锁。
    // 这条探针是「kdbxweb 有没有被正确加载」唯一能在启动时暴露问题的检查。
    let engineInfo: EngineInfo | null = null;
    let selfTestMs: number | null = null;
    try {
        engineInfo = describeEngine();
        selfTestMs = await argon2SelfTest();
        installArgon2();
    } catch (err) {
        reportError(`引擎自检失败：${errorText(err)}`);
    }

    // 自动锁定的落地端。订在验收分支之前 —— 验收要能测到
    // 「Rust 判定该锁了」这条事件真的到得了前端。
    void listenLock((reason) => void onAutoLock(reason));

    // 应用菜单栏那两条（含各自的 ⌘, / ⌘L）。动作名由 Rust 侧筛过一遍，
    // 认不出来的菜单 id 到不了这里（见 src-tauri/src/menu.rs）。
    void listenMenu((action) => {
        if (action === 'settings') shellToggleSettings();
        else if (action === 'lock') shellLock();
    });

    if (flags.includes('accept')) {
        const password = await devPassword();
        if (!password) {
            await reportBoot(JSON.stringify({ error: 'accept 模式需要设置 VAULT_DEV_PASSWORD' }, null, 2));
            return;
        }

        // 验收脚本自己出错时也要有输出。没有这层兜底的话，它一抛异常就静默停在那里，
        // 应用既不退出也不报错 —— 外面只能看到看门狗把进程杀掉，日志里最后一行的
        // 「页面加载事件: Finished」看着一切正常，根因完全看不出来。
        let items: Awaited<ReturnType<typeof runAcceptance>>;
        try {
            items = await runAcceptance(store, password, vault, enterApp);
        } catch (err) {
            // 先走 report_error 这条通道：它每次调用都有回显，能确认消息真的到了宿主。
            // report_boot 只在最后那次调用里才有输出，用它报错时「没输出」既可能是
            // 没走到这里，也可能是走到了但消息没出去 —— 分不清。
            await reportErrorSync(`验收脚本抛异常：${errorText(err)}`);
            await reportBoot(JSON.stringify({ error: `验收脚本抛异常：${errorText(err)}` }, null, 2));
            return;
        }

        const passed = items.filter((i) => i.ok).length;
        await reportBoot(
            JSON.stringify(
                {
                    模式: 'M3 自动化验收',
                    环境: IN_TAURI ? 'Tauri（真实 WKWebView）' : '普通浏览器',
                    通过: `${passed} / ${items.length}`,
                    全部通过: passed === items.length,
                    items
                },
                null,
                2
            )
        );
        return;
    }

    if (flags.includes('unlocked')) {
        await enterDevUnlocked(flags);
    } else {
        paintLock();
        await unlock.prepare();
    }

    await selfCheck(flags, engineInfo, selfTestMs);
})();
