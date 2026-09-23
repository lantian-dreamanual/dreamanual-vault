/* 新建 / 编辑条目的弹窗。
 *
 * 只负责产出 VaultEntry，落库交给调用方。
 * 新建时 id 留空 —— KDBX 的条目 UUID 由库自己生成，界面不预设。 */

import { isComposing, must, toast } from '../ui/dom';
import { icons } from '../ui/icons';
import { passwordScore, randomPassword } from '../ui/password';
import type { VaultEntry } from '../vault/model';

interface EditorHost {
    /** 每次打开新建弹窗时现取，这样「当前筛选到哪个分类」能跟着走 */
    defaultGroup: () => string;
    /** 顶层分组。每次打开弹窗现取，不缓存 —— 弹窗开着的时候侧栏也可能建了分类 */
    groups: () => string[];
    /** 在弹窗里新建一个分类，回传最终落下的名字；取消回 null */
    onNewCategory: () => Promise<string | null>;
    onSave: (entry: VaultEntry) => void;
    onDelete: (entry: VaultEntry) => void;
}

/** 「＋ 新建分类…」那一项的值。
 *
 *  空串不可能是真实分类名 —— `createGroup` 拒绝空名，`ensureGroup` 把空名兜成
 *  「未分类」—— 所以拿它当哨兵不会和任何分类撞上，比用 `__new__` 这类可读字符串安全。 */
export const NEW_CATEGORY = '';

export interface CatOption {
    value: string;
    label: string;
}

/** 分类下拉的选项。
 *
 *  **当前值一定要在里头。** 库里的条目不保证属于某个顶层分组：直接挂在根组下的
 *  条目，它读出来的 `group` 是库名；「打开其他库」导进来的 vault 里，落在二级分组
 *  的条目，`group` 是那个二级分组的名字。而 `groups()` 只列顶层分组。
 *  选项里漏掉当前值，`<select>` 会退到第一个选项上 —— 用户什么都没改、点一下保存，
 *  条目就被挪到了别的分类。静默改数据，没有任何提示。
 *
 *  同理当前值已在列表里时不重复添加：重一次会让下拉出现两个同名项，看着像分类坏了。 */
export function categoryOptions(groups: string[], current: string): CatOption[] {
    const names = groups.slice();
    if (current && !names.includes(current)) names.push(current);

    return [
        ...names.map((name) => ({ value: name, label: name })),
        { value: NEW_CATEGORY, label: '＋ 新建分类…' }
    ];
}

function today(): string {
    return new Date().toISOString().slice(0, 10);
}

export class EntryEditor {
    private mask = must('#editor-mask');
    private titleEl = must('#editor-title');
    private inTitle = must<HTMLInputElement>('#f-title');
    private inCat = must<HTMLSelectElement>('#f-cat');
    private inUser = must<HTMLInputElement>('#f-user');
    private inPw = must<HTMLInputElement>('#f-pw');
    private revealBtn = must('#f-pw-reveal');
    private inUrl = must<HTMLInputElement>('#f-url');
    private inNotes = must<HTMLTextAreaElement>('#f-notes');
    private meterFill = must('#f-pw-meter > i');
    private deleteBtn = must('#editor-delete');
    private saveBtn = must<HTMLButtonElement>('#editor-save');

    /** 正在编辑的条目；新建时为 null */
    private editing: VaultEntry | null = null;

    /** 下拉里上一次选中的真实分类。选中「＋ 新建分类…」时先把自己复原成它，
     *  这样用户取消新建，下拉不会停在那一项上。 */
    private lastCat = '';

    constructor(private host: EditorHost) {
        this.wire();
    }

