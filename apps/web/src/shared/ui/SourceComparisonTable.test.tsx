// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { multilineImportReview, testFileReview } from '../api/__fixtures__/test-review'
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
  highlighter.load.mockResolvedValue({ codeToHtml: highlighter.html, themeColors: () => ({ bg: 'var(--bg-input)', fg: 'var(--text-primary)', comment: '#7f848e' }) })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })
it('does not paint an unchanged statement because the opposite side has a meaningful edit', async () => {
  const review = testFileReview()
  const rows = sourceRows(review).map((row) => ({ ...row, beforeChanged: false, afterChanged: row.afterLine === 5 }))
  await act(async () => root.render(<SourceComparisonTable review={review} rows={rows} mode="code" />))
  expect(container.querySelector('del')).toBeNull()
  expect([...container.querySelectorAll('ins')].map((item) => item.textContent)).toEqual(['  expect(x).toBe(2)'])
})
it('keeps an edited do/while condition visible and includes it when opening source', async () => {
  const review = testFileReview()
  for (const side of ['before', 'after'] as const) {
    const condition = side === 'before' ? 'firstReady' : 'secondReady'
    const source = `do {\n  work()\n} while (${condition})`
    const text = `Run once, then repeat while ${condition} is truthy`
    review[side] = { source, tests: [], story: { steps: [{ id: 'loop', kind: 'flow', flowKind: 'loop', role: 'action', text, spans: [{ text }], fidelity: 'derived',
      source: { file: review.file, startLine: 1, endLine: 3, snippet: source }, headerEndLine: 1, footerStartLine: 3,
      children: [{ id: 'work', role: 'action', text: 'Call work', spans: [{ text: 'Call work' }], fidelity: 'derived', source: { file: review.file, startLine: 2, endLine: 2, snippet: 'work()' } }] }] } }
  }
  review.patch = '@@ -1,3 +1,3 @@\n do {\n   work()\n-} while (firstReady)\n+} while (secondReady)'
  const select = vi.fn()
  await act(async () => root.render(<SourceComparisonTable review={review} rows={sourceRows(review)} mode="english" onSelectSource={select} />))
  expect(container.querySelector('[data-side="after"][data-source-line="1"] ins')?.textContent).toContain('secondReady')
  expect(container.querySelector('[data-side="after"][data-source-line="2"]')?.textContent).toContain('Call work')
  await act(async () => container.querySelector<HTMLButtonElement>('[data-side="after"][data-source-line="1"] button')!.click())
  expect(select).toHaveBeenLastCalledWith({ side: 'after', line: 1, endLine: 3 })
})
it.each(['added test', 'changed tags'])('collapses registration syntax for %s and opens the complete header in Code mode', async (variant) => {
  const review = testFileReview()
  const readable = review.before.tests[0].readable
  const source = ["test('concurrent binding remains durable', {", "  tag: ['@req-R18', '@req-R19'],", '}, async () => {',
    '  const value = 1;', '  expect(value).toBe(1);', '});']
  for (const side of ['before', 'after'] as const) {
    const lines = [...source]
    if (side === 'before') lines[1] = "  tag: ['@req-R18'],"
    review[side] = { source: lines.join('\n'), tests: [{ name: 'concurrent binding remains durable', line: 1, endLine: 6, readable }], story: { steps: [{
      id: 'test', kind: 'flow', flowKind: 'scope', role: 'test', text: 'Test: "concurrent binding remains durable"',
      spans: [{ text: 'Test: "concurrent binding remains durable"' }], fidelity: 'derived', headerEndLine: 3,
      source: { file: review.file, startLine: 1, endLine: 6, snippet: lines.join('\n') }, children: [
        { id: 'setup', role: 'setup', text: 'Set constant value to 1', spans: [{ text: 'Set constant value to 1' }], fidelity: 'derived',
          source: { file: review.file, startLine: 4, endLine: 4, snippet: lines[3] } },
        { id: 'check', role: 'check', text: 'Check that value equals 1', spans: [{ text: 'Check that value equals 1' }], fidelity: 'derived',
          source: { file: review.file, startLine: 5, endLine: 5, snippet: lines[4] } },
      ],
    }] } }
  }
  if (variant === 'added test') {
    review.before = { source: '', tests: [], story: { steps: [] } }
    review.patch = '@@ -0,0 +1,6 @@\n' + source.map((line) => '+' + line).join('\n')
  } else review.patch = '@@ -1,6 +1,6 @@\n' + source.flatMap((line, i) => i === 1
    ? ["-  tag: ['@req-R18'],", '+' + line] : [' ' + line]).join('\n')
  review.meaningfulChanges = variant === 'added test'
    ? { before: [], after: source.map((_, index) => index + 1) }
    : { before: [], after: [] }
  const select = vi.fn()
  await act(async () => root.render(<SourceComparisonTable review={review} rows={sourceRows(review)} mode="english" change={1} onSelectSource={select} />))
  expect(container.textContent).toContain('TEST"concurrent binding remains durable"')
  expect(container.textContent).not.toMatch(/tag:|async|=>/)
  expect(container.textContent).toContain('SETUPSet constant value to 1')
  expect(container.textContent).toContain('CHECKvalue equals 1')
  const englishTestHighlight = container.querySelector('[data-side="after"][data-source-line="1"] ins')
  if (variant === 'added test') expect(englishTestHighlight).not.toBeNull()
  else {
    expect(englishTestHighlight).toBeNull()
    expect(container.querySelector('[data-side="before"][data-source-line="1"] del')).toBeNull()
    expect(container.querySelector('[data-selected="true"]')).toBeNull()
  }
  expect(container.querySelector('[data-side="after"][data-source-line="2"]')).toBeNull()
  expect(container.querySelector('[data-side="after"][data-source-line="3"]')).toBeNull()
  await act(async () => container.querySelector<HTMLButtonElement>('[data-side="after"][data-source-line="1"] button')!.click())
  expect(select).toHaveBeenLastCalledWith({ side: 'after', line: 1, endLine: 3 })
  await act(async () => root.render(<SourceComparisonTable review={review} rows={sourceRows(review)} mode="code" selection={select.mock.lastCall![0]} />))
  expect(container.querySelector('[data-side="after"][data-source-line="2"]')?.textContent).toContain(source[1])
  expect(container.querySelector('[data-side="after"][data-source-line="2"] ins')).not.toBeNull()
  expect(container.querySelector('[data-side="after"][data-source-line="3"]')?.textContent).toContain(source[2])
  expect(container.querySelectorAll('[data-source-selected]')).toHaveLength(3)
})
it('compacts a multiline import into its source range and preserves all code lines', async () => {
  const review = multilineImportReview()
  const select = vi.fn()
  await act(async () => root.render(<SourceComparisonTable review={review} rows={sourceRows(review)} mode="english" onSelectSource={select} />))
  expect(container.querySelectorAll('tbody tr')).toHaveLength(3)
  expect([...container.querySelectorAll('td:first-child .cl-context-line')].map((element) => element.textContent)).toEqual(['1', '2–18', '19'])
  expect(container.textContent).toContain('cassandraFixture')
  await act(async () => container.querySelector<HTMLButtonElement>('[data-side="after"][data-source-line="2"] button')!.click())
  expect(select).toHaveBeenLastCalledWith({ side: 'after', line: 2, endLine: 18 })
  await act(async () => root.render(<SourceComparisonTable review={review} rows={sourceRows(review)} mode="code" selection={select.mock.lastCall![0]} />))
  expect(container.querySelectorAll('tbody tr')).toHaveLength(19)
  expect(container.querySelectorAll('[data-source-selected]')).toHaveLength(17)
  expect(container.querySelector('[data-side="after"][data-source-line="3"]')?.textContent).toContain('api,')
})
it('marks and navigates each edit inside a compacted range even when its English wording is identical', async () => {
  const review = multilineImportReview()
  review.meaningfulChanges = { before: [], after: [] }
  const rows = sourceRows(review)
  for (const [index, change] of [[2, 1], [8, 2]]) {
    rows[index].change = change
    rows[index].after = `  changed${change},`
  }
  for (const change of [1, 2]) {
    await act(async () => root.render(<SourceComparisonTable review={review} rows={rows} mode="english" change={change} />))
    expect(container.querySelectorAll('tbody tr')).toHaveLength(3)
    expect(container.querySelectorAll('[data-selected]')).toHaveLength(1)
    expect(container.querySelector('[data-selected] .cl-context-line')?.textContent).toBe('2–18')
    expect(container.querySelector('[data-source-line="2"][data-side="before"] del')).not.toBeNull()
    expect(container.querySelector('[data-source-line="2"][data-side="after"] ins')).not.toBeNull()
  }
})
it.each(['before', 'after'] as const)('retains independent %s content opposite a continuation without repeating its line number', async (side) => {
  const review = multilineImportReview()
  delete review[side].story
  await act(async () => root.render(<SourceComparisonTable review={review} rows={sourceRows(review)} mode="english" />))
  expect(container.querySelectorAll('tbody tr')).toHaveLength(19)
  const opposite = side === 'before' ? 'after' : 'before'
  expect(container.querySelector(`[data-side="${side}"][data-source-line="3"]`)?.textContent).toContain('English unavailable · View code')
  expect(container.querySelector(`[data-side="${side}"][data-source-line="3"]`)?.textContent).not.toContain('api,')
  expect(container.querySelector(`[data-side="${opposite}"][data-source-line="3"]`)?.closest('td')?.querySelector('.cl-context-line')).toBeNull()
  await act(async () => root.render(<SourceComparisonTable review={review} rows={sourceRows(review)} mode="code" />))
  expect(container.querySelector(`[data-side="${side}"][data-source-line="3"]`)?.textContent).toContain('api,')
})
it.each(['insert', 'remove'] as const)('keeps unequal ranges aligned when an import member is %s', async (operation) => {
  const review = multilineImportReview()
  const before = review.before.source.split('\n')
  const after = [...before.slice(0, 9), '  newMember,', ...before.slice(9)]
  review.after.source = after.join('\n')
  review.after.story!.steps[0].source.endLine = 19
  review.patch = '@@ -1,19 +1,20 @@\n' + [...before.slice(0, 9).map((line) => ` ${line}`), '+  newMember,', ...before.slice(9).map((line) => ` ${line}`)].join('\n')
  if (operation === 'remove') {
    [review.before, review.after] = [review.after, review.before]
    review.patch = review.patch.replace('@@ -1,19 +1,20 @@', '@@ -1,20 +1,19 @@').replace('+  newMember,', '-  newMember,')
  }
  await act(async () => root.render(<SourceComparisonTable review={review} rows={sourceRows(review)} mode="english" change={1} />))
  expect(container.querySelectorAll('tbody tr')).toHaveLength(3)
  const ranges = [...container.querySelectorAll('[data-selected] .cl-context-line')].map((element) => element.textContent)
  expect(ranges).toEqual(operation === 'insert' ? ['2–18', '2–19'] : ['2–19', '2–18'])
  const last = [...container.querySelectorAll('tbody tr:last-child .cl-context-line')].map((element) => element.textContent)
  expect(last).toEqual(operation === 'insert' ? ['19', '20'] : ['20', '19'])
  await act(async () => root.render(<SourceComparisonTable review={review} rows={sourceRows(review)} mode="code" change={1} />))
  expect(container.querySelector(operation === 'insert' ? 'ins' : 'del')?.textContent).toBe('  newMember,')
})
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
it('uses the same compact two-character gutter as the standalone code viewer', async () => {
  const review = testFileReview()
  await act(async () => root.render(<SourceComparisonTable review={review} rows={sourceRows(review)} mode="code" />))
  expect(container.querySelector<HTMLElement>('.cl-review-source-canvas')?.style.getPropertyValue('--review-gutter-width')).toBe('2ch')
})
it('shares English labels and colors while explicitly marking untranslated source', async () => {
  const review = testFileReview()
  review.after.tests[0].readable.story = { steps: [{ id: 'check', role: 'check', text: 'Check that x equals 2', spans: [{ text: 'Check', kind: 'verb' }, { text: ' that x equals ' }, { text: '2', kind: 'number' }], fidelity: 'exact', source: { file: review.file, startLine: 5, endLine: 5, snippet: 'expect(x).toBe(2)' } }] }
  await act(async () => root.render(<SourceComparisonTable review={review} rows={sourceRows(review)} mode="english" />))
  expect(container.querySelector('[data-testid="readable-story-role-check"]')?.textContent).toBe('CHECK')
  expect(container.querySelector('[data-story-span="number"]')?.textContent).toBe('2')
  expect(container.textContent).toContain('CHECKx equals 2')
  expect(container.textContent).toContain('English unavailable · View code')
  expect(container.textContent).not.toContain('import { test, expect }')
})
it('uses the Code mode comment colour for English notes', async () => {
  const review = testFileReview()
  review.after.story = { steps: [{
    id: 'note', role: 'note', text: 'This helper reads only the current run log.',
    spans: [{ text: 'This helper reads only the current run log.' }], fidelity: 'exact',
    source: { file: review.file, startLine: 3, endLine: 3, snippet: '// This helper reads only the current run log.' },
  }] }
  await act(async () => root.render(<SourceComparisonTable review={review} rows={sourceRows(review)} mode="english" />))
  const canvas = container.querySelector<HTMLElement>('.cl-review-source-canvas')
  const role = container.querySelector<HTMLElement>('[data-testid="readable-story-role-note"]')
  const text = container.querySelector<HTMLElement>('[data-story-span="text"]')
  expect(canvas?.style.getPropertyValue('--code-comment')).toBe('#7f848e')
  expect(role?.style.color).toBe('var(--code-comment)')
  expect(text?.style.color).toBe('var(--code-comment)')
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
