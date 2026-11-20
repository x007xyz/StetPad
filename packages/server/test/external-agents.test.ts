import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startServer, type RunningServer } from '../src'

const FAKE_AGENT = join(__dirname, 'fake-acp-agent.mjs')
const MCP_BRIDGE = { command: process.execPath, args: ['--import', 'tsx', join(__dirname, '../src/mcp.ts')] }
const LOCAL_TOKEN = 'local-test-token-4417'

/** An agent as the Settings dialog submits it. The fake agent stands in for a real ACP program. */
const agent = (over: Record<string, unknown> = {}) => ({
  id: 'my-agent',
  label: 'My Agent',
  command: process.execPath,
  args: [FAKE_AGENT],
  ...over,
})

type Known = { id: string; label: string; command: string; args: string[]; installed: boolean; builtin: boolean }
type ModelsBody = { externalAgents: { id: string; label: string }[]; externalAgentsAll?: Known[] }

describe('external agents', () => {
  let server: RunningServer
  let dir: string
  let base = ''
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(base + path, {
      ...init,
      headers: { authorization: `Bearer ${LOCAL_TOKEN}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
    })
    return { status: res.status, body: (await res.json()) as Record<string, any> }
  }
  const put = (externalAgents: unknown) => call('/api/settings', { method: 'PUT', body: JSON.stringify({ externalAgents }) })
  const models = async () => (await call('/api/models')).body as ModelsBody
  const start = async () => {
    server = await startServer({ dataDir: dir, port: 0, token: LOCAL_TOKEN, mcpCommand: MCP_BRIDGE })
    base = `http://127.0.0.1:${server.port}`
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aiw-ext-'))
    await start()
  })
  afterAll(async () => {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('rejects an invalid list with a message and saves nothing', async () => {
    const bad: [string, unknown][] = [
      ['not a list', { id: 'x' }],
      ['bad id', [agent({ id: 'Bad_ID' })]],
      ['built-in id', [agent({ id: 'dsh' })]],
      ['duplicate id', [agent(), agent({ label: 'Again' })]],
      ['empty label', [agent({ label: '   ' })]],
      ['long label', [agent({ label: 'x'.repeat(61) })]],
      ['empty command', [agent({ command: '' })]],
      ['command with NUL', [agent({ command: 'node\u0000' })]],
      ['command starting with a dash', [agent({ command: '--help' })]],
      ['args not a list', [agent({ args: 'acp' })]],
      ['too many args', [agent({ args: Array.from({ length: 21 }, () => 'a') })]],
      ['arg not a string', [agent({ args: [1] })]],
      ['too many agents', Array.from({ length: 21 }, (_, i) => agent({ id: `a${i}` }))],
    ]
    for (const [name, value] of bad) {
      const res = await put(value)
      expect(res.status, name).toBe(400)
      expect(typeof res.body.error, name).toBe('string')
    }
    expect((await models()).externalAgentsAll?.filter((a) => !a.builtin)).toEqual([])
  })

  it('saves a custom agent and lists it with its installed state', async () => {
    const ghost = agent({ id: 'ghost', label: 'Ghost', command: 'aiw-no-such-agent-7731', args: [] })
    expect((await put([agent(), ghost, agent({ id: 'node-agent', label: 'Node', command: 'node', args: ['-e', '0'] })])).status).toBe(200)
    const body = await models()
    const all = body.externalAgentsAll!
    expect(all.find((a) => a.id === 'dsh')).toMatchObject({ builtin: true, command: 'dsh' })
    expect(all.find((a) => a.id === 'my-agent')).toMatchObject({ label: 'My Agent', builtin: false, installed: true, args: [FAKE_AGENT] })
    expect(all.find((a) => a.id === 'ghost')).toMatchObject({ builtin: false, installed: false })
    expect(all.find((a) => a.id === 'node-agent')).toMatchObject({ command: 'node', installed: true, args: ['-e', '0'] })
    // Only installed agents are offered in the Ai panel.
    expect(body.externalAgents.map((a) => a.id)).toEqual(expect.arrayContaining(['my-agent', 'node-agent']))
    expect(body.externalAgents.map((a) => a.id)).not.toContain('ghost')
  })

  it('a list left out of a save is removed', async () => {
    expect((await put([agent()])).status).toBe(200)
    expect((await models()).externalAgentsAll!.filter((a) => !a.builtin).map((a) => a.id)).toEqual(['my-agent'])
    expect((await put([])).status).toBe(200)
    expect((await models()).externalAgentsAll!.filter((a) => !a.builtin)).toEqual([])
  })

  it('starts a user-registered agent through external-runs and receives its edits as suggestions', async () => {
    expect((await put([agent()])).status).toBe(200)
    const id = (await call('/api/import/create', { method: 'POST', body: JSON.stringify({ title: 'user agent', blocks: [{ type: 'paragraph', attrs: {}, delta: [{ insert: 'The quick brown fox.' }] }] }) })).body.id as string

    const started = await call(`/api/docs/${id}/external-runs`, { method: 'POST', body: JSON.stringify({ agent: 'my-agent', prompt: 'make it faster' }) })
    expect(started.status).toBe(200)
    let run: { status: string; text: string; steps: string[]; agent: string; error?: string } = { status: 'running', text: '', steps: [], agent: '' }
    const deadline = Date.now() + 20_000
    while (run.status === 'running') {
      if (Date.now() > deadline) throw new Error('external run did not end')
      await new Promise((r) => setTimeout(r, 50))
      run = (await call(`/api/external-runs/${started.body.id}`)).body as typeof run
    }
    expect(run).toMatchObject({ status: 'done', agent: 'My Agent', text: 'Replaced one word.' })
    expect(run.steps).toContain('document_replace_block')
  }, 30_000)

  it('refuses to start an agent that is not installed', async () => {
    expect((await put([agent({ id: 'ghost', label: 'Ghost', command: 'aiw-no-such-agent-7731', args: [] })])).status).toBe(200)
    const id = (await call('/api/import/create', { method: 'POST', body: JSON.stringify({ title: 'ghost', blocks: [{ type: 'paragraph', attrs: {}, delta: [{ insert: 'Text.' }] }] }) })).body.id as string
    const res = await call(`/api/docs/${id}/external-runs`, { method: 'POST', body: JSON.stringify({ agent: 'ghost', prompt: 'hi' }) })
    expect(res.status).toBe(409)
    expect(res.body.error).toContain('没有找到这个 Agent')
  })

  it('keeps the saved list across a restart', async () => {
    expect((await put([agent()])).status).toBe(200)
    await server.close()
    await start()
    expect((await models()).externalAgentsAll!.find((a) => a.id === 'my-agent')).toMatchObject({ label: 'My Agent', builtin: false })
  })
})
