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
    await act(async () => panes[1].querySelector<HTMLElement>('[data-outline-box] .outline-label')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, metaKey: true })))
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
      expect(host.querySelectorAll('[aria-label="Visual outline"]')).toHaveLength(1)
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
    const select = host.querySelector<HTMLSelectElement>('.cl-revision-head select')!
    await act(async () => { select.value = '1:order'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(host.querySelector('section[aria-label="Before repair 2"] [aria-label="Test source"]')).toBeTruthy()
    expect(host.querySelector('section[aria-label="After repair 2"] [aria-label="Visual outline"]')).toBeTruthy()
    await act(async () => button('File comparison').click())
    expect(host.textContent).toContain('Edit 1 / 1')
    expect(host.querySelector('[aria-label="Code changes before and after"]')).toBeTruthy()
  } finally { act(() => root.unmount()) }
})

it('marks only a reported live line in the source editor and clears it in place when execution ends', async () => {
  const { TestPresentation } = await import('@/shared/ui/TestPresentation')
  const file = 'e2e/simple.spec.ts'
  const source = "test('case', async () => {\n  await first()\n\n  await second()\n})"
  const review = reviewSourceFor(file, source, undefined, { withTests: true, side: 'after' })
  const test = { ...review.tests[0], steps: [], bodySource: source.slice(source.indexOf('{')), bodyLine: 1 }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    const show = (line?: number) => act(async () => root.render(<TestPresentation view="single" sourceFile={file}
      inspection={{ mode: 'code', line: 2 }} onInspection={() => {}} test={test}
      executionHighlight={line ? { kind: 'running', bodyLine: line } : undefined} />))
    const marked = () => [...host.querySelectorAll<HTMLElement>('[data-evidence="Running now"]')].map(row => row.dataset.sourceLine)
    await show()
    expect(host.querySelectorAll('.cm-line').length).toBeGreaterThan(2)
    expect(marked()).toEqual([])
    await show(4)
    expect(marked()).toEqual(['4'])
    await show()
    expect(marked()).toEqual([])
  } finally { act(() => root.unmount()); host.remove() }
})

it('expands inside the full-screen Coverage layer and returns to its open card on Escape', async () => {
  const { TestPresentation } = await import('@/shared/ui/TestPresentation')
  const { FullScreenPage } = await import('@/shared/ui/PageHeader')
  const file = 'e2e/example.spec.ts'
  const source = "test('release the number', () => { releaseNumber() })"
  const review = reviewSourceFor(file, source, undefined, { withTests: true, side: 'after' })
  const test = { ...review.tests[0], steps: [], bodySource: '{ releaseNumber() }' }
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  let pageClosed = false
  try {
    await act(async () => root.render(<FullScreenPage onClose={() => { pageClosed = true }} testId="coverage">
      <TestPresentation view="single" sourceFile={file} test={test} />
    </FullScreenPage>))
    const page = host.querySelector('[data-testid="coverage"]')!
    await act(async () => page.querySelector<HTMLButtonElement>('.location-action')!.click())
    expect(page.querySelector('[data-testid="expanded-test-reader"] svg[aria-label$="flowchart"]')).toBeTruthy()
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(pageClosed).toBe(false)
    expect(page.querySelector('[data-testid="expanded-test-reader"]')).toBeNull()
    expect(page.querySelector('[aria-label="Visual outline"]')).toBeTruthy()
  } finally { act(() => root.unmount()); host.remove() }
})
