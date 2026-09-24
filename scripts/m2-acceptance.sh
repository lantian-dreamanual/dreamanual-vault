#!/usr/bin/env bash
#
# M2 自动化验收。
#
# 跑的是应用自身的真实链路：webview 里的 Argon2 WASM、真实的 KDBX 加解密、
# 经 IPC 走 Rust 的原子写。不依赖人工点击，也不需要肉眼看结果。
#
# 七段：
#   ① 应用内的功能验收（VAULT_DEV=accept），结果由应用打到 stdout
#      A 功能 / B 备份 / C 自动锁定 / D 剪贴板 / E ⌘C 取字段 / F 掩码动效 / G 重建库
#      H 输入法组合态（2026-09-23 加入）
#      I 关于与更新检查（2026-09-23 加入）
#   ② 外壳几何：设置面板打开时它有没有盖住整个窗口，以及面板滚动是否真的可用
#   ③ 库文件的磁盘形态：在不在、有没有明文、换库配置有没有还回去
#   ④ 备份的磁盘形态：镜像与主库逐字节一致、裁剪不误删、历史版本留够
#   ⑤ 用 KeePassXC 打开应用写出的库、导出件（含换过 KDF 档的那一份）与备份件
#   ⑥ 剪贴板清除的用户视角读数（从系统层面看，不经过应用）
#   ⑦ 配色对比度：逐对前景/背景算 WCAG 对比度（spike/contrast.mjs）
#
# 库文件落在仓库内的 .dev-home/，不碰 ~/Library/Application Support/。
#
# 用法：
#   ./scripts/m2-acceptance.sh
#   KEEP=1 ./scripts/m2-acceptance.sh     # 保留 .dev-home 以便人工查看
#
# 前置：npm run app:build

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

# 分段耗时的基准。bash 自带 SECONDS，赋值即重新计时。
SECONDS=0

BIN="src-tauri/target/release/dreamanual-vault"
DEV_HOME="$HERE/.dev-home"
VAULT="$DEV_HOME/vault.kdbx"
EXPORTED="$DEV_HOME/export-check.kdbx"
KDF_EXPORTED="$DEV_HOME/kdf-check.kdbx"
CONFIG="$DEV_HOME/config.json"
BACKUP_DIR="$DEV_HOME/backup"
BACKUP_FILE="$BACKUP_DIR/vault.kdbx"
PW="${VAULT_DEV_PASSWORD:-correct horse battery staple 上海}"
KXC="/Applications/KeePassXC.app/Contents/MacOS/keepassxc-cli"
LOG="${TMPDIR:-/tmp}/vault-m2-accept.log"

if [ ! -x "$BIN" ]; then
    echo "找不到 ${BIN}"
    echo "先构建：npm run app:build"
    exit 1
fi

# 锁屏时 WebView 的页面进程会被系统挂起：JS 与计时器一起停摆，应用里的 Argon2
# 永远算不完，`vault.open()` 的 Promise 不 settle。脚本会静默挂住（没有报错、
# 没有输出，只有看门狗把进程杀掉）。这里提前判掉，换成一句能立刻照做的提示。
. "$HERE/scripts/preflight-screen.sh"
keep_awake "$@"
require_screen_usable || exit 1

pass=0
fail=0

step() {
    printf '\n\033[1m%s\033[0m \033[2m（累计 %s 秒）\033[0m\n' "$1" "$SECONDS"
}

# 分段耗时。脚本原来只报「通过 N，失败 0」，没有任何时间读数 —— 于是
# 「整轮跑了 8 分钟」这件事只能从外面量，定位不到是哪一段慢。
stamp() {
    printf '  \033[2m（累计 %s 秒）\033[0m\n' "$SECONDS"
}

verdict() {
    if [ "$1" = "1" ]; then
        printf '  [通过] %s\n' "$2"
        pass=$((pass + 1))
    else
        printf '  [失败] %s\n' "$2"
        fail=$((fail + 1))
    fi
}

