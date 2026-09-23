/* 设置面板。
 *
 * 已接通的：主题、自动锁定与锁屏锁定、剪贴板清除、KDF 档位（F7.6）、
 * 修改主密码（F7.5）、库位置（打开其他库 / 用默认位置）、导出库文件、备份整组。
 * 每一项都真的落到磁盘与行为上，「拨了开关什么都没发生」这种状态不留。
 *
 * 面板上显示的值全部来自 `config.json` 或**当前库的文件头**，不在前端另存一份。
 * 理由与 Rust 侧的 `settings_update` 契约一致：备份成功后 Rust 会写 `lastBackupAt`，
 * 前端持有一份快照的话，两边迟早不一致，而「上次备份成功时间」正是发现备份
 * 坏掉的第一信号 —— 它显示错了，这个功能就白做了。
 *
 * KDF 那一栏是个例外，它读的是库文件头而不是配置：配置里的 `kdfPreset` 是
 * 「新建库用哪一档」，换档之后两者会分叉，显示配置值等于告诉用户「没换成」。 */

import { confirmDialog, promptDialog, secretDialog } from '../ui/confirm';
import { must, toast } from '../ui/dom';
import { exportFileName, formatSize, friendlyTime, shortPath, vaultDisplayName } from '../ui/format';
import { contextMenu, type MenuItem } from '../ui/menu';
import { weaknessOf } from '../ui/password';
import { DONATE_URL, checkUpdate, type CheckState } from '../ui/update';
import {
    IN_TAURI,
    appVersion,
    backupRun,
    backupStatus,
    openExternal,
    pickBackupDir,
    pickSavePath,
    pickVaultFile,
    clipboardConfigure,
    lockConfigure,
    revealInFinder,
    settingsGet,
    settingsUpdate,
    type AppConfig,
    type BackupStatus
} from '../host';
import { DEFAULT_PRESET, KDF_PRESETS, type PresetName } from '../vault/kdf';
import { WrongPasswordError } from '../vault/session';
import type { VaultStore } from '../vault/store';

export interface SettingsHost {
    /** 换库之后当前会话已经断开，界面要退回解锁页并重新分流 */
    onVaultSwitched: () => void;
}

function errorText(err: unknown): string {
    if (err instanceof WrongPasswordError) return '主密码不正确';
    return err instanceof Error ? err.message : String(err);
}

export class SettingsView {
    private openOtherBtn = must<HTMLButtonElement>('#set-open-other');
    private revealBtn = must<HTMLButtonElement>('#set-reveal');
    private exportBtn = must<HTMLButtonElement>('#set-export');
    private vaultNameEl = must('#set-vault-name');
    private renameVaultBtn = must<HTMLButtonElement>('#set-rename-vault');

    private autoLockEl = must<HTMLSelectElement>('#set-autolock');
    private clipClearEl = must<HTMLSelectElement>('#set-clipclear');
    private kdfEl = must<HTMLSelectElement>('#set-kdf');
    private kdfApplyBtn = must<HTMLButtonElement>('#set-kdf-apply');
    private kdfCurrentEl = must('#set-kdf-current');
    private changePwBtn = must<HTMLButtonElement>('#set-change-pw');

    private backupPathEl = must('#set-backup-path');
    /** 备份目录的「选择…」。**它没有禁用态** —— 挑一个目录不依赖任何已读到的状态。
     *
     *  这里原先有一句 `disabled = false` 写在 `renderBackupState()` 的
     *  「状态读不到」分支里，而 `index.html` 上又把 `disabled` 写死 ——
     *  真机上状态一定会读到，那句永远跑不到，按钮就一直是灰的。
     *  一处「只在异常路径上恢复的可用态」＝ 正常路径上永久失效。 */
    private backupPickBtn = must<HTMLButtonElement>('#set-backup-pick');
    private backupAutoEl = must<HTMLInputElement>('#set-backup-auto');
    private backupLastEl = must('#set-backup-last');
    private backupPill = must('#set-backup-state');
    private backupNowBtn = must<HTMLButtonElement>('#set-backup-now');
    private keepEl = must<HTMLInputElement>('#set-keep');

