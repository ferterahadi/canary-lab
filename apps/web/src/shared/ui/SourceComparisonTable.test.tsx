// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { testFileReview } from '../api/__fixtures__/test-review'
import { sourceRows } from '../lib/test-review-model'
import { SourceComparisonTable } from './SourceComparisonTable'
import { ShikiCode } from './TestCodeBlock'

const highlighter = vi.hoisted(() => ({ load: vi.fn(), html: vi.fn() }))
vi.mock('./code-highlighter', () => ({ getCodeHighlighter: highlighter.load, codeThemeFor: (theme: string) => theme }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  highlighter.load.mockReset(); highlighter.html.mockReset()
  highlighter.html.mockImplementation((source: string) => `<pre><code>${source.split('\n').map((line) => `<span class="line"><span style="color:var(--code-keyword)">${line.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</span></span>`).join('\n')}</code></pre>`)
  highlighter.load.mockResolvedValue({ codeToHtml: highlighter.html, themeColors: () => ({ bg: 'var(--bg-input)', fg: 'var(--text-primary)' }) })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })
it('uses full-file Shiki output in aligned rows, including inserted and removed sides', async () => {
  const review = testFileReview()
  const rows = sourceRows(review)
  rows.push({ id: 'added', before: null, after: 'new line', afterLine: 9, change: 3 })
  await act(async () => root.render(<SourceComparisonTable review={review} rows={rows} mode="code" change={1} />))
  expect(highlighter.html.mock.calls.map(([source]) => source)).toEqual([review.before.source, review.after.source])
  expect(container.querySelector('del span[style]')?.textContent).toBe('  expect(x).toBe(1)')
  expect(container.querySelector('ins span[style]')?.textContent).toBe('  expect(x).toBe(2)')
  expect(container.querySelector('#added td:first-child')?.textContent).toContain('No corresponding line')
  expect(container.querySelector('#added td:last-child')?.textContent).toContain('new line')
  expect(container.querySelectorAll('[data-selected="true"]')).toHaveLength(1)
})
it('shares the existing English semantic labels and token colors, retaining untranslated source', async () => {
  const review = testFileReview()
  review.after.tests[0].readable.story = { steps: [{ id: 'check', role: 'check', text: 'Check that x equals 2', spans: [{ text: 'Check', kind: 'verb' }, { text: ' that x equals ' }, { text: '2', kind: 'number' }], fidelity: 'exact', source: { file: review.file, startLine: 5, endLine: 5, snippet: 'expect(x).toBe(2)' } }] }
  await act(async () => root.render(<SourceComparisonTable review={review} rows={sourceRows(review)} mode="english" />))
  expect(container.querySelector('[data-testid="readable-story-role-check"]')?.textContent).toBe('CHECK')
  expect(container.querySelector('[data-story-span="number"]')?.textContent).toBe('2')
  expect(container.textContent).toContain('import { test, expect }')
})
it('links function headings to their declaration and keeps untranslated lines clickable', async () => {
  const review = testFileReview()
  review.after.story = { steps: [{ id: 'function', kind: 'flow', flowKind: 'scope', role: 'setup', text: 'Define function helper', spans: [{ text: 'Define function helper' }], fidelity: 'derived',
    source: { file: review.file, startLine: 3, endLine: 8, snippet: review.after.source }, children: [] }] }
  const select = vi.fn()
  await act(async () => root.render(<SourceComparisonTable review={review} rows={sourceRows(review)} mode="english" onSelectSource={select} />))
  await act(async () => container.querySelector<HTMLButtonElement>('[data-side="after"][data-source-line="3"] button')!.click())
  expect(select).toHaveBeenLastCalledWith({ side: 'after', line: 3, endLine: 3 })
  await act(async () => container.querySelector<HTMLButtonElement>('[data-side="before"][data-source-line="1"] button')!.click())
  expect(select).toHaveBeenLastCalledWith({ side: 'before', line: 1, endLine: 1 })
  expect(container.querySelector('[data-side="before"][data-source-line="2"] button')).toBeNull()
})
it('opens the complete multiline loop header from its English description', async () => {
  const review = testFileReview()
  review.after.story = { steps: [{ id: 'loop', kind: 'flow', flowKind: 'loop', role: 'setup', headerEndLine: 6, text: 'Process each item', spans: [], fidelity: 'derived',
    source: { file: review.file, startLine: 3, endLine: 8, snippet: review.after.source }, children: [] }] }
  const select = vi.fn()
  await act(async () => root.render(<SourceComparisonTable review={review} rows={sourceRows(review)} mode="english" onSelectSource={select} />))
  expect(container.querySelector('[data-side="after"][data-source-line="4"]')?.textContent?.trim()).toBe('')
  await act(async () => container.querySelector<HTMLButtonElement>('[data-side="after"][data-source-line="3"] button')!.click())
  expect(select).toHaveBeenLastCalledWith({ side: 'after', line: 3, endLine: 6 })
})
it('makes only the original code range clickable to return to English', async () => {
  const review = testFileReview()
  const returnToEnglish = vi.fn()
  const selection = { side: 'after' as const, line: 6, endLine: 7 }
  await act(async () => root.render(<SourceComparisonTable review={review} rows={sourceRows(review)} mode="code"
    selection={selection} returnSelection={selection} onReturnToEnglish={returnToEnglish} />))
  const links = [...container.querySelectorAll<HTMLButtonElement>('button[data-source-line]')]
  expect(links.map((link) => [link.dataset.side, link.dataset.sourceLine])).toEqual([['after', '6'], ['after', '7']])
  for (const link of links) {
    expect(link.type).toBe('button')
    expect(link.title).toBe('Show English for line 6')
    await act(async () => link.click())
  }
  expect(returnToEnglish).toHaveBeenCalledTimes(2)
  expect(container.querySelector('[data-side="before"][data-source-line="6"]')?.tagName).toBe('DIV')
  expect(container.querySelector('[data-side="after"][data-source-line="5"]')?.tagName).toBe('DIV')
})
it('renders escaped source and never keeps old highlighted HTML while the new version is loading', async () => {
  const first = 'const oldValue = 1'
  await act(async () => root.render(<ShikiCode source={first} />))
  expect(container.textContent).toContain(first)
  let resolve: (value: unknown) => void = () => {}
  highlighter.load.mockReturnValueOnce(new Promise((done) => { resolve = done }))
  const next = 'const text = "<img src=x onerror=alert(1)>"'
  await act(async () => root.render(<ShikiCode source={next} />))
  expect(container.textContent).toContain(next)
  expect(container.textContent).not.toContain(first)
  expect(container.querySelector('img')).toBeNull()
  await act(async () => resolve({ codeToHtml: highlighter.html, themeColors: () => ({}) }))
  expect(container.textContent).toContain(next)
  expect(container.querySelector('img')).toBeNull()
})