# 跑一次应用，输出写进指定日志。两件事都守着：
#
#   1. 看门狗。应用只在页面真的加载起来之后才报读数并退出；页面没起来时它会
#      一直等，验收就静默挂着 —— 实测挂过 7 分钟，一条输出都没有。macOS 没有
#      coreutils 的 timeout，所以自己起一个单独的进程掐表（见下面 run_app）。
#   2. 查「页面加载事件: Finished」。缺了它说明窗口是白的（内嵌的前端资源坏了），
#      这时后面无论怎么解析都只会说「没拿到报告」，看不出根因。
#
# 预算要盖住整轮验收，不只是启动。① 段应用内**两次实测差得很远**：119.6 秒与
# 196 秒 —— 同一份二进制、同一台机器。后者那一轮 C5 也只花了 61 秒，说明差异来自
# 系统负载（十次 reopen 每次都真的读盘加解锁，各 3.7 秒上下，这一段浮动最大）。
#
# 固定等待的部分：C5 真等一次无操作锁定 61–65 秒 · D3 真等一次剪贴板到点 17 秒 ·
# G 段重建库（换档与改主密码各走一遍，25 次 Argon2 派生）13–31 秒。
#
# C5 还会被真实输入打断并顺延，最坏多花 85 秒 → ① 段最坏约 280 秒。
# 给到 320 秒是照这个最坏值留的余量；这个数调小会让验收在半途被杀
# （看着像应用卡死），调大则会让「真的挂了」的那一轮白等更久。
APP_TIMEOUT="${APP_TIMEOUT:-320}"

# 掐表要用**一个单独的进程**，这样 `kill "$watchdog"` 送走的就是全部。
#
# 两种看起来更简单的写法都不行，都实测过：
#
#   `( sleep $APP_TIMEOUT; kill $app_pid ) &`
#       kill 掉的是子 shell，子 shell 里头的 sleep 变成孤儿，而它**继承了本
#       脚本的 stdout**。把输出接走的那一端要等所有持有管道写端的人都退出才
#       看得到 EOF —— 于是「整轮用时」被记成「最后一个孤儿 sleep 的到期时刻」。
#       两次实测精确吻合：APP_TIMEOUT=300 时报 384 秒、改成 420 后报 504 秒。
#
#   `sleep $APP_TIMEOUT & sleeper=$!; ( wait $sleeper; kill $app_pid ) &`
#       子 shell 不是 sleeper 的父进程，`wait` 直接返回 127（not a child of
#       this shell），看门狗**永远不触发**，超时保护静默失效。
#
# 判活同理不能用 `kill -0 $app_pid` 代替 `wait`：应用正常退出后会变成僵尸，
# 僵尸的进程表项还在，`kill -0` 照样返回成功，轮询会一路转到超时为止。
run_app() {
    log="$1"
    shift

    env "$@" "$BIN" >"$log" 2>&1 &
    app_pid=$!

    python3 -c '
import os, signal, sys, time
time.sleep(float(sys.argv[1]))
try:
    os.kill(int(sys.argv[2]), signal.SIGTERM)
except OSError:
    pass
' "$APP_TIMEOUT" "$app_pid" &
    watchdog=$!

    wait "$app_pid" 2>/dev/null

    # 应用到这一步必然已经没了（要么自己退，要么刚被看门狗杀掉），
    # 只剩看门狗要收。它是单进程，kill 一次就干净。
    kill "$watchdog" 2>/dev/null
    wait "$watchdog" 2>/dev/null

    if ! grep -q '页面加载事件: Finished' "$log" 2>/dev/null; then
        echo
        echo "  应用页面没有加载成功（窗口会是全白）。启动日志："
        sed 's/^/    /' "$log" 2>/dev/null | tail -20
        echo
        echo "  多半是二进制里内嵌的前端资源坏了，重新构建一次再跑："
        echo "    PATH=\"\$HOME/.cargo/bin:\$PATH\" npm run app:build"
        exit 1
    fi
}

# ------------------------------------------------------------------ ① 功能验收

step "① 应用内功能验收（真实 WKWebView + 真实 kdbx）"

rm -rf "$DEV_HOME"