    private versionEl = must('#set-version');
    private updateStateEl = must('#set-update-state');
    private checkUpdateBtn = must<HTMLButtonElement>('#set-check-update');
    private donateBtn = must<HTMLButtonElement>('#set-donate');

    /** 当前版本号，从宿主读一次就存着。它是二进制的属性，运行期间不会变。 */
    private currentVersion = '';

    /** 发现新版本时的下载页地址。按钮在「下载更新」与「立即检查」两种语义间切换，
     *  这一格就是「当前按的是哪一种」——比每次去读按钮文案可靠。 */
    private pendingUpdate: string | null = null;

    /** 最近一次读到的配置。`null` 表示还没读到（或当前不在应用环境里）。
     *
     *  「重建之后要按哪一档重新起自动锁定」从这里取，所以它必须反映磁盘，
     *  不能只在打开面板时读一次 —— 用户刚把自动锁定改成 30 分钟又去换 KDF，
     *  捕获一次的值会把 30 分钟改回 5 分钟。 */
    private config: AppConfig | null = null;

    /** 正在重建库。
     *
     *  重建会经过 `saveState: saving → saved`，那是 `store.subscribe` 的触发源；
     *  置位期间 `syncKdf()` / `renderKdf()` 直接返回，否则跑到一半按钮会被重新点亮，
     *  用户能在会话正要被整体替换的那一刻再点一次。 */
    private busy = false;

    constructor(
        private store: VaultStore,
        private host: SettingsHost
    ) {
        this.wireData();
        this.wireBackup();
        this.wireAutoLock();
        this.wireClipboard();
        this.wireKdf();
        this.wirePassword();
        this.wireAbout();

        // 库路径与「能不能导出」都跟着会话状态走
        store.subscribe(() => {
            this.renderVaultPath();
            this.renderVaultName();
            this.exportBtn.disabled = !store.isOpen();
            this.syncKdf();
            // 每次保存都会带上备份结果，面板开着的时候要跟着变
            void this.refreshBackupView();
        });

        void this.renderVersion();
        void this.refresh();
    }

    // ------------------------------------------------------------ 关于

    /** 版本号只在这一处写进界面，来源是宿主（即二进制的 `tauri.conf.json`）。
     *  页面上没有第二个地方写版本 —— 两处各写一份、发版时漏改一处，就会出
     *  「装了新版、界面还说是旧版」，而更新检查正是拿这个值去比对的。 */
    private async renderVersion(): Promise<void> {
        try {
            this.currentVersion = await appVersion();
            this.versionEl.textContent = `v${this.currentVersion}`;
        } catch {
            // 浏览器预览里没有宿主。显示一个破折号，别假装知道版本
            this.versionEl.textContent = '—';
        }
    }

    private wireAbout(): void {
        this.checkUpdateBtn.addEventListener('click', () => void this.checkForUpdate());
        this.donateBtn.addEventListener('click', () => void this.openUrl(DONATE_URL));
    }

    /** 「检查更新」。
     *
     *  这是应用自己发起的唯一一个网络请求，只在按下这一下发生 —— 没有启动检查，
     *  也没有后台轮询。发现新版本之后按钮变成「下载更新」，点它去**下载页**而不是
     *  直接下 DMG：首次打开会被 Gatekeeper 拦下来，而页面上写了怎么处理。 */
    private async checkForUpdate(): Promise<void> {
        if (this.pendingUpdate) {
            await this.openUrl(this.pendingUpdate);
            return;
        }
        if (!IN_TAURI) {
            toast('浏览器预览里检查不了更新，请在应用里试');
            return;
        }
        if (!this.currentVersion) await this.renderVersion();
        if (!this.currentVersion) {
            this.renderUpdateState({ kind: 'failed' });
            return;
        }

        this.checkUpdateBtn.disabled = true;
        this.renderUpdateState({ kind: 'checking' });
        const state = await checkUpdate(this.currentVersion);
        this.checkUpdateBtn.disabled = false;
        this.renderUpdateState(state);
    }

