/* 图标。全部取自 lucide v1.47.0（ISC），路径数据只存在于 index.html 的 <defs> 里，
   这里只按尺寸拼一个引用 —— 形状要在哪儿改，就改 index.html 那份 symbol。
   逐字一致性由 spike/lucide-baseline.json 与 spike/icons.mjs 守。

   之前这里各抄了一份路径，与 index.html 里的静态标记重复：lock / search / x /
   eye / refresh-cw / external-link 六个两边都有，改一次要改两处，且两处很容易
   对不上。现在同一语义只有一份定义。

   原来还有 check / external / lock / search 四个从没被调用过，已删。 */

/** 描边实粗细统一 1.5 CSS px。
    24 网格上 1 单位 = size/24 个 CSS 像素，所以 stroke-width = 1.5 × 24 / size = 36 / size。
    取 1.5 而不是官方的 2，是因为 1.5 CSS px 在 2× 屏上正好是 3 个设备像素（整数）——
    2 换算出 2.5 会落在半像素上，抗锯齿把描边糊开。
    12→3 · 13→2.769 · 14→2.571 · 15→2.4 · 16→2.25 */
const strokeFor = (size: number): string => String(Math.round((36 / size) * 1000) / 1000);

const wrap = (name: string, size: number): string =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" stroke-width="${strokeFor(size)}" ` +
    `aria-hidden="true"><use href="#ic-${name}"/></svg>`;

export const icons = {
    copy: (size = 15) => wrap('copy', size),
    eye: (size = 15) => wrap('eye', size),
    eyeOff: (size = 15) => wrap('eye-off', size),
    refresh: (size = 15) => wrap('refresh-cw', size),
    edit: (size = 15) => wrap('pencil', size),
    trash: (size = 15) => wrap('trash-2', size),
    plus: (size = 15) => wrap('plus', size)
} as const;
