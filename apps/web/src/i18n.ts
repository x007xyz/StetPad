/**
 * Interface language. The source strings are Chinese; English is applied by
 * translating rendered text and attributes against the tables below. Switching
 * language reloads the page, so nothing needs to be translated back.
 * User content must be marked translate="no"; editor and chat bodies are also
 * skipped. Text that is not in the tables stays unchanged.
 */
export type Lang = 'zh' | 'en'

import { toggleTheme } from './theme'

const KEY = 'aiw.lang'

export function getLang(): Lang {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'zh' || v === 'en') return v
  } catch {
    /* storage unavailable */
  }
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

export function setLang(l: Lang): void {
  try {
    localStorage.setItem(KEY, l)
  } catch {
    /* storage unavailable */
  }
  location.reload()
}

export function fmtDate(t: number): string {
  const d = new Date(t)
  return getLang() === 'zh'
    ? `${d.getMonth() + 1}月${d.getDate()}日`
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const EXACT: Record<string, string> = {
  '手动保存': 'Manual save', '自动保存': 'Auto save', '导入': 'Import', 'AI 操作前': 'Before AI', 'AI 操作后': 'After AI', '修订处理完': 'Changes reviewed', '恢复前': 'Before restore',
  // Folder page
  '空文件夹（把文档拖进来）': 'Empty folder (drag documents here)',
  '找不到这个文件夹，或者你没有权限打开它。': 'This folder could not be found, or you do not have permission to open it.',
  '这个文件夹还是空的。把侧栏里的文档拖进来，或用文档旁的“移动到…”。': 'This folder is empty. Drag documents here from the sidebar, or use “Move to…” next to a document.',
  '这里的 AI 能阅读并修改这个文件夹里的全部文档，例如"统一各篇的语气""检查前后的术语是否一致"。修改会以修订的形式出现在对应文档里，由你逐条确认。': 'The AI here can read and edit all documents in this folder, for example to make the tone consistent or check terminology across documents. Edits appear as changes in each document for you to review individually.',
  '没有可用的模型。请在"设置"里填写模型密钥。': 'No models available. Enter a model API key in "Settings".',
  '没有可编辑的文档': 'No editable documents',
  '文件夹名称': 'Folder name',
  '文件夹大纲': 'Folder outline',
  '给文件夹里的 AI 的指令': 'Instructions for the folder AI',
  '让 AI 处理整个文件夹…（Enter 发送）': 'Ask AI to work on the whole folder… (Enter to send)',
  '在单独页面中打开': 'Open on a separate page',
  '滚动到这里时加载内容…': 'Content loads when you scroll here…',
  '收起修订': 'Hide changes',
  '收起AI': 'Hide AI',
  '侧边面板': 'Side panel',
  // Search, trash, comments
  '搜索文档': 'Search documents',
  '回收站': 'Trash',
  '新建文件夹': 'New folder',
  '移动到…': 'Move to…',
  '还没有文件夹': 'No folders yet',
  '移到回收站': 'Move to trash',
  '30 天内可以在回收站恢复。': 'You can restore it from the trash within 30 days.',
  '其中的文档不会被删除，会移到文档列表。': 'Its documents are not deleted; they move to the document list.',
  '删除后无法恢复。': 'This cannot be undone.',
  '关闭提示': 'Dismiss notice',
  '查看回收站': 'View trash',
  '无标题': 'Untitled',
  '回收站中的文档会在 30 天后自动彻底删除。': 'Documents in the trash are permanently deleted after 30 days.',
  '回收站是空的。删除的文档会先放在这里。': 'The trash is empty. Deleted documents appear here first.',
  '删除于': 'Deleted',
  '彻底删除': 'Delete permanently',
  '加载失败': 'Failed to load',
  '刚刚': 'Just now',
  '有人': 'Someone',
  'AI 回复了你的评论': 'AI replied to your comment',
  '全部已读': 'Mark all read',
  '搜索中…': 'Searching…',
  '搜索所有文档的标题和正文…': 'Search titles and text in all documents…',
  '输入关键词，搜索你能看到的所有文档。': 'Type keywords to search every document you can see.',
  '搜索失败，请稍后再试。': 'Search failed. Please try again.',
  '没有找到相关文档。': 'No matching documents.',
  '搜索结果': 'Search results',
  'AI 助手': 'AI assistant',
  '请 AI 回复这条评论': 'Ask the AI to reply to this comment',
  '写下评论，@ 可提及他人或 AI': 'Write a comment; type @ to mention someone or the AI',
  '已请 AI 处理，回复会出现在这条评论下': 'The AI has been asked. Its reply will appear under this comment.',
  // Provider management
  '服务端版本过旧，请重新构建并重启桌面应用': 'The server build is out of date. Rebuild and restart the desktop app.',
  '未验证': 'unverified',
  '模型提供方': 'Model providers', '从目录添加提供方，配置密钥和可用模型，并查看余额和用量。': 'Add providers from the catalog, set keys and models, and check balance and usage.',
  '管理提供方…': 'Manage providers…', '默认提供方': 'Default provider', '没有可用的提供方': 'No providers available',
  '搜索提供方…': 'Search providers…', '已启用': 'Enabled', '已停用': 'Disabled', '添加提供方': 'Add provider', '设为默认': 'Set as default', '启用': 'Enabled',
  '概览': 'Overview', '用量': 'Usage', '端点': 'Endpoint', '就绪': 'Ready', '需要密钥': 'Needs a key', '已停用 ': 'Disabled',
  '选择模型': 'Choose models', '测试连接': 'Test connection', '测试': 'Test', '测试中…': 'Testing…', '没有启用的模型': 'No enabled models', '余额': 'Balance', '查询余额': 'Check balance',
  '用已保存的配置向模型发一条很短的请求。': 'Sends a very short request to the model using the saved configuration.',
  '这个服务没有可读取余额的接口。可以在“模型”里填写价格，到“用量”里看估算花费。': 'This service has no balance API. Enter prices under Models to see estimated spend under Usage.',
  '从接口获取模型': 'Fetch models from API', '获取中…': 'Fetching…', '手动添加模型 ID': 'Add a model ID manually', '筛选…': 'Filter…',
  '关闭开关的模型不会出现在选择列表里。': 'Models that are switched off do not appear in the pickers.', '启用 ': 'Enabled ', '输入价': 'Input price', '输出价': 'Output price', '显示名': 'Display name',
  '默认': 'Default', ' 未验证': ' unverified', '还没有模型。点“从接口获取模型”，或手动添加。': 'No models yet. Fetch them from the API, or add one manually.',
  '这个提供方最近 30 天没有用量。': 'No usage for this provider in the last 30 days.', '估算花费': 'Est. cost',
  'API 密钥': 'API key', 
  '内置提供方的端点是固定的。可以在“概览”里停用它，或在“模型”里增减模型。': 'The endpoint of a built-in provider is fixed. Switch it off at the top, or add and remove models under Models.',
  '价格币种符号': 'Currency symbol for prices', '价格币种符号（可选）': 'Currency symbol for prices (optional)', '删除这个提供方': 'Delete this provider',
  '添加提供方 ': 'Add provider', '任何兼容 OpenAI 接口的服务都可以添加。端点通常以 /v1 结尾。': 'Any service with an OpenAI-compatible API can be added. Endpoints usually end with /v1.',
  '还没有提供方。点“添加提供方”开始。': 'No providers yet. Click Add provider to start.', '有未保存的修改': 'Unsaved changes', '请填写名称和端点 ': 'Please enter a name and endpoint',
  '这个提供方没有启用的模型，先到“模型”里打开一个': 'This provider has no enabled models. Switch one on under Models first.',
  '搜索提供方': 'Search providers', '添加模型': 'Add model', '筛选模型': 'Filter models', '测试用模型': 'Model for testing',
  '已保存在应用里': 'Saved in the app', '来自本机 DSH 配置': 'From the local DSH config', '来自环境变量': 'From an environment variable', '未设置': 'Not set', '将在保存后生效': 'Takes effect after saving',
  '这个服务暂不支持查询余额。': 'This service does not support balance lookup.', '查询中…': 'Checking…',
  '）': ')', '（': ' (',
  '新建一篇，或把 Word、PDF、HTML、Markdown 文件拖到这里导入。': 'Create one, or drag a Word, PDF, HTML or Markdown file here to import it.',
  '文档保存在这台电脑上。': 'Documents are stored on this computer.',
  '加载中…': 'Loading…', '出错了': 'Something went wrong',
  'AI 的每一处修改都由你逐条确认。': 'Every change the AI makes waits for your decision.', '登录': 'Sign in', '显示已解决': 'Show resolved', '回复': 'Reply', '回复…': 'Reply…', '重新打开': 'Reopen', '解决': 'Resolve', '删除': 'Delete',
  '原文已删除：': 'Original text deleted: ',
  '还没有评论。选中一段文字，点工具栏里的"评论"。AI 也会把需要你决定的事写成评论。': 'No comments yet. Select some text and click "Comment" in the toolbar. The AI also leaves comments when it needs a decision from you.',
  '没有待处理的修订。AI 的修改、以及你在修订模式下的修改，会列在这里。': 'No pending changes. Changes by the AI, and yours made in tracked mode, are listed here.',
  '全部接受': 'Accept all', '全部拒绝': 'Reject all', '接受': 'Accept', '拒绝': 'Reject', '删除段落': 'Deleted paragraph', '新增段落': 'New paragraph',
  '接受这条修订': 'Accept this change', '拒绝这条修订': 'Reject this change',
  '进行中': 'Running', '完成': 'Done', '已取消': 'Cancelled', '出错': 'Error', '已中断': 'Interrupted',
  '达到步数上限，未完成': 'Step limit reached, unfinished', '输出被截断': 'Output was cut off', '模型拒绝了请求': 'The model refused the request',
  'AI 任务': 'AI task', '启动失败': 'Failed to start', '快捷操作': 'Quick action', '直接在下面回复即可。': 'Just reply below.',
  '没有可用的模型。请在首页的"设置"里填写模型密钥。': 'No model available. Add a model key in Settings on the home page.',
  '让 AI 修改这篇文档…（Enter 发送，Shift+Enter 换行）': 'Ask the AI to change this document… (Enter to send, Shift+Enter for a new line)',
  '模型或外部 Agent': 'Model or external agent', '外部 Agent（用它自己的模型）': 'External agents (use their own model)', '停止': 'Stop', '发送': 'Send',
  '新建文档': 'New document', '导入文件': 'Import file', '设置': 'Settings', '还没有文档。': 'No documents yet.', '导入预览': 'Import preview',
  '标题': 'Title', '取消': 'Cancel', '创建文档': 'Create document', '所有者': 'Owner', '可编辑': 'Can edit', '移除': 'Remove',
  '添加': 'Add', '关闭': 'Close', '（表格）': '(table)', '（图片）': '(image)',
  '导入失败': 'Import failed', '添加失败': 'Failed to add', '+ 行': '+ Row', '+ 列': '+ Column', '− 行': '− Row', '− 列': '− Column',
  '正文': 'Text', '普通段落': 'Plain paragraph', '标题 1': 'Heading 1', '标题 2': 'Heading 2', '标题 3': 'Heading 3', '# 空格': '# space', '## 空格': '## space', '### 空格': '### space',
  '无序列表': 'Bulleted list', '有序列表': 'Numbered list', '待办': 'To-do', '[] 空格': '[] space', '引用': 'Quote', '> 空格': '> space', '高亮块': 'Callout',
  '提示或备注': 'Tip or note', '代码块': 'Code block', '``` 空格': '``` space', '分割线': 'Divider', '表格': 'Table', '可编辑的简单表格': 'Simple editable table',
  '图片': 'Image', '从电脑选择': 'Choose from computer', '提示': 'Tip', '代码': 'Code',
  '给这个版本起个名字（可留空）': 'Name this version (optional)', '当前文档': 'Current document', '恢复失败': 'Restore failed', '版本名称': 'Version name',
  '版本标签不能超过 200 字': "Version label can't exceed 200 characters",
  '自上个版本以来没有改动，未保存新版本。': 'Nothing has changed since the last version, so no new version was saved.',
  '保存当前版本': 'Save current version', '对比所选两个版本': 'Compare the two selected versions', '与当前文档对比': 'Compare with current document', '勾选版本以对比': 'Tick versions to compare',
  '还没有版本。AI 操作前后、导入后会自动保存，也可以手动保存。': 'No versions yet. They are saved automatically around AI runs and imports, and you can save one by hand.',
  '命名': 'Rename', '恢复': 'Restore', '版本历史': 'Version history', '版本对比': 'Compare versions', '只看有变化的段落': 'Only changed paragraphs',
  '默认模型': 'Default model', '没有可用的模型': 'No models available', '（未验证）': ' (unverified)',
  '模型分工': 'Model roles', '识图模型': 'Vision model', '图片生成模型': 'Image generation model', '改图模型': 'Image editing model', '语音转写模型': 'Transcription model', '图表生成模型': 'Diagram generation model',
  '图片描述、AI 看图、扫描版 PDF 识别': 'Image descriptions, AI vision and scanned PDF recognition',
  'AI 生成图片': 'AI image generation', 'AI 改图': 'AI image editing', '视频转文字稿和字幕': 'Video transcripts and subtitles',
  'Mermaid、公式、draw.io 的 AI 生成（自动 = 跟随默认模型）': 'AI generation of Mermaid, formulas and draw.io (automatic = use the default model)',
  '自动': 'Automatic', '模型分工暂时不可用': 'Model roles are temporarily unavailable',
  '文字': 'Text', '识图': 'Vision', '生图': 'Image generation', '改图': 'Image editing', '转写': 'Transcription',
  '"未验证"表示这个模型还没有通过编辑评测，可以用，但工具调用的可靠性没有保证。': '"Unverified" means the model has not passed the editing eval. You can use it, but tool-call reliability is not guaranteed.',
  '写作偏好': 'Writing preferences', '例如：不用被动句；术语统一用“修订”而不是“更改”': 'e.g. avoid passive voice; always say "suggestion", not "edit"',
  '模型密钥': 'Model keys', '密钥只保存在服务端，保存后不会再显示。留空表示不修改。没有填写时，会使用环境变量或本机 DSH 配置里的密钥。': 'Keys are stored on the server only and are not shown again. Leave blank to keep as is. If empty, environment variables or the local DSH config are used.',
  '自定义模型': 'Custom models', '可以添加任何兼容 OpenAI 接口的服务，例如 opencode-go、Ollama 或自建服务。端点通常以 /v1 结尾。模型 ID 每行一个，也可以写成“模型ID=显示名”。保存后生效。': 'You can add any service with an OpenAI-compatible API, such as opencode-go, Ollama or a self-hosted server. Endpoints usually end with /v1. One model ID per line; you can also write "model-id=Display name". Takes effect after saving.',
  '还没有自定义模型。': 'No custom models yet.', '编辑': 'Edit', '添加提供商': 'Add provider', '确定': 'OK', '名称': 'Name', '密钥': 'Key', '（已保存）': '(saved)',
  '端点（如 https://host/v1）': 'Endpoint (e.g. https://host/v1)', '留空表示不修改': 'Leave blank to keep as is', '本机服务可以留空': 'Can be left blank for local services',
  '模型 ID（每行一个，可写成 模型ID=显示名）': 'Model IDs (one per line; you can write model-id=Display name)', '保存失败': 'Save failed',
  '请填写名称和端点': 'Please enter a name and endpoint', '至少填写一个模型 ID': 'Enter at least one model ID',
  '外部 Agent': 'External agents',
  '外部 Agent 是你电脑上已安装的编程助手。它们使用自己的模型、密钥和计费，对文档的修改会作为建议等你确认。命令会直接在这台电脑上运行（不经过 shell），请只添加你信任的程序。': 'External agents are coding assistants installed on this computer. They use their own model, keys and billing, and their edits to the document arrive as suggestions for you to confirm. Commands run directly on this computer (not through a shell), so only add programs you trust.',
  '命令': 'Command', '来源': 'Source', '状态': 'Status', '内置': 'Built-in', '自定义': 'Custom', '已安装': 'Installed', '未安装': 'Not installed', '保存后检测': 'Checked after saving',
  '参数（每行一个）': 'Arguments (one per line)', '例如：my-agent 或 /usr/local/bin/my-agent': 'e.g. my-agent or /usr/local/bin/my-agent', '例如：My Agent': 'e.g. My Agent',
  '请填写名称和命令': 'Please enter a name and command', '添加 Agent': 'Add agent',
  'AI 用量': 'AI usage', '最近 30 天没有用量。': 'No usage in the last 30 days.',
  '日期': 'Date', '模型': 'Model', '次数': 'Runs', '输入': 'Input', '输出': 'Output', '已保存': 'Saved', '保存': 'Save',
  '两边内容相同。': 'Both sides are identical.', '仅格式变化': 'Formatting only', '未命名文档': 'Untitled document', '我': 'Me',
  '输入内容，或输入 / 选择块类型': 'Type something, or type / to pick a block type', '上传失败': 'Upload failed', '操作失败': 'Action failed',
  '找不到这篇文档，或者你没有权限打开它。': 'This document does not exist, or you do not have access.', '返回文档列表': 'Back to documents', '← 文档': '← Documents',
  '文档标题': 'Document title', '已同步': 'Synced', '连接中…': 'Connecting…', '连接中': 'Connecting', '离线，修改已保存在本机': 'Offline, changes are saved locally',
  '视图': 'View', '行内修订': 'Inline', '左右对比': 'Side by side', '修改稿': 'Revised', '原文': 'Original', '修订模式': 'Track changes', '搜索操作…': 'Search actions…', '搜索操作': 'Search actions', '没有匹配的操作': 'No matching actions', '块': 'Block', '转换成': 'Turn into', '创建副本': 'Duplicate', '上移': 'Move up', '下移': 'Move down', '当前': 'Current', 'AI 修改这一段': 'Ask AI to edit this block', '加入 AI 对话': 'Add to AI chat', '自定义指令…': 'Custom instruction…', '点击打开菜单，拖动移动这一段': 'Click for menu, drag to move', '加粗': 'Bold', '斜体': 'Italic', '下划线': 'Underline', '删除线': 'Strikethrough', '行内代码': 'Inline code', '让 AI 修改选中的内容': 'Ask AI to edit the selection', 'AI 修改': 'Ask AI', '收起 AI': 'Hide AI', '目录': 'Outline',
  '目录：一直显示（点击改为悬停显示）': 'Outline: always shown (click to show on hover)', '目录：悬停显示（点击改为一直显示）': 'Outline: shown on hover (click to always show)', '还没有标题。用 # 或 / 插入标题后，这里会出现目录。': 'No headings yet. Add one with # or / and the outline appears here.', '引用评论或段落': 'Mention a comment or paragraph', '发送（Enter）': 'Send (Enter)',
  '修订模式已开启：你的修改会记为修订，确认后才生效': 'Track changes on: your edits are recorded as changes and apply once accepted',
  '修订模式已关闭：直接修改正文。点击开启后修改会留痕': 'Track changes off: you edit the text directly. Turn on to record your edits',
  '上一处修订': 'Previous change', '下一处修订': 'Next change', '导出': 'Export', 'Markdown（按原文）': 'Markdown (original)', 'HTML（按原文）': 'HTML (original)', 'Word（按原文）': 'Word (original)', '文档包（含全部版本）': 'Package (all versions)',
  '正在打开文档…': 'Opening document…', '只看有修订的段落': 'Only paragraphs with changes', '评论': 'Comment', '修订': 'Changes', '版本': 'Versions',
  '写下评论': 'Write a comment', '告诉 AI 怎么改选中的内容': 'Tell the AI how to change the selection', '高亮': 'Highlight', '更多 AI 操作': 'More AI actions', '更多…': 'More…', '自定义…': 'Custom…',
  '拖动以移动这一段（也可以用 Alt+↑/↓）': 'Drag to move this block (or use Alt+↑/↓)', '权限': 'Permission', '创建链接': 'Create link', '已复制': 'Copied', '复制': 'Copy', '撤销': 'Revoke',
  'AI 续写': 'AI continue', '接着上文往下写': 'Continue from the text above',
  }

Object.assign(EXACT, {
  '当前内容会先保存为一个版本，不会丢失。': 'Your current content will be saved as a version first.',
  'AI 任务运行中，暂不能恢复': 'Wait for the AI task to finish before restoring a version.',
  '文档内容和待确认的修改不会受影响。': 'Document content and pending changes won’t be affected.',
  '新对话': 'New chat', '切换对话': 'Switch chat', '删除对话': 'Delete chat',
  '导出时包含视频？': 'Include videos in the export?', '包含视频': 'Include videos', '不含视频': 'Skip videos',
  '放弃未保存的修改？': 'Discard unsaved changes?', '关闭后，图表中未保存的修改将丢失。': 'Unsaved changes to the diagram will be lost.',
  '放弃修改': 'Discard changes', 'draw.io 编辑器': 'draw.io editor',
  '我的文档': 'My documents', '提及': 'Mention', '无法连接本机服务，请重启应用': 'Cannot reach the local service. Restart the app.',
  '- 空格': '- space', '1. 空格': '1. space', '侧栏': 'Sidebar', '打开侧栏': 'Open sidebar', '收起侧栏': 'Collapse sidebar', '文档': 'Documents', '面板': 'Panel', '打开面板': 'Open panel', '收起面板': 'Collapse panel',
  '浏览器插件': 'Browser clipper', '管理已连接的 Stetpad 网页剪藏插件。撤销后，对应浏览器插件需重新配对才能访问文档。': 'Manage connected Stetpad web clippers. Revoked extensions must re-pair before accessing documents.',
  '创建时间': 'Created', '最近使用': 'Last used', '生成连接码': 'Generate connection code', '生成连接码失败': 'Failed to generate connection code', '撤销失败': 'Failed to revoke',
  '插件连接码': 'Clipper connection code', '连接码只显示一次，粘贴到浏览器插件即可完成绑定。': 'Shown only once. Paste this code into the browser extension to finish connecting.',
  '进入文档列表': 'Go to documents', '当前环境：本机桌面端': 'Environment: Local desktop app',
})

const PATTERNS: [RegExp, (...m: string[]) => string][] = [
  [/^文档标题：(.*)$/, (_, title) => `Document title: ${title}`],
  [/^单独打开 (.*)$/, (_, title) => `Open ${title} separately`],
  [/^共 (\d+) 篇$/, (_, n) => `${n} ${n === '1' ? 'document' : 'documents'}`],
  [/^(\d+) 处修订$/, (_, n) => `${n} ${n === '1' ? 'change' : 'changes'}`],
  [/^自动（当前：(.*)）$/, (_, model) => `Automatic (current: ${model})`],
  [/^模型分工暂时不可用：(.*)$/s, (_, error) => `Model roles are temporarily unavailable: ${error}`],
  [/^没有可用的模型：在模型提供方里给模型勾选"(.*)"能力$/, (_, cap) => `No models available: enable the "${EXACT[cap] ?? cap}" capability for a model under Model providers`],
  [/^无法删除"(.*)"。$/, (_, t) => `Can't delete "${t}".`],
  [/^删除文件夹"(.*)"？$/, (_, t) => `Delete folder "${t}"?`],
  [/^永久删除"(.*)"？$/, (_, t) => `Permanently delete "${t}"?`],
  [/^删除文件夹 (.*)$/, (_, t) => `Delete folder ${t}`],
  [/^移动 (.*)$/, (_, t) => `Move ${t}`],
  [/^重命名 (.*)$/, (_, t) => `Rename ${t}`],
  [/^文件夹 (.*)$/, (_, t) => `Folder ${t}`],
  [/^把"(.*)"移到回收站？$/, (_, t) => `Move "${t}" to the trash?`],
  [/^"(.*)" 已移到回收站$/, (_, t) => `"${t}" moved to the trash`],
  [/^(\d+) 分钟前$/, (_, n) => `${n} min ago`],
  [/^(\d+) 小时前$/, (_, n) => `${n} h ago`],
  [/^(\d+) 天前$/, (_, n) => `${n} d ago`],
  [/^(.+) 回复了你的评论$/, (_, a) => `${EXACT[a] ?? a} replied to your comment`],
  [/^目前有 (\d+) 个提供方可用，(\d+) 个模型已启用。$/, (_, a, b) => `${a} providers ready, ${b} models enabled.`],
  [/^(\d+) 个已启用，共 (\d+) 个 ?$/, (_, a, b) => `${a} enabled of ${b} `],
  [/^从接口读取到 (\d+) 个模型，新增 (\d+) 个。$/, (_, a, b) => `Read ${a} models from the API, ${b} new.`],
  [/^连接正常，耗时 (\d+) ms$/, (_, n) => `Connection OK, ${n} ms`],
  [/^最近 30 天共 (.*) token(?:，估算花费 (.*))?。$/, (_, n, c) => `${n} tokens in the last 30 days${c ? `, estimated spend ${c}` : ''}.`],
  [/^余额（(.*)）$/, (_, c) => `Balance (${c})`], [/^赠送余额（(.*)）$/, (_, c) => `Granted (${c})`], [/^充值余额（(.*)）$/, (_, c) => `Topped up (${c})`],
  [/^累计充值（\$）$/, () => 'Total credits ($)'], [/^累计消耗（\$）$/, () => 'Total used ($)'], [/^余额（\$）$/, () => 'Balance ($)'],
  [/^价格为每百万 token（(.*)），填写后“用量”里会估算花费。$/, (_, c) => `Prices are per million tokens (${c}); with prices set, Usage shows an estimated spend.`],
  [/^密钥只保存在服务端，保存后不会再显示。留空表示不修改。当前：(.*)。(.*)$/, (_, a, b) => `Keys are stored on the server only and are not shown again. Leave blank to keep as is. Current: ${EXACT[a] ?? a}.${b ? ' If empty, environment variables or the local DSH config are used.' : ''}`],
  [/^修订 (\d+)$/, (_, n) => `Changes ${n}`], [/^评论 (\d+)$/, (_, n) => `Comments ${n}`],
  [/^条未解决$/, () => 'unresolved'], [/^条待处理$/, () => 'pending'], [/^个段落有修订$/, () => 'paragraphs with changes'],
  [/^删除"(.*)"？此操作不可恢复。$/s, (_, t) => `Delete "${t}"? This cannot be undone.`],
  [/^删除 (.*)$/, (_, t) => `Delete ${t}`], [/^正在解析 (.*)…$/, (_, t) => `Parsing ${t}…`],
  [/^恢复到"(.*)"？$/s, (_, title) => `Restore "${title}"?`],
  [/^删除对话"(.*)"？$/s, (_, title) => `Delete chat "${title === '新对话' ? EXACT[title] : title}"?`],
  [/^文档包含 (\d+) 个视频（共 ([\d.]+) MB）。图片始终会导出。$/, (_, n, mb) => `This document contains ${n} ${n === '1' ? 'video' : 'videos'} (${mb} MB total). Images are included either way.`],
  [/^共 (\d+) 个段落。$/, (_, n) => `${n} blocks.`],
  [/^第 ([\d, ]+) 页没有可提取的文字，已跳过。这些页面超过了 40 页识别上限，请拆分 PDF 后重试。$/, (_, pages) => `Pages ${pages} have no extractable text and were skipped because they exceed the 40-page recognition limit. Split the PDF and try again.`],
  [/^第 ([\d, ]+) 页没有可提取的文字，已跳过。配置支持图像的模型后可识别这些页面。$/, (_, pages) => pages.includes(',')
    ? `Pages ${pages} have no extractable text and were skipped. Configure a vision model to recognize these pages.`
    : `Page ${pages} has no extractable text and was skipped. Configure a vision model to recognize this page.`],
  [/^导入最多保留前 (\d+) 个段落。继续创建将省略最后 (\d+) 个段落。$/, (_, limit, omitted) => `This import can keep only the first ${limit} blocks. Creating the document will omit the last ${omitted} ${omitted === '1' ? 'block' : 'blocks'}.`],
  [/^PDF 导入最多保留前 (\d+) 页。继续创建将省略最后 (\d+) 页。$/, (_, limit, omitted) => `This PDF import can keep only the first ${limit} pages. Creating the document will omit the last ${omitted} ${omitted === '1' ? 'page' : 'pages'}.`],
  [/^导入内容超过 (\d+) 个段落，请拆分后重试。$/, (_, limit) => `The import exceeds ${limit} blocks. Split the file and try again.`],
  [/^原文档的排版不会保留，内容已整理成下面的简单格式。(?:共 (\d+) 个段落。)?$/, (_, n) => `The original layout is not kept; the content was normalised into the simple format below.${n === undefined ? '' : ` ${n} blocks.`}`],
  [/^……其余 (\d+) 段未显示$/, (_, n) => `…${n} more blocks not shown`],
  [/^(\d+) 字$/, (_, n) => `${n} words`], [/^ ?字$/, () => ' chars'],
  [/^　?(\d+) 处未应用（文字已被改动）$/, (_, n) => `${n} not applied (text had changed)`], [/^　失败：(.*)$/, (_, e) => ` Failed: ${e}`],
  [/^AI 想问你：$/, () => 'The AI asks: '], [/^接受 (\d+) 处$/, (_, n) => `Accept ${n}`],
  [/^今天已用 (.*) token$/, (_, n) => `Used today: ${n} tokens`],
  [/^首选模型出错，已改用备用模型（(.*)）$/, (_, m) => `Preferred model failed; switched to fallback (${m})`],
  [/^（按修改稿）$/, () => ' (revised)'], [/^PDF（打印）$/, () => 'PDF (print)'], [/^（已保存）$/, () => ' (saved)'],
  [/^由外部 Agent「(.*)」执行/, (m, a) => m.replace(/^由外部 Agent「.*」/, `Run by external agent "${a}" `)],
]

/** Interface text in the current language (for places the DOM translator does not reach, such as the tab title). */
export function t(zh: string): string {
  return getLang() === 'zh' ? zh : tr(zh)
}

function tr(raw: string): string {
  const s = raw.trim()
  if (!s || !/[一-鿿　-〿＀-￯]/.test(s)) return raw
  const lead = raw.slice(0, raw.length - raw.trimStart().length)
  const trail = raw.slice(raw.trimEnd().length)
  const hit = EXACT[s]
  if (hit !== undefined) return lead + hit + trail
  for (const [re, f] of PATTERNS) {
    const m = s.match(re)
    if (m) return lead + f(...(m as unknown as string[])) + trail
  }
  return raw
}

const ATTRS = ['placeholder', 'aria-label', 'title', 'label']
const SKIP = '[translate="no"], .ProseMirror, .chat-body, .md, .doc-text, [data-i18n-skip]'

function walk(root: Node): void {
  if (root.nodeType === Node.TEXT_NODE) {
    const p = root.parentElement
    if (p && !p.closest(SKIP) && !['SCRIPT', 'STYLE', 'TEXTAREA'].includes(p.tagName)) {
      const v = root.nodeValue ?? ''
      const tab = p.closest('[role=tab]') && v.trim().startsWith('评论')
      const t = tab ? v.replace('评论', 'Comments') : tr(v)
      if (t !== v) root.nodeValue = t
    }
    return
  }
  if (!(root instanceof Element)) return
  if (root.closest(SKIP)) return
  for (const a of ATTRS) {
    const v = root.getAttribute(a)
    if (v) {
      const t = tr(v)
      if (t !== v) root.setAttribute(a, t)
    }
  }
  root.childNodes.forEach(walk)
}

export function initI18n(): void {
  const lang = getLang()
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  const btn = document.createElement('button')
  btn.className = 'lang-toggle'
  btn.textContent = lang === 'zh' ? 'EN' : '中文'
  btn.title = lang === 'zh' ? 'English' : '中文'
  btn.setAttribute('aria-label', 'Language')
  btn.onclick = () => setLang(lang === 'zh' ? 'en' : 'zh')
  btn.className = 'lang-toggle'
  // Theme and language buttons share one floating group.
  let tools = document.querySelector('.floating-tools')
  if (!tools) {
    tools = document.createElement('div')
    tools.className = 'floating-tools'
    document.body.appendChild(tools)
  }
  const theme = document.createElement('button')
  theme.textContent = '◐'
  theme.title = lang === 'zh' ? '切换浅色 / 深色' : 'Toggle light / dark'
  theme.setAttribute('aria-label', theme.title)
  theme.onclick = toggleTheme
  tools.append(theme, btn)
  if (lang === 'zh') return
  const w = window as unknown as Record<string, (m?: string, d?: string) => unknown>
  for (const fn of ['alert', 'confirm', 'prompt'] as const) {
    const orig = w[fn]!.bind(window)
    w[fn] = (m?: string, d?: string) => orig(m === undefined ? m : tr(String(m)), d)
  }
  const root = document.getElementById('root')!
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'characterData') walk(m.target)
      else if (m.type === 'attributes') walk(m.target)
      else m.addedNodes.forEach(walk)
    }
  }).observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS })
  walk(root)
}
