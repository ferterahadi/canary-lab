// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { reviewSourceFor } from '../../../../../web-server/src/shared/readable-tests/review-source'
import { extractTestMetadataFromSource } from '../../../../../web-server/src/shared/ast-extractor'
import { pairTestDeclarations, reviewDeclarationPairs } from '../../../../../web-server/src/shared/test-declaration-pairs'
import { CycleFileReview } from './CycleFileReview'
import { ReviewFlows, type ReviewInspection } from './ReviewFlows'

it('pairs renamed declarations and drills into the chosen side of the review', async () => {
  const file = 'e2e/orders.spec.ts'
  const before = "test('old title', async () => { await submit() })"
  const after = "\ntest('new title', async () => { await submit() })"
  const side = (source: string, side: 'before' | 'after') => reviewSourceFor(file, source, undefined, { withTests: true, side })
  const sources = {
    before: side(before, 'before'), after: side(after, 'after'),
    declarationPairs: reviewDeclarationPairs(pairTestDeclarations(
      extractTestMetadataFromSource(file, before).tests, extractTestMetadataFromSource(file, after).tests)),
  }
  function Comparison() {
    const [inspection, setInspection] = useState<ReviewInspection>()
    return <ReviewFlows sources={sources} labels={{ before: 'Git HEAD', after: 'Current source' }}
      inspection={inspection} onInspect={setInspection} onReturn={() => {}} />
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<Comparison />))
    expect(host.querySelector('option')?.textContent).toContain('old title → new title')
    const panes = host.querySelectorAll('section')
    expect(panes[0].textContent).toContain(sources.before.tests[0].readable.graph!.revisions[file].slice(0, 12))
    expect(panes[1].textContent).toContain(sources.after.tests[0].readable.graph!.revisions[file].slice(0, 12))
    await act(async () => panes[1].querySelector<HTMLButtonElement>('button[data-source]:not([data-box="start"]):not([data-box="end"])')!.click())
    expect(panes[1].querySelector('[role="tab"][aria-label="Code"]')?.getAttribute('aria-selected')).toBe('true')
    expect(panes[0].querySelector('[role="tab"][aria-label="Visual"]')?.getAttribute('aria-selected')).toBe('true')
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})

it('keeps added and removed declarations on their own sides', async () => {
  const file = 'e2e/orders.spec.ts'
  const old = "test('removed', async () => { await cancel() })"
  const next = "test('added', async () => { await submit() })"
  const sources = {
    before: reviewSourceFor(file, old, undefined, { withTests: true, side: 'before' }),
    after: reviewSourceFor(file, next, undefined, { withTests: true, side: 'after' }),
    declarationPairs: reviewDeclarationPairs(pairTestDeclarations(
      extractTestMetadataFromSource(file, old).tests, extractTestMetadataFromSource(file, next).tests)),
  }
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    for (const side of ['before', 'after'] as const) {
      const [pair] = sources.declarationPairs.filter(item => item[side])
      await act(async () => root.render(<ReviewFlows sources={sources} labels={{ before: 'Before', after: 'After' }}
        inspection={{ side, flow: { card: pair[side]!, mode: 'visual' } }} onInspect={() => {}} onReturn={() => {}} />))
      expect(host.querySelectorAll('[aria-label="Test flow"]')).toHaveLength(1)
      expect(host.textContent).toContain(side === 'before' ? 'Removed test · absent after' : 'Added test · absent before')
    }
  } finally { act(() => root.unmount()) }
})

it('opens a recovered repair from Results & Fixes and returns to its file edits', async () => {
  const file = 'e2e/orders.spec.ts'
  const old = "test('order', async () => { expect(1).toBe(1) })"
  const next = old.replace('toBe(1)', 'toBe(2)')
  const host = document.createElement('div')
  const root = createRoot(host)
  const button = (text: string) => [...host.querySelectorAll('button')].find(el => el.textContent === text)!
  try {
    await act(async () => root.render(<CycleFileReview cycle={2} files={[{
      path: file, lineEnding: 'lf', change: 'modified', language: 'typescript', role: 'spec',
      rows: [], recovery: { kind: 'reconstructed', verified: 'blob' },
      sources: { before: reviewSourceFor(file, old, undefined, { withTests: true, side: 'before' }),
        after: reviewSourceFor(file, next, undefined, { withTests: true, side: 'after' }),
        declarationPairs: [{ before: '1:order', after: '1:order' }], patch: '@@ -1 +1 @@\n-' + old + '\n+' + next },
    }]} />))
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Visual"]')!.click())
    expect(host.querySelector('section[aria-label="Before repair 2"] [aria-label="Test flow"]')).toBeTruthy()
    expect(host.querySelector('section[aria-label="After repair 2"] [aria-label="Test flow"]')).toBeTruthy()
    await act(async () => button('File comparison').click())
    expect(host.textContent).toContain('Edit 1 / 1')
    expect(host.querySelector('[aria-label="Code changes before and after"]')).toBeTruthy()
  } finally { act(() => root.unmount()) }
})
