/* 保险箱面板：分类栏 + 列表栏 + 详情栏。
 *
 * 数据全部来自 VaultStore —— 每次渲染都从库里现读，本文件不缓存条目。
 * 库那一层做了缓存（见 kdbx.ts），所以这里是「读一次拿一份快照」的成本，
 * 换来的是「渲染函数永远是纯函数」这条简单性质，不必手动同步状态。
 *
 * 列表走 innerHTML 全量重建。M0 实测 500 条 1ms，所以不做节点复用。
 *
 * 契约：从 store 拿到的 VaultEntry 是共享引用，**只能读**。
 * 要改就构造一个新对象交给 `store.updateEntry()`。 */

import {
    compareEntries,
    entryInitial,
    entrySubtitle,
    groupColor,
    matches,
    UNCATEGORIZED,
    type VaultEntry
} from '../vault/model';
import type { VaultStore } from '../vault/store';
import { clipboardArm, reportError } from '../host';
import { escapeHtml, highlight, isComposing, must, toast } from '../ui/dom';
import { icons } from '../ui/icons';
import { contextMenu, type MenuItem } from '../ui/menu';
import { randomPassword } from '../ui/password';

export const ALL_GROUP = '全部';

/** 分类行拖拽的位移阈值（像素）。小于它的位移当作一次点击 ——
 *  分类行本来就是按钮，触控板或鼠标的轻微抖动不该把它变成一次排序。 */
const DRAG_THRESHOLD = 4;

/**
 * 详情栏里三个可复制字段的名字。**导出是给验收脚本用的** ——
 * `accept.ts` 靠 `.row[data-field="…"]` 取行，名字写死在两边的话，
 * 改一个字段名会让一串断言静默失效：选择器匹配不到，取值函数返回 `null`，
 * 报出来的是「这个字段没值」而不是「行名改了」。名字只有这一处定义。
 */
export const FIELD_USER = '账号';
export const FIELD_URL = '网址';

/**
 * 密码那一行。
 *
 * 这一栏不只装密码：应用只显示一次的 API key / 恢复码也落在这里（自定义字段
 * 系统按 PRD §3.3 砍掉了，多行信息才进备注），所以名字把两种都写出来。
 * 编辑器里那一栏、右键菜单里的「复制…」、⌘C 的兜底都取这一个值。 */
export const FIELD_PASSWORD = '密码 / 密钥';

export interface VaultHooks {
    onNewEntry: () => void;
    onEditEntry: (entry: VaultEntry) => void;
    onDeleteEntry: (entry: VaultEntry) => void;
    onNewGroup: () => void;
    /** 打开分类面板。名称与颜色在同一个框里改，所以这里只递分类名、不分两项。 */
    onEditGroup: (name: string) => void;
    onDeleteGroup: (name: string) => void;
    /** 拖完分类行的结果顺序（不含「全部」）。名字缺一个都会被 store 拒绝。 */
    onReorderGroups: (names: string[]) => void;
}

export class VaultView {
    private activeGroup = ALL_GROUP;
    private query = '';
    private selectedId: string | null = null;
    private revealed = new Set<string>();
    /**
     * 掩码切换动效的一次性标记（F4.2）。
     *
     * `renderDetail()` 重建 `innerHTML`，新节点挂不上过渡，只能让它自己播一次动画。
     * 这个标记保证只有「点了眼睛」那一帧带 `.is-swap` —— 否则搜索每敲一个字
     * 重绘一次，密码行就会跟着闪一次。
     */
    private pwSwap = false;
    /**
     * 详情栏的「当前字段」—— 最近一次被聚焦或被点的可复制行。
     *
     * 存字段名而不是元素引用：`renderDetail()` 每次都重建 `innerHTML`，
     * 存下来的元素会变成游离节点，读它的 `dataset` 读到的是上一版的值。
     */
    private currentField: string | null = null;
    /** 分类行的拖拽态。`null` = 没在拖。 */
    private drag: { name: string; y0: number; moved: boolean } | null = null;
    /**
     * 吃掉拖拽松手之后紧跟的那一次 click。
     *
     * 松手时浏览器仍会按「按下的位置」补一次 click，而分类行是按钮 —— 不清掉的话，
     * 拖完顺序会顺手把筛选切到刚拖的那个分类上。
     */
    private swallowClick = false;