    private wire(): void {
        must('#editor-close').addEventListener('click', () => this.close());
        must('#editor-cancel').addEventListener('click', () => this.close());

        this.mask.addEventListener('click', (ev) => {
            if (ev.target === this.mask) this.close();
        });

        this.saveBtn.addEventListener('click', () => this.commit());

        // F5.1：名称为空时保存不可用。禁用比点了再弹提示少一步返工。
        this.inTitle.addEventListener('input', () => this.syncSaveButton());

        this.deleteBtn.addEventListener('click', () => {
            if (this.editing) {
                this.close();
                this.host.onDelete(this.editing);
            }
        });

        must('#f-pw-reveal').addEventListener('click', () => {
            this.inPw.type = this.inPw.type === 'password' ? 'text' : 'password';
            this.replaySwap();
        });

        must('#f-pw-gen').addEventListener('click', () => {
            this.inPw.value = randomPassword(20);
            this.inPw.type = 'text';
            this.replaySwap();
            this.updateMeter();
        });

        this.inPw.addEventListener('input', () => this.updateMeter());

        // 标题框上曾经绑过「回车 = 保存并关窗」。撤掉了，撤的理由是它太容易误触：
        //   1. 弹窗里六个字段只有第一个有这条规则，用户猜不到，也没法从界面上看出来；
        //   2. 中文输入法里回车是确认候选词（`isComposing` 那一类），在标题框打字
        //      选词就会把弹窗存掉；
        //   3. 误保存的代价不对称 —— 保存成功没有任何提示价值（用户以为自己在打字），
        //      而 KDBX 没有撤销，半成品直接覆盖了原条目。
        // 保存仍有两条明确的路：底部「保存」按钮，与下面那条 ⌘S。

        // 选中「＋ 新建分类…」就弹输入框。选完先把自己复原成上一次的真实分类：
        // 建分类是要 await 的，中间这段时间下拉不能停在一个不是分类的值上 ——
        // 用户这时候按保存就会拿到空值。取消时同样要复原。
        this.inCat.addEventListener('change', () => {
            const picked = this.inCat.value;
            if (picked !== NEW_CATEGORY) {
                this.lastCat = picked;
                return;
            }
            this.inCat.value = this.lastCat;
            void this.chooseNewCategory();
        });

        document.addEventListener('keydown', (ev) => {
            // `promptDialog` 也把按键监听挂在 `document` 上，且不拦事件、只收掉自己。
            // 少了这一道，在它上面按 Esc 会连编辑器一起关掉。
            if (!this.isTopmost()) return;
            // 输入法正在选词时的回车 / Esc 不算按键（见 `isComposing`）。
            // 这里尤其要紧：Esc 取消候选项会顺手把整个弹窗关掉，未保存的改动一起没。
            if (isComposing(ev)) return;
            if (ev.key === 'Escape') {
                ev.preventDefault();
                this.close();
            } else if (ev.key === 's' && ev.metaKey) {
                ev.preventDefault();
                this.commit();
            }
        });
    }

    /** 有没有别的弹窗压在自己上面。`#editor-mask` 与 `promptDialog` 建的遮罩同是
     *  `.mask`，后者 append 到 body 末尾，所以 DOM 顺序的最后一个就是最上面那个。 */
    private isTopmost(): boolean {
        if (this.mask.classList.contains('hidden')) return false;
        const masks = document.querySelectorAll<HTMLElement>('.mask:not(.hidden)');
        return masks[masks.length - 1] === this.mask;
    }

    /** 重建分类下拉。用 DOM 接口而不是拼 innerHTML —— 分类名是用户输入，
     *  拼字符串就得再过一遍转义，这里没有出错的余地。 */
    private renderCatOptions(current: string): void {
        this.inCat.replaceChildren();
        for (const opt of categoryOptions(this.host.groups(), current)) {
            const el = document.createElement('option');
            el.value = opt.value;
            el.textContent = opt.label;
            this.inCat.append(el);
        }
        this.inCat.value = current;
        this.lastCat = current;
    }

    private async chooseNewCategory(): Promise<void> {
        const created = await this.host.onNewCategory();
        if (created) {
            // 重建而不是 append：分类列表是按本地化顺序排的，直接追加会让它落在末尾
            this.renderCatOptions(created);
        }
        this.inCat.focus();
    }

    private updateMeter(): void {
        const { level, color } = passwordScore(this.inPw.value);
        this.meterFill.style.width = `${(level / 3) * 100}%`;
        this.meterFill.style.background = color;
    }

