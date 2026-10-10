/* 领域模型。
 *
 * 这一层把「KDBX 的 Group / Entry」与「界面要用的形状」隔开，好处是
 * 将来换加密库时界面不用跟着动（PRD §8.2 的架构约束）。
 *
 * M1 阶段数据来自 mock，形状先定下来。 */

/** KDBX 里条目必须属于某个 Group，没有分类的条目统一挂在这个分组下 */
export const UNCATEGORIZED = '未分类';

/** 与 KDBX 的 5 个标准字段一一对应，顺序即详情页的展示顺序 */
export interface VaultEntry {
    id: string;
    title: string;
    userName: string;
    password: string;
    url: string;
    notes: string;
    group: string;
    updatedAt: string;
}

export interface VaultData {
    /** 库名，写在 KDBX 的默认分组上 */
    name: string;
    groups: string[];
    entries: VaultEntry[];
}

/** 列表里显示的次要文字：账号优先，没有就退到网址，再没有就用备注首行 */
export function entrySubtitle(entry: VaultEntry): string {
    if (entry.userName.trim()) return entry.userName.trim();
    if (entry.url.trim()) return entry.url.trim();
    const firstLine = entry.notes.split('\n').find((line) => line.trim());
    return firstLine ? firstLine.trim() : '';
}

/** 把条目网址的存值整理成可打开的 URL。
 *
 *  裸域是常态（`vpn.example.com`、内网 IP），没写协议的一律补 `https://`；
 *  显式写了任意协议的尊重原样 —— 存 `ftp://…` 的条目原样交给 Rust 终审，
 *  在那里被拒并给用户一条失败提示，而不是在界面里被悄悄改写成 https。
 *  纯函数：验收里直接调它，不触发真实打开。 */
export function normalizeEntryUrl(raw: string): string {
    const value = raw.trim();
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
}

/** 头像块里的字符：取标题首字母，中文取第一个字 */
export function entryInitial(entry: VaultEntry): string {
    const t = entry.title.trim();
    return t ? t.slice(0, 1).toUpperCase() : '#';
}

/**
 * 分类色的可选值：Tailwind v4 的 400 档，按色相升序取 10 个。
 *
 * 2026-10-09 从 300 档加深一档（用户反馈「这套分类颜色太浅」）。现在一个色服务
 * 三个地方，约束取最严的那格：
 *
 * ① 详情分类 tag 的**文字**（`.tag-cat`，压 `--panel-2`）—— 文字要 4.5:1，
 *    最差 violet-400 5.5:1，全组达标；这是 300 档做不到的（violet-300 只有
 *    4.2:1），加深的主要动因。
 * ② 色板色格（`.palette-sw`，24px 大色块压弹窗 `--panel-2`）—— 非文本 3:1，
 *    最差格同①，余量大。
 * ③ 侧栏圆点（6px，压 `--panel-2` / 悬停 `--panel-3` / 选中 `--accent-soft`）
 *    —— 最差 violet-400 压悬停 3.8:1，门禁口径从自定的 4.0 回落到 WCAG 非文本
 *    3.0（spike/contrast.mjs 的 DOT_MIN）：分类在侧栏还有名称文字可读，圆点是
 *    辅助线索；且分类色在详情里以 tag 文字出现，那里的 4.5 由同一门禁单独把守。
 *
 * 数组顺序 = 颜色面板的展示顺序 = `groupColor()` 的取模顺序。
 */
export const DOT_COLORS = [
    '#f472b6', '#fb923c', '#facc15', '#a3e635', '#4ade80',
    '#2dd4bf', '#22d3ee', '#60a5fa', '#a78bfa', '#e879f9'
] as const;

/** 加深前（300 档）的色值 → 现值。库里存过旧色的分组读回来映射到新档，不退自动色。 */
const LEGACY_DOT_COLORS: Record<string, string> = {
    '#f9a8d4': '#f472b6', '#fdba74': '#fb923c', '#fde047': '#facc15',
    '#bef264': '#a3e635', '#86efac': '#4ade80', '#5eead4': '#2dd4bf',
    '#67e8f9': '#22d3ee', '#93c5fd': '#60a5fa', '#c4b5fd': '#a78bfa',
    '#f0abfc': '#e879f9'
};

/** 没设过自定义颜色时的退回色：按分类名哈希取一个固定值，不随条目增减变化。
 *
 *  只有 10 个色，分类多于 10 个就会撞色。右键菜单「编辑分类…」里的色板就是用来破这个
 *  循环的 —— 设过的分类走 KDBX 分组扩展位里存的那个色，不再走这里。 */
export function groupColor(group: string): string {
    let hash = 0;
    for (let i = 0; i < group.length; i += 1) hash = (hash * 31 + group.charCodeAt(i)) >>> 0;
    return DOT_COLORS[hash % DOT_COLORS.length]!;
}

/** 这个色是不是色板里的一个。
 *
 *  读回来的自定义色要过这一关：别的客户端（或手工编辑过的库）往同一个键里写了任意值时，
 *  退回自动色，而不是把圆点涂成深色底上看不见的颜色。 */
export function isDotColor(value: string): boolean {
    return (DOT_COLORS as readonly string[]).includes(value);
}

/** 存储值 → 现行色板的色。旧档（300）映射到加深后的新档；不在任何一版的色板里返回 null。
 *
 *  读取路径统一走这里：旧值不至于被打回自动色，任意垃圾值照样挡住。 */
export function normalizeDotColor(value: string): string | null {
    if ((DOT_COLORS as readonly string[]).includes(value)) return value;
    return LEGACY_DOT_COLORS[value.toLowerCase()] ?? null;
}

/** 全字段匹配。分类名参与匹配，这样搜「数据库」能带出整个分类。 */
export function matches(entry: VaultEntry, query: string): boolean {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [entry.title, entry.userName, entry.url, entry.notes, entry.group]
        .join('\n')
        .toLowerCase()
        .includes(q);
}

/** 名称排序：中文按拼音、英文按字母。显式指定 locale，
    因为不同 macOS 版本对裸 localeCompare 的默认行为不一致（PRD R5）。 */
const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });

export function compareEntries(a: VaultEntry, b: VaultEntry): number {
    return collator.compare(a.title, b.title);
}