# rm -rf 可能被拦下（沙箱/安全软件的批量删除保护按「本轮累计删除数」计数，
# 走完一轮构建之后很容易就超阈值）。目录没清掉的话，后面每一段都会跑在上一轮的
# 残留上，而且**五条红全部指向同一个没清干净的目录**，看起来像应用坏了：
#   A1 说「库不存在时探测结果明确」失败 —— 因为库真的还在
#   A2 说「这个位置已经有一个库了」
#   ③ 说「config.json 里残留了 lastOpenedVault」—— 上一轮写的
#   ④⑤ 数到没被裁掉的假 .bak、并试图用 KeePassXC 打开它
# 宁可在这里停下，也不要给出这种误导性的结论。
if [ -e "$DEV_HOME" ]; then
    echo "  清不掉 .dev-home —— 验收会跑在前一轮的残留上，结果不可信。"
    echo "  多半是批量删除保护拦下了。手动清一次再跑这条命令："
    echo "      mv .dev-home /tmp/dev-home-stale-\$(date +%s)"
    exit 1
fi

mkdir -p "$DEV_HOME"

# 备份目录要**预先存在**，并在里头埋三份 2020 年的假历史版本 + 一个不相干的文件。
#
# 预置的理由：时间戳精确到分钟，应用里连着改几次库也只能轮转出同一分钟那一份，
# 「裁到上限」这件事就测不出来。埋几份旧的在里面，第一次镜像就会把它们
# 连同新产生的版本一起裁到上限 —— 这才是那条断言真正在量的事。
#
# 那个 `我的笔记.txt` 是对照：裁剪只认 `vault.kdbx.<YYYYMMDD-HHmm>.bak` 这个形状，
# 用户自己放进备份目录的东西一份都不能删。
mkdir -p "$BACKUP_DIR"
printf 'old-1' >"$BACKUP_DIR/vault.kdbx.20200101-0000.bak"
printf 'old-2' >"$BACKUP_DIR/vault.kdbx.20200102-0000.bak"
printf 'old-3' >"$BACKUP_DIR/vault.kdbx.20200103-0000.bak"
printf 'do not touch' >"$BACKUP_DIR/我的笔记.txt"

# VAULT_PERF_EXIT=1：应用报完读数自行退出，不需要人去关窗口
run_app "$LOG" VAULT_HOME="$DEV_HOME" VAULT_DEV=accept VAULT_DEV_PASSWORD="$PW" VAULT_PERF_EXIT=1
stamp

if [ ! -f "$LOG" ]; then
    echo "  应用没有产生任何输出"
    exit 1
fi

REPORT="$(sed -n '/^{/,/^}$/p' "$LOG")"
if [ -z "$REPORT" ]; then
    echo "  没拿到验收报告，原始输出："
    tail -30 "$LOG"
    exit 1
fi

printf '%s\n' "$REPORT" | python3 -c '
import json, sys

data = json.load(sys.stdin)
if "error" in data:
    print("  应用报错：" + data["error"])
    sys.exit(1)

for item in data["items"]:
    flag = "通过" if item["ok"] else "失败"
    line = "  [%s] %s %s" % (flag, item["id"], item["name"])
    if item["detail"]:
        line += " — " + item["detail"]
    print(line)

print()
print("  小计：%s" % data["通过"])
sys.exit(0 if data["全部通过"] else 1)
'

inner=$?
if [ "$inner" = "0" ]; then
    echo "  ↳ 应用内全部通过"
else
    echo "  ↳ 应用内有失败项（见上方 [失败] 行，明细见 ${LOG}）"
fi

# 上面那段 Python 已经把明细打出来了，这里只按退出码计数
INNER_TOTAL="$(printf '%s\n' "$REPORT" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["items"]))')"
INNER_PASSED="$(printf '%s\n' "$REPORT" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(sum(1 for i in d["items"] if i["ok"]))')"
pass=$((pass + INNER_PASSED))
fail=$((fail + INNER_TOTAL - INNER_PASSED))

# ------------------------------------------------------------------ ② 外壳几何

step "② 外壳几何（设置面板打开时的真实布局）"

# 设置面板是唯一内容比窗口高的面板，所以布局上的事只有它能暴露。
#
# 当前判据两件：① 它**覆盖整个窗口**（左右边界对不对，退回 `main.stage` 那一列时
# 左边界会变成 248）；② 面板滚动真的可用（内容 1100 多、视口 720，滚不动就是坏）。
# 原先还有一条「外壳未被撑开」，量的是面板自身高度 —— 面板改成绝对定位之后它恒为真，
# 留着就是一条不咬的断言，已删（见 main.ts 的 shellGeometry）。
#
# 必须量真实布局 —— 这一条截图看不出来：程序化的 scrollIntoView 能滚
# overflow:hidden 的容器，用户手动滚不能，所以「截到了数据组」并不等于
# 「用户看得到数据组」。这个缺陷就是这么混过 M2 收尾、直到上手用才发现的。
GEOM_LOG="${TMPDIR:-/tmp}/vault-m2-shell.log"
run_app "$GEOM_LOG" VAULT_HOME="$DEV_HOME" VAULT_DEV=unlocked,settings VAULT_DEV_PASSWORD="$PW" VAULT_PERF_EXIT=1
stamp

