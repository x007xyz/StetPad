# Electron 内嵌服务打包验证

验证的问题：Electron 主进程里运行 Hono 服务和 better-sqlite3（原生模块），打包之后是否仍能加载并工作。

结论：可以。开发模式和打包产物都通过冒烟检查（Electron 45.3.2、better-sqlite3 13.1.1、macOS arm64，未签名）。

## 运行

```bash
npm install
npm run smoke:dev      # 开发模式下的冒烟检查
npm run pack           # 产出 release/mac-arm64/AiWriterSpike.app
npm run smoke:packed   # 对打包产物做同样的检查
npm start              # 打开窗口，页面经本地服务读写 SQLite
```

冒烟检查在一行 JSON 里报告：无令牌访问得到 401、伪造 `Host` 得到 403、带令牌写入后能读回、SQLite 版本。

## 让原生模块在打包后可用的设置

- `build.asarUnpack: ["**/*.node"]`：原生模块必须在 asar 之外，否则无法加载。
- `build.npmRebuild: true`（默认）：打包时 electron-builder 会按 Electron 的版本准备原生模块。better-sqlite3 13 自带各平台预编译文件，本机没有触发源码编译。
- `mac.identity: null`：跳过签名。正式发布需要签名与公证，这里没有验证。

## 遇到的问题

- **Electron 二进制下载**：Electron 45 在首次运行时才下载二进制。本机从 GitHub 下载多次中途停滞。处理方式是用 curl 断点续传官方压缩包，核对官方 `SHASUMS256.txt` 的 SHA-256 后解压到 `node_modules/electron/dist`，并写入 `path.txt`。持续集成环境里应缓存这个压缩包。
- **`build.electronDist`** 指向上面解压出的目录，避免 electron-builder 打包时再下载一次。网络正常的环境可以去掉这一项。
- **主进程未捕获的异常会弹出模态对话框并一直等待**，在无界面检查里表现为卡死。冒烟模式下改为打印错误并以非零状态退出。

## 没有验证的

代码签名与公证、自动更新、Windows、x64、打包体积优化（目前把所有平台的预编译文件都带上了）。
