#!/usr/bin/env bash
#
# 把 bundle 好的 .app 打成带背景图与图标位置的 DMG。
#
# 方案与投资监控的 build_dmg.sh 一致：appdmg 0.6.6（经 npx 调用），它依赖的
# ds-store 包直接写 .DS_Store，不走 Finder AppleScript，不需要任何系统授权。
# .app 必须先 bundle 好（npm run app:bundle）——本脚本不编译、不签名。
#
# 用法：
#   npm run app:bundle && npm run dmg
#   ./scripts/build-dmg.sh            # 正常打包
#   ./scripts/build-dmg.sh --raw      # 跳过 appdmg，直接 hdiutil（无背景图）
#
# appdmg 报 ERR_DLOPEN_FAILED / NODE_MODULE_VERSION 不匹配时：
#   npx 缓存里的原生模块 macos-alias 是按别的 node 版本编译的。
#   清缓存重装：mv ~/.npm/_npx/<hash> ~/.Trash/ （或删掉整个 ~/.npm/_npx）
#
# appdmg 失败或找不到 node 时自动降级为原生 hdiutil：内容一致，
# 窗口为默认布局、无背景图与图标位置。

set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT"

APP_DIR="src-tauri/target/release/bundle/macos"
APP_NAME="Dreamanual 密码管理.app"
APP_PATH="$APP_DIR/$APP_NAME"
VOL_NAME="Dreamanual 密码管理"
DMG_DIR="src-tauri/target/release/bundle/dmg"
DMG_OUT="$DMG_DIR/Dreamanual 密码管理.dmg"
CONFIG="assets/dmg/dmg_config.json"

RAW=0
for arg in "$@"; do
    case "$arg" in
        --raw) RAW=1 ;;
        *) echo "未知参数: $arg"; exit 2 ;;
    esac
done

if [ ! -d "$APP_PATH" ]; then
    echo "找不到构建产物：$APP_PATH"
    echo "先构建：npm run app:bundle（或 npm run app:release 前半段）"
    exit 1
fi

# 定位 node：优先系统 node，其次 WorkBuddy 托管运行时（取最高版本）。
# 不假设用户终端 PATH 里有 node。
find_node() {
    local c best
    for c in "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node; do
        if [ -n "$c" ] && [ -x "$c" ]; then echo "$c"; return 0; fi
    done
    best="$(ls -d "$HOME"/.workbuddy/binaries/node/versions/*/bin/node 2>/dev/null | sort -V | tail -1)"
    if [ -n "$best" ] && [ -x "$best" ]; then echo "$best"; return 0; fi
    return 1
}

# 降级方案：原生 hdiutil（内容一致，默认窗口布局、无背景图）。
# 不在这里再用 osascript 补布局 —— 那条路要 Finder 自动化授权，会把
# 「必定成功」的兜底变回「可能被权限拒」。
dmg_via_hdiutil() {
    local work stage tmp mnt
    work="$(mktemp -d)"
    stage="$work/stage"
    mkdir -p "$stage"
    cp -R "$APP_PATH" "$stage/"
    cp "assets/dmg/安装说明.txt" "$stage/"
    ln -s /Applications "$stage/Applications"
    tmp="$work/tmp.dmg"
    hdiutil create -volname "$VOL_NAME" -srcfolder "$stage" -ov -format UDRW -fs HFS+ "$tmp" >/dev/null
    mnt="$(hdiutil attach "$tmp" -readwrite -noverify -noautoopen | grep -o '/Volumes/.*' | head -1)"
    hdiutil detach "$mnt" >/dev/null 2>&1 || hdiutil detach "$mnt" -force >/dev/null 2>&1 || true
    hdiutil convert "$tmp" -format UDZO -imagekey zlib-level=9 -o "$DMG_OUT" >/dev/null
    rm -rf "$work"
}

mkdir -p "$DMG_DIR"
rm -f "$DMG_OUT"

DMG_OK=0
if [ "$RAW" -eq 1 ]; then
    echo "按 --raw 跳过 appdmg"
else
    NODE_BIN="$(find_node || true)"
    if [ -z "$NODE_BIN" ]; then
        echo "未找到 node，跳过 appdmg，改用原生 hdiutil 打包"
        echo "（想要带背景图的 DMG，请先安装 node 再重跑本脚本）"
    else
        echo "使用 node: $NODE_BIN ($("$NODE_BIN" -v 2>/dev/null))"
        if PATH="$(dirname "$NODE_BIN"):$PATH" npx --yes appdmg "$CONFIG" "$DMG_OUT"; then
            DMG_OK=1
        else
            echo ""
            echo "appdmg 打包失败。最常见原因：npx 缓存里的原生模块与当前 node 版本不匹配。"
            echo "  修复: mv ~/.npm/_npx/<hash> ~/.Trash/ 之后重跑本脚本"
            echo "现改用原生 hdiutil 降级打包。"
        fi
    fi
fi

if [ "$DMG_OK" -eq 1 ]; then
    echo "DMG 打包完成（appdmg，含背景图与图标位置）"
else
    dmg_via_hdiutil
    echo "DMG 打包完成（降级模式：默认窗口布局，无背景图）"
fi

ls -lh "$DMG_OUT"
