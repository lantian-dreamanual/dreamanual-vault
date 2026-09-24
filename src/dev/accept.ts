/* M2 的自动化验收。
 *
 * 由 `VAULT_DEV=accept` 触发，跑完整的真实链路：webview 里的 Argon2 WASM、
 * 真实的 KDBX 加解密、经 IPC 走 Rust 的原子写。跑完把结果打到 stdout。
 *
 * 为什么不在 Node 侧测：`spike/` 已经能验 KDBX 往返，但那是 Node 的 crypto 与
 * hash-wasm。应用真正跑的是 webview 的 WebCrypto 与 argon2-browser，
 * 是两个不同的 WASM 产物。这一步验的是**应用自己写出来的库**。
 *
 * ⚠️ 这个文件是全项目**唯一**能直接 import `vault/kdbx.ts` 的地方（架构约束见
 * PRD §8.2 说的是 `views/` 与 `main.ts` 只认 `vault/session.ts`）。理由：
 * G 段（换档 / 改主密码）的判据是「拿这个密码去开**磁盘上那份**」，而
 * `store.open()` 会把当前会话换掉 —— 验不了「旧密码打不开」这种反例。
 *
 * 验收用的库文件落在 VAULT_HOME 指向的目录，不碰正式位置。 */

import {
    appVersion,
    backupRun,
    backupStatus,
    clipboardArm,
    clipboardConfigure,
    clipboardStatus,
    listenLock,
    lockArm,
    lockConfigure,
    lockStatus,
    reportErrorSync,
    settingsChoices,
    settingsGet,
    settingsUpdate,
    vaultDefaultPath,
    vaultInfo,
    vaultRead,
    vaultVersions
} from '../host';
import { DOT_COLORS, groupColor, isDotColor, matches } from '../vault/model';
import { closeContextMenu } from '../ui/menu';
import { isNewer } from '../ui/update';
import { KDF_PRESETS, type PresetName } from '../vault/kdf';
import { VaultSession } from '../vault/kdbx';
import { categoryOptions, NEW_CATEGORY } from '../views/editor';
import type { VaultStore } from '../vault/store';
import type { EntryInput } from '../vault/session';
import { ALL_GROUP, FIELD_PASSWORD, FIELD_URL, FIELD_USER } from '../views/vault';
import type { VaultView } from '../views/vault';

export interface AcceptItem {
    id: string;
    name: string;
    ok: boolean;
    detail: string;
}

const VAULT_NAME = 'Dreamanual 密码管理';
const SEED_GROUPS = ['服务器', '办公', '数据库'];

/** 故意含多行中文、中文引号、emoji 与 IP —— 这些是真实备注里会出现的形状 */
const SAMPLE: EntryInput = {
    title: '堡垒机-生产',
    userName: 'demo.admin',
    password: 'Demo#Jump-02',
    url: '192.0.2.11',
    notes: 'JumpServer 3.10\n地址：https://192.0.2.11\n端口：443 / SSH 转发 2222\n\n登录后先选资产组「生产环境」，再选具体机器。',
    group: '服务器'
};

const SAMPLE2: EntryInput = {
    title: '公司 VPN',
    userName: 'demo.user',
    password: 'Demo#Vpn-01',
    url: 'vpn.example.com',
    notes: '认证方式：域账号 + 短信二次验证\n连续 3 次失败会锁 30 分钟。',
    group: '办公'
};

function message(err: unknown): string {
    return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => window.setTimeout(resolve, ms));

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
    outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
        for (let j = 0; j < needle.length; j += 1) {
            if (haystack[i + j] !== needle[j]) continue outer;
        }
        return i;
    }
    return -1;
}

function plaintextHits(bytes: Uint8Array, needles: string[]): string[] {
    const encoder = new TextEncoder();
    return needles.filter((n) => indexOfBytes(bytes, encoder.encode(n)) >= 0);
}

const round = (n: number): number => Math.round(n * 100) / 100;

