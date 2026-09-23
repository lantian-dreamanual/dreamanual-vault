/* argon2-browser 的 bundled 版本是 webpack 产物，通过 <script> 挂到 window 上，
   没有随包提供类型。这里按实际用到的 API 补一份最小声明。 */

declare global {
    interface Window {
        argon2: Argon2Browser;
    }
}

export interface Argon2HashOptions {
    pass: Uint8Array | string;
    salt: Uint8Array | string;
    time: number;
    mem: number; // KiB
    hashLen: number;
    parallelism: number;
    type: number;
}

export interface Argon2HashResult {
    hash: Uint8Array;
    hashHex: string;
    encoded: string;
}

export interface Argon2Browser {
    hash(options: Argon2HashOptions): Promise<Argon2HashResult>;
    ArgonType: { Argon2d: 0; Argon2i: 1; Argon2id: 2 };
    unloadRuntime(): void;
}

export {};