    /**
     * 重放掩码切换动效（F4.2，关键帧在 base.css 的 `pw-swap` / `eye-pop`）。
     *
     * 同一个元素上重复戴同一个类不会重播动画，得先摘掉、强制一次重排、再戴上。
     * 摘掉那一下不能省 —— 省了就只剩第一次点击有动效，之后全静默。
     */
    private replaySwap(): void {
        this.pulse(this.inPw, 'is-swap');
        this.syncRevealIcon();
        this.pulse(this.revealBtn, 'is-pop');
    }

    /**
     * 眼睛图标跟着输入框的 `type` 走。
     *
     * 详情栏那一处本来就会换图标（`vault.ts` 的 `eye` / `eyeOff`），弹窗这里原先
     * 是一段静态 svg —— 两处同一个语义的开关长得不一样，掩码状态在弹窗里只能从
     * 输入框里那串点自己看出来。新建 / 编辑两处复位也要调一次，否则会留着上一次
     * 打开时的图标（那里不带 `is-pop`，开弹窗时不该眨）。
     */
    private syncRevealIcon(): void {
        // 换 svg 前先摘掉 `is-pop`：新节点插入时父级若还戴着这个类，动画会立刻播一遍。
        this.revealBtn.classList.remove('is-pop');
        this.revealBtn.innerHTML = this.inPw.type === 'text' ? icons.eyeOff(15) : icons.eye(15);
    }

    /** 摘掉 → 强制重排 → 戴上。重复调用能重播动画。 */
    private pulse(el: HTMLElement, cls: string): void {
        el.classList.remove(cls);
        void el.offsetWidth;
        el.classList.add(cls);
    }

    private syncSaveButton(): void {
        this.saveBtn.disabled = !this.inTitle.value.trim();
    }

    openCreate(): void {
        this.editing = null;
        this.titleEl.textContent = '新建条目';
        this.deleteBtn.classList.add('hidden');

        this.inTitle.value = '';
        this.renderCatOptions(this.host.defaultGroup());
        this.inUser.value = '';
        this.inPw.value = '';
        this.inPw.type = 'password';
        this.syncRevealIcon();
        this.inUrl.value = '';
        this.inNotes.value = '';
        this.updateMeter();
        this.syncSaveButton();

        this.show();
        this.inTitle.focus();
    }

    openEdit(entry: VaultEntry): void {
        this.editing = { ...entry };
        this.titleEl.textContent = `编辑「${entry.title}」`;
        this.deleteBtn.classList.remove('hidden');

        this.inTitle.value = entry.title;
        this.renderCatOptions(entry.group);
        this.inUser.value = entry.userName;
        this.inPw.value = entry.password;
        this.inPw.type = 'password';
        this.syncRevealIcon();
        this.inUrl.value = entry.url;
        this.inNotes.value = entry.notes;
        this.updateMeter();
        this.syncSaveButton();

        this.show();
        this.inTitle.focus();
        this.inTitle.select();
    }

    private show(): void {
        this.mask.classList.remove('hidden');
    }

    close(): void {
        this.mask.classList.add('hidden');
        this.editing = null;
    }

    get isOpen(): boolean {
        return !this.mask.classList.contains('hidden');
    }

    private commit(): void {
        const title = this.inTitle.value.trim();
        if (!title) {
            toast('标题不能为空');
            this.inTitle.focus();
            return;
        }

        // 下拉不该停在「＋ 新建分类…」上；真出现了就退回上一次的真实分类
        const group = this.inCat.value || this.lastCat || this.host.defaultGroup();
        const entry: VaultEntry = {
            id: this.editing?.id ?? '',
            title,
            userName: this.inUser.value.trim(),
            password: this.inPw.value,
            url: this.inUrl.value.trim(),
            notes: this.inNotes.value,
            group,
            updatedAt: today()
        };

        const wasEditing = this.editing !== null;
        this.close();
        this.host.onSave(entry);
        toast(wasEditing ? `已更新「${entry.title}」` : `已新建「${entry.title}」`);
    }
}