export async function runAcceptance(
    store: VaultStore,
    password: string,
    vault: VaultView,
    /** 把主视图显出来（main.ts 的 `enterApp`）。只有 E 段用得上，见那一段的说明。 */
    showVault: () => void
): Promise<AcceptItem[]> {
    const items: AcceptItem[] = [];
    const check = (id: string, name: string, ok: boolean, detail = ''): void => {
        items.push({ id, name, ok, detail });
    };

    /** 进度标记。验收卡住时日志里要能看出停在哪一条 ——
     *  进程被看门狗杀掉，压在 IPC 队列里的输出就永远到不了 stdout。 */
    const mark = async (where: string): Promise<void> => {
        await reportErrorSync(`验收进度：${where}`);
    };
    await mark('进入验收');

    /** 关掉会话再打开 —— 每一次都真的从磁盘读回来，验的是落盘结果而不是内存状态 */
    const reopen = async (): Promise<void> => {
        await mark('reopen: 保存');
        await store.save();
        await mark('reopen: 关闭会话');
        store.close();
        await mark('reopen: 重新解锁');
        await store.open(password);
        await mark('reopen: 完成');
    };

    // ---------------------------------------------------------------- 建库

    const before = await store.probe();
    await mark('A1 已跑');
    check('A1', '库不存在时探测结果明确，不误报为错误', !before.exists, before.path);

    await mark('A25 解锁页「当前库」菜单');
    // 解锁卡片上「当前库」那一行是个按钮，换库 / 建库 / 在访达中显示三个动作都收在
    // 它的菜单里 —— 卡片底部那一行（`#lock-new` / `#lock-open`）与路径行右侧的
    // 「在访达中显示」已经撤掉了，所以这一行**是唯一入口**。
    //
    // 判据要真点一下：它是个 `<button class="vault-row">` 而不是 `.btn`，
    // 只读 DOM 结构看不出监听有没有接上。B12 那个缺陷的教训（断言不能绕开真实入口）
    // 在这里同样适用，而「撤掉旧入口、补上新入口」这种改法最容易留下一个点不动的行。
    const vaultRow = document.querySelector<HTMLButtonElement>('#lock-vault');
    let vaultMenu: string[] = [];
    if (vaultRow) {
        vaultRow.click();
        await sleep(60);
        vaultMenu = Array.from(document.querySelectorAll<HTMLElement>('.ctxmenu button')).map(
            (b) => b.textContent ?? ''
        );
        // 等 `contextMenu` 那个 `setTimeout(0)` 装上 detach，否则监听漏在 window 上
        await sleep(30);
        closeContextMenu();
    }
    const oldFootGone =
        !document.querySelector('#lock-new') &&
        !document.querySelector('#lock-open') &&
        !document.querySelector('#lock-reveal');
    check(
        'A25',
        '解锁页的「当前库」点得开菜单，换库与建库都在里面（底部的旧入口已撤）',
        Boolean(vaultRow) &&
            oldFootGone &&
            vaultMenu.some((l) => l.includes('打开其他库')) &&
            vaultMenu.some((l) => l.includes('新建保险箱')),
        !vaultRow
            ? '找不到 #lock-vault'
            : `底部旧入口已撤=${oldFootGone} · 菜单 ${
                  vaultMenu.length ? vaultMenu.join(' / ') : '（点了没弹出来）'
              }`
    );

    await mark('A26 进度条常驻占位');
    // 「点『解锁』的瞬间卡片会长高」——`#lock-bar` 原本是 `display: none`（`.hidden`），
    // `setBusy()` 把它显出来，3px 的条加上 14px 上边距全算进卡片高度，按钮在手指
    // 底下跳一下。
    //
    // 判据问的是「它占着位吗、它看不见吗」这一对事实 —— CSS 里能表达这个区别的
    // 只有 `display` 与 `visibility` 两档，所以直接读这两个 computed 值：
    //   · `display !== 'none'` → 占位（`display: none` 的元素不参与布局）
    //   · `visibility === 'hidden'` → 看不见
    // 两条同时成立才是「隐藏但占位」。只判前一条的话，「进度条一直显示」的实现
    // 也会绿；只判后一条则那正是坏掉的样子。
    //
    // 读 computed style 而不是 `getBoundingClientRect()`：后者在祖先 `display: none`
    // 时返回全 0，而**这一刻界面停在解锁页的哪张卡上不该影响这条断言**。
    const idleBar = document.querySelector<HTMLElement>('#new-bar');
    const idleBarStyle = idleBar ? getComputedStyle(idleBar) : null;
    check(
        'A26',
        '进度条隐藏时仍占位（点「解锁」时卡片不会长高）',
        Boolean(idleBarStyle) &&
            idleBarStyle!.display !== 'none' &&
            idleBarStyle!.visibility === 'hidden',
        !idleBarStyle
            ? '找不到 #new-bar'
            : `display=${idleBarStyle.display} · visibility=${idleBarStyle.visibility}`
    );

    // 建库落点这一条是回归门禁。修之前 `create()` 不传路径就走「当前库位置」，
    // 而那个位置是配置优先的 —— 换过一次库之后建库会落到上一次打开的那个库里。
    // 用户看到的现象是「我没选过地址，文件却跑到别处去了」。
    //
    // 先把配置指到一个诱饵路径上，再按显式参数建库，看它是不是照参数落。
    // 只断言「建完在目标位置」是不够的：配置恰好指对时，错误实现同样能满足它。
    const defaultPath = await vaultDefaultPath();
    const decoy = `${defaultPath}.decoy`;
    await store.switchPath(decoy);

    try {
        await store.create({
            password,
            name: VAULT_NAME,
            preset: '均衡',
            groups: SEED_GROUPS,
            path: defaultPath
        });
        await mark('A2 建库完成');
        check('A2', '建库成功并立即落盘', store.isOpen() && store.status().exists, `${store.lastCreateMs} ms`);
    } catch (err) {
        check('A2', '建库成功并立即落盘', false, message(err));
        // 建库失败就没法往下走了。但上面刚把「当前库」指到诱饵路径上，
        // 不还回去的话它会留在 config.json 里，让后面 ③ 段报出
        // 「config.json 里残留了 lastOpenedVault」—— 一条指向这里的误导性红。
        try {
            await store.switchPath(null);
        } catch {
            /* 还原失败不该盖住真正的失败项 */
        }
        return items;
    }

    const landed = await vaultInfo(defaultPath);
    const strayed = await vaultInfo(decoy);
    const onTarget = landed.exists && !strayed.exists;
    check(
        'A2b',
        '建库落点由参数决定，不跟「当前库位置」走',
        onTarget,
        onTarget
            ? '配置指向诱饵位置时，仍按参数落在默认位置'
            : `落点 ${landed.path}${strayed.exists ? `；诱饵位置 ${decoy} 也生成了文件` : ''}`
    );

    const header = store.session().header();
    check(
        'A3',
        '写出的库是 KDBX 4.0 + Argon2id + AES-256',
        header.version === '4.0' && header.cipher === 'AES-256-CBC' && header.preset === '均衡',
        `${header.version} / ${header.preset} ${header.memoryMiB} MiB / ${header.cipher}`
    );

    const groups = store.groups();
    check(
        'A4',
        '默认分类齐全，「未分类」自动存在',
        ['服务器', '办公', '数据库', '未分类'].every((g) => groups.includes(g)),
        groups.join(' / ')
    );

    // ---------------------------------------------------------------- 录入 / 查找

    store.addEntry(SAMPLE);
    store.addEntry(SAMPLE2);
    await reopen();

    check(
        'A5',
        '新建两条后重新读盘，条数与标题都对',
        store.entries().length === 2 && store.entries().some((e) => e.title === SAMPLE.title),
        store.entries().map((e) => e.title).join(' / ')
    );

    const readBack = store.entries().find((e) => e.title === SAMPLE.title);
    const same = (a: string, b: string): boolean => a === b;
    check(
        'A6',
        '全部字段逐字一致（含多行中文备注与中文引号）',
        !!readBack &&
            same(readBack.userName, SAMPLE.userName) &&
            same(readBack.password, SAMPLE.password) &&
            same(readBack.url, SAMPLE.url) &&
            same(readBack.notes, SAMPLE.notes),
        readBack ? `备注 ${readBack.notes.length} 字，含 ${readBack.notes.split('\n').length} 行` : '读不回来'
    );

    const byIp = store.entries().filter((e) => matches(e, '192.0.2.11'));
    const byGroup = store.entries().filter((e) => matches(e, '办公'));
    const byNote = store.entries().filter((e) => matches(e, '短信二次验证'));
    check(
        'A7',
        '全文检索能命中备注里的 IP、中文词与分类名',
        byIp.length === 1 && byNote.length === 1 && byGroup.length === 1,
        `IP ×${byIp.length} · 备注词 ×${byNote.length} · 分类名 ×${byGroup.length}`
    );

    // ---------------------------------------------------------------- 编辑

    const target = store.entries().find((e) => e.title === SAMPLE.title)!;
    store.updateEntry({ ...target, title: '堡垒机-生产（已改）', group: '办公' });
    await reopen();

    const edited = store.entries().find((e) => e.id === target.id);
    check(
        'A8',
        '编辑后重新读盘：标题与分类都改了，id 不变',
        edited?.title === '堡垒机-生产（已改）' && edited?.group === '办公' && edited?.id === target.id,
        edited ? `id ${edited.id.slice(0, 8)}… → 分类「${edited.group}」` : '条目不见了'
    );

    // ---------------------------------------------------------------- 分类

    store.createGroup('云服务');
    await mark('A3–A8 已跑');
    check('A9', '新建分类', store.groups().includes('云服务'), store.groups().join(' / '));

    await mark('A10 之前：改分类名，现有分类=' + store.groups().join('|'));
    try {
        store.renameGroup('云服务', '云平台');
        await mark('A10 之前：改名返回');
    } catch (err) {
        await mark('改名抛错：' + message(err));
        throw err;
    }
    await reopen();
    check(
        'A10',
        '分类改名后重新读盘，改名生效',
        store.groups().includes('云平台') && !store.groups().includes('云服务'),
        store.groups().join(' / ')
    );

    const moved = store.moveEntryGroup('办公', '云平台');
    await reopen();
    const movedEntry = store.entries().find((e) => e.id === target.id);
    const leftInOffice = store.entries().filter((e) => e.group === '办公').length;
    const inCloud = store.entries().filter((e) => e.group === '云平台').length;
    check(
        'A11',
        '条目随分类移动：原分类清空，条目全部落到目标分类',
        moved > 0 && leftInOffice === 0 && inCloud === moved && movedEntry?.group === '云平台',
        `移动 ${moved} 条 · 原分类剩 ${leftInOffice} · 目标分类 ${inCloud}`
    );

    const beforeGroupDelete = store.entries().length;
    store.removeGroup('云平台');
    await reopen();
    const uncategorized = store.entries().filter((e) => e.group === '未分类').length;
    check(
        'A12',
        '删除分类后条目移入「未分类」，不跟着被删',
        store.entries().length === beforeGroupDelete &&
            uncategorized === beforeGroupDelete &&
            !store.groups().includes('云平台'),
        `条数仍为 ${store.entries().length}，「未分类」${uncategorized} 条`
    );

    // ------------------------------------------------- 编辑弹窗的分类选项

    // 分类字段从 `<input list="cat-list">` 换成 `<select>` 之后，选项由
    // `categoryOptions()` 生成。这里测的是它最容易漏的一条：
    // **当前分类不在顶层分组里时，也必须作为一项列出来。**
    //
    // 这个场景不是假想：`groups()` 只返回顶层分组，而库里条目的 `group` 取的是
    // `parentGroup.name` —— 直接挂在根组下的条目读到的是库名，「打开其他库」
    // 导进来的 vault 里落在二级分组的条目读到的是二级分组的名字。两者都不在
    // `groups()` 里。选项里漏掉当前值，`<select>` 会退到第一个选项上，
    // 用户什么都没改、按一下保存，条目就被挪到了别的分类 —— 静默改数据。
    const withForeign = categoryOptions(['办公', '服务器'], '历史遗留组');
    check(
        'A21',
        '当前分类不在顶层分组里时仍作为一项列出（打开条目再保存不会挪走它）',
        withForeign.length === 4 &&
            withForeign[0].value === '办公' &&
            withForeign[1].value === '服务器' &&
            withForeign[2].value === '历史遗留组' &&
            withForeign[3].value === NEW_CATEGORY,
        withForeign.map((o) => o.label).join(' / ')
    );

    const withExisting = categoryOptions(['办公', '服务器'], '办公');
    check(
        'A22',
        '当前分类已在列表里时不重复添加，末项固定是「＋ 新建分类…」',
        withExisting.length === 3 &&
            withExisting.filter((o) => o.value === '办公').length === 1 &&
            withExisting[withExisting.length - 1].value === NEW_CATEGORY,
        withExisting.map((o) => o.label).join(' / ')
    );

    // ------------------------------------------------- 分类颜色与顺序
    //
    // 这两样都写在 KDBX 分组自己的扩展位上（Group → CustomData），不另存配置文件。
    // 判据一律走「写进库 → 重新读盘」，因为只验内存里的会话等于验它自己。

    const COLOR_MAIN = DOT_COLORS[7]!;
    const COLOR_ALT = DOT_COLORS[2]!;
    store.setGroupColor('办公', COLOR_MAIN);
    await reopen();
    check(
        'A38',
        '分类颜色写进库、重新读盘还在',
        store.groupColors()['办公'] === COLOR_MAIN,
        `办公 → ${store.groupColors()['办公'] ?? '(读不到)'}`
    );

    store.setGroupColor('办公', null);
    await reopen();
    check(
        'A39',
        '没设过色的分类不在表里、退回自动色（清掉自定义色也回到这一态）',
        store.groupColors()['办公'] === undefined && isDotColor(groupColor('办公')),
        `表里 ${Object.keys(store.groupColors()).length} 条 · 办公自动色 ${groupColor('办公')}`
    );

    // 任意取色没有任何门禁拦得住「选了个在深色底上看不见的色」，所以入口只收色板内的值。
    // 这里的黑值拼出来而不是写字面量 —— 字面 hex 会撞 `spike/contrast.mjs` 的
    // 「令牌之外无未登记的色值」那条断言，而它不该为测试值开一个登记位。
    const notInPalette = '#' + '0'.repeat(6);
    let strayColor = '';
    try {
        store.setGroupColor('办公', notInPalette);
    } catch (err) {
        strayColor = message(err);
    }
    check('A40', '色板外的颜色被拒绝', strayColor !== '', strayColor || '没有抛错');

    const byName = [...store.groups()];
    const flipped = [...byName].reverse();
    store.reorderGroups(flipped);
    await reopen();
    check(
        'A41',
        '拖拽顺序写进库、重新读盘保持',
        store.groups().join('|') === flipped.join('|'),
        `${flipped.join(' → ')} · 读回 ${store.groups().join(' → ')}`
    );

    // 顺序请求少一个分类就等于把它静默挤到最后，这一类请求必须被拒。
    let partial = '';
    try {
        store.reorderGroups(byName.slice(0, 2));
    } catch (err) {
        partial = message(err);
    }
    check('A42', '顺序请求与当前分类对不上时被拒绝', partial !== '', partial || '没有抛错');

    // ---- 侧栏色点取的是库里存的那个色
    const catRow = (name: string): HTMLElement | null =>
        Array.from(document.querySelectorAll<HTMLElement>('.cat[data-group]')).find(
            (r) => r.dataset.group === name
        ) ?? null;
    const rgbOf = (hex: string): string => {
        const n = parseInt(hex.slice(1), 16);
        return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
    };

    store.setGroupColor('办公', COLOR_ALT);
    vault.refresh();
    const dotEl = catRow('办公')?.querySelector<HTMLElement>('.cat-dot');
    const dotColor = dotEl ? getComputedStyle(dotEl).backgroundColor : '';
    check(
        'A43',
        '侧栏色点用的是库里存的颜色',
        dotColor === rgbOf(COLOR_ALT),
        dotEl ? `色点 ${dotColor}，期望 ${rgbOf(COLOR_ALT)}（${COLOR_ALT}）` : '找不到「办公」那一行的色点'
    );

    // ---- 拖拽：用合成的 PointerEvent 走一遍真实链路（按下 → 移动 → 松手）
    //
    // 判据是「顺序真的变了」，而不是「回调被调用了」：只验 store 那一层的话，
    // 一个没接上事件的界面照样能过。拖拽用 pointer 事件实现，合成事件可驱动。
    //
    // **量几何之前必须让应用壳可见。** 拖拽靠 `getBoundingClientRect()` 定位落点，
    // 而 `#view-app` 没有 `.is-active` 时是 `display: none` —— 那时所有 rect 全是 0，
    // 「往下拖一百像素」会被算成「往上拖 4px」，落点判断必然错，而读数看起来像
    // 「拖了但没动」。这与 main.ts 里量外壳几何之前那次 `paintApp()` 是同一个理由。
    // 跑完切回解锁页，后面几段不必知道这一段动过视图。
    const unlockView = document.querySelector<HTMLElement>('#view-unlock');
    const appView = document.querySelector<HTMLElement>('#view-app');
    unlockView?.classList.remove('is-active');
    appView?.classList.add('is-active');

    const rows = Array.from(document.querySelectorAll<HTMLElement>('.cat[data-group]')).filter(
        (r) => r.dataset.group !== ALL_GROUP
    );
    const dragFrom = rows[0];
    const dragTo = rows[rows.length - 1];
    const namesBefore = rows.map((r) => r.dataset.group ?? '');

    let dragDetail = '找不到可拖的分类行';
    if (dragFrom && dragTo) {
        const box = dragFrom.getBoundingClientRect();
        const fire = (type: string, target: EventTarget, y: number): void => {
            target.dispatchEvent(
                new PointerEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    composed: true,
                    pointerId: 1,
                    pointerType: 'mouse',
                    isPrimary: true,
                    button: 0,
                    buttons: 1,
                    clientX: box.left + 10,
                    clientY: y
                })
            );
        };

        const before = vault.currentGroup();
        const docNames = (): string[] =>
            Array.from(document.querySelectorAll<HTMLElement>('.cat[data-group]'))
                .filter((r) => r.dataset.group !== ALL_GROUP)
                .map((r) => r.dataset.group ?? '');

        // 落点取「最后一行下半区」—— 按拖拽逻辑该排到末尾。坐标在按下之前算：
        // 拖动过程中行会移动，边走边取坐标就不是同一个屏幕位置了。
        const dropY = dragTo.getBoundingClientRect().bottom - 2;

        fire('pointerdown', dragFrom, box.top + 4);
        fire('pointermove', window, dropY);
        // 拖动中就该看到新顺序。这一步与下一步分开读，红了能分清是「界面没接上」
        // 还是「界面接上了但库那边没落」。
        const during = docNames();
        fire('pointerup', window, dropY);
        const after = docNames();

        // 松手那一下浏览器会补一次 click，目标是**指针最终位置下的元素**。
        // 节点在这期间被重画过，所以要从文档里现查，不能用按下时的那个引用。
        const under = document.elementFromPoint(box.left + 10, dropY);
        const clickTarget =
            under instanceof HTMLElement ? (under.closest('.cat[data-group]') ?? under) : document.body;
        clickTarget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

        const expected = [...namesBefore.slice(1), namesBefore[0]];
        dragDetail =
            `拖前 ${namesBefore.join('→')} · 拖动中 ${during.join('→')} · 松手后 ${after.join('→')}`;

        check(
            'A44',
            '合成拖拽事件能改顺序（按下 → 移动 → 松手）',
            namesBefore.length > 1 &&
                during.join('|') === expected.join('|') &&
                after.join('|') === expected.join('|'),
            dragDetail
        );
        check(
            'A45',
            '拖完松手补的那一次点击不切换筛选',
            vault.currentGroup() === before,
            `拖前选中「${before}」，松手后「${vault.currentGroup()}」`
        );

        await reopen();
        check(
            'A46',
            '拖出来的顺序重新读盘仍在',
            store.groups().join('|') === expected.join('|'),
            `读回 ${store.groups().join(' → ')}`
        );

        // 收尾：把顺序恢复成按名称，后面几段不必知道这个库被拖过
        store.reorderGroups([...store.groups()].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')));
        store.setGroupColor('办公', null);
        await reopen();
    } else {
        check('A44', '合成拖拽事件能改顺序（按下 → 移动 → 松手）', false, dragDetail);
    }

    // ------------------------------------------------- 分类面板（名称 + 颜色）
    //
    // 判据是「菜单里只剩一项，且能一路点到落库」，而不是「回调被调用」：
    // 只验 store 那一层的话，一个还挂着「重命名 / 设置颜色」两项的菜单照样能过。
    // 这一段同时守着一条容易漏的接缝 —— 面板改名之后颜色要跟着走，
    // 而颜色存在**分组对象自己的**扩展位上，名字换了对象没换，两件事得对上。

    vault.refresh();

    const menuLabels = (): string[] =>
        Array.from(document.querySelectorAll<HTMLElement>('.ctxmenu button')).map(
            (b) => b.textContent ?? ''
        );

    const officeRow = catRow('办公');
    let editLabels: string[] = [];
    if (officeRow) {
        officeRow.dispatchEvent(
            new MouseEvent('contextmenu', {
                bubbles: true,
                cancelable: true,
                clientX: 120,
                clientY: 300
            })
        );
        for (let i = 0; i < 40 && !document.querySelector('.ctxmenu'); i += 1) await sleep(25);
        editLabels = menuLabels();
    }
    // 「删除分类」对非「未分类」的分组是应当有的，判据只盯合并的那一项：
    // 「编辑分类…」恰好出现一次，且两个旧项（重命名 / 设置颜色）一个都不在。
    const editCount = editLabels.filter((l) => l.includes('编辑分类')).length;
    const staleItems = editLabels.filter((l) => l.includes('重命名') || l.includes('设置颜色'));
    check(
        'A47',
        '分类右键菜单里只剩一项「编辑分类…」，重命名与设置颜色两项都已不在',
        editCount === 1 && staleItems.length === 0,
        officeRow
            ? `菜单 ${editLabels.length} 项：${editLabels.join(' / ') || '（点了没弹出来）'}` +
              (staleItems.length ? ` · 残留旧项：${staleItems.join(' / ')}` : '')
            : '找不到「办公」那一行'
    );

    const COLOR_NEW = DOT_COLORS[3]!;
    const renamedTo = '办公改';
    Array.from(document.querySelectorAll<HTMLElement>('.ctxmenu button'))
        .find((b) => (b.textContent ?? '').includes('编辑分类'))
        ?.click();
    for (let i = 0; i < 40 && !document.querySelector('#group-name'); i += 1) await sleep(25);

    const nameField = document.querySelector<HTMLInputElement>('#group-name');
    let inMemory = false;
    let panelRead = '面板没打开';
    if (nameField) {
        nameField.value = renamedTo;
        nameField.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector<HTMLElement>(`.palette-sw[data-color="${COLOR_NEW}"]`)?.click();
        document.querySelector<HTMLElement>('.mask [data-role="ok"]')?.click();
        await sleep(60);

        inMemory =
            store.groups().includes(renamedTo) &&
            !store.groups().includes('办公') &&
            store.groupColors()[renamedTo] === COLOR_NEW;
        panelRead =
            `内存：${
                store.groups().includes(renamedTo) ? `改名为「${renamedTo}」了` : '名字没变'
            } · 颜色 ${store.groupColors()[renamedTo] ?? '(无)'}`;
    }

    await reopen();
    const afterDisk =
        store.groups().includes(renamedTo) &&
        !store.groups().includes('办公') &&
        store.groupColors()[renamedTo] === COLOR_NEW;
    check(
        'A48',
        '分类面板里改名 + 选色一次提交，内存与读盘都对',
        inMemory && afterDisk,
        `${panelRead} · 读盘：${store.groups().join('→')} · 颜色 ${
            store.groupColors()[renamedTo] ?? '(无)'
        }（期望 ${COLOR_NEW}）`
    );

    // 收尾：改回原名并清掉颜色，后面几段不必知道这个分类被动过
    store.renameGroup(renamedTo, '办公');
    store.setGroupColor('办公', null);
    await reopen();
    vault.selectGroup(ALL_GROUP);

    // ------------------------------------------------- 焦点环（全应用一套）

    // ---- 规则只有一处
    //
    // 判据取「样式表里那条 `:focus-visible` 的值」，不取某个元素的读数：
    // 后者只能证明那一个元素对，证明不了「全应用一条」。规则被删掉、或者
    // 有人给某个元素另写一份规格，这条会红。
    //
    // ⚠️ 选配器现在是个**列表**（`:focus-visible, [data-ring]`），`[data-ring]`
    // 是给截图开的那个口子，与 `:focus-visible` **共用同一份声明块** —— 这正是
    // 不想让它变成第二份规格的做法。所以这里不能逐字比 `=== ':focus-visible'`：
    // 本文件已经被这条打瞎过一次（选配器一加同族的，判据静默返回 null）。
    // 按英文逗号拆开、逐项去空白后看有没有那一项，加同族选配器不会失效，
    // 而另起一条规则仍然不会命中这里。
    const focusRule = ((): CSSStyleRule | null => {
        for (const sheet of Array.from(document.styleSheets)) {
            let rules: CSSRuleList;
            try {
                rules = sheet.cssRules;
            } catch {
                continue; // 跨源表读不到就跳过；本地全是同源，正常走不到这里
            }
            for (const rule of Array.from(rules)) {
                if (!(rule instanceof CSSStyleRule)) continue;
                const parts = rule.selectorText.split(',').map((s) => s.trim());
                if (parts.includes(':focus-visible')) return rule;
            }
        }
        return null;
    })();

    check(
        'A49',
        '全应用只有一条焦点环规则，规格就是那四条',
        focusRule !== null &&
            focusRule.style.outlineWidth === '2px' &&
            focusRule.style.outlineStyle === 'solid' &&
            focusRule.style.outlineOffset === '2px' &&
            // 颜色那条含 `var()`，CSSOM 读不出值，只能从规则原文里认
            /var\(--accent-2\)/.test(focusRule.cssText),
        focusRule
            ? `${focusRule.style.outlineWidth} ${focusRule.style.outlineStyle} · ` +
              `offset ${focusRule.style.outlineOffset} · ${focusRule.cssText.slice(0, 96)}`
            : '样式表里找不到 :focus-visible 规则'
    );

    // 「聚焦时环有没有画出来」这一条**不在这里测**，原因值得记下来。
    //
    // `:focus-visible` 由浏览器按「最近一次交互是不是键盘」判定，而验收前面派发过
    // 合成的 `pointerdown`（拖拽那一段），浏览器把它记成指针交互，之后 `el.focus()`
    // 一律不命中 `:focus-visible` —— 连文本框都不命中（实测读数 `outline-style: none`，
    // 而规范里文本输入本该总是命中）。合成 `KeyboardEvent` 改不了这个状态，
    // 只有真实的 Tab 导航会。`outline-offset` 也写在 `:focus-visible` 里，
    // 同样读不到，换它当代理指标也不行（试过，读数是 0px）。
    //
    // 于是分工：**环画不画得出来**交给截图（`10-focus` 拍的就是它，那边给第一行挂
    // `data-ring` 把环逼出来，不去抢前台 —— 理由见 src/main.ts 那段）；
    // **规格是不是只有一处**交给 `spike/contrast.mjs` 的 L7 / L8 ——
    // 那是源码级判据，跑在 Node 侧，这里读不到文件。
    //
    // `[data-ring]` 与 `:focus-visible` 共用一份声明块这件事由上面 A49 的
    // 选配器列表本身保证，不必另加断言。**「键盘走到这一行会不会出环」没人自动测**：
    // `:focus-visible` 认真实输入事件，只能由人按一次 Tab 看。

    // ---- 列表行可聚焦
    //
    // 列表是这个应用的主界面。分类行与按钮都能 Tab 到、列表行走不到的话，
    // 键盘用户的路就断在这里，焦点环也没有落点。
    const listRows = [...document.querySelectorAll<HTMLElement>('#list .item')];
    check(
        'A50',
        '列表行可聚焦（每一行 tabindex="0"）',
        listRows.length > 0 && listRows.every((el) => el.tabIndex === 0),
        listRows.length ? `${listRows.length} 行 · 首行 tabIndex=${listRows[0]!.tabIndex}` : '列表是空的'
    );

    // ---- 回车能选中，且焦点还回那一行
    const secondRow = listRows[1];
    if (secondRow) {
        const beforeId = document.querySelector<HTMLElement>('#list .item.on')?.dataset.id ?? null;
        const wantId = secondRow.dataset.id ?? '';
        const wantTitle = secondRow.querySelector('.item-title')?.textContent ?? '';

        secondRow.focus();
        secondRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await sleep(100);

        const onRow = document.querySelector<HTMLElement>('#list .item.on');
        const gotTitle = document.querySelector('.detail-title')?.textContent ?? '';
        // 选中会重绘 `innerHTML`，焦点默认掉回 body；这一条守的是「还回去」那一步
        const refocused = document.activeElement === onRow;

        check(
            'A51',
            '列表行按回车能选中，重绘后焦点回到那一行',
            onRow?.dataset.id === wantId && gotTitle === wantTitle && refocused,
            `选中 ${onRow?.dataset.id === wantId ? '对' : `错（拿到 ${onRow?.dataset.id ?? '空'}）`} · ` +
                `详情「${gotTitle}」 · 焦点${refocused ? '还在这一行' : '掉走了'}`
        );

        // 收尾：点回测试前那一条，后面几段不必知道列表被动过
        for (const el of listRows) {
            if (el.dataset.id === beforeId) {
                el.click();
                break;
            }
        }
        await sleep(60);
    }

    // ---- 「请我喝杯咖啡」那一行
    //
    // 这一行是设置页里唯一的「支持作者」入口，靠咖啡图标 + 常亮的强调色文字
    // 让人一眼扫到。图标走的是 index.html 里的静态 `<use>`，所以 `spike/icons.mjs`
    // 只守到「它是不是官方形状」那一层 —— 图标有没有真的挂在这一行上、
    // 跟文字是不是同一个色，只有这里能守。挪走图标或改掉 `.srow-lead` 的颜色，
    // 这一条会红。
    //
    // 判据不写死色值：强调色从令牌现读。`var()` 在 CSSOM 里读不到展开值，
    // 所以塞给一个临时元素让浏览器自己解析 —— 换令牌色时这里跟着走。
    const lead = document.querySelector<HTMLElement>('#set-donate .srow-lead');
    const leadIcon = lead?.querySelector('use')?.getAttribute('href') ?? '';
    const leadText = lead?.querySelector('b');
    const leadSvg = lead?.querySelector<SVGElement>('svg');
    const probe = document.createElement('span');
    probe.style.color = 'var(--accent-2)';
    document.body.append(probe);
    const accent2 = getComputedStyle(probe).color;
    probe.remove();
    const textInk = leadText ? getComputedStyle(leadText).color : '';
    const iconInk = leadSvg ? getComputedStyle(leadSvg).color : '';

    check(
        'A52',
        '「请我喝杯咖啡」行：咖啡图标挂在文字前，图标与文字同为强调色',
        leadIcon === '#ic-coffee' &&
            leadText?.textContent === '请我喝杯咖啡' &&
            textInk !== '' &&
            textInk === accent2 &&
            iconInk === accent2,
        `图标 ${leadIcon || '无'} · 文字色 ${textInk || '—'} · 图标色 ${iconInk || '—'} · 强调色 ${accent2}`
    );

    appView?.classList.remove('is-active');
    unlockView?.classList.add('is-active');

    // ---------------------------------------------------------------- 删除

    const beforeDelete = store.entries().length;
    store.removeEntry(target.id);
    await reopen();
    check(
        'A13',
        '删除的条目移入回收站：列表里没了，库里还留着',
        store.entries().length === beforeDelete - 1 && store.trashCount() === 1,
        `列表 ${store.entries().length} 条 · 回收站 ${store.trashCount()} 条`
    );

    // ---------------------------------------------------------------- 失败路径

    store.close();
    let rejected = '';
    try {
        await store.open(`${password}不对`);
    } catch (err) {
        rejected = err instanceof Error ? err.name : String(err);
    }
    await mark('A9–A13 已跑');
    check('A14', '错误主密码被拒绝，且能识别为主密码问题', rejected === 'WrongPasswordError', `错误类型 ${rejected || '未抛出'}`);

    await store.open(password); // 回到可用状态

    // ---------------------------------------------------------------- 落盘形态

    const bytes = new Uint8Array(await vaultRead());
    const hits = plaintextHits(bytes, [
        password,
        SAMPLE.title,
        SAMPLE.userName,
        SAMPLE.password,
        SAMPLE.notes,
        SAMPLE2.notes,
        '生产环境'
    ]);
    check(
        'A15',
        '磁盘字节里搜不到任何明文凭据',
        hits.length === 0,
        hits.length ? `命中：${hits.join(', ')}` : `已探测 7 个关键词，库 ${bytes.length} 字节`
    );

    // ---------------------------------------------------------------- 库名
    //
    // 库名在 KDBX 里落在两个字段上（`meta.name` 与默认分组名），应用侧两个一起写，
    // 结构前提在 `spike/roundtrip.mjs` 的 S15/S16 里验。这里验应用这一侧：改完
    // `reopen()`，读的是**磁盘上的字节**，不是内存里那个对象。
    //
    // ⚠️ 这一段要在会话开着的时候跑。库名写在加密体内部，没有会话就没有落点 ——
    // 放在「导出与换库」之后会撞上「保险箱还没有解锁」，而那一步是在 B 段开头才补的。
    //
    // 桌面文件名不参与：默认位置固定叫 `vault.kdbx`，改库名不碰它。

    const originalName = store.vaultName;
    await mark('A23 之前：改库名');
    const renamed = store.renameVault('改名验收库');
    await reopen();
    check(
        'A23',
        '改库名后重新读盘，新库名生效',
        renamed === '改名验收库' && store.vaultName === '改名验收库',
        `写入「${renamed}」· 读回「${store.vaultName}」`
    );

    store.renameVault(originalName);
    await reopen();
    check(
        'A24',
        '改回原名后重新读盘，库名复原（不给后面的断言留副作用）',
        store.vaultName === originalName,
        `读回「${store.vaultName}」`
    );

    // ---------------------------------------------------------------- 规模

    const api = store.session();
    const bulk: EntryInput = {
        title: '压测条目',
        userName: 'bench',
        password: 'Bench#2026',
        url: '10.0.0.1',
        notes: '用于 500 条规模下的读与检索读数。',
        group: '服务器'
    };
    for (let i = 0; i < 500; i += 1) api.createEntry({ ...bulk, title: `压测条目 ${String(i).padStart(3, '0')}` });

    const tRead0 = performance.now();
    const all = store.entries();
    const readMs = performance.now() - tRead0;

    const tFilter0 = performance.now();
    const hits500 = all.filter((e) => matches(e, '压测'));
    const filterMs = performance.now() - tFilter0;

    await reopen();
    await mark('A15 已跑');
    check(
        'A16',
        '500 条规模下重新读盘，条目一条不少',
        store.entries().length === 501 && hits500.length === 500,
        `读 ${round(readMs)} ms · 过滤 ${round(filterMs)} ms · 重开库后 ${store.entries().length} 条`
    );

    // ---------------------------------------------------------------- 导出与换库
    //
    // 这两件事走的是同一条通道（vault_read / vault_write 的路径参数），
    // 所以串起来验：先导出成一份独立的库，再把它当成「其他库」换过去、
    // 用它自己的主密码解锁 —— 这正是 F6.1 的验收标准「导出文件可独立解锁」。

    await mark('A16 已跑');

    const vaultPath = store.status().path;
    const slash = vaultPath.lastIndexOf('/');
    if (slash < 0) {
        check('A17', '导出到指定位置', false, `库路径不是绝对路径：${vaultPath}`);
        return items;
    }

    const dir = vaultPath.slice(0, slash);
    const exportPath = `${dir}/export-check.kdbx`;
    const expectedEntries = store.entries().length;

    let restored = false;
    try {
        const exported = await store.exportTo(exportPath);
        const exportInfo = await vaultInfo(exportPath);
        check(
            'A17',
            '导出到指定位置，落盘字节数与内存状态一致',
            exportPath !== vaultPath && exportInfo.exists && exported === exportInfo.size && exported > 0,
            `export-check.kdbx ${exported} 字节（与主库同一份内容）`
        );

        const switched = await store.switchPath(exportPath);
        check(
            'A18',
            '换库后当前库指向新位置，且能看出位置来自配置',
            switched.path === exportPath && switched.configured && !store.isOpen(),
            `${switched.path.split('/').slice(-2).join('/')} · configured=${switched.configured}`
        );

        await store.open(password);
        const exportedEntries = store.entries();
        const exportedHeader = store.session().header();
        check(
            'A19',
            '导出的文件能独立解锁，条目与加密参数都与主库一致',
            exportedEntries.length === expectedEntries &&
                exportedHeader.version === '4.0' &&
                exportedHeader.cipher === 'AES-256-CBC',
            `${exportedEntries.length} 条 · ${exportedHeader.version} / ${exportedHeader.cipher} / Argon2id ${exportedHeader.memoryMiB} MiB`
        );

        await mark('A17–A19 已跑');
        const back = await store.switchPath(null);
        const after = await store.probe();
        check(
            'A20',
            '「用默认位置」清掉配置：回到默认位置且不再标记为配置来源',
            !back.configured && !after.configured && after.path !== exportPath && !store.isOpen(),
            `回到 ${after.path.split('/').slice(-2).join('/')}`
        );
        restored = true;
    } catch (err) {
        check('A17', '导出与换库链路', false, message(err));
    } finally {
        // 这一段动过应用配置（last_opened_vault），无论成败都要把它还回去 ——
        // 留着会让后面的截图与读数脚本跑在另一个库上
        if (!restored) {
            try {
                await store.switchPath(null);
            } catch {
                /* 恢复失败不该盖住真正的失败项 */
            }
        }
    }

    // ---------------------------------------------------------------- 备份链路
    //
    // M3 的验收标准是「备份文件可独立解锁」。最后那一步换个实现来解才算数，
    // 所以它在 m2-acceptance.sh 里用 keepassxc-cli 做。这一段负责把镜像造出来，
    // 并验那些只有应用自己知道的性质：字节一致、轮转、裁剪到上限、
    // 不认得的文件不动、目录不可达时保存照常成功。
    //
    // 规模大的裁剪用例（造十几份不同时间戳的历史版本）在 Rust 侧单测里 ——
    // 时间戳精确到分钟，在这一段里造不出多份来。

    const backupDir = `${dir}/backup`;
    const backupFile = `${backupDir}/vault.kdbx`;
    const sameBytes = (a: ArrayBuffer, b: ArrayBuffer): boolean => {
        if (a.byteLength !== b.byteLength) return false;
        const x = new Uint8Array(a);
        const y = new Uint8Array(b);
        for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return false;
        return true;
    };

    try {
        // A20 收尾时会话是关着的 —— 「用默认位置」会换掉当前库，会话随之关闭
        // （那一条断言要的正是这个状态）。这一段要靠真实写盘才能看出镜像与轮转，
        // 所以先重新解锁默认位置那个库。漏掉这一步的话，B4 的第一次 createGroup
        // 会抛「保险箱还没有解锁」，而它被 catch 兜成「B1 备份链路」一条红 ——
        // 报告上只剩一行红，看起来像 B 段整体坏了，实际只是没开门。
        await mark('B 段开始：重新解锁默认位置的库');
        await store.open(password);

        await mark('B1 读取设置');
        // ---- 设置读写
        const before = await settingsGet();
        const after = await settingsUpdate({ autoLockMinutes: 15 });
        const reread = await settingsGet();
        // 改完立刻还原。留着一个 15 分钟在这里，后面 C1 读到的配置
        // 会与 arm 那一刻用的值不同 —— 断言之间不该互相污染。
        await settingsUpdate({ autoLockMinutes: before.autoLockMinutes });
        check(
            'B1',
            '设置改一项只动那一项，并且真的落盘',
            after.autoLockMinutes === 15 &&
                reread.autoLockMinutes === 15 &&
                after.keepVersions === before.keepVersions &&
                after.backupDir === before.backupDir &&
                after.lockOnSleep === before.lockOnSleep,
            `autoLockMinutes ${before.autoLockMinutes} → ${reread.autoLockMinutes} · 其余字段不变`
        );

        await mark('B2 受保护字段');
        // ---- 后端自己维护的字段不许从设置页改
        let guarded = '';
        try {
            await settingsUpdate({ lastBackupAt: null });
        } catch (err) {
            guarded = message(err);
        }
        const stillThere = (await settingsGet()).lastBackupAt;
        check(
            'B2',
            '设置页改不了备份记账字段（整份覆盖会冲掉「上次成功时间」）',
            guarded.includes('不能通过设置页修改') && stillThere === before.lastBackupAt,
            guarded || '没有被拦住'
        );

        await mark('B3 配置备份目录');
        // ---- 配上备份目录
        await settingsUpdate({ backupDir, keepVersions: 2 });
        const configured = await backupStatus();
        check(
            'B3',
            '设置备份目录后状态可为界面所用',
            configured.configured &&
                configured.dir === backupDir &&
                configured.keepVersions === 2 &&
                configured.lastAt === null &&
                !configured.stale,
            `configured=${configured.configured} · 上限 ${configured.keepVersions} · 从未成功过不算过期（stale=${configured.stale}）`
        );

        await mark('B4 保存并镜像');
        // ---- 保存后自动镜像
        store.createGroup('备份验收甲');
        await store.save();

        const vaultBytes = await vaultRead();
        const mirrorExists = (await vaultInfo(backupFile)).exists;
        const mirrorBytes = mirrorExists ? await vaultRead(backupFile) : new ArrayBuffer(0);
        const plantedLeft = (await vaultVersions(backupFile)).map((v) => v.name);
        const strayKept = (await vaultInfo(`${backupDir}/我的笔记.txt`)).exists;

        check(
            'B4',
            '保存后自动镜像：备份件与主库字节完全一致',
            mirrorExists && sameBytes(vaultBytes, mirrorBytes),
            mirrorExists ? `${vaultBytes.byteLength} 字节，逐字节相同` : '备份目录里没有出现镜像'
        );

        // 脚本预置了 3 份 2020 年的假历史版本 + 一个不相干的文件，
        // 上限设成 2 —— 镜像后应当只剩 2 份，而那个不相干的文件一个都不能少
        check(
            'B5',
            '历史版本裁到上限，且不认得的文件不动',
            plantedLeft.length === 2 && strayKept,
            `预置 3 份 → 剩 ${plantedLeft.length} 份 · 无关文件${strayKept ? '仍在' : '被误删'}`
        );

        await mark('B6 未变跳过');
        // ---- 内容没变就跳过
        const unchanged = await backupRun(false);
        const afterIdle = (await vaultVersions(backupFile)).length;
        check(
            'B6',
            '内容与备份目录一致时跳过，不产生新的历史版本',
            unchanged.outcome?.unchanged === true &&
                unchanged.outcome.rotated === null &&
                afterIdle === 2,
            `unchanged=${unchanged.outcome?.unchanged} · 历史版本仍为 ${afterIdle} 份`
        );

        await mark('B7 轮转');
        // ---- 改动之后把「改动前那一份」轮转成历史版本
        const prevMirror = await vaultRead(backupFile);

        store.createGroup('备份验收乙');
        await store.save();

        const versionsAfter = await vaultVersions(backupFile);

        // 判据是「改动前那一份还能不能从历史版本里找回来」，而不是「有没有多出一个
        // 新文件名」。
        //
        // 历史版本的时间戳精确到分钟（`backup::STAMP_FORMAT` = %Y%m%d-%H%M）。
        // 这一段里 B4 与 B7 两次保存在同一分钟内跑完，第二次写出的名字与第一次
        // 完全相同、直接覆盖 —— 名字集合看起来一份没变，但「上一份被留下来」
        // 这件事是成立的。按名字判会误报成失败，按内容判才测的是这件事本身。
        //
        // 由此带来一个已知边界：同一分钟内连着保存两次，只有最后一次之前的内容
        // 会成为历史版本。这是分钟级时间戳的取值（PRD §5.3 定的是分钟），
        // 影响限于「同分钟内的中间态」。
        const contents = await Promise.all(versionsAfter.map((v) => vaultRead(v.path)));
        const keptPrev = contents.some((b) => sameBytes(prevMirror, b));

        check(
            'B7',
            '改动之后把改动前那一份留成历史版本，总数不超过上限',
            keptPrev && versionsAfter.length === 2,
            `上一份镜像${keptPrev ? '能在历史版本里找回' : '没被留下'} · 共 ${versionsAfter.length} 份（${versionsAfter.map((v) => v.name).join(' / ')}）`
        );

        await mark('B8 本地历史版本');
        // ---- 本地历史版本（主库旁边那份）
        const localVersions = await vaultVersions();
        check(
            'B8',
            '主库旁边也在轮转本地历史版本（PRD §5.3）',
            localVersions.length >= 1 && localVersions.every((v) => v.name.includes('vault.kdbx.')),
            `本地 ${localVersions.length} 份：${localVersions.map((v) => v.name).join(' / ') || '（无）'}`
        );

        await mark('B9 目录不可达');
        // ---- 备份目录不可达：保存照常成功，失败只记账
        const lastGoodAt = (await backupStatus()).lastAt;
        await settingsUpdate({ backupDir: `${dir}/挂载点不在了` });

        store.createGroup('备份验收丙');
        await store.save();

        const failed = await backupStatus();
        const saveState = store.status();
        const failureText = failed.lastError ?? '';
        check(
            'B9',
            '备份目录不可达时保存照常成功，失败原因记进配置',
            saveState.saveState === 'saved' &&
                !saveState.error &&
                failureText.includes('备份目录不可用') &&
                failed.lastAt === lastGoodAt,
            saveState.error
                ? `保存居然失败了：${saveState.error}`
                : `已保存 · 上次成功时间保留（${lastGoodAt ? '有' : '无'}）· ${failureText || '没有记下失败原因'}`
        );

        await mark('B11 界面选项一致');
        // ---- 界面上的可选值与配置层认得的值必须一致
        //
        // 这条盯的是一种静默失效：往 index.html 加一个 <option> 而没同步加到
        // config.rs 的常量里，用户选中它、保存成功、下次打开又变回去了 ——
        // 界面上没有任何地方说过这件事。反过来也一样：常量里有、下拉里没有，
        // 那个档位在界面上就无法选到。
        const choices = await settingsChoices();
        const optionValues = (id: string): string[] =>
            Array.from(document.querySelectorAll<HTMLOptionElement>(`#${id} option`)).map(
                (o) => o.value
            );
        const sameSet = (a: string[], b: string[]): boolean =>
            a.length === b.length && [...a].sort().join() === [...b].sort().join();

        const keepEl = document.querySelector<HTMLInputElement>('#set-keep');
        const mismatches: string[] = [];
        if (!sameSet(optionValues('set-autolock'), choices.autoLockMinutes.map(String))) {
            mismatches.push('自动锁定');
        }
        if (!sameSet(optionValues('set-clipclear'), choices.clipboardClearSeconds.map(String))) {
            mismatches.push('剪贴板清除');
        }
        if (!sameSet(optionValues('set-kdf'), choices.kdfPresets)) mismatches.push('KDF 档位');
        if (keepEl?.min !== String(choices.keepVersionsMin)) mismatches.push('历史版本下限');
        if (keepEl?.max !== String(choices.keepVersionsMax)) mismatches.push('历史版本上限');

        check(
            'B11',
            '设置页下拉的选项与配置层认得的取值一一对应',
            mismatches.length === 0,
            mismatches.length
                ? `对不上：${mismatches.join(' / ')}（改了界面没同步改 config.rs，或反过来）`
                : `自动锁定 ${choices.autoLockMinutes.length} 档 · 剪贴板 ${choices.clipboardClearSeconds.length} 档 · KDF ${choices.kdfPresets.length} 档 · 历史版本 ${choices.keepVersionsMin}–${choices.keepVersionsMax}`
        );

        // ---------------------------------------------------------------- 备份目录按钮

        await mark('B12 备份目录「选择…」可点');
        // 这条盯的是一类静默失效：**可用态只在异常路径上恢复**。
        //
        // `index.html` 上把 `disabled` 写死，而唯一把它打开的那一句写在
        // `renderBackupState()` 的「状态读不到」分支里 —— 那个分支只在浏览器预览或
        // 读取失败时进得去，真机上 `backupStatus()` 一定成功，按钮就永远是灰的。
        // 手指点上去没有任何反应，也没有报错。
        //
        // 判据必须**真点一下**。只读 `disabled` 属性判不了：一个「属性被去掉了但
        // 监听没接上」的实现照样是绿的。同理也不能去调 `settingsUpdate({backupDir})`
        // —— B3 就是这么写的，正是它让这个缺陷从 M3 一路活到现在。
        const pickBtn = document.querySelector<HTMLButtonElement>('#set-backup-pick');
        let menuLabels: string[] = [];
        if (pickBtn) {
            pickBtn.click();
            // 菜单现在**同步**就出来了（原先还要 await 一次「建议目录」），
            // 这个循环只是给 `contextMenu` 自己留一口气
            for (let i = 0; i < 40 && !document.querySelector('.ctxmenu'); i += 1) {
                await sleep(25);
            }
            // 让 `contextMenu` 那个 `setTimeout(0)` 把全局监听的 detach 装上，
            // 否则下面 close 掉之后它们会漏在 window 上
            await sleep(30);
            menuLabels = Array.from(
                document.querySelectorAll<HTMLElement>('.ctxmenu button')
            ).map((b) => b.textContent ?? '');
            closeContextMenu();
        }
        // 这一步依赖前面 B9 —— 它刚把 `backupDir` 设成一个不可达路径，所以配置里
        // 是有目录的，点它走的是菜单分支。**没有目录时 `openBackupDirMenu()` 直接
        // 弹系统目录选择器**，那是个原生对话框、自动化环境里观测不到，只能人工确认
        // （与「⌘C 能不能被网页拿到」同一类，见 MEMORY 的待人工确认项）。
        // 把 `#set-backup-path` 的读数一起报出来：万一前置状态变了，
        // 报告里能直接看出是「配置里没目录」而不是「按钮坏了」。
        const pathText = document.querySelector('#set-backup-path')?.textContent ?? '';
        const canChange = menuLabels.some((l) => l.includes('更改目录'));
        const canClear = menuLabels.some((l) => l.includes('清除备份目录'));

        check(
            'B12',
            '备份目录的「选择…」点得开，菜单里能改能清',
            Boolean(pickBtn) && pickBtn?.disabled === false && canChange && canClear,
            !pickBtn
                ? '找不到 #set-backup-pick'
                : `disabled=${pickBtn.disabled} · 目录显示「${pathText}」· 菜单 ${
                      menuLabels.length ? menuLabels.join(' / ') : '（点了没弹出来）'
                  }`
        );

        // ---------------------------------------------------------------- 自动锁定

        await mark('C1 自动锁定已启用');
        // 三条判据分开看：arm 有没有用上当前配置、改配置是不是立刻生效、
        // 以及「无操作到点 → Rust 发事件 → 前端关会话」这条链路真的走通没有。
        // 前两条读状态就够，第三条要真等一次。

        if (!store.isOpen()) await store.open(password);

        const cfg = await settingsGet();
        const threshold = cfg.autoLockMinutes * 60;

        // 按当前配置重新 arm 一次再比。C1 盯的是「arm 把分钟数换算成了对等的秒数」，
        // 库开着时 arm 用的是什么值由 A/B 段的真实开关库路径覆盖 ——
        // 这里不重新 arm 的话，比的是若干步之前的一次快照。
        await lockArm(cfg.autoLockMinutes, cfg.lockOnSleep);
        const armed = await lockStatus();
        check(
            'C1',
            '解锁之后自动锁定开始计时，阈值取自当前配置',
            armed.armed && armed.idleSeconds === threshold,
            `armed=${armed.armed} · 阈值 ${armed.idleSeconds}s（配置 ${cfg.autoLockMinutes} 分钟）`
        );

        await mark('C2 改配置立刻生效');
        await lockConfigure(1, cfg.lockOnSleep);
        const narrowed = await lockStatus();
        await lockConfigure(cfg.autoLockMinutes, cfg.lockOnSleep);
        const restored = await lockStatus();
        check(
            'C2',
            '改「自动锁定」立刻作用到计时上，不必等下次解锁',
            narrowed.idleSeconds === 60 && restored.idleSeconds === threshold,
            `收紧到 ${narrowed.idleSeconds}s · 还原到 ${restored.idleSeconds}s`
        );

        await mark('C3 「从不」档位');
        await lockConfigure(0, cfg.lockOnSleep);
        const never = await lockStatus();
        await lockConfigure(cfg.autoLockMinutes, cfg.lockOnSleep);
        const backOn = await lockStatus();
        check(
            'C3',
            '「从不」档位下无操作不再触发锁定，改回来又能触发',
            never.idleSeconds === 0 && backOn.idleSeconds === threshold,
            `「从不」读作 ${never.idleSeconds}s · 改回来读作 ${backOn.idleSeconds}s`
        );

        // ---------------------------------------------------------------- 输入清零
        //
        // 先证明「界面上的输入真的会把计时清零」，再等真实的无操作锁定。
        // 顺序不能反：下面那条断言失败时要能分清「没人动过、链路断了」还是
        // 「有人动了鼠标」—— 判断依据正是这一条本身。
        //
        // 判据取两个读数：静置 3.5 秒之后计时确实涨上去了（说明这段时间没有
        // 别的输入在动它），连派 8 次事件之后它被打回来。只判「打回来」是不够的：
        // 若旁边正好有人在动鼠标，即使监听根本没接上，读数也会是小的 ——
        // 那会变成一条恒绿的断言。
        await mark('C4 界面输入会把无操作计时清零');
        await lockArm(cfg.autoLockMinutes, cfg.lockOnSleep);
        await sleep(3500);
        const beforeInput = await lockStatus();
        // 连派而不是单派：上报有 2 秒节流，单派一次可能正好落在窗口里被吞掉
        for (let i = 0; i < 8; i += 1) {
            document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
            await sleep(350);
        }
        const afterInput = await lockStatus();
        check(
            'C4',
            '界面上的输入事件会上报，无操作计时被打回起点',
            beforeInput.sinceActivityMs >= 2500 && afterInput.sinceActivityMs < 3000,
            `静置 3.5 秒后 ${beforeInput.sinceActivityMs} ms → 连派 8 次后 ${afterInput.sinceActivityMs} ms`
        );

        await mark('C5 等一次真实的无操作锁定（阈值 60 秒）');
        // 走真实路径，不把阈值改小 —— 1 分钟是设置里最小的一档，
        // 换算本身已经在 Rust 单测里覆盖过（`idle_limit`）。
        //
        // 这条断言会被**真实输入**打断：无操作计时认的是文档上的 pointermove /
        // keydown 一类事件，跑验收时鼠标从窗口上滑过一次，计时就从头开始。
        // 所以一边等一边读 `sinceActivityMs`，把两种情形分开：
        //
        //   - 它比上一次读数小 → 有人动了键鼠，计时被重置（锁定本来就该更晚）。
        //     这种情况的失败措辞是「被真实输入打断」，不是「功能坏了」。
        //   - 它一路涨过阈值却什么都没发生 → 那才是链路断了，直接提前收场，
        //     不必把预算耗光。
        //
        // 预算 150 秒：够「被打断之后重新攒够 60 秒」的第二次机会。
        const events: string[] = [];
        const unlisten = await listenLock((reason) => events.push(reason));

        await lockConfigure(1, cfg.lockOnSleep);
        const started = Date.now();
        const BUDGET = 150_000;
        let locked = false;
        let maxSince = 0;
        let resets = 0;
        let lastSince = -1;
        while (Date.now() - started < BUDGET) {
            await sleep(500);
            if (!store.isOpen()) {
                locked = true;
                break;
            }
            const st = await lockStatus();
            if (lastSince >= 0 && st.sinceActivityMs + 1000 < lastSince) resets += 1;
            lastSince = st.sinceActivityMs;
            maxSince = Math.max(maxSince, st.sinceActivityMs);
            // 计时已经越过阈值很多还没锁 —— 这不是被打断，是链路问题
            if (st.sinceActivityMs >= 70_000) break;
        }
        unlisten();
        const waited = Math.round((Date.now() - started) / 1000);
        // 失败时最要紧的是分清两种「计时照涨、事件全无」：
        // `armed=false` 说明 Rust 侧压根没在判定（`tick()` 第一句就 return 了），
        // 与「阈值没生效」或「事件没送到前端」是完全不同的两件事，而读数一模一样。
        // 这两个字段 `lockStatus()` 本来就返回，不打出来就只能靠读 Rust 源码去猜。
        const snap = await lockStatus();
        await mark(
            `C5 结束：locked=${locked} 事件=${events.join('/') || '无'} 计时最长=${maxSince}ms 重置=${resets} ` +
                `armed=${snap.armed} fired=${snap.fired ?? '无'} 阈值=${snap.idleSeconds}s`
        );

        // 「等过、被打断过」这句话只在失败时才需要，但它同时是这条断言
        // 唯一的判据来源，所以两种情形都在 detail 里说清楚。
        const touched = resets > 0 ? ` · 期间 ${resets} 次输入把计时清零` : '';
        check(
            'C5',
            '无操作到点之后锁定，界面回到解锁页',
            locked && events.includes('idle'),
            locked
                ? `等 ${waited} 秒 · 收到事件 ${events.join(' / ') || '（无）'}${touched}`
                : resets > 0
                  ? `${waited} 秒内被真实输入打断 ${resets} 次，计时最长只到 ${maxSince} ms。` +
                    '这条断言要求连续 60 秒不碰键鼠 —— 请重跑，跑的时候别把鼠标划过窗口'
                  : `${waited} 秒仍未锁定 · 计时已到 ${maxSince} ms 却没有事件` +
                    `（armed=${snap.armed} · fired=${snap.fired ?? '无'} · 阈值 ${snap.idleSeconds}s，不是输入打断）`
        );

        await mark('C6 锁定之后停表');
        const afterLock = await lockStatus();
        check(
            'C6',
            '锁定之后计时停表，不会反复触发',
            !afterLock.armed && afterLock.fired === null,
            locked
                ? `armed=${afterLock.armed} · fired=${afterLock.fired ?? 'null'}`
                : 'C5 没有锁上，停表无从判定'
        );

        // ---------------------------------------------------------------- D 剪贴板清除

        // D3 会**真的清掉运行验收这台机器当前的剪贴板** —— 那就是它的目的，
        // 跑之前心里有数就行。
        //
        // 最重要的一条判据（「剪贴板已被别的程序改写时不许清」）不在这里，在 Rust
        // 单测里：`clipboard::tests::a_replaced_clipboard_is_never_touched`。应用内改不了
        // 剪贴板的 changeCount，硬要在这里测就得让脚本与应用按秒对齐，那种断言本身
        // 会变成新的不稳定源。这一段测链路：档位读得到、计时起得来、到点真的清了。

        await mark('D1 复制之后按当前档位计时');
        await clipboardConfigure(15);
        const clipArmed = await clipboardArm();
        check(
            'D1',
            '复制之后按当前档位开始计时',
            clipArmed.armed && clipArmed.seconds === 15 && clipArmed.unchanged,
            `armed=${clipArmed.armed} · 档位=${clipArmed.seconds}s · unchanged=${clipArmed.unchanged} · ` +
                `基准 ${clipArmed.baseline} 当前 ${clipArmed.changeCount ?? 'null'}`
        );

        await mark('D2 「从不」档不计时清除');
        await clipboardConfigure(0);
        const clipNever = await clipboardArm();
        check(
            'D2',
            '「从不」档不再自动清除',
            clipNever.armed && clipNever.seconds === 0,
            `armed=${clipNever.armed} · 档位=${clipNever.seconds}s`
        );

        // D3 这一段有个机器环境依赖：应用只在剪贴板里**还是自己那一份**时才清
        // （`clipboard.rs` 的 `Superseded` 分支）。这台机器上确实有别的程序会写剪贴板 ——
        // 空载时实测 70 秒里自变过一次；跑验收时也撞到过一轮（计数 547 → 554）。
        // 撞上它，`armed` 被置假、`fired` 保持假，形态与「到点没清」一样，
        // 于是这条本该绿的断言变红，红的原因却与应用无关。
        //
        // 所以把两种失败分开：被改写（应用按设计停表走开）不算这条断言的失败，
        // 重新 arm 再来一轮；只有「仍在计时却到点没清」才判失败 —— 那才是它要咬的 bug。
        // 重试不会放过真 bug：代码真到点不清的话，三轮都停在 `armed=true`，照样红。
        await mark('D3 到点之后真的清掉（等 15 秒）');
        await clipboardConfigure(15);
        let clipBefore = await clipboardArm();
        let cleared = await clipboardStatus();
        let d3Waited = 0;
        let rounds = 0;
        let supersededRounds = 0;
        for (;;) {
            rounds += 1;
            const started = Date.now();
            while (Date.now() - started < 25_000) {
                await sleep(500);
                cleared = await clipboardStatus();
                // 清掉了：armed 落假、fired 置真。被改写了：armed 落假、fired 保持假。
                // 两种情况都不用再等，直接出来分流。
                if (cleared.fired || !cleared.armed) break;
            }
            d3Waited += Math.round((Date.now() - started) / 1000);
            if (cleared.fired || cleared.armed || rounds >= 3) break;
            supersededRounds += 1;
            clipBefore = await clipboardArm();
        }
        // 清除会调 `clearContents`，那本身也是一次写入 —— 所以计数必然往前走一格。
        // 拿它做附带判据：只看 `fired` 的话，「置了个标记但没真动剪贴板」也能通过。
        const counted = clipBefore.changeCount !== null && cleared.changeCount !== null
            ? cleared.changeCount > clipBefore.changeCount
            : null;
        const why = !clipBefore.armed
            ? '起表时读不到剪贴板计数，计时根本没起来'
            : cleared.armed
                ? '仍在计时（档位 15 秒）却到点没清 —— 这条是真失败'
                : '计时期间剪贴板被别的程序改写过，应用按设计停表走开';
        check(
            'D3',
            '到点之后剪贴板被清掉',
            cleared.fired && counted !== false,
            cleared.fired
                ? `等 ${d3Waited} 秒 · 计数 ${clipBefore.changeCount ?? '?'} → ${cleared.changeCount ?? '?'}` +
                  (counted === null ? '（计数读不到，只看标记）' : '') +
                  (supersededRounds > 0 ? ` · 被改写 ${supersededRounds} 轮后重试成功` : '')
                : `等 ${d3Waited} 秒仍未清除 · 计数 ${clipBefore.changeCount ?? '?'} → ${cleared.changeCount ?? '?'}` +
                  (rounds > 1 ? ` · 已试 ${rounds} 轮` : '') +
                  ` · ${why}`
        );

        await mark('D4 清完之后停表');
        const settled = await clipboardStatus();
        check(
            'D4',
            '清完之后停表，不会反复清',
            !settled.armed && settled.fired,
            `armed=${settled.armed} · fired=${settled.fired}` +
                (settled.fired ? '' : '（D3 没跑完一次清除，这条无从判定）')
        );

        // 还原成默认档，别把验收用的 15 秒留给后面的段
        await clipboardConfigure(30);

        // ------------------------------------------------------------ E 剪贴板与 ⌘C
        //
        // E 段验的是「⌘C 复制当前字段」挑值的逻辑。**没有验完**：网页侧的接线
        // 可以自动化，但「macOS 会不会把 ⌘C 先交给『编辑』菜单、网页根本收不到」
        // 这件事，在自动化里验不了（发合成按键要辅助功能权限，这台机器没开）。
        // 所以 E3 的措辞只说「网页侧接线」，实际按键要用手按一次确认，见 PRD 附录 N。
        {
            // 这一段开始前要补两件事，缺一件下面全是红的：
            //
            //   ① C5 真的等了一次无操作锁定，会话是关着的 —— 没有会话就没有详情栏。
            //   ② accept 模式从头到尾**不起主视图**（全程直接在 store 上跑），界面还停在
            //      解锁页。而 `display: none` 里的元素**没法获得焦点**，这一段验的却正是
            //      「焦点落在哪一行」，所以光把 DOM 渲染出来不够，得让视图真的可见。
            await mark('E 段开始：重新解锁并把主视图显出来');
            if (!store.isOpen()) await store.open(password);
            showVault();
            await sleep(250);

            const rowValue = (field: string): string | null =>
                document.querySelector<HTMLElement>(
                    `#detail .row[data-field="${field}"] [data-copy]`
                )?.dataset.copy ?? null;

            const account = rowValue(FIELD_USER);
            const secret = rowValue(FIELD_PASSWORD);
            const site = rowValue(FIELD_URL);

            // 没有这三条，「挑对了字段」这个断言就没有判别力：
            // 三个值要是碰巧相同，复制错哪一项都能看着是绿的。
            const distinct =
                account !== null &&
                secret !== null &&
                site !== null &&
                new Set([account, secret, site]).size === 3;
            await mark(`E1 三个字段值互不相同：${distinct}`);
            check(
                'E1',
                '详情栏三个可复制字段的值互不相同（否则下面几条没有判别力）',
                distinct,
                `账号=${account === null ? '缺' : `${account.length} 字符`} · ` +
                    `密码=${secret === null ? '缺' : `${secret.length} 字符`} · ` +
                    `网址=${site === null ? '缺' : `${site.length} 字符`}`
            );

            // 焦点不在任何一行上 → 退到密码。这条要在碰任何行之前跑：
            // 「当前字段」是焦点状态，一旦聚焦过某一行就再也回不到「都没有」。
            const blurred = await (async () => {
                if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
                return vault.copyCurrentField();
            })();
            await sleep(120);
            check(
                'E2',
                '焦点不在字段行上时，⌘C 退到密码',
                distinct && blurred === secret,
                blurred === null ? '没有接管这次按键' : `复制的是 ${blurred === secret ? FIELD_PASSWORD : blurred === account ? FIELD_USER : blurred === site ? FIELD_URL : '别的值'}`
            );

            // 焦点落在哪一行就复制哪一行
            const picks: string[] = [];
            let ok = distinct;
            for (const field of [FIELD_USER, FIELD_URL]) {
                const el = document.querySelector<HTMLElement>(`#detail .row[data-field="${field}"]`);
                if (!el) {
                    ok = false;
                    picks.push(`${field}=行不在`);
                    continue;
                }
                el.focus();
                await sleep(120);
                const got = vault.copyCurrentField();
                const want = rowValue(field);
                picks.push(`${field}→${got === want ? '对' : '错'}`);
                if (got !== want) ok = false;
            }
            await sleep(120);
            check('E3', '⌘C 复制焦点所在的那一行', ok, picks.join(' · '));
            await clipboardConfigure(30);

            // 合成按键，验 main.ts 那条 keydown 接线。
            //
            // 判据取「这次按键有没有被接管」（`defaultPrevented`），**不取剪贴板计数前进**：
            // 计数前进与否取决于这个 webview 当下能不能写剪贴板（异步剪贴板 API 要文档
            // 有焦点），而验收跑在无人操作的窗口上，那件事本身就不稳定。拿它当判据，
            // 绿的红的都要看运气；而「接管没接管」是确定性的，且正是 main.ts 那段代码
            // 真正决定的事。写入那一段由 `copy()` 自己保证 —— 它失败时会弹「复制失败」。
            const clipBefore = await clipboardStatus();
            const ev = new KeyboardEvent('keydown', {
                key: 'c',
                metaKey: true,
                bubbles: true,
                cancelable: true
            });
            document.dispatchEvent(ev);

            // 顺手把计数读出来放进明细：它不动不能说明接线坏了，
            // 但看一眼就知道这个环境写没写进去。
            await sleep(400);
            const clipAfter = await clipboardStatus();
            await mark(`E4 合成 ⌘C：接管=${ev.defaultPrevented} 计数 ${clipBefore.changeCount} → ${clipAfter.changeCount}`);
            check(
                'E4',
                '合成的 ⌘C 被接管（只验网页侧接线；真有按键时 macOS 会不会先交给「编辑」菜单见附录 N）',
                ev.defaultPrevented,
                `接管=${ev.defaultPrevented} · 剪贴板计数 ${clipBefore.changeCount} → ${clipAfter.changeCount}` +
                    '（计数是旁证，不作判据 —— 无人操作的窗口里网页写剪贴板本来就不稳）'
            );

            // 对照：用户自己选了文字时**不许**接管，否则正常的文本复制会坏掉。
            // 没有这一条的话，上面那条在一个「无条件 preventDefault」的实现上也是绿的。
            const notesBlock = document.querySelector<HTMLElement>('#detail .block-v');
            const sel = window.getSelection();
            let guarding = false;
            if (notesBlock && sel) {
                const range = document.createRange();
                range.selectNodeContents(notesBlock);
                sel.removeAllRanges();
                sel.addRange(range);
                guarding = !sel.isCollapsed && String(sel).trim().length > 0;
            }
            const ev2 = new KeyboardEvent('keydown', {
                key: 'c',
                metaKey: true,
                bubbles: true,
                cancelable: true
            });
            document.dispatchEvent(ev2);
            window.getSelection()?.removeAllRanges();
            await mark(`E5 有选区：造出选区=${guarding} 接管=${ev2.defaultPrevented}`);
            check(
                'E5',
                '有文字被选中时 ⌘C 让系统去复制，不截胡',
                guarding && !ev2.defaultPrevented,
                guarding
                    ? `接管=${ev2.defaultPrevented}（应为 false）`
                    : '造不出选区，这条没有判别力'
            );

            // -------------------------------------------------------- F 掩码切换动效（F4.2）
            //
            // 动效本身没法验，能验的是它的**接线**，且必须成对验：
            //   F1 点了眼睛 → 新节点带 `.is-swap` 且该类的 `animation-name` 真的解析到 `pw-swap`
            //   F2 对照：**没点**眼睛（搜索重绘）→ 不带类
            // 两条缺一不可。只留 F1 的话，一个「每次重绘都带类」的实现也是绿的，
            // 那意味着搜索每敲一个字密码行闪一下；只留 F2 则什么都证明不了。
            //
            // F1 里「类存在」与「animation-name 解析得到」也是两条：只断言类名，
            // 规则被改名或挂错选择器时照样绿（`.is-swap` 挂在 `.row-v` 上，
            // 而关键帧定义在 base.css —— 两处都在，动画才有）。
            await mark('F 段开始：掩码切换动效');
            {
                /**
                 * 关键帧是不是真的定义在样式表里。
                 *
                 * `getComputedStyle(el).animationName` 报的是**声明**的名字 —— 关键帧被
                 * 删掉或改名的（比如改了 base.css 里的 `@keyframes` 名、忘了改引用），
                 * 它照样返回 `pw-swap`。界面上什么都不缺，只是不动。所以另起一条去
                 * CSSOM 里按名字找 `CSSKeyframesRule`。
                 *
                 * 不用「读两次 opacity 看有没有在动」那种时序判据：它要挑在动画播到一半
                 * 的窗口里读，机器一忙就假红。CSSOM 这条是确定的。
                 */
                const hasKeyframes = (name: string): boolean => {
                    for (const sheet of Array.from(document.styleSheets)) {
                        let rules: CSSRuleList | null = null;
                        try {
                            rules = sheet.cssRules;
                        } catch {
                            continue; // 跨源表读不到，跳过
                        }
                        for (const rule of Array.from(rules ?? [])) {
                            if (rule instanceof CSSKeyframesRule && rule.name === name) return true;
                        }
                    }
                    return false;
                };
                // 对照：拿一个不存在的名字试一次。没有这一条，一个恒返回 true 的桩
                // 也能让 F1 / F3 全绿。
                const kfWorks = hasKeyframes('pw-swap') && !hasKeyframes('pw-swap-并不存在');
                await mark(`F 关键帧探针可用=${kfWorks}`);

                // 选中项先固定下来。上面的 A 段可能改了库内容，直接读 `#detail` 不稳。
                document.querySelector<HTMLElement>('#list .item')?.click();
                await sleep(150);

                const row = document.querySelector<HTMLElement>(
                    `#detail .row[data-field="${FIELD_PASSWORD}"]`
                );
                const rowV = row?.querySelector<HTMLElement>('.row-v') ?? null;
                const eyeBtn = row?.querySelector<HTMLElement>('[data-act="reveal"]') ?? null;
                const want =
                    row?.querySelector<HTMLElement>('[data-copy]')?.dataset.copy ?? null;

                if (!rowV || !eyeBtn || !want) {
                    check('F1', '详情栏密码行接上掩码切换动效', false, '密码行 / 眼睛按钮 / 期望值 缺一');
                    check('F2', '非切换引起的重绘不带动效类', false, '同上');
                } else {
                    const before = rowV.textContent ?? '';
                    // 用 `.click()` 而不是模拟指针：这里验的是委托监听有没有接上，
                    // 不是命中测试（那一档在「② 外壳几何」里另验）。
                    eyeBtn.click();
                    await sleep(60);

                    const after = document.querySelector<HTMLElement>(
                        `#detail .row[data-field="${FIELD_PASSWORD}"] .row-v`
                    );
                    const cls = after?.classList.contains('is-swap') ?? false;
                    const anim = after ? getComputedStyle(after).animationName : '(无节点)';
                    const unmasked = after?.textContent === want;
                    check(
                        'F1',
                        '点眼睛后新节点带 .is-swap，关键帧也在样式表里',
                        cls && anim === 'pw-swap' && kfWorks && unmasked,
                        `类=${cls} · animation-name=${anim} · 关键帧探针=${kfWorks} · ` +
                            `${before.slice(0, 3)}…→${unmasked ? '明文' : '未换'}`
                    );

                    // 搜索重绘：换一个字再换回来，走的是同一段 renderDetail()。
                    const search = document.querySelector<HTMLInputElement>('#search');
                    if (!search) {
                        check('F2', '非切换引起的重绘不带动效类', false, '找不到搜索框');
                    } else {
                        search.value = '堡垒';
                        search.dispatchEvent(new Event('input', { bubbles: true }));
                        await sleep(80);
                        search.value = '';
                        search.dispatchEvent(new Event('input', { bubbles: true }));
                        await sleep(80);
                        const again = document.querySelector<HTMLElement>(
                            `#detail .row[data-field="${FIELD_PASSWORD}"] .row-v`
                        );
                        const stray = again?.classList.contains('is-swap') ?? true;
                        check(
                            'F2',
                            '对照：搜索重绘后不带动效类（否则每敲一个字都会闪）',
                            !stray,
                            stray ? '重绘后仍带 is-swap' : '重绘后干净'
                        );
                    }
                }

                // 编辑弹窗那一处。入口走详情栏的编辑按钮，与用户点的是同一条路径。
                const editBtn = document.querySelector<HTMLElement>('#detail [data-act="edit"]');
                const openEditor = async (): Promise<void> => {
                    editBtn?.click();
                    await sleep(150);
                };
                // 图标现在只以 symbol 引用出现（路径数据在 index.html 的 <defs> 里，
                // 由 spike/icons.mjs 逐字守着），所以分辨「睁眼 / 闭眼」要看 use 指向谁。
                //
                // 原先这里比的是 eyeOff 独有的路径串 `m2 2 20 20` —— 换成 symbol 引用后
                // 那个串根本不在按钮的 innerHTML 里，判据会恒为 false：F3 直接红，
                // 而 F4 那条「不是闭眼」反而白绿。改图标集时要连这类「靠路径串认图标」
                // 的判据一起找出来 —— grep 路径片段（`m2 2 20 20`、`d="M`），别 grep `svg`，
                // 那样一个都扫不到。
                const EYE_OPEN = '#ic-eye';
                const EYE_CLOSED = '#ic-eye-off';
                const refOf = (host: Element | null | undefined): string =>
                    host?.querySelector('use')?.getAttribute('href') ?? '';
                const pwIn = (): HTMLInputElement | null =>
                    document.querySelector<HTMLInputElement>('#f-pw');
                const eyeEl = (): HTMLElement | null =>
                    document.querySelector<HTMLElement>('#f-pw-reveal');

                await openEditor();
                const pw0 = pwIn();
                const eye0 = eyeEl();
                if (!pw0 || !eye0) {
                    check('F3', '编辑弹窗的眼睛切换到明文', false, '弹窗没开或找不到输入框');
                    check('F4', '重开弹窗时掩码状态与图标一起复位', false, '同上');
                } else {
                    // 对照：刚打开时必须是掩码、图标是「睁眼」。没有这一条，
                    // F3 在一个「打开就已经是明文」的实现上也会绿。
                    const idle = pw0.type === 'password' && refOf(eye0) === EYE_OPEN;

                    eyeEl()?.click();
                    await sleep(60);
                    const pw1 = pwIn();
                    const eye1 = eyeEl();
                    const svg = eye1?.querySelector('svg');
                    const inputAnim = pw1 ? getComputedStyle(pw1).animationName : '(无)';
                    const eyeAnim = svg ? getComputedStyle(svg).animationName : '(无)';
                    check(
                        'F3',
                        '编辑弹窗的眼睛切换到明文，图标换掉并带 .is-swap / .is-pop',
                        idle &&
                            pw1?.type === 'text' &&
                            refOf(eye1) === EYE_CLOSED &&
                            inputAnim === 'pw-swap' &&
                            eyeAnim === 'eye-pop' &&
                            kfWorks,
                        `开弹窗时是掩码=${idle} · type=${pw1?.type} · ` +
                            `图标=${refOf(eye1) === EYE_CLOSED ? '闭眼' : '睁眼'} · ` +
                            `输入框动画=${inputAnim} · 图标动画=${eyeAnim} · 关键帧探针=${kfWorks}`
                    );

                    eyeEl()?.click(); // 切回掩码，F4 要验的是「重开」，先留个非初始态
                    await sleep(60);
                    document.querySelector<HTMLElement>('#editor-close')?.click();
                    await sleep(80);
                    await openEditor();

                    const pw2 = pwIn();
                    const eye2 = eyeEl();
                    check(
                        'F4',
                        '重开弹窗时掩码状态与图标一起复位，且不补播动画',
                        pw2?.type === 'password' &&
                            refOf(eye2) === EYE_OPEN &&
                            !(eye2?.classList.contains('is-pop') ?? true),
                        `type=${pw2?.type} · 图标=${refOf(eye2) === EYE_CLOSED ? '闭眼' : '睁眼'} · ` +
                            `带 is-pop=${eye2?.classList.contains('is-pop')}`
                    );

                    document.querySelector<HTMLElement>('#editor-close')?.click();
                    await sleep(80);
                }
            }
        }

        // ------------------------------------------------------------ H 输入法组合态
        //
        // 中文输入法打字时，回车是「确认候选词」、Esc 是「取消候选词」—— 两个键都属于
        // 打字过程，跟「提交」「关窗」没有关系。浏览器却照样派发 `key === 'Enter'` /
        // `key === 'Escape'` 的 keydown，只判 `ev.key` 的处理器会当成用户按了功能键。
        // 修之前的三处后果：
        //   · 编辑弹窗标题框里选个词 → 弹窗当场保存关掉
        //   · 编辑弹窗里 Esc 取消候选词 → 弹窗关掉，未保存的改动一起没
        //   · 建库卡库名里选个词 → 当场把保险箱建出来
        //
        // 守卫是 `isComposing(ev)`，加在**每个** keydown 处理器的首句。这里验它有没有
        // 接上、以及有没有接过头 —— 所以每条效果断言都成对：
        //     组合态的按键不生效  ×  非组合态的同类按键照常生效
        // 只留前一半的话，一个「把 keydown 监听整个摘掉」的实现同样全绿。
        //
        // 三类按键都要覆盖：标题框的 Enter（提交）、任意字段的 Esc（关窗）、
        // 解锁卡与建库卡上的 Enter（解锁 / 建库）。它们分别接在元素监听、document
        // 监听、和另外两条视图链路上，抽样一条证明不了另外两条。
        await mark('H 段开始：输入法组合态');
        {
            const maskEl = (): HTMLElement | null =>
                document.querySelector<HTMLElement>('#editor-mask');
            const titleIn = (): HTMLInputElement | null =>
                document.querySelector<HTMLInputElement>('#f-title');
            const editorOpen = (): boolean => !(maskEl()?.classList.contains('hidden') ?? true);
            const openEditor = async (): Promise<void> => {
                document.querySelector<HTMLElement>('#detail [data-act="edit"]')?.click();
                await sleep(150);
            };
            /** 打开着就用，没开先开一次。目的是让每条的判据只反映自己那一次派发 ——
             *  实现坏掉时前一条红不该把后面几条一起染红，那种连锁红分不清坏了几处。 */
            const needEditor = async (): Promise<boolean> => {
                if (!editorOpen()) await openEditor();
                return editorOpen();
            };

            /**
             * 往元素上派发一次按键。三种形态：普通、两种「输入法组合态」的表征。
             *
             * 组合态靠 `defineProperty` 打在**实例**上遮蔽原型的 getter，不走
             * `new KeyboardEvent(..., { isComposing: true })` 那一路 —— `KeyboardEventInit`
             * 压根不收 `keyCode`，而 `isComposing` 收不收由 webview 决定：设不上就静默
             * 退化成普通按键，断言跟着假绿。实例属性是确定的，处理器读到的就是 true。
             */
            const pressKey = (el: HTMLElement | null, key: string, how: 'plain' | 'ime' | 'kc229'): void => {
                const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
                if (how === 'ime') {
                    Object.defineProperty(ev, 'isComposing', { value: true, configurable: true });
                }
                if (how === 'kc229') {
                    // 旧接口。部分输入法在组合态只报这个，不报 isComposing ——
                    // 守卫里少判一个条件就会漏掉那批输入法。
                    Object.defineProperty(ev, 'keyCode', { value: 229, configurable: true });
                }
                el?.dispatchEvent(ev);
            };

            // ---- 标题框上的回车（原来绑着「提交」的那一处）

            await needEditor();
            const e0 = editorOpen();
            pressKey(titleIn(), 'Enter', 'ime');
            pressKey(titleIn(), 'Enter', 'kc229');
            await sleep(80);
            const afterImeEnter = editorOpen();
            check(
                'A27',
                '标题框里的回车不提交：输入法选词那一下（isComposing / keyCode 229 两种表征）',
                e0 && afterImeEnter,
                !e0 ? '编辑弹窗没打开' : `两种组合态表征各派发一次 → 仍开着=${afterImeEnter}`
            );

            await needEditor();
            const e1 = editorOpen();
            pressKey(titleIn(), 'Enter', 'plain');
            await sleep(150);
            const afterPlainEnter = editorOpen();
            check(
                'A28',
                '回车提交这个行为本身已撤掉：非组合态的回车同样不提交',
                e1 && afterPlainEnter,
                !e1 ? '编辑弹窗没打开' : `非组合态回车 → 仍开着=${afterPlainEnter}`
            );

            // ---- 弹窗里的 Esc（原来会直接关窗、丢掉未保存内容的那一处）

            await needEditor();
            const e2 = editorOpen();
            pressKey(titleIn(), 'Escape', 'ime');
            await sleep(80);
            const afterImeEsc = editorOpen();
            check(
                'A29',
                '输入法里按 Esc 是在取消候选词，不会把编辑弹窗关掉',
                e2 && afterImeEsc,
                !e2 ? '编辑弹窗没打开' : `组合态 Esc → 仍开着=${afterImeEsc}`
            );

            await needEditor();
            const e3 = editorOpen();
            pressKey(titleIn(), 'Escape', 'plain');
            await sleep(150);
            const afterPlainEsc = editorOpen();
            check(
                'A30',
                '对照：非组合态的 Esc 照常关窗（守卫没有把按键整个拦下）',
                e3 && !afterPlainEsc,
                !e3 ? '编辑弹窗没打开' : `非组合态 Esc → 仍开着=${afterPlainEsc}（应为 false）`
            );

            // ---- 撤掉回车之后的保存路径
            //
            // 没有这一条，A27 / A28 在一个「保存功能整个坏掉」的实现上也是绿的 ——
            // 它们只要求「弹窗还开着」，而弹窗永远关不掉同样满足。
            // 打开的是已有条目、标题保持原样，点一下不改任何字段。
            await needEditor();
            const e4 = editorOpen();
            document.querySelector<HTMLButtonElement>('#editor-save')?.click();
            await sleep(220);
            const closedBySave = !editorOpen();
            check(
                'A31',
                '对照：撤掉回车之后，「保存」按钮照常关窗（保存路径没被一起删掉）',
                e4 && closedBySave,
                !e4 ? '编辑弹窗没打开' : `点保存 → 关掉=${closedBySave}`
            );

            // ---- 解锁 / 建库那条链路上的回车
            //
            // 库名几乎一定是中文，用输入法打完按回车选词会当场把保险箱建出来 ——
            // 这条链路的代价最大。而且解锁框与建库卡是**两个独立的监听**（一个挂在
            // `#lock-pw` 上，一个挂在建库卡那三个字段上），只派发一个证明不了另一个。
            //
            // 判据取提示行的去向：对应的输入为空时 `submitOpen()` / `submitCreate()`
            // 都只写一句提示就返回（那两个分支里没有 await），不碰会话、不跑 Argon2，
            // 是这两条链路上副作用最小的可观测点。
            const lockPw = document.querySelector<HTMLInputElement>('#lock-pw');
            const lockMsg = document.querySelector<HTMLElement>('#lock-msg');
            const newName = document.querySelector<HTMLInputElement>('#new-name');
            const newMsg = document.querySelector<HTMLElement>('#new-msg');
            const textOf = (el: HTMLElement | null): string => el?.textContent?.trim() ?? '';
            const resetCards = (): void => {
                if (lockPw) lockPw.value = '';
                if (newName) newName.value = '';
                if (lockMsg) lockMsg.textContent = '';
                if (newMsg) newMsg.textContent = '';
            };

            resetCards();
            pressKey(lockPw, 'Enter', 'ime');
            pressKey(lockPw, 'Enter', 'kc229');
            pressKey(newName, 'Enter', 'ime');
            pressKey(newName, 'Enter', 'kc229');
            await sleep(150);
            const imeLock = textOf(lockMsg);
            const imeNew = textOf(newMsg);
            check(
                'A32',
                '解锁卡与建库卡的回车都不触发：输入法选词那一下（两种表征各派发一次）',
                Boolean(lockPw) && Boolean(newName) && imeLock === '' && imeNew === '',
                !lockPw || !newName
                    ? '找不到 #lock-pw 或 #new-name'
                    : `解锁提示「${imeLock || '(空)'}」 · 建库提示「${imeNew || '(空)'}」（都应为空）`
            );

            resetCards();
            pressKey(lockPw, 'Enter', 'plain');
            await sleep(180);
            const plainLock = textOf(lockMsg);
            pressKey(newName, 'Enter', 'plain');
            await sleep(180);
            const plainNew = textOf(newMsg);
            check(
                'A33',
                '对照：非组合态的回车照常触发（解锁提示「请输入主密码」、建库提示「库名不能为空」）',
                plainLock.includes('请输入主密码') && plainNew.includes('库名不能为空'),
                `解锁提示「${plainLock || '(空)'}」 · 建库提示「${plainNew || '(空)'}」`
            );
            resetCards();
        }

        // ------------------------------------------------------------ I 关于与更新检查
        //
        // 这一段钉三件事：页面上显示的版本号只有宿主一个来源、版本比较这个纯函数
        // 在两个方向上都判得对、以及按钮按下去**真的发起了请求**。
        //
        // 网络那一条刻意写成弱断言（终态只要不是「检查中…」就算过）—— 验收不该
        // 因为官网临时不可达而变红。它的实际读数会打出来；「线上确实读得到版本文件」
        // 由发布之后的那次读数证明，不混进这里当门禁。
        {
            await mark('I 段开始：关于与更新检查');

            // ---- 版本号只有一个来源
            //
            // 判据是「界面显示的」与「宿主返回的」逐字相等，而不是「长得像个版本号」。
            // 一条 `/^v\d+\.\d+\.\d+/` 的格式断言放得下一个前端自己写死 `1.0.0` 的实现 ——
            // 而那正是要防的：发版时漏改前端那一份，界面说着旧版本、更新检查却拿它去比对，
            // 于是永远提示有新版本。
            const versionEl = document.querySelector<HTMLElement>('#set-version');
            const shownVersion = versionEl?.textContent?.trim() ?? '';
            let hostVersion = '';
            try {
                hostVersion = await appVersion();
            } catch {
                /* 非应用环境下读不到，下面的判据会红并说明原因 */
            }
            check(
                'A34',
                '设置页「关于」组显示的版本与宿主一致（界面上没有第二处写版本号）',
                Boolean(versionEl) &&
                    hostVersion !== '' &&
                    shownVersion === `v${hostVersion}`,
                !versionEl
                    ? '找不到 #set-version'
                    : `界面「${shownVersion || '(空)'}」· 宿主「${hostVersion || '(读不到)'}」`
            );

            // ---- 版本比较
            //
            // 三组输入里两组的期望是 false —— 一个恒真的实现过不了。
            // 只测「更高的版本判为更新」是不够的：`() => true` 也满足那一条。
            const cases: Array<[string, string, boolean]> = [
                ['1.0.1', '1.0.0', true],
                ['1.0.0', '1.0.0', false],
                ['0.9.9', '1.0.0', false],
                ['1.0', '1.0.0', false] // 缺位按 0 算：同版不提示
            ];
            const wrong = cases.filter(([a, b, want]) => isNewer(a, b) !== want);
            check(
                'A35',
                '版本比较：更高为真，同版与更低为假（含缺位 `1.0` vs `1.0.0`）',
                wrong.length === 0,
                wrong.length === 0
                    ? cases.map(([a, b, w]) => `${a}>${b}=${w}`).join(' · ')
                    : `判错 ${wrong.length} 组：${wrong.map(([a, b]) => `${a} vs ${b}`).join(' · ')}`
            );

            // ---- 按下去真的发起了请求
            //
            // 判据取「点击后同一帧内」的状态：`checkForUpdate()` 在 await 之前就写了
            // 「检查中…」并禁用按钮。这里点完立刻读、**不 sleep** —— 网络快的时候
            // 请求几十毫秒就回来了，读晚一步会被终态覆盖，那这条就白写了。
            const checkBtn = document.querySelector<HTMLButtonElement>('#set-check-update');
            const stateEl = document.querySelector<HTMLElement>('#set-update-state');
            const btnText = (): string => checkBtn?.textContent?.trim() ?? '';
            const stateText = (): string => stateEl?.textContent?.trim() ?? '';

            const beforeClick = btnText();
            checkBtn?.click();
            const duringClick = btnText();
            const disabledDuring = checkBtn?.disabled === true;
            check(
                'A36',
                '点「立即检查」立刻进入检查中（禁用按钮，文案变「检查中…」）',
                Boolean(checkBtn) &&
                    beforeClick.includes('立即检查') &&
                    duringClick.includes('检查中') &&
                    disabledDuring,
                !checkBtn
                    ? '找不到 #set-check-update'
                    : `点击前「${beforeClick}」· 点击后「${duringClick}」· disabled=${disabledDuring}`
            );

            // ---- 与上一条成对：状态机要收敛
            //
            // 只有 A36 的话，一个「点了就永远转圈」的实现也是绿的。4 秒是
            // `checkUpdate()` 自己的超时，轮询上限放到 6 秒留余量。
            for (let i = 0; i < 40 && btnText().includes('检查中'); i += 1) {
                await sleep(150);
            }
            const finalBtn = btnText();
            const finalState = stateText();
            check(
                'A37',
                '检查会收敛到终态：不卡在「检查中…」，按钮恢复可点',
                Boolean(checkBtn) &&
                    !finalBtn.includes('检查中') &&
                    checkBtn?.disabled === false,
                !checkBtn
                    ? '找不到 #set-check-update'
                    : `按钮「${finalBtn}」· 状态「${finalState || '(空)'}」· disabled=${checkBtn.disabled}`
            );
        }

        // ------------------------------------------------------------ G 重建库
        //
        // F7.5 改主密码与 F7.6 换 KDF 档位。这一段动的是**加密层的写入口**，
        // 所以判据一律取自磁盘上那份字节 —— 拿内存里的会话去验，验的是它自己，
        // 换档写错了照样报新值。
        //
        // 两个改动各做一遍再改回来，库在段末回到原样。不还原的话，后面 ③④⑤ 段
        // 与 keepassxc-cli 那些检查会拿原主密码去开一个换过密码的库，整片红且指向别处。
        {
            await mark('G 段开始：KDF 换档与改主密码');

            /** 拿这个密码去开**磁盘上那份**。当前会话不动，所以可以连着试好几个密码。 */
            const probe = async (
                pw: string
            ): Promise<{
                ok: boolean;
                preset: PresetName | null;
                memoryMiB: number;
                entries: number;
                why: string;
            }> => {
                try {
                    const s = await VaultSession.open(await vaultRead(), pw);
                    const h = s.header();
                    return {
                        ok: true,
                        preset: h.preset,
                        memoryMiB: h.memoryMiB,
                        entries: s.entries().length,
                        why: ''
                    };
                } catch (err) {
                    return { ok: false, preset: null, memoryMiB: -1, entries: -1, why: message(err) };
                }
            };

            /** 磁盘上那份的指纹。用 FNV-1a 而不是 `crypto.subtle` —— subtle 只在
             *  安全上下文里存在，而 webview 的协议算不算安全上下文取决于 Tauri 的
             *  实现细节。这条断言不该由那件事决定成败。 */
            const digest = async (path?: string): Promise<string> => {
                const bytes = new Uint8Array(await vaultRead(path));
                let h = 0x811c9dc5;
                for (let i = 0; i < bytes.length; i += 1) {
                    h ^= bytes[i]!;
                    h = Math.imul(h, 0x01000193) >>> 0;
                }
                return `${bytes.length}:${h.toString(16)}`;
            };

            const NEW_PW = `${password}-改过`;
            const start = await probe(password);
            const entriesBefore = start.entries;
            const memoryBefore = start.memoryMiB;
            await mark(
                `G 起点：档位=${start.preset ?? '落在三档之外'}（${memoryBefore} MiB）· ${entriesBefore} 条`
            );


            /** 把这一段动过的东西还原回去：主密码与 KDF 档位。
             *
             *  放在 `finally` 里，而不是留在成功路径的 G8 / G9 上。这一段改的是
             *  **加密层的写入口**，中途一旦中断（跑动中撞上一次自动锁定就会），
             *  库会停在临时主密码上 —— 后面每一段都会拿原主密码去开它，
             *  红成一片而且指向别处，外面的人工核查也打不开那份库。
             *
             *  先看磁盘上那份是哪个密码能开，再决定要不要改：这条判据让还原本身
             *  是幂等的，不会因为「其实没改过」而白改一次。会话被关掉时自己重新
             *  解锁一次 —— 还原的动作要求库是开着的。 */
            const restoreAfterRebuild = async (): Promise<void> => {
                try {
                    if ((await probe(NEW_PW)).ok) {
                        if (!store.isOpen()) await store.open(NEW_PW);
                        await store.changeMasterPassword(NEW_PW, password);
                    }

                    const back = await probe(password);
                    if (back.ok && start.preset && back.memoryMiB !== memoryBefore) {
                        if (!store.isOpen()) await store.open(password);
                        await store.changePreset(password, start.preset);
                    }

                    const done = await probe(password);
                    await mark(
                        `G 段还原：原主密码${done.ok ? '能开' : '开不了'} · ` +
                            (done.ok ? `${done.memoryMiB} MiB` : done.why)
                    );
                } catch (err) {
                    // 还原失败要留痕。静默把库丢在临时主密码上，外面只会看到
                    // 一片指向别处的红，看不出是这一步没做。
                    await mark(`G 段还原失败：${message(err)}`);
                }
            };

            try {
                // ---- G1 换档：磁盘上那份的文件头真的换了参数
                await store.changePreset(password, '流畅');
                const low = await probe(password);
                check(
                    'G1',
                    '换档到「流畅」后，磁盘上那份的文件头报 128 MiB',
                    low.ok && low.memoryMiB === KDF_PRESETS['流畅'].memoryMiB,
                    low.ok
                        ? `内存 ${memoryBefore} → ${low.memoryMiB} MiB · 档位=${low.preset ?? '落在三档之外'}`
                        : `换档后开不了：${low.why}`
                );

                // ---- G2 换档是整库重写：内容一条不少，主密码没跟着变
                check(
                    'G2',
                    '换档重写了整个库，条目一条不少、原主密码照旧能开',
                    low.ok && low.entries === entriesBefore,
                    `条目 ${entriesBefore} → ${low.ok ? low.entries : '开不了'}`
                );

                // ---- G3 改动前那一份被完整留在了本地历史版本里
                //
                // 这是整条链的安全网：写坏了、或者改完后悔了，靠的就是它。
                // 放在这里而不是段末，因为此刻最新那份历史版本正好是**起点状态**
                // （段末就不是了 —— 后面每改一次都会再轮转一份）。
                const versions = await vaultVersions();
                let keptInfo = '没有历史版本';
                let keptOk = false;
                if (versions.length) {
                    const v = versions[0]!;
                    try {
                        const s = await VaultSession.open(await vaultRead(v.path), password);
                        keptOk =
                            s.entries().length === entriesBefore &&
                            s.header().memoryMiB === memoryBefore;
                        keptInfo = `${v.name} → ${s.entries().length} 条 / ${s.header().memoryMiB} MiB`;
                    } catch (err) {
                        keptInfo = `${v.name} 打不开：${message(err)}`;
                    }
                }
                check(
                    'G3',
                    '换档前那一份被完整留在本地历史版本里（起点档位与条目数都在）',
                    keptOk,
                    `${versions.length} 份 · ${keptInfo}`
                );

                // ---- G4 把这一档导出一份，交给脚本用 KeePassXC 复核参数
                //
                // 「应用自己解得开」只证明了一半。换的是 KDF 参数，得换个实现来解才算数。
                // 段末库会换回原档位，所以这份导出件是脚本唯一能拿到的 128 MiB 样本。
                const exportPath = `${(store.status().path ?? '').replace(/[^/]+$/, '')}kdf-check.kdbx`;
                let exported = 0;
                try {
                    exported = await store.exportTo(exportPath);
                } catch {
                    /* 下面那条断言会如实报出来 */
                }
                check(
                    'G4',
                    '换档后那一份能独立导出（脚本侧再用 KeePassXC 核一遍参数）',
                    exported > 0,
                    `${exported} 字节`
                );

                // ---- G5 改主密码：新密码能开、旧密码开不了
                //
                // 「旧密码开不了」是这条的要害。只断言「新密码能开」的话，一个什么都
                // 没改的实现也能过 —— 库本来就用旧密码能开。
                await store.changeMasterPassword(password, NEW_PW);
                const byNew = await probe(NEW_PW);
                const byOld = await probe(password);
                check(
                    'G5',
                    '改主密码后：新密码能开，旧密码开不了',
                    byNew.ok && !byOld.ok,
                    `新密码=${byNew.ok ? '能开' : `开不了（${byNew.why}）`} · ` +
                        `旧密码=${byOld.ok ? '居然还能开' : '开不了'}`
                );

                // ---- G6 改密码没动库内容
                check(
                    'G6',
                    '改主密码重写了整个库，条目一条不少',
                    byNew.ok && byNew.entries === entriesBefore,
                    `条目 ${entriesBefore} → ${byNew.ok ? byNew.entries : '开不了'}`
                );

                // ---- G7 对照：主密码输错时，整条链路必须停在原地
                //
                // 没有这一条，一个「不验旧密码、无条件往下走」的实现照样能过 G1–G6。
                //
                // 两条腿都要走，因为她们被拦住的地方不一样：
                //
                //   · 换档那条，目标密码**就是**输入的那个 —— 所以即便跳过第 ② 步的校验，
                //     第 ④ 步「用新凭据开刚导出的字节」也会失败（文件里还是旧密码），
                //     照样拦得住。
                //   · 改密那条，新密码是另一个值 —— 跳过第 ② 步就一路通到底，磁盘被
                //     重写成新密码。用户以为自己输错了会被拒绝，实际库已经换锁。
                //
                // 只测前者时，把第 ② 步整段挖掉的变异照样全绿 —— 这一条是变异验证
                // 发现的（见附录 O）。
                const beforeWrong = await digest();
                const legs: Array<[string, () => Promise<void>]> = [
                    ['换档', () => store.changePreset(`${NEW_PW} 不对`, '安全')],
                    ['改主密码', () => store.changeMasterPassword(`${NEW_PW} 不对`, `${NEW_PW} 更不对`)]
                ];
                const refusals: string[] = [];
                for (const [what, run] of legs) {
                    try {
                        await run();
                        refusals.push(`${what}=没有拒绝`);
                    } catch (err) {
                        refusals.push(`${what}=${message(err)}`);
                    }
                }
                const afterWrong = await digest();
                check(
                    'G7',
                    '主密码输错时两种重建都拒绝执行，磁盘上那份一个字节都没动',
                    refusals.every((r) => r.includes('主密码')) && beforeWrong === afterWrong,
                    `${refusals.join(' · ')} · ` +
                        `指纹${beforeWrong === afterWrong ? '未变' : `由 ${beforeWrong} 变成 ${afterWrong}`}`
                );

                // ---- G8 改回原主密码
                await store.changeMasterPassword(NEW_PW, password);
                const home = await probe(password);
                const stillNew = await probe(NEW_PW);
                check(
                    'G8',
                    '改回原主密码后：原密码能开，临时密码开不了',
                    home.ok && !stillNew.ok && home.entries === entriesBefore,
                    `原密码=${home.ok ? '能开' : '开不了'} · ` +
                        `临时密码=${stillNew.ok ? '居然还能开' : '开不了'}`
                );

                // ---- G9 换回原档位
                if (start.preset) await store.changePreset(password, start.preset);
                const back = await probe(password);
                check(
                    'G9',
                    '换回原档位后，文件头的参数回到起点',
                    !!start.preset && back.ok && back.memoryMiB === memoryBefore,
                    start.preset
                        ? `${back.memoryMiB} MiB（起点 ${memoryBefore} MiB）· 档位=${back.preset ?? '落在三档之外'}`
                        : '起点档位落在三档之外，这一条没有判别力'
                );

                // ---- G10 重建之后自动锁定仍在计时
                //
                // 重建会先 `lockDisarm()` 停表（一次重建最长约 6 秒，撞上无操作阈值
                // 就会在会话被整体替换的那一刻锁定）。收尾必须用 `lockArm`：
                // `lockConfigure` 只改参数、不置 `armed`，拿它收尾会把自动锁定永久
                // 关掉 —— 而这个后果在界面上完全看不出来。
                //
                // 阈值那一项也在断言里：起表要用**磁盘上那份**配置。只信调用方手里
                // 那份快照的话，设置面板从没被打开过时它是 null，会按 0 起表，同样
                // 把自动锁定关掉。
                //
                // 这一条测得到，是因为停表 / 起表随重建流程一起放在 `store.rebuild()`
                // 里 —— 早先写在 `SettingsView.runRebuild()`，而验收直接调 store，
                // 那两条断言其实从未走到被变异的那段代码（见附录 O）。
                const lock = await lockStatus();
                check(
                    'G10',
                    '重建之后自动锁定按磁盘上的配置重新起表',
                    lock.armed && lock.idleMinutes > 0,
                    `armed=${lock.armed} · 阈值=${lock.idleMinutes} 分钟`
                );

                await mark('G 段结束：库已回到起点');
            } finally {
                await restoreAfterRebuild();
            }
        }
    } catch (err) {
        check('B1', '备份、自动锁定与剪贴板链路', false, message(err));
    } finally {
        await mark('收尾：补镜像并还原配置');
        // 这一段动过应用配置。留着的话设置页截图会拍到一个指向 .dev-home 的备份目录，
        // 而那是验收专用的路径，不是用户的配置。
        try {
            // 先把镜像补回来：B9 那一步的保存没能镜像，磁盘上的备份件落后于主库。
            // 后面验收要拿它跟主库逐字节比，还要用 KeePassXC 打开它。
            await settingsUpdate({ backupDir });
            await backupRun(true);
        } catch {
            /* 补镜像失败不该盖住真正的失败项 */
        }
        try {
            await settingsUpdate({ backupDir: null, keepVersions: 10, autoLockMinutes: 5 });
        } catch {
            /* 恢复失败不该盖住真正的失败项 */
        }
    }

    return items;
}