    /** 四种结果各自的文案。「检查失败」必须与「已是最新」分开说 ——
     *  把读不到说成最新，等于告诉用户可以放心。 */
    private renderUpdateState(state: CheckState): void {
        const set = (text: string, cls: string): void => {
            this.updateStateEl.textContent = text;
            this.updateStateEl.className = cls;
        };

        this.pendingUpdate = state.kind === 'available' ? state.url : null;

        switch (state.kind) {
            case 'checking':
                this.checkUpdateBtn.textContent = '检查中…';
                set('', '');
                break;
            case 'latest':
                this.checkUpdateBtn.textContent = '立即检查';
                set('已是最新版本', '');
                break;
            case 'available':
                this.checkUpdateBtn.textContent = '下载更新';
                set(`发现新版本 v${state.version}`, 'is-new');
                break;
            case 'failed':
                this.checkUpdateBtn.textContent = '立即检查';
                set('检查失败，请稍后再试', 'is-bad');
                break;
        }
    }

    /** 唤起系统浏览器。域名白名单在 Rust 侧，这里只负责把失败说出来。 */
    private async openUrl(url: string): Promise<void> {
        try {
            await openExternal(url);
        } catch (err) {
            toast(`打开链接失败：${errorText(err)}`, 3600);
        }
    }

    // ------------------------------------------------------------ 读配置

    /** 从磁盘现读一次，铺到面板上。
     *
     *  面板每次打开都会调它 —— 备份状态在面板关着的时候也会变
     *  （保存一次就镜像一次），拿上次打开时的快照显示等于在骗人。 */
    async refresh(): Promise<void> {
        if (!IN_TAURI) return;

        try {
            this.config = await settingsGet();
        } catch (err) {
            toast(`读取设置失败：${errorText(err)}`);
            return;
        }

        const cfg = this.config;

        this.autoLockEl.value = String(cfg.autoLockMinutes);
        this.syncKdf();
        this.backupAutoEl.checked = cfg.backupAuto;
        this.keepEl.value = String(cfg.keepVersions);
        must<HTMLInputElement>('#set-lockonsleep').checked = cfg.lockOnSleep;
        (must<HTMLSelectElement>('#set-clipclear')).value = String(cfg.clipboardClearSeconds);

        await this.refreshBackupView();
    }

    /** 写一项设置。只传改动的那一项 —— 整份覆盖会冲掉 Rust 刚写的时间戳。 */
    private async patch(fields: Record<string, unknown>, failHint: string): Promise<void> {
        if (!IN_TAURI) {
            toast('浏览器预览里改不了设置，请在应用里试');
            return;
        }
        try {
            // 返回的是**落盘之后**的那份：越界值会被 Rust 收回到最近的合法档位，
            // 面板要按它重新渲染，否则界面显示的和磁盘上的不是一个值
            this.config = await settingsUpdate(fields);
            this.applyConfig(this.config);
        } catch (err) {
            toast(`${failHint}：${errorText(err)}`, 3600);
            // 失败时把控件拉回磁盘上那份，别让用户以为改成了
            void this.refresh();
        }
    }

    private applyConfig(cfg: AppConfig): void {
        this.autoLockEl.value = String(cfg.autoLockMinutes);
        this.syncKdf();
        this.backupAutoEl.checked = cfg.backupAuto;
        this.keepEl.value = String(cfg.keepVersions);
        must<HTMLInputElement>('#set-lockonsleep').checked = cfg.lockOnSleep;
        (must<HTMLSelectElement>('#set-clipclear')).value = String(cfg.clipboardClearSeconds);
        void this.refreshBackupView();
    }

    // ------------------------------------------------------------ 只读展示

    /** 「库名」那行。库名为空时退回文件名这条口径与侧栏底栏共用
     *  `vaultDisplayName()`，两处各写一份迟早会不一致。
     *
     *  改库名要写进加密体，所以库没打开时按钮点不动 —— 没有会话就没有落点。 */
    private renderVaultName(): void {
        const status = this.store.status();
        const label = vaultDisplayName(this.store.vaultName, status.path);

        this.vaultNameEl.textContent = label;
        // 「库名」那格是单行省略，长库名要能悬停看全 —— title 给全名而不是路径
        this.vaultNameEl.title = label;
        this.renameVaultBtn.disabled = !this.store.isOpen();
    }

