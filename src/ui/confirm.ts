/* 二次确认弹窗。删除条目、后续的恢复历史版本都用它。
   自建而不用 window.confirm：WebView 的原生 confirm 在 macOS 上是网页样式，
   与应用其余部分割裂。 */

import { escapeHtml, isComposing, onBackdropClose } from './dom';
import { icons } from './icons';

export interface ConfirmOptions {
    title: string;
    body: string;
    confirmText?: string;
    cancelText?: string;
    danger?: boolean;
}

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
    const { title, body, confirmText = '确认', cancelText = '取消', danger = false } = options;

    return new Promise<boolean>((resolve) => {
        const mask = document.createElement('div');
        mask.className = 'mask';
        mask.innerHTML =
            `<div class="modal" style="max-width:390px">` +
            `<div class="modal-head"><h2>${escapeHtml(title)}</h2></div>` +
            `<div class="modal-body"><div class="block-v" style="padding-bottom:14px">${escapeHtml(body)}</div></div>` +
            `<div class="modal-foot">` +
            `<button class="btn btn-gho" data-role="cancel">${escapeHtml(cancelText)}</button>` +
            `<button class="btn ${danger ? 'btn-danger' : 'btn-pri'}" data-role="ok">${escapeHtml(confirmText)}</button>` +
            `</div></div>`;

        const finish = (value: boolean): void => {
            document.removeEventListener('keydown', onKey, true);
            mask.remove();
            resolve(value);
        };

        function onKey(ev: KeyboardEvent): void {
            // 这个弹窗没有输入框，理论上进不了组合态。仍然过一遍 —— 让「每个 keydown
            // 的首句都判这个」成为一条没有例外的规则，有例外就会有忘掉的地方。
            if (isComposing(ev)) return;
            if (ev.key === 'Escape') {
                ev.preventDefault();
                finish(false);
            } else if (ev.key === 'Enter') {
                ev.preventDefault();
                finish(true);
            }
        }

        // 点遮罩关窗要走 `onBackdropClose`：拖选文字拖出弹窗抬起在遮罩上，
        // click 目标恰好是遮罩，只判 `target === mask` 会把弹窗误关。
        onBackdropClose(mask, () => finish(false));
        mask.addEventListener('click', (ev) => {
            const target = ev.target as HTMLElement;
            const role = target.closest<HTMLElement>('[data-role]')?.dataset.role;
            if (role === 'ok') finish(true);
            if (role === 'cancel') finish(false);
        });

        document.addEventListener('keydown', onKey, true);
        document.body.appendChild(mask);
        mask.querySelector<HTMLButtonElement>('[data-role="ok"]')?.focus();
    });
}

// ------------------------------------------------------------------ 单行输入

export interface PromptOptions {
    title: string;
    label?: string;
    value?: string;
    placeholder?: string;
    confirmText?: string;
    danger?: boolean;
    /** 同步校验。返回非空字符串表示不通过，该字符串作为错误提示。 */
    validate?: (value: string) => string | null;
}

/** 单行输入弹窗。改名分类、新建分类用它。
 *  同样不走 window.prompt —— WebView 的原生输入框与应用观感割裂，
 *  而且在 Tauri 里它的行为依赖运行时实现，不可靠。 */
