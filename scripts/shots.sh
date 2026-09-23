#!/usr/bin/env bash
#
# 界面截图验收。
#
# 每个视图起一次应用、截一次图、退出。视图由开发标记选择（见 src-tauri/src/main.rs
# 的 dev_flags）。
#
# 用法：
#   ./scripts/shots.sh                 # 截全部 7 张
#   WAIT=8 ./scripts/shots.sh          # 机器慢时多等一会
#   ./scripts/shots.sh 03-vault        # 只截某一张
#
# 前置：npm run app:build
#
# M2 起界面跑在真实 kdbx 上，所以这里要先备一个库。库落在 /Users/Shared 下（见下），
# 不碰正式位置；首次运行会建库并灌入演示数据，之后复用。
#
# 截图需要「屏幕录制」权限，且需要 pyobjc（pip install pyobjc-framework-Quartz）。
# 脚本会自动挑一个装了 Quartz 的解释器。

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

BIN="src-tauri/target/release/dreamanual-vault"
OUT_DIR="spike/out/shots"
WAIT="${WAIT:-5}"
LOG_DIR="${TMPDIR:-/tmp}"

# 演示库刻意**不放**在仓库里，也不放在任何家目录下。
#
# 截图会发到官网作品页（works/vault.html），而界面多处要显示库文件路径 ——
# 库落在 `$HERE/.dev-home/` 时，设置页「主库位置」那一行会把
# `/Users/<用户名>/Downloads/…` 连同用户名一起印到公开页面上。
#
# 于是把它放到 /Users/Shared 下：路径中性、不含用户名，读起来也像一个演示安装。
# 与验收脚本各用各的库（那边仍是仓库内的 .dev-home/），互不干扰。
DEV_HOME="/Users/Shared/Dreamanual 密码管理"
PW="${VAULT_DEV_PASSWORD:-correct horse battery staple 上海}"

# 锁屏时 WebView 的页面进程会被系统挂起，应用起得来但永远到不了可截图的形态。
# 与其等满 30 秒窗口预算再报「没找到窗口」，不如在这里一句话说清。
. "$HERE/scripts/preflight-screen.sh"
require_screen_usable || exit 1

# 视图名@开发标记@库状态
#   ready     用 $DEV_HOME 里已有的库
#   empty     指向一次性空目录，让应用停在建库卡片
#   external  一次性目录 + 一份 config.json 指向 $DEV_HOME 的库，
#             用来截「库不在默认位置」时的形态。它与 ready 的差别只有一处：
#             设置页「主库位置」那一行的按钮文案（打开其他库… → 更改位置…）。
#             所以只有滚到「数据」那一组的视图配得上这个状态 —— 不滚的视图
#             截出来与 ready 逐字节相同，等于什么都没验。
#
# 解锁页只有一张（01）。它不按库的来处分叉：卡片上那一行显示的是**路径与大小**，
# 不显示库名（KDBX 4.0 把 Meta 段一起加密，库没打开时读不到），所以「默认位置的库」
# 与「别处的库」在解锁页上是同一个界面，分两张出来只会得到两张一样的图。
#
# `settings:data` 会把设置面板滚到「数据」那一组 —— 面板比窗口高，
# 库文件位置与导出在下面，不滚就截不到。滚到底的那一屏同时装着「数据」与「关于」。
#
# `editor` 打开第一条目的编辑弹窗。改动落在弹窗里的时候主视图截图看不见它。
#
# 分隔符用 @ 而不是冒号：开发标记自己带冒号（settings:data），
# 用冒号分段会把它切开，结果是「滚到数据那一组」静默失效。
VIEWS=(
    "01-lock@@ready"
    "02-lock-create@@empty"
    "03-vault@unlocked,seed@ready"
    "04-settings@unlocked,settings,seed@ready"
    "05-settings-data@unlocked,settings:data@ready"
    "06-settings-data-external@unlocked,settings:data@external"
    "07-editor@unlocked,seed,editor@ready"
)

# 曾经试过再加一张 `08-settings-about`（滚到「关于」那一组）。它截出来与 05
# **逐字节相同** —— 设置面板的内容高度只比窗口高一点点，两组滚到底停在同一个
# 位置，那一屏本来就同时装着「数据」与「关于」。收尾那道重复门禁当场报了出来。
# 判据与当初删掉「解锁页按库的来处分两张」时一致：没有信息增量的视图不留。

