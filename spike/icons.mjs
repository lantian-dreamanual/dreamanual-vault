/**
 * 图标来源门禁。
 *
 * 目的：把「这个应用里的图标都是 lucide 官方形状」从一次性的替换变成会咬人的断言。
 *
 * 起因是一把变形了的齿轮：设置按钮那个 `settings` 用的是一份手写近似路径，
 * 描边超出 24×24 画布左、上各 2.1 用户单位 —— 15px 下被裁掉 1.3px，
 * 看起来就是齿轮左上角塌了一块。同一份近似还散在别处：13 个图标里 12 个
 * 与官方有 1.6%–21.1% 的像素差，只有 external-link 逐像素一致。
 *
 * 所以这里**不硬编码任何路径**，期望值全部从 spike/lucide-baseline.json
 * （整份取自 lucide-static@1.47.0）读出来再比。手改其中一条路径，门禁就红 ——
 * 要更新就整份从官方重新导出，别去给比对器开洞。
 *
 * 分两层：
 *   结构  symbol 集合与基准一致、页面里不许有第二份手写图标、图标都走 use 引用
 *   逐字  每个 symbol 的内容与官方基准完全相同
 *
 * 另有一条与图标无关但会一起坏掉的：描边口径。全部图标实粗细统一 1.5 CSS px，
 * 按 stroke-width = 36 / 显示尺寸 折算（见 src/ui/icons.ts::strokeFor）。
 * 改尺寸忘了改描边，这条会红。
 *
 * `--online` 会重新拉一遍官方 SVG 与基准比对 —— 用来确认基准本身没被手改过。
 * 默认不联网：本应用「联网面只有一处」是硬约束，验收不该顺手开第二条。
 *
 * `--refresh <图标名>` 从官方重新导出一两个图标写回基准。基准文件顶上那句
 * 「要更新就整份从官方重新导出，不要手改其中一条」就是这条命令。它只做
 * 「拉官方 → canon → 写回」三件事，不碰 index.html —— 写完再跑一次门禁，
 * I2 会告诉你 index.html 那边还缺哪个 symbol。
 *
 * 用法：node spike/icons.mjs [--online | --refresh <图标名>…]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BASELINE = path.join(HERE, 'lucide-baseline.json');
const HTML_PATH = path.join(ROOT, 'index.html');
const TS_PATH = path.join(ROOT, 'src', 'ui', 'icons.ts');
const OUT_DIR = path.join(HERE, 'out');

/** 实粗细 1.5 CSS px：stroke-width = 1.5 × 24 / size = 36 / size */
const STROKE_NUMERATOR = 36;

/** 官方图标版本。**只在这一处写**，基准文件里的 `source` 必须与它同版（I1 守）。
 *  两处各写一份的话，升级时漏改一处就会变成「拿新版本的形状比旧版本的基准」，
 *  红出来的差异全是版本漂移，不是真问题。 */
const LUCIDE_VERSION = '1.47.0';

const results = [];

function check(id, name, ok, detail = '') {
    results.push({ id, name, ok, detail });
    console.log(`  [${ok ? '通过' : '失败'}] ${id} ${name}${detail ? ` — ${detail}` : ''}`);
}

/**
 * 规范形。必须与生成基准时用的是同一个口径，否则两边永远比不平。
 * 元素之间不留空白、自闭合统一成 `/>`、去掉注释。
 */
function canon(s) {
    return s
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\s+/g, ' ')
        .replace(/\s*\/>/g, '/>')
        .replace(/>\s+</g, '><')
        .trim();
}

/** 递归列出目录下的文件（跳过 node_modules 与点开头的东西）。 */
function walk(dir) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...walk(p));
        else out.push(p);
    }
    return out;
}

/** 从 index.html 里取出 <symbol id="ic-*"> 的内容。 */
function readSymbols(html) {
    const out = new Map();
    for (const m of html.matchAll(/<symbol id="ic-([^"]+)"[^>]*>([\s\S]*?)<\/symbol>/g)) {
        out.set(m[1], canon(m[2]));
    }
    return out;
}

/** 去掉 icon 的 defs 那一整块（宽高为 0、含 #brand-key 与全部 symbol）。 */
function stripDefs(html) {
    return html.replace(/<svg width="0" height="0"[\s\S]*?<\/defs><\/svg>/, '');
}

