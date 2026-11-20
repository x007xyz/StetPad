# AGENTS.md

给在这个仓库里工作的 AI Agent（Claude Code、Codex 等）看的约定。详细设计见 [PLAN.md](PLAN.md)。

## 产品方向（2026-11-19 确定）

- **只做桌面客户端**：Electron 应用内嵌服务端，单人使用，没有账号。文档用 SQLite 存在本机。
- **客户端开源**（AGPL-3.0；`packages/crdt` 是 MIT），用户用自己的模型密钥就能使用全部功能。
- **靠订阅收费**：平台 AI 额度，以后是多设备同步和多人协作。订阅用到的云端服务不开源，**不在这个仓库里**。
- Web 版以后要做官网或在线版时再考虑。

## 不要做的事

- 不要加回账号、登录、团队空间、成员、分享链接、访客、给他人发通知、@提及他人、PostgreSQL、Web 模式（`mode: 'web'`）。这些已在 2026-11-19 移除。
- 旧实现保留在本地分支 `archive/web-collab`（未推送），只作参考，不要合回主线。
- 不要在客户端代码里按套餐锁功能。

## 以后的联网协作

走同步方案：本地服务作为协作者连到云端同一篇文档，靠 CRDT 合并，不做差异比对。动手前先读 PLAN.md 4.4，先解决两件事：

- **作者身份**：本地作者现在固定是"我"。
- **权限在云端判定**：只读、只能提建议等角色不能只靠本地执行。

## 代码结构

| 位置 | 内容 |
| --- | --- |
| `packages/crdt` | 修订模型（Yjs 之上）、Agent 提议的并发应用 |
| `packages/server` | 内嵌服务端：存储、协同、版本、导入导出、Agent 运行时、MCP |
| `packages/clip` | 网页剪藏的块清洗 |
| `apps/web` | 界面（React），由内嵌服务端提供给桌面窗口 |
| `apps/clipper` | 浏览器剪藏插件，只连本机桌面端 |
| `desktop` | Electron 壳 |

## 约定

- AI 的所有修改都以**修订建议**进入文档，不能直接覆盖原文，也不能替人接受或拒绝。
- 界面文字写中文；英文靠 `apps/web/src/i18n.ts` 的对照表翻译。新增界面文字时，在表里补上英文。
- 确认操作用 `apps/web/src/components/confirm.tsx` 的 `confirmAction`，不要用 `window.confirm`。
- 代码注释和提交信息用英文。
- 测试不能依赖真实的模型密钥或网络。

## 验证

```bash
pnpm -r typecheck
pnpm -r test
cd desktop && npm run smoke:dev
```

在浏览器里开发界面（不打包）：

```bash
pnpm --dir apps/web build
AIW_TOKEN=dev pnpm --dir packages/server start
```

然后打开 `http://127.0.0.1:8787/?token=dev`。数据在 `.data/`，用 `AIW_DATA_DIR` 可以换目录。
