#!/usr/bin/env bash
#
# 把构建产物装进 /Applications，源目录不留 .app。
#
# 为什么要有这一条：
#   Tauri 的 .app 固定在 src-tauri/target/release/bundle/macos/。那是个结构完整
#   的应用包，会被 LaunchServices 注册、被 Spotlight 索引 —— 于是启动台里同名
#   应用出现两份（下面那行小字写着 "macos" 的就是它）。构建完顺手挪走，
#   开发目录只留 bundle/dmg/ 里的 DMG。
#
# 用法：
#   npm run app:install                       # 装 app，源移入废纸篓
#   ./scripts/install-app.sh --keep-source    # 保留源（接下来还要拿它打 DMG）
#
# 可覆盖的环境变量（给测试用，正常跑不用管）：
#   SRC_DIR    默认 src-tauri/target/release/bundle/macos
#   DEST_DIR   默认 /Applications
#   TRASH_DIR  默认 $HOME/.Trash

set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT"

SRC_DIR="${SRC_DIR:-$ROOT/src-tauri/target/release/bundle/macos}"
DEST_DIR="${DEST_DIR:-/Applications}"
TRASH_DIR="${TRASH_DIR:-$HOME/.Trash}"

LSR=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

KEEP_SOURCE=0
for arg in "$@"; do
    case "$arg" in
        --keep-source) KEEP_SOURCE=1 ;;
        *) echo "未知参数: $arg"; exit 2 ;;
    esac
done

plist_read() { /usr/libexec/PlistBuddy -c "Print :$2" "$1/Contents/Info.plist" 2>/dev/null; }

# 废纸篓里重名就往后加序号。mv 到已存在的目录不会覆盖，而是把包塞进那个目录里，
# 静默发生、事后只看到一个目录。
trash_path() {
    local p="$1" n=0
    while [ -e "$p" ]; do n=$((n + 1)); p="$1.$n"; done
    printf '%s' "$p"
}

# ---- 1. 找产物 ----------------------------------------------------------
if [ ! -d "$SRC_DIR" ]; then
    echo "找不到构建目录：$SRC_DIR"
    echo "先构建：npm run app:bundle"
    exit 1
fi

shopt -s nullglob
APPS=("$SRC_DIR"/*.app)
shopt -u nullglob

if [ "${#APPS[@]}" -eq 0 ]; then
    echo "构建目录里没有 .app：$SRC_DIR"
    echo "先构建：npm run app:bundle"
    exit 1
fi

if [ "${#APPS[@]}" -gt 1 ]; then
    echo "构建目录里有 ${#APPS[@]} 个 .app，不确定装哪个，先手工清理："
    printf '  %s\n' "${APPS[@]}"
    exit 1
fi

SRC_APP="${APPS[0]}"
NAME="$(basename "$SRC_APP")"
VERSION="$(plist_read "$SRC_APP" CFBundleShortVersionString)"
BIN="$(plist_read "$SRC_APP" CFBundleExecutable)"
STAMP="$(date +%Y%m%d-%H%M%S)"

if [ -z "$VERSION" ] || [ -z "$BIN" ]; then
    echo "读不到 $NAME 的版本号或可执行文件名，包可能不完整"
    exit 1
fi

echo "准备安装：$NAME $VERSION"
echo "  来源：$SRC_APP"
echo "  目标：$DEST_DIR/$NAME"

mkdir -p "$DEST_DIR" "$TRASH_DIR"

# ---- 2. 旧包先进废纸篓 --------------------------------------------------
# 直接覆盖的话，中途失败就两个都没有了。先进废纸篓，装坏了还能捞回来。
OLD_TRASHED=""
if [ -e "$DEST_DIR/$NAME" ]; then
    OLD_VER="$(plist_read "$DEST_DIR/$NAME" CFBundleShortVersionString)"
    OLD_TRASHED="$(trash_path "$TRASH_DIR/$NAME.replaced-$STAMP")"
    mv "$DEST_DIR/$NAME" "$OLD_TRASHED"
    echo "  旧包已移入废纸篓（版本 ${OLD_VER:-未知}）：$OLD_TRASHED"
fi

# ---- 3. 复制 ------------------------------------------------------------
# 用 ditto 而不是 cp -R：ditto 搬扩展属性与资源分支，是 Apple 给 .app 用的那一个。
if ! ditto "$SRC_APP" "$DEST_DIR/$NAME"; then
    echo "复制失败。"
    if [ -n "$OLD_TRASHED" ]; then
        echo "旧包还在废纸篓里，放回：mv \"$OLD_TRASHED\" \"$DEST_DIR/$NAME\""
    fi
    exit 1
fi

# ---- 4. 回读校验 --------------------------------------------------------
# 「装过去了」不等于「装的是那一份」。读版本号 + 比二进制哈希。
NEW_VER="$(plist_read "$DEST_DIR/$NAME" CFBundleShortVersionString)"
NEW_BIN="$(plist_read "$DEST_DIR/$NAME" CFBundleExecutable)"
src_hash="$(shasum -a 256 "$SRC_APP/Contents/MacOS/$BIN" 2>/dev/null | cut -d' ' -f1)"
dst_hash="$(shasum -a 256 "$DEST_DIR/$NAME/Contents/MacOS/${NEW_BIN:-$BIN}" 2>/dev/null | cut -d' ' -f1)"

if [ "$NEW_VER" != "$VERSION" ] || [ -z "$src_hash" ] || [ "$src_hash" != "$dst_hash" ]; then
    echo "校验失败：装过去的包与源对不上"
    echo "  源版本 $VERSION / 目标版本 ${NEW_VER:-读不到}"
    echo "  源哈希 ${src_hash:-读不到} / 目标哈希 ${dst_hash:-读不到}"
    echo "回滚：删掉装过去的那份，再把废纸篓里的放回"
    rm -rf "$DEST_DIR/$NAME"
    if [ -n "$OLD_TRASHED" ]; then
        echo "  mv \"$OLD_TRASHED\" \"$DEST_DIR/$NAME\""
    fi
    exit 1
fi

# 让系统认一下新位置（旧位置的注册已随包被移走而失效）
"$LSR" -f "$DEST_DIR/$NAME" 2>/dev/null || true

echo "已安装：$DEST_DIR/$NAME $NEW_VER"
echo "  二进制哈希：$dst_hash"

# ---- 5. 源目录不留 .app -------------------------------------------------
if [ "$KEEP_SOURCE" -eq 1 ]; then
    echo "  源保留（--keep-source）：$SRC_APP"
else
    # 后缀与旧包那份区分开：同一个 stamp 会让第二次 mv 落进已存在的目录里
    SRC_TRASHED="$(trash_path "$TRASH_DIR/$NAME.source-$STAMP")"
    if mv "$SRC_APP" "$SRC_TRASHED"; then
        echo "  源已移入废纸篓：$SRC_TRASHED"
        echo "  需要还原：mv \"$SRC_TRASHED\" \"$SRC_APP\""
    else
        echo "  源没挪走（不影响安装）：$SRC_APP"
    fi
fi
