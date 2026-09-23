/* 图标。全部是 24×24 描边 SVG，与原型同源。
   详情栏与列表是动态渲染的，所以图标要以字符串形式拼进模板。 */

const wrap = (path: string, size: number, stroke = 2): string =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;

export const icons = {
    copy: (size = 15) =>
        wrap('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>', size),

    check: (size = 15) => wrap('<path d="m5 12 5 5L20 7"/>', size, 2.4),

    eye: (size = 15) =>
        wrap('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>', size),

    eyeOff: (size = 15) =>
        wrap('<path d="M10.6 5.2A9.9 9.9 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.3 4.1"/><path d="M6.2 6.2A17 17 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 4.2-.9"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="m2 2 20 20"/>', size),

    refresh: (size = 15) =>
        wrap('<path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>', size),

    edit: (size = 15) =>
        wrap('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>', size),

    trash: (size = 15) =>
        wrap('<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6"/><path d="M10 11v6M14 11v6"/>', size),

    external: (size = 15) =>
        wrap('<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>', size),

    lock: (size = 15) =>
        wrap('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>', size, 2.2),

    search: (size = 15) =>
        wrap('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/>', size, 2.2)
} as const;

export type IconName = keyof typeof icons;
