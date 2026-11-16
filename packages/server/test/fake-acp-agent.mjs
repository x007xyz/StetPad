// A stand-in for a real ACP agent (DSH, Pi, ...). It speaks the protocol,
// connects to the MCP server it is given, and makes one edit. No model involved.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createInterface } from 'node:readline'

const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
let mcp = null
let nextId = 1000
const waiting = new Map()

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue
  const msg = JSON.parse(line)
  if (msg.method === 'initialize') send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } })
  else if (msg.method === 'session/new') {
    const s = msg.params.mcpServers[0]
    mcp = new Client({ name: 'fake-agent', version: '0' })
    await mcp.connect(new StdioClientTransport({ command: s.command, args: s.args, env: { ...process.env, ...Object.fromEntries(s.env.map((e) => [e.name, e.value])) } }))
    send({ id: msg.id, result: { sessionId: 's1' } })
  } else if (msg.method === 'session/prompt') {
    const update = (u) => send({ method: 'session/update', params: { sessionId: 's1', update: u } })
    void (async () => {
      update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'document_read' })
      const read = await mcp.callTool({ name: 'document_read', arguments: {} })
      const blockId = read.content[0].text.match(/\[([\w-]+)\]/)[1]
      // Ask before editing, as real agents do.
      const permId = nextId++
      const allowed = new Promise((resolve) => waiting.set(permId, resolve))
      send({ id: permId, method: 'session/request_permission', params: { sessionId: 's1', toolCall: { toolCallId: 't2' }, options: [{ optionId: 'no', name: 'Reject', kind: 'reject_once' }, { optionId: 'yes', name: 'Allow', kind: 'allow_once' }] } })
      const outcome = await allowed
      if (outcome?.outcome?.optionId === 'yes') {
        update({ sessionUpdate: 'tool_call', toolCallId: 't2', title: 'document_replace_block' })
        await mcp.callTool({ name: 'document_replace_block', arguments: { block_id: blockId, content: 'The fast brown fox.' } })
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Replaced one word.' } })
      }
      await mcp.close()
      send({ id: msg.id, result: { stopReason: 'end_turn' } })
    })()
  } else if (msg.id !== undefined && waiting.has(msg.id)) {
    waiting.get(msg.id)(msg.result)
    waiting.delete(msg.id)
  }
}