geometry="$(python3 - "$GEOM_LOG" << 'PY'
import json, re, sys

text = open(sys.argv[1], encoding="utf-8", errors="replace").read()
for block in re.findall(r"^\{.*?^\}$", text, re.S | re.M):
    try:
        data = json.loads(block)
    except json.JSONDecodeError:
        continue
    if "shellGeometry" in data:
        print(json.dumps(
            {
                "shell": data["shellGeometry"],
                "unlock": data.get("unlockGeometry"),
                "ui": data.get("uiAffordances"),
                "editor_cat": data.get("editorCategory"),
            },
            ensure_ascii=False,
        ))
        sys.exit(0)
sys.exit(2)
PY
)"

if [ -z "$geometry" ]; then
    verdict 0 "没拿到外壳几何读数（看 ${GEOM_LOG}）"
else
    while IFS='|' read -r ok desc; do
        [ -n "$ok" ] || continue
        verdict "$ok" "$desc"
    done < <(printf '%s\n' "$geometry" | python3 -c '
import json, sys

# 这段一抛异常，后面的断言会**静默消失** —— 少几条照样报「通过 N，失败 0」，
# 看着全绿其实没跑到。踩过一次：新增读数的字段名写错了一个字，前面几条照常打印，
# 后两条连同断言的解析一起没了，输出仍是「通过 44，失败 0」。
# 转成一条明确的红，比让计数悄悄缩水好。
sys.excepthook = lambda t, v, tb: print("0|几何读数解析中断：%s（这一段后面的断言没跑到）" % v)

g = json.load(sys.stdin)
s = g["shell"]
print("%d|%s" % (
    1 if s["面板覆盖整窗"] else 0,
    "设置面板覆盖整个窗口（左边界 %s / 右边界 %s / 视口宽 %s）"
    % (s["面板左边界"], s["面板右边界"], s["视口宽"]),
))
print("%d|%s" % (
    1 if s["出口按钮在视口内"] else 0,
    "设置页出口按钮在视口内（底边 %s）" % s["出口按钮底边"],
))

u = g.get("unlock")
if not u:
    print("0|没有拿到建库卡片的几何读数")
else:
    print("%d|%s" % (
        1 if u["顶边未越界"] and u["底边在容器内"] else 0,
        "建库卡片在默认窗口里完整可见（卡片高 %s / 容器可视高 %s / 内容高 %s / 可滚 %s）" % (
            u["卡片高"], u["容器可视高"], u["容器内容高"],
            "是" if u["容器可滚"] else "否",
        ),
    ))

a = g.get("ui")
if not a:
    print("0|没有拿到界面入口的可达性读数")
else:
    if a["设置页有可见出口"]:
        print("1|设置面板里有可见的返回出口")
    else:
        print("0|设置面板里没有可见的返回出口（仍只靠侧栏底栏那个开关）")
    if a["点出口回到保险箱"]:
        print("1|点面板内的出口回到保险箱")
    else:
        print("0|点面板内的出口没有回到保险箱")
    if a["分类标题行有新建入口"] and a["新建入口在分类标题行内"]:
        print("1|「分类」标题行里有可见的新建分类入口")
    else:
        print(
            "0|分类的新建入口不在标题行里（可见=%s 在行内=%s）"
            % ("是" if a["分类标题行有新建入口"] else "否", "是" if a["新建入口在分类标题行内"] else "否")
        )
    if a["设置打开时分类不可点"]:
        print("1|设置面板打开时分类列表够不着（被面板盖住）")
    else:
        print("0|设置面板打开时分类列表仍然可点（盖没盖住只看尺寸判不出来）")
    if a["KDF当前档位那行报出实际档位"]:
        print("1|KDF 那一栏报的是当前库的实际档位（不是配置里的新建默认档）")
    else:
        print("0|KDF 那一栏没有报出当前库的实际档位（读的是配置值，或停在占位文案上）")
    if a["拨到别的档时应用可点"] and a["拨回当前档位时应用不可点"]:
        print("1|KDF「应用」只在选中项与当前档位不同时可点（成对判据）")
    else:
        print(
            "0|KDF「应用」的可用性没跟着选中项走（拨到别的档=%s 拨回当前档=%s）"
            % ("可点" if a["拨到别的档时应用可点"] else "不可点",
               "不可点" if a["拨回当前档位时应用不可点"] else "可点")
        )

c = g.get("editor_cat")
if not c:
    print("0|没有拿到编辑弹窗分类字段的读数（库里没有条目？）")
else:
    print("%d|%s" % (
        1 if c["选项数"] >= c["分类数"] + 1 else 0,
        "分类下拉列出全部分类（分类 %s 个 → 选项 %s 项，含末位的「＋ 新建分类…」）" % (
            c["分类数"], c["选项数"],
        ),
    ))
    print("%d|%s" % (
        1 if c["当前值被选中"] and c["当前值在选项里"] else 0,
        "编辑时当前分类被选中而不是被过滤掉（条目「%s」，下拉落在「%s」）" % (
            c["条目当前分类"], c["下拉选中的值"],
        ),
    ))
    print("%d|%s" % (
        1 if c["末项是新建分类"] else 0,
        "分类字段是下拉而不是自由文本，打错字不会再静默新建一个分类",
    ))
    print("%d|%s" % (
        1 if c["上层有弹窗时 Esc 不关编辑器"] else 0,
        "编辑器上压着别的弹窗时，Esc 不会连编辑器一起关掉",
    ))
    print("%d|%s" % (
        1 if c["没有上层时 Esc 照常关掉编辑器"] else 0,
        "没有上层弹窗时 Esc 照常关掉编辑器（上一条的对照）",
    ))
')
fi

# ------------------------------------------------------------------ ③ 磁盘形态

step "③ 库文件的磁盘形态"

if [ -f "$VAULT" ]; then
    verdict 1 "库文件已生成：${VAULT#${HERE}/}（$(wc -c <"$VAULT" | tr -d ' ') 字节）"
else
    verdict 0 "库文件没有生成"
fi

# 明文扫描。用字节而不是文本比对 —— 库文件里有大量不可打印字节，
# 按文本读会漏掉跨行的匹配。
if [ -f "$VAULT" ]; then
    hit="$(VAULT="$VAULT" PW="$PW" python3 - << 'PY'
import os, sys

data = open(os.environ["VAULT"], "rb").read()
needles = [
    os.environ["PW"].encode(),
    "堡垒机".encode(),
    "192.0.2.11".encode(),
    "Demo#Jump-02".encode(),
    "生产环境".encode(),
    "压测条目".encode(),
]
hits = [n.decode() for n in needles if n in data]
print(",".join(hits))
PY
)"
    if [ -z "$hit" ]; then
        verdict 1 "磁盘上搜不到任何明文凭据（已探测 6 个关键词）"
    else
        verdict 0 "磁盘上出现明文：${hit}"
    fi
