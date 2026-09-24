/* DOM 小工具。项目不引框架，这几个函数就是全部的「视图辅助」。 */

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

export function toast(message: string, ms = 1600): void {
    const node = $('#toast');
    if (!node) return;
    node.textContent = message;
    node.classList.add('on');
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
