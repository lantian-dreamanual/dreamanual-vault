/* DOM 小工具。项目不引框架，这几个函数就是全部的「视图辅助」。 */

import { icons } from './icons';

export function $(selector: string, root: ParentNode = document): HTMLElement | null {
    return root.querySelector(selector);
}

export function must<T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document): T {
    const node = root.querySelector<T>(selector);
    if (!node) throw new Error(`找不到元素：${selector}`);
    return node;
}

/** 列表渲染走 innerHTML，所以所有来自库里的文本都必须先过这一层 */
export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** 把命中片段包成 <mark>。先转义再匹配，两边用同一套转义，位置才对得上。 */
export function highlight(text: string, query: string): string {
    const safe = escapeHtml(text);
    const q = query.trim();
    if (!q) return safe;

    const needle = escapeHtml(q).toLowerCase();
    const haystack = safe.toLowerCase();

    let out = '';
    let from = 0;
    for (;;) {
        const at = haystack.indexOf(needle, from);
        if (at < 0) {
            out += safe.slice(from);
            break;
        }
        out += safe.slice(from, at) + '<mark>' + safe.slice(at, at + needle.length) + '</mark>';
        from = at + needle.length;
    }
    return out;
}

let toastTimer: number | undefined;

/** 提示的三种语义。 */
export type ToastKind = 'ok' | 'err' | 'info';

/** 图标 html 预先拼好。三个都是 16px（第八节「Toast」的 ic-16）。 */
const TOAST_ICON: Record<ToastKind, string> = {
    ok: icons.ok(),
    err: icons.err(),
    info: icons.info()
};

/**
 * 底部居中提示，默认 2000ms。
 *
 * `kind` 必传：这一处是「做成了」「没做成」还是「只是说明」，只有调用点知道。
 * 给默认值就没人再想它，三种语义会退化成一种。
 *
 * 图标与文字同取 `--toast-ink`，不走「成功绿 / 失败红 / 信息蓝」——
 * `--ok` / `--danger` / `--accent` 这三个基础档是为固定深色底选的，压在 toast 的
 * 浅实色底上只有 2.01 / 2.99 / 2.92:1，够不到承载图形那条 3:1 的线
 * （`spike/contrast.mjs` 的 ui 档）。语义由形状承载，与「底是实色浅底」同时成立。
 */
export function toast(message: string, kind: ToastKind, ms = 2000): void {
    const node = $('#toast');
    if (!node) return;
    node.innerHTML = `${TOAST_ICON[kind]}<span>${escapeHtml(message)}</span>`;
    node.classList.remove('ok', 'err', 'info');
    node.classList.add('on', kind);
    if (toastTimer !== undefined) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => node.classList.remove('on'), ms);
}

export function show(node: HTMLElement): void {
    node.classList.remove('hidden');
}

export function hide(node: HTMLElement): void {
    node.classList.add('hidden');
}

export function toggleClass(node: HTMLElement, name: string, on: boolean): void {
    node.classList.toggle(name, on);
}

/**
 * 这次按键是不是发生在输入法的组合态里。
 *
 * 中文输入法打字时，**回车是「确认候选词」、Esc 是「取消候选词」** —— 都是敲字过程
 * 的一部分，跟「提交」「关窗」没有任何关系。但浏览器照样会派发
 * `key === 'Enter'` / `key === 'Escape'` 的 keydown，只判 `ev.key` 的处理器会把它
 * 当成用户按了提交键。于是：标题框里选个词 → 弹窗保存关掉了；弹窗里 Esc 取消候选词
 * → 未保存的改动全丢。
 *
 * 所以所有 keydown 处理器的**第一句**都过这里。它不是某几个对话框的特例 ——
 * 这是一条适用于每一个按键处理器的通用前置判断。
 *
 * 两个条件都判：`isComposing` 是标准属性；`keyCode === 229`（旧接口）是给不发前者的
 * 输入法留的兜底 —— 那种输入法在组合态只报 229。少判一个就会漏掉一部分输入法。
 */
/**
 * 「点遮罩关窗」，并挡掉拖选误触。
 *
 * `click` 的事件目标是**按下与抬起两处节点的共同祖先** —— 在弹窗里按下、拖着选字
 * 一直拖到遮罩上抬起，共同祖先恰好是遮罩自己，`ev.target === mask` 成立，弹窗就被
 * 当成「点了外面」关掉，正在选的内容与未保存的输入一起丢掉。
 *
 * 判据因此改成：**按下那一刻就在遮罩上**，才算真的点了外面。四个弹窗
 * （条目编辑、确认框、输入框、分类/调色板面板）共用这一份。
 */
export function onBackdropClose(mask: HTMLElement, close: () => void): void {
    let downOnMask = false;
    mask.addEventListener('pointerdown', (ev) => {
        downOnMask = ev.target === mask;
    });
    mask.addEventListener('click', (ev) => {
        const hit = ev.target === mask && downOnMask;
        downOnMask = false;
        if (hit) close();
    });
}

export function isComposing(ev: KeyboardEvent): boolean {
    return ev.isComposing || ev.keyCode === 229;
}
