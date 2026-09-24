/**
 * M0 技术验证 · 第 2 步：与 KeePassXC 的闭环互通验收（G3）
 *
 * 三个方向都要过，缺一不可：
 *   A 正向  我们写的 .kdbx  →  KeePassXC 能解锁、能读到全部字段
 *   B 反向  KeePassXC 建的库 →  我们能读
 *   C 回环  KeePassXC 改过我们的库 →  我们能再读，且不丢数据
 *
 * 只有三个方向都通，G3「数据格式为标准 .kdbx，可被第三方客户端打开」
 * 才算真的成立。C 方向尤其关键：KeePassXC 改过并保存我们的库之后，
 * 我们必须能读得回来，且不丢原有条目。
 *
 * 关于文件版本（实测结论，与最初的假设相反）：
 *   - kdbxweb 写出的默认是 4.0
 *   - KeePassXC 保存后**不会**升版本，实测仍是 4.0
 *   - 我们显式声明的 4.1，KeePassXC 保存后被降回 4.0（方向 D）
 *   所以「KDBX 4.1」这个版本号没有实际收益，已按 4.0 处理。
 *
 * 依赖本机的 keepassxc-cli（随 KeePassXC.app 一起安装）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import kdbxwebModule from 'kdbxweb';
import { installArgon2 } from './lib/argon2-node.mjs';
import { KDF_PRESETS, DEFAULT_PRESET } from './kdf-presets.mjs';
import {
    MASTER_PASSWORD,
    VAULT_PATH,
    buildAndSave,
    toBufferView,
    readAllEntries,
    kdbxVersionOf,
    describeHeader
} from './roundtrip.mjs';

const kdbxweb = kdbxwebModule.Kdbx ? kdbxwebModule : kdbxwebModule.default;
const { Kdbx, Credentials, ProtectedValue } = kdbxweb;

const KC = '/Applications/KeePassXC.app/Contents/MacOS/keepassxc-cli';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'out');
const FOREIGN_PATH = path.join(OUT_DIR, 'from-keepassxc.kdbx');
const V41_PATH = path.join(OUT_DIR, 'vault-4.1.kdbx');
const FOREIGN_PASSWORD = 'KeePassXC 建的库 pass 2026';
const SEED_TITLES = ['公司 VPN', '堡垒机-生产', '短信平台后台'];

const results = [];

function check(id, name, ok, detail = '') {
    results.push({ id, name, ok, detail });
    console.log(`  [${ok ? '通过' : '失败'}] ${id} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** 调用 keepassxc-cli，密码通过 stdin 传入 */
function kc(args, passwords) {
    const input = passwords.map((p) => `${p}\n`).join('');
    const r = spawnSync(KC, args, { input, encoding: 'utf8' });
    if (r.error) {
        throw r.error;
    }
    return {
        code: r.status,
        output: `${r.stdout || ''}${r.stderr || ''}`
    };
}

