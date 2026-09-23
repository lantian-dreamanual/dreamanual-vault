/**
 * 配色对比度门禁（PRD §7.3 / M4 C1）。
 *
 * 目的：把「配色里每一对前景/背景都达标」从一次性的目测变成会咬人的断言。
 * 令牌只有一个来源（src/styles/tokens.css），所以这里**不硬编码任何颜色**——
 * 期望值全部从令牌文件解析出来后现算。改配色时忘了某一对，门禁就红。
 *
 * 分档（按 WCAG 2.1 AA）：
 *   text   4.5:1  正文与控件文字，含字号偏小的字段标签、按钮、tag
 *   large  3.0:1  大字（≥24px，或 ≥18.66px 且 ≥700 字重）
 *   ui     3.0:1  承载信息的图形：强度条填充、分类圆点、开关滑块
 *
 * `large` 这一档目前没有组合落在里头：解锁页标题 19px / 650 字重，按标准仍算
 * 正文（大字线要 700 字重或 24px）。留着是为了量到它时不用改分档表。
 *
 * 侧栏是唯一「底色不是令牌」的区域（macOS 材质，PRD §7.2）。材质实测读数在
 * scripts/a3-probe.sh，本脚本只覆盖侧栏里**自带不透明底**的两处（.cat-n 徽章、
 * .btn-gho 按钮），它们的底色仍是令牌，文字色则取 `.sider` 作用域里的重定义值。
 *
 * 另有一条「色值不外泄」断言：tokens.css 之外出现的十六进制色值必须逐条登记在
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

function readTokens() {
    const css = fs.readFileSync(path.join(STYLES, 'tokens.css'), 'utf8');
    return varsIn(blockOf(css, ':root {'));
}

/** 侧栏作用域里被重定义的文字令牌。只有这一个 —— 见 views.css 的注释。 */
function readSiderOverrides() {
    const css = fs.readFileSync(path.join(STYLES, 'views.css'), 'utf8');
    return varsIn(blockOf(css, '.sider {'));
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
    { fg: '--ink-2', bg: '--panel', tier: 'text', where: '.block-v 备注、tag、.pw-col 标签、侧栏「分类」与 .sider-foot 的 .vault-name' },
    { fg: '--ink-2', bg: '--panel-2', tier: 'text', where: '.btn-gho 按钮、解锁页的 .vault-row 路径（底色 --panel-2）' },
    { fg: '--ink-2', bg: '--panel-3', tier: 'text', where: '.tag 与 .ava 的文字（底色是 --panel-3）' },
    { fg: '--ink-3', bg: '--panel', tier: 'text', where: '.row-k 字段标签、.row-v.muted「未填写」、空态、.hint' },
    { fg: '--ink-3', bg: '--panel-2', tier: 'text', where: '列表副标题 .item-sub、.vault-row-chev 的箭头（--panel-2）' },
    { fg: '--ink-3', bg: '--panel-3', tier: 'text', where: '.pill 的文字、.icon-btn 悬停面' },
    { fg: '--accent', bg: '--panel', tier: 'text', where: '.save-state.is-busy 之类的强调文字、选中态的 .cat / .item' },
    { fg: '--accent-2', bg: '--accent-soft', tier: 'text', where: '选中的分类、.detail-ava、.tag-cat、.pill.ok' },
    { fg: '--danger', bg: '--panel', tier: 'text', where: '.lock-msg、.ctxmenu 危险项、.save-state.is-error' },
    { fg: '--danger', bg: '--danger-soft', tier: 'text', where: '.btn-danger 与 .pill.bad' },
    { fg: '--danger', bg: '--danger-hover', tier: 'text', where: '.btn-danger 悬停、危险菜单项悬停' },
    { fg: '--warn-ink', bg: '--warn-bg', tier: 'text', where: '.pill.warn 与警告条' },
    { fg: '--mark-ink', bg: '--mark-bg', tier: 'text', where: '搜索命中的 <mark>' },
    { fg: '--toast-ink', bg: '--toast-bg', tier: 'text', where: 'toast' },
    { fg: '--ok', bg: '--panel', tier: 'ui', where: '强度条满格填充（配「强」字）' },
    { fg: '--warn', bg: '--panel', tier: 'ui', where: '强度条中档填充（配「一般」字）' },
    { fg: '--accent', bg: '--panel', tier: 'ui', where: '强度条扫描、开关选中态' },

    // 主按钮：白字压在实心底上。实心底是独立令牌（--accent-fill / -2）——
    // 深色档的 --accent 太亮，白字压上去只有 3.68:1，两个角色不能共用一个值。
    { fgHex: '#ffffff', bg: '--accent-fill', tier: 'text', where: '.btn-pri 主按钮文字' },
    { fgHex: '#ffffff', bg: '--accent-fill-2', tier: 'text', where: '.btn-pri 悬停' },

    // 侧栏里自带不透明底的两处（文字色取 .sider 作用域的重定义值）。
    // 落在材质上的文字不在此表 —— 底色不是令牌，由 scripts/a3-probe.sh 实测。
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
    { file: 'src/styles/views.css', hex: '#fff', reason: '.lock-mark / .brand-ic 品牌渐变上的图标与 .switch i::after 开关滑块（图形，非文字）' },
    {
        file: 'src/styles/views.css',
        hex: '#d1d7df',
        reason: '侧栏 --ink-2 覆盖值。侧栏底色是 macOS 材质（不是令牌），只能在 .sider 作用域里另给，理由见该处注释与 scripts/a3-probe.sh'
    },
    { file: 'src/vault/model.ts', hex: '#2563eb', reason: '分类圆点色板，10 个一组循环取色' },
    { file: 'src/vault/model.ts', hex: '#0891b2', reason: '同上' },
    { file: 'src/vault/model.ts', hex: '#0f9d63', reason: '同上' },
    { file: 'src/vault/model.ts', hex: '#ca8a04', reason: '同上' },
    { file: 'src/vault/model.ts', hex: '#dc2626', reason: '同上' },
    { file: 'src/vault/model.ts', hex: '#7c3aed', reason: '同上' },
    { file: 'src/vault/model.ts', hex: '#db2777', reason: '同上' },
    { file: 'src/vault/model.ts', hex: '#0d9488', reason: '同上' },
    { file: 'src/vault/model.ts', hex: '#ea580c', reason: '同上' },
    { file: 'src/vault/model.ts', hex: '#4f46e5', reason: '同上' }
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

    // ---- ③ 色值不外泄
    console.log('\n  ── 色值来源 ──');
    const allowed = new Set(ALLOWED_HEX.map((a) => `${a.file}|${a.hex}`));
    const stray = [];
    for (const file of walk(SRC)) {
        const rel = path.relative(ROOT, file);
        if (rel === 'src/styles/tokens.css') continue; // 令牌唯一来源，整份豁免
        const text = fs.readFileSync(file, 'utf8');
        for (const m of text.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
            const hex = m[0].toLowerCase();
            // 只认 3 位 / 6 位色值，挡掉 #view-unlock 这类选择器与注释里的 #hex
            if (!parseHex(hex)) continue;
            if (!allowed.has(`${rel}|${hex}`)) stray.push(`${rel} 的 ${hex}`);
        }
    }
    check('L3 令牌之外无未登记的色值', 'tokens.css 之外出现的色值都能追到一条理由',
        stray.length === 0, stray.length ? `未登记：${[...new Set(stray)].join('、')}` : '无');

    // ---- ④ 汇总
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