    private renderVaultPath(): void {
        const el = must('#set-vault-path');
        const status = this.store.status();

        el.textContent = status.path || '—';
        if (status.exists && status.size > 0) {
            el.textContent += ` · ${formatSize(status.size)}`;
        }
        el.title = status.path;

        // 「在访达中显示」要有一个真实存在的文件才有目标
        this.revealBtn.disabled = !status.exists || !status.path;

        // 位置不是默认那个时，按钮文案跟着变 —— 否则「主库位置」这个标题
        // 下面挂着一个别处的路径，看起来像显示错了
        this.openOtherBtn.textContent = status.configured ? '更改位置…' : '打开其他库…';
    }

    /** 库文件在 `~/Library/Application Support/` 下，而 Finder 默认隐藏 `~/Library`，
     *  所以「路径写在那儿」和「人能找到它」是两件事。 */
    private async reveal(): Promise<void> {
        const path = this.store.status().path;
        if (!path) return;
        try {
            await revealInFinder(path);
        } catch (err) {
            toast(`无法在访达中显示：${errorText(err)}`);
        }
    }

    /** 改库名。两个字段一起写这件事在 `kdbx.ts` 的 `renameVault()` 里，
     *  这里只负责问一次新名字、落盘、报一句。
     *
     *  与它下面那行「主库位置」无关：库名写在库文件内部，磁盘上的文件名不动。 */
    private async renameVault(): Promise<void> {
        const current = this.store.vaultName;
        const name = await promptDialog({
            title: '重命名保险箱',
            label: '新的库名',
            value: current,
            placeholder: '例如：公司凭据',
            // 一字未改就不必写一次盘。空值由 promptDialog 自己拦。
            validate: (value) => (value === current ? '与当前库名相同' : null)
        });
        if (!name || name === current) return;

        try {
            this.store.renameVault(name);
            toast(`库名已改为「${name}」`);
        } catch (err) {
            toast(`改库名失败：${errorText(err)}`, 3600);
        }
    }

    // ------------------------------------------------------------ 备份状态

    private async refreshBackupView(): Promise<void> {
        if (!IN_TAURI) {
            this.renderBackupState(null);
            return;
        }
        try {
            this.renderBackupState(await backupStatus());
        } catch {
            /* 状态拿不到不该让面板崩掉 */
        }
    }

    /** 四种状态要能一眼分开（PRD F7.8）。用 `null` 表示「读不到」，
     *  它与「未设置」是两回事 —— 读不到时不该说「未设置备份目录」，
     *  那会让用户去重新配一个本来配好的目录。 */
    private renderBackupState(st: BackupStatus | null): void {
        const pill = this.backupPill;
        pill.classList.remove('ok', 'warn', 'bad');

        if (!st) {
            this.backupPathEl.textContent = '—';
            this.backupPathEl.title = '';
            this.backupLastEl.textContent = '读取中…';
            pill.textContent = '—';
            this.backupNowBtn.disabled = true;
            return;
        }

        const dir = st.dir;
        this.backupPathEl.textContent = dir ? shortPath(dir) : '未设置';
        this.backupPathEl.title = dir ?? '还没有选择备份目录';
        // 「立即备份」在没设备份目录时点不动，否则按下去只会弹一句「还没有设置备份目录」
        this.backupNowBtn.disabled = !st.configured;

        if (!st.configured) {
            pill.textContent = '未设置备份目录';
            pill.classList.add('warn');
            this.backupLastEl.textContent = '备份目录确定前不产生备份';
            return;
        }

        if (st.lastError) {
            // 配好了但没在工作 —— 这是要人去查 NAS 的那一档
            pill.textContent = st.stale ? '超过 24 小时未成功' : '上次备份失败';
            pill.classList.add('bad');
            const last = st.lastAt ? friendlyTime(st.lastAt) : '从未成功';
            this.backupLastEl.textContent = `${last} · ${st.lastError}`;
            return;
        }

        if (!st.lastAt) {
            // 刚配好还没触发过保存。这与「成功过但过期了」要分开说，
            // 否则刚设完就被告知「超过 24 小时未成功」是在吓人
            pill.textContent = '等待首次备份';
            this.backupLastEl.textContent = '下一次保存或点「立即备份」时镜像';
            return;
        }

        if (st.stale) {
            pill.textContent = '超过 24 小时未成功';
            pill.classList.add('bad');
            this.backupLastEl.textContent = friendlyTime(st.lastAt);
            return;
        }

        pill.textContent = '正常';
        pill.classList.add('ok');
        this.backupLastEl.textContent = friendlyTime(st.lastAt);
    }

