/* 解锁与建库。
 *
 * 两张卡片共用 #view-unlock 这一个网格容器，同一时刻只显示一张。
 * 进哪一张由库文件在不在决定 —— 首次启动时库不存在，这是正常状态，
 * 不应该表现成「找不到文件」的错误。
 *
 * Argon2 按档位要 0.35–1.6 秒，没有进度反馈会被当成卡死（PRD F1.4），
 * 所以进度条在等待期间必须可见。 */

import { confirmDialog } from '../ui/confirm';
import { isComposing, must } from '../ui/dom';
import { formatSize, shortPath } from '../ui/format';
import { contextMenu, type MenuItem } from '../ui/menu';
import {
    IN_TAURI,
    pickNewVaultPath,
    pickVaultFile,
    revealInFinder,
    vaultDefaultPath
} from '../host';
import type { PresetName } from '../vault/kdf';
import { VaultFormatError, WrongPasswordError } from '../vault/session';
import { samePath, type VaultStore } from '../vault/store';
import { passwordScore, weaknessOf } from '../ui/password';

function errorText(err: unknown): string {
    if (err instanceof WrongPasswordError) return '主密码不正确';
    if (err instanceof VaultFormatError) return err.message;
    return err instanceof Error ? err.message : String(err);
}

export class UnlockView {
    // 解锁卡片
    private cardOpen = must('#lock-card');
    private openPw = must<HTMLInputElement>('#lock-pw');
    private openBtn = must<HTMLButtonElement>('#lock-submit');
    private openMsg = must('#lock-msg');
    private openBar = must('#lock-bar');
    private pathHint = must('#lock-path');
    /** 「当前库」那一行。整行是按钮，点开换库菜单 —— 换库、建库、在访达中显示
     *  三个动作都收在里面，所以卡片底部不再有那一行按钮。 */
    private vaultRow = must<HTMLButtonElement>('#lock-vault');

    // 建库卡片
    private cardCreate = must('#lock-create');
    private newName = must<HTMLInputElement>('#new-name');
    private newPw = must<HTMLInputElement>('#new-pw');
    private newPw2 = must<HTMLInputElement>('#new-pw2');
    private newPreset = must<HTMLSelectElement>('#new-preset');
    private newMeter = must('#new-pw-meter > i');
    private newHint = must('#new-pw-hint');
    private newBtn = must<HTMLButtonElement>('#new-submit');
    private newMsg = must('#new-msg');
    private newBar = must('#new-bar');
    private newLoc = must('#new-loc');
    private newLocPick = must<HTMLButtonElement>('#new-loc-pick');
    private newLocHint = must('#new-loc-hint');

    /** 建库要落到哪个文件。**由用户看得见、可改**，不再从「当前库位置」推断 ——
     *  后者是配置优先的，换过一次库之后建库会落到上一次打开的那个库里。
     *  进建库卡片时定一次，之后由 `#new-loc-pick` 改。 */
    private createPath = '';
    /** 应用数据目录下的默认位置。用来判断落点是不是「默认那个」。 */
    private defaultPath = '';

    private busy = false;
    /** `notice()` 记下的一句话，由 `prepare()` 在渲染完之后写到当前卡片上 */
    private pendingNotice = '';
    /** 库文件存在时，建库卡片底部那个按钮是「返回解锁」；不存在时它改作「打开其他库」 */
    private hasVault = false;
    private backFoot = must('#new-foot');
    private backBtn = must<HTMLButtonElement>('#new-back');

    constructor(
        private store: VaultStore,
        private onUnlocked: () => void
    ) {
        this.wire();
    }

    // ---------------------------------------------------------------- 接线

    private wire(): void {
        this.openBtn.addEventListener('click', () => void this.submitOpen());
        this.openPw.addEventListener('keydown', (ev) => {
            // 单字段的登录卡里「回车 = 解锁」是标准预期，保留；只排除输入法选词那一下。
            if (isComposing(ev)) return;
            if (ev.key === 'Enter') void this.submitOpen();
        });

        this.newBtn.addEventListener('click', () => void this.submitCreate());
        for (const el of [this.newName, this.newPw, this.newPw2]) {
            el.addEventListener('keydown', (ev) => {
                // 这三个字段里 `#new-name` 最危险：库名几乎一定是中文，用输入法打完
                // 按回车选词，就会当场把保险箱建出来 —— 落一个自己没打算建的文件。
                if (isComposing(ev)) return;
                if (ev.key === 'Enter') void this.submitCreate();
            });
        }
        this.newPw.addEventListener('input', () => this.updateMeter());

        this.vaultRow.addEventListener('click', () => this.openVaultMenu());
        this.newLocPick.addEventListener('click', () => void this.pickCreateLocation());
        this.backBtn.addEventListener('click', () => {
            // 没有可返回的解锁页时，这个位置留给「打开其他库」。
            // 曾经是直接把这个按钮藏掉 —— 结果第一次启动、手上已经有现成库
            // （比如从 KeePassXC 迁过来）的用户，被关在建库卡片里没有出口。
            if (this.hasVault) this.showCreate(false);
            else void this.pickOther();
        });
    }

