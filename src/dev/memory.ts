/* 内存里的假库。
 *
 * 用途只有一个：**没有宿主可以读文件时，同一套界面仍然能被完整点一遍。**
 * 浏览器里 `npm run dev` 加 `?dev=unlocked` 走的就是这条路 —— 调 CSS、
 * 看排版、对着原型改视觉，不必每次都构建整个 Tauri 应用。
 *
 * 它不落盘，也不做加密。任何判断真伪的地方都以 Tauri 环境为准，
 * 不会因为它存在而把「开发预览」和「真实库」混起来。 */

import { KDF_PRESETS, type PresetName } from '../vault/kdf';
import { UNCATEGORIZED, type VaultEntry } from '../vault/model';
import type { EntryInput, HeaderInfo, VaultSessionApi } from '../vault/session';
import { DEMO_ENTRIES, DEMO_GROUPS } from './seed';

export class MemorySession implements VaultSessionApi {
    private readonly items: VaultEntry[] = [];
    private readonly cats: string[];
    private seq = 0;

    /** 预览里「换过档」的落点。`header()` 读它，好让设置页显示当前档位那一行
     *  在预览里也真的会变 —— 否则「点了应用什么都不动」这条路径没法用界面自查。 */
    private previewPreset: PresetName = '均衡';

    constructor(
        // 不加 readonly：预览里要能用 `renameVault()` 改掉它，好把设置页那行走通
        public name = 'Dreamanual 密码管理（内存预览）',
        entries: EntryInput[] = DEMO_ENTRIES,
        groups: string[] = DEMO_GROUPS
    ) {
        this.cats = [...new Set([...groups, UNCATEGORIZED])];
        for (const e of entries) this.createEntry(e);
    }

    header(): HeaderInfo {
        const p = KDF_PRESETS[this.previewPreset];
        return {
            version: '预览',
            memoryMiB: p.memoryMiB,
            iterations: p.iterations,
            parallelism: p.parallelism,
            preset: this.previewPreset,
            cipher: 'AES-256-CBC'
        };
    }

    groups(): string[] {
        return [...this.cats].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    }

    entries(): VaultEntry[] {
        return this.items.map((e) => ({ ...e }));
    }

    trashCount(): number {
        return 0;
    }

    createEntry(input: EntryInput): VaultEntry {
        this.seq += 1;
        const group = input.group.trim() || UNCATEGORIZED;
        if (!this.cats.includes(group)) this.cats.push(group);

        const created: VaultEntry = {
            id: `mem-${this.seq}`,
            title: input.title,
            userName: input.userName,
            password: input.password,
            url: input.url,
            notes: input.notes,
            group,
            updatedAt: today()
        };
        this.items.push(created);
        return created;
    }

    updateEntry(input: VaultEntry): VaultEntry {
        const at = this.items.findIndex((e) => e.id === input.id);
        if (at < 0) throw new Error('这条记录已经不在库里了');
        const group = input.group.trim() || UNCATEGORIZED;
        if (!this.cats.includes(group)) this.cats.push(group);

        const next = { ...input, group, updatedAt: today() };
        this.items[at] = next;
        return next;
    }

    removeEntry(id: string): void {
        const at = this.items.findIndex((e) => e.id === id);
        if (at >= 0) this.items.splice(at, 1);
    }

    /* 内存预览不加密也不落盘。这两个方法存在的意义是让设置页那两处控件
       **能被完整点一遍**（F7.5 / F7.6）—— 没有它们，浏览器里 `npm run dev`
       点「应用」会抛「未实现」，而那不是真实链路的错。
       改主密码在这里没有落点：预览会话不持有凭据，没有东西可改。
       真要验证这两条链路，只能在应用里走 `VAULT_DEV=accept`。 */

    async changeMasterPassword(_next: string): Promise<void> {
        /* 无凭据可改 */
    }

    applyPreset(preset: PresetName): void {
        this.previewPreset = preset;
    }

    /** 预览里只动这一个字段 —— 真实库里那份同名副本在 KDBX 的顶层分组上。 */
    renameVault(name: string): string {
        const trimmed = name.trim();
        if (!trimmed) throw new Error('库名不能为空');
        this.name = trimmed;
        return trimmed;
    }

    createGroup(name: string): string {
        const trimmed = name.trim();
        if (!trimmed) throw new Error('分类名不能为空');
        if (this.cats.includes(trimmed)) throw new Error(`分类「${trimmed}」已存在`);
        this.cats.push(trimmed);
        return trimmed;
    }

    renameGroup(from: string, to: string): string {
        const trimmed = to.trim();
        if (from === UNCATEGORIZED) throw new Error('「未分类」不能改名');
        if (!trimmed) throw new Error('分类名不能为空');
        const at = this.cats.indexOf(from);
        if (at < 0) throw new Error(`找不到分类「${from}」`);
        if (trimmed !== from && this.cats.includes(trimmed)) throw new Error(`分类「${trimmed}」已存在`);

        this.cats[at] = trimmed;
        for (const item of this.items) if (item.group === from) item.group = trimmed;
        return trimmed;
    }

    removeGroup(name: string): void {
        if (name === UNCATEGORIZED) throw new Error('「未分类」不能删除');
        const at = this.cats.indexOf(name);
        if (at < 0) throw new Error(`找不到分类「${name}」`);
        this.cats.splice(at, 1);
        for (const item of this.items) if (item.group === name) item.group = UNCATEGORIZED;
    }

    /** 内存预览不落盘。写盘路径在 non-Tauri 环境下本来就不会被走到。 */
    async toBytes(): Promise<ArrayBuffer> {
        return new ArrayBuffer(0);
    }
}

function today(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