    /** 报告一次备份的结果。**失败不是保存失败**，提示语要写清楚这一点。 */
    private reportBackup(run: Awaited<ReturnType<typeof backupRun>>): void {
        if (run.error) {
            toast(`备份失败（库已保存）：${run.error}`, 5200);
            return;
        }
        if (run.skipped) {
            toast(run.skipped);
            return;
        }
        if (run.outcome) {
            const o = run.outcome;
            if (o.unchanged) {
                toast('备份目录里已是最新，没有产生新的历史版本', 3600);
            } else {
                const extra = o.rotated
                    ? ` · 旧版本存为 ${o.rotated}${o.pruned ? ` · 清理 ${o.pruned} 份` : ''}`
                    : '';
                toast(`已备份 ${formatSize(o.bytes)} → ${shortPath(o.dest)}${extra}`, 4200);
            }
        }
    }

    // ------------------------------------------------------------ 数据

    private wireData(): void {
        this.revealBtn.addEventListener('click', () => void this.reveal());
        this.openOtherBtn.addEventListener('click', () => {
            if (!this.store.status().configured) {
                void this.openOther();
                return;
            }
            // 已经指向别处了，才多出「用默认位置」这一项
            const items: MenuItem[] = [
                { label: '打开其他库…', onPick: () => void this.openOther() },
                { label: '用默认位置', onPick: () => void this.useDefault() }
            ];
            const rect = this.openOtherBtn.getBoundingClientRect();
            contextMenu({ x: rect.right - 168, y: rect.bottom + 6 }, items);
        });

        this.exportBtn.addEventListener('click', () => void this.exportVault());
        this.renameVaultBtn.addEventListener('click', () => void this.renameVault());
    }

    /** F1.3：换库。当前会话会断开，所以先讲清楚代价。 */
    private async openOther(): Promise<void> {
        let picked: string | null;
        try {
            picked = await pickVaultFile();
        } catch (err) {
            toast(`打开文件选择器失败：${errorText(err)}`, 3600);
            return;
        }
        if (!picked) return; // 用户取消

        const current = this.store.status().path;
        if (current && picked !== current) {
            const ok = await confirmDialog({
                title: '打开其他库',
                body:
                    `将切换到：\n${picked}\n\n当前库会先保存，然后锁定。` +
                    `以后要回到 ${shortPath(current)} 需要重新输入它的主密码。`,
                confirmText: '打开'
            });
            if (!ok) return;
        }

        try {
            await this.store.switchPath(picked);
            toast(`已切换到 ${shortPath(picked)}`);
            this.host.onVaultSwitched();
        } catch (err) {
            toast(`换库失败：${errorText(err)}`, 3600);
        }
    }

    /** 切回默认位置。那边有没有库由换完之后的分流决定 —— 可能进解锁，也可能进建库。 */
    private async useDefault(): Promise<void> {
        const ok = await confirmDialog({
            title: '用默认位置',
            body: '将切回默认位置。当前库会先保存，然后锁定。',
            confirmText: '切换'
        });
        if (!ok) return;

        try {
            const info = await this.store.switchPath(null);
            toast(`已切回默认位置：${shortPath(info.path)}`);
            this.host.onVaultSwitched();
        } catch (err) {
            toast(`切换失败：${errorText(err)}`, 3600);
        }
    }

    // ------------------------------------------------------ 供侧栏底栏复用

    /* 侧栏底栏那行「当前是哪个库」点开的菜单，三条动作都在上面实现过了。
       这里只做转发：换库要先保存当前库、再断开会话、最后回解锁页 ——
       这套判断有一份就够了，两个入口各写一份迟早会不一致。 */

    openOtherVault(): void {
        void this.openOther();
    }

    useDefaultVault(): void {
        void this.useDefault();
    }

    revealVault(): void {
        void this.reveal();
    }