/** 页面里所有「图标 svg」：带 viewBox 且引用了一个 ic-* symbol。 */
function readIconUses(html) {
    const out = [];
    for (const m of html.matchAll(/<svg\b([^>]*)>([\s\S]*?)<\/svg>/g)) {
        const attrs = m[1];
        const ref = m[2].match(/<use href="#(ic-[^"]+)"\s*\/>/);
        if (!ref) continue;
        const num = (k) => {
            const r = attrs.match(new RegExp(`${k}="([\\d.]+)"`));
            return r ? Number(r[1]) : NaN;
        };
        out.push({ attrs, inner: m[2].trim(), ref: ref[1], w: num('width'), sw: num('stroke-width') });
    }
    return out;
}

async function officialInner(name) {
    const url = `https://unpkg.com/lucide-static@${LUCIDE_VERSION}/icons/${name}.svg`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    const txt = await res.text();
    const m = txt.replace(/<!--[\s\S]*?-->/g, '').match(/<svg\b[^>]*>([\s\S]*?)<\/svg>/);
    if (!m) throw new Error(`${name}: 取不到内容`);
    return canon(m[1]);
}

/** 从官方重新导出几个图标写回基准。
 *
 *  存在的理由：基准文件顶上写着「要更新就整份从官方重新导出，不要手改其中一条」，
 *  但那句话一直没有可执行的形式 —— 每次加图标都得临时写个一次性的脚本，
 *  而临时脚本正是「手改」最容易发生的地方。
 *
 *  只改基准这一个文件，不碰 index.html：写完之后再跑一次门禁，I2 会指出
 *  index.html 那边还缺哪个 symbol、I5 会指出引用处描边写错没有。 */
async function refresh(names) {
    if (names.length === 0) {
        console.error('用法：node spike/icons.mjs --refresh <图标名> [更多…]');
        process.exitCode = 2;
        return;
    }
    const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
    for (const n of names) {
        const inner = await officialInner(n);
        const existed = Object.prototype.hasOwnProperty.call(baseline.icons, n);
        baseline.icons[n] = inner;
        console.log(`  ${existed ? '更新' : '新增'} ${n} — ${inner.length} 字节`);
    }
    // 末尾补换行：与手工维护时编辑器写出来的形态一致，diff 里不会多一行「\ No newline」
    fs.writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`\n已写回 ${path.relative(ROOT, BASELINE)}`);
    console.log('下一步：在 index.html 的 <defs> 里加对应的 <symbol id="ic-…">，再跑一次门禁');
}

