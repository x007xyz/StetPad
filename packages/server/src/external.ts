import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { accessSync, constants, statSync } from 'node:fs'
import type { Collab } from './collab'

/**
 * External agents over the Agent Client Protocol (ACP).
 *
 * The app starts an agent the user already has (DSH, Pi, Claude Code, Codex,
 * opencode), opens a session, and hands it one MCP server: this document's
 * tool layer. Whatever the agent does to the document therefore arrives as
 * pending suggestions. The agent uses its own model, keys and billing.
 *
 * ACP is JSON-RPC 2.0, one message per line, over the agent's stdio.
 */
export interface AgentDef {
  id: string
  label: string
  command: string
  args: string[]
}

const BUILT_IN: AgentDef[] = [
  { id: 'dsh', label: 'DSH', command: 'dsh', args: ['--profile', 'acp'] },
  { id: 'pi', label: 'Pi', command: 'pi-acp', args: [] },
  { id: 'claude', label: 'Claude Code', command: 'claude-agent-acp', args: [] },
  { id: 'codex', label: 'Codex', command: 'codex-acp', args: [] },
  { id: 'opencode', label: 'opencode', command: 'opencode', args: ['acp'] },
]
const BUILT_IN_IDS = new Set(BUILT_IN.map((b) => b.id))

/** Most agents one user can register in Settings. */
export const MAX_USER_AGENTS = 20
const USER_AGENT_ID = /^[a-z0-9-]{1,32}$/
const MAX_ARGS = 20

/**
 * Validates the complete list of user-registered agents sent from Settings.
 * Throws with a message for the user; nothing is partially accepted.
 */
export function parseAgentDefs(input: unknown): AgentDef[] {
  if (!Array.isArray(input)) throw new Error('外部 Agent 的格式不正确')
  if (input.length > MAX_USER_AGENTS) throw new Error(`最多只能添加 ${MAX_USER_AGENTS} 个外部 Agent`)
  const seen = new Set<string>()
  const out: AgentDef[] = []
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') throw new Error('外部 Agent 的格式不正确')
    const a = raw as Record<string, unknown>
    const id = typeof a.id === 'string' ? a.id : ''
    if (!USER_AGENT_ID.test(id)) throw new Error(`Agent ID「${id}」不合法：只能包含小写字母、数字和连字符，最多 32 个字符`)
    if (BUILT_IN_IDS.has(id)) throw new Error(`Agent ID「${id}」与内置的 Agent 重复`)
    if (seen.has(id)) throw new Error(`Agent ID「${id}」重复`)
    seen.add(id)
    const label = typeof a.label === 'string' ? a.label.trim() : ''
    if (!label || label.length > 60) throw new Error(`Agent「${id}」的名称不能为空，且不能超过 60 个字符`)
    const command = typeof a.command === 'string' ? a.command.trim() : ''
    // Spawned without a shell. A leading "-" would be read as an option by the PATH lookup.
    if (!command || command.length > 500 || command.includes('\0') || command.startsWith('-')) {
      throw new Error(`Agent「${label}」的命令不合法：不能为空，不能超过 500 个字符，不能以 - 开头`)
    }
    if (!Array.isArray(a.args)) throw new Error(`Agent「${label}」的参数格式不正确`)
    if (a.args.length > MAX_ARGS) throw new Error(`Agent「${label}」的参数最多 ${MAX_ARGS} 个`)
    for (const arg of a.args) {
      if (typeof arg !== 'string' || arg.length > 500 || arg.includes('\0')) throw new Error(`Agent「${label}」的参数不合法：每个参数都是不超过 500 个字符的文本`)
    }
    out.push({ id, label, command, args: [...(a.args as string[])] })
  }
  return out
}

/** The list as saved for a user. A stored value that no longer validates is treated as empty. */
export function parseStoredAgents(raw: string | null): AgentDef[] {
  if (!raw) return []
  try {
    return parseAgentDefs(JSON.parse(raw))
  } catch {
    return []
  }
}

/**
 * Built-in agents, the environment extras and the user's own list. The first
 * entry with an id wins, and a user entry can never take a built-in id.
 */
function agents(custom: AgentDef[] = []): AgentDef[] {
  let extra: AgentDef[] = []
  try {
    // Extra agents: AIW_ACP_AGENTS='[{"id":"x","label":"X","command":"...","args":[]}]'
    const parsed = JSON.parse(process.env.AIW_ACP_AGENTS ?? '[]')
    extra = Array.isArray(parsed) ? (parsed as AgentDef[]) : []
  } catch {
    extra = []
  }
  const all = [
    ...extra,
    ...BUILT_IN.filter((b) => !extra.some((e) => e.id === b.id)),
    ...custom.filter((c) => !BUILT_IN_IDS.has(c.id)),
  ]
  return all.filter((a, i) => all.findIndex((b) => b.id === a.id) === i)
}

/** A bare name is looked up on PATH; a path is checked directly. */
const onPath = (cmd: string): boolean => {
  if (/[\\/]/.test(cmd)) {
    try {
      accessSync(cmd, constants.X_OK)
      return statSync(cmd).isFile()
    } catch {
      return false
    }
  }
  return spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }).status === 0
}

export interface ExternalRun {
  id: string
  agent: string
  status: 'running' | 'done' | 'cancelled' | 'error'
  text: string
  steps: string[]
  error?: string
}

interface Live {
  run: ExternalRun
  child: ChildProcess
  cancel: () => void
}

export class ExternalAgents {
  private runs = new Map<string, Live>()
  private byDoc = new Map<string, string>()