    /** F6.1：另存一份加密的 `.kdbx`。
     *
     *  导的是**内存里的最新状态**，包含还没落盘的改动 —— 直接复制磁盘上那份的话，
     *  刚改完就导出会拿到旧内容。 */
    private async exportVault(): Promise<void> {
        if (!this.store.isOpen()) return;

        let target: string | null;
        try {
            target = await pickSavePath(exportFileName(this.store.vaultName));
        } catch (err) {
            toast(`打开保存对话框失败：${errorText(err)}`, 3600);
            return;
        }
        if (!target) return; // 用户取消

        try {
            const bytes = await this.store.exportTo(target);
            toast(`已导出 ${formatSize(bytes)}：${shortPath(target)}`, 4200);
        } catch (err) {
            toast(`导出失败：${errorText(err)}`, 4200);
        }
    }

    // ------------------------------------------------------------ 备份

    private wireBackup(): void {
        this.backupPickBtn.addEventListener('click', () => void this.openBackupDirMenu());
        this.backupNowBtn.addEventListener('click', () => void this.backupNow());

        this.backupAutoEl.addEventListener('change', () => {
            void this.patch({ backupAuto: this.backupAutoEl.checked }, '保存「自动镜像」开关失败');
        });

        // 历史版本上限：数字框，边打边存会存下一串半成品（1 → 12 → 123），
        // 所以等它失焦或回车再存
        const commitKeep = (): void => {
            const n = Number(this.keepEl.value);
            if (!Number.isFinite(n)) {
                void this.refresh();
                return;
            }
            void this.patch({ keepVersions: Math.round(n) }, '保存历史版本上限失败');
        };
        this.keepEl.addEventListener('change', commitKeep);
        this.keepEl.addEventListener('blur', commitKeep);
    }

    /** 挑备份目录。
     *
     *  还没设过的时候**直接弹系统目录选择器** —— 这时他只有「挑一个」这一件事可做，
     *  中间夹一层只有一个选项的菜单等于让他多点一次。设过了才给菜单，
     *  那时他多半是来改或来清的。
     *
     *  **判断「有没有设过」要现读一次，不能用 `this.config`。** 那个字段只在
     *  `refresh()`（构造时、面板每次打开时）与 `patch()` 里更新，而备份目录在面板
     *  关着的时候也会变 —— 验收里 B3/B9 就是直接调 `settingsUpdate` 改的。
     *  拿一份停在启动时刻的快照来判断，会把「已经设过」认成「没设过」，
     *  于是想清除目录的人被推去挑一个新目录。读失败时退回 `this.config` 那份
     *  （浏览器预览里没有宿主，两个来源都不可用时弹选择器会自己报错）。
     *
     *  这里原先还有一条「推荐目录」链路：扫 `~/Library/CloudStorage/` 下的
     *  `SynologyDrive-*` 挂载点，每个都生成一条 `<挂载点>/99-其他/<应用目录>`。
     *  2026-09-22 整个删掉了 —— 每块盘都成一条候选，`shortPath()` 截断后几条
     *  显示得一模一样，还全都带「目录还不存在」；而单一内容盘（音乐库、照片库、
     *  影视库）本来就不是备份的去处。备份目标用户自己知道，不该由应用猜。
     *
     *  名字与 `pickBackupDir()`（真正弹系统对话框的那个）区分开 ——
     *  同名的话类方法会把导入的那个遮住，一调用就变成自己递归自己。 */
    private async openBackupDirMenu(): Promise<void> {
        let dir = this.config?.backupDir ?? null;
        try {
            dir = (await backupStatus()).dir;
        } catch {
            /* 状态读不到就按上面那份判 */
        }

        if (!dir) {
            await this.chooseCustomBackupDir();
            return;
        }

        const rect = this.backupPickBtn.getBoundingClientRect();
        const anchor = { x: rect.right - 260, y: rect.bottom + 6 };
        contextMenu(anchor, [
            { label: '更改目录…', onPick: () => void this.chooseCustomBackupDir() },
            { label: '清除备份目录', onPick: () => void this.setBackupDir(null) }
        ]);
    }

