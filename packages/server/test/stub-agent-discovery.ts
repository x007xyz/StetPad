import { beforeAll, vi } from 'vitest'
import { ExternalAgents } from '../src/external'

export function stubAgentDiscovery(): void {
  // /api/models also lists local agents. Keep PATH subprocesses out of model
  // tests; external-agents.test.ts exercises real executable discovery.
  beforeAll(() => {
    const available = vi.spyOn(ExternalAgents.prototype, 'available').mockReturnValue([])
    const all = vi.spyOn(ExternalAgents.prototype, 'all').mockReturnValue([])
    return () => {
      all.mockRestore()
      available.mockRestore()
    }
  })
}