export function promptDialog(options: PromptOptions): Promise<string | null> {
    const {
        title,
        label = '',
        value = '',
        placeholder = '',
        confirmText = '确定',
        danger = false,
        validate
    } = options;

    return new Promise<string | null>((resolve) => {
        const mask = document.createElement('div');
        mask.className = 'mask';
        mask.innerHTML =
            `<div class="modal" style="max-width:390px">` +
            `<div class="modal-head"><h2>${escapeHtml(title)}</h2></div>` +
            `<div class="modal-body">` +
            (label ? `<div class="field"><label for="prompt-inp">${escapeHtml(label)}</label>` : '<div class="field">') +
            `<input class="inp" id="prompt-inp" autocomplete="off" spellcheck="false" ` +
            `placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(value)}">` +
            `<div class="lock-msg" data-role="err"></div>` +
            `</div></div>` +
            `<div class="modal-foot">` +
            `<button class="btn btn-gho" data-role="cancel">取消</button>` +
            `<button class="btn ${danger ? 'btn-danger' : 'btn-pri'}" data-role="ok">${escapeHtml(confirmText)}</button>` +
            `</div></div>`;

        const input = mask.querySelector<HTMLInputElement>('#prompt-inp')!;
        const errBox = mask.querySelector<HTMLElement>('[data-role="err"]')!;

        const finish = (result: string | null): void => {
            document.removeEventListener('keydown', onKey, true);
            mask.remove();
            resolve(result);
        };

        const submit = (): void => {
            const text = input.value.trim();
            const problem = validate?.(text) ?? (text ? null : '不能为空');
            if (problem) {
                errBox.textContent = problem;
                input.focus();
                input.select();
                return;
            }
            finish(text);
        };

        function onKey(ev: KeyboardEvent): void {
            // 输入法选词时的回车 / Esc 不响：这两个弹窗里的输入框装的是分类名、
            // 主密码这一类中文内容，回车确认候选项会当场把输入提交掉。
            if (isComposing(ev)) return;
            if (ev.key === 'Escape') {
                ev.preventDefault();
                finish(null);
            } else if (ev.key === 'Enter') {
                ev.preventDefault();
                submit();
            }
        }

        onBackdropClose(mask, () => finish(null));
        mask.addEventListener('click', (ev) => {
            const target = ev.target as HTMLElement;
            const role = target.closest<HTMLElement>('[data-role]')?.dataset.role;
            if (role === 'ok') submit();
            if (role === 'cancel') finish(null);
        });

        input.addEventListener('input', () => {
            errBox.textContent = '';
        });

        document.addEventListener('keydown', onKey, true);
        document.body.appendChild(mask);
        input.focus();
        input.select();
    });
}

// ------------------------------------------------------------------ 密码字段（可多列）

export interface SecretField {
    id: string;
    label: string;
    placeholder?: string;
    /** 同步校验。返回非空字符串表示不通过，该字符串作为错误提示。 */
    validate?: (value: string, all: Record<string, string>) => string | null;
}

export interface SecretDialogOptions {
    title: string;
    /** 弹窗正文。留给「改完之后旧副本仍是旧密码」这类必须让人看见的话。 */
    body?: string;
    fields: SecretField[];
    confirmText?: string;
    /** 跨字段的整体校验（例如两次输入要一致）。返回非空字符串表示不通过。 */
    validateAll?: (all: Record<string, string>) => string | null;
}

/**
 * 多字段的密码弹窗（F7.5 改主密码用它）。
 *
 * 与 `promptDialog` 的区别只有两点：字段可以多个，每个字段默认掩码并各带一个眼睛。
 * 眼睛图标与掩码切换的观感跟编辑弹窗一致 —— 同一件事在两个地方长得不一样，
 * 用户会以为是两个功能。
 *
 * 返回值是 字段 id → 值。取消返回 null。**这里不做任何加密动作**：校验通过就把值
 * 交回调用方，真正可不可用由调用方去验（旧密码对不对只有解锁一次才知道）。
 */
