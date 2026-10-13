import { act } from 'react'
import type { Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ShikiCode } from './TestCodeBlock'
import { mountRoot } from '@/test-helpers/mount-root'

const highlighter = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('./code-highlighter', () => ({ getCodeHighlighter: highlighter.load, codeThemeFor: () => 'test' }))
const openEditor = vi.hoisted(() => vi.fn().mockResolvedValue({}))
vi.mock('../api/workspace', () => ({ openEditor }))

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  highlighter.load.mockReset()
  openEditor.mockClear()
})
mountRoot({ attach: true, onMount: (mounted) => ({ container, root } = mounted) })

const escapedHighlighter = {
  codeToHtml: (source: string) => `<pre><code>${source.split('\n').map((line) => `<span class="line">${line.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</span>`).join('\n')}</code></pre>`,
  themeColors: () => ({}),
}

describe.each(['fallback', 'shiki'] as const)('%s line presentation', (renderer) => {
  beforeEach(() => {
    if (renderer === 'fallback') highlighter.load.mockRejectedValue(new Error('unavailable'))
    else highlighter.load.mockResolvedValue(escapedHighlighter)
  })

  it('preserves highlight precedence, source mapping, story numbering and escaping while mounted', async () => {
    const source = '<script>unsafe & text</script>\ncontinuation\nselected\nplain'
    const props = {
      source,
      sourceLocation: { file: '/workspace/suite/example.spec.ts', startLine: 10 },
      sourceLineMap: [
        { sourceLine: 20, sourceLines: [20, 21] },
        { sourceLine: 22, sourceLines: [] },
        { sourceLine: 23, sourceLines: [23] },
        { sourceLine: 24, sourceLines: [24] },
      ],
      selectedSourceRange: { startLine: 21, endLine: 23 },
      changedLines: new Set([1, 2]),
      storyLineNumbers: new Map([
        [20, { sequence: '01', label: '01' }],
        [22, { sequence: '01', label: '01' }],
        [23, { sequence: '02.1', label: '1' }],
      ]),
    }
    await act(async () => root.render(<ShikiCode {...props} lineHighlight={{ kind: 'failed', lines: new Set([1]) }} />))
    const lines = () => [...container.querySelectorAll<HTMLElement>('.line')]
    expect(lines()).toHaveLength(4)
    const [failed, changed, selected, plain] = lines()
    expect(failed.dataset).toMatchObject({ codeLine: '01', codeSequence: '01', sourceLine: '20', selectedLine: 'true', changedLine: 'true', activeLine: 'true', executionHighlight: 'failed' })
    expect(failed.style.boxShadow).toContain('var(--danger)')
    expect(failed.textContent).toBe('<script>unsafe & text</script>FAILED HERE')
    expect(container.querySelector('script')).toBeNull()
    expect(changed.dataset.codeSequence).toBe('')
    expect(changed.dataset.sourceLine).toBe('22')
    expect(changed.style.boxShadow).toContain('var(--warning)')
    expect(selected.dataset.codeSequenceLabel).toBe('1')
    expect(selected.style.boxShadow).toContain('var(--accent)')
    expect(plain.style.boxShadow).toBe('')
    await act(async () => failed.click())
    expect(openEditor).toHaveBeenCalledWith({ file: props.sourceLocation.file, line: 20, column: 1 })

    await act(async () => root.render(<ShikiCode {...props} lineHighlight={{ kind: 'running', lines: new Set([2]) }} />))
    expect(lines()[0].style.boxShadow).toContain('var(--warning)')
    expect(lines()[0].dataset.activeLine).toBeUndefined()
    expect(lines()[1].style.boxShadow).toContain('var(--running)')
    expect(lines()[1].dataset.executionHighlight).toBe('running')
    expect(container.querySelector('.cl-execution-label')).toBeNull()
  })

  it('uses physical numbering without a source mapping', async () => {
    await act(async () => root.render(<ShikiCode source={'first\nsecond'} />))
    const lines = [...container.querySelectorAll<HTMLElement>('.line')]
    expect(lines.map((line) => line.dataset.codeSequence)).toEqual(['01', '02'])
    expect(lines.every((line) => line.dataset.sourceLine === undefined)).toBe(true)
  })
})

it('keeps the same presentation when the highlighter becomes available', async () => {
  let resolve!: (value: typeof escapedHighlighter) => void
  highlighter.load.mockReturnValue(new Promise((done) => { resolve = done }))
  await act(async () => root.render(<ShikiCode source="first" sourceLocation={{ file: '/workspace/example.spec.ts', startLine: 10 }} lineHighlight={{ kind: 'failed', lines: new Set([1]) }} />))
  const before = container.querySelector<HTMLElement>('.line')!
  const expected = { text: before.textContent, line: before.dataset.sourceLine, style: before.style.cssText }
  await act(async () => resolve(escapedHighlighter))
  const after = container.querySelector<HTMLElement>('.line')!
  expect({ text: after.textContent, line: after.dataset.sourceLine, style: after.style.cssText }).toEqual(expected)
  expect(container.querySelector('.shiki-block')).not.toBeNull()
})
