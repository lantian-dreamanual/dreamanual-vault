/**
 * 生成物同步检查：src/styles/tokens.generated.css 与设计系统产出的那份必须逐字节相同。
 *
 * app 是独立仓库，构建不该依赖 design/ 在旁边，所以生成物入库存了一份。
 * 代价是两边会悄悄分叉 —— 改了 design/tokens.json、重跑 build.mjs，却忘了同步过来，
 * 界面上就还是旧配色，而且没有任何东西会报错。这条断言把「忘了同步」变成一次失败。
 *
 * 设计系统仓库不在旁边时（单独 clone 了这个 app）报 SKIP 并以 0 退出 ——
 * 缺的是参照物，不是这份副本有问题。
 *
 * 用法：
 *   node spike/tokens-sync.mjs          检查
 *   node spike/tokens-sync.mjs --write  把设计系统的产物同步过来
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LOCAL = path.join(ROOT, 'src', 'styles', 'tokens.generated.css');
const SOURCE = path.join(ROOT, '..', '..', 'design', 'dist', 'css', 'dreamanual.vault.css');

const write = process.argv.includes('--write');

if (!fs.existsSync(SOURCE)) {
    console.log('SKIP  设计系统产物不在旁边，跳过生成物同步检查');
    console.log(`      期望位置：${SOURCE}`);
    process.exit(0);
}

const source = fs.readFileSync(SOURCE, 'utf8');

if (write) {
    fs.writeFileSync(LOCAL, source);
    console.log(`已同步 tokens.generated.css ← ${path.relative(ROOT, SOURCE)}`);
    process.exit(0);
}

if (!fs.existsSync(LOCAL)) {
    console.log('FAIL  本地没有 src/styles/tokens.generated.css');
    console.log('      跑 `npm run tokens:sync` 从设计系统取一份。');
    process.exit(1);
}

if (fs.readFileSync(LOCAL, 'utf8') === source) {
    console.log('PASS  生成物与设计系统一致');
    process.exit(0);
}

console.log('FAIL  生成物已与设计系统分叉');
console.log(`      本地：${path.relative(ROOT, LOCAL)}`);
console.log(`      来源：${path.relative(ROOT, SOURCE)}`);
console.log('      跑 `npm run tokens:sync` 同步。');
process.exit(1);
