/* 展示层的格式化件。
 *
 * 抽出来的理由：库文件体积与路径在解锁卡片、设置页、侧栏状态三处都要显示，
 * 各写一份迟早会不一致 —— 同一个文件在三处显示成 `12.3 KB` / `12.34 KB` /
 * `0.01 MB`，用户会以为是三回事。 */

/** 文件体积。不足 1 KB 用字节 —— 「1.0 KB」会盖住「其实只写了 3 个字节」这种问题 */
export function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 路径只留最后两段。完整路径在设置页已经单独显示，
 *  提示语里再塞一遍全文会把别的内容挤掉。 */
export function shortPath(path: string): string {
    const parts = path.split('/').filter(Boolean);
    if (parts.length <= 2) return path;
    return `…/${parts.slice(-2).join('/')}`;
}

/** 24 小时制 HH:MM */
export function clockTime(at: number): string {
    const d = new Date(at);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 导出文件名：库名 + 日期。带日期是因为同一次备份会有多个导出件，
 *  重名会被系统加上「副本」后缀，那比带日期更难认。 */
export function exportFileName(vaultName: string, at = new Date()): string {
    const day = [
        at.getFullYear(),
        String(at.getMonth() + 1).padStart(2, '0'),
        String(at.getDate()).padStart(2, '0')
    ].join('-');
    // 文件名里不能出现的字符，去掉；去掉后为空就退回产品名
    const base = vaultName.replace(/[/\\:*?"<>|]/g, '').trim() || 'Dreamanual 密码管理';
    return `${base}-${day}.kdbx`;
}

/** 库的显示名：优先用库名，库名为空时退回文件名，两者都没有才是「—」。
 *
 *  `meta.name` 可能为空：别处造的库、或从 KeePass 导进来没写库名的库都这样。
 *  显示空白比显示文件名更糟，用户会不知道自己在看哪个库。侧栏底栏与设置页
 *  「库名」那行共用这一份口径。 */
export function vaultDisplayName(name: string, path: string): string {
    const trimmed = name.trim();
    if (trimmed) return trimmed;

    const file = path ? (path.split('/').pop() ?? '') : '';
    return file || '—';
}

/** RFC3339 时间戳 → 「今天 18:30」/「09-20 18:30」/「2025-09-20 18:30」。
 *
 *  「上次备份成功」那一格用它。日期不能省：那条信息的作用就是看它有多久没动，
 *  只显示时分的话，隔了三天的备份看起来和十分钟前的一样新。 */
export function friendlyTime(iso: string, now = new Date()): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;

    const hm = clockTime(d.getTime());
    const sameYear = d.getFullYear() === now.getFullYear();
    const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    if (
        sameYear &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate()
    ) {
        return `今天 ${hm}`;
    }
    return sameYear ? `${md} ${hm}` : `${d.getFullYear()}-${md} ${hm}`;
}