    private catsEl = must('#cats');
    private listEl = must('#list');
    private detailEl = must('#detail');
    private searchEl = must<HTMLInputElement>('#search');
    private searchClearEl = must('#search-clear');
    private countEl = must('#list-count');
    private scopeEl = must('#list-scope');

    constructor(
        private store: VaultStore,
        private hooks: VaultHooks
    ) {
        this.wire();
        this.renderAll();
    }

    // ---------------------------------------------------------------- 查询

    private entries(): VaultEntry[] {
        return this.store.entries();
    }

    private groups(): string[] {
        return this.store.groups();
    }

    /** 当前选中的分类可能已经被改名或删掉了，渲染前先把它拉回有效值 */
    private normalizeGroup(): void {
        if (this.activeGroup === ALL_GROUP) return;
        if (!this.groups().includes(this.activeGroup)) this.activeGroup = ALL_GROUP;
    }

    private visible(): VaultEntry[] {
        return this.entries()
            .filter((e) => this.activeGroup === ALL_GROUP || e.group === this.activeGroup)
            .filter((e) => matches(e, this.query))
            .sort(compareEntries);
    }

    private selected(): VaultEntry | null {
        const list = this.visible();
        if (!list.length) return null;
        return list.find((e) => e.id === this.selectedId) ?? list[0]!;
    }

    private find(id: string | undefined): VaultEntry | undefined {
        if (!id) return undefined;
        return this.entries().find((e) => e.id === id);
    }

    /** 选中一条并重绘。鼠标那一下 click 与键盘的回车走同一份 ——
     *  分成两处的话，改了一边另一边会悄悄不同。 */
    private selectItem(id: string | null): void {
        this.selectedId = id;
        this.renderList();
        this.renderDetail();
    }

    /** 把焦点还给刚选中的那一行。`selectItem()` 重建的是 `innerHTML`，
     *  焦点会掉回 body —— 不还回去的话，键盘用户每选一条都要从头 Tab 一遍。
     *  遍历比对 `dataset.id` 而不拼选择器：条目 id 里出现引号或方括号是可能的。 */
    private focusItem(id: string): void {
        for (const el of this.listEl.querySelectorAll<HTMLElement>('.item')) {
            if (el.dataset.id === id) {
                el.focus();
                return;
            }
        }
    }

    // ---------------------------------------------------------------- 渲染

    /** 改动落库之后整屏重绘。由 main.ts 在数据变化后调用。 */
    refresh(): void {
        this.renderAll();
    }

    private renderAll(): void {
        this.normalizeGroup();
        this.renderCats();
        this.renderList();
        this.renderDetail();
    }

    private renderCats(): void {
        const counts = this.store.groupCounts();
        const colors = this.store.groupColors();
        const total = this.entries().length;

        const row = (name: string, count: number, dot: string | null): string => {
            const on = name === this.activeGroup ? ' on' : '';
            const dotHtml = dot ? `<span class="cat-dot" style="background:${dot}"></span>` : '';
            return (
                `<button class="cat${on}" data-group="${escapeAttr(name)}">` +
                dotHtml +
                `<span class="cat-name">${escapeHtml(name)}</span>` +
                `<span class="cat-n">${count}</span>` +
                `</button>`
            );
        };

        this.catsEl.innerHTML =
            `<div class="cats-label"><span>分类</span>` +
            `<button class="cats-add" id="cats-new" type="button" title="新建分类" aria-label="新建分类">` +
            icons.plus(11) +
            `</button></div>` +
            row(ALL_GROUP, total, null) +
            this.groups()
                // 设过色的走库里存的那个值，没设过的按名称算 —— 后者在分类多于 10 个时会撞色
                .map((g) => row(g, counts.get(g) ?? 0, colors[g] ?? groupColor(g)))
                .join('');
    }

    private renderList(): void {
        const list = this.visible();

        if (!list.length) {
            this.listEl.innerHTML = this.query
                ? `<div class="empty">没有匹配「${highlight(this.query, '')}」的条目</div>`
                : `<div class="empty">这个分类还是空的</div>`;
        } else {
            const current = this.selected();
            // 条目行可聚焦。列表是这个应用的主界面，键盘 Tab 能走到分类行和各个
            // 按钮，却走不到列表行的话，那段路就断在这里。
            // `role="button"` 是说给读屏的：它得知道这一行能被敲下去，
            // 不然「可聚焦」只意味着多一个停留点。
            this.listEl.innerHTML = list
                .map((e) => {
                    const on = current && e.id === current.id ? ' on' : '';
                    return (
                        `<div class="item${on}" data-id="${e.id}" tabindex="0" role="button">` +
                        `<div class="ava">${highlight(entryInitial(e), this.query)}</div>` +
                        `<div class="item-main">` +
                        `<div class="item-title">${highlight(e.title, this.query)}</div>` +
                        `<div class="item-sub">${highlight(entrySubtitle(e), this.query)}</div>` +
                        `</div></div>`
                    );
                })
                .join('');
        }

        this.countEl.textContent = `${list.length} 条`;
        this.scopeEl.textContent = this.activeGroup === ALL_GROUP ? '全部分类' : this.activeGroup;
        this.searchClearEl.classList.toggle('hidden', !this.query);
    }

