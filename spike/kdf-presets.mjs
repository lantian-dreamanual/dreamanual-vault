/**
 * Argon2id 参数档位的唯一定义处。
 *
 * 这些数值来自实测，不是抄来的默认值。标定方法：
 *   1. Node 侧粗排候选（spike/kdf-calibrate.mjs）
 *   2. 在真实 WKWebView + argon2-browser 里精测三档（app 的标定模式）
 *      实测读数见 spike/out/kdf-calibration-*.json
 *
 * 为什么三档统一 3 轮迭代、只调内存：Argon2 抵抗 GPU / ASIC 的关键是内存带宽，
 * 提高内存比提高迭代轮数更有效；迭代数固定也让三档的行为差异可预期。
 *
 * ⚠️ 参数写入 .kdbx 文件头，由文件自身携带。换档 = 重建库，
 *    所以改动本文件后必须重跑 node roundtrip.mjs 与 node interop.mjs。
 *
 * M0 阶段放在 spike/ 下；M1 建工程时搬到 src/vault/kdf.ts，作为前端唯一来源。
 */

export const KDF_PRESETS = {
    流畅: {
        memoryMiB: 128,
        iterations: 3,
        parallelism: 4,
        version: 0x13,
        saltBytes: 32,
        measuredInWebviewMs: 351
    },
    均衡: {
        memoryMiB: 256,
        iterations: 3,
        parallelism: 4,
        version: 0x13,
        saltBytes: 32,
        measuredInWebviewMs: 859
    },
    安全: {
        memoryMiB: 512,
        iterations: 3,
        parallelism: 4,
        version: 0x13,
        saltBytes: 32,
        measuredInWebviewMs: 1591
    }
};

/** 新建库用哪一档 */
export const DEFAULT_PRESET = '均衡';

/** 转成 KDBX 文件头里的字节数（kdbxweb 要求是 1024 的整数倍） */
export function presetToKdfParams(preset) {
    return {
        memoryBytes: preset.memoryMiB * 1024 * 1024,
        iterations: preset.iterations,
        parallelism: preset.parallelism,
        version: preset.version,
        saltBytes: preset.saltBytes
    };
}
