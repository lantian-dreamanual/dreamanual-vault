/* Argon2 适配层：把 argon2-browser 接成 kdbxweb 期望的签名。
 *
 * kdbxweb 通过 CryptoEngine.setArgon2Impl(fn) 注入，fn 的签名是
 *   (password, salt, memory, iterations, length, parallelism, type, version) => Promise<ArrayBuffer>
 *
 * ⚠️ memory 的单位是 **KiB** —— kdbxweb 内部已经把文件头里的字节数除过 1024
 *    （源码里的 key-encryptor-kdf.ts）。argon2-browser 的 mem 也是 KiB，正好对齐。
 *    这里再除一次会得到错误密钥，且不会报错，只是每次解锁都失败。
 *
 * Node 侧对应实现在 spike/lib/argon2-node.mjs，两者签名一致，
 * 差别只是底层 WASM 产物不同（同一档位耗时差 1.4–1.7 倍，所以定档只能用 webview 读数）。 */

import type { Argon2HashResult } from '../types/argon2-browser';

/** kdbxweb 的 Argon2Fn 用的就是这组参数类型（见 crypto-engine.d.ts）。
    这里手写一份而不从包里 import，是为了让本文件在 Node 侧也能被复用。 */
export type Argon2Impl = (
    password: ArrayBuffer,
    salt: ArrayBuffer,
    memoryKiB: number,
    iterations: number,
    length: number,
    parallelism: number,
    type: number,
    version: number
) => Promise<ArrayBuffer>;

/** WASM 在 CSP 缺 'wasm-unsafe-eval' 时的症状是 Promise 永不 settle，
    try/catch 接不住。所有 WASM 调用都要套这层超时，否则界面静默卡死。
 *
 *  ⚠️ 这层超时**只挡得住「WASM 被拦掉」**，它本身靠 `setTimeout` 计时 ——
 *  而 WASM 是同步跑在 WebView 主线程上的。凡是主线程被占住、或整个 WebContent
 *  进程被系统冻结（锁屏、显示器休眠时 macOS 会把不可见页面的进程挂起），
 *  `setTimeout` 排不上队，这层超时同样不会触发，表现为界面无声无息地停住。
 *  排查这类挂死要看进程的 CPU 占用（0% ＝ 被冻结，不是算不完），
 *  别只盯这一层超时。 */
export const WASM_TIMEOUT_MS = 8000;

function withTimeout<T>(p: Promise<T>, label: string, ms = WASM_TIMEOUT_MS): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = window.setTimeout(() => {
            reject(new Error(`${label} 超过 ${ms}ms 未返回。WASM 很可能被 CSP 拦掉了（检查 script-src 是否含 'wasm-unsafe-eval'）`));
        }, ms);
        p.then(
            (value) => {
                window.clearTimeout(timer);
                resolve(value);
            },
            (err: unknown) => {
                window.clearTimeout(timer);
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        );
    });
}

function backend(): Window['argon2'] {
    const a = window.argon2;
    if (!a) throw new Error('argon2-browser 未加载：检查 index.html 里 /vendor/argon2-bundled.min.js 是否被 CSP 挡掉');
    return a;
}

/** kdbxweb 的注入实现 */
export const argon2ImplWebview: Argon2Impl = async (
    password,
    salt,
    memoryKiB,
    iterations,
    length,
    parallelism,
    _type,
    version
) => {
    if (version !== 0x13) {
        throw new Error(`只实现 Argon2 version 0x13，收到 0x${version.toString(16)}`);
    }

    const res: Argon2HashResult = await withTimeout(
        backend().hash({
            pass: new Uint8Array(password),
            salt: new Uint8Array(salt),
            time: iterations,
            mem: memoryKiB,
            hashLen: length,
            parallelism,
            type: backend().ArgonType.Argon2id
        }),
        'Argon2 计算'
    );

    const { hash } = res;
    return hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength) as ArrayBuffer;
};

/** 自检：跑一次极小参数的 Argon2，确认 WASM 在这个 CSP 下真的能跑。
 *  参数故意调得很小（1 MiB / 1 轮），耗时可忽略。
 *  这条检查是 M0 那个坑的守门人：缺 'wasm-unsafe-eval' 时它会以超时告终，
 *  而不是让解锁界面在用户面前静默卡死后无声无息。 */
export async function argon2SelfTest(): Promise<number> {
    const t0 = performance.now();
    const out = await withTimeout(
        backend().hash({
            pass: 'selftest',
            salt: 'selftest-salt',
            time: 1,
            mem: 1024,
            hashLen: 32,
            parallelism: 1,
            type: backend().ArgonType.Argon2id
        }),
        'Argon2 自检',
        4000
    );
    if (out.hash.length !== 32) throw new Error(`自检输出长度异常：${out.hash.length}`);
    return performance.now() - t0;
}
