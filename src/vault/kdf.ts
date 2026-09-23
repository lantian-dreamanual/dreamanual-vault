/* Argon2id 参数档位的唯一定义处。
 *
 * 数值来自实测，不是抄来的默认值。标定方法：
 *   1. Node 侧粗排候选        → spike/kdf-calibrate.mjs
 *   2. 真实 WKWebView 精测三档 → 验证壳的 VAULT_KDF_CALIBRATE 模式
 *   实测读数见 spike/out/kdf-calibration-webview.json
 *
 * 三档统一 3 轮迭代、只调内存：Argon2 抵抗 GPU / ASIC 靠的是内存带宽，
 * 提高内存比提高迭代轮数有效；迭代数固定也让三档的行为差异可预期。
 *
 * ⚠️ 参数写进 .kdbx 文件头，由文件自身携带。换档 = 重建库。
 *    改动本文件后必须重跑 spike/roundtrip.mjs 与 spike/interop.mjs。 */

export type PresetName = '流畅' | '均衡' | '安全';

export interface KdfPreset {
    /** 内存开销，MiB */
    memoryMiB: number;
    iterations: number;
    parallelism: number;
    version: number;
    saltBytes: number;
    /** 本机 WKWebView 实测解锁耗时中位数，仅供界面提示使用 */
    measuredInWebviewMs: number;
}

export const KDF_PRESETS: Record<PresetName, KdfPreset> = {
    流畅: { memoryMiB: 128, iterations: 3, parallelism: 4, version: 0x13, saltBytes: 32, measuredInWebviewMs: 351 },
    均衡: { memoryMiB: 256, iterations: 3, parallelism: 4, version: 0x13, saltBytes: 32, measuredInWebviewMs: 859 },
    安全: { memoryMiB: 512, iterations: 3, parallelism: 4, version: 0x13, saltBytes: 32, measuredInWebviewMs: 1591 }
};

export const PRESET_NAMES: PresetName[] = ['流畅', '均衡', '安全'];

/** 新建库用哪一档 */
export const DEFAULT_PRESET: PresetName = '均衡';

export interface KdfParams {
    memoryBytes: number;
    iterations: number;
    parallelism: number;
    version: number;
    saltBytes: number;
}

/** 转成写进 KDBX 文件头的字节数。kdbxweb 会校验 M 能被 1024 整除。 */
export function presetToKdfParams(preset: KdfPreset): KdfParams {
    return {
        memoryBytes: preset.memoryMiB * 1024 * 1024,
        iterations: preset.iterations,
        parallelism: preset.parallelism,
        version: preset.version,
        saltBytes: preset.saltBytes
    };
}
