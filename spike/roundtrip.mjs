/**
 * M0 技术验证 · 第 1 步：kdbxweb + Argon2id 读写 .kdbx 往返
 *
 * 目的：在进入任何 Tauri / UI 工作之前，先把最不可逆的一环钉死——
 *   我们写出来的 .kdbx，KeePassXC 到底能不能打开。
 *
 * 覆盖的验收项：
 *   G1  磁盘上无明文（扫描 .kdbx 字节）
 *   G2  加密逻辑全部来自第三方库（本文件不含任何 crypto 原语）
 *   G3  生成标准 KDBX，可被第三方客户端打开（见 interop.mjs 自动验收）
 *   F1.2 错误主密码以解密失败判定，不存校验值
 *   §4.2 Argon2 解锁耗时实测
 *
 * 两个容易踩的坑，已在此文件里固化正确写法：
 *   1. kdbxweb 2.x 的 entry.fields 是 Map，不是普通对象。
 *      README 里的 `entry.fields.Title = x` 写法在 2.x 上无效：
 *      它只会在 Map 实例上挂一个无用属性，字段不会进库（且不报错）。
 *   2. header 上获取加密算法用 dataCipherUuid.id，没有 header.cipher 这个属性。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import kdbxwebModule from 'kdbxweb';
import { installArgon2, backendName } from './lib/argon2-node.mjs';
import { KDF_PRESETS, DEFAULT_PRESET, presetToKdfParams } from './kdf-presets.mjs';

const kdbxweb = kdbxwebModule.Kdbx ? kdbxwebModule : kdbxwebModule.default;
const { Kdbx, Credentials, ProtectedValue, Consts, VarDictionary } = kdbxweb;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'out');

export const MASTER_PASSWORD = 'correct horse battery staple 上海';
export const VAULT_NAME = 'Dreamanual 密码管理';
export const VAULT_PATH = path.join(OUT_DIR, 'vault.kdbx');

// Argon2id 参数。M 必须是 1024 的整数倍（kdbxweb 会校验），单位字节。
// 档位定义在 kdf-presets.mjs，那里是唯一来源；这里只取新建库用的默认档。
export const KDF = presetToKdfParams(KDF_PRESETS[DEFAULT_PRESET]);
export const KDF_PRESET_NAME = DEFAULT_PRESET;

export const CATEGORIES = ['服务器', '办公', '数据库'];

// KDBX 规范里条目字符串字段的固定键名，与 PRD §3.2 一致
export const FIELD_KEYS = ['Title', 'UserName', 'Password', 'URL', 'Notes'];

const SEED = [
    {
        group: '服务器',
        Title: '公司 VPN',
        UserName: 'demo.user',
        Password: 'Vpn!2026#Lab',
        URL: 'https://vpn.example.com',
        Notes: '用途：外网接入办公网\n申请单号：SEC-2026-0417\n负责人：张三'
    },
    {
        group: '服务器',
        Title: '堡垒机-生产',
        UserName: 'ops@example.com',
        Password: 'Bast!on#Prod9',
        URL: '',
        Notes: 'IP：192.0.2.40\n端口：2222\n连接命令：ssh -p 2222 demo.ops@192.0.2.40'
    },
    {
        group: '办公',
        Title: '短信平台后台',
        UserName: 'sms-admin',
        Password: 'Sms@Platform7',
        URL: 'https://sms.example.net/admin',
        Notes: '备注：仅内网可访问\n有效期至 2026-12-31'
    }
];

const results = [];

function check(id, name, ok, detail = '') {
    results.push({ id, name, ok, detail });
    console.log(`  [${ok ? '通过' : '失败'}] ${id} ${name}${detail ? ` — ${detail}` : ''}`);
}

export function toBufferView(u8) {
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

/**
 * 直接读文件头的版本号：签名占 0-7，随后是 versionMinor（uint16 LE）、
 * versionMajor（uint16 LE）。用于确认第三方客户端保存后是否升级了格式版本。
 */
