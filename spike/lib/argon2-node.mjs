/**
 * kdbxweb 的 Argon2 实现适配层（Node 侧）。
 *
 * kdbxweb 把 Argon2 算法留成注入点，签名为：
 *   (password, salt, memory, iterations, length, parallelism, type, version) => Promise<ArrayBuffer>
 *
 * 注意 memory 的单位：kdbxweb 在 key-encryptor-kdf.ts 里做了 memory / 1024，
 * 也就是传进来时已经是 KiB。hash-wasm 的 memorySize 同为 KiB，可直接透传。
 *
 * 浏览器侧（Tauri webview）换成 argon2-browser，本文件的函数签名保持一致，
 * 由 kdbx.ts 决定注入哪一个。
 */
import { argon2d, argon2id } from 'hash-wasm';

const TYPE_ARGON2D = 0;
const TYPE_ARGON2ID = 2;
const VERSION_0x13 = 0x13;

const BACKEND_NAME = 'hash-wasm (WASM)';

export async function argon2Impl(
    password,
    salt,
    memory,
    iterations,
    length,
    parallelism,
    type,
    version
) {
    if (version !== VERSION_0x13) {
        throw new Error(
            `只实现 Argon2 version 0x13，收到的版本是 0x${version.toString(16)}`
        );
    }

    let fn;
    if (type === TYPE_ARGON2ID) {
        fn = argon2id;
    } else if (type === TYPE_ARGON2D) {
        fn = argon2d;
    } else {
        throw new Error(`未实现的 Argon2 type：${type}`);
    }

    // hash-wasm 默认返回 hex 字符串，必须显式要求二进制输出
    const hash = await fn({
        password: new Uint8Array(password),
        salt: new Uint8Array(salt),
        parallelism,
        iterations,
        memorySize: memory,
        hashLength: length,
        outputType: 'binary'
    });

    // slice() 复制到独立的 ArrayBuffer，避免把 WASM 堆内存视图交出去
    return hash.slice().buffer;
}

export function installArgon2(kdbxweb) {
    kdbxweb.CryptoEngine.setArgon2Impl(argon2Impl);
}

export function backendName() {
    return BACKEND_NAME;
}
