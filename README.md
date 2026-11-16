<p align="center"><img src="assets/brand/stetpad-icon.svg" width="96" alt="Stetpad"></p>

<h1 align="center">Stetpad</h1>

飞书文档 / Notion 式的块编辑器。AI 的每一处修改都以修订的形式进入文档，由人逐条接受或拒绝；AI 和人可以同时编辑同一篇文档。设计见 [PLAN.md](PLAN.md)。

## 运行

需要 Node 22+ 和 pnpm。

```bash
pnpm install
pnpm --dir apps/web build
pnpm --dir packages/server start
```

打开 `http://127.0.0.1:8787`，注册一个账号即可使用（Web 模式）。数据保存在 `.data/`。

桌面应用（macOS，未签名）：

```bash
cd desktop && npm install && npm run pack
open "release/mac-arm64/Stetpad.app"
```

桌面应用不需要账号，文档保存在本机的用户数据目录。

## 模型

服务端按以下顺序找密钥：应用设置里保存的 → 本机 DSH 的凭据（`~/.dsh/.credentials.yaml`）→ 环境变量。找到哪家的密钥，就提供哪家的模型。

| 提供方 | 密钥名 |
| --- | --- |
| DeepSeek | `DEEPSEEK_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Google | `GOOGLE_GENERATIVE_AI_API_KEY` |
| 任意 OpenAI 兼容端点 | `AIW_COMPAT_BASE_URL`、`AIW_COMPAT_MODELS`、`AIW_COMPAT_API_KEY` |

界面上标"未验证"的模型没有跑过编辑评测。评测（会调用模型并产生费用）：

```bash
pnpm --dir packages/server exec tsx scripts/eval.ts deepseek:deepseek-flash
```

## 外部 Agent（MCP）

把一篇文档作为 MCP 服务提供给 Claude Code、Codex、Pi、DSH 等。它们的修改同样以修订出现，不能替你接受或拒绝。

```bash
pnpm --dir packages/server exec tsx src/mcp.ts --url http://127.0.0.1:8787 --token <令牌> --doc <文档 ID> --author "Pi"
```

令牌可以是登录后的会话令牌，也可以是 `share:<分享链接里的令牌>`。

## 目录

| 位置 | 内容 |
| --- | --- |
| `packages/crdt` | 修订模型（基于 Yjs 的字符身份集合）、词级差异、Agent 提议的并发应用 |
| `packages/server` | 存储、账号、协同服务、版本、导入导出、文档工具层、Agent 运行时、MCP 服务 |
| `apps/web` | 前端：编辑器、修订面板、左右对比、版本、AI 面板 |
| `desktop` | Electron 桌面壳（内嵌同一个服务端） |
| `evals/results` | 各模型的评测结果 |
| `apps/editor-spike`、`spikes/` | 阶段 0 的技术验证，保留作参考 |

## 测试

```bash
pnpm -r typecheck
pnpm -r test
cd desktop && npm run smoke:dev && npm run smoke:packed
```

## 名字与图标

**Stet** 是校对符号，拉丁语"保留原样"：审稿人划掉一处修改、决定保留原文时，在删除线下打一排点并写 stet。Stetpad 的核心正是这件事：AI 只提修改，人决定留下哪些。

图标突出两件事：**这是一本笔记**，**里面有 AI 在帮你写**。

<img src="assets/brand/stetpad-mark.svg" width="120" alt="Stetpad 标志">

- **带线圈的笔记本**：写作和笔记的地方。
- **墨色文字行中间那行朱红**：AI 写下的修改。它以修订的形式出现，等你接受或拒绝。
- **右下角的星芒**：AI。大星芒压在笔记本一角，表示 AI 在文档里工作，而不是在旁边的聊天框里。

| 文件 | 用途 |
| --- | --- |
| [`assets/brand/stetpad-icon.svg`](assets/brand/stetpad-icon.svg) | 应用图标（墨色圆角底板），也是网页 favicon（`apps/web/public/favicon.svg`） |
| [`assets/brand/stetpad-icon-macos.svg`](assets/brand/stetpad-icon-macos.svg) | 按 macOS 图标网格留白的版本；`desktop/build/icon.png`（1024×1024）由它导出 |
| [`assets/brand/stetpad-mark.svg`](assets/brand/stetpad-mark.svg) | 无底板的标志，星芒周围用遮罩留出空隙，自动适配深色模式，用于文档和网页 |

颜色：纸色 `#FBF6EC`、墨色 `#2A251F`、朱红 `#D63F2A`。

重新导出桌面图标（macOS）：

```bash
qlmanage -t -s 1024 -o /tmp assets/brand/stetpad-icon-macos.svg && cp /tmp/stetpad-icon-macos.svg.png desktop/build/icon.png
```

## 许可证

- 本仓库默认采用 [GNU AGPL-3.0](LICENSE)：可以自由使用、修改、自行部署；修改后的版本若通过网络向他人提供服务，需以同一许可证公开源代码。
- [`packages/crdt`](packages/crdt)（修订模型）采用 [MIT](packages/crdt/LICENSE)，可单独在任何项目中使用。

各包的许可证以其目录下的 `LICENSE` 文件和 `package.json` 的 `license` 字段为准。