    private async chooseCustomBackupDir(): Promise<void> {
        let picked: string | null;
        try {
            picked = await pickBackupDir();
        } catch (err) {
            toast(`打开目录选择器失败：${errorText(err)}`, 3600);
            return;
        }
        if (!picked) return;
        await this.setBackupDir(picked);
    }

    private async setBackupDir(dir: string | null): Promise<void> {
        await this.patch({ backupDir: dir }, '保存备份目录失败');
        if (this.config?.backupDir === dir && dir) {
            toast(`备份目录已设为 ${shortPath(dir)}`, 4200);
        }
    }

    private async backupNow(): Promise<void> {
        this.backupNowBtn.disabled = true;
        try {
            this.reportBackup(await backupRun(true));
        } catch (err) {
            toast(`备份失败：${errorText(err)}`, 4200);
        } finally {
            // 状态在任何一条路径上都可能变（成功/失败/被跳过），统一重读一次
            await this.refreshBackupView();
            this.backupNowBtn.disabled = !this.config?.backupDir;
        }
    }

    // ------------------------------------------------------------ KDF 档位（F7.6）

    private wireKdf(): void {
        this.kdfApplyBtn.addEventListener('click', () => void this.applyPreset());
        // 拨动 select 只重新算一次「应用」按钮，不立刻重建库 ——
        // 换档会把整个库重新加密一遍，一次误触就要重来一趟。
        this.kdfEl.addEventListener('change', () => this.renderKdf());
    }

    /** 把 KDF 那一栏对齐到库的当前状态。**会改写 select 的值** ——
     *  只在「库的状态刚变过」的时机调用（打开面板、重建完成、换库）。 */
    private syncKdf(): void {
        if (this.busy) return;

        const open = this.store.isOpen();
        this.changePwBtn.disabled = !open;

        if (!open) {
            this.kdfEl.value = this.config?.kdfPreset ?? DEFAULT_PRESET;
            this.kdfEl.disabled = true;
            this.kdfApplyBtn.disabled = true;
            this.kdfCurrentEl.textContent = '库还没打开';
            return;
        }

        const h = this.store.session().header();
        this.kdfEl.disabled = false;
        this.kdfEl.value = h.preset ?? DEFAULT_PRESET;
        this.renderKdf();
    }

    /** 只刷新「当前档位」那行与「应用」的可用性，不动 select 里用户的选择。 */
    private renderKdf(): void {
        if (this.busy || !this.store.isOpen()) return;

        const h = this.store.session().header();
        this.kdfCurrentEl.textContent = h.preset
            ? `当前库：${h.preset} · ${h.memoryMiB} MiB`
            : // 第三方库可能落在三档之外。如实报参数，别硬套一个档位名
              `当前库：文件自带参数 ${h.memoryMiB} MiB / ${h.iterations} 轮`;
        // 选中项与当前档位一致时没有可做的事：按钮亮着只会让人以为漏点了什么
        this.kdfApplyBtn.disabled = this.kdfEl.value === h.preset;
    }

    private async applyPreset(): Promise<void> {
        if (!this.store.isOpen()) return;

        const target = this.kdfEl.value as PresetName;
        const cur = this.store.session().header();

        const out = await secretDialog({
            title: '换 KDF 档位',
            body:
                `会把整个库按「${target}」重新加密一次（${KDF_PRESETS[target].memoryMiB} MiB）。\n` +
                `当前档位：${cur.preset ?? `文件自带参数 ${cur.memoryMiB} MiB`}。\n` +
                `已经存在的历史版本与备份文件仍是旧参数，它们照旧用当前主密码打开。`,
            fields: [{ id: 'pw', label: '主密码', placeholder: '换档前确认一次' }],
            confirmText: '重建库'
        });
        // 取消时把 select 拨回当前档位，别让它停在没生效的那一项上
        if (!out) {
            this.syncKdf();
            return;
        }

        await this.runRebuild(
            this.kdfApplyBtn,
            '应用',
            () => this.store.changePreset(out.pw, target),
            `已按「${target}」重建库`
        );
    }

    // ------------------------------------------------------------ 修改主密码（F7.5）

    private wirePassword(): void {
        this.changePwBtn.addEventListener('click', () => void this.changeMasterPassword());
    }