export function secretDialog(options: SecretDialogOptions): Promise<Record<string, string> | null> {
    const { title, body = '', fields, confirmText = '确定', validateAll } = options;

    return new Promise<Record<string, string> | null>((resolve) => {
        const mask = document.createElement('div');
        mask.className = 'mask';

        const rows = fields
            .map(
                (f) =>
                    `<div class="field">` +
                    `<label for="secret-${escapeHtml(f.id)}">${escapeHtml(f.label)}</label>` +
                    `<div class="pw-wrap is-single">` +
                    `<input class="inp" type="password" id="secret-${escapeHtml(f.id)}" ` +
                    `data-field="${escapeHtml(f.id)}" autocomplete="off" spellcheck="false" ` +
                    `placeholder="${escapeHtml(f.placeholder ?? '')}">` +
                    `<div class="pw-tools">` +
                    `<button class="icon-btn" data-eye="${escapeHtml(f.id)}" title="显示 / 隐藏">` +
                    icons.eye() +
                    `</button></div></div></div>`
            )
            .join('');

        mask.innerHTML =
            `<div class="modal" style="max-width:400px">` +
            `<div class="modal-head"><h2>${escapeHtml(title)}</h2></div>` +
            `<div class="modal-body">` +
            (body ? `<div class="block-v" style="padding-bottom:12px">${escapeHtml(body)}</div>` : '') +
            rows +
            `<div class="lock-msg" data-role="err"></div>` +
            `</div>` +
            `<div class="modal-foot">` +
            `<button class="btn btn-gho" data-role="cancel">取消</button>` +
            `<button class="btn btn-pri" data-role="ok">${escapeHtml(confirmText)}</button>` +
            `</div></div>`;

        const errBox = mask.querySelector<HTMLElement>('[data-role="err"]')!;
        const inputs = Array.from(mask.querySelectorAll<HTMLInputElement>('input[data-field]'));

        const readAll = (): Record<string, string> => {
            const all: Record<string, string> = {};
            for (const el of inputs) all[el.dataset.field!] = el.value;
            return all;
        };

        const finish = (result: Record<string, string> | null): void => {
            document.removeEventListener('keydown', onKey, true);
            mask.remove();
            resolve(result);
        };

        const submit = (): void => {
            const all = readAll();
            let problem: string | null = null;
            for (const f of fields) {
                problem = f.validate?.(all[f.id] ?? '', all) ?? null;
                if (problem) {
                    mask.querySelector<HTMLInputElement>(`input[data-field="${f.id}"]`)?.focus();
                    break;
                }
            }
            if (!problem) problem = validateAll?.(all) ?? null;
            if (problem) {
                errBox.textContent = problem;
                (inputs.find((el) => !el.value) ?? inputs[0])?.focus();
                return;
            }
            finish(all);
        };

        function onKey(ev: KeyboardEvent): void {
            // 输入法选词时的回车 / Esc 不响：这两个弹窗里的输入框装的是分类名、
            // 主密码这一类中文内容，回车确认候选项会当场把输入提交掉。
            if (isComposing(ev)) return;
            if (ev.key === 'Escape') {
                ev.preventDefault();
                finish(null);
            } else if (ev.key === 'Enter') {
                ev.preventDefault();
                submit();
            }
        }

        onBackdropClose(mask, () => finish(null));
        mask.addEventListener('click', (ev) => {
            const target = ev.target as HTMLElement;
            const role = target.closest<HTMLElement>('[data-role]')?.dataset.role;
            if (role === 'ok') submit();
            if (role === 'cancel') finish(null);
        });

        // 眼睛：与编辑弹窗同一个路数 —— 换图标，然后重放一次关键帧。
        // 同一个元素上重复戴同一个类不会重播，所以先摘掉、强制重排、再戴上。
        for (const btn of Array.from(mask.querySelectorAll<HTMLElement>('[data-eye]'))) {
            const input = mask.querySelector<HTMLInputElement>(`input[data-field="${btn.dataset.eye}"]`)!;
            btn.addEventListener('click', () => {
                const shown = input.type === 'text';
                input.type = shown ? 'password' : 'text';
                btn.innerHTML = shown ? icons.eye() : icons.eyeOff();

                btn.classList.remove('is-pop');
                void btn.offsetWidth;
                btn.classList.add('is-pop');

                input.classList.remove('is-swap');
                void input.offsetWidth;
                input.classList.add('is-swap');
                input.focus();
            });
        }

        for (const el of inputs) {
            el.addEventListener('input', () => {
                errBox.textContent = '';
            });
        }

        document.addEventListener('keydown', onKey, true);
        document.body.appendChild(mask);
        inputs[0]?.focus();
    });
}
