/* 库会话与写盘调度。
 *
 * 这一层是「界面」与「加密库」之间的接线板，职责有三：
 *
 * 1. 持有当前的 VaultSessionApi 与库文件路径，界面不必知道文件在哪
 * 2. 把同一轮里的多次改动**合并成一次写盘** —— 新建条目时会连着建分类，
 *    分开写就是两次全量加密 + 两次落盘
 * 3. 把保存状态广播出去，让界面能显示「保存中 / 已保存 / 保存失败」
 *
 * 写库失败不阻塞操作：改动留在内存里的会话对象上，界面持续显示失败状态，
 * 下一次任何改动都会把**全部**改动一起写下去（KDBX 是整体加密的，没有增量写）。
 * 所以失败只意味着延迟，不意味着丢数据。 */

import {
    IN_TAURI,
    backupRun,
    vaultDefaultPath,
    vaultInfo,
    vaultRead,
    vaultSave,
    vaultSetPath,
    vaultWrite,
    lockArm,
    lockDisarm,
    settingsGet,
    reportError,
    type BackupRun,
    type VaultInfo
} from '../host';
import { VaultSession } from './kdbx';
import { DEFAULT_PRESET, KDF_PRESETS, type PresetName } from './kdf';
import { UNCATEGORIZED, type VaultEntry } from './model';
import type { EntryInput, VaultSessionApi } from './session';

/** 建库时预置的分类（PRD §3.4）。「未分类」由会话保证存在，不写在这里。 */
export const DEFAULT_GROUPS = ['服务器', '办公', '数据库'];

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export interface VaultStatus {
    /** 库文件路径。浏览器预览下是占位文字 */
    path: string;
    exists: boolean;
    size: number;
    modifiedAt: number | null;
    /** 库位置来自配置（走过一次「打开其他库」），不是默认位置 */
    configured: boolean;
    saveState: SaveState;
    /** 上次成功写入的时间，epoch 毫秒 */
    savedAt: number | null;
    /** 上次失败原因；成功后清空 */
    error: string | null;
    /** 最近一次保存附带的备份结果。
     *
     *  与 `saveState` 分开：备份失败**不代表保存失败**。库在那个时点已经写进磁盘了，
     *  把两件事合成一个状态，就会出现「保存失败」的提示 —— 用户会以为刚做的改动没了。 */
    backup: BackupRun | null;
}

export type StatusListener = (status: VaultStatus) => void;

/** 两个路径是不是同一个位置。
 *
 *  比对前做 NFC 归一化：macOS 的文件对话框可能回传 NFD 形式的文件名，
 *  而 Rust 侧拼出来的默认路径是 NFC 的 —— 不归一化的话，
 *  「密码管理」四个字会被判成两个不同的目录。末尾斜杠同理。 */
function samePath(a: string, b: string): boolean {
    const norm = (p: string): string => p.normalize('NFC').replace(/\/+$/, '');
    return norm(a) === norm(b);
}

export { samePath };

export interface CreateRequest {
    password: string;
    name: string;
    preset?: PresetName;
    groups?: string[];
    /** 库文件落到哪里。**必填**。
     *
     *  原先是可选，不传就走「当前库位置」—— 而「当前库位置」是配置优先的，
     *  所以换过一次库之后，建库会落到上一次打开的那个库里。用户看到的现象是
     *  「新建库没让我选地址」，实际落点却由一次无关的历史操作决定。
     *  改成必填之后，落点与历史状态脱钩。 */
    path: string;
}

export class VaultStore {
    private api: VaultSessionApi | null = null;
    private filePath: string | null = null;
    private label = '';

    private exists = false;
    private size = 0;
    private modifiedAt: number | null = null;
    /** 库位置来自配置（走过一次「打开其他库」），不是默认位置 */
    private configured = false;

    private saveState: SaveState = 'idle';
    private savedAt: number | null = null;
    private error: string | null = null;
    private backup: BackupRun | null = null;