    private renderDetail(): void {
        const entry = this.selected();
        if (!entry) {
            this.detailEl.innerHTML = this.query
                ? `<div class="detail-empty">没有选中条目<br>换个搜索词试试</div>`
                : `<div class="detail-empty">左侧选一条查看详情<br>或按 ⌘N 新建</div>`;
            return;
        }

        const shown = this.revealed.has(entry.id);
        const pwText = shown ? entry.password : '••••••••••••';
        const pwClass = shown ? '' : ' muted';
        const eye = shown ? icons.eyeOff() : icons.eye();
        // 动效标记读一次就清（见字段注释）。清在读之后 —— 下面几句才把类名拼进 HTML。
        const swap = this.pwSwap ? ' is-swap' : '';
        const eyeCls = this.pwSwap ? ' is-pop' : '';
        this.pwSwap = false;

        // 可复制的行带 `data-field` 且可聚焦 —— ⌘C「复制当前字段」要有「当前」这个概念，
        // 判据就是焦点（点击或 Tab 落到哪一行）。没有值的行不参与，因为没什么可复制。
        const rowValue = (key: string, value: string, opts: { mono?: boolean } = {}): string => {
            if (!value.trim()) {
                return `<div class="row"><div class="row-k">${key}</div><div class="row-v muted">未填写</div></div>`;
            }
            const cls = opts.mono ? 'row-v' : 'row-v plain';
            return (
                `<div class="row is-copyable" tabindex="0" data-field="${key}">` +
                `<div class="row-k">${key}</div>` +
                `<div class="${cls}">${highlight(value, this.query)}</div>` +
                `<div class="row-acts"><button class="icon-btn" data-copy="${escapeAttr(value)}" title="复制">${icons.copy()}</button></div>` +
                `</div>`
            );
        };

        this.detailEl.innerHTML =
            `<div class="detail-head">` +
            `<div class="detail-ava">${entryInitial(entry)}</div>` +
            `<div>` +
            `<div class="detail-title">${highlight(entry.title, this.query)}</div>` +
            `<div class="detail-tags">` +
            `<span class="tag tag-cat">${escapeHtml(entry.group)}</span>` +
            `<span class="tag">更新于 ${escapeHtml(entry.updatedAt)}</span>` +
            `</div></div>` +
            `<div class="detail-acts">` +
            `<button class="icon-btn" data-act="edit" title="编辑">${icons.edit()}</button>` +
            `<button class="icon-btn" data-act="delete" title="删除">${icons.trash()}</button>` +
            `</div></div>` +

            `<div class="detail-body">` +
            rowValue(FIELD_USER, entry.userName) +
            `<div class="row is-copyable" tabindex="0" data-field="${FIELD_PASSWORD}">` +
            `<div class="row-k">${FIELD_PASSWORD}</div>` +
            `<div class="row-v${pwClass}${swap}">${highlight(pwText, this.query)}</div>` +
            `<div class="row-acts">` +
            `<button class="icon-btn${eyeCls}" data-act="reveal" title="显示 / 隐藏">${eye}</button>` +
            `<button class="icon-btn" data-copy="${escapeAttr(entry.password)}" title="复制${FIELD_PASSWORD}">${icons.copy()}</button>` +
            `<button class="icon-btn" data-act="generate" title="生成新密码">${icons.refresh()}</button>` +
            `</div></div>` +
            rowValue(FIELD_URL, entry.url, { mono: true }) +
            `<div class="block"><div class="block-k">备注</div>` +
            `<div class="block-v">${entry.notes.trim() ? highlight(entry.notes, this.query) : '<span class="muted">未填写</span>'}</div>` +
            `</div></div>`;
    }

    // ---------------------------------------------------------------- 交互