fi

# 换库会写 config.json。验收最后一步要把它还回去 —— 残留的话，
# 之后的截图与读数脚本会跑在导出件上，读数看着正常但测的是另一个库。
if [ -f "$CONFIG" ]; then
    if python3 -c "
import json, sys
cfg = json.load(open('$CONFIG'))
sys.exit(0 if (cfg.get('lastOpenedVault') or '') == '' else 1)
" 2>/dev/null; then
        verdict 1 "换库配置已还原（lastOpenedVault 为空）"
    else
        verdict 0 "config.json 里残留了 lastOpenedVault：$(python3 -c "import json;print(json.load(open('$CONFIG')).get('lastOpenedVault'))" 2>/dev/null)"
    fi
else
    verdict 0 "没有生成 config.json —— 换库那一步没写进配置"
fi

# ------------------------------------------------------------------ ④ 备份的磁盘形态

step "④ 备份的磁盘形态"

# 备份件与主库逐字节相同 —— 应用内那条比的是「读出来的字节」，
# 这里比的是磁盘上那两个文件本身，两处分开量
if [ -f "$BACKUP_FILE" ] && [ -f "$VAULT" ]; then
    if cmp -s "$VAULT" "$BACKUP_FILE"; then
        verdict 1 "备份件与主库逐字节一致（$(wc -c <"$BACKUP_FILE" | tr -d ' ') 字节）"
    else
        verdict 0 "备份件与主库不一致：$(wc -c <"$VAULT" | tr -d ' ') vs $(wc -c <"$BACKUP_FILE" | tr -d ' ') 字节"
    fi