    /** 有改动还没写出去。
     *
     *  语义严格限定成「会话改过、写盘还没跟上」，**不是**「save() 被调过」：
     *
     *  - `touch()` 置位；`drain()` 在每轮动笔之前清掉
     *  - 写盘期间又被 `touch()` 置位，`drain` 会接着写下一轮
     *
     *  收窄这一点是关键。早先 `save()` 无条件置位，于是「改动方法内部触发的
     *  一次」+「调用方 `await save()` 确认落盘的再一次」会让 drain 写两轮 ——
     *  第二轮的会话状态与第一轮完全一样，但 `toBytes()` 产出的字节每次都不同
     *  （KDBX 的 masterSeed 与各 IV 是新生成的），备份侧那条「内容未变就跳过」
     *  的守卫因此失效：每保存一次就多轮转一份历史版本，把真正该留下的顶掉。
     *
     *  但 `save()` 本身**不能**因为「没有改动」就不写 —— 会话是公开的
     *  （`session()` 直接返回），有些路径会绕过 `touch()` 直接改它，例如验收里
     *  批量灌 500 条那一段。那些改动同样需要一次 `save()` 才能落盘。 */
    private dirty = false;
    private writer: Promise<void> | null = null;

    private listeners = new Set<StatusListener>();

    /** 上一次解锁的耗时（含读文件 + KDF + 解密解析），毫秒 */
    lastUnlockMs: number | null = null;

    /** 上一次新建库的耗时，毫秒 */
    lastCreateMs: number | null = null;

    // ------------------------------------------------------------ 状态广播

    subscribe(fn: StatusListener): () => void {
        this.listeners.add(fn);
        fn(this.status());
        return () => this.listeners.delete(fn);
    }

    status(): VaultStatus {
        return {
            path: this.filePath ?? this.label,
            exists: this.exists,
            size: this.size,
            modifiedAt: this.modifiedAt,
            configured: this.configured,
            saveState: this.saveState,
            savedAt: this.savedAt,
            error: this.error,
            backup: this.backup
        };
    }

    /** 把宿主回报的库文件状态整份吸收进来。
     *  不逐字段挑着更新 —— 库换了之后留下上一个库的字节数，比没有更糟。 */
    private absorb(info: VaultInfo): void {
        this.filePath = info.path;
        this.label = info.path;
        this.exists = info.exists;
        this.size = info.size;
        this.modifiedAt = info.modifiedAt;
        this.configured = info.configured;
    }

    private notify(): void {
        const s = this.status();
        for (const fn of this.listeners) fn(s);
    }

    // ------------------------------------------------------------ 探测与开关

    /** 库文件在不在、多大。界面据此在「解锁」与「新建」之间分流。 */
    async probe(path?: string): Promise<VaultInfo> {
        const info = await vaultInfo(path);
        this.absorb(info);
        this.notify();
        return info;
    }

    isOpen(): boolean {
        return this.api !== null;
    }

    /** 已解锁的会话。未解锁时抛错，避免界面拿着 null 到处判空。 */
    session(): VaultSessionApi {
        if (!this.api) throw new Error('保险箱还没有解锁');
        return this.api;
    }

    get vaultName(): string {
        return this.api?.name ?? '';
    }

    async create(req: CreateRequest): Promise<void> {
        if (!IN_TAURI) throw new Error('新建库需要应用环境，浏览器预览里不可用');

        const target = req.path?.trim() ?? '';
        if (!target) throw new Error('没有指定库文件要保存到哪里');

        const info = await vaultInfo(target);
        if (info.exists) {
            throw new Error(`这个位置已经有一个库了：${info.path}`);
        }

        const started = performance.now();

        this.api = await VaultSession.create({
            name: req.name,
            password: req.password,
            preset: req.preset ?? DEFAULT_PRESET,
            groups: req.groups ?? DEFAULT_GROUPS
        });
        this.absorb(info);
        this.error = null;

        // 空库也要立刻落盘：否则用户以为建好了，实际上磁盘上什么都没有
        await this.save();

        // 位置要记进配置，而且必须在 refresh() 之前 —— refresh() 不传路径，
        // 走的是「配置优先」的解析；配置没更新的话它会把这个库的 filePath
        // 拨回上一次打开的那个位置，之后每一次写入都落到另一个库上。
        //
        // 落在默认位置时不写配置：configured 的语义是「库不在默认位置」。
        // 底栏那个换库菜单与设置页都靠它判断要不要给出「用默认位置」。
        await vaultSetPath(samePath(target, await vaultDefaultPath()) ? null : target);

        await this.refresh();

        this.lastCreateMs = Math.round((performance.now() - started) * 100) / 100;
    }

