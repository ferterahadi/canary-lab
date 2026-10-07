// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ExternalDraftAgentPanel } from './ExternalDraftAgentPanel'
import type { DraftRecord, ExternalDraftStage } from '@shared/draft-types'
import type { ClientKind } from '@shared/run-mode'

function draft(overrides: Partial<DraftRecord> = {}): DraftRecord {
  return {
    draftId: 'draft-1',
    prdText: '',
    prdDocuments: [],
    repos: [],
    featureName: 'checkout',
    producer: 'external',
    externalStage: 'authoring-tests' as ExternalDraftStage,
    externalClientKind: 'claude',
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
  it('updates and removes an error without replacing the mounted card or session link', () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    const root = createRoot(container)
    const show = (over: Partial<DraftRecord>) => act(() => root.render(<ExternalDraftAgentPanel draft={draft(over)} stageView="generating" />))
    try {
      show({})
      const card = container.querySelector('.cl-card')
      const link = container.querySelector('a')
      show({ externalStage: 'error', errorMessage: 'First failure' })
      const error = Array.from(container.querySelectorAll('div')).find((el) => el.textContent === 'First failure')!
      expect(error.className).toBe('mt-3 rounded-md px-3 py-2 text-[11px] @[320px]:mt-4')
      expect(error.getAttribute('style')).toContain('var(--danger)')
      // happy-dom drops color-mix declarations; assert their authored markup.
      const html = renderToStaticMarkup(<ExternalDraftAgentPanel draft={draft({ externalStage: 'error', errorMessage: 'First failure' })} stageView="generating" />)
      expect(html).toContain('color-mix(in srgb, var(--danger) 10%, transparent)')
      expect(html).toContain('1px solid color-mix(in srgb, var(--danger) 30%, transparent)')
      show({ externalStage: 'error', errorMessage: 'Next failure' })
      expect(error.textContent).toBe('Next failure')
      show({ externalStage: 'ready', errorMessage: 'Next failure' })
      expect(container.textContent).not.toContain('Next failure')
      expect(container.querySelector('.cl-card')).toBe(card)
      expect(container.querySelector('a')).toBe(link)
    } finally { act(() => root.unmount()) }
  })
  it('renders the client brand, stage, and conversation name', () => {
    const html = renderToStaticMarkup(
      <ExternalDraftAgentPanel draft={draft()} stageView="generating" />,
    )
    expect(html).toContain('Claude')
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
    ['claude', 'Claude'],
    ['codex-pty', 'Codex (runner)'],
    ['other', 'External agent'],
  ] as Array<[ClientKind, string]>)('renders the %s client label', (kind, label) => {
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
    expect(html).toContain('Open Claude')
  })

  it('omits the open-session link when externalSessionUrl is missing', () => {
    const html = renderToStaticMarkup(
      <ExternalDraftAgentPanel
        draft={draft({ externalSessionUrl: undefined })}
        stageView="generating"
      />,
    )
    expect(html).not.toContain('Open Claude')
  })
})