async function main() {
    // 导出模式：只写基准，不跑断言 —— 这时候 index.html 那边往往还没改，
    // I2/I3 必然红，跑一遍只会误导。
    const refreshIdx = process.argv.indexOf('--refresh');
    if (refreshIdx >= 0) {
        await refresh(process.argv.slice(refreshIdx + 1));
        return;
    }

    const online = process.argv.includes('--online');
    const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
    const names = Object.keys(baseline.icons);
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    const ts = fs.readFileSync(TS_PATH, 'utf8');
    const rel = (p) => path.relative(ROOT, p);

    // ---- ① 基准
    const sameVersion = typeof baseline.source === 'string' && baseline.source.includes(LUCIDE_VERSION);
    check('I1 基准读得到', `lucide ${baseline.source} 下 ${names.length} 个图标`,
        names.length > 0 && baseline.viewBox === '0 0 24 24' && sameVersion,
        `${rel(BASELINE)} · ${names.length} 个 · 许可 ${baseline.license}` +
            (sameVersion ? '' : ` · ⚠️ 基准是 ${baseline.source}，脚本认的是 ${LUCIDE_VERSION}`));

    // ---- ② symbol 集合
    const symbols = readSymbols(html);
    const defined = [...symbols.keys()];
    const missing = names.filter((n) => !symbols.has(n));
    const extra = defined.filter((n) => !names.includes(n));
    check('I2 symbol 集合与基准一致', '不多不少',
        missing.length === 0 && extra.length === 0,
        missing.length || extra.length
            ? `缺 ${missing.join('、') || '无'} · 多 ${extra.join('、') || '无'}`
            : `${defined.length} 个`);

    // ---- ③ 逐字相等（本门禁的核心）
    const mismatch = names.filter((n) => symbols.has(n) && symbols.get(n) !== baseline.icons[n]);
    check('I3 图标路径与官方逐字相等', '每个 symbol 的内容都取自官方',
        mismatch.length === 0,
        mismatch.length ? mismatch.join('、') : `${names.length} 个全部一致`);

    // ---- ④ 没有第二份手写图标
    //   两处都要扫：index.html 的静态标记，以及 src 下 .ts 里拼字符串的模板。
    //   只扫 index.html 会漏掉 src/views/vault.ts 里那个「新建分类」的加号 ——
    //   第一版就是这么漏的，装完了才发现还有一份手写的。
    //   icons.ts 的 wrap() 只有 <use>，不会被这条误伤。
    const GEOM = /<(path|rect|circle|line|polyline|polygon|ellipse|g)\b/;
    const handWritten = [];

    const body = stripDefs(html);
    for (const m of body.matchAll(/<svg\b[^>]*>([\s\S]*?)<\/svg>/g)) {
        if (GEOM.test(m[1])) handWritten.push(`index.html：${canon(m[0]).slice(0, 60)}`);
    }

    for (const file of walk(path.join(ROOT, 'src'))) {
        if (!file.endsWith('.ts')) continue;
        const text = fs.readFileSync(file, 'utf8');
        for (const m of text.matchAll(/<svg\b[^>]*>([\s\S]*?)<\/svg>/g)) {
            if (!GEOM.test(m[1])) continue;
            const line = text.slice(0, m.index).split('\n').length;
            handWritten.push(`${path.relative(ROOT, file)}:${line}`);
        }
    }

    check('I4 没有手写图标残留', 'index.html 与 src/*.ts 里的图标都必须走 symbol 引用',
        handWritten.length === 0,
        handWritten.length ? handWritten.join(' | ') : 'index.html 与 src 下全部干净');

    // ---- ⑤ 描边口径
    const uses = readIconUses(html);
    const badStroke = uses.filter((u) => !(Math.abs(u.sw * u.w - STROKE_NUMERATOR) <= 0.05));
    check('I5 页面侧描边按 36/尺寸', '实粗细统一 1.5 CSS px',
        uses.length > 0 && badStroke.length === 0,
        badStroke.length
            ? badStroke.map((u) => `${u.ref}@${u.w}px sw${u.sw}`).join('、')
            : `${uses.length} 处 · ${[...new Set(uses.map((u) => `${u.w}px→${u.sw}`))].join(' ')}`);

    // ---- ⑥ icons.ts 只引用已定义的 symbol
    const tsRefs = [...ts.matchAll(/wrap\('([^']+)'/g)].map((m) => m[1]);
    const tsBad = tsRefs.filter((n) => !symbols.has(n));   // symbol 表里的键已剥掉 ic- 前缀
    check('I6 icons.ts 引用的 symbol 都有定义', '拼字符串那侧不引空',
        tsRefs.length > 0 && tsBad.length === 0,
        tsBad.length ? tsBad.join('、') : `${tsRefs.length} 个 · ${tsRefs.join(' ')}`);

    // ---- ⑦ icons.ts 的描边口径
    const formula = /const\s+strokeFor\s*=\s*\(size:\s*number\)[^=]*=>[^;]*?\b(\d+)\s*\/\s*size/.exec(ts);
    check('I7 icons.ts 的描边口径是 36/尺寸',
        '口径只有一处，且与页面侧同源',
        formula !== null && Number(formula[1]) === STROKE_NUMERATOR,
        formula ? `strokeFor = ${formula[1]} / size` : '在 src/ui/icons.ts 里找不到 strokeFor = N / size');

    // ---- ⑧ 品牌钥匙不能被顺手换掉
    //   它是应用身份标记（跟随 App 图标），不是通用图标。曾经有过一次
    //   把用户故意改的蓝色钥匙按旧稿反推回金色的事。
    const brandOk = /id="brand-key"/.test(html) && /<use href="#brand-key"/.test(html);
    check('I8 品牌钥匙还在', '它是身份标记，不属于 lucide 图标集',
        brandOk, brandOk ? 'index.html 里 <use href="#brand-key"> 三处引用完好' : '找不到了');

    // ---- ⑨（可选）基准本身与官方线上一致
    if (online) {
        const drifted = [];
        for (const n of names) {
            try {
                if ((await officialInner(n)) !== baseline.icons[n]) drifted.push(n);
            } catch (e) {
                drifted.push(`${n}(${e.message})`);
            }
        }
        check('I9 基准与官方线上一致', '确认基准没被手改过',
            drifted.length === 0, drifted.length ? drifted.join('、') : `${names.length} 个一致`);
    }

    // ---- 汇总
    const passed = results.filter((r) => r.ok).length;
    console.log(`\n结果：${passed} / ${results.length} 项通过`);

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const reportPath = path.join(OUT_DIR, 'icons.json');
    fs.writeFileSync(reportPath, JSON.stringify({
        measuredAt: new Date().toISOString(),
        source: baseline.source,
        online,
        rows: results
    }, null, 2));
    console.log(`报告：${path.relative(process.cwd(), reportPath)}`);

    if (passed !== results.length) process.exitCode = 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    try {
        await main();
    } catch (e) {
        console.error('\n脚本异常终止：', e);
        process.exitCode = 1;
    }
}
