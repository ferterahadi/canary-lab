import type { DraftRecord } from '@/shared/api/types'
import { WizardDraftProvider, useWizardDrafts } from '../WizardDraftContext'
import { FakeWebSocket } from '../WizardDraftContext.test'

export function workspaceSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances.find((item) => item.url === 'ws://test/ws/workspace')
  if (!socket) throw new Error('workspace socket not opened')
  return socket
}

export function Probe({ captured }: { captured: { value: ReturnType<typeof useWizardDrafts> | null } }) {
  captured.value = useWizardDrafts()
  return null
}

export function draft(overrides: Partial<DraftRecord> = {}): DraftRecord {
  return {
    draftId: 'draft-1',
    prdText: 'Checkout flow',
    prdDocuments: [],
    repos: [{ name: 'app', localPath: '/app' }],
    featureName: 'checkout-flow',
    status: 'planning',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}
