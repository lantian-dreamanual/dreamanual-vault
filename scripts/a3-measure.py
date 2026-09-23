#!/usr/bin/env python3
"""A3 侧栏材质的读数工具。

要回答的问题：侧栏那块到底有没有真的被 macOS 材质画出来。

**主判据**（与背景无关，深浅两档通用）：侧栏底色必须与同一个窗口里的内容面板
明显不同色，也不能落在纯黑 / 纯白上。材质没生效时，侧栏要么被网页底色盖成面板色
（差值 ≈ 0），要么背后什么都没有（值落在 0 或 255）。

辅以**同一时刻的两张截图**对照，作为读数：

  window.png  `screencapture -l <窗口 id>`，只抓窗口。窗口背后什么都没有，
              毛玻璃（blendingMode = BehindWindow）没得采样，只能落到兜底色。
  full.png    `screencapture -x` 抓整屏。窗口压在真实桌面上合成，是用户看到的样子。

  · 深色档两张之差 +7 左右，且差异沿 y 有结构 → 材质确实在采样窗口背后的内容
  · 浅色档两张之差 ≈ 0 → 这一档的 sidebar 材质近乎不透明，不吃桌面。
    **这不是失败**，所以不能拿「两张之差」当主判据。

两条容易踩的坑，都已在代码里挡掉：

  1. 全屏图那一路要求窗口**没被遮住**。窗口在后台时，那个矩形上拍到的是压住它的
     别的窗口 —— 读数会静默变成别人的颜色（实测拍到一块浅色面板，差值 +192，
     看起来像「材质坏了」）。所以截图前先 activate。
  2. 归属名不能只用子串 `dreamanual`。本机另有一个叫 `Dreamanual` 的应用
     （投资监控），会被一起匹配进来。

用法：
    python3 scripts/a3-measure.py            # 应用在跑即可，脚本会自己提到前台
"""

import subprocess
import sys
import time

try:
    import numpy as np
    import Quartz
    from AppKit import NSApplicationActivateIgnoringOtherApps, NSRunningApplication
    from PIL import Image
except ImportError as exc:  # pragma: no cover
    sys.exit(f"需要 pyobjc-framework-Quartz / AppKit 与 pillow/numpy：{exc}")

OUT = "/tmp/a3-probe"

# 打包成 .app 之后归属名是 productName（Dreamanual 密码管理），直接跑二进制时是进程名。
OWNERS = ("dreamanual-vault", "密码管理")

# 列宽取自 tokens.css：--sider-w 248 / --list-w 322 / 详情 510（CSS 点 ×2 = 像素）
BANDS = {
    "侧栏": (0, 496),
    "列表面板": (496, 1140),
    "详情面板": (1140, 2160),
}
# 顶部 30 CSS 点（60 像素）是 Overlay 标题栏那一带，红绿灯浮在上面，先切掉
TOP_CUT = 60


def find_window(budget=30.0):
    """拿面积最大的本应用窗口，返回 (窗口 id, bounds, 归属进程 pid)。

    带轮询：二进制刚重新链接后的**首次**启动，窗口登记到窗口服务器会明显变慢，
    一次性查询会误报「没找到应用窗口」。
    """
    options = Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements
    deadline = time.monotonic() + budget
    seen = {}
    while True:
        best = None
        for w in Quartz.CGWindowListCopyWindowInfo(options, Quartz.kCGNullWindowID):
            owner = w.get("kCGWindowOwnerName") or ""
            if not any(c in owner.lower() or c in owner for c in OWNERS):
                # 记下都看到了谁 —— 失败时能一眼看出是「应用没起」还是「判据不对」
                seen[owner or "(无名)"] = seen.get(owner or "(无名)", 0) + 1
                continue
            if w.get("kCGWindowLayer", 1) != 0:
                continue
            b = w.get("kCGWindowBounds", {})
            area = b.get("Width", 0) * b.get("Height", 0)
            if area <= 0:
                continue
            if best is None or area > best[2]:
                best = (w["kCGWindowNumber"], b, area, w.get("kCGWindowOwnerPID"))
        if best or time.monotonic() >= deadline:
            if best is None:
                print(f"共看到 {sum(seen.values())} 个窗口，归属：{', '.join(sorted(seen))}", file=sys.stderr)
            return None if best is None else (best[0], best[1], best[3])
        time.sleep(0.5)