    async open(password: string, path?: string): Promise<void> {
        const info = await vaultInfo(path);
        if (!info.exists) throw new Error(`找不到库文件：${info.path}`);

        // 解锁耗时是 M2 的验收读数之一。构成见 PRD §4.2：KDF 占绝大部分，
        // 解密 + 解压 + 解析只有几毫秒。
        const started = performance.now();

        const bytes = await vaultRead(path);
        this.api = await VaultSession.open(bytes, password);
        this.lastUnlockMs = Math.round((performance.now() - started) * 100) / 100;

        this.absorb(info);
        this.error = null;
        this.dirty = false;
        this.saveState = 'idle';
        this.notify();
    }

    /** 换库（F1.3）：写配置 → 断开当前会话 → 指向新库。
     *
     *  顺序有两处讲究：
     *  1. **先落盘再换** —— 换完之后 `filePath` 就指向别的文件了，
     *     攒在内存里的改动会再也写不回原来那个库
     *  2. **写配置放在落盘之后** —— 配置一改，Rust 侧的 `vault_path()` 立刻指向新库，
     *     这时候再写就是在往新库里写旧内容
     *
     *  已解锁会话在这里被丢掉，调用方要负责把界面退回解锁页并重新分流。 */
    async switchPath(path: string | null): Promise<VaultInfo> {
        if (this.isOpen()) await this.save();

        const info = await vaultSetPath(path);

        this.api = null;
        this.dirty = false;
        this.saveState = 'idle';
        this.savedAt = null;
        this.error = null;
        this.backup = null;
        this.absorb(info);
        this.notify();

        return info;
    }

    /** 仅开发与浏览器预览使用：把一个现成的会话塞进来。
     *  没有宿主可读文件时，界面仍然要能被完整地点一遍。 */
    attach(api: VaultSessionApi, label: string): void {
        this.api = api;
        this.filePath = null;
        this.label = label;
        this.exists = true;
        this.size = 0;
        this.modifiedAt = null;
        this.configured = false;
        this.error = null;
        this.dirty = false;
        this.saveState = 'idle';
        this.notify();
    }

    /** 锁定：断开对库的引用。 */
    close(): void {
        this.api = null;
        this.dirty = false;
        this.saveState = 'idle';
        this.error = null;
        this.backup = null;
        this.notify();
    }

    /** 重新读一次文件元信息（保存后大小会变） */
    async refresh(): Promise<void> {
        if (!this.filePath || !IN_TAURI) return;
        try {
            // 不传路径：让 Rust 侧按配置解析当前库。
            // 传了 this.filePath 会让 configured 被判成 false（那是「显式指定」的语义）
            this.absorb(await vaultInfo());
            this.notify();
        } catch {
            /* 元信息拿不到不影响正事 */
        }
    }

    // ------------------------------------------------------------ 写盘

    /** 会话改动之后调用：标记「有未写出的改动」并触发写盘。
     *
     *  `dirty` 与写盘是两件事：同一轮里的多次改动只让 `dirty` 置位一次，
     *  drain 据此合并成一次全量写。 */
    private touch(): void {
        this.dirty = true;
        void this.save();
    }