    private wire(): void {
        this.catsEl.addEventListener('click', (ev) => {
            // 刚拖完的那一次点击不当事（见 swallowClick 的注释）
            if (this.swallowClick) {
                this.swallowClick = false;
                return;
            }

            const target = ev.target as HTMLElement;

            // 分类标题行那个 +。走委托而不是给按钮挂监听：renderCats() 每次
            // 重建 innerHTML，直接挂在按钮上的监听会跟着一起被丢掉。
            if (target.closest('#cats-new')) {
                this.hooks.onNewGroup();
                return;
            }

            const btn = target.closest<HTMLElement>('.cat');
            if (!btn) return;
            this.activeGroup = btn.dataset.group ?? ALL_GROUP;
            this.selectedId = null;
            this.renderAll();
        });

        // 分类行拖拽改序。用 pointer 事件自实现，不用 HTML5 拖拽：
        // 合成的 PointerEvent 能驱动这条链路（验收里要真按一遍），而 HTML5 拖拽
        // 既要一个真的 DataTransfer，又会带出 WebKit 自己的拖拽幽灵图。
        //
        // 监听挂到 window 上而不是容器上：指针拖出侧栏（拖到列表列、甚至窗口边缘）
        // 时仍要收到 move 与 up，否则会卡在「正在拖」的状态里。
        this.catsEl.addEventListener('pointerdown', (ev) => {
            this.swallowClick = false;

            const row = (ev.target as HTMLElement).closest<HTMLElement>('.cat[data-group]');
            const name = row?.dataset.group;
            // 「全部」是伪分类，不参与排序；右键与中键不拾起
            if (!name || name === ALL_GROUP || ev.button !== 0) return;

            this.drag = { name, y0: ev.clientY, moved: false };

            const onMove = (move: PointerEvent): void => this.dragMove(move);
            const onUp = (): void => {
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
                this.dragEnd();
            };
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
        });

        this.catsEl.addEventListener('contextmenu', (ev) => {
            ev.preventDefault();
            const pos = { x: ev.clientX, y: ev.clientY };
            const btn = (ev.target as HTMLElement).closest<HTMLElement>('.cat');
            const name = btn?.dataset.group ?? ALL_GROUP;

            if (name === ALL_GROUP) {
                contextMenu(pos, [{ label: '新建分类…', onPick: () => this.hooks.onNewGroup() }]);
                return;
            }

            const items: MenuItem[] = [
                { label: '编辑分类…', onPick: () => this.hooks.onEditGroup(name) }
            ];
            if (name !== UNCATEGORIZED) {
                items.push({ label: '删除分类', danger: true, onPick: () => this.hooks.onDeleteGroup(name) });
            }
            contextMenu(pos, items);
        });

        this.listEl.addEventListener('click', (ev) => {
            const item = (ev.target as HTMLElement).closest<HTMLElement>('.item');
            if (!item) return;
            this.selectItem(item.dataset.id ?? null);
        });

        // 条目行的键盘激活。回车与空格都能按下去，走的是上面 mouse 那一下的同一份逻辑。
        this.listEl.addEventListener('keydown', (ev) => {
            if (isComposing(ev)) return;
            if (ev.key !== 'Enter' && ev.key !== ' ') return;

            const item = (ev.target as HTMLElement).closest<HTMLElement>('.item');
            if (!item) return;
            ev.preventDefault();

            const id = item.dataset.id ?? null;
            this.selectItem(id);
            if (id) this.focusItem(id);
        });

        this.listEl.addEventListener('contextmenu', (ev) => {
            const node = (ev.target as HTMLElement).closest<HTMLElement>('.item');
            if (!node) return;
            ev.preventDefault();

            const entry = this.find(node.dataset.id);
            if (!entry) return;

            this.selectItem(entry.id);

            contextMenu({ x: ev.clientX, y: ev.clientY }, [
                { label: '编辑', onPick: () => this.hooks.onEditEntry(entry) },
                { label: `复制${FIELD_PASSWORD}`, onPick: () => void this.copy(entry.password) },
                { label: `复制${FIELD_USER}`, onPick: () => void this.copy(entry.userName) },
                { label: '复制备注', onPick: () => void this.copy(entry.notes) },
                { label: '删除', danger: true, onPick: () => this.hooks.onDeleteEntry(entry) }
            ]);
        });

        this.detailEl.addEventListener('click', (ev) => {
            const btn = (ev.target as HTMLElement).closest<HTMLElement>('button');
            if (!btn) return;

            const copyValue = btn.dataset.copy;
            if (copyValue !== undefined) {
                void this.copy(copyValue);
                return;
            }

            const entry = this.selected();
            if (!entry) return;

            switch (btn.dataset.act) {
                case 'reveal':
                    if (this.revealed.has(entry.id)) this.revealed.delete(entry.id);
                    else this.revealed.add(entry.id);
                    this.pwSwap = true;
                    this.renderDetail();
                    break;
                case 'generate': {
                    // 生成即落库：这个按钮改的是密码本身，留在内存里等用户再点保存
                    // 会出现「看起来换了，其实没换」。直接更新并写明已保存。
                    const next = randomPassword(20);
                    this.store.updateEntry({ ...entry, password: next });
                    this.revealed.add(entry.id);
                    // 生成即切到明文，值也变了 —— 同一段「落定」动效，别让它硬跳
                    this.pwSwap = true;
                    this.renderAll();
                    toast('已生成新密码并保存');
                    break;
                }
                case 'edit':
                    this.hooks.onEditEntry(entry);
                    break;
                case 'delete':
                    this.hooks.onDeleteEntry(entry);
                    break;
                default:
                    break;
            }
        });

        this.searchEl.addEventListener('input', () => {
            this.query = this.searchEl.value;
            this.selectedId = null;
            this.renderList();
            this.renderDetail();
        });

        // 「当前字段」跟着焦点走。两个事件都要：`focusin` 管键盘（Tab）与大多数点击，
        // `pointerdown` 兜住「点在行内的文字上、WebKit 没把焦点移进这一行」的情形。
        // 两者都是幂等的（记的是同一行），不会互相干扰。
        this.detailEl.addEventListener('focusin', (ev) => this.noteField(ev.target));
        this.detailEl.addEventListener('pointerdown', (ev) => this.noteField(ev.target));

        this.searchClearEl.addEventListener('click', () => this.clearSearch());
    }

