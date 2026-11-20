<p align="center"><img src="assets/brand/stetpad-icon.svg" width="96" alt="Stetpad"></p>

<h1 align="center">Stetpad</h1>

飞书文档 / Notion 式的块编辑器，桌面客户端。AI 的每一处修改都以修订的形式进入文档，由人逐条接受或拒绝；AI 和人可以同时编辑同一篇文档。设计见 [PLAN.md](PLAN.md)。

## 功能

### 编辑器
- 块：段落、1–3 级标题、无序 / 有序 / 待办列表、引用、高亮块、代码块、分割线、表格、图片、视频、附件、链接卡片、公式、Mermaid、draw.io。
- 行内样式、斜杠菜单、Markdown 快捷输入、拖拽排序、块菜单；中文输入法、撤销 / 重做、HTML 粘贴均已验证。
- 脚注：选中文字加脚注，文末自动编号成参考文献列表。
- 行内公式 `$x$`（KaTeX）和块级公式；Mermaid 随主题重绘、可放大查看，过宽时横向滚动。
- 大纲、深浅色主题、中文 / English 界面。
- 跨文档搜索（⌘K / Ctrl+K）：按标题和正文搜索所有文档，正文按修改稿匹配。
- 回收站：删除的文档先进回收站，可恢复或彻底删除；30 天后自动彻底删除（`AIW_TRASH_DAYS` 可改）。

### 修订与 AI 协作
- 修订：行内显示删除线 / 下划线；修订模式下，人的修改也会被记录；可以逐条、按作者或全部接受和拒绝，所有副本收敛到同一结果。
- AI 和人同时编辑同一段落；AI 的每条修改都附带原因，可以撤回。
- 两种显示：行内修订、左右对比（原文与修改稿并排）；版本对比也用左右对比。
- 评论：可回复、可解决，AI 也能读写评论；输入 `@` 可以选择 AI。
- 评论里 `@AI`：AI 读取这条评论的上下文，按要求修改文档（以修订出现）或回答问题，并在同一条评论下回复。没有可用模型或任务失败时，也会在评论里说明。

### 内置 Agent
- 选区快捷操作、对话、斜杠续写；运行在服务端持久化，断线后可续上，可以取消。
- 长文档先给大纲、按需读取；有步数、token 和时长预算；厂商出错时重试或切换备用模型。
- 多家模型：DeepSeek、OpenRouter、Anthropic、OpenAI、Google，以及任意 OpenAI 兼容端点；可以自定义模型，并给每个模型勾选能力（文字、识图、生图、改图、转写）；不同用途（对话、识图、生图等）可以分别指定模型。
- 对话模型不能识图时，自动用识图模型把图片转成文字描述。
- 用量计量和限额。

### 多媒体
- 图片：粘贴、拖入、图注、宽度；裁剪、旋转、翻转；AI 生成描述（alt），上传或生成后自动补全。
- AI 生成图片、AI 改图（替换原图或另插一张），对话框里显示单价，自动选推荐模型；Agent 也可以调用生图。
- AI 画图：根据描述生成 Mermaid、公式或 draw.io；表格可以一键生成图表。
- 视频：上传（≤1GB，分片断点续传，多个文件排队上传）或嵌入 B 站 / YouTube / Vimeo；自动截取封面帧；AI 转写生成文字稿和字幕。
- draw.io：内嵌编辑器、自动预览；可以离线托管（见下文）。
- 附件：PDF、Office、压缩包等（≤100MB），PDF 显示为页面预览图。
- 链接卡片：粘贴网址时提示转换，服务端抓取标题和封面（防 DNS 重绑定），封面存到本地。
- 文件存储在 `<数据目录>/assets/`，支持 Range 请求；同一用户重复上传的相同文件只存一份；不再被引用的文件 7 天后自动清理。

### 版本、导入与导出
- 版本：AI 修改前后、导入、修订处理完、恢复前、定时和手动快照；任意两个版本对比；恢复。
- 导入：Word、PDF（扫描件交给识图模型转写）、HTML、Markdown、纯文本，导入前预览；导入时被丢弃的文件会列出来告诉用户。
- 导出：Markdown、HTML、PDF、Word（公式、Mermaid、脚注、图片都会带上）。
- 文档包 `.stetpad`：zip 格式，包含正文、全部版本、未处理的修订和评论，以及所有文件；可以在另一台机器上导入。

### 桌面客户端
- Electron 内嵌服务端，不需要账号，文档用 SQLite 保存在本机；文件夹整理文档；只监听本机回环地址，校验令牌和 Host；密钥用系统钥匙串加密保存；支持自动更新。

### 外部 Agent 与剪藏
- MCP 服务：把文档的同一套工具提供给 Claude Code、Codex 等外部 Agent，它们的修改同样以修订出现。
- ACP：在应用里直接调用本机的外部 Agent（Agent Client Protocol）。
- 浏览器剪藏插件：Chrome / Edge、Firefox、Safari，连接本机桌面客户端。

## 开源与订阅

桌面客户端完全开源，用自己的模型密钥就能使用全部功能，不需要账号。

另外提供付费订阅，内容是需要服务器才能提供的服务：平台 AI 额度（不用自己申请各家模型的密钥），以后还会有多设备同步与多人协作。订阅用到的云端服务不在这个仓库里。

## 待开发

以下功能的代码已经写好，但还没有在真实环境里跑过（缺密钥、证书或需要下载），使用时可能需要修正：