if [ ! -x "$BIN" ]; then
    echo "找不到 ${BIN}"
    echo "先构建：npm run app:build"
    exit 1
fi

PYTHON=""
for p in "${PYTHON:-}" "$HOME/.workbuddy/binaries/python/envs/default/bin/python" python3; do
    [ -n "$p" ] || continue
    command -v "$p" >/dev/null 2>&1 || continue
    if "$p" -c "import Quartz" 2>/dev/null; then
        PYTHON="$p"
        break
    fi
done

if [ -z "$PYTHON" ]; then
    echo "没找到带 pyobjc Quartz 的 Python。装一个："
    echo "  python3 -m venv ~/.workbuddy/binaries/python/envs/default"
    echo "  ~/.workbuddy/binaries/python/envs/default/bin/pip install pyobjc-framework-Quartz"
    exit 1
fi

# ------------------------------------------------------------------ 备库

mkdir -p "$DEV_HOME"

# 窗口几何（PRD §7.2）会落进 $DEV_HOME/config.json，而截图脚本是**复用**这个目录的：
# 上一轮人工跑应用、并正常退出过一次，这里就会多出一个 `window` 项 —— 于是这 7 张图
# 会静默地按那个尺寸拍，而建库卡片的可用高度是算着 720 来的（附录 H4）。
# 清掉这一项，让每轮截图都从配置里的 1080×720 开始。
if [ -f "$DEV_HOME/config.json" ]; then
    "$PYTHON" - "$DEV_HOME/config.json" <<'PY'
import json, sys

path = sys.argv[1]
with open(path, encoding='utf-8') as fh:
    cfg = json.load(fh)
if cfg.pop('window', None) is not None:
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump(cfg, fh, ensure_ascii=False, indent=2)
    print('  清掉了上一轮留下的窗口几何，按配置里的默认尺寸拍')
PY
fi

if [ ! -f "$DEV_HOME/vault.kdbx" ]; then
    echo "首次运行：在 $DEV_HOME 建库并灌入演示数据…"
    env VAULT_HOME="$DEV_HOME" VAULT_DEV=unlocked,seed VAULT_DEV_PASSWORD="$PW" VAULT_PERF_EXIT=1 \
        "$BIN" >"${LOG_DIR}/shot-prepare.log" 2>&1
    if [ -f "$DEV_HOME/vault.kdbx" ]; then
        echo "  已建库：$(wc -c <"$DEV_HOME/vault.kdbx" | tr -d ' ') 字节"
    else
        echo "  建库失败，看 ${LOG_DIR}/shot-prepare.log"
        exit 1
    fi
fi

# ------------------------------------------------------------------ 截图

mkdir -p "$OUT_DIR"

only="${1:-}"
taken=0
failed=0