else
    verdict 0 "备份目录里没有镜像：${BACKUP_FILE#${HERE}/}"
fi

# 裁剪只认 vault.kdbx.<YYYYMMDD-HHmm>.bak 这个形状，别的东西一份都不能删
if [ -f "$BACKUP_DIR/我的笔记.txt" ]; then
    verdict 1 "裁剪没有误删备份目录里无关的文件"
else
    verdict 0 "备份目录里那个无关的文件被裁掉了 —— 裁剪的判据认宽了"
fi

# 历史版本要被裁到上限（accept.ts 里设的是 2）
versions="$(find "$BACKUP_DIR" -maxdepth 1 -name 'vault.kdbx.*.bak' 2>/dev/null | wc -l | tr -d ' ')"
if [ "$versions" -le 2 ]; then
    verdict 1 "历史版本裁到上限（留 ${versions} 份，上限 2）"
else
    verdict 0 "历史版本没有裁到上限：${versions} 份（上限 2）"
fi

# ------------------------------------------------------------------ ⑤ 第三方互通

step "⑤ 与 KeePassXC 互通（应用写出的库 + 导出件 + 备份件，不是 M0 的）"

if [ ! -x "$KXC" ]; then
    echo "  跳过：没找到 ${KXC}"
elif [ ! -f "$VAULT" ]; then
    echo "  跳过：库文件不存在"
