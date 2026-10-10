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
    plus: (size = 15) => wrap('plus', size),
    external: (size = 15) => wrap('external-link', size),

    // Toast 的语义图标。默认 16 —— 第八节「Toast」定的就是 ic-16，
    // 三处调用不在别处复用，默认值直接给规格值，省掉每次写尺寸。
    ok: (size = 16) => wrap('circle-check', size),
    err: (size = 16) => wrap('circle-x', size),
    info: (size = 16) => wrap('info', size),

    // 保存状态位（底栏库名右侧，main.ts 的 store 订阅注入）。默认 14 ——
    // 与同排两个 icon-btn 同尺寸。三态：saving→save / saved→save-check /
    // error→save-off，形状 + 颜色双通道表达状态（CSS 侧管颜色）。
    save: (size = 14) => wrap('save', size),
    saveCheck: (size = 14) => wrap('save-check', size),
    saveOff: (size = 14) => wrap('save-off', size)
} as const;