    /** 立刻写一次。已有写盘在跑时返回同一个 Promise —— 调用方等的就是「这批改动写下去」。
     *
     *  **不因为「没有改动」就跳过**：会话是公开的，绕过 `touch()` 直接改它的路径
     *  （验收批量灌数据那一段）也要靠一次 `save()` 落盘。跳过它们就是丢数据。
     *  「同一批改动的重复触发不多写一轮」这件事由 `drain` 的循环条件保证。 */
    save(): Promise<void> {
        if (this.writer) return this.writer;
        this.writer = this.drain();
        return this.writer;
    }

    private async drain(): Promise<void> {
        try {
            // 至少写一轮：会话是公开的（`session()` 直接返回），有路径绕过 `touch()`
            // 直接改它、只靠一次 `save()` 落盘 —— 那种情况下 `dirty` 不会被置位。
            // 验收里批量灌 500 条那一段就是这样，用「没有改动就不写」会把它们丢掉。
            //
            // 之后只有「写盘这段时间里 `dirty` 又被置位」才继续下一轮。这一条把
            // 「写盘期间真的又有改动」与「同一批改动被第二次 `await save()` 触发」
            // 区分开 —— 后者不该再写一遍。`toBytes()` 每次产出的字节都不同
            // （KDBX 的 masterSeed 与各 IV 是新生成的），白写一轮会让备份侧
            // 「内容未变就跳过」的守卫失效，多轮转出一份历史版本把该留下的顶掉。
            //
            // 循环留在 `drain` 里而不是交给调用方，是因为返回的 Promise 要覆盖到
            // 「这批改动全部落盘」—— `reopen()` 那种「保存完立刻关会话再读盘」的
            // 用法依赖这一点：写盘期间攒下的改动还没写完就断开，改动就丢了。
            do {
                this.dirty = false;
                await this.writeOnce();
            } while (this.dirty);
        } finally {
            this.writer = null;
            // 防御：do-while 已经排空了 dirty，正常走不到这里
            if (this.dirty) void this.save();
        }
    }

    private async writeOnce(): Promise<void> {
        const api = this.api;
        if (!api) return;

        // 浏览器预览没有文件可写；内存预览（解锁失败后退到的那份假库）也不能写。
        //
        // 后一条不只是「没有文件可写」那么简单：假库的 `toBytes()` 是**空**的，
        // 而 `vault_save` 的形状是「先把现有文件存成历史版本、再把新字节原子写进去」。
        // 所以真让它写一次，主库会被换成一个 0 字节文件，而那份好文件进了历史目录 ——
        // 看上去像「文件坏了」，实际是这条链自己合拢的。
        //
        // 内存会话的改动本来就在内存里，这里记一次「已保存」让界面状态保持一致，
        // 而不是把预览卡在报错上。
        if (!IN_TAURI || !api.persistable) {
            this.savedAt = Date.now();
            this.saveState = 'saved';
            this.backup = null;
            this.notify();
            return;
        }

        this.saveState = 'saving';
        this.notify();

        try {
            await this.commitBytes(await api.toBytes());
        } catch (err) {
            this.error = err instanceof Error ? err.message : String(err);
            this.saveState = 'error';
            reportError(`保存库失败：${this.error}`);
        }

        this.notify();
    }

    /** 把这串字节写进主库，并把保存状态更新到位。**出错就抛**，由调用方决定怎么呈现。
     *
     *  抽出来是为了让重建库（换档 / 改主密码）能写**自己验证过的那串字节** ——
     *  走 `save()` 会在写之前重新 `toBytes()` 一次，产出的字节与验证过的那串不同
     *  （KDBX 每次换 masterSeed 与各 IV）。两串必须是同一串，那一步验证才成立。 */
    private async commitBytes(bytes: ArrayBuffer): Promise<void> {
        // 走 vault_save 而不是 vault_write：主库保存附带两件事 ——
        // 覆盖前存一份本地历史版本，写完之后镜像到备份目录。
        const result = await vaultSave(bytes, this.filePath ?? undefined);
        this.backup = result.backup;

        this.savedAt = Date.now();
        this.size = result.bytes;
        this.modifiedAt = this.savedAt;
        this.error = null;
        this.saveState = 'saved';
    }