async function main() {
    installArgon2(kdbxweb);
    fs.mkdirSync(OUT_DIR, { recursive: true });

    if (!fs.existsSync(KC)) {
        console.error(`找不到 keepassxc-cli：${KC}`);
        console.error('请先安装 KeePassXC，或修改本脚本顶部的 KC 常量。');
        process.exitCode = 1;
        return;
    }

    // ---------- 准备：用我们自己的脚本写一个库 ----------
    console.log('\n准备 · 生成待验收的库');
    await buildAndSave();
    const written = describeHeader(await Kdbx.load(
        toBufferView(fs.readFileSync(VAULT_PATH)),
        new Credentials(ProtectedValue.fromString(MASTER_PASSWORD))
    ));
    console.log(`  已写出 ${path.relative(process.cwd(), VAULT_PATH)}（KDBX ${written.version}）`);

    // ---------- 方向 A：我们写 → KeePassXC 读 ----------
    console.log('\n方向 A · 我们写的库 → KeePassXC 读');

    const info = kc(['db-info', '-q', VAULT_PATH], [MASTER_PASSWORD]);
    check('A1', 'KeePassXC 能解锁我们的库', info.code === 0 && !/错误|Error/i.test(info.output));

    const infoText = info.output;
    // 期望值从档位定义推导，不写死数字——否则每次改 KDF 参数这个断言都会假红
    const kdf = KDF_PRESETS[DEFAULT_PRESET];
    const expectedKb = `${kdf.memoryMiB * 1024} KB`;
    check(
        'A2',
        'KeePassXC 报告的加密与 KDF 与写入值一致',
        infoText.includes('AES 256') &&
            /Argon2id/.test(infoText) &&
            infoText.includes(expectedKb) &&
            new RegExp(`Argon2id（${kdf.iterations} 次`).test(infoText),
        `期望 AES 256 / Argon2id / ${kdf.iterations} 次 / ${expectedKb}`
    );

    const ls = kc(['ls', '-R', '-q', VAULT_PATH], [MASTER_PASSWORD]);
    const expectedTree = ['服务器/', '办公/', '数据库/', '公司 VPN', '堡垒机-生产', '短信平台后台'];
    const missingInTree = expectedTree.filter((t) => !ls.output.includes(t));
    check('A3', 'KeePassXC 能列出全部分类与条目', missingInTree.length === 0, missingInTree.length ? `缺：${missingInTree.join(', ')}` : `${expectedTree.length} 项全中`);

    const show = kc(['show', '-s', '-q', VAULT_PATH, '服务器/公司 VPN'], [MASTER_PASSWORD]);
    check(
        'A4',
        'KeePassXC 能读出密码明文与多行中文备注',
        show.output.includes('Vpn!2026#Lab') &&
            show.output.includes('申请单号：SEC-2026-0417') &&
            show.output.includes('负责人：张三')
    );

    const bastion = kc(['show', '-s', '-q', VAULT_PATH, '服务器/堡垒机-生产'], [MASTER_PASSWORD]);
    check(
        'A5',
        '备注里的 IP / 端口 / 连接命令可被检索到（PRD 场景 S3）',
        bastion.output.includes('192.0.2.40') && bastion.output.includes('2222'),
        'IP 192.0.2.40 与端口 2222 均在'
    );

    const exported = kc(['export', '-q', '-f', 'xml', VAULT_PATH], [MASTER_PASSWORD]);
    check(
        'A6',
        'KeePassXC 能完整导出 XML（说明结构无歧义）',
        exported.code === 0 && exported.output.includes('Dreamanual 密码管理'),
        `${exported.output.length} 字符`
    );

    // ---------- 方向 B：KeePassXC 写 → 我们读 ----------
    console.log('\n方向 B · KeePassXC 建的库 → 我们读');
    if (fs.existsSync(FOREIGN_PATH)) {
        fs.unlinkSync(FOREIGN_PATH);
    }

    const created = kc(['db-create', '-q', '-p', FOREIGN_PATH], [FOREIGN_PASSWORD, FOREIGN_PASSWORD]);
    check('B1', 'KeePassXC 建库成功', created.code === 0 && fs.existsSync(FOREIGN_PATH));

    kc(['mkdir', '-q', FOREIGN_PATH, '运维'], [FOREIGN_PASSWORD]);
    const added = kc(
        [
            'add',
            '-q',
            FOREIGN_PATH,
            '运维/第三方写入的条目',
            '-u',
            'kc-user',
            '--url',
            'https://kc.example.com',
            '--notes',
            '由 KeePassXC 写入\n第二行备注',
            '-g',
            '-L',
            '24'
        ],
        [FOREIGN_PASSWORD]
    );
    check('B2', 'KeePassXC 能建分类与条目', added.code === 0);

    const foreignVersion = kdbxVersionOf(fs.readFileSync(FOREIGN_PATH));
    console.log(`  KeePassXC 写出的文件版本：${foreignVersion.major}.${foreignVersion.minor}`);

    let foreignDb = null;
    let foreignError = null;
    try {
        foreignDb = await Kdbx.load(
            toBufferView(fs.readFileSync(FOREIGN_PATH)),
            new Credentials(ProtectedValue.fromString(FOREIGN_PASSWORD))
        );
    } catch (e) {
        foreignError = (e && e.message) || String(e);
    }
    check('B3', '我们能读 KeePassXC 建的库', foreignDb !== null, foreignError || `KDBX ${foreignVersion.major}.${foreignVersion.minor}`);

    if (foreignDb) {
        const entries = readAllEntries(foreignDb);
        const groups = foreignDb
            .getDefaultGroup()
            .groups.filter((g) => g.name !== 'Recycle Bin')
            .map((g) => g.name);
        check(
            'B4',
            '分类与条目读回正确',
            groups.includes('运维') && entries.some((e) => e.Title === '第三方写入的条目'),
            `分类：${groups.join(', ')}；条目：${entries.map((e) => e.Title).join(', ')}`
        );
        const target = entries.find((e) => e.Title === '第三方写入的条目');
        check(
            'B5',
            'KeePassXC 生成的随机密码与备注能被解出',
            !!target && target.Password.length === 24 && target.Notes.includes('第二行备注'),
            target ? `密码长度 ${target.Password.length}，备注 ${target.Notes.length} 字符` : '未找到条目'
        );
    }

    // ---------- 方向 C：KeePassXC 改我们的库 → 我们再读 ----------
    console.log('\n方向 C · KeePassXC 改过我们的库 → 我们再读');
    const beforeDb = await Kdbx.load(
        toBufferView(fs.readFileSync(VAULT_PATH)),
        new Credentials(ProtectedValue.fromString(MASTER_PASSWORD))
    );
    const beforeCount = [...beforeDb.getDefaultGroup().allEntries()].length;

    // 先给每个分组写上「分类颜色 / 自定义顺序」这两个扩展位。
    // 它们在应用里存的地方就是 Group → CustomData（见 `src/vault/kdbx.ts` 的两个键），
    // 而**别的客户端重存之后还在不在**是这套功能成立的前提 ——
    // 只验「我们自己读写没问题」会漏掉这一半。
    const EXT_COLOR = 'DreamanualColor';
    const EXT_ORDER = 'DreamanualOrder';
    const probeColors = ['#fb64b6', '#ff8904', '#fdc700'];
    const expectedExt = new Map();
    beforeDb.getDefaultGroup().groups.forEach((g, i) => {
        if (!g.name) return;
        const color = probeColors[i % probeColors.length];
        g.customData = new Map([
            [EXT_COLOR, { value: color }],
            [EXT_ORDER, { value: String(i + 1) }]
        ]);
        expectedExt.set(g.name, { color, order: String(i + 1) });
    });
    fs.writeFileSync(VAULT_PATH, Buffer.from(await beforeDb.save()));

    const modified = kc(
        [
            'add',
            '-q',
            VAULT_PATH,
            '办公/KeePassXC 加的条目',
            '-u',
            'kc-added',
            '--notes',
            '这条由 KeePassXC 写入',
            '-g',
            '-L',
            '20'
        ],
        [MASTER_PASSWORD]
    );
    check('C1', 'KeePassXC 能修改并保存我们的库', modified.code === 0);

    const afterVersion = kdbxVersionOf(fs.readFileSync(VAULT_PATH));
    console.log(`  KeePassXC 保存后的文件版本：${afterVersion.major}.${afterVersion.minor}`);

    let merged = null;
    let mergeError = null;
    try {
        merged = await Kdbx.load(
            toBufferView(fs.readFileSync(VAULT_PATH)),
            new Credentials(ProtectedValue.fromString(MASTER_PASSWORD))
        );
    } catch (e) {
        mergeError = (e && e.message) || String(e);
    }
    check('C2', '我们能读回被 KeePassXC 改过的文件', merged !== null, mergeError || '');

    if (merged) {
        const entries = readAllEntries(merged);
        check(
            'C3',
            'KeePassXC 新增的条目可读',
            entries.some((e) => e.Title === 'KeePassXC 加的条目'),
            entries.map((e) => e.Title).join(' / ')
        );
        check(
            'C4',
            '原有条目一条未丢',
            SEED_TITLES.every((t) => entries.some((e) => e.Title === t)),
            `改前 ${beforeCount} 条 → 改后 ${entries.length} 条`
        );
        const vpn = entries.find((e) => e.Title === '公司 VPN');
        check(
            'C5',
            '原有条目的字段未被改动',
            !!vpn && vpn.Password === 'Vpn!2026#Lab' && vpn.Notes.includes('SEC-2026-0417'),
            vpn ? `${vpn.UserName} / 备注 ${vpn.Notes.length} 字符` : '未找到'
        );

        // ---- 分组扩展位能不能穿过 KeePassXC 的重存
        const afterGroups = merged.getDefaultGroup().groups;
        const lost = [...expectedExt.keys()].filter((name) => {
            const g = afterGroups.find((x) => x.name === name);
            const want = expectedExt.get(name);
            return (
                g?.customData?.get(EXT_COLOR)?.value !== want.color ||
                g?.customData?.get(EXT_ORDER)?.value !== want.order
            );
        });
        check(
            'C7',
            '分组扩展位上的颜色与顺序穿过 KeePassXC 的重存（另一个客户端改过之后还在）',
            expectedExt.size > 0 && lost.length === 0,
            lost.length
                ? `丢了：${lost.join(', ')}`
                : `${expectedExt.size} 个分组的两个键都原值保留`
        );
    }

    // 再存一次，确认我们这个方向也能写回
    if (merged) {
        const e2 = merged.getDefaultGroup().groups.find((g) => g.name === '办公');
        const extra = merged.createEntry(e2);
        extra.fields.set('Title', '回环后再写一条');
        extra.fields.set('UserName', 'roundtrip');
        extra.fields.set('Password', ProtectedValue.fromString('Loop!Back2'));
        extra.times.update();
        const saved = await merged.save();
        const tmp = path.join(OUT_DIR, 'vault.kdbx');
        fs.writeFileSync(tmp, Buffer.from(saved));
        const finalCheck = kc(['ls', '-R', '-q', tmp], [MASTER_PASSWORD]);
        check(
            'C6',
            '我们再次写入后，KeePassXC 仍能打开（方向 A 可重复）',
            finalCheck.output.includes('回环后再写一条'),
            finalCheck.code === 0 ? '已确认' : `退出码 ${finalCheck.code}`
        );
    }

    // ---------- 方向 D：KDBX 4.1 版本声明 ----------
    console.log('\n方向 D · KDBX 4.1 版本声明（PRD §8 写的是 4.1，kdbxweb 默认写 4.0）');
    await buildAndSave({ outPath: V41_PATH, versionMinor: 1 });
    const v41 = kdbxVersionOf(fs.readFileSync(V41_PATH));
    check(
        'D1',
        '我们能显式写出声明为 4.1 的文件',
        v41.major === 4 && v41.minor === 1,
        `${v41.major}.${v41.minor}`
    );

    const v41Info = kc(['db-info', '-q', V41_PATH], [MASTER_PASSWORD]);
    check(
        'D2',
        'KeePassXC 能解锁 4.1 文件',
        v41Info.code === 0 && !/错误|Error/i.test(v41Info.output)
    );

    const v41Ls = kc(['ls', '-R', '-q', V41_PATH], [MASTER_PASSWORD]);
    check(
        'D3',
        '4.1 文件里的中文分类与条目可读',
        v41Ls.output.includes('服务器/') && v41Ls.output.includes('公司 VPN')
    );

    kc(
        ['add', '-q', V41_PATH, '办公/4.1 里加的一条', '-u', 'v41', '--notes', 'OK', '-g', '-L', '16'],
        [MASTER_PASSWORD]
    );
    const v41After = kdbxVersionOf(fs.readFileSync(V41_PATH));
    console.log(`  KeePassXC 保存 4.1 文件后的版本：${v41After.major}.${v41After.minor}`);

    let v41Db = null;
    let v41Err = null;
    try {
        v41Db = await Kdbx.load(
            toBufferView(fs.readFileSync(V41_PATH)),
            new Credentials(ProtectedValue.fromString(MASTER_PASSWORD))
        );
    } catch (e) {
        v41Err = (e && e.message) || String(e);
    }
    check('D4', '我们能读回 4.1 文件', v41Db !== null, v41Err || `${v41After.major}.${v41After.minor}`);

    if (v41Db) {
        const titles = readAllEntries(v41Db).map((e) => e.Title);
        check(
            'D5',
            '4.1 回环后条目完整',
            SEED_TITLES.every((t) => titles.includes(t)) && titles.includes('4.1 里加的一条'),
            titles.join(' / ')
        );
    }

    const passed = results.filter((r) => r.ok).length;
    const reportPath = path.join(OUT_DIR, 'interop-report.md');
    const directionOf = (id) =>
        ({ A: 'A 正向 · 我们写 → KeePassXC 读', B: 'B 反向 · KeePassXC 写 → 我们读', C: 'C 回环 · KeePassXC 改我们的库 → 我们接着读写', D: 'D 4.1 版本声明' })[
            id.charAt(0)
        ] || '-';
    fs.writeFileSync(
        reportPath,
        [
            '# M0 技术验证报告 · 与 KeePassXC 的闭环互通（G3）',
            '',
            `- 生成时间：${new Date().toISOString()}`,
            `- 第三方客户端：keepassxc-cli ${kc(['--version'], []).output.trim()}`,
            `- 结论：${passed} / ${results.length} 项通过`,
            '',
            '| 方向 | 项 | 检查 | 结果 | 说明 |',
            '|---|---|---|---|---|',
            ...results.map(
                (r) => `| ${directionOf(r.id)} | ${r.id} | ${r.name} | ${r.ok ? '通过' : '失败'} | ${r.detail || '-'} |`
            ),
            ''
        ].join('\n')
    );

    console.log(`\n结果：${passed} / ${results.length} 项通过`);
    console.log(`报告：${path.relative(process.cwd(), reportPath)}\n`);
    if (passed !== results.length) {
        process.exitCode = 1;
    }
}

main().catch((e) => {
    console.error('\n脚本异常终止：', e);
    process.exitCode = 1;
});