    private async changeMasterPassword(): Promise<void> {
        if (!this.store.isOpen()) return;

        const out = await secretDialog({
            title: '修改主密码',
            body:
                '会用新主密码把整个库重新加密一次。改完之后：\n' +
                '· 本地历史版本与备份目录里的旧副本，仍然只能用旧主密码打开\n' +
                '· 主密码丢失后没有找回途径',
            fields: [
                { id: 'old', label: '当前主密码' },
                { id: 'next', label: '新主密码' },
                { id: 'again', label: '再输一次新主密码' }
            ],
            validateAll: (all) => (all.next === all.again ? null : '两次输入的新主密码不一致'),
            confirmText: '更改'
        });
        if (!out) return;

        // 弱密码只劝一次，与建库同一套口径（PRD §4.3）—— 拦下来更像找麻烦。
        const weak = weaknessOf(out.next);
        if (weak) {
            const ok = await confirmDialog({
                title: '主密码偏弱',
                body: `${weak}。\n\n主密码丢失后没有找回途径，请确认你记得住这一串。`,
                confirmText: '仍然使用'
            });
            if (!ok) return;
        }

        await this.runRebuild(
            this.changePwBtn,
            '修改…',
            () => this.store.changeMasterPassword(out.old, out.next),
            '主密码已更改'
        );
    }

    /** 重建期间挡住重复点击，并把结果翻译成一句提示。
     *
     *  停表 / 起表不在这里 —— 它随重建流程一起放在 `vault/store.ts` 的 `rebuild()` 里。
     *  放在那一层的理由：谁调重建都会经过，散在视图层会漏（验收就是直接调 store 的，
     *  在这里收尾它根本走不到，那两条断言会变成空转）。 */
    private async runRebuild(
        btn: HTMLButtonElement,
        idleLabel: string,
        run: () => Promise<void>,
        done: string
    ): Promise<void> {
        this.busy = true;
        btn.disabled = true;
        btn.textContent = '重建中…';
        this.kdfEl.disabled = true;

        try {
            await run();
            toast(done, 4200);
        } catch (err) {
            toast(`重建库失败：${errorText(err)}`, 5600);
        } finally {
            this.busy = false;
            btn.textContent = idleLabel;
            this.syncKdf();
            await this.refreshBackupView();
        }
    }

    /** 「自动锁定」与「锁屏与休眠时锁定」。
     *
     *  这两个值落两处：`config.json`（下次开库时用）与 Rust 侧的计时状态（立刻生效）。
     *  只落配置的话，用户把 5 分钟改成 1 分钟、界面上已经显示 1 分钟了，
     *  行为却要等下次解锁才变 —— 看着像个 bug。 */
    private wireAutoLock(): void {
        this.autoLockEl.addEventListener('change', () => void this.applyAutoLock());
        must<HTMLInputElement>('#set-lockonsleep').addEventListener('change', () =>
            void this.applyAutoLock()
        );
    }

    private async applyAutoLock(): Promise<void> {
        const minutes = Number(this.autoLockEl.value);
        const lockOnSleep = must<HTMLInputElement>('#set-lockonsleep').checked;
        await this.patch({ autoLockMinutes: minutes, lockOnSleep }, '保存自动锁定设置失败');
        await lockConfigure(minutes, lockOnSleep);
    }

    /** 「剪贴板清除」。
     *
     *  与自动锁定同一个路数：值落两处 —— `config.json`（下次启动时用）与 Rust 侧的
     *  当前档位（立刻生效）。只落配置的话，用户把 30 秒改成 15 秒、界面上已经显示
     *  15 秒了，下一次复制却还按 30 秒清 —— 看着像个 bug。
     *
     *  档位由 Rust 侧维护而不是每次复制时现读配置，理由见 `host.ts` 的 `clipboardArm`。 */
    private wireClipboard(): void {
        this.clipClearEl.addEventListener('change', () => void this.applyClipboard());
    }

    private async applyClipboard(): Promise<void> {
        const seconds = Number(this.clipClearEl.value);
        await this.patch({ clipboardClearSeconds: seconds }, '保存剪贴板设置失败');
        await clipboardConfigure(seconds);
    }
}
