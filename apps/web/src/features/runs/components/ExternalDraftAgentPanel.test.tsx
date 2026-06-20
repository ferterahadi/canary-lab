import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ExternalDraftAgentPanel } from './ExternalDraftAgentPanel'
import type { DraftRecord, ExternalDraftStage, ExternalHealClientKind } from '../../../shared/api/types'

function draft(overrides: Partial<DraftRecord> = {}): DraftRecord {
  return {
    draftId: 'draft-1',
    prdText: '',
    prdDocuments: [],
    repos: [],
    featureName: 'checkout',
    source: 'external',
    externalStage: 'authoring-tests' as ExternalDraftStage,
    externalClientKind: 'claude-desktop',
    externalSessionId: 'sess-abcdef-12345',
    externalConversationName: 'Add checkout tests',
    externalSessionUrl: 'codex://session/sess-abcdef',
    status: 'generating',
    createdAt: '2026-05-27T10:00:00.000Z',
    updatedAt: '2026-05-27T10:00:00.000Z',
    ...overrides,
  }
}

describe('ExternalDraftAgentPanel', () => {
  it('renders the client brand, stage, and conversation name', () => {
    const html = renderToStaticMarkup(
      <ExternalDraftAgentPanel draft={draft()} stageView="generating" />,
    )
    expect(html).toContain('Claude Desktop')
    expect(html).toContain('Authoring tests')
    expect(html).toContain('Add checkout tests')
  })

  it.each([
    ['scaffolding', 'Scaffolding'],
    ['authoring-tests', 'Authoring tests'],
    ['validating', 'Validating'],
    ['ready', 'Ready'],
    ['applied', 'Applied'],
    ['error', 'Error'],
  ] as Array<[ExternalDraftStage, string]>)('shows the %s stage label', (stage, label) => {
    const html = renderToStaticMarkup(
      <ExternalDraftAgentPanel draft={draft({ externalStage: stage })} stageView="generating" />,
    )
    expect(html).toContain(label)
  })

  it('renders the error message only when the stage is error', () => {
    const passing = renderToStaticMarkup(
      <ExternalDraftAgentPanel draft={draft({ errorMessage: 'boom' })} stageView="generating" />,
    )
    expect(passing).not.toContain('boom')

    const failing = renderToStaticMarkup(
      <ExternalDraftAgentPanel
        draft={draft({ externalStage: 'error', errorMessage: 'boom' })}
        stageView="generating"
      />,
    )
    expect(failing).toContain('boom')
  })

  it.each([
    ['claude-cli', 'Claude CLI'],
    ['codex-desktop', 'Codex Desktop'],
    ['other', 'External Client'],
  ] as Array<[ExternalHealClientKind, string]>)('renders the %s client label', (kind, label) => {
    const html = renderToStaticMarkup(
      <ExternalDraftAgentPanel draft={draft({ externalClientKind: kind })} stageView="planning" />,
    )
    expect(html).toContain(label)
  })

  it('renders the open-session link when externalSessionUrl is provided', () => {
    const html = renderToStaticMarkup(
      <ExternalDraftAgentPanel draft={draft()} stageView="generating" />,
    )
    expect(html).toContain('codex://session/sess-abcdef')
    expect(html).toContain('Open Claude Desktop')
  })

  it('omits the open-session link when externalSessionUrl is missing', () => {
    const html = renderToStaticMarkup(
      <ExternalDraftAgentPanel
        draft={draft({ externalSessionUrl: undefined })}
        stageView="generating"
      />,
    )
    expect(html).not.toContain('Open Claude Desktop')
  })
})