for entry in "${VIEWS[@]}"; do
    name="${entry%%@*}"
    rest="${entry#*@}"
    flags="${rest%%@*}"
    state="${rest#*@}"

    if [ -n "$only" ] && [ "$only" != "$name" ]; then
        continue
    fi

    log="${LOG_DIR}/shot-${name}.log"
    pidfile="${LOG_DIR}/shot-${name}.pid"

    # 空库态用一次性目录，截完就删 —— 不能污染下面几张要用的库。
    # 落点写死 `/tmp` 而不是 `$LOG_DIR`：`$TMPDIR` 展开成
    # `/var/folders/fh/…/T/`，它会出现在建库卡的「保存位置」那一行，
    # 一张公开截图顶着两行乱码路径没有意义。
    if [ "$state" = "empty" ]; then
        home="/tmp/vault-shot-empty"
        rm -rf "$home"
        mkdir -p "$home"
    elif [ "$state" = "external" ]; then
        # 「打开其他库」之后的形态：配置里记着别处的路径。
        # 直接写 config.json 而不是在界面上点菜单 —— 后者要人工操作，
        # 且会真的改动 $DEV_HOME 的配置，影响后面几张截图。
        home="/tmp/vault-shot-external"
        rm -rf "$home"
        mkdir -p "$home"
        printf '{"autoLockMinutes":5,"clipboardClearSeconds":30,"kdfPreset":"均衡","backupDir":null,"backupAuto":true,"keepVersions":10,"lockOnSleep":true,"lastOpenedVault":"%s","lastBackupAt":null,"lastBackupError":null}' \
            "${DEV_HOME}/vault.kdbx" >"${home}/config.json"
    else
        home="$DEV_HOME"
    fi

    # 变量展开一律写 ${var}：bash 3.2 在 $var 紧跟中文字符时会把中文首字节吞进变量名
    if [ -n "$flags" ]; then
        ( env VAULT_HOME="$home" VAULT_DEV_PASSWORD="$PW" VAULT_DEV="$flags" \
            "$BIN" >"$log" 2>&1 & echo $! >"$pidfile" )
    else
        ( env VAULT_HOME="$home" VAULT_DEV_PASSWORD="$PW" \
            "$BIN" >"$log" 2>&1 & echo $! >"$pidfile" )
    fi

    sleep "$WAIT"

    pid="$(cat "$pidfile" 2>/dev/null || true)"

    # 先看页面有没有加载起来。文件存在、尺寸正确、退出码 0，都不等于拍到了界面：
    # 内嵌的前端资源坏掉时窗口是全白，`screencapture` 照样成功返回，废图会被当成
    # 验收产物存下来 —— M2 收尾撞过一次，之后又撞过一次（那次连验收脚本也静默挂了）。
    # 应用自己会在页面加载完成时打一行日志，拿它当判据最直接。
    if ! grep -q '页面加载事件: Finished' "$log" 2>/dev/null; then
        failed=$((failed + 1))
        echo "  [失败] ${name}：页面没有加载成功，窗口是全白的"
        sed 's/^/      /' "$log" 2>/dev/null | tail -6
        echo "      多半是二进制内嵌的前端资源坏了，重建一次：npm run app:build"
        [ -n "$pid" ] && kill "$pid" 2>/dev/null
        wait "$pid" 2>/dev/null
        sleep 1
        continue
    fi

    # 抓图一律带 PID，不靠归属名。按名字匹配是子串匹配：产品名改过名之后，
    # 淘汰的旧 .app 仍在 /Applications 里，它的 owner 同样含「密码管理」，
    # 谁在前景就截到谁 —— 这一轮就这么静默拍出过一整张旧界面。
    # 万一拿不到 PID（写 pid 文件失败），退回按名字，至少还能出图。
    shot_args=("$OUT_DIR/${name}.png")
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        shot_args+=(--pid "$pid")
    else
        shot_args+=(dreamanual-vault 密码管理)
    fi

    if "$PYTHON" scripts/window-shot.py "${shot_args[@]}"; then
        taken=$((taken + 1))
    else
        failed=$((failed + 1))
        echo "  [失败] ${name}：应用起来了但没找到窗口"
        echo "      该视图的启动日志：${log}"
        echo "      二进制刚重新链接过时首次启动会慢，先单张重试："
        echo "        ./scripts/shots.sh ${name}"
    fi

    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    sleep 1
done

# 逐字节相同的两张图 = 其中一张什么都没验，但它看上去和别的图一样「有产出」。
# 新加一个视图最省事的做法是复制一行改个名字，而复制出来的那张常常与原地一模一样 ——
# 06 与 04 就是这么来的（设置页不滚到底看不到「数据」那几行，而两处差异恰好在里面），
# 它一直以「验证了换库形态」的名义躺在目录里，直到有人去比哈希才发现。
#
# 这条判据的边界要说清：它只拦得住**页面是静态的**那种重复。解锁页有光标闪烁，
# 同一个界面截两次哈希也不同（01 与当初那张 05 就是这么逃过去的），
# 那种只能靠人看图上的东西有没有差别。宁可判得窄，也不要判出误报。
if [ "$taken" -gt 0 ]; then
    dup_hash="$(shasum -a 256 "$OUT_DIR"/*.png | awk '{print $1}' | sort | uniq -d | head -1)"
    if [ -n "$dup_hash" ]; then
        failed=$((failed + 1))
        echo "  [失败] 有图与别的图逐字节相同 —— 它没有验证任何东西："
        shasum -a 256 "$OUT_DIR"/*.png | awk -v h="$dup_hash" '$1 == h {printf "      %s\n", $2}'
    fi
fi

echo
echo "截图完成：成功 ${taken}，失败 ${failed}，输出目录 ${OUT_DIR}/"