    /** 强制把当前内容写到另一个路径（F6.1 导出）。不影响主库的写入目标。
     *
     *  内存预览拒绝导出：那份假库 `toBytes()` 是空的，导出去只会得到一个 0 字节文件，
     *  而用户会以为「导出了一份备份」。 */
    async exportTo(path: string): Promise<number> {
        const api = this.session();
        if (!api.persistable) {
            throw new Error('内存预览里的库不能导出 —— 它没有可写出的内容');
        }
        return vaultWrite(await api.toBytes(), path);
    }

    // ------------------------------------------------------------ 重建库

    /** 换 KDF 档位（F7.6）。`current` 是用户当场输入的主密码 —— 它不参与加密，
     *  只用来做一次真正的身份校验（换档是整库重写的破坏性操作）。 */
    async changePreset(current: string, preset: PresetName): Promise<void> {
        const want = KDF_PRESETS[preset].memoryMiB;
        await this.rebuild(current, current, (api) => api.applyPreset(preset), (probe) => {
            const got = probe.header().memoryMiB;
            return got === want ? null : `文件头报的内存是 ${got} MiB，与目标的 ${want} MiB 不符`;
        });
    }

    /** 换主密码（F7.5）。`current` 用来校验、`next` 成为库的新密钥。 */
    async changeMasterPassword(current: string, next: string): Promise<void> {
        await this.rebuild(current, next, (api) => api.changeMasterPassword(next));
    }

