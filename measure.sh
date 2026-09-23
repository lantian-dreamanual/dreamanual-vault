#!/usr/bin/env bash
#
# 性能读数复现。
#
# 读数由前端在启动自检里采集，经 invoke 交给 Rust 打印到 stdout ——
# 不依赖肉眼看秒表，也不依赖截图比对。
#
# 两段：
#   ① 冷启动到解锁页（默认）
#   ② 真实解锁并进入主视图（UNLOCK=1，且 .dev-home/ 里已有库）
#
# 用法：
#   ./measure.sh                 # 连跑 3 次
#   RUNS=5 ./measure.sh          # 跑 5 次
#   UNLOCK=1 ./measure.sh        # 额外跑一组解锁读数
#
# 前置：npm run app:build
#
# 注意读数区分「JS 执行耗时」与「到下一帧耗时」——后者在快操作上恒为 33 ms
# （两次 requestAnimationFrame 的固定间隔），判断性能要看前者。

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

BIN="src-tauri/target/release/dreamanual-vault"
RUNS="${RUNS:-3}"
LOG_DIR="${TMPDIR:-/tmp}"

DEV_HOME="$HERE/.dev-home"
PW="${VAULT_DEV_PASSWORD:-correct horse battery staple 上海}"

if [ ! -x "$BIN" ]; then
    echo "找不到 ${BIN}"
    echo "先构建：npm run app:build"
    exit 1
fi

run_once() {
    local tag="$1"
    local n="$2"
    shift 2

    local log="$LOG_DIR/vault-measure-${tag}-${n}.log"
    local pidfile="$LOG_DIR/vault-measure-${tag}-${n}.pid"

    ( env VAULT_PERF_EXIT=1 "$@" "$BIN" >"$log" 2>&1 & echo $! >"$pidfile" )

    local pid
    pid="$(cat "$pidfile")"
    # 应用报完读数会自行退出；给足 40 秒兜底（解锁要跑 Argon2）
    for _ in $(seq 1 80); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.5
    done
    if kill -0 "$pid" 2>/dev/null; then
        echo "  [未自行退出，强制结束]"
        kill "$pid" 2>/dev/null || true
    fi

    echo "===================== ${tag} · 第 ${n} 次 ====================="
    grep -E '进程启动到读数送达' "$log" || true
    sed -n '/^{/,/^}$/p' "$log" || true
    echo
}

for i in $(seq 1 "$RUNS"); do
    run_once "冷启动" "$i" env VAULT_HOME="$DEV_HOME"
done

if [ "${UNLOCK:-0}" = "1" ]; then
    if [ ! -f "$DEV_HOME/vault.kdbx" ]; then
        echo "解锁读数需要 .dev-home/vault.kdbx。先跑一次 ./scripts/shots.sh 或带 seed 启动一次。"
        exit 1
    fi
    echo "解锁读数：库在 ${DEV_HOME}/vault.kdbx"
    for i in $(seq 1 "$RUNS"); do
        run_once "真实解锁" "$i" \
            env VAULT_HOME="$DEV_HOME" VAULT_DEV=unlocked VAULT_DEV_PASSWORD="$PW"
    done
fi

echo "说明："
echo "  firstPaintMs     本页从导航开始到第二帧的耗时（即首屏）"
echo "  viewSwitch.*     视图切换的 JS 执行耗时。低于 1ms 表示落在计时精度以下"
echo "  wasmSelfTestMs   Argon2 WASM 自检耗时。这一项失败 = CSP 缺 'wasm-unsafe-eval'"
echo "  engine           kdbxweb 的引擎探针，randomBytes 必须是 16"
echo "  vault.解锁耗时   读文件 + KDF + 解密解析的总耗时（UNLOCK=1 时才有）"
echo "  vault.文件头     写出的库的版本 / KDF 档位 / 加密算法"
