/* kdbxweb 的唯一封装层。
 *
 * 架构约束（PRD §8.2）：**全项目只有这个文件可以碰 kdbxweb**。
 * 将来要换加密库（或换回自有格式），改动面被限制在这一个文件内。
 *
 * ---------------------------------------------------------------------------
 * 为什么走 <script> 而不是 import
 *
 * kdbxweb 的两个构建产物都是 UMD，且都把 `crypto` 与 `@xmldom/xmldom` 声明为外部依赖：
 *
 *     module.exports = factory(require("crypto"), require("@xmldom/xmldom"));
 *     ...
 *     else root["kdbxweb"] = factory(root["crypto"], root["@xmldom/xmldom"]);
 *
 * 交给打包器时会命中第一行：`require("crypto")` 被当成 Node 内置模块、
 * 在浏览器目标下被替换成空对象，结果是 `CryptoEngine.random()` 拿到一个没有
 * `getRandomValues` 的对象 —— 这不影响启动，只会在真正建库时才炸。
 *
 * 走 <script> 则命中最后一行，`root.crypto` 正好是浏览器的 WebCrypto 对象，
 * 也就是这个包的浏览器用法。M0 的 34 项验收就是在这条路径上跑通的。
 * 类型仍然完整：`import type` 只取类型，编译后被完全擦除，不产生运行时依赖。
 * ---------------------------------------------------------------------------
 *
 * kdbxweb 的实测行为，记在这里免得后面忘：
 *   - 写出的文件版本是 KDBX 4.0（读取上限 4.1）。显式声明 4.1 会被 KeePassXC 降回 4.0
 *   - entry.fields 是 Map，必须用 .set() / .get()。写成 entry.fields.Title = x
 *     会在 Map 实例上挂一个无用属性，字段不进库且不报错，读回全是 undefined
 *   - Kdbx.create(creds, name) 的第二个参数**既是库名（meta.name）也是默认分组名** ——
 *     create() 内部先写 meta._name，再调 createDefaultGroup()，而后者用 meta.name 命名。
 *     本应用里它长这样：顶层组「Dreamanual 密码管理」下面挂着各分类。
 *     ⚠️ 只在建库那一次是同一个值，之后是两个独立字段 —— 改库名要两个一起写（`renameVault()`）
 *   - 创建时会自动建 Recycle Bin（meta.recycleBinEnabled = true），
 *     所以 db.remove(entry) 是**移入回收站**而不是彻底删除
 *   - 加密算法读 header.dataCipherUuid.id，没有 header.cipher 这个属性 */

import type * as KdbxwebNs from 'kdbxweb';
import { argon2ImplWebview } from './argon2';
import { KDF_PRESETS, presetToKdfParams, type PresetName } from './kdf';
import { UNCATEGORIZED, type VaultEntry } from './model';
import {
    VaultFormatError,
    WrongPasswordError,
    type CreateVaultOptions,
    type EntryInput,
    type HeaderInfo,
    type VaultSessionApi
} from './session';

let argon2Installed = false;

/** kdbxweb 由 index.html 里的 <script> 挂到 window 上 */
function engine(): typeof KdbxwebNs {
    const k = window.kdbxweb;
    if (!k) {
        throw new Error('kdbxweb 未加载：检查 index.html 里的 /vendor/kdbxweb.min.js 是否被 CSP 或路径问题挡掉');
    }
    return k;
}

/** 把 webview 侧的 Argon2 实现注入 kdbxweb。幂等。 */
export function installArgon2(): void {
    if (argon2Installed) return;
    engine().CryptoEngine.setArgon2Impl(argon2ImplWebview);
    argon2Installed = true;
}

export function isArgon2Installed(): boolean {
    return argon2Installed;
}

export interface EngineInfo {
    kdfArgon2id: string;
    cipherAes: string;
    cipherChaCha20: string;
    /** random 的探针结果。走错加载路径时这里会失败，而启动阶段看不出来。 */
    randomBytes: number;
}

