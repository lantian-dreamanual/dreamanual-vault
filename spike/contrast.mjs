/**
 * 配色对比度门禁（PRD §7.3 / M4 C1）。
 *
 * 目的：把「配色里每一对前景/背景都达标」从一次性的目测变成会咬人的断言。
 * 令牌只有一个来源（生成物 src/styles/tokens.generated.css，由 design/build.mjs 产出；
 * 本地 tokens.css 只剩布局常量），所以这里**不硬编码任何颜色**——
 * 期望值全部从令牌文件解析出来后现算。改配色时忘了某一对，门禁就红。
 *
 * 分档（按 WCAG 2.1 AA）：
 *   text   4.5:1  正文与控件文字，含字号偏小的字段标签、按钮、tag
 *   large  3.0:1  大字（≥24px，或 ≥18.66px 且 ≥700 字重）
 *   ui     3.0:1  承载信息的图形：强度条填充、开关滑块
 *
 * 分类圆点**不在这三档里**，它另有一条断言（DOT_MIN，3.0:1 = WCAG 非文本档）。
 * 沿革：色板还是 300 档时曾自定 4.0:1（圆点 6px 又小又唯一）；2026-10-09 色板
 * 加深到 400 档（用户反馈「太浅」，主因是分类色要当详情 tag 的**文字**用，4.5:1
 * 只有 400 档做得到），最差格 violet-400 压悬停 panel-3 落在 3.8:1，圆点判据
 * 回落非文本 3:1 —— 侧栏里分类还有名称文字可读，且 tag 文字的 4.5 由下面
 * 「分类圆点」一节的第二条断言单独把守。逐格读数见那一节。
 *
 * `large` 这一档目前没有组合落在里头：解锁页标题 19px / 650 字重，按标准仍算
 * 正文（大字线要 700 字重或 24px）。留着是为了量到它时不用改分档表。
 *
 * 侧栏底色 2026-10-09 起落令牌（先 --bg、同日提亮到 --panel-2，沿革见
 * SIDER_MATERIAL 处的注释），侧栏文字组合全部进 PAIRS 表按令牌现算。
 * `.sider` 作用域重定义已删，`scope: 'sider'` 机制保留，将来再出现作用域
 * 覆盖时直接可用。
 *
 * 另有一条「色值不外泄」断言：令牌文件之外出现的十六进制色值必须逐条登记在
 * 下面的 ALLOWED_HEX 里并写明理由。散在规则与 TS 里的裸色值不跟着令牌走，
 * 换配色时就是一片读不清 —— 这条断言就是用来把它们逼出来的。
 * 扫描是朴素的，注释里提到的色值也算数；真需要在某处写下具体色值，
 * 把理由登记进 ALLOWED_HEX，别去给扫描器开洞。
 *
 * 用法：node spike/contrast.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const STYLES = path.join(ROOT, 'src', 'styles');
const SRC = path.join(ROOT, 'src');
const OUT_DIR = path.join(HERE, 'out');

const results = [];

function check(id, name, ok, detail = '') {
    results.push({ id, name, ok, detail });
    console.log(`  [${ok ? '通过' : '失败'}] ${id} ${name}${detail ? ` — ${detail}` : ''}`);
}

// ----------------------------------------------------------------- 颜色与对比度

/** `#rgb` / `#rrggbb` → [r, g, b]，各 0-255。解析不了返回 null。 */
function parseHex(text) {
    const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(text.trim());
    if (!m) return null;
    let h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

/** WCAG 相对亮度。sRGB 分量先线性化，再按 0.2126 / 0.7152 / 0.0722 加权。 */
function luminance([r, g, b]) {
    const lin = (v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** 对比度。与前后景顺序无关。 */
function ratio(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

// ----------------------------------------------------------------- 读令牌

/** 从一段 CSS 里取出所有 `--name: #hex;`。非 hex（rgba 阴影之类）不进表。 */
function varsIn(block) {
    const out = {};
    for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
        const hex = parseHex(m[2]);
        if (hex) out[m[1]] = hex;
    }
    return out;
}

/** 取 `selector { ... }` 的内容。找不到返回空串。 */
function blockOf(css, selector) {
    const at = css.indexOf(selector);
    if (at < 0) return '';
    const open = css.indexOf('{', at);
    const close = css.indexOf('}', open);
    return open < 0 || close < 0 ? '' : css.slice(open + 1, close);
}

/**
 * 配色令牌来自生成物 `tokens.generated.css`（design/build.mjs 产出，入库存一份）；
 * 本地 `tokens.css` 只剩布局常量。两份都读并合并成一张表 —— 将来本地若再加颜色
 * 令牌，这里不必改，门禁自动纳入。
 */
function readTokens() {
    const files = ['tokens.generated.css', 'tokens.css'];
    return Object.assign({}, ...files.map((f) =>
        varsIn(blockOf(fs.readFileSync(path.join(STYLES, f), 'utf8'), ':root {'))));
}

/** 侧栏作用域里被重定义的文字令牌。覆盖已删（2026-10-09），机制保留：
    再出现作用域覆盖时无需改这里。 */
function readSiderOverrides() {
    const css = fs.readFileSync(path.join(STYLES, 'views.css'), 'utf8');
    return varsIn(blockOf(css, '.sider {'));
}

// ----------------------------------------------------------------- 分类圆点色板

/** 色板门槛（WCAG 1.4.11 非文本）。沿革见文件头注释：300 档时代自定 4.0，
 *  2026-10-09 加深到 400 档后最差格 3.8:1，回落非文本 3.0。 */
const DOT_MIN = 3.0;

/**
 * 侧栏底色（圆点与焦点环的「侧栏底」取它）。
 *
 * 沿革：材质时代取实测量 #33383b（scripts/a3-probe.sh 那次的整屏截图侧栏中位数，
 * 同一次测量里详情面板的中位数正好等于 --panel，证明取样位置准）；2026-10-09
 * 材质退役，先铺 --bg；同日复看改口径「侧栏要比主内容区浅」，随 views.css 的
 * `.sider` 落 --panel-2。以后改侧栏底色，这里同步改。
 */
const SIDER_MATERIAL = '#262626';

/** 分类圆点色板：从 `src/vault/model.ts` 的 `DOT_COLORS` 现读，不在本脚本里再抄一份。 */
function readDotColors() {
    const ts = fs.readFileSync(path.join(SRC, 'vault', 'model.ts'), 'utf8');
    const at = ts.indexOf('export const DOT_COLORS');
    if (at < 0) return [];
    const open = ts.indexOf('[', at);
    const close = ts.indexOf(']', open);
    if (open < 0 || close < 0) return [];
    return [...ts.slice(open, close).matchAll(/#[0-9a-fA-F]{6}/g)].map((m) => m[0].toLowerCase());
}

// ----------------------------------------------------------------- 待检组合

/**
 * 一对 = 一处真实出现的前景/背景组合。
 *
 * `where` 不是注释而是判据的一部分：改配色的人要能顺着它找到受影响的地方；
 * 找不到对应规则的组合就该从表里删掉，而不是留着当装饰。
 *
 * `scope: 'sider'` 表示文字色取 `.sider` 作用域里的重定义值（令牌表里没有）。
 */
const PAIRS = [
    { fg: '--ink', bg: '--panel', tier: 'text', where: '条目标题、详情正文、右键菜单项、设置面板正文' },
    { fg: '--ink', bg: '--bg', tier: 'text', where: '解锁页落在 --bg 上的正文' },
    { fg: '--ink', bg: '--panel-2', tier: 'text', where: '.inp 输入框里的值（body 继承 --ink）' },
    { fg: '--ink-2', bg: '--panel', tier: 'text', where: '.block-v 备注、tag、.pw-col 标签' },
    { fg: '--ink-2', bg: '--panel-2', tier: 'text', scope: 'sider', where: '侧栏文字（2026-10-09 侧栏提亮，底色落 --panel-2）：.cat 名称、.cats-label、.vault-name' },
    { fg: '--ink-2', bg: '--panel-2', tier: 'text', where: '.btn-gho 按钮文字（落在主内容区 --panel 上的）、.tag「更新于」标签（2026-10-09 徽章改版同步后底 panel-2）' },
    { fg: '--ink-2', bg: '--panel-3', tier: 'text', where: '.ava 的文字、以及卡片抬 panel-2 后的次级块：.vault-row / .loc-row 路径、悬停设置行的副标题、卡片内 .btn-gho 文字' },
    { fg: '--ink', bg: '--panel-3', tier: 'text', where: '.icon-btn 悬停时的图标与文字' },
    { fg: '--ink-3', bg: '--panel', tier: 'text', where: '.row-k 字段标签、.row-v.muted「未填写」、空态、.hint' },
    { fg: '--ink-3', bg: '--panel-2', tier: 'text', where: '列表副标题 .item-sub、解锁/弹窗里的 .hint 与副文本（--panel-2）' },
    { fg: '--ink-3', bg: '--panel-3', tier: 'ui', where: '.vault-row-chev 的箭头（.vault-row 抬到 panel-3；图形按 3:1 判）' },
    { fg: '--accent', bg: '--panel', tier: 'text', where: '.save-state.is-busy 的强调文字（保存中气泡）' },
    { fg: '--accent-2', bg: '--accent-soft', tier: 'text', where: '.detail-ava、.pill.ok（.tag-cat 2026-10-09 起改分类自色，走「分类圆点」一节的 L3b 断言）' },
    { fg: '--accent-2', bg: '--panel', tier: 'text', where: '「请我喝杯咖啡」的咖啡图标与文字（设置页 .srow-lead 常亮强调色）' },
    { fg: '--accent-2', bg: '--panel-2', tier: 'text', where: '「请我喝杯咖啡」行悬停（.srow-link 豁免于通用悬停底 panel-3，保持 panel-2 —— accent-2 压 panel-3 只有 4.08）' },
    { fg: '--danger', bg: '--panel', tier: 'text', where: '.ctxmenu 危险项、.save-state.is-error' },
    { fg: '--danger-ink', bg: '--panel-2', tier: 'text', where: '.lock-msg（解锁卡抬 panel-2 后从 --danger 换 -ink 档，基础档只剩 4.3）' },
    { fg: '--danger-ink', bg: '--danger-soft', tier: 'text', where: '.btn-danger 与 .pill.bad' },
    { fg: '--danger-ink', bg: '--danger-hover', tier: 'text', where: '.btn-danger 悬停、危险菜单项悬停' },
    { fg: '--warn-ink', bg: '--warn-soft', tier: 'text', where: '.pill.warn 与警告条' },
    { fg: '--mark-ink', bg: '--mark-soft', tier: 'text', where: '搜索命中的 <mark>' },
    { fg: '--toast-ink', bg: '--toast-bg', tier: 'text', where: 'toast' },
    { fg: '--ok', bg: '--panel', tier: 'ui', where: '强度条满格填充（配「强」字）' },
    { fg: '--warn', bg: '--panel', tier: 'ui', where: '强度条中档填充（配「一般」字）' },
    { fg: '--accent', bg: '--panel', tier: 'ui', where: '强度条扫描的填充' },

    // 开关：选中态的块底取实心档（--accent-fill），上面压白色滑块。
    // 四个 app 共用这条 —— 承载元素（字或图形）的实心块一律走实心档，
    // --accent 只留给文字、图标、描边和自身成图形的填充（强度条、扫描条）。
    { fg: '--accent-fill', bg: '--panel', tier: 'ui', where: '开关选中态的块底（设置页两处 .switch）' },
    { fgHex: '#ffffff', bg: '--accent-fill', tier: 'ui', where: '开关选中态的白色滑块' },

    // 主按钮：白字压在实心底上。实心底是独立令牌（--accent-fill / -2）——
    // 深色档的 --accent 太亮，白字压上去只有 3.68:1，两个角色不能共用一个值。
    { fgHex: '#ffffff', bg: '--accent-fill', tier: 'text', where: '.btn-pri 主按钮文字' },
    { fgHex: '#ffffff', bg: '--accent-fill-2', tier: 'text', where: '.btn-pri 悬停' },
    // 侧栏选中行：大面积实心块单独取下一档（fill-2 / 700），白字 6.3:1。
    // 600 档铺满一整行偏亮，且白字只有 4.66:1。
    { fgHex: '#ffffff', bg: '--accent-fill-2', tier: 'text', where: '侧栏选中行 .cat.on' },

    // 侧栏里自带不透明底的两处（`.sider` 作用域覆盖已删，scope 机制保留）。
    { fg: '--ink-2', bg: '--panel', tier: 'text', scope: 'sider', where: '.cat-n 计数徽章' },
    { fg: '--ink-2', bg: '--panel-2', tier: 'text', scope: 'sider', where: '.btn-gho 按钮' }
];

const TIER_MIN = { text: 4.5, large: 3.0, ui: 3.0 };

/*
 * tokens.css 之外允许出现的十六进制色值。
 *
 * 登记在这里等于承认「它不跟主题走，且这是有意的」。理由必须写清楚 ——
 * 写不出来的，说明它本该是令牌。
 */
const ALLOWED_HEX = [
    { file: 'src/styles/base.css', hex: '#fff', reason: '.btn-pri 主按钮文字：压在实心 --accent-fill 上，正白' },
    { file: 'src/styles/views.css', hex: '#fff', reason: '.lock-mark / .brand-ic 品牌渐变上的图标与 .switch i::after 开关滑块（图形，非文字；滑块压在 --accent-fill 上，断言见 PAIRS 表）' },
    {
        file: 'src/styles/views.css',
        hex: '#e5e5e5',
        reason: '历史沿革注释提及：材质时代 .sider 作用域的 --ink-2 覆盖值（规则已删，views.css 注释里留着沿革说明）'
    },
    { file: 'src/vault/model.ts', hex: '#f472b6', reason: '分类色板（Tailwind v4 400 档，10 个一组）：侧栏圆点 / 色板色格 / 详情 .tag-cat 文字三处同源，对比度断言见「分类圆点」一节' },
    { file: 'src/vault/model.ts', hex: '#fb923c', reason: '同上' },
    { file: 'src/vault/model.ts', hex: '#facc15', reason: '同上' },
    { file: 'src/vault/model.ts', hex: '#a3e635', reason: '同上' },
    { file: 'src/vault/model.ts', hex: '#4ade80', reason: '同上' },
    { file: 'src/vault/model.ts', hex: '#2dd4bf', reason: '同上' },
    { file: 'src/vault/model.ts', hex: '#22d3ee', reason: '同上' },
    { file: 'src/vault/model.ts', hex: '#60a5fa', reason: '同上' },
    { file: 'src/vault/model.ts', hex: '#a78bfa', reason: '同上' },
    { file: 'src/vault/model.ts', hex: '#e879f9', reason: '同上' },
    { file: 'src/vault/model.ts', hex: '#f9a8d4', reason: '旧档（300 档）色值，只出现在 LEGACY_DOT_COLORS 迁移映射里：库里存过旧色的分组读回时映射到新档' },
    { file: 'src/vault/model.ts', hex: '#fdba74', reason: '同上' },
    { file: 'src/vault/model.ts', hex: '#fde047', reason: '同上' },
    { file: 'src/vault/model.ts', hex: '#bef264', reason: '同上' },
    { file: 'src/vault/model.ts', hex: '#86efac', reason: '同上' },
    { file: 'src/vault/model.ts', hex: '#5eead4', reason: '同上' },
    { file: 'src/vault/model.ts', hex: '#67e8f9', reason: '同上' },
    { file: 'src/vault/model.ts', hex: '#93c5fd', reason: '同上' },
    { file: 'src/vault/model.ts', hex: '#c4b5fd', reason: '同上' },
    { file: 'src/vault/model.ts', hex: '#f0abfc', reason: '同上' }
];

// ----------------------------------------------------------------- 主流程

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (/\.(css|ts)$/.test(e.name)) out.push(p);
    }
    return out;
}

function main() {
    const tokens = readTokens();
    const sider = readSiderOverrides();

    console.log('配色对比度门禁\n');

    // ---- ① 令牌解析成功（解析不到就说明令牌文件的写法被换了，后面的断言全是空的）
    check('L0', '解析出配色令牌', Object.keys(tokens).length >= 25,
        `${Object.keys(tokens).length} 个`);

    // ---- ② 逐对算对比度
    let failed = 0;
    for (const pair of PAIRS) {
        const table = pair.scope === 'sider' ? { ...tokens, ...sider } : tokens;
        const bg = table[pair.bg];
        const fg = pair.fgHex ? parseHex(pair.fgHex) : table[pair.fg];
        const min = TIER_MIN[pair.tier];

        if (!fg || !bg) {
            check(`${pair.fg ?? pair.fgHex}/${pair.bg}`, pair.where, false, '令牌取不到');
            failed += 1;
            continue;
        }

        const r = ratio(fg, bg);
        const ok = r + 1e-9 >= min;
        const label = pair.fg ?? `${pair.fgHex}（字面值）`;
        const scope = pair.scope === 'sider' ? '侧栏 ' : '';
        // 副标题写「一处真实出现的位置」，失败了要能直奔过去。
        check(`${scope}${label} on ${pair.bg}`, pair.where, ok,
            `${r.toFixed(2)}:1（需 ≥${min}）`);
        if (!ok) failed += 1;
    }

    // ---- ③ 分类圆点色板
    //
    // 圆点压在侧栏毛玻璃上，三类底各算一遍：材质底（多数时候）、悬停的 --panel-3、
    // 选中行的 --accent-soft。判据取三者里最差的那一格。
    console.log('\n  ── 分类圆点 ──');
    const dots = readDotColors();
    check(
        'L1 色板',
        '从 model.ts 解析出 10 个分类色',
        dots.length === 10 && new Set(dots).size === 10,
        dots.length ? dots.join(' ') : '一个都没解析到'
    );

    const dotBacks = [
        { label: '侧栏 --panel-2', rgb: parseHex(SIDER_MATERIAL) },
        { label: '--panel-3 悬停', rgb: tokens['--panel-3'] },
        { label: '--accent-soft 选中', rgb: tokens['--accent-soft'] }
    ].filter((b) => b.rgb);

    check('L2 圆点底色取到', '三类底都能取到（侧栏底随 .sider 落令牌）', dotBacks.length === 3, dotBacks.map((b) => b.label).join(' · '));

    if (dots.length && dotBacks.length === 3) {
        let worst = { r: Infinity, dot: '', label: '' };
        for (const dot of dots) {
            for (const back of dotBacks) {
                const r = ratio(parseHex(dot), back.rgb);
                if (r < worst.r) worst = { r, dot, label: back.label };
            }
        }
        check(
            'L3 圆点对比度',
            `分类圆点压在三类底上都 ≥ ${DOT_MIN}:1`,
            worst.r + 1e-9 >= DOT_MIN,
            `最差 ${worst.dot} on ${worst.label} = ${worst.r.toFixed(2)}:1`
        );

        // 分类色还以**文字**出现在详情的 .tag-cat（压 --panel-2），文字按 4.5 判 ——
        // 这条是 2026-10-09 色板加深到 400 档的动因所在，缺了它加深就白加。
        const panel2 = tokens['--panel-2'];
        if (panel2) {
            let worstTag = { r: Infinity, dot: '' };
            for (const dot of dots) {
                const r = ratio(parseHex(dot), panel2);
                if (r < worstTag.r) worstTag = { r, dot };
            }
            check(
                'L3b 分类色作 tag 文字',
                '.tag-cat 字色（分类色）压 --panel-2 上都 ≥ 4.5:1',
                worstTag.r + 1e-9 >= 4.5,
                `最差 ${worstTag.dot} = ${worstTag.r.toFixed(2)}:1`
            );
        }
    }

    // ---- ④ 色值不外泄
    console.log('\n  ── 色值来源 ──');
    const allowed = new Set(ALLOWED_HEX.map((a) => `${a.file}|${a.hex}`));
    const stray = [];
    for (const file of walk(SRC)) {
        const rel = path.relative(ROOT, file);
        if (/^src\/styles\/tokens(\.generated)?\.css$/.test(rel)) continue; // 令牌来源（生成物 + 本地布局），整份豁免
        const text = fs.readFileSync(file, 'utf8');
        for (const m of text.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
            const hex = m[0].toLowerCase();
            // 只认 3 位 / 6 位色值，挡掉 #view-unlock 这类选择器与注释里的 #hex
            if (!parseHex(hex)) continue;
            if (!allowed.has(`${rel}|${hex}`)) stray.push(`${rel} 的 ${hex}`);
        }
    }
    check('L4 令牌之外无未登记的色值', 'tokens.css 之外出现的色值都能追到一条理由',
        stray.length === 0, stray.length ? `未登记：${[...new Set(stray)].join('、')}` : '无');

    // ---- ⑤ 焦点环
    //
    // 全应用共用 base.css 里那一条 `:focus-visible`。环是 `outline`，带 2px
    // `outline-offset` —— offset 是这条判据能成立的前提：环画在元素**外面**，
    // 压的是底，不是元素自身。少了它，环会直接盖在实心主按钮（--accent-fill）上，
    // 蓝压蓝只有 1.79:1，键盘走一圈等于没有提示。
    //
    // 四类底取实际会出现的：面板、输入框底、悬停面、侧栏底。
    console.log('\n  ── 焦点环 ──');
    const ring = tokens['--accent-2'];
    const ringBacks = [
        { label: '--panel', rgb: tokens['--panel'] },
        { label: '--panel-2', rgb: tokens['--panel-2'] },
        { label: '--panel-3', rgb: tokens['--panel-3'] },
        { label: '侧栏 --panel-2', rgb: parseHex(SIDER_MATERIAL) }
    ].filter((b) => b.rgb);

    check(
        'L5 焦点环底色取到',
        '环色与四类底都能取到',
        Boolean(ring) && ringBacks.length === 4,
        ring ? `--accent-2 · ${ringBacks.length} 类底` : '取不到 --accent-2'
    );

    if (ring && ringBacks.length === 4) {
        let worstRing = { r: Infinity, label: '' };
        for (const back of ringBacks) {
            const r = ratio(ring, back.rgb);
            if (r < worstRing.r) worstRing = { r, label: back.label };
        }
        check(
            'L6 焦点环对比度',
            '焦点环压在四类底上都 ≥ 3:1（WCAG 1.4.11 非文本）',
            worstRing.r + 1e-9 >= 3.0,
            `最差 on ${worstRing.label} = ${worstRing.r.toFixed(2)}:1`
        );
    }

    // ---- ⑥ 焦点环规格只能有一处（源码级判据）
    //
    // 「聚焦时环画没画出来」在应用内测不了：`:focus-visible` 由浏览器按「最近一次
    // 交互是不是键盘」判定，而验收前面派发过合成的 `pointerdown`，之后一律不命中
    // （详见 accept.ts 里那段说明）。但**规格是不是只有一处**在这里能查 ——
    // 读的是源文件，Node 侧做得到。
    //
    // 允许两处：base.css 那条通用规则，与 views.css 里开关的例外
    // （`.switch` 的 input 是 `opacity: 0`，环得画在滑块上）。
    // 别处再冒出 outline 声明就该问一句为什么：多一处就多一个会分叉的地方。
    console.log('\n  ── 焦点环规格 ──');
    const ringSpots = [];
    for (const file of walk(STYLES)) {
        const rel = path.relative(ROOT, file);
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        let lastHit = -10;
        lines.forEach((line, i) => {
            if (!/outline-(?:width|style|color|offset)\s*:/.test(line)) return;
            // 相邻几行算同一处（一条规则的四句声明写成四行）
            if (i - lastHit > 2) ringSpots.push(`${rel}:${i + 1}`);
            lastHit = i;
        });
    }
    check(
        'L7 焦点环规格只有两处',
        'base.css 的通用规则 + views.css 里开关的例外，别处不再自己写一份',
        ringSpots.length === 2,
        ringSpots.length ? ringSpots.join(' · ') : '一处都没找到（通用规则被删了？）'
    );

    // 旧令牌：那是个 18% 透明度的蓝，压在各类底上只有 1.05–1.27:1 ——
    // 「写了但看不见」的本体。留着它，迟早有人再用一次。
    const legacyRing = walk(SRC).filter((f) => /--focus-ring/.test(fs.readFileSync(f, 'utf8')));
    check(
        'L8 旧令牌已清掉',
        '--focus-ring 不再出现在 src/ 里',
        legacyRing.length === 0,
        legacyRing.length ? legacyRing.map((f) => path.relative(ROOT, f)).join('、') : '无'
    );

    // ---- ⑦ 汇总
    const passed = results.filter((r) => r.ok).length;
    console.log(`\n结果：${passed} / ${results.length} 项通过`);

    if (failed > 0) {
        console.log('\n不达标的组合（改 tokens.css 后重跑）：');
        for (const r of results) if (!r.ok) console.log(`  · ${r.id} — ${r.detail}`);
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const reportPath = path.join(OUT_DIR, 'contrast.json');
    fs.writeFileSync(reportPath, JSON.stringify({
        measuredAt: new Date().toISOString(),
        pairs: PAIRS.length,
        rows: results
    }, null, 2));
    console.log(`报告：${path.relative(process.cwd(), reportPath)}`);

    if (passed !== results.length) process.exitCode = 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    try {
        main();
    } catch (e) {
        console.error('\n脚本异常终止：', e);
        process.exitCode = 1;
    }
}