- 多家模型的工具集评测：目前只有 DeepSeek Flash 和 Claude Sonnet 5（经 OpenRouter）跑过评测，其余提供方标为"未验证"。
- 扫描件 PDF 识别：只用替身测过，没有用真实模型跑过。
- AI 改图、视频 AI 转写：需要 OpenAI / Google 密钥并产生费用，没有实际调用过。
- 离线 draw.io：下载和打包流程没有完整走过一遍。
- 代码签名与 Windows 安装包：本机没有证书，也无法交叉编译；CI 工作流已写好，还没有在真实 runner 上运行过。
- 系统输入法：组合输入用浏览器协议模拟验证过，没有用搜狗、苹果拼音等具体输入法试过。
- Agent 重复修改同一处时，结果正确，但不是最简形式（例如先提议删除、再提议恢复同样的文字，会表现为"保留删除 + 重新插入"）。

## 已知限制

- Mermaid 图只能由浏览器绘制。网页里导出（修改稿或原文）时由浏览器现画；不经过浏览器的导出（GET 接口、MCP）使用缓存，缓存来自编辑器在浅色主题下显示过的图和以前的导出。从没在编辑器里显示过的图，这类导出仍然只显示源码。
- 视频断点续传：上传状态保存在磁盘上，服务器重启后可以接着传；但浏览器只在约 30 秒内自动重试，刷新页面或断开更久就需要重新上传。
- 嵌入视频点一下就会选中并开始播放，但能否自动播放取决于 B 站 / YouTube / Vimeo 自己的策略，没有逐个验证。
- Google Imagen 没有 3:2 和 2:3，选这两种比例时先按 4:3 / 3:4 生成，再居中裁掉多出的部分。
- AI 读写行内公式用 `$…$`，字面的美元符号写作 `\$`。AI 忘了转义时，价格这类写法（`$5`、`$5 和 $6`）按普通文字处理；另外，如果 AI 写入时有人同时在改同一段，新公式可能显示为普通文字。

## 运行

需要 Node 22+ 和 pnpm。

桌面应用（macOS，未签名）：

```bash
cd desktop && npm install && npm run pack
open "release/mac-arm64/Stetpad.app"
```

桌面应用不需要账号，文档保存在本机的用户数据目录。

开发时也可以不打包，直接在浏览器里用：

```bash
pnpm install
pnpm --dir apps/web build
AIW_TOKEN=dev pnpm --dir packages/server start
```

打开 `http://127.0.0.1:8787/?token=dev`（`token` 填 `AIW_TOKEN` 的值；不设置时启动日志会打印一个随机令牌）。数据保存在 `.data/`。

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

## 离线的 draw.io

画图默认使用 embed.diagrams.net。桌面版可以把 draw.io 打包进应用，离线也能画图：

```bash
cd desktop && npm run fetch:drawio   # 下载固定版本的 draw.io 到 desktop/drawio（需要联网与 unzip）
npm run pack                          # 打包时自动带上 desktop/drawio
```

服务端也可以直接提供一个 draw.io 网页目录：设置 `AIW_DRAWIO_DIR` 指向含 `index.html` 的目录，编辑器会改用 `/drawio/`。`AIW_DRAWIO_URL` 始终优先。

## 外部 Agent（MCP）

把一篇文档作为 MCP 服务提供给 Claude Code、Codex、Pi、DSH 等。它们的修改同样以修订出现，不能替你接受或拒绝。

```bash
pnpm --dir packages/server exec tsx src/mcp.ts --url http://127.0.0.1:8787 --token <令牌> --doc <文档 ID> --author "Pi"
```

令牌是桌面应用的本机令牌。

## 目录

| 位置 | 内容 |
| --- | --- |
| `packages/crdt` | 修订模型（基于 Yjs 的字符身份集合）、词级差异、Agent 提议的并发应用 |
| `packages/clip` | 跨端网页块清洗与归一化（HTML/DOM → Block、懒加载图、公式、Markdown） |
| `packages/server` | 存储、协同服务、版本、导入导出、文档工具层、Agent 运行时、MCP 服务 |
| `apps/web` | 前端：编辑器、修订面板、左右对比、版本、AI 面板 |
| `apps/clipper` | 跨浏览器网页剪藏插件（Chrome / Firefox / Safari MV3，WXT + Defuddle） |
| `desktop` | Electron 桌面壳（内嵌同一个服务端） |
| `evals/results` | 各模型的评测结果 |
| `apps/editor-spike`、`spikes/` | 阶段 0 的技术验证，保留作参考 |

## 浏览器剪藏插件

连接本机桌面客户端，支持 Chrome / Edge、Firefox 与 Safari：

```bash
pnpm --dir apps/clipper build
```

- **Chrome / Edge**：打开扩展管理页开启开发者模式，加载 `apps/clipper/.output/chrome-mv3`。
- **Firefox**：在 `about:debugging#/runtime/this-firefox` 临时载入 `apps/clipper/.output/firefox-mv3/manifest.json`。
- **Safari (macOS)**：运行 `pnpm --dir apps/clipper xcode:safari` 生成 `apps/clipper/.output/safari-xcode/Stetpad Clipper` Xcode 工程并运行。

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

- 本仓库默认采用 [GNU AGPL-3.0](LICENSE)：可以自由使用、修改和分发；分发修改后的版本或通过网络向他人提供服务时，需以同一许可证公开源代码。
- [`packages/crdt`](packages/crdt)（修订模型）采用 [MIT](packages/crdt/LICENSE)，可单独在任何项目中使用。

各包的许可证以其目录下的 `LICENSE` 文件和 `package.json` 的 `license` 字段为准。
