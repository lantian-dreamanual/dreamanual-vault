#!/usr/bin/env bash
#
# A3 侧栏毛玻璃的一次性探针。
#
# 起一次应用（跟随系统主题 + unlocked,seed），截两张图，交给 a3-measure.py 读读数：
#   · 只看窗口的那一张：窗口背后空无一物，毛玻璃没得采样
#   · 压在桌面上的那一张：用户实际看到的样子
# 两张一对照就知道材质到底通没通。
#
# 用法：
#   ./scripts/a3-probe.sh                      # 默认 unlocked,seed
#   ./scripts/a3-probe.sh unlocked,settings    # 换一组视图标记

set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT"

. "$HERE/preflight-screen.sh"
require_screen_usable || exit 1

PW='correct horse battery staple 上海'
BIN="$ROOT/src-tauri/target/release/dreamanual-vault"
FLAGS="${1:-unlocked,seed}"
OUT=/tmp/a3-probe
PY="$HOME/.workbuddy/binaries/python/envs/default/bin/python"

mkdir -p "$OUT"

echo "开发标记：${FLAGS}"

env VAULT_HOME="$ROOT/.dev-home" VAULT_DEV_PASSWORD="$PW" VAULT_DEV="$FLAGS" \
    "$BIN" >"$OUT/app.log" 2>&1 &
pid=$!

sleep 8

if grep -q '页面加载事件: Finished' "$OUT/app.log" 2>/dev/null; then
    echo "页面加载：Finished"
else
    echo "页面加载：没等到 —— 看 ${OUT}/app.log"
fi
grep '窗口几何' "$OUT/app.log" 2>/dev/null | sed 's/^/  /'

"$PY" "$HERE/a3-measure.py"
rc=$?

# 每轮换一组文件名，好把「跟随系统」与「强制浅色」两轮放在一起比
"$PY" - "$OUT" "$FLAGS" <<'PY' 2>/dev/null || true
import os, shutil, sys
out, flags = sys.argv[1], sys.argv[2]
tag = flags.replace(':', '-').replace(',', '_')
for n in ('window', 'full'):
    src = os.path.join(out, f'{n}.png')
    if os.path.exists(src):
        shutil.copy2(src, os.path.join(out, f'{n}__{tag}.png'))
print(f'本轮另存为 *__{tag}.png')
PY

kill "$pid" 2>/dev/null
wait "$pid" 2>/dev/null

exit "$rc"
