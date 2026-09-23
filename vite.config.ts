import { defineConfig } from 'vite';

// 目标运行环境是 macOS 的 WKWebView，不是浏览器。
// 之所以显式写 target，是因为 Vite 默认按「浏览器」降级，会引入本项目用不到
// 的 polyfill，而 WKWebView 对 ES2022 的支持是完整的。
export default defineConfig({
    clearScreen: false,
    server: {
        port: 1420,
        strictPort: true,
        host: '127.0.0.1',
        // src-tauri 由 cargo 自己监听，交给 Vite 会触发无意义的整页重载
        watch: { ignored: ['**/src-tauri/**'] }
    },
    build: {
        target: 'safari16',
        outDir: 'dist',
        emptyOutDir: true,
        sourcemap: true
    }
});
