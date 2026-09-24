#!/usr/bin/env bash
#
# 桌面应用自动化验收的共同前置条件：屏幕得是唤醒且未锁定的。
#
# 为什么这件事必须提前判掉
# ------------------------
# macOS 在屏幕锁定 / 显示器休眠时，会把「不可见页面」的 WebContent 进程挂起。
# 具体到本应用：
#
#   - Argon2 是同步跑在 WebView 主线程上的（一次 256 MiB / 三档约 0.7 秒）
#   - 进程一旦被冻结，JS 停摆、`setTimeout` 不再触发、CPU 掉到 0%
#   - 于是 `argon2.hash()` 的 Promise 永不 settle，`WASM_TIMEOUT_MS` 那层
#     超时也**永远不会触发**（它靠的正是 setTimeout）
#
# 表现为验收脚本静默挂住：没有报错、没有输出，外面只能看到看门狗把进程杀掉。
# 实测在这上面浪费过一整轮排查 —— 症状看起来像应用自己的缺陷，实际与应用无关
# （Node 侧同样参数的 Argon2 全程稳定，因为 Node 没有窗口）。
#
# 判据用 `ioreg`：`IOConsoleLocked` / `CGSSessionScreenIsLocked` 都是明文布尔，
# 不依赖 pyobjc，也不用申请任何权限。
#
# 用法（在脚本里 source 之后调）：
#     . "$HERE/scripts/preflight-screen.sh"
#     keep_awake "$@" && { ... }        # 可选：整轮期间不让显示器休眠
#     require_screen_usable || exit 1

screen_is_locked() {
    ioreg -n Root -d1 2>/dev/null | grep -q '"IOConsoleLocked" = Yes'
}

# 让整轮跑动期间显示器不要休眠 —— 用 `caffeinate` 把本脚本重新拉起来。
#
# 为什么不能只靠开头那次预检：验收整轮两分半、截图整轮约一分钟，而**中途**显示器
# 休眠同样会走「显示器睡眠 → 屏幕锁定 → 页面进程被挂起」这条链。跑动中没人碰键鼠，
# 显示器休眠这件事恰恰是最容易发生的。撞上之后的表现与开头就锁屏一模一样：
# 脚本静默挂住、看门狗到点收场、整轮读数全部落空 —— 而且失败信息指向应用。
#
# 调用点写成 `keep_awake "$@"`（顶层调用），函数里的 `$@` 才是脚本的参数。
# 已经拉起来过就不再来一遍：`exec` 换掉的是当前进程，再进一次就是无限递归。
keep_awake() {
    [ -n "${VAULT_KEEP_AWAKE:-}" ] && return 0
    command -v caffeinate >/dev/null 2>&1 || return 0

    echo "整轮期间禁止显示器休眠（caffeinate -dims）"
    # 不用 `-u`：那会伪造用户活动，而应用的无操作计时**不该**被它影响 ——
    # 验收里有一条断言等的正是「真实的无操作到点」。
    VAULT_KEEP_AWAKE=1 exec caffeinate -dims "$0" "$@"
}

# 屏幕不可用时打印能直接照做的提示并返回 1；可用时返回 0。
require_screen_usable() {
    if ! screen_is_locked; then
        return 0
    fi

    cat <<'EOF'

屏幕已锁定 —— 这一步跑不了。

  锁屏（或显示器休眠）后 macOS 会把 WebView 的页面进程挂起：JS 与计时器一起停摆，
  CPU 归零，应用里的 Argon2 永远算不完。脚本不会报错，只会一直等下去。

  请先解锁屏幕（保持解锁状态），再重跑同一条命令。

EOF
    return 1
}
