/* 「移动库文件」弹窗（F1.4）。
 *
 * 为什么不用 `confirmDialog`：这一趟要在确认之前先选目标文件夹，选完还要当场
 * 校验（同目录 / 不存在 / 同名 / 不可写 / 跨盘 / 云盘），确认之后又要显示执行
 * 进度。四个状态加一个失败态，两句话的确认框装不下。
 *
 * 分工：本文件只管界面与状态流转。**保存与搬动都由调用方传进来** ——
 * 「先落盘、再搬文件」这条顺序属于会话层（`store.moveTo`），写在这里就成了
 * 第二份实现，验收直接调 store 时走不到。
 *
 * 文案口径（design-system 第八节「设置行文案」/ 知识库「去 AI 味」第五类）：
 * 提示只写原因与结果。「复制、校验、删源」这些过程不进界面。
 */

import { escapeHtml, isComposing, onBackdropClose } from './dom';
import { icons } from './icons';
import { listenMoveProgress, pickFolder, vaultMoveCheck, type MoveCheck } from '../host';

export interface MoveDialogOptions {
    /** 当前库的完整路径，弹窗里照原样显示 */
    source: string;
    /** 文件名。搬动不改名，两个状态的提示里都要用到它 */
    fileName: string;
    /** 同目录的历史版本份数（面板上那行副标题用的是同一个数） */
    versions: number;
    /** 搬之前把内存里的改动落盘 */
    prepare: () => Promise<void>;
    /** 真正搬。返回新路径与搬过去的历史版本份数 */
    run: (dir: string) => Promise<{ path: string; versions: number }>;
}

export interface MoveOutcome {
    path: string;
    versions: number;
}

/** 拦下的原因 → 一句提示。原因在后端（它才看得见文件系统），话在这里说。 */
function blockStrip(check: MoveCheck): string {
    const name = `<b>${escapeHtml(check.fileName)}</b>`;
    switch (check.block) {
        case 'same-dir':
            return `库文件已经在这个文件夹里。请选择其他文件夹。`;
        case 'missing':
            return `这个文件夹打不开。请选择其他文件夹。`;
        case 'conflict':
            return `这个文件夹里已有同名文件 ${name}。请选择其他文件夹，或先重命名该文件。`;
        case 'readonly':
            return `这个文件夹不能写入。请选择其他文件夹。`;
        default:
            return `这个文件夹不能用来放库文件。请选择其他文件夹。`;
    }
}

/** 「会一起移动什么」。份数为 0 时不要硬凑一句「0 份历史版本」。 */
function moveNote(fileName: string, versions: number): string {
    const name = `<b>${escapeHtml(fileName)}</b>`;
    return versions > 0
        ? `会一起移动 ${name} 与同目录的 <b>${versions} 份历史版本</b>。`
        : `会移动 ${name}。同目录没有其他历史版本。`;
}

function strip(kind: 'info' | 'warn' | 'danger', text: string): string {
    const icon = kind === 'danger' || kind === 'warn' ? icons.alert(14) : icons.info(14);
    return `<div class="strip ${kind}">${icon}<div>${text}</div></div>`;
}

/** 失败原因 → 一句人话。
 *
 *  后端报的是「哪一步、哪个文件、什么 errno」，那是给排查用的。界面只留
 *  结论与出口，原文挂到弹窗正文的 title 上 —— 要用时悬停看得到，平时不占版面。
 *  这一层不能少：`移动失败：/path（os error 13）` 与前端那句前缀叠在一起，
 *  会拼出「移动失败。移动失败：…」。 */
function failureText(raw: string): string {
    // 后端 preflight 兜底的拦截串已经是给人看的话（与 blockStrip 同一份措辞），
    // 原样透出，不要再包一层「移动没有完成」。
    if (raw.includes('请选择其他文件夹')) return escapeHtml(raw);
    const why = /Permission denied|os error 13/.test(raw)
        ? '没有写入这个文件夹的权限。'
        : /No space left|os error 28/.test(raw)
          ? '这个磁盘没有足够空间。'
          : /校验/.test(raw)
            ? '复制之后校验没通过，文件可能已损坏。'
            : '移动没有完成。';
    // 回滚卡住时才有文件留在新位置，那时不能说「还在原位置」
    const where = raw.includes('没能退回原处')
        ? '有文件没能退回原处，请到访达里确认。'
        : '库文件还在原位置。';
    return `${escapeHtml(why)}${where}`;
}