def activate(pid):
    """把应用提到前台，返回是否成功（见文件头第 1 条坑）。"""
    if not pid:
        return False
    app = NSRunningApplication.runningApplicationWithProcessIdentifier_(pid)
    if app is None:
        return False
    ok = app.activateWithOptions_(NSApplicationActivateIgnoringOtherApps)
    time.sleep(1.0)
    return bool(ok)


def band_means(img):
    a = np.asarray(img.convert("RGB")).astype(np.float64)[TOP_CUT:, :, :]
    return {k: a[:, x0:x1].reshape(-1, 3).mean(axis=0) for k, (x0, x1) in BANDS.items()}


def main() -> int:
    found = find_window()
    if not found:
        print("没找到应用窗口 —— 先起应用再跑这个脚本", file=sys.stderr)
        return 2

    window_id, bounds, pid = found
    print(f"窗口 id={window_id} pid={pid} 位置=({bounds['X']:.0f}, {bounds['Y']:.0f}) "
          f"尺寸={bounds['Width']:.0f}×{bounds['Height']:.0f} 点")
    print("提到前台：" + ("成功" if activate(pid) else "失败（读数可能拍到被遮住的内容）"))

    win_png = f"{OUT}/window.png"
    full_png = f"{OUT}/full.png"

    subprocess.run(["/usr/sbin/screencapture", "-l", str(window_id), "-o", "-x", win_png], check=True)
    subprocess.run(["/usr/sbin/screencapture", "-x", full_png], check=True)

    full = Image.open(full_png)
    # bounds 是逻辑点，整屏图是物理像素：按比例换算（Retina 下正好 2 倍）
    scale = full.width / Quartz.CGDisplayBounds(Quartz.CGMainDisplayID()).size.width
    box = (
        round(bounds["X"] * scale),
        round(bounds["Y"] * scale),
        round((bounds["X"] + bounds["Width"]) * scale),
        round((bounds["Y"] + bounds["Height"]) * scale),
    )
    print(f"整屏 {full.width}×{full.height} 像素，换算倍率 {scale:g}，窗口在整屏图里占 {box}")

    win = Image.open(win_png)
    crop = full.crop(box)
    if crop.size != win.size:
        crop = crop.resize(win.size, Image.LANCZOS)
        print("（两次裁切尺寸不一致，已按窗口图重采样）")

    mw, mc = band_means(win), band_means(crop)

    side, panel = mw["侧栏"].mean(), mw["列表面板"].mean()
    painted = abs(side - panel) > 20 and 8 < side < 247

    print()
    print(f"{'区域':<10} {'只看窗口':>20} {'压在桌面上':>20} {'差':>8}   读数")
    for k in BANDS:
        d = mc[k].mean() - mw[k].mean()
        if k == "侧栏":
            note = "与内容面板不同色，材质在画" if painted else "与内容面板同色 —— 材质没生效"
        else:
            note = "不透明（两张一致）" if abs(d) <= 2 else "变了 —— 这一块不该受材质影响"
        print(f"{k:<10} ({mw[k][0]:6.1f},{mw[k][1]:6.1f},{mw[k][2]:6.1f}) "
              f"({mc[k][0]:6.1f},{mc[k][1]:6.1f},{mc[k][2]:6.1f}) {d:+7.1f}   {note}")

    sens = mc["侧栏"].mean() - mw["侧栏"].mean()
    print()
    print(f"侧栏对桌面的敏感度（两张之差）：{sens:+.1f}　"
          f">6 说明材质还吃窗口背后的内容；≈0 说明这一档的材质近乎不透明（正常）")
    opaque_ok = all(abs(mc[k].mean() - mw[k].mean()) <= 2 for k in ("列表面板", "详情面板"))
    ok = painted and opaque_ok
    print("结论：" + ("材质生效，且内容区未被波及" if ok else "有项不符 —— 见上表"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
