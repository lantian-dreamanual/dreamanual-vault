# Dreamanual 密码管理

macOS 桌面密码管理器。账号密码收进本机的一个加密文件，文件用标准 KDBX 格式保存，
KeePassXC、KeePass、Strongbox 等客户端都能打开。

官网与下载：<https://dreamanual.com/works/vault.html>

## 功能特性

- **标准 KDBX**：写出的库是 KDBX 4.0，与 KeePassXC 双向互通（四方向 22 项自动检查）
- **Argon2id**：主密码经 Argon2id 派生密钥，三档强度可选（128 / 256 / 512 MiB，3 轮，并行度 4）
- **本地读写**：库文件的读写都在本机磁盘。应用不发遥测、不上传内容，唯一的联网动作是设置页手动「检查更新」
- **自动备份**：指定一个目录，之后每次保存镜像一份过去，并保留最近若干份历史版本
- **自动锁定**：无操作超时锁定；系统锁屏或进入休眠时立即锁定
- **剪贴板清除**：复制密码后按设定时长清空剪贴板，退出应用时也会清一次
- **全文检索**：标题、账号、网址、备注一起搜
- **原生界面**：Tauri 2 + 原生 DOM，深色三栏布局

## 下载安装

### 系统要求

- macOS 12.0（Monterey）及以上
- Apple Silicon（M 系列）

### 下载 DMG

官网下载：<https://dreamanual.com/works/vault.html>

也可以从仓库内 [release/](release/) 目录直接下载（[Dreamanual 密码管理.dmg](release/Dreamanual%20%E5%AF%86%E7%A0%81%E7%AE%A1%E7%90%86.dmg)）。

1. 打开 DMG，将 Dreamanual 密码管理.app 拖入「应用程序」文件夹
2. 首次打开若提示「无法验证开发者」：系统设置 → 隐私与安全性 → 仍要打开

### 从源码构建

见下方[编译构建](#编译构建)。

## 使用说明

1. 首次启动新建库：选一个保存位置，设定主密码（Argon2id 强度三选一）
2. 主密码解锁后添加条目：标题、账号、密码、网址与备注
3. 复制密码后剪贴板按设定时长自动清空；无操作超时或锁屏即自动锁定
4. 建议在设置页开启自动备份，指定一个目录镜像保存历史版本

## 技术架构

- **框架**：Tauri 2（Rust 内核 + WebView）+ 原生 DOM，无前端框架
- **加密**：KDBX 4.0 标准，AES-256 解密 + Argon2id 密钥派生，读写实现在 `src/vault.rs`
- **联网**：仅设置页手动「检查更新」一条，其余动作全部本地
- **验收**：与 KeePassXC 的互通有四方向 22 项自动检查兜底（见下方验证）

## 编译构建

需要 Node 与 Rust 工具链。

```bash
npm install
npm run tauri build
```

产物在 `src-tauri/target/release/bundle/`，包含 `.app` 与 `.dmg`。
发版时把 DMG 手动拷一份到 `release/`（仓库内 DMG 下载链接指向这里；
`dist/` 是 vite 构建输出目录，会被清空，不放 DMG）。

开发模式：

```bash
npm run app:dev
```

## 验证

改到加密链路的代码之后，下面三条都要跑。

```bash
node spike/roundtrip.mjs       # KDBX 往返（含换 KDF 档再换回）
node spike/interop.mjs         # 与 KeePassXC 的四方向互通，需要本机装有 KeePassXC
./scripts/m2-acceptance.sh     # 应用内全量验收，跑真实的 Argon2 与真实库文件
```

`./scripts/m2-acceptance.sh` 里的库文件落在仓库内的 `.dev-home/`，
不会碰到 `~/Library/Application Support/` 下的正式库。

## 开发者

蓝添 (Dreamanual)

## 许可证

MIT
