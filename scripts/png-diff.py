#!/usr/bin/env python3
"""两张同尺寸 PNG，数出指定列起往右有多少像素不同。

用法：
    python3 scripts/png-diff.py <a.png> <b.png> [x起=0]

stdout 只打一个整数（不同的像素数）。真出错才非 0 退出。

---

`shots.sh` 收尾拿它验 `10-focus.png`：**焦点环到底画出来了没有。**

为什么不能用「两张图哈希不同」当判据 —— 这条踩过，记在这里免得再踩：

侧栏材质是 `followsWindowActiveState` 的，窗口活跃 / 不活跃时同一块底会差到
(71,73,75) 与 (45,50,53)。所以 `10-focus` 与 `03-vault` 的哈希**天然**就不同，
而那两张图的列表列可以逐字节相同。曾经据此判断「焦点环偶发没画，已修好」，
实际它一次都没画出来 —— 哈希变了，环没画。

判据收窄到「列表列」才有意义：侧栏那点材质噪声够不到它，只有列表里真出现了
或消失了什么东西，这里才不为 0。反过来，两张本该相同的图在这里应当为 0。

---

不用 PIL：`shots.sh` 挑解释器的唯一条件是「装了 Quartz」（见那边选 PYTHON 的
循环），这里跟着用同一套 API，不额外多一个依赖。

⚠️ 两个坑：

1. `CGBitmapContext` 的坐标原点在**左下**，装进内存后第 0 行是图像的最后一行。
   本脚本只按行比较，两端一致地翻，翻不翻都不影响结果 —— 但要是有人拿它按
   (x, y) 取某个具体像素，得先翻回来（`h-1-y`），并且留意 Quartz 会做色彩空间
   转换，读出来的 RGB 与 PIL 原值会差几个数。
2. `CGBitmapContextGetData` 拿到的是**借用**的内存，不是自己的。上下文一旦被
   回收，这块内存就没了，再去读就是段错误。所以这里立刻 `bytes()` 拷一份，
   并把上下文留在返回值里吊着命。
"""

import sys

try:
    import Quartz
    from Foundation import NSURL
except ImportError:
    sys.exit("需要 pyobjc 的 Quartz / Foundation：pip install pyobjc-framework-Quartz")


def pixels(path):
    """返回 (宽, 高, 每行字节数, 像素字节)。像素按 RGBA 四字节排列。"""
    url = NSURL.fileURLWithPath_(path)
    src = Quartz.CGImageSourceCreateWithURL(url, None)
    if src is None:
        sys.exit(f"读不出来：{path}")
    image = Quartz.CGImageSourceCreateImageAtIndex(src, 0, None)
    width = Quartz.CGImageGetWidth(image)
    height = Quartz.CGImageGetHeight(image)
    row_bytes = width * 4
    ctx = Quartz.CGBitmapContextCreate(
        None,
        width,
        height,
        8,
        row_bytes,
        Quartz.CGColorSpaceCreateDeviceRGB(),
        Quartz.kCGImageAlphaPremultipliedLast | Quartz.kCGBitmapByteOrder32Big,
    )
    Quartz.CGContextDrawImage(ctx, Quartz.CGRectMake(0, 0, width, height), image)
    raw = bytes(Quartz.CGBitmapContextGetData(ctx).as_buffer(row_bytes * height))
    return width, height, row_bytes, raw, (src, image, ctx)


def main() -> int:
    argv = sys.argv[1:]
    if len(argv) < 2:
        sys.exit("用法：png-diff.py <a.png> <b.png> [x起=0]")
    xmin = int(argv[2]) if len(argv) > 2 else 0

    wa, ha, ra, pa, _ = pixels(argv[0])
    wb, hb, rb, pb, _ = pixels(argv[1])
    if (wa, ha) != (wb, hb):
        sys.exit(f"尺寸不同：{wa}×{ha} 与 {wb}×{hb}")

    x0 = max(0, min(xmin, wa)) * 4
    diff = 0
    for row in range(ha):
        base = row * ra
        a_row = pa[base + x0 : base + ra]
        b_row = pb[base + x0 : base + rb]
        # 整行相同就整行跳过 —— 只差几个像素时（焦点环就是这种）绝大部分行都走这条
        if a_row == b_row:
            continue
        diff += sum(1 for p, q in zip(memoryview(a_row).cast("I"), memoryview(b_row).cast("I")) if p != q)

    print(diff)
    return 0


if __name__ == "__main__":
    sys.exit(main())