    /**
     * 换档与改主密码共用的重建流程。
     *
     * 两件事在这条链上特别要紧：
     *
     * 1. **旧密码必须真验一次。** 密钥来自会话持有的凭据，不来自输入框 ——
     *    所以「输密码当确认」只是走个过场的话，输错了照样改成功，文件仍用原密码加密。
     *    拿旧密码去 load 当前磁盘字节，是唯一能分辨对错的判据。
     * 2. **落盘之前先证明那串字节能开。** KDBX 是整体加密的，写坏了就是整库打不开。
     *    先用新凭据把 `toBytes()` 的结果 load 一遍，通过才动磁盘。
     * 3. **这段时间自动锁定停表，收尾重新起表。** 重建要几秒，撞上无操作阈值就会在
     *    会话被整体替换的那一刻锁定 —— 见 ⓪ 那一节。
     *
     * 任一步失败都会把会话与磁盘恢复到改动前，见两处 catch。
     */
    private async rebuild(
        current: string,
        nextPassword: string,
        apply: (api: VaultSessionApi) => void | Promise<void>,
        /** 除「条目数不变」之外、重建后必须成立的事。返回非空字符串表示不成立。 */
        extra?: (probe: VaultSessionApi) => string | null
    ): Promise<void> {
        if (!IN_TAURI) throw new Error('重建库需要应用环境，浏览器预览里不可用');

        const api = this.session();
        const path = this.filePath;
        if (!path) throw new Error('还不知道库文件在哪，无法重建');

        const expected = api.entries().length;
        const inspect = (probe: VaultSessionApi): string | null => {
            const got = probe.entries().length;
            if (got !== expected) return `重建后读出的条目是 ${got} 条，改动前是 ${expected} 条`;
            return extra?.(probe) ?? null;
        };

        // ⓪ 停表。重建最长约 6 秒，而 idle 计时照走、最小档就是 1 分钟 ——
        //    在无操作第 58 秒点下「应用」，锁定正好落在会话要被整体替换的那一刻。
        //
        //    停表放在这一层而不是各个调用方：换档与改密都从这里过，散在外面会漏。
        //    收尾必须用 `lockArm` —— `lockConfigure` 只改参数、**不置 `armed`**，
        //    拿它收尾会把自动锁定永久关掉，而这件事在界面上完全看不出来。
        //
        //    起表用的配置要**现读磁盘上那份**，不能信调用方手里那份快照：设置面板
        //    从没被打开过时它是 null（验收模式正是如此），按 0 起表同样会把自动锁定
        //    悄悄关掉。这里自己读，就不必要求每个调用方都记得传。
        await lockDisarm();
        try {
            // ① 改动前先留副本。本地历史版本由后面那次 vault_save 自动产生（它在覆盖前
            //    把现有内容存进历史目录），这里补的是备份目录那一份 —— 强制镜像一次，
            //    让 NAS 上有一份与改动前一致的副本。没配备份目录 / 开关关着会返回
            //    skipped，那不算失败。
            //
            //    只在本轮有未落盘的改动（或正有一轮写在跑）时才先 save()：无条件调它会
            //    多写一轮内容相同的盘，多轮转出一份历史版本，把该留下的顶掉（见 `dirty` 注）。
            if (this.dirty || this.writer) await this.save();
            try {
                await backupRun(true);
            } catch {
                /* 镜像失败不阻塞重建：本地历史版本那条还在 */
            }

            // ② 校验旧密码。load 的是**磁盘上那份**，不是内存里的会话 ——
            //    磁盘上这份才是用户下次开机要打开的东西。
            const before = await vaultRead(path);
            await VaultSession.open(before, current);

            // ③ 把改动应用到会话并导出新字节（这一次 toBytes 内部按新参数派生密钥）
            await apply(api);
            const bytes = await api.toBytes();

            // ④ 落盘之前先证明这串字节能开
            const problem = inspect(await VaultSession.open(bytes, nextPassword));
            if (problem) throw new Error(`${problem}，已放弃写入`);

            // ⑤ 写盘。写的是刚验过的那串字节，所以不走 save()
            this.saveState = 'saving';
            this.notify();
            try {
                await this.commitBytes(bytes);
            } catch (err) {
                const detail = err instanceof Error ? err.message : String(err);
                await this.restore(before, current);
                this.error = `重建后的库没能写进磁盘：${detail}`;
                this.saveState = 'error';
                reportError(this.error);
                this.notify();
                throw new Error(this.error);
            }

            // ⑥ 从磁盘读回再验一次。第 ④ 步验的是内存里那串，这一步验的是**磁盘上那份** ——
            //    写盘链路（base64 → IPC → Rust 的原子写）出错时只有这里会暴露。
            try {
                const back = inspect(await VaultSession.open(await vaultRead(path), nextPassword));
                if (back) throw new Error(back);
            } catch (err) {
                const detail = err instanceof Error ? err.message : String(err);
                // 磁盘上那份开不了。把改动前的内容写回主库位置 —— 第 ⑤ 步已经把它存成
                // 历史版本了，但历史目录里那份不能直接用。
                try {
                    await vaultWrite(before, path);
                } catch {
                    /* 回写也失败，错误信息里如实说明 */
                }
                await this.restore(before, current);
                this.error = `写盘之后回读校验失败：${detail}`;
                this.saveState = 'error';
                reportError(this.error);
                this.notify();
                throw new Error(this.error);
            }

            this.notify();
        } finally {
            try {
                const cfg = await settingsGet();
                await lockArm(cfg.autoLockMinutes, cfg.lockOnSleep);
            } catch {
                /* 起表失败只是不自动锁，库本身照常可用，不该盖住真正的失败 */
            }
        }
    }

    /** 把会话退回改动前那份字节。
     *
     *  用「重新打开改动前的字节」而不是「反向应用一次改动」：反向应用得记住原来的
     *  KDF 原始参数，而第三方库的参数可能落在三档之外，记不住。重新打开只有一处逻辑，
     *  两种重建都适用。代价是失败路径上多一次 KDF —— 失败本来就罕见，值得。 */
    private async restore(before: ArrayBuffer, password: string): Promise<void> {
        try {
            this.api = await VaultSession.open(before, password);
            this.dirty = false;
        } catch {
            /* 会话已经不可信。磁盘上那份还在，界面锁定后重新解锁即可回到正轨。 */
        }
    }