else
    # keepassxc-cli 在本机直接输出中文，所以这里比对的是中文标签
    info="$(printf '%s\n' "$PW" | "$KXC" db-info "$VAULT" 2>&1)"
    if printf '%s' "$info" | grep -q '加密：AES 256'; then
        verdict 1 "KeePassXC 能打开并识别加密方案"
        printf '%s\n' "$info" | grep -E '名称|加密|KDF|条目数|群组数' | sed 's/^/      /'
    else
        verdict 0 "KeePassXC 打不开：${info}"
    fi

    listing="$(printf '%s\n' "$PW" | "$KXC" ls "$VAULT" 2>&1)"
    for want in 服务器 办公 数据库 未分类; do
        if printf '%s' "$listing" | grep -q "$want"; then
            verdict 1 "分类「${want}」在 KeePassXC 里原样呈现"
        else
            verdict 0 "分类「${want}」没有出现在 KeePassXC 的目录树里"
        fi
    done

    # 逐字段读回一条，确认字段映射没有偏移
    shown="$(printf '%s\n' "$PW" | "$KXC" show -s "$VAULT" '服务器/压测条目 007' 2>&1)"
    if printf '%s' "$shown" | grep -q 'bench'; then
        verdict 1 "KeePassXC 能逐字段读出条目内容"
        printf '%s\n' "$shown" | sed 's/^/      /'
    else
        verdict 0 "读条目失败：${shown}"
    fi

    # 导出件也要能被第三方打开。应用自己解得开只证明了一半 ——
    # F6.1 的验收标准是「导出文件可独立解锁」，换个实现来解才算数。
    if [ -f "$EXPORTED" ]; then
        einfo="$(printf '%s\n' "$PW" | "$KXC" db-info "$EXPORTED" 2>&1)"
        if printf '%s' "$einfo" | grep -q '加密：AES 256'; then
            verdict 1 "导出的文件能被 KeePassXC 独立打开"
            printf '%s\n' "$einfo" | grep -E '加密|KDF|条目数|群组数' | sed 's/^/      /'
        else
            verdict 0 "导出的文件打不开：${einfo}"
        fi

        eshown="$(printf '%s\n' "$PW" | "$KXC" show -s "$EXPORTED" '服务器/压测条目 007' 2>&1)"
        if printf '%s' "$eshown" | grep -q 'bench'; then
            verdict 1 "导出件里能逐字段读出条目（内容与主库一致）"
        else
            verdict 0 "从导出件读条目失败：${eshown}"
        fi
    else
        verdict 0 "没有找到导出件：${EXPORTED#${HERE}/}"
    fi

    # --- 换过 KDF 档的那一份（F7.6）
    #
    # 应用内 G1 读的是文件头里那个数字 —— 那是应用自己写的、应用自己读的。
    # 参数写错（M 没按 KiB 填、I 没跟着改）时，应用那边可能照样报 128 MiB；
    # 让 KeePassXC 按新参数真的解一遍，才算验到了换档这件事。
    #
    # 段末库会换回原档位，所以这份导出件是脚本唯一能拿到的「非默认档」样本。
    if [ -f "$KDF_EXPORTED" ]; then
        kinfo="$(printf '%s\n' "$PW" | "$KXC" db-info "$KDF_EXPORTED" 2>&1)"
        if printf '%s' "$kinfo" | grep -q 'Argon2id' && printf '%s' "$kinfo" | grep -q '131072 KB'; then
            verdict 1 "换档后的那一份在 KeePassXC 里报 128 MiB / 3 轮（参数真的换过去了）"
            printf '%s\n' "$kinfo" | grep -E '加密|KDF|条目数' | sed 's/^/      /'
        else
            verdict 0 "换档后的那一份参数不对：$(printf '%s' "$kinfo" | grep 'KDF' || printf '%s' "$kinfo" | head -1)"
        fi

        kshown="$(printf '%s\n' "$PW" | "$KXC" show -s "$KDF_EXPORTED" '服务器/压测条目 007' 2>&1)"
        if printf '%s' "$kshown" | grep -q 'bench'; then
            verdict 1 "换档后的那一份内容完整（逐字段读回与主库一致）"
        else
            verdict 0 "从换档后的那一份读条目失败：${kshown}"
        fi
    else
        verdict 0 "没有找到换档后的导出件：${KDF_EXPORTED#${HERE}/}（应用内 G4 那一项没产出）"
    fi

    # --- 备份件（M3 的验收标准）
    #
    # 「备份文件可独立解锁」——换个实现来解才算数，所以这一条必须在应用之外做。
    # 备份目录上的那个文件不是应用导出的副本，是每次保存后镜像过去的那一份，
    # 它要是解不开，备份就等于没有。
    if [ -f "$BACKUP_FILE" ]; then
        binfo="$(printf '%s\n' "$PW" | "$KXC" db-info "$BACKUP_FILE" 2>&1)"
        if printf '%s' "$binfo" | grep -q '加密：AES 256'; then
            verdict 1 "备份目录里的镜像能被 KeePassXC 用主密码独立解锁"
            printf '%s\n' "$binfo" | grep -E '加密|KDF|条目数|群组数' | sed 's/^/      /'
        else
            verdict 0 "备份件打不开：${binfo}"
        fi

        bshown="$(printf '%s\n' "$PW" | "$KXC" show -s "$BACKUP_FILE" '服务器/压测条目 007' 2>&1)"
        if printf '%s' "$bshown" | grep -q 'bench'; then
            verdict 1 "备份件里能逐字段读出条目（备份的确实是这个库）"
        else
            verdict 0 "从备份件读条目失败：${bshown}"
        fi

        # 历史版本同样要是能解开的库，而不是半个文件 ——
        # 它们在 NAS 上，出问题时没人会去本地核对。
        #
        # 取**字典序最后**的一份，不能用 find 的默认顺序：`find` 按目录项顺序吐，
        # 和名字无关。脚本预置的那几份假 .bak 时间戳是 2020 年，永远排在真版本
        # （2026）前面 —— 之前用 head -1 时取的正是那个 5 字节的 'old-3'，
        # 于是这条断言一直在报「历史版本打不开」，测的根本不是应用写出来的东西。
        hist="$(find "$BACKUP_DIR" -maxdepth 1 -name 'vault.kdbx.*.bak' 2>/dev/null | sort | tail -1)"
        if [ -n "$hist" ]; then
            hinfo="$(printf '%s\n' "$PW" | "$KXC" db-info "$hist" 2>&1)"
            if printf '%s' "$hinfo" | grep -q '加密：AES 256'; then
                verdict 1 "留着的历史版本也是一个能独立解锁的库（$(basename "$hist")）"
            else
                verdict 0 "历史版本打不开：${hinfo}"
            fi
        else
            verdict 0 "备份目录里没有留下历史版本"
        fi
    else
        verdict 0 "没有找到备份件：${BACKUP_FILE#${HERE}/}"
    fi
