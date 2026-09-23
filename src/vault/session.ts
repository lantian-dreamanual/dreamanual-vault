/* 库会话的对外接口。
 *
 * 存在的意义有两条：
 *
 * 1. **视图层不依赖 kdbx.ts。** kdbx.ts 里含有 kdbxweb 的类型引用，而这个接口
 *    只说 VaultEntry / string[]，视图与 store 只认它。
 *
 * 2. **浏览器预览也能跑同一套界面。** 没有宿主可读文件时，
 *    `src/dev/memory.ts` 用一份内存里的假库实现同一个接口，
 *    于是界面逻辑不必为「没有 Tauri」分叉。
 *
 * 「未分类」这类领域常量留在 model.ts，这里只定义契约。 */

import type { VaultEntry } from './model';
import type { PresetName } from './kdf';

// ------------------------------------------------------------------ 错误

/** 主密码不对。
 *
 * KDBX 4 用 HMAC-SHA256 校验头部，密码错的失败点落在「密钥校验」而不是
 * 「解密后解析」，所以能确定地判定为主密码问题 —— 这也是 PRD §4.3
 * 「不存校验值，靠解密失败判定」能成立的原因。
 *
 * 定义在这里而不是 kdbx.ts：界面要按它分流提示文案，
 * 而界面不该为了一个错误类型去 import 加密封装层。 */
export class WrongPasswordError extends Error {
    constructor() {
        super('主密码不正确');
        this.name = 'WrongPasswordError';
    }
}

/** 不是 KDBX 文件，或文件损坏 */
export class VaultFormatError extends Error {
    constructor(detail: string) {
        super(detail);
        this.name = 'VaultFormatError';
    }
}

// ------------------------------------------------------------------ 契约

export interface HeaderInfo {
    version: string;
    /** Argon2 内存，MiB */
    memoryMiB: number;
    iterations: number;
    parallelism: number;
    /** 命中三档之一时给出档位名，否则为 null —— 打开第三方库时可能落在档外 */
    preset: PresetName | null;
    cipher: string;
}

export interface CreateVaultOptions {
    /** 库名。同时也是 KDBX 顶层分组的名字。 */
    name: string;
    password: string;
    preset: PresetName;
    /** 建库时预置的分类。空数组表示只需要「未分类」。 */
    groups?: string[];
}

export interface EntryInput {
    title: string;
    userName: string;
    password: string;
    url: string;
    notes: string;
    group: string;
}

export interface VaultSessionApi {
    /** 库名。与 KDBX 顶层分组的名字同源，改它要两个字段一起写 —— 见 `renameVault()`。 */
    readonly name: string;

    header(): HeaderInfo;
    /** 分类列表，不含回收站 */
    groups(): string[];
    /** 全部条目，不含回收站 */
    entries(): VaultEntry[];
    /** 回收站里的条目数 */
    trashCount(): number;

    createEntry(input: EntryInput): VaultEntry;
    updateEntry(input: VaultEntry): VaultEntry;
    /** 移入回收站 */
    removeEntry(id: string): void;

    /**
     * 换主密码（F7.5）。改的是会话持有的凭据，**下一次 `toBytes()` 就是新密钥** ——
     * 这个调用本身不落盘，也不校验旧密码（旧密码对不对只能在解锁时判）。
     * 「先验旧密码、再落盘、再回读」那一整套在 `store.ts` 的 `rebuild()` 里。
     */
    changeMasterPassword(next: string): Promise<void>;

    /**
     * 换 KDF 档位（F7.6）。写的是文件头的参数，下一次 `toBytes()` 按新参数派生密钥。
     *
     * 与主密码那一条同一个形状：改的是内存里的会话，落盘与否由调用方决定。 */
    applyPreset(preset: PresetName): void;

    /**
     * 改库名。与上面两条不同，它写的是加密体内部的元信息（`meta.name` 与顶层分组名），
     * 下一次 `toBytes()` 带上新名即可，不必重建库。
     *
     * 落盘与否同样由调用方决定 —— 与分类改名一个形状。 */
    renameVault(name: string): string;

    createGroup(name: string): string;
    renameGroup(from: string, to: string): string;
    /** 分类下的条目移入「未分类」 */
    removeGroup(name: string): void;

    /** 序列化成 KDBX 字节。写到哪由调用方决定。 */
    toBytes(): Promise<ArrayBuffer>;
}
