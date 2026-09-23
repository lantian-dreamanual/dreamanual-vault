#!/usr/bin/env python3
"""只截应用自己的窗口，不截整个屏幕。

两步走：
  1. 用 Quartz 按归属进程名筛出目标窗口，拿到 CGWindowID 与窗口尺寸；
  2. 调系统 `screencapture -l <id>` 抓那一块。

为什么不用 `CGWindowListCreateImage`：该 API 自 macOS 14 起被废弃，新系统上
直接返回空图（ScreenCaptureKit 取代了它）。`screencapture` 走的是系统截图
路径，权限由「屏幕录制」统一授予，在新系统上仍然可用。

`-o` 去掉窗口阴影，`-x` 不播快门声。抓窗口本身不要求窗口在最前，
被遮挡也照样抓得到。

需要「屏幕录制」权限。没授权时 screencapture 会失败或产出黑图，
脚本据此报错而不是静默产出废图。

用法：
    python3 scripts/window-shot.py <输出路径> [进程名…]
    python3 scripts/window-shot.py <输出路径> --pid <pid>

`--pid` 优先：只认这个进程的窗口，不再看归属名。脚本自己起的应用都有 PID，
应当一律走这条路；按名字匹配是给手工调用留的退路。
"""

import os
import struct
import subprocess
import sys
import tempfile
import time

try:
    import Quartz
except ImportError:
    sys.exit("需要 pyobjc 的 Quartz 模块：pip install pyobjc-framework-Quartz")

# 归属名必须收紧，不能用子串 `dreamanual`：本机另有一个叫 `Dreamanual` 的应用
# （投资监控），会被一起匹配进来。它平时窗口小、抢不过本应用，但只要本应用的窗口
# 还没登记好，就会截错窗口 —— 而且不报错，只是拍到别人的界面。
# 直接跑二进制时归属名是进程名；打包成 .app 后是 productName。
#
# 但按名字匹配（无论收多紧）都有个死角：**同时存在的另一个同名/近名应用**。
# 产品名从「Dreamanual密码管理」改成「Dreamanual 密码管理」（中英文之间加空格）之后，
# 淘汰下来的旧包仍留在 /Applications 里，它的 owner 是旧名 —— 子串 `密码管理` 照样命中。
# 于是 `shots.sh` 拍出来的头几张是旧包的界面，而脚本报的是「已保存」，一切看起来正常。
# 所以调用方能给 PID 时一律给 PID（见 `find_window` 的 `pid` 参数）：
# PID 唯一，不可能命中别人。
DEFAULT_OWNER = ("dreamanual-vault", "密码管理")

# 窗口探测预算（秒）。默认 30 —— 二进制刚重新链接后的**首次**启动，窗口登记到
# 窗口服务器会明显变慢。原先用「重试 20 次 × 0.5 秒」＝固定 10 秒，整轮批次里
# 撞过一次头两张失败、单独重跑就过。改成按截止时间轮询，顺便把等了多久打出来，
# 下次再出问题带得上读数。可用 WINDOW_WAIT_SEC 覆盖。
DEFAULT_BUDGET_SEC = 30.0


def find_window(candidates, pid=None):
    """返回 (window_id, bounds, owner)，取面积最大的普通窗口。

    给了 `pid` 就只认这个进程的窗口；没给才退回按归属名子串匹配（不带 .app
    直接跑二进制时，窗口服务器登记的名字是进程名；打包成 .app 之后是应用名）。
    PID 是唯一标识，能挡住「另一个近名应用同时开着窗口」这类误配。"""
    options = (
        Quartz.kCGWindowListOptionOnScreenOnly
        | Quartz.kCGWindowListExcludeDesktopElements
    )
    windows = Quartz.CGWindowListCopyWindowInfo(options, Quartz.kCGNullWindowID)

    best = None
    for w in windows:
        owner = w.get("kCGWindowOwnerName", "")
        if pid is not None:
            if w.get("kCGWindowOwnerPID") != pid:
                continue
        elif not any(c.lower() in owner.lower() for c in candidates):
            continue
        if w.get("kCGWindowLayer", 1) != 0:
            continue
        bounds = w.get("kCGWindowBounds", {})
        area = bounds.get("Width", 0) * bounds.get("Height", 0)
        if area <= 0:
            continue
        if best is None or area > best[2]:
            best = (w["kCGWindowNumber"], bounds, area, owner)

    if best is None:
        return None
    return best[0], best[1], best[3]


def png_size(path):
    """直接读 PNG 头拿尺寸，不依赖图像库"""
    with open(path, "rb") as f:
        head = f.read(24)
    if head[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    return struct.unpack(">II", head[16:24])


def main() -> int:
    argv = list(sys.argv[1:])
    pid = None
    if "--pid" in argv:
        i = argv.index("--pid")
        try:
            pid = int(argv[i + 1])
        except (IndexError, ValueError):
            print("--pid 后面要跟一个整数进程号", file=sys.stderr)
            return 2
        del argv[i : i + 2]

    out = os.path.abspath(argv[0] if argv else "shot.png")
    candidates = argv[1:] or list(DEFAULT_OWNER)

    try:
        budget = float(os.environ.get("WINDOW_WAIT_SEC") or DEFAULT_BUDGET_SEC)
    except ValueError:
        budget = DEFAULT_BUDGET_SEC

    # 窗口刚起来时可能还没登记到窗口服务器，按截止时间轮询而不是固定次数
    started = time.monotonic()
    deadline = started + budget
    found = None
    while True:
        found = find_window(candidates, pid)
        if found or time.monotonic() >= deadline:
            break
        time.sleep(0.5)

    if not found:
        waited = time.monotonic() - started
        who = f"PID {pid}" if pid is not None else f"归属名「{'/'.join(candidates)}」"
        print(
            f"没找到匹配 {who} 的窗口（已等 {waited:.1f} 秒）。应用在跑吗？",
            file=sys.stderr,
        )
        return 2

    window_id, bounds, owner = found

    # 先落临时文件：screencapture 失败时可能留下 0 字节或半截文件，
    # 直接写目标路径会让「废图」看起来像成功产物。
    tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    tmp.close()
    try:
        proc = subprocess.run(
            ["/usr/sbin/screencapture", "-l", str(window_id), "-o", "-x", tmp.name],
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            print(
                f"抓图失败（退出码 {proc.returncode}）：{proc.stderr.strip() or '多半是没给「屏幕录制」权限'}",
                file=sys.stderr,
            )
            return 3

        size = png_size(tmp.name)
        if not size:
            print("抓图失败：产出不是合法 PNG", file=sys.stderr)
            return 3

        width, height = size
        # screencapture 抓的是物理像素，bounds 是逻辑点。Retina 下宽高会翻倍，
        # 所以只校验比例，不校验绝对值。
        expected = (bounds["Width"], bounds["Height"])
        if width <= 0 or height <= 0:
            print("抓图失败：图像尺寸为 0", file=sys.stderr)
            return 3
        if round(width / height, 2) != round(expected[0] / expected[1], 2):
            print(
                f"警告：抓到 {width}×{height}，与窗口比例 {expected[0]:.0f}×{expected[1]:.0f} 不符",
                file=sys.stderr,
            )

        os.replace(tmp.name, out)
        print(
            f"已保存 {out}（{width}×{height} 像素，窗口 {expected[0]:.0f}×{expected[1]:.0f} 点，归属 {owner}）"
        )
        return 0
    finally:
        if os.path.exists(tmp.name):
            os.unlink(tmp.name)


if __name__ == "__main__":
    sys.exit(main())