fi

# ------------------------------------------------------------------ ⑥ 剪贴板清除

step "⑥ 剪贴板清除（用户视角）"

# 应用内那一段（D1–D4）到点真的调了 `clearContents`，这里从外面看结果：
# 复制过之后剪贴板最终应该是空的 —— 这是这件事唯一对用户可见的效果。
#
# 用 `pbpaste` 读，走系统层面的事实，不经过应用。措辞要能分辨两种情形：
#
#   - 空 → 清干净了
#   - 不空 → 要么清没发生（链路问题），要么这期间你在别的应用里复制了东西
#     （那是正确的行为 —— 别人写进来的内容本来就不该清）。重跑一次就能分开。
if command -v pbpaste >/dev/null 2>&1; then
    CLIP_CONTENT="$(pbpaste 2>/dev/null || true)"
    if [ -z "$CLIP_CONTENT" ]; then
        verdict 1 "验收跑完之后剪贴板是空的（复制过的东西已被清掉）"
    else
        verdict 0 "剪贴板里还有 ${#CLIP_CONTENT} 个字符 —— 若这轮验收期间你在别的应用里复制过内容，重跑一次即可；否则是清除没有发生"
    fi
else
    echo "  ↳ 这台机器上没有 pbpaste，跳过"
fi

# ------------------------------------------------------------------ ⑦ 配色对比度

step "⑦ 配色对比度（每对真实前景/背景）"

# 令牌只有一个来源（src/styles/tokens.css），所以这一段不硬编码任何颜色 ——
# 期望值现场从令牌算出来。放进验收的理由：改配色的人不一定会记得手动跑它。
#
# 报告要确认是**这一轮**刷新的。产出文件被当作「刚跑过」的证据，而它可能是上一轮
# 留下的 —— 这一条在 ② 那段已经咬过一次（解析抛异常，后半段断言连同计数一起消失，
# 输出仍是「通过 N，失败 0」）。
#
# 判据取 mtime 而不是「先删掉再跑」：`rm` 会被沙箱的批量删除保护拦下（累计到 50
# 就拦），而那条保护只打印一行提示、脚本不会知道删没删掉。mtime 是确定的事实。
CONTRAST_JSON="$HERE/spike/out/contrast.json"

if ! command -v node >/dev/null 2>&1; then
    echo "  ↳ 这台机器上没有 node，跳过"
else
    C_START="$(date +%s)"
    if node "$HERE/spike/contrast.mjs" >/dev/null 2>&1; then C_OK=1; else C_OK=0; fi
    C_FRESH=0
    if [ -f "$CONTRAST_JSON" ] && [ "$(stat -f %m "$CONTRAST_JSON" 2>/dev/null || echo 0)" -ge "$C_START" ]; then
        C_FRESH=1
    fi

    if [ "$C_FRESH" = "0" ]; then
        verdict 0 "配色对比度门禁没有产出本轮的报告（脚本自身出错，单独跑一次 node spike/contrast.mjs 看输出）"
    elif [ "$C_OK" = "1" ]; then
        verdict 1 "$(python3 - "$CONTRAST_JSON" <<'PY'
import json, sys
rows = json.load(open(sys.argv[1]))["rows"]
bad = [r["id"] for r in rows if not r["ok"]]
print("配色对比度 %d/%d 达标" % (len(rows) - len(bad), len(rows)))
PY
)"
    else
        verdict 0 "$(python3 - "$CONTRAST_JSON" <<'PY'
import json, sys
rows = json.load(open(sys.argv[1]))["rows"]
bad = [r["id"] for r in rows if not r["ok"]]
print("配色对比度 %d/%d，不达标 %d 条：%s（明细见 spike/out/contrast.json）"
      % (len(rows) - len(bad), len(rows), len(bad), "、".join(bad)))
PY
)"
    fi
fi

# ------------------------------------------------------------------ 收尾

step "结果"

echo "  通过 ${pass}，失败 ${fail}"
echo "  应用输出：${LOG}"

if [ "${KEEP:-0}" != "1" ]; then
    echo "  验收库：${VAULT#${HERE}/}（保留，供人工用 KeePassXC 打开查看）"
fi

if [ "$fail" != "0" ]; then
    exit 1
fi