  constructor(private collab: Collab) {}

  /** Agents on this machine that the user can start in the Ai panel. */
  available(custom: AgentDef[] = []): { id: string; label: string }[] {
    return agents(custom).filter((a) => onPath(a.command)).map(({ id, label }) => ({ id, label }))
  }

  /** Every agent the Settings page lists: the built-in ones and the user's own, installed or not. */
  all(custom: AgentDef[] = []): { id: string; label: string; command: string; args: string[]; installed: boolean; builtin: boolean }[] {
    return [...BUILT_IN, ...custom.filter((c) => !BUILT_IN_IDS.has(c.id))].map((a) => ({
      id: a.id,
      label: a.label,
      command: a.command,
      args: a.args,
      installed: onPath(a.command),
      builtin: BUILT_IN_IDS.has(a.id),
    }))
  }

  get(id: string): ExternalRun | null {
    return this.runs.get(id)?.run ?? null
  }

  cancel(id: string): boolean {
    const live = this.runs.get(id)
    if (!live || live.run.status !== 'running') return false
    live.cancel()
    return true
  }

  stopAll(): void {
    for (const l of this.runs.values()) l.child.kill()
  }

  /** `custom` is the calling user's own agent list. */
  async start(agentId: string, prompt: string, documentId: string, mcp: { command: string; args: string[]; env?: Record<string, string> }, custom: AgentDef[] = []): Promise<string> {
    const def = agents(custom).find((a) => a.id === agentId)
    if (!def || !onPath(def.command)) throw new Error('这台电脑上没有找到这个 Agent')
    const active = this.byDoc.get(documentId)
    if (active && this.runs.get(active)?.run.status === 'running') throw new Error('这篇文档已有一个外部 Agent 在运行')

    await this.collab.snapshot(documentId, 'before-ai', 'system').catch(() => {})
    const run: ExternalRun = { id: randomUUID(), agent: def.label, status: 'running', text: '', steps: [] }
    const child = spawn(def.command, def.args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
    let nextId = 1
    let sessionId: string | null = null
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
    const send = (msg: object): void => void child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
    const request = <T>(method: string, params: unknown): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const id = nextId++
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
        send({ id, method, params })
      })
    const finish = (status: ExternalRun['status'], error?: string): void => {
      if (run.status !== 'running') return
      run.status = status
      run.error = error
      child.kill()
      void this.collab.snapshot(documentId, 'after-ai', 'system').catch(() => {})
    }

    let buf = ''
    child.stdout!.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const lineText = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!lineText.startsWith('{')) continue
        let msg: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } }
        try {
          msg = JSON.parse(lineText)
        } catch {
          continue
        }
        if (msg.method === 'session/update') {
          const u = msg.params?.update as { sessionUpdate?: string; content?: { text?: string }; title?: string } | undefined
          if (u?.sessionUpdate === 'agent_message_chunk' && u.content?.text) run.text += u.content.text
          else if (u?.sessionUpdate === 'tool_call' && u.title) run.steps.push(u.title)
        } else if (msg.method === 'session/request_permission' && msg.id !== undefined) {
          // The only tools the agent was given are this document's, and they can only suggest.
          const options = (msg.params?.options as { optionId: string; kind?: string }[] | undefined) ?? []
          const allow = options.find((o) => o.kind?.startsWith('allow')) ?? options[0]
          send({ id: msg.id, result: { outcome: allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' } } })
        } else if (msg.method && msg.id !== undefined) {
          // File system, terminal and anything else: this client offers none of it.
          send({ id: msg.id, error: { code: -32601, message: 'not supported by this client' } })
        } else if (msg.id !== undefined && pending.has(msg.id)) {
          const p = pending.get(msg.id)!
          pending.delete(msg.id)
          if (msg.error) p.reject(new Error(msg.error.message ?? 'agent error'))
          else p.resolve(msg.result)
        }
      }
    })
    let stderr = ''
    child.stderr!.on('data', (c: Buffer) => (stderr = (stderr + c.toString('utf8')).slice(-2000)))
    child.on('error', (e) => finish('error', e.message))
    child.on('exit', (code) => {
      for (const p of pending.values()) p.reject(new Error('agent exited'))
      finish(run.status === 'running' ? 'error' : run.status, `Agent 进程退出（${code}）${stderr ? '：' + stderr.trim().split('\n').slice(-3).join(' ') : ''}`)
    })

    this.runs.set(run.id, {
      run,
      child,
      cancel: () => {
        if (sessionId) send({ method: 'session/cancel', params: { sessionId } })
        setTimeout(() => finish('cancelled'), 300)
      },
    })
    this.byDoc.set(documentId, run.id)

    void (async () => {
      try {
        await request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
        const env = Object.entries(mcp.env ?? {}).map(([name, value]) => ({ name, value }))
        const session = await request<{ sessionId: string }>('session/new', {
          cwd: process.cwd(),
          mcpServers: [{ name: 'stetpad', command: mcp.command, args: [...mcp.args, '--author', def.label], env }],
        })
        sessionId = session.sessionId
        const intro = 'You are editing a document through the "stetpad" MCP tools. Read it with document_read, and make every change with the document_* tools; do not use files or a shell. Each edit becomes a suggestion the user reviews. Finish with one sentence on what you changed.\n\nTask: '
        await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: intro + prompt }] })
        finish('done')
      } catch (err) {
        finish(run.status === 'cancelled' ? 'cancelled' : 'error', err instanceof Error ? err.message : String(err))
      }
    })()
    return run.id
  }
}