/** 引擎探针。除了把关键常量取出来，还真的取一次随机数 ——
 *  这条是「kdbxweb 有没有被正确加载」唯一能在启动时暴露问题的检查。 */
export function describeEngine(): EngineInfo {
    const k = engine();
    return {
        kdfArgon2id: k.Consts.KdfId.Argon2id,
        cipherAes: k.Consts.CipherId.Aes,
        cipherChaCha20: k.Consts.CipherId.ChaCha20,
        randomBytes: k.CryptoEngine.random(16).length
    };
}

// ------------------------------------------------------------------ 错误

/** 把 kdbxweb 抛出的东西收敛成本项目自己的两种错误，其余原样透传。 */
function translate(err: unknown): Error {
    const code = (err as { code?: string } | null)?.code;
    const message = err instanceof Error ? err.message : String(err);

    switch (code) {
        case 'InvalidKey':
            return new WrongPasswordError();
        case 'BadSignature':
            return new VaultFormatError('这不是一个 KDBX 文件（文件签名不匹配）');
        case 'FileCorrupt':
            return new VaultFormatError('库文件已损坏，无法解析');
        case 'InvalidVersion':
        case 'Unsupported':
            return new VaultFormatError(`这个 KDBX 版本暂不支持：${message}`);
        default:
            return err instanceof Error ? err : new Error(message);
    }
}

// ------------------------------------------------------------------ 工具

function assertArgon2(): void {
    if (!argon2Installed) throw new Error('Argon2 尚未注入：调用 kdbx 之前必须先 installArgon2()');
}

