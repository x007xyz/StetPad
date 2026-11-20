import { projectBlocks } from '@stetpad/crdt'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as Y from 'yjs'
import { z } from 'zod'
import { DocTools } from './tools'

/**
 * MCP server for external agents (Claude Code, Codex, Pi, DSH, ...).
 *
 * It joins one document as a collaborator and exposes the same tool layer
 * the built-in agent uses, so whatever an external agent writes arrives as
 * pending suggestions attributed to it. It can read and propose; it cannot
 * accept or reject.
 *
 *   tsx src/mcp.ts --url http://127.0.0.1:8787 --token <token> --doc <id> [--author "Pi"]
 *
 * `--token` is the desktop app's local token or a browser clipper token (`clp_...`).
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const url = arg('url') ?? process.env.AIW_URL
const token = arg('token') ?? process.env.AIW_TOKEN
const docId = arg('doc') ?? process.env.AIW_DOC
const author = arg('author') ?? process.env.AIW_AUTHOR ?? 'External agent'
if (!url || !token || !docId) {
  console.error('usage: mcp --url <server> --token <token> --doc <document id> [--author <name>]')
  process.exit(2)
}

const doc = new Y.Doc()
const provider = new HocuspocusProvider({
  url: url.replace(/^http/, 'ws').replace(/\/$/, '') + '/collab',
  name: docId,
  document: doc,
  token,
})
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('timed out connecting to the document')), 15_000)
  provider.on('synced', () => {
    clearTimeout(timer)
    resolve()
  })
  provider.on('authenticationFailed', () => {
    clearTimeout(timer)
    reject(new Error('access to the document was refused'))
  })
})

const tools = new DocTools(doc, { author, runId: `mcp-${Date.now()}` })
const server = new McpServer({ name: 'stetpad', version: '0.1.0' })
const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
})
const reason = z.string().optional().describe('One short sentence on why this change helps')
const NOTE = ' Blocks are written as `[block_id] content`; headings use #, lists use -, 1. or - [ ], quotes use >, code uses a fence with a language (```mermaid, ```drawio), math uses $$ lines, images use ![alt](src "caption"), videos use !video[title](src), attachments use !file[name](src), link cards use !link[title](url). Every edit becomes a pending suggestion for the user to accept or reject.'

server.registerTool('document_outline', { description: 'Headings and section sizes of the document.' + NOTE, inputSchema: {} }, async () => text(tools.getOutline()))
server.registerTool(
  'document_read',
  { description: 'Read blocks by id, by range (from/to), or the whole document when no argument is given.', inputSchema: { block_ids: z.array(z.string()).optional(), from: z.string().optional(), to: z.string().optional() } },
  async (a) => text(tools.readBlocks(a)),
)
server.registerTool('document_search', { description: 'Find blocks containing a phrase.', inputSchema: { query: z.string() } }, async (a) => text(tools.searchDocument(a.query)))
server.registerTool('document_changes', { description: 'Pending suggestions in the document.', inputSchema: {} }, async () => text(tools.listChanges()))
server.registerTool(
  'document_replace_block',
  { description: 'Propose new content for one block (the complete block).', inputSchema: { block_id: z.string(), content: z.string(), reason } },
  async (a) => text(tools.replaceBlock(a.block_id, a.content, a.reason)),
)
server.registerTool(
  'document_edit_text',
  { description: 'Propose replacing a phrase that occurs exactly once in a block.', inputSchema: { block_id: z.string(), old_text: z.string(), new_text: z.string(), reason } },
  async (a) => text(tools.editText(a.block_id, a.old_text, a.new_text, a.reason)),
)
server.registerTool(
  'document_insert_blocks',
  { description: 'Propose new blocks after a block (null inserts at the top).', inputSchema: { after_block_id: z.string().nullable(), blocks: z.array(z.string()).min(1), reason } },
  async (a) => text(tools.insertBlocks(a.after_block_id, a.blocks, a.reason)),
)
server.registerTool('document_delete_block', { description: 'Propose deleting a block.', inputSchema: { block_id: z.string(), reason } }, async (a) => text(tools.deleteBlock(a.block_id, a.reason)))
server.registerTool(
  'document_add_footnote',
  { description: 'Attach a footnote to a phrase that occurs exactly once in a block. The note is listed at the end of the document. Use it for footnotes, citations or sources.', inputSchema: { block_id: z.string(), phrase: z.string(), note: z.string() } },
  async (a) => text(tools.addFootnote(a.block_id, a.phrase, a.note)),
)
server.registerTool(
  'document_withdraw',
  { description: 'Take back suggestions you made, by change id.', inputSchema: { change_ids: z.array(z.string()).min(1) } },
  async (a) => text(tools.withdrawChanges(a.change_ids)),
)

void projectBlocks // the document is live: reads always reflect other people's edits
await server.connect(new StdioServerTransport())
const stop = (): void => {
  provider.destroy()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
process.stdin.on('close', stop)