    // ---------------------------------------------------------------- 换库菜单

    /** 「当前库」那一行点开的菜单。
     *
     *  原先这三个动作是卡片底部的两个按钮 + 路径行右侧的一个小按钮，铺成两行、
     *  还需要两条分隔线把三组分开。它们回答的其实是同一个问题 —— 「换哪一个库」——
     *  所以归到一个入口里，和侧栏底栏那个库菜单是同一种做法。
     *
     *  「在访达中显示」的显示条件原先是 `renderReveal()`：非预览环境、库存在、
     *  且知道路径。菜单项是在点击时才拼的，所以条件直接写在里面，不再需要
     *  一个「渲染时同步按钮可见性」的函数。 */
    private openVaultMenu(): void {
        const rect = this.vaultRow.getBoundingClientRect();
        const items: MenuItem[] = [
            { label: '打开其他库…', onPick: () => void this.pickOther() },
            { label: '新建保险箱…', onPick: () => void this.startCreate() }
        ];
        // 库还没建时没有可显示的目标，这一项不出现
        if (IN_TAURI && this.hasVault && Boolean(this.store.status().path)) {
            items.push({ label: '在访达中显示', onPick: () => void this.revealCurrent() });
        }
        contextMenu({ x: rect.left, y: rect.bottom + 6 }, items);
    }

    // ---------------------------------------------------------------- 打开其他库

    /** F1.3：挑一个别的 `.kdbx`，把它记为当前库（PRD §5.1 路径记入配置）。
     *
     *  这里是解锁页的入口 —— 还没有会话，所以没有东西需要先落盘。
     *  换完之后重新分流：那个文件在就进解锁卡片，不在就进建库卡片。 */
    private async pickOther(): Promise<void> {
        if (this.busy) return;

        let picked: string | null;
        try {
            picked = await pickVaultFile();
        } catch (err) {
            this.message(this.openMsg, `打开文件选择器失败：${errorText(err)}`);
            return;
        }
        if (!picked) return; // 用户取消

        let exists = false;
        try {
            exists = (await this.store.switchPath(picked)).exists;
        } catch (err) {
            this.message(this.openMsg, errorText(err));
            return;
        }

        await this.prepare();
        // prepare 会清消息，所以提示放在它后面
        this.message(
            exists ? this.openMsg : this.newMsg,
            exists
                ? `已切换到 ${shortPath(picked)}，输入它的主密码`
                : `${shortPath(picked)} 这个位置还没有库，将在此新建`
        );
    }

    // ---------------------------------------------------------------- 建库落点

    /** 切到建库 / 解锁卡片。
     *
     *  public 是给启动自检用的：它要量建库卡片在默认窗口里是否完整可见，
     *  而卡片高度取决于路径文字折成几行 —— 只能走真实渲染，
     *  手工切 DOM 类名会把两行的路径量成一行。 */
    async showCreateCard(create: boolean): Promise<void> {
        if (create) {
            await this.startCreate();
            return;
        }
        this.showCreate(false);
    }

    /** 从解锁卡片进建库卡片。落点回到默认位置。
     *
     *  这一步不能沿用「当前库位置」：能走到这里说明那个位置**已经有一个库了**
     *  （解锁卡片只在库存在时出现），拿它当落点会立刻撞上「这个位置已经有一个库了」。 */
    private async startCreate(): Promise<void> {
        try {
            this.createPath = await vaultDefaultPath();
        } catch {
            // 拿不到默认位置时退到当前库的目录，至少不是空的
            this.createPath = this.store.status().path;
        }
        this.showCreate(true);
    }

    /** 给新建的库挑一个保存位置。对话框开在默认目录、预填库名，
     *  不想挑位置的人直接回车就落到默认位置。 */
    private async pickCreateLocation(): Promise<void> {
        if (this.busy) return;

        let picked: string | null;
        try {
            picked = await pickNewVaultPath(this.createPath || (await vaultDefaultPath()));
        } catch (err) {
            this.message(this.newMsg, `打开文件选择器失败：${errorText(err)}`);
            return;
        }
        if (!picked) return; // 用户取消，落点保持原样

        this.createPath = picked;
        this.renderCreateLocation();
        this.message(this.newMsg, '');
    }