export function moveVaultDialog(options: MoveDialogOptions): Promise<MoveOutcome | null> {
    const { source, fileName, prepare, run } = options;
    let versions = options.versions;

    return new Promise<MoveOutcome | null>((resolve) => {
        const mask = document.createElement('div');
        mask.className = 'mask';
        mask.innerHTML =
            `<div class="modal" style="max-width:440px">` +
            `<div class="modal-head"><h2>移动库文件</h2>` +
            `<button class="icon-btn" type="button" data-role="close" title="关闭" aria-label="关闭">${icons.close()}</button></div>` +
            `<div class="modal-body" data-role="body"></div>` +
            `<div class="modal-foot" data-role="foot">` +
            `<button class="btn btn-gho" data-role="cancel">取消</button>` +
            `<button class="btn btn-pri" data-role="ok" disabled>移动</button>` +
            `</div></div>`;

        const body = mask.querySelector<HTMLElement>('[data-role="body"]')!;
        const foot = mask.querySelector<HTMLElement>('[data-role="foot"]')!;
        const okBtn = mask.querySelector<HTMLButtonElement>('[data-role="ok"]')!;
        const head = mask.querySelector<HTMLElement>('.modal-head')!;

        /** 已经选好的目标目录；null = 还没选 */
        let target: string | null = null;
        /** 上一次校验的结果。拦下时主按钮不可点 */
        let check: MoveCheck | null = null;
        /** 正在搬。这期间 Esc 与关闭都不响应 —— 中途停下会留下两份库 */
        let running = false;

        const finish = (value: MoveOutcome | null): void => {
            document.removeEventListener('keydown', onKey, true);
            mask.remove();
            resolve(value);
        };

        // ------------------------------------------------------------ 选目标

        const renderChoose = (): void => {
            const picked = target !== null;
            const blocked = check?.block ?? null;

            const notes: string[] = [];
            if (check && !blocked) {
                if (check.crossDisk) notes.push(strip('info', '目标位置位于另一个磁盘，移动可能需要较长时间。'));
                if (check.cloud) notes.push(strip('warn', '这个文件夹在云盘同步范围内，移动后库文件会被同步到云端。'));
            }

            body.innerHTML =
                `<div class="mv-lbl">当前位置</div>` +
                `<div class="mv-path">${escapeHtml(source)}</div>` +
                `<div class="mv-lbl">移到</div>` +
                `<div class="mv-target">` +
                `<button class="btn btn-gho" type="button" data-role="pick">${picked ? '重新选择…' : '选择文件夹…'}</button>` +
                `<span class="mv-val${picked ? '' : ' is-empty'}">${picked ? escapeHtml(target!) : '尚未选择'}</span>` +
                `</div>` +
                (blocked ? strip('danger', blockStrip(check!)) : notes.join('')) +
                `<p class="mv-note">${moveNote(fileName, versions)}</p>`;

            okBtn.disabled = !picked || Boolean(blocked);
            head.querySelector('[data-role="close"]')?.classList.remove('is-off');
        };

        const pick = async (): Promise<void> => {
            let dir: string | null;
            try {
                dir = await pickFolder('选择目标文件夹');
            } catch {
                return;
            }
            if (!dir) return;

            try {
                check = await vaultMoveCheck(dir);
                target = dir;
                versions = check.versions;
            } catch {
                // 校验自己挂了（宿主不可用）时别把人挡在门外：交给真正搬动那一步报错
                check = null;
                target = dir;
            }
            renderChoose();
        };

        // ------------------------------------------------------------ 执行中

        const renderRunning = (done: number | null, total: number): void => {
            // 主库加历史版本只有一份时（total = 1）不必报数，报了也是「1/1」；
            // 这时也没有什么「历史版本」可提 —— 上一屏刚说过「同目录没有其他历史版本」。
            const counting = total > 1 && done !== null;
            const what = total > 1 ? '正在移动库文件与历史版本' : '正在移动库文件';
            body.innerHTML =
                `<div class="mv-steps">` +
                `<div class="mv-step is-done"><span class="ico">${icons.stepDone(16)}</span>已保存当前改动</div>` +
                `<div class="mv-step is-now"><span class="ico is-spin">${icons.stepNow(16)}</span>` +
                `${what}${counting ? `（${done}/${total}）` : '…'}</div>` +
                `<div class="mv-step"><span class="ico">${icons.stepNext(16)}</span>完成移动</div>` +
                `</div>`;
        };

        // ------------------------------------------------------------ 失败

        const renderFailure = (reason: string): void => {
            running = false;
            body.innerHTML = strip('danger', failureText(reason));
            // 原始原因（含 errno 与路径）挂在这里，排查时悬停能看全，平时不上界面
            body.title = reason;
            // 失败之后只剩「关闭」一个出口：库还在原位置，重试要重新选目标。
            // 页脚在执行中被藏起来了，这里必须显回来 —— 否则「关闭」是个
            // display: none 的按钮，弹窗只剩右上角那个小叉。
            foot.style.display = '';
            foot.innerHTML = `<button class="btn btn-gho" data-role="cancel">关闭</button>`;
            head.querySelector('[data-role="close"]')?.classList.remove('is-off');
        };

        const start = async (): Promise<void> => {
            if (!target || running) return;
            running = true;
            // 执行中不给出口：中途停下会留下两份库，反而要人去分辨哪份是新的
            okBtn.disabled = true;
            foot.style.display = 'none';
            head.querySelector('[data-role="close"]')?.classList.add('is-off');
            renderRunning(null, 1 + versions);

            // 拿不到进度事件时照常搬，只是不报「（7/11）」。这一步失败不能把
            // 弹窗卡在执行态 —— 那时页脚已经藏起来、关闭也不响应，页面没出口。
            const unlisten = await listenMoveProgress((done, total) => {
                if (running) renderRunning(done, total);
            }).catch(() => () => {});

            try {
                await prepare();
                const report = await run(target);
                running = false;
                finish({ path: report.path, versions: report.versions });
            } catch (err) {
                renderFailure(err instanceof Error ? err.message : String(err));
            } finally {
                unlisten();
            }
        };

        // ------------------------------------------------------------ 事件

        function onKey(ev: KeyboardEvent): void {
            if (isComposing(ev)) return;
            if (ev.key === 'Escape') {
                ev.preventDefault();
                if (!running) finish(null);
            } else if (ev.key === 'Enter') {
                ev.preventDefault();
                if (!running) void start();
            }
        }

        onBackdropClose(mask, () => {
            if (!running) finish(null);
        });

        mask.addEventListener('click', (ev) => {
            const target_ = ev.target as HTMLElement;
            const role = target_.closest<HTMLElement>('[data-role]')?.dataset.role;
            if (role === 'ok') void start();
            if (role === 'cancel' || role === 'close') {
                if (!running) finish(null);
            }
            if (role === 'pick') void pick();
        });

        document.addEventListener('keydown', onKey, true);
        document.body.appendChild(mask);
        renderChoose();
        okBtn.focus();
    });
}
