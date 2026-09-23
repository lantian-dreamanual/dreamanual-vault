---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'af6efbda-2d30-4049-88f8-d1d2bdaafb04'
  PropagateID: 'af6efbda-2d30-4049-88f8-d1d2bdaafb04'
  ReservedCode1: 'f061ebcd-23e7-4fcc-8209-2c61822b21be'
  ReservedCode2: 'f061ebcd-23e7-4fcc-8209-2c61822b21be'
---

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

## 系统要求

- macOS 12.0（Monterey）及以上
- Apple Silicon（M 系列）

## 安装

从官网下载 DMG：<https://dreamanual.com/works/vault.html>

## 构建

需要 Node 与 Rust 工具链。

```bash
npm install
npm run tauri build
```

产物在 `src-tauri/target/release/bundle/`，包含 `.app` 与 `.dmg`。

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

## 许可

MIT