    /** 路径整串显示，不截断 —— 截断之后恰好把「在哪个目录」切掉。 */
    private renderCreateLocation(): void {
        this.newLoc.textContent = this.createPath || '—';
        this.newLoc.title = this.createPath;
        // 只有「用户改过位置、且改到的不是默认那个」才占提示行。
        // 上面的路径已经说了库落在哪，默认时再解释一句只是占高度。
        const custom =
            !!this.createPath && !!this.defaultPath && !samePath(this.createPath, this.defaultPath);
        this.newLocHint.textContent = custom ? '库文件会直接落在你选的这个位置，只保存在本机' : '';
        this.newLocHint.classList.toggle('hidden', !custom);
    }

    // ---------------------------------------------------------------- 在访达中显示

    /** 光给一行路径不足以让人找到库文件：`~/Library` 在 Finder 里是隐藏的。
     *
     *  入口在「当前库」菜单里（原先挂在路径行右侧，路径行撤掉之后归到这里）。 */
    private async revealCurrent(): Promise<void> {
        const path = this.store.status().path;
        if (!path) return;
        try {
            await revealInFinder(path);
        } catch (err) {
            this.message(this.openMsg, `无法在访达中显示：${errorText(err)}`);
        }
    }

    private updateMeter(): void {
        const { level, color } = passwordScore(this.newPw.value);
        this.newMeter.style.width = `${(level / 3) * 100}%`;
        this.newMeter.style.background = color;

        const weak = weaknessOf(this.newPw.value);
        // 默认文案与 index.html 里 #new-pw-hint 的初始值同一句，改一处要改两处
        this.newHint.textContent = this.newPw.value && weak ? weak : '用一句你记得住的话，越长越安全';
        this.newHint.classList.toggle('warn', Boolean(this.newPw.value) && Boolean(weak));
    }

    private message(node: HTMLElement, text: string): void {
        node.textContent = text;
    }

    private setBusy(on: boolean, which: 'open' | 'create'): void {
        this.busy = on;

        // 切的是 `.is-idle`（`visibility`）而不是 `.hidden`（`display`）——
        // 进度条要**一直占着那 17px**，否则点「解锁」的瞬间卡片会长高，按钮跳一下。
        const openBar = this.openBar;
        const newBar = this.newBar;
        openBar.classList.toggle('is-idle', !(on && which === 'open'));
        newBar.classList.toggle('is-idle', !(on && which === 'create'));

        this.openBtn.disabled = on;
        this.openPw.disabled = on;
        this.newBtn.disabled = on;
        for (const el of [this.newName, this.newPw, this.newPw2, this.newPreset, this.newLocPick]) {
            el.disabled = on;
        }
    }

    // ---------------------------------------------------------------- 卡片切换

    private showCreate(create: boolean): void {
        this.cardCreate.classList.toggle('hidden', !create);
        this.cardOpen.classList.toggle('hidden', create);
        // 底部这个按钮在两种状态下都有用：有库时回解锁页，没库时去挑别的库。
        // 文案跟着变而不是藏起来 —— 藏掉会让「手上有现成库」的用户困在建库卡片里。
        this.backFoot.classList.remove('hidden');
        this.backBtn.textContent = this.hasVault ? '返回解锁' : '打开其他库';
        this.message(this.newMsg, '');
        this.message(this.openMsg, '');

        if (create) {
            this.newPw.value = '';
            this.newPw2.value = '';
            this.updateMeter();
            this.renderCreateLocation();
            this.newPw.focus();
        } else {
            this.openPw.focus();
        }
    }