    /**
     * 拖拽中：按指针的纵向位置把行挪到该在的位置。
     *
     * 直接改 DOM 顺序，不先算一份数据再重画 —— 拖动过程中每按一下重画，行的节点
     * 引用就全失效了，指针还按着的那一行会跟着消失。松手时再读一遍 DOM 顺序提交。
     */
    private dragMove(ev: PointerEvent): void {
        const drag = this.drag;
        if (!drag) return;

        if (!drag.moved) {
            if (Math.abs(ev.clientY - drag.y0) < DRAG_THRESHOLD) return;
            drag.moved = true;
            this.catsEl.classList.add('is-sorting');
            this.rowOf(drag.name)?.classList.add('is-dragging');
        }

        const el = this.rowOf(drag.name);
        if (!el) return;

        const others = Array.from(this.catsEl.querySelectorAll<HTMLElement>('.cat[data-group]')).filter(
            (r) => r !== el && r.dataset.group !== ALL_GROUP
        );

        // 落在「第一个中点低于指针」的那一行之前；没有这样的行就放到末尾
        const next = others.find((r) => {
            const box = r.getBoundingClientRect();
            return ev.clientY < box.top + box.height / 2;
        });
        if (next) this.catsEl.insertBefore(el, next);
        else this.catsEl.appendChild(el);
    }

    /** 松手：读过一遍 DOM 顺序交给调用方落库。没移动过就当作一次点击。 */
    private dragEnd(): void {
        const drag = this.drag;
        this.drag = null;
        if (!drag) return;

        this.catsEl.classList.remove('is-sorting');
        this.rowOf(drag.name)?.classList.remove('is-dragging');

        if (!drag.moved) return;
        this.swallowClick = true;

        const names = Array.from(this.catsEl.querySelectorAll<HTMLElement>('.cat[data-group]'))
            .map((r) => r.dataset.group ?? '')
            .filter((n) => n && n !== ALL_GROUP);
        this.hooks.onReorderGroups(names);
    }

    /** 按分类名找侧栏那一行。
     *
     *  遍历比对 `dataset.group` 而不是拼选择器：`data-group` 里的名字经过 HTML
     *  转义（`&` 写成 `&amp;`），用 `CSS.escape` 拼出来的选择器会查不到含这些字符的名字。 */
    private rowOf(name: string): HTMLElement | null {
        return (
            Array.from(this.catsEl.querySelectorAll<HTMLElement>('.cat[data-group]')).find(
                (r) => r.dataset.group === name
            ) ?? null
        );
    }

