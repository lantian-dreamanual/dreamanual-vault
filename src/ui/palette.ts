/* 分类面板：名称与颜色在同一个框里改完。
 *
 * 颜色只给固定色板、不给任意取色：分类圆点压在侧栏毛玻璃上（macOS 材质，不是令牌），
 * 这一板色是按那个底选出来并进了对比度门禁的（spike/contrast.mjs，门槛 4.0:1）。
 * 任意取色没有任何门禁挡得住「选了个在深色底上看不见的色」。
 *
 * 色格从 `DOT_COLORS` 来，不在本文件里写死十六进制 —— 色板只有一个来源，
 * 门禁也从那一个来源读。
 *
 * 名称与颜色为什么同框：两者都是「这个分类长什么样」，分成两个弹窗之后，
 * 改一个分类要右键两次、开两次形态不同的窗。 */

import { DOT_COLORS, isDotColor } from '../vault/model';
import { escapeHtml, isComposing, onBackdropClose } from './dom';

export interface GroupDraft {
    name: string;
    /** 色值 / `null`（跟随自动）。 */
    color: string | null;
}

export interface GroupDialogOptions {
    title: string;
    /** 名称预填。新建时传空串。 */
    name: string;
    /** 当前颜色。`null` = 跟随自动。 */
    color: string | null;
    /** 名称校验。返回问题文案就拦下提交，返回 `null` 放行。 */
    validate: (name: string) => string | null;
}

/** 色格的朗读名，顺序与 `DOT_COLORS` 一一对应。 */
export const SWATCH_LABELS = ['粉', '橙', '黄', '柠檬', '绿', '青绿', '青', '蓝', '紫', '洋红'];

/**
 * 返回值是三态：草稿 / `undefined`（取消）。
 *
 * 取消与「跟随自动」必须分开：合成一个值的话，按 Esc 会变成「把颜色清掉」，
 * 而用户按 Esc 的意思是「当我没点过」。
 */
export function groupDialog(options: GroupDialogOptions): Promise<GroupDraft | undefined> {
    const { title, name, color, validate } = options;

    return new Promise<GroupDraft | undefined>((resolve) => {
        const mask = document.createElement('div');
        mask.className = 'mask';

        const autoOn = !color || !isDotColor(color);
        const swatch = (value: string, label: string, on: boolean, extra = ''): string =>
            `<button type="button" class="palette-sw${extra}${on ? ' is-on' : ''}" role="radio" ` +
            `aria-checked="${on}" data-color="${value}"` +
            (value ? ` style="--sw:${value}"` : '') +
            ` aria-label="${escapeHtml(label)}"></button>`;

        mask.innerHTML =
            `<div class="modal" style="max-width:420px">` +
            `<div class="modal-head"><h2>${escapeHtml(title)}</h2></div>` +
            `<div class="modal-body">` +
            `<div class="field"><label for="group-name">分类名</label>` +
            `<input class="inp" id="group-name" autocomplete="off" spellcheck="false" ` +
            `placeholder="例如：服务器" value="${escapeHtml(name)}">` +
            `<div class="lock-msg" data-role="err"></div></div>` +
            `<div class="field palette-field"><label>颜色</label>` +
            `<div class="palette" role="radiogroup" aria-label="分类颜色">` +
            swatch('', '跟随自动', autoOn, ' is-auto') +
            DOT_COLORS.map((hex, i) => swatch(hex, SWATCH_LABELS[i] ?? hex, hex === color)).join('') +
            `</div></div>` +
            `</div>` +
            `<div class="modal-foot">` +
            `<button class="btn btn-gho" data-role="cancel">取消</button>` +
            `<button class="btn btn-pri" data-role="ok">保存</button>` +
            `</div></div>`;

        const input = mask.querySelector<HTMLInputElement>('#group-name')!;
        const errBox = mask.querySelector<HTMLElement>('[data-role="err"]')!;

        const finish = (result: GroupDraft | undefined): void => {
            document.removeEventListener('keydown', onKey, true);
            mask.remove();
            resolve(result);
        };

        /** 「跟随自动」那一格的 `data-color` 是空串，读出来要还原成 `null`。 */
        const picked = (): string | null =>
            mask.querySelector<HTMLElement>('.palette-sw.is-on')?.dataset.color || null;

        const submit = (): void => {
            const text = input.value.trim();
            const problem = validate(text) ?? (text ? null : '分类名不能为空');
            if (problem) {
                errBox.textContent = problem;
                input.focus();
                input.select();
                return;
            }
            finish({ name: text, color: picked() });
        };

        function onKey(ev: KeyboardEvent): void {
            // 名称框装的是中文，选词时的回车 / Esc 不响：回车确认候选项会当场把
            // 面板提交掉。焦点落在色格上时按回车同样走提交，与这里不冲突。
            if (isComposing(ev)) return;
            if (ev.key === 'Escape') {
                ev.preventDefault();
                finish(undefined);
            } else if (ev.key === 'Enter') {
                ev.preventDefault();
                submit();
            }
        }

        // 点遮罩关窗走 `onBackdropClose`：拖选文字拖出面板、抬在遮罩上时
        // click 目标恰好是遮罩，只判 `target === mask` 会把面板误关。
        onBackdropClose(mask, () => finish(undefined));
        mask.addEventListener('click', (ev) => {
            const target = ev.target as HTMLElement;
            const role = target.closest<HTMLElement>('[data-role]')?.dataset.role;

            if (role === 'ok') {
                submit();
                return;
            }
            if (role === 'cancel') {
                finish(undefined);
                return;
            }

            const sw = target.closest<HTMLElement>('.palette-sw');
            if (!sw) return;
            for (const other of Array.from(mask.querySelectorAll('.palette-sw'))) {
                other.classList.toggle('is-on', other === sw);
                other.setAttribute('aria-checked', String(other === sw));
            }
            sw.focus();
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