    /** 启动或锁定时调用：看库在不在，进对应的卡片 */
    async prepare(): Promise<void> {
        this.setBusy(false, 'open');
        this.openPw.value = '';
        this.message(this.openMsg, '');
        // 路径先退回「读取中…」：这一行要等一次 IPC 才知道填什么。留空的话
        // 卡片里会缺一块（首帧就是这样），而留着上一轮的值更糟 —— 用户刚在设置里
        // 换过库的话，它显示的是一个已经不是当前库的路径。读到之后覆盖。
        this.pathHint.textContent = '读取中…';

        if (!IN_TAURI) {
            // 浏览器预览没有宿主，走内存数据。这条分支只为调界面存在。
            this.pathHint.textContent = '浏览器预览 · 数据不落盘';
            this.showCreate(false);
            this.openPw.value = 'preview';
            this.message(this.openMsg, '预览模式：直接解锁');
            this.applyNotice();
            return;
        }

        try {
            this.defaultPath = await vaultDefaultPath();
            const info = await this.store.probe();
            this.hasVault = info.exists;
            // 这一行只留路径末两段（`shortPath`）：完整路径塞进卡片会折成两行，
            // 把主密码框与按钮整体往下顶。要看全路径有设置页「主库位置」那一行，
            // 要定位文件点开这一行的菜单即可。
            this.pathHint.textContent = info.exists
                ? `${shortPath(info.path)} · ${formatSize(info.size)}`
                : shortPath(info.path);
            // 这里原先在位置取自配置时追加一句「（来自「打开其他库」）」。删掉了 ——
            // 「打开其他库」是个按钮名，把它当库的来源讲不成话；而库落在哪，
            // 上面那行路径已经写明，换到别处也能一眼看出来。
            // 这个位置没有库时，建库卡片默认就落在它上面 ——
            //「打开其他库」挑了一个空位置之后，界面承诺的是「将在此新建」
            if (!info.exists) this.createPath = info.path;
            this.showCreate(!info.exists);
        } catch (err) {
            // 读不到时给一个占位符而不是留空：留空看起来像「这一行本来就没有内容」，
            // 而真相是「没读到」。与设置页那几个读不到时的「—」一致。
            this.pathHint.textContent = '—';
            this.showCreate(false);
            this.message(this.openMsg, errorText(err));
        }

        this.applyNotice();
    }

    /** 从解锁页外面写一句提示。
     *
     *  自动锁定回到解锁页时用：界面突然退回解锁页而没有任何说明，看起来像应用出了问题。
     *  只记不写 DOM —— `prepare()` 会先清消息再渲染，直接写会被它清掉。 */
    notice(text: string): void {
        this.pendingNotice = text;
    }

    private applyNotice(): void {
        const text = this.pendingNotice;
        if (!text) return;
        this.pendingNotice = '';
        // 落在哪张卡片上取决于库在不在，所以看当前显示的是哪一张
        const onCreate = !this.cardCreate.classList.contains('hidden');
        this.message(onCreate ? this.newMsg : this.openMsg, text);
    }

    // ---------------------------------------------------------------- 解锁

    private async submitOpen(): Promise<void> {
        if (this.busy) return;

        const password = this.openPw.value;
        if (!password) {
            this.message(this.openMsg, '请输入主密码');
            this.openPw.focus();
            return;
        }

        this.message(this.openMsg, '');
        this.setBusy(true, 'open');

        try {
            await this.store.open(password);
            this.setBusy(false, 'open');
            this.openPw.value = '';
            this.onUnlocked();
        } catch (err) {
            this.setBusy(false, 'open');
            this.message(this.openMsg, errorText(err));
            this.openPw.focus();
            this.openPw.select();
        }
    }

    // ---------------------------------------------------------------- 建库

    private async submitCreate(): Promise<void> {
        if (this.busy) return;

        const name = this.newName.value.trim();
        if (!name) {
            this.message(this.newMsg, '库名不能为空');
            this.newName.focus();
            return;
        }

        const password = this.newPw.value;
        if (!password) {
            this.message(this.newMsg, '请设置主密码');
            this.newPw.focus();
            return;
        }
        if (password !== this.newPw2.value) {
            this.message(this.newMsg, '两次输入的主密码不一致');
            this.newPw2.focus();
            this.newPw2.select();
            return;
        }

        // 弱密码只劝一次。拦下来更像找麻烦，而这一串是用户自己要记住的。
        // （F7.5 之后主密码能在设置页改，但「劝一次」这个分寸不变 ——
        //  建库当下就把人拦在门外，代价与收益不成比例。）
        const weak = weaknessOf(password);
        if (weak) {
            const go = await confirmDialog({
                title: '主密码偏弱',
                body: `${weak}。\n\n主密码丢失后没有找回途径，请确认你记得住这一串。`,
                confirmText: '就用这个',
                danger: true
            });
            if (!go) {
                this.newPw.focus();
                this.newPw.select();
                return;
            }
        }

        this.message(this.newMsg, '');
        this.setBusy(true, 'create');

        const preset = this.newPreset.value as PresetName;

        try {
            await this.store.create({ password, name, preset, path: this.createPath });
            this.setBusy(false, 'create');
            this.newPw.value = '';
            this.newPw2.value = '';
            this.hasVault = true;
            this.onUnlocked();
        } catch (err) {
            this.setBusy(false, 'create');
            this.message(this.newMsg, errorText(err));
        }
    }
}