    private async copy(value: string): Promise<void> {
        if (!value.trim()) {
            toast('这一项是空的');
            return;
        }
        try {
            await navigator.clipboard.writeText(value);
        } catch {
            toast('复制失败');
            return;
        }

        // 写进剪贴板**之后**才让 Rust 侧开始计时 —— 它读的那一次 `changeCount`
        // 才是「我们刚写进去的那一份」的编号。顺序反过来（先计时后写）基准会落在
        // 写入之前，第一轮检查就会以为剪贴板被别人改过，于是立刻停表、永远清不掉。
        //
        // 计时没起来不该让提示变成「复制失败」：东西已经复制上了，那是另一件事。
        try {
            const st = await clipboardArm();
            toast(st.seconds > 0 ? `已复制 · ${st.seconds} 秒后自动清空` : '已复制');
        } catch (err) {
            reportError(`剪贴板计时未启动：${String(err)}`);
            toast('已复制');
        }
    }

    clearSearch(): void {
        this.searchEl.value = '';
        this.query = '';
        this.renderList();
        this.renderDetail();
        this.searchEl.focus();
    }

    /** 记下焦点落到了哪一行。点击与键盘都要记 —— 焦点在按钮上时算它所在那一行。 */
    private noteField(target: EventTarget | null): void {
        const row =
            target instanceof HTMLElement ? target.closest<HTMLElement>('.row[data-field]') : null;
        if (row?.dataset.field) this.currentField = row.dataset.field;
    }

    /** 某一行上那个复制按钮带着的值。行不存在或没有复制按钮时返回 null。 */
    private valueOf(key: string): string | null {
        const btn = this.detailEl.querySelector<HTMLElement>(
            `.row[data-field="${key}"] [data-copy]`
        );
        return btn?.dataset.copy ?? null;
    }

    /**
     * ⌘C：复制详情栏的「当前字段」。
     *
     * 「当前」取焦点所在的那一行；焦点不在任何一行上时退到最近点过的那一行；
     * 两者都没有时退到「密码 / 密钥」那一行。最后这条兜底是刻意的：鼠标用户点一下列表、
     * 点一下侧栏之后，焦点在哪儿是看不见的状态，而密码管理器里 ⌘C 十有八九
     * 要的就是密码或那串一次性密钥。
     *
     * 返回**复制了什么**（`null` = 这次按键不归我们管）。返回 `string | null` 而不是
     * `boolean`：调用方据此决定要不要 `preventDefault` —— 没处理却拦下按键的话，
     * 用户选中一段文字再按 ⌘C 会什么都不发生。验收也拿它断言「挑中的是哪一个字段」，
     * 因为剪贴板里的内容读不出来（读内容会触发 macOS 的粘贴权限提示，而
     * `src-tauri/src/clipboard.rs` 的整个设计就是为了绕开这件事）。
     */
    copyCurrentField(): string | null {
        if (!this.selected()) return null;

        const focused =
            document.activeElement instanceof HTMLElement
                ? document.activeElement.closest<HTMLElement>('.row[data-field]')?.dataset.field
                : undefined;
        const key = focused ?? this.currentField ?? undefined;

        const value = (key ? this.valueOf(key) : null) ?? this.valueOf(FIELD_PASSWORD);
        if (value === null) return null;

        void this.copy(value);
        return value;
    }

    focusSearch(): void {
        this.searchEl.focus();
        this.searchEl.select();
    }

    // ---------------------------------------------------------------- 对外

    /** 新建条目时的默认分类：跟随当前筛选，在全部分类下落到「未分类」 */
    preset(): string {
        return this.activeGroup === ALL_GROUP ? UNCATEGORIZED : this.activeGroup;
    }

    selectGroup(name: string): void {
        this.activeGroup = name;
        this.selectedId = null;
        this.renderAll();
    }

    currentGroup(): string {
        return this.activeGroup;
    }

    entryCount(): number {
        return this.entries().length;
    }

    knownGroups(): string[] {
        return this.groups();
    }

    /** 删除后清掉选中项再重绘。删除本身由 main.ts 走完确认流程后调用 store。 */
    forget(id: string): void {
        this.revealed.delete(id);
        if (this.selectedId === id) this.selectedId = null;
        this.renderAll();
    }

    toastSaved(message: string): void {
        toast(message);
    }
}

// -------------------------------------------------------------------- 工具

function escapeAttr(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
