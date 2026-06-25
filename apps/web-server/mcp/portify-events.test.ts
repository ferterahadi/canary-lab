import { describe, it, expect } from 'vitest'
import { registerCanaryLabTools, type CanaryLabMcpDeps } from './tools'
import type { WorkspaceEvent, WorkspaceEventPublisher } from '../src/shared/workspace-events'

// The MCP portify tools mutate feature state (save_portify writes an overlay;
// remove_portification reverts the config + deletes it). When driven from an
// external client (Claude Desktop) the open web UI only learns about the change
// via a workspace event — without one, the portified badge stays stale until a
// manual refresh. These tests pin that each tool emits `features-changed`.

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>

function captureTools(deps: Partial<CanaryLabMcpDeps>): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>()
  const fakeServer = {
    registerTool: (name: string, _config: unknown, cb: ToolHandler) => {
      handlers.set(name, cb)
    },
  }
  registerCanaryLabTools(
    fakeServer as never,
    deps as unknown as CanaryLabMcpDeps,
    { profile: 'full' },
  )
  return handlers
}

function recordingPublisher(): { events: WorkspaceEvent[]; publisher: WorkspaceEventPublisher } {
  const events: WorkspaceEvent[] = []
  return { events, publisher: { publish: (event) => { events.push(event) } } }
}

describe('MCP portify tools emit workspace events', () => {
  it('save_portify publishes features-changed so the UI updates without a refresh', async () => {
    const { events, publisher } = recordingPublisher()
    const handlers = captureTools({
      savePortify: async () => ({ feature: 'cns_better_auth' }) as never,
      workspaceEvents: publisher,
    })

    await handlers.get('save_portify')!({ workflowId: 'wf1', confirm: true })

    expect(events).toEqual([{ type: 'features-changed' }])
  })

  it('remove_portification publishes features-changed so the badge clears live', async () => {
    const { events, publisher } = recordingPublisher()
    const handlers = captureTools({
      removePortification: () => ({ name: 'cns_better_auth', portified: false, reverted: true }),
      workspaceEvents: publisher,
    })

    await handlers.get('remove_portification')!({ feature: 'cns_better_auth', confirm: true })

    expect(events).toEqual([{ type: 'features-changed' }])
  })

  it('does not emit when the underlying save fails', async () => {
    const { events, publisher } = recordingPublisher()
    const handlers = captureTools({
      savePortify: async () => { throw new Error('not ready-to-save') },
      workspaceEvents: publisher,
    })

    await handlers.get('save_portify')!({ workflowId: 'wf1', confirm: true })

    expect(events).toEqual([])
  })
})