export function kdbxVersionOf(buffer) {
    return { minor: buffer.readUInt16LE(8), major: buffer.readUInt16LE(10) };
}

/** 原子写：临时文件 → fsync → rename 覆盖 */
function atomicWrite(filePath, arrayBuffer) {
    const tmp = `${filePath}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
        fs.writeFileSync(fd, Buffer.from(arrayBuffer));
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
}

/** 把一组 KDF 参数写进文件头。`params` 默认取新建库那一档 ——
 *  传别的档给它，就是「在已有库上换档」（F7.6），应用侧走的是同一个函数
 *  （`src/vault/kdbx.ts` 的 `applyKdf`）。 */
export function applyKdf(db, params = KDF) {
    db.setKdf(Consts.KdfId.Argon2id);
    const p = db.header.kdfParameters;
    const salt = kdbxweb.CryptoEngine.random(params.saltBytes);
    p.set('S', VarDictionary.ValueType.Bytes, toBufferView(salt));
    p.set('P', VarDictionary.ValueType.UInt32, params.parallelism);
    p.set('M', VarDictionary.ValueType.UInt32, params.memoryBytes);
    p.set('I', VarDictionary.ValueType.UInt32, params.iterations);
    p.set('V', VarDictionary.ValueType.UInt32, params.version);
}

export function setField(entry, key, value) {
    entry.fields.set(key, key === 'Password' ? ProtectedValue.fromString(value) : value);
}

export function getField(entry, key) {
    const v = entry.fields.get(key);
    if (v === undefined || v === null) {
        return '';
    }
    return typeof v === 'string' ? v : v.getText();
}

function buildDatabase(versionMinor) {
    const credentials = new Credentials(ProtectedValue.fromString(MASTER_PASSWORD));
    const db = Kdbx.create(credentials, VAULT_NAME);
    if (versionMinor !== undefined) {
        // kdbxweb 默认写 4.0（DefaultMinorVersions[4] = 0），
        // 但读的上限是 4.1（LastMinorVersions[4] = 1），所以 4.1 可以显式声明
        db.header.versionMinor = versionMinor;
    }
    applyKdf(db);

    const root = db.getDefaultGroup();
    const groups = new Map(CATEGORIES.map((name) => [name, db.createGroup(root, name)]));

    for (const seed of SEED) {
        const entry = db.createEntry(groups.get(seed.group));
        setField(entry, 'Title', seed.Title);
        setField(entry, 'UserName', seed.UserName);
        setField(entry, 'Password', seed.Password);
        setField(entry, 'URL', seed.URL);
        setField(entry, 'Notes', seed.Notes);
        entry.times.update();
    }

    return { db, credentials };
}

export function describeHeader(db) {
    const p = db.header.kdfParameters;
    const cipherId = db.header.dataCipherUuid && db.header.dataCipherUuid.id;
    return {
        version: `${db.header.versionMajor}.${db.header.versionMinor}`,
        cipherId,
        cipher:
            cipherId === Consts.CipherId.Aes
                ? 'AES-256-CBC'
                : cipherId === Consts.CipherId.ChaCha20
                  ? 'ChaCha20'
                  : `未知 (${cipherId})`,
        compression: db.header.compression === 1 ? 'GZip' : 'None',
        crs: db.header.crsAlgorithm === Consts.CrsAlgorithm.ChaCha20 ? 'ChaCha20' : String(db.header.crsAlgorithm),
        kdfUuid: Buffer.from(p.get('$UUID')).toString('base64'),
        memoryMiB: p.get('M') / 1024 / 1024,
        iterations: p.get('I'),
        parallelism: p.get('P'),
        version0x: `0x${Number(p.get('V')).toString(16)}`,
        saltLen: p.get('S').byteLength
    };
}

/** 排除 Kdbx.create 预置的 Recycle Bin，只返回本应用定义的分类 */
export function appGroups(db) {
    return db
        .getDefaultGroup()
        .groups.filter((g) => g.name !== Consts.Defaults.RecycleBinName)
        .map((g) => g.name)
        .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

export function readAllEntries(db) {
    return [...db.getDefaultGroup().allEntries()].map((entry) => ({
        group: entry.parentGroup ? entry.parentGroup.name : '',
        Title: getField(entry, 'Title'),
        UserName: getField(entry, 'UserName'),
        Password: getField(entry, 'Password'),
        URL: getField(entry, 'URL'),
        Notes: getField(entry, 'Notes')
    }));
}

function scanPlaintext(bytes) {
    const needles = [
        MASTER_PASSWORD,
        ...SEED.flatMap((s) => [s.Title, s.UserName, s.Password, s.URL, s.Notes]).filter(Boolean),
        '192.0.2.40',
        '堡垒机',
        '申请单号'
    ].filter(Boolean);

    return {
        probed: needles.length,
        hits: needles.filter((n) => bytes.includes(Buffer.from(n, 'utf8')))
    };
}

export async function buildAndSave(options = {}) {
    const { outPath = VAULT_PATH, versionMinor } = options;
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const { db, credentials } = buildDatabase(versionMinor);
    atomicWrite(outPath, await db.save());
    return { db, credentials };
}

async function main() {
    console.log(`\nArgon2 后端：${backendName()}`);
    installArgon2(kdbxweb);

    console.log('\n阶段 1 · 建库并写入');
    const { db, credentials } = await buildAndSave();
    check('S1', '建库成功', !!db, `库名「${VAULT_NAME}」`);

    const fieldKeys = [...[...db.getDefaultGroup().allEntries()][0].fields.keys()];
    check(
        'S2',
        '条目默认字段集与 PRD §3.2 的 5 个字段一致',
        FIELD_KEYS.every((k) => fieldKeys.includes(k)) && fieldKeys.length === FIELD_KEYS.length,
        fieldKeys.join(' / ')
    );

    const groups = appGroups(db);
    check(
        'S3',
        `写入 ${CATEGORIES.length} 个分类（Recycle Bin 由库自动预置，不计入）`,
        groups.length === CATEGORIES.length,
        groups.join(' / ')
    );
    check('S4', `写入 ${SEED.length} 条条目`, db.getDefaultGroup().allEntries ? [...db.getDefaultGroup().allEntries()].length === SEED.length : false);

    console.log('\n阶段 2 · 保存落盘');
    const fileSize = fs.statSync(VAULT_PATH).size;
    check('S5', '保存并原子落盘', fileSize > 0, `${fileSize} 字节`);

    console.log('\n阶段 3 · 文件头核对');
    const header = describeHeader(db);
    for (const [k, v] of Object.entries(header)) {
        console.log(`  ${k.padEnd(12)}${v}`);
    }
    check('S6', '版本为 KDBX 4.x', header.version.startsWith('4.'), header.version);
    check('S7', 'KDF 为 Argon2id', header.kdfUuid === Consts.KdfId.Argon2id, header.kdfUuid);
    check('S8', '加密算法 AES-256-CBC', header.cipher === 'AES-256-CBC', header.cipher);

    console.log('\n阶段 4 · 读回并逐字段比对（解锁耗时实测）');
    const loadStart = Date.now();
    const reopened = await Kdbx.load(toBufferView(fs.readFileSync(VAULT_PATH)), credentials);
    const loadMs = Date.now() - loadStart;
    console.log(
        `  解锁耗时 ${loadMs} ms（Argon2 ${header.memoryMiB} MiB / ${header.iterations} 轮 / 并行度 ${header.parallelism}）`
    );

    const actual = readAllEntries(reopened);
    const byTitle = new Map(actual.map((e) => [e.Title, e]));
    const mismatches = [];
    for (const want of SEED) {
        const got = byTitle.get(want.Title);
        if (!got) {
            mismatches.push(`缺少条目「${want.Title}」`);
            continue;
        }
        for (const key of ['Title', 'UserName', 'Password', 'URL', 'Notes', 'group']) {
            const w = want[key] ?? '';
            const g = got[key] ?? '';
            if (w !== g) {
                mismatches.push(`${want.Title}.${key}: 期望「${w}」实得「${g}」`);
            }
        }
    }
    check(
        'S9',
        '全部字段往返一致（含多行中文备注）',
        mismatches.length === 0,
        mismatches.length ? mismatches.join('; ') : `${SEED.length} 条 × 6 字段`
    );

    console.log('\n阶段 5 · 明文泄露扫描（G1）');
    const scan = scanPlaintext(fs.readFileSync(VAULT_PATH));
    check(
        'S10',
        '磁盘上搜不到任何明文凭据',
        scan.hits.length === 0,
        scan.hits.length ? `命中：${scan.hits.join(', ')}` : `已探测 ${scan.probed} 个关键词`
    );

    console.log('\n阶段 6 · 错误主密码判定（F1.2）');
    let wrongCode = null;
    try {
        await Kdbx.load(
            toBufferView(fs.readFileSync(VAULT_PATH)),
            new Credentials(ProtectedValue.fromString(`${MASTER_PASSWORD}x`))
        );
    } catch (e) {
        wrongCode = (e && e.code) || e.constructor.name;
    }
    check('S11', '错误主密码被拒绝且报错可识别', wrongCode !== null, `code = ${wrongCode}`);

    console.log('\n阶段 7 · 二次写入（改库后再读）');
    const target = reopened.getDefaultGroup().groups.find((g) => g.name === '数据库');
    const added = reopened.createEntry(target);
    setField(added, 'Title', '生产库-MySQL');
    setField(added, 'UserName', 'root');
    setField(added, 'Password', 'Mysql@Prod1');
    setField(added, 'Notes', 'IP：192.0.2.41\n端口：3306');
    added.times.update();
    atomicWrite(VAULT_PATH, await reopened.save());
    const third = await Kdbx.load(toBufferView(fs.readFileSync(VAULT_PATH)), credentials);
    const titles = readAllEntries(third)
        .map((e) => e.Title)
        .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    check(
        'S12',
        '二次写入后可读回，条目全在',
        titles.length === SEED.length + 1 && titles.includes('生产库-MySQL'),
        titles.join(' / ')
    );

    // ---------------------------------------------------------------- 阶段 8 · 换档
    //
    // 「在已有库上换 KDF 档」（F7.6）走的是 `db.setKdf()` 这条路径，与建库时写参数
    // 不同：kdbxweb 的 `Kdbx.setKdf` 会把 `meta.headerHash` 清掉，并换一套新的
    // kdfParameters。漏了任何一步，症状都是「文件在别的客户端里解不开」——
    // 而应用自己解得开，因为它用的是内存里那份会话。
    //
    // 这里换到「流畅」再换回默认档，验两件事：换过去之后文件头报的是新参数、
    // 条目一条不少；换回来之后仍然能开（换档是可逆的，不是单向门）。
    console.log('\n阶段 8 · 在已有库上换 KDF 档（F7.6）');
    const lightParams = presetToKdfParams(KDF_PRESETS['流畅']);
    applyKdf(third, lightParams);
    atomicWrite(VAULT_PATH, await third.save());

    const afterSwap = await Kdbx.load(toBufferView(fs.readFileSync(VAULT_PATH)), credentials);
    const swappedHeader = describeHeader(afterSwap);
    const swappedEntries = readAllEntries(afterSwap).length;
    check(
        'S13',
        '换档之后，磁盘上那份的头报的是新参数、条目一条不少',
        swappedHeader.memoryMiB === KDF_PRESETS['流畅'].memoryMiB &&
            swappedEntries === titles.length,
        `内存 ${header.memoryMiB} → ${swappedHeader.memoryMiB} MiB · 条目 ${swappedEntries}`
    );

    // 反向对照：只断言「换过去能开」的话，一个把参数写在别处、实际仍按旧档派生的
    // 实现也能过。换回来之后必须仍是新档的参数、且仍能开。
    applyKdf(afterSwap, KDF);
    atomicWrite(VAULT_PATH, await afterSwap.save());
    const backHome = await Kdbx.load(toBufferView(fs.readFileSync(VAULT_PATH)), credentials);
    const homeHeader = describeHeader(backHome);
    check(
        'S14',
        '换回默认档后仍能开，参数回到 256 MiB（换档可逆）',
        homeHeader.memoryMiB === header.memoryMiB &&
            readAllEntries(backHome).length === titles.length,
        `内存 ${swappedHeader.memoryMiB} → ${homeHeader.memoryMiB} MiB · 条目 ${readAllEntries(backHome).length}`
    );

    // ------------------------------------------------------------ 库名落在两个字段上
    //
    // 应用侧的 `renameVault()` 把 `meta.name` 与默认分组名一起写，依据就是 S16 这条：
    // 只改一个，另一个不动。这里把前提本身也断言掉，免得哪天 kdbxweb 把它们联动了、
    // 而应用侧还按「两个都要写」的逻辑跑（那时会多写一次无害的赋值，但注释就成了错的）。
    //
    // 放在最后：下面这两步会改内存里的 `db.meta.name`，前面的断言不该被它影响。

    check(
        'S15',
        'Kdbx.create() 的 name 同时写进 meta.name 与默认分组名',
        db.meta.name === VAULT_NAME && db.getDefaultGroup().name === VAULT_NAME,
        `meta.name「${db.meta.name}」· 默认分组「${db.getDefaultGroup().name}」`
    );

    db.meta.name = '只改 meta.name';
    check(
        'S16',
        '单独改 meta.name 不会带动默认分组名（所以改名要两个一起写）',
        db.getDefaultGroup().name === VAULT_NAME,
        `meta.name → 「${db.meta.name}」· 默认分组仍为「${db.getDefaultGroup().name}」`
    );

    const passed = results.filter((r) => r.ok).length;
    const reportPath = path.join(OUT_DIR, 'report.md');
    fs.writeFileSync(
        reportPath,
        [
            '# M0 技术验证报告 · Node 侧 kdbx 往返',
            '',
            `- 生成时间：${new Date().toISOString()}`,
            `- Argon2 后端：${backendName()}`,
            `- 库文件：out/vault.kdbx（${fs.statSync(VAULT_PATH).size} 字节）`,
            `- 解锁耗时：${loadMs} ms（Argon2 ${header.memoryMiB} MiB / ${header.iterations} 轮 / 并行度 ${header.parallelism}）`,
            `- 结论：${passed} / ${results.length} 项通过`,
            '',
            '| 项 | 检查 | 结果 | 说明 |',
            '|---|---|---|---|',
            ...results.map((r) => `| ${r.id} | ${r.name} | ${r.ok ? '通过' : '失败'} | ${r.detail || '-'} |`),
            '',
            '## 文件头',
            '',
            '| 字段 | 值 |',
            '|---|---|',
            `| 版本 | ${header.version} |`,
            `| 加密算法 | ${header.cipher} |`,
            `| 压缩 | ${header.compression} |`,
            `| 内层随机流 | ${header.crs} |`,
            `| KDF UUID | ${header.kdfUuid} |`,
            `| Argon2 内存 | ${header.memoryMiB} MiB |`,
            `| Argon2 迭代 | ${header.iterations} |`,
            `| Argon2 并行度 | ${header.parallelism} |`,
            `| Argon2 版本 | ${header.version0x} |`,
            `| 盐长度 | ${header.saltLen} 字节 |`,
            ''
        ].join('\n')
    );

    console.log(`\n结果：${passed} / ${results.length} 项通过`);
    console.log(`报告：${path.relative(process.cwd(), reportPath)}`);
    console.log(`库文件：${path.relative(process.cwd(), VAULT_PATH)}\n`);

    if (passed !== results.length) {
        process.exitCode = 1;
    }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    main().catch((e) => {
        console.error('\n脚本异常终止：', e);
        process.exitCode = 1;
    });
}
