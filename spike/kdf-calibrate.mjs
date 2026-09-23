/**
 * Argon2id 参数标定（Node 侧粗排）。
 *
 * 目的：PRD §4.2 要求「标定到解锁耗时约 1 秒」，但没说具体档位。
 * 本脚本扫一遍参数空间，得到「内存 × 迭代」到耗时的映射，
 * 再据此选出 安全 / 均衡 / 流畅 三档候选值。
 *
 * 注意：这里的后端是 hash-wasm，与 webview 侧的 argon2-browser 是两个不同的
 * WASM 编译产物，绝对耗时会有差异。所以本脚本只做**粗排**，选出候选档位后
 * 必须在真实 WKWebView 里复测（app 的标定模式）。
 *
 * 用法：node kdf-calibrate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { argon2id } from 'hash-wasm';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// 一次解锁 = 一次 argon2id。这里用固定口令与盐，只关心耗时。
const PASSWORD = new Uint8Array(Buffer.from('correct horse battery staple 上海', 'utf8'));
const SALT = new Uint8Array(32).fill(7);
const PARALLELISM = 4;
const HASH_LENGTH = 32;

const MEMORY_MIB = [64, 128, 256, 512];
const ITERATIONS = [1, 2, 3, 5, 8];
const REPEATS = 3;

async function timeOnce(memoryMiB, iterations) {
    const t0 = performance.now();
    await argon2id({
        password: PASSWORD,
        salt: SALT,
        parallelism: PARALLELISM,
        iterations,
        memorySize: memoryMiB * 1024, // KiB
        hashLength: HASH_LENGTH,
        outputType: 'binary'
    });
    return performance.now() - t0;
}

function median(xs) {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
}

const rows = [];
console.log('Argon2id 参数标定（hash-wasm / Node）');
console.log(`并行度 ${PARALLELISM} · 每档重复 ${REPEATS} 次取中位数\n`);

for (const mem of MEMORY_MIB) {
    for (const it of ITERATIONS) {
        // 预热一次，避开首次分配 WASM 堆内存的开销
        try {
            await timeOnce(mem, it);
        } catch (e) {
            rows.push({ mem, it, ms: NaN, error: String(e.message || e) });
            console.log(`  ${String(mem).padStart(3)} MiB × ${it} 轮  失败：${e.message || e}`);
            continue;
        }
        const times = [];
        for (let r = 0; r < REPEATS; r += 1) {
            times.push(await timeOnce(mem, it));
        }
        const ms = median(times);
        rows.push({ mem, it, ms });
        const flag = ms >= 700 && ms <= 1400 ? '  ← 落在 1 秒附近' : '';
        console.log(
            `  ${String(mem).padStart(3)} MiB × ${it} 轮  ${ms.toFixed(0).padStart(5)} ms${flag}`
        );
    }
    console.log('');
}

const valid = rows.filter((r) => !Number.isNaN(r.ms));
const closest = valid.reduce((a, b) => (Math.abs(a.ms - 1000) < Math.abs(b.ms - 1000) ? a : b));

console.log('='.repeat(58));
console.log(`最接近 1 秒的组合：${closest.mem} MiB × ${closest.it} 轮 → ${closest.ms.toFixed(0)} ms`);

// 选三档：流畅取 ~1s 的 1/3，安全取 ~1s 的 2.5 倍，均衡取 1s 附近
function pick(targetMs) {
    return valid.reduce((a, b) => (Math.abs(a.ms - targetMs) < Math.abs(b.ms - targetMs) ? a : b));
}
const smooth = pick(350);
const balanced = pick(1000);
const strong = pick(2500);
console.log('');
console.log('候选三档：');
console.log(`  流畅  ${smooth.mem} MiB × ${smooth.it} 轮 → ${smooth.ms.toFixed(0)} ms`);
console.log(`  均衡  ${balanced.mem} MiB × ${balanced.it} 轮 → ${balanced.ms.toFixed(0)} ms`);
console.log(`  安全  ${strong.mem} MiB × ${strong.it} 轮 → ${strong.ms.toFixed(0)} ms`);

const outPath = path.join(HERE, 'out', 'kdf-calibration.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(
    outPath,
    JSON.stringify(
        {
            backend: 'hash-wasm (Node)',
            host: `${os.platform()} ${os.arch()} · ${os.cpus()[0].model} · ${os.cpus().length} 核`,
            parallelism: PARALLELISM,
            repeats: REPEATS,
            measuredAt: new Date().toISOString(),
            rows: valid,
            candidates: { smooth, balanced, strong }
        },
        null,
        2
    )
);
console.log(`\n结果已写入 ${path.relative(process.cwd(), outPath)}`);
