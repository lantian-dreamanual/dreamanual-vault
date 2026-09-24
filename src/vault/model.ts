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

/** 头像块里的字符：取标题首字母，中文取第一个字 */
export function entryInitial(entry: VaultEntry): string {
    const t = entry.title.trim();
    return t ? t.slice(0, 1).toUpperCase() : '#';
}

/**
 * 分类圆点的可选色：Tailwind v4 的 400 档，按色相升序取 10 个。
 *
 * 为什么是 400 档：圆点只出现在侧栏分类行，而侧栏底色是 macOS 毛玻璃、不是令牌
 * （实测中位数见 `spike/contrast.mjs` 的 `SIDER_MATERIAL`）。500 档的暗端压在这个底上
 * 会跌到 3:1 以下（violet-500 2.70、blue-500 3.15），400 档最差的一格是 violet-400 4.16:1。
 * 逐格读数与门禁在同一个脚本里（门槛 4.0:1，比 WCAG 非文本的 3:1 留一档）。
 *
 * 数组顺序 = 颜色面板的展示顺序 = `groupColor()` 的取模顺序。
 */
export const DOT_COLORS = [
    '#fb64b6', '#ff8904', '#fdc700', '#9ae600', '#05df72',
    '#00d5be', '#00d3f2', '#51a2ff', '#a684ff', '#ed6aff'
] as const;

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