/** Uint8Array → ArrayBuffer。kdbxweb 的入参要 ArrayBuffer，直接传视图会带上多余的字节。 */
function toBufferView(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** 本地时区的 YYYY-MM-DD。KDBX 里存的是 UTC，展示按本机时间更符合直觉。 */
function dateOnly(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

const FIELD = {
    title: 'Title',
    userName: 'UserName',
    password: 'Password',
    url: 'URL',
    notes: 'Notes'
} as const;

/** 写字段。密码走 ProtectedValue —— KDBX 要求受保护字段在内存中也是加密的，
 *  明文只应该出现在界面要显示的那一刻。 */
function setField(entry: KdbxwebNs.KdbxEntry, key: string, value: string): void {
    const k = engine();
    entry.fields.set(key, key === FIELD.password ? k.ProtectedValue.fromString(value) : value);
}

function setEntryFields(entry: KdbxwebNs.KdbxEntry, data: Omit<VaultEntry, 'id' | 'group' | 'updatedAt'>): void {
    setField(entry, FIELD.title, data.title);
    setField(entry, FIELD.userName, data.userName);
    setField(entry, FIELD.password, data.password);
    setField(entry, FIELD.url, data.url);
    setField(entry, FIELD.notes, data.notes);
}

function getField(entry: KdbxwebNs.KdbxEntry, key: string): string {
    const v = entry.fields.get(key);
    if (v === undefined || v === null) return '';
    return typeof v === 'string' ? v : v.getText();
}

/** KDBX 的条目可以带自定义字段（KeePassXC 的「高级 → 自定义字段」）。
 *  PRD §3.3 决定本应用不做自定义字段，但从第三方库读进来的条目可能有。
 *  这里把它们的名字单独列出来，界面在详情页提一句，避免静默丢信息。 */
function extraFieldNames(entry: KdbxwebNs.KdbxEntry): string[] {
    const known = new Set<string>(Object.values(FIELD));
    return [...entry.fields.keys()].filter((name) => !known.has(name));
}

// ------------------------------------------------------------------ KDF

/** 把档位参数写进文件头。参数随文件走，换任何客户端都能正确解锁。 */
function applyKdf(db: KdbxwebNs.Kdbx, preset: PresetName): void {
    const k = engine();
    const params = presetToKdfParams(KDF_PRESETS[preset]);

    db.setKdf(k.Consts.KdfId.Argon2id);
    const p = db.header.kdfParameters!;
    const salt = k.CryptoEngine.random(params.saltBytes);
    p.set('S', k.VarDictionary.ValueType.Bytes, toBufferView(salt));
    p.set('P', k.VarDictionary.ValueType.UInt32, params.parallelism);
    p.set('M', k.VarDictionary.ValueType.UInt32, params.memoryBytes);
    p.set('I', k.VarDictionary.ValueType.UInt32, params.iterations);
    p.set('V', k.VarDictionary.ValueType.UInt32, params.version);
}

// ------------------------------------------------------------------ 会话

/**
 * 一个已解锁的库。
 *
 * 这是本文件对外唯一的门面：视图层拿到的只有 VaultEntry / string[]，
 * 看不到 kdbxweb 的任何类型。所有改动都作用在内存中的 Kdbx 实例上，
 * **不自动落盘** —— 什么时候写、写到哪，由 store 决定。
 */
export class VaultSession implements VaultSessionApi {
    private constructor(
        private readonly db: KdbxwebNs.Kdbx,
        private readonly credentials: KdbxwebNs.Credentials
    ) {}

    // -------------------------------------------------------------- 打开

    static async create(opts: CreateVaultOptions): Promise<VaultSession> {
        assertArgon2();
        const k = engine();

        const credentials = new k.Credentials(k.ProtectedValue.fromString(opts.password));
        const db = k.Kdbx.create(credentials, opts.name);
        applyKdf(db, opts.preset);

        // Kdbx.create 已经把顶层组命名为库名，这里只补分类
        const session = new VaultSession(db, credentials);
        for (const name of opts.groups ?? []) {
            const trimmed = name.trim();
            if (trimmed && !session.hasGroup(trimmed)) db.createGroup(db.getDefaultGroup(), trimmed);
        }
        // 未分类始终存在 —— 新建条目时分类留空就落在这里（PRD §3.4）
        session.ensureGroup(UNCATEGORIZED);

        return session;
    }

    static async open(bytes: ArrayBuffer, password: string): Promise<VaultSession> {
        assertArgon2();
        const k = engine();

        if (bytes.byteLength === 0) throw new VaultFormatError('库文件是空的');

        try {
            const credentials = new k.Credentials(k.ProtectedValue.fromString(password));
            const db = await k.Kdbx.load(bytes, credentials);
            const session = new VaultSession(db, credentials);
            // 有的第三方库没有回收站，补一个：本应用的「删除」语义依赖它
            if (!db.meta.recycleBinUuid) db.createRecycleBin();
            return session;
        } catch (err) {
            throw translate(err);
        }
    }

    /**
     * 换主密码（F7.5）。kdbxweb 的 credentials 是引用语义，改完下一次 save 就是新密钥。
     *
     * 注意两件事：
     * 1. **这里不校验旧密码。** `setPassword` 对任何字符串都成功 —— 新密钥只由
     *    这一串决定，与旧的那个无关。所以「旧密码输错了」在调用这一句之前就该被拦住
     *    （`store.ts` 的 `rebuild()` 先拿旧密码去 load 当前磁盘字节）。
     * 2. **改了之后内存与磁盘就分叉了。** 写盘失败时调用方要把会话回滚，
     *    否则用户以为密码没改成，实际上内存里已经是新的了。
     */
    async changeMasterPassword(next: string): Promise<void> {
        const k = engine();
        await this.credentials.setPassword(k.ProtectedValue.fromString(next));
        this.db.credentials = this.credentials;
    }

    /**
     * 换 KDF 档位（F7.6）。
     *
     * KDBX 把 KDF 参数写在文件头、由文件自己携带，所以换档就是改文件头再整库重加密。
     * 参数一次全量重写（含新盐）：只调内存量而沿用旧盐，等于在同一份盐上换档，
     * 没有理由这么省。
     *
     * 与建库走同一个 `applyKdf()` —— 两处若各写一遍，迟早有一处漏掉某个字段，
     * 而漏掉的后果是文件在别的客户端里解不开。
     */
    applyPreset(preset: PresetName): void {
        applyKdf(this.db, preset);
    }

    // -------------------------------------------------------------- 元信息

    get name(): string {
        return this.db.meta.name ?? '';
    }

    /**
     * 改库名。
     *
     * KDBX 里库名落在**两个字段**上：`meta.name`（本应用读它做侧栏底栏与导出文件名）
     * 与顶层分组的 `name`。`Kdbx.create()` 当初用同一个参数把两者一起初始化，
     * 之后各改各的、不会联动，所以这里必须一起写。
     *
     * 漏写一处的后果是名字脱钩：只写 `meta.name` 时侧栏变了，而直接挂在根组下的
     * 条目在编辑器里读到的「分类」还是旧名（`views/editor.ts` 的 `categoryOptions`
     * 那句注释讲的就是它）；只写分组名则反过来，别的客户端看到新名、本应用看到旧名。
     *
     * 改的是加密体内部的元信息，下一次 `toBytes()` 就带上新名。换主密码（F7.5）与
     * 换 KDF 档（F7.6）要重建整个库，那两条另走 `store.ts` 的 `rebuild()`。
     */
    renameVault(name: string): string {
        const trimmed = name.trim();
        if (!trimmed) throw new Error('库名不能为空');

        this.db.meta.name = trimmed;
        this.db.getDefaultGroup().name = trimmed;
        return trimmed;
    }

    header(): HeaderInfo {
        const p = this.db.header.kdfParameters!;
        const memoryMiB = Number(p.get('M')) / 1024 / 1024;
        const iterations = Number(p.get('I'));
        const parallelism = Number(p.get('P'));
        const cipherId = this.db.header.dataCipherUuid?.id;

        const matched = (Object.keys(KDF_PRESETS) as PresetName[]).find(
            (name) => KDF_PRESETS[name].memoryMiB === memoryMiB
        );

        return {
            version: `${this.db.header.versionMajor}.${this.db.header.versionMinor}`,
            memoryMiB,
            iterations,
            parallelism,
            preset: matched ?? null,
            cipher:
                cipherId === engine().Consts.CipherId.Aes
                    ? 'AES-256-CBC'
                    : cipherId === engine().Consts.CipherId.ChaCha20
                      ? 'ChaCha20'
                      : String(cipherId)
        };
    }

    // -------------------------------------------------------------- 分类

    private root(): KdbxwebNs.KdbxGroup {
        return this.db.getDefaultGroup();
    }

    /** 回收站：删除的条目的去处，不计入分类 */
    private recycleBin(): KdbxwebNs.KdbxGroup | undefined {
        const uuid = this.db.meta.recycleBinUuid;
        return uuid ? this.db.getGroup(uuid) : undefined;
    }

    /** 分类列表（不含回收站）。按名称排序，与列表的排序口径一致。 */
    groups(): string[] {
        const bin = this.recycleBin();
        return this.root()
            .groups.filter((g) => !bin || !g.uuid.equals(bin.uuid))
            .map((g) => g.name ?? '')
            .filter(Boolean)
            .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    }

    hasGroup(name: string): boolean {
        return this.root().groups.some((g) => g.name === name);
    }

    private groupByName(name: string): KdbxwebNs.KdbxGroup | undefined {
        return this.root().groups.find((g) => g.name === name);
    }

    /** 取分类，不存在就建一个 */
    ensureGroup(name: string): KdbxwebNs.KdbxGroup {
        const wanted = name.trim() || UNCATEGORIZED;
        return this.groupByName(wanted) ?? this.db.createGroup(this.root(), wanted);
    }

    createGroup(name: string): string {
        const trimmed = name.trim();
        if (!trimmed) throw new Error('分类名不能为空');
        if (trimmed === UNCATEGORIZED) return trimmed;
        if (this.hasGroup(trimmed)) throw new Error(`分类「${trimmed}」已存在`);
        this.db.createGroup(this.root(), trimmed);
        return trimmed;
    }

    /** 改名。分类下的条目跟着走 —— 条目挂在组对象上，改的是组自己的名字。 */
    renameGroup(from: string, to: string): string {
        const target = this.groupByName(from);
        if (!target) throw new Error(`找不到分类「${from}」`);
        const trimmed = to.trim();
        if (!trimmed) throw new Error('分类名不能为空');
        if (trimmed !== from && this.hasGroup(trimmed)) throw new Error(`分类「${trimmed}」已存在`);
        if (from === UNCATEGORIZED) throw new Error('「未分类」不能改名');

        target.name = trimmed;
        return trimmed;
    }

    /** 删分类。**里面的条目移入「未分类」**，不跟着删（PRD §3.4）。 */
    removeGroup(name: string): void {
        if (name === UNCATEGORIZED) throw new Error('「未分类」不能删除');
        const target = this.groupByName(name);
        if (!target) throw new Error(`找不到分类「${name}」`);

        const fallback = this.ensureGroup(UNCATEGORIZED);
        for (const entry of [...target.entries]) this.db.move(entry, fallback);
        // 嵌套子组一并搬到未分类，避免组里还藏着看不见的条目
        for (const child of [...target.groups]) this.db.move(child, fallback);
        this.db.remove(target);
    }

    // -------------------------------------------------------------- 条目

    private index(): Map<string, KdbxwebNs.KdbxEntry> {
        const map = new Map<string, KdbxwebNs.KdbxEntry>();
        for (const entry of this.root().allEntries()) map.set(entry.uuid.id, entry);
        return map;
    }

    private toVaultEntry(entry: KdbxwebNs.KdbxEntry): VaultEntry {
        return {
            id: entry.uuid.id,
            title: getField(entry, FIELD.title),
            userName: getField(entry, FIELD.userName),
            password: getField(entry, FIELD.password),
            url: getField(entry, FIELD.url),
            notes: getField(entry, FIELD.notes),
            group: entry.parentGroup?.name ?? UNCATEGORIZED,
            updatedAt: dateOnly(entry.times.lastModTime ?? new Date())
        };
    }

    /**
     * 全部条目。回收站里的不算 —— 回收站是「已删除」的去处，
     * 混进列表会让分类计数和搜索都变得没法解释。
     */
    entries(): VaultEntry[] {
        const bin = this.recycleBin();
        const out: VaultEntry[] = [];
        for (const entry of this.root().allEntries()) {
            if (bin && entry.parentGroup && entry.parentGroup.uuid.equals(bin.uuid)) continue;
            out.push(this.toVaultEntry(entry));
        }
        return out;
    }

    /** 回收站里的条目数，界面在设置里提一句 */
    trashCount(): number {
        const bin = this.recycleBin();
        return bin ? [...bin.allEntries()].length : 0;
    }

    createEntry(input: EntryInput): VaultEntry {
        const group = this.ensureGroup(input.group);
        const entry = this.db.createEntry(group);
        setEntryFields(entry, input);
        entry.times.update();
        return this.toVaultEntry(entry);
    }

    updateEntry(input: VaultEntry): VaultEntry {
        const entry = this.index().get(input.id);
        if (!entry) throw new Error('这条记录已经不在库里了，可能已在别处被删除');

        setEntryFields(entry, input);

        const current = entry.parentGroup?.name ?? UNCATEGORIZED;
        if (current !== input.group) this.db.move(entry, this.ensureGroup(input.group));

        entry.times.update();
        return this.toVaultEntry(entry);
    }

    /** 移入回收站。KDBX 的删除语义就是这样，`db.remove` 内部按 meta 决定去向。 */
    removeEntry(id: string): void {
        const entry = this.index().get(id);
        if (!entry) throw new Error('这条记录已经不在库里了');
        this.db.remove(entry);
    }

    /** 这条条目有没有界面没展示的额外字段，供详情页提示 */
    extraFieldsOf(id: string): string[] {
        const entry = this.index().get(id);
        return entry ? extraFieldNames(entry) : [];
    }

    // -------------------------------------------------------------- 落盘

    /** 序列化成 KDBX 字节。写到哪里由调用方决定。 */
    async toBytes(): Promise<ArrayBuffer> {
        return this.db.save();
    }
}
