/* 右键菜单。
 *
 * 自建而不用系统的：macOS 网页里右键会弹 WebKit 的「重新载入 / 检查元素」，
 * 与应用观感割裂；Tauri 的菜单插件又只能挂到原生菜单栏上，跟随不了鼠标位置。
 *
 * 菜单挂到 body 上用 fixed 定位，出界时往回收，避免贴着屏幕边缘时被裁掉。 */

import { escapeHtml, isComposing } from './dom';

export interface MenuItem {
    label: string;
    danger?: boolean;
    onPick: () => void;
}

let openMenu: HTMLElement | null = null;
let detach: (() => void) | null = null;

export function closeContextMenu(): void {
    detach?.();
    detach = null;
    openMenu?.remove();
    openMenu = null;
}

export function contextMenu(pos: { x: number; y: number }, items: MenuItem[]): void {
    closeContextMenu();
    if (!items.length) return;

    const el = document.createElement('div');
    el.className = 'ctxmenu';
    el.setAttribute('role', 'menu');
    el.innerHTML = items
        .map(
            (item, i) =>
                `<button role="menuitem" data-i="${i}"${item.danger ? ' class="is-danger"' : ''}>` +
                `${escapeHtml(item.label)}</button>`
        )
        .join('');
    document.body.appendChild(el);

    const rect = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(pos.x, window.innerWidth - rect.width - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(pos.y, window.innerHeight - rect.height - 8))}px`;

    const onKey = (ev: KeyboardEvent): void => {
        // 输入法选词那一下 Esc 是在取消候选词，不该把菜单关掉。
        if (isComposing(ev)) return;
        if (ev.key !== 'Escape') return;
        ev.preventDefault();
        closeContextMenu();
    };
    const onAway = (ev: Event): void => {
        if (el.contains(ev.target as Node)) return;
        closeContextMenu();
    };

    el.addEventListener('click', (ev) => {
        const btn = (ev.target as HTMLElement).closest<HTMLElement>('button[data-i]');
        if (!btn) return;
        const item = items[Number(btn.dataset.i)];
        closeContextMenu();
        item?.onPick();
    });

    // 延迟一轮再挂全局监听：触发本次菜单的那一下 pointerdown 已经过去了，
    // 但避免同一次事件的冒泡路径上又把自己关掉，这里留一个 tick 更稳。
    window.setTimeout(() => {
        window.addEventListener('pointerdown', onAway, true);
        window.addEventListener('blur', closeContextMenu);
        window.addEventListener('resize', closeContextMenu);
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('scroll', closeContextMenu, true);
        detach = () => {
            window.removeEventListener('pointerdown', onAway, true);
            window.removeEventListener('blur', closeContextMenu);
            window.removeEventListener('resize', closeContextMenu);
            document.removeEventListener('keydown', onKey, true);
            document.removeEventListener('scroll', closeContextMenu, true);
        };
    }, 0);

    openMenu = el;
}