    // ------------------------------------------------------------ 条目与分类
    //
    // 每个改动方法走 `touch()`（置位「有改动」+ 触发写盘），而不是直接 `void save()`。
    // 两者在本类内部等价，差别在调用方：界面与验收会再 `await save()` 一次确认落盘，
    // 那种「同一批改动的第二次触发」不该再写一遍盘。

    addEntry(input: EntryInput): VaultEntry {
        const created = this.session().createEntry(input);
        this.touch();
        return created;
    }

    updateEntry(entry: VaultEntry): VaultEntry {
        const updated = this.session().updateEntry(entry);
        this.touch();
        return updated;
    }

    removeEntry(id: string): void {
        this.session().removeEntry(id);
        this.touch();
    }

    moveEntryGroup(from: string, to: string): number {
        const api = this.session();
        let moved = 0;
        for (const entry of api.entries()) {
            if (entry.group !== from) continue;
            api.updateEntry({ ...entry, group: to });
            moved += 1;
        }
        if (moved) this.touch();
        return moved;
    }

    /** 建分类。`color` 只有分类面板会传 —— 一次面板提交只该产生一次库改动：
     *  分成「先建、再设色」两次调用会让写盘循环多轮转一份历史版本。 */
    createGroup(name: string, color: string | null = null): string {
        const created = this.session().createGroup(name);
        if (color) this.session().setGroupColor(created, color);
        this.touch();
        return created;
    }

    renameGroup(from: string, to: string): string {
        const renamed = this.session().renameGroup(from, to);
        this.touch();
        return renamed;
    }

    /** 改分类：名称与颜色一次提交，返回最终的名字。
     *
     *  只写**真的改过**的那一项。两处都没动就直接返回 —— 面板打开又原样保存
     *  不该产生一次库改动。两处都动时合成一次，理由同 `createGroup`。 */
    updateGroup(from: string, name: string, color: string | null): string {
        const renamed = name !== from;
        const was = this.groupColors()[from] ?? null;
        if (!renamed && was === color) return from;

        const final = renamed ? this.session().renameGroup(from, name) : from;
        if (was !== color) this.session().setGroupColor(final, color);
        this.touch();
        return final;
    }

    /** 改库名。侧栏底栏那行跟着变 —— `refreshVaultLabel()` 已经挂在订阅上，不用另接线。 */
    renameVault(name: string): string {
        const renamed = this.session().renameVault(name);
        this.touch();
        return renamed;
    }

    removeGroup(name: string): void {
        this.session().removeGroup(name);
        this.touch();
    }

    /** 设置分类颜色（`null` = 退回自动色）。颜色存在分组扩展位上，跟着库走。 */
    setGroupColor(name: string, color: string | null): void {
        this.session().setGroupColor(name, color);
        this.touch();
    }

    /** 拖拽改序。顺序同样存在分组扩展位上 —— 拖过之后这个库就按它排。 */
    reorderGroups(names: string[]): void {
        this.session().reorderGroups(names);
        this.touch();
    }

    // ------------------------------------------------------------ 便捷查询

    groups(): string[] {
        return this.api ? this.api.groups() : [];
    }

    /** 分类名 → 自定义色。只有设过的分类在表里，其余走 `groupColor()` 的自动色。 */
    groupColors(): Record<string, string> {
        return this.api ? this.api.groupColors() : {};
    }

    entries(): VaultEntry[] {
        return this.api ? this.api.entries() : [];
    }

    trashCount(): number {
        return this.api ? this.api.trashCount() : 0;
    }

    /** 分类名 → 条目数。计数从库现算，不另存一份。 */
    groupCounts(): Map<string, number> {
        const map = new Map<string, number>();
        for (const g of this.groups()) map.set(g, 0);
        for (const e of this.entries()) map.set(e.group, (map.get(e.group) ?? 0) + 1);
        return map;
    }

    /** 「未分类」是不是空的 —— 界面上没内容时可以把它藏起来 */
    hasUncategorizedOnly(): boolean {
        const counts = this.groupCounts();
        return counts.size === 1 && (counts.get(UNCATEGORIZED) ?? 0) === 0;
    }
}
