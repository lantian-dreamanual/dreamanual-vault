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

/** 26 个分类色。同一分类永远拿到同一个颜色，不随条目增减变化。 */
const DOT_COLORS = [
    '#2563eb', '#0891b2', '#0f9d63', '#ca8a04', '#dc2626',
    '#7c3aed', '#db2777', '#0d9488', '#ea580c', '#4f46e5'
];

export function groupColor(group: string): string {
    let hash = 0;
    for (let i = 0; i < group.length; i += 1) hash = (hash * 31 + group.charCodeAt(i)) >>> 0;
    return DOT_COLORS[hash % DOT_COLORS.length]!;
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
