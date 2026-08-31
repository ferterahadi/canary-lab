// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatCodeForDisplayWithLineMap } from '@shared/code-display-format'
import type { ExtractedTest, ReadableStoryItem } from '../api/types'
import { openEditor } from '../api/client'
import { applyTheme } from '../lib/theme'
import { TestPresentation } from './TestPresentation'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('shiki/core', () => ({
  createHighlighterCore: async () => ({
    codeToHtml: (code: string, options: { theme: string }) => (
      `<pre class="shiki" data-shiki-theme="${options.theme}"><code>${code.split('\n').map((line) => `<span class="line">${line}</span>`).join('\n')}</code></pre>`
    ),
  }),
}))
vi.mock('shiki/engine/oniguruma', () => ({ createOnigurumaEngine: () => ({}) }))
vi.mock('shiki/langs/typescript.mjs', () => ({ default: {} }))
vi.mock('shiki/themes/one-dark-pro.mjs', () => ({ default: {} }))
vi.mock('shiki/themes/one-light.mjs', () => ({ default: {} }))
vi.mock('shiki/wasm', () => ({ default: {} }))
vi.mock('../api/client', () => ({ openEditor: vi.fn() }))

const TEST: ExtractedTest = {
  name: 'completes checkout',
  line: 7,
  bodyLine: 10,
  bodySource: "{\n  await page.goto('/checkout')\n}",
  steps: [],
  readable: {
    version: 2,
    title: 'completes checkout',
    completeness: 'partial',
    story: {
      steps: [
        {
          id: 'checkout-step',
          role: 'setup',
          text: 'Prepare checkout',
          spans: [{ text: 'Prepare checkout' }],
          fidelity: 'derived',
          source: {
            file: '/repo/e2e/checkout.spec.ts',
            startLine: 10,
            endLine: 12,
            snippet: "{\n  await page.goto('/checkout')\n}",
          },
        },
        {
          id: 'open-checkout',
          role: 'action',
          text: 'Open “/checkout”',
          spans: [{ text: 'Open “/checkout”' }],
          fidelity: 'derived',
          source: {
            file: '/repo/e2e/checkout.spec.ts',
            startLine: 11,
            endLine: 11,
            snippet: "await page.goto('/checkout')",
          },
        },
        {
          id: 'helper-check',
          role: 'check',
          text: 'Check that account is active',
          spans: [{ text: 'Check that ' }, { text: 'account', kind: 'variable' }, { text: ' is active' }],
          fidelity: 'derived',
          source: {
            file: '/repo/e2e/helpers/account.ts',
            startLine: 30,
            endLine: 30,
            snippet: 'expect(account.active).toBe(true)',
          },
        },
      ],
    },
    nodes: [
      {
        id: 'checkout-step',
        kind: 'group',
        text: 'Checkout',
        fidelity: 'exact',
        source: {
          file: '/repo/e2e/checkout.spec.ts',
          startLine: 10,
          endLine: 12,
          snippet: "{\n  await page.goto('/checkout')\n}",
        },
        children: [{
          id: 'open-checkout',
          kind: 'leaf',
          role: 'action',
          text: 'Open “/checkout”',
          fidelity: 'derived',
          source: {
            file: '/repo/e2e/checkout.spec.ts',
            startLine: 11,
            endLine: 11,
            snippet: "await page.goto('/checkout')",
          },
        }],
      },
      {
        id: 'helper-check',
        kind: 'leaf',
        role: 'unknown',
        text: 'Review this source step',
        fidelity: 'unresolved',
        source: {
          file: '/repo/e2e/helpers/account.ts',
          startLine: 30,
          endLine: 30,
          snippet: 'expect(account.active).toBe(true)',
        },
      },
    ],
  },
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.mocked(openEditor).mockReset()
  localStorage.clear()
  document.documentElement.classList.remove('dark')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('TestPresentation', () => {
  it('opens in English and keeps the complete test source one action away', async () => {
    act(() => root.render(<TestPresentation test={TEST} sourceFile="/repo/e2e/checkout.spec.ts" />))

    expect(container.querySelector('[data-testid="test-presentation-english"]')).not.toBeNull()
    expect(container.textContent).toContain('Open “/checkout”')
    expect(container.textContent).toContain('Some syntax could not be translated')
    // The header names the same file:range in both modes, so switching feels
    // like changing the representation, not the component.
    expect(container.textContent).toContain('e2e/checkout.spec.ts:L10–12')
    expect(container.querySelector('[data-testid="test-presentation-code"]')).toBeNull()
    const english = container.querySelector('[data-testid="test-presentation-english"]')
    const englishOpenButton = english?.querySelector<HTMLButtonElement>('button[aria-label="Open in editor"]')
    expect(englishOpenButton).not.toBeNull()
    expect(englishOpenButton?.parentElement?.querySelector('.cl-code-shell')).not.toBeNull()
    await act(async () => {
      englishOpenButton?.click()
      await Promise.resolve()
    })
    expect(openEditor).toHaveBeenCalledWith({
      file: '/repo/e2e/checkout.spec.ts',
      line: 11,
      column: 1,
    })
    vi.mocked(openEditor).mockClear()

    await act(async () => {
      ;(container.querySelector('[data-testid="test-presentation-code-tab"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })

    expect(container.querySelector('[data-testid="test-presentation-code"]')).not.toBeNull()
    expect(container.textContent).toContain('e2e/checkout.spec.ts:L10–12')
    expect(container.textContent).toContain("await page.goto('/checkout')")
    const displayedLines = container.querySelectorAll<HTMLElement>('[data-code-line]')
    expect(displayedLines).toHaveLength(1)
    expect(displayedLines[0].dataset.codeLine).toBe('01')
    expect(displayedLines[0].dataset.codeSequence).toBe('02')
    expect(displayedLines[0].dataset.codeSequenceLabel).toBe('02')
    expect(displayedLines[0].title).toBe('English step 02')
    expect(displayedLines[0].textContent).toBe("await page.goto('/checkout')")
    const codeContent = displayedLines[0].querySelector(':scope > .cl-code-line-content')
    expect(codeContent?.textContent).toBe("await page.goto('/checkout')")
    expect(container.querySelector('[data-testid="test-presentation-code"] button[aria-label="Open in editor"]')).not.toBeNull()
    const codeBlock = container.querySelector<HTMLElement>('.cl-numbered-code')
    expect(codeBlock?.classList.contains('overflow-hidden')).toBe(true)
    expect(codeBlock?.classList.contains('overflow-x-auto')).toBe(false)
    expect(codeBlock?.classList.contains('overflow-y-hidden')).toBe(false)
  })

  it('shows changed executable steps in English and calls out changed source with no English step', async () => {
    const dirty: ExtractedTest = {
      ...TEST,
      bodySource: "{\n  await page.goto('/checkout')\n  // expect(order).toBeDefined()\n}",
      readable: {
        ...TEST.readable,
        story: {
          steps: [TEST.readable.story!.steps[1]],
        },
      },
    }
    act(() => root.render(
      <TestPresentation
        test={dirty}
        sourceFile="/repo/e2e/checkout.spec.ts"
        changedLines={new Set([2, 3])}
      />,
    ))

    const changed = container.querySelector<HTMLElement>('[data-testid="readable-story-item-open-checkout"]')
    expect(changed?.dataset.changedSource).toBe('true')
    expect(container.querySelector('[data-testid="readable-modified-open-checkout"]')?.textContent).toBe('MODIFIED')
    const unmapped = container.querySelector('[data-testid="readable-unmapped-change"]')
    expect(unmapped?.textContent).toContain('L12')
    expect(unmapped?.textContent).toContain('a check being commented out')

    await act(async () => {
      ;(Array.from(unmapped?.querySelectorAll('button') ?? [])[0] as HTMLButtonElement).click()
      await Promise.resolve()
    })
    expect(container.querySelector('[data-testid="test-presentation-code"]')).not.toBeNull()
    expect(container.querySelectorAll('[data-changed-line="true"]')).toHaveLength(2)
  })

  it('reveals a helper snippet in Code when its English node is selected', async () => {
    act(() => root.render(<TestPresentation test={TEST} sourceFile="/repo/e2e/checkout.spec.ts" />))

    await act(async () => {
      ;(container.querySelector('[data-testid="readable-story-item-helper-check"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })

    expect(container.querySelector('[data-testid="test-presentation-code"]')).not.toBeNull()
    expect(container.textContent).toContain('helpers/account.ts:L30')
    expect(container.textContent).toContain('expect(account.active).toBe(true)')
    expect(container.textContent).toContain('Full test')
    expect(container.querySelectorAll('[data-selected-line="true"]')).toHaveLength(1)
    expect(container.querySelector<HTMLElement>('[data-code-line]')?.dataset.codeSequence).toBe('03')
  })

  it('uses the matching nested English numbers and leaves structural Code rows blank', async () => {
    const nested: ExtractedTest = {
      ...TEST,
      bodyLine: 20,
      bodySource: `{
  await withConnection(async (connection) => {
    for (const item of items) {
      await send(item)
      expect(result).toBe(true)
    }
  })
}`,
      readable: {
        ...TEST.readable,
        story: {
          steps: [{
            id: 'connection-flow',
            kind: 'flow',
            flowKind: 'scope',
            role: 'setup',
            text: 'Using connection',
            spans: [{ text: 'Using connection' }],
            fidelity: 'derived',
            source: {
              file: '/repo/e2e/checkout.spec.ts',
              startLine: 21,
              endLine: 26,
              snippet: 'await withConnection(async (connection) => {})',
            },
            children: [{
              id: 'item-loop',
              kind: 'flow',
              flowKind: 'loop',
              role: 'action',
              text: 'For each item in items',
              spans: [{ text: 'For each item in items' }],
              fidelity: 'derived',
              source: {
                file: '/repo/e2e/checkout.spec.ts',
                startLine: 22,
                endLine: 25,
                snippet: 'for (const item of items) {}',
              },
              children: [
                {
                  id: 'send-item',
                  role: 'action',
                  text: 'Send item',
                  spans: [{ text: 'Send item' }],
                  fidelity: 'derived',
                  source: {
                    file: '/repo/e2e/checkout.spec.ts',
                    startLine: 23,
                    endLine: 23,
                    snippet: 'await send(item)',
                  },
                },
                {
                  id: 'check-result',
                  role: 'check',
                  text: 'Check that result equals true',
                  spans: [{ text: 'Check that result equals true' }],
                  fidelity: 'derived',
                  source: {
                    file: '/repo/e2e/checkout.spec.ts',
                    startLine: 24,
                    endLine: 24,
                    snippet: 'expect(result).toBe(true)',
                  },
                },
              ],
            }],
          }],
        },
      },
    }
    act(() => root.render(
      <TestPresentation
        test={nested}
        sourceFile="/repo/e2e/checkout.spec.ts"
        executionHighlight={{ kind: 'running', bodyLine: 4 }}
      />,
    ))

    const activeEnglish = container.querySelector<HTMLElement>('[data-execution-highlight="running"]')
    expect(activeEnglish?.textContent).toContain('Send item')
    expect(container.querySelector('[data-testid="readable-story-item-connection-flow"]')?.getAttribute('data-execution-highlight')).toBeNull()
    expect(container.querySelector('[data-testid="readable-story-item-item-loop"]')?.getAttribute('data-execution-highlight')).toBeNull()

    await act(async () => {
      ;(container.querySelector('[data-testid="test-presentation-code-tab"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })

    const lines = Array.from(container.querySelectorAll<HTMLElement>('[data-code-line]'))
    expect(lines.map((line) => line.dataset.codeLine)).toEqual(['01', '02', '03', '04', '05', '06'])
    expect(lines.map((line) => line.dataset.codeSequence)).toEqual([
      '01',
      '01.1',
      '01.1.1',
      '01.1.2',
      '',
      '',
    ])
    expect(lines.map((line) => line.dataset.codeSequenceLabel)).toEqual(['01', '1', '1', '2', '', ''])
    expect(lines.every((line) => line.querySelector(':scope > .cl-code-line-content') !== null)).toBe(true)
    expect(lines[2].dataset.executionHighlight).toBe('running')
  })

  it('uses the server-formatted line map for numbering, highlights, selection, and editor navigation', async () => {
    const formatted: ExtractedTest = {
      ...TEST,
      bodyLine: 40,
      bodySource: `{
  const message = msgs.find((item) => item.kind === 'SEND') as
    | SendMessage
    | undefined
  await send({id: message?.id,retries:2})
}`,
      codeDisplay: {
        code: `{
    const message = msgs.find((item) => item.kind === 'SEND') as SendMessage | undefined;
    await send({ id: message?.id, retries: 2 });
}`,
        lineMap: [
          { sourceLine: 40, sourceLines: [40] },
          { sourceLine: 41, sourceLines: [41, 42, 43] },
          { sourceLine: 44, sourceLines: [44] },
          { sourceLine: 45, sourceLines: [45] },
        ],
      },
      readable: {
        ...TEST.readable,
        story: {
          steps: [
            {
              id: 'find-message',
              role: 'setup',
              text: 'Find the matching message',
              spans: [{ text: 'Find the matching message' }],
              fidelity: 'derived',
              source: {
                file: '/repo/e2e/checkout.spec.ts',
                startLine: 42,
                endLine: 43,
                snippet: "msgs.find((item) => item.kind === 'SEND')",
              },
            },
            {
              id: 'send-message',
              role: 'action',
              text: 'Send the message',
              spans: [{ text: 'Send the message' }],
              fidelity: 'derived',
              source: {
                file: '/repo/e2e/checkout.spec.ts',
                startLine: 44,
                endLine: 44,
                snippet: 'await send({id: message?.id,retries:2})',
              },
            },
          ],
        },
      },
    }
    act(() => root.render(
      <TestPresentation
        test={formatted}
        sourceFile="/repo/e2e/checkout.spec.ts"
        executionHighlight={{ kind: 'running', bodyLine: 3 }}
        changedLines={new Set([5])}
      />,
    ))

    await act(async () => {
      ;(container.querySelector('[data-testid="readable-story-item-find-message"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })

    const lines = Array.from(container.querySelectorAll<HTMLElement>('[data-code-line]'))
    expect(lines).toHaveLength(2)
    expect(lines.map((line) => line.textContent)).toEqual([
      "const message = msgs.find((item) => item.kind === 'SEND') as SendMessage | undefined;",
      'await send({ id: message?.id, retries: 2 });',
    ])
    expect(lines.map((line) => line.dataset.codeSequence)).toEqual(['01', '02'])
    expect(lines.map((line) => line.dataset.sourceLine)).toEqual(['41', '44'])
    expect(lines[0].dataset.activeLine).toBe('true')
    expect(lines[0].dataset.selectedLine).toBe('true')
    expect(lines[1].dataset.changedLine).toBe('true')

    await act(async () => {
      lines[1].click()
      await Promise.resolve()
    })
    expect(openEditor).toHaveBeenCalledWith({
      file: '/repo/e2e/checkout.spec.ts',
      line: 44,
      column: 1,
    })
  })

  it('keeps every English step number after a formatted template literal', async () => {
    const sourceFile = '/repo/e2e/email-batching.spec.ts'
    const bodySource = [
      '{',
      '  const txId = `batch_17_${nowId()}`',
      '',
      '  // 3 + 5 + 9 = 17 emails, all < 50 per call → batch-processor.',
      '  // Delay queue (x-max-length=1) accepts the first trigger; subsequent ones are rejected.',
      '  // After 20s TTL the single TRIGGER_EMAIL_BATCH dead-letters to NOTIFIER_QUEUE.',
      "  await sendSeparateCalls(request, txId, [3, 5, 9], 'batch-17')",
      '',
      '  const msgs = await drainNotifierQueue(txId, 1, 60_000)',
      '',
      '  expect(msgs).toHaveLength(1)',
      "  expect(msgs[0].pattern).toBe('TRIGGER_EMAIL_BATCH')",
      '  expect((msgs[0] as TriggerBatchMessage).data.emailInfo.transactionId).toBe(txId)',
      '}',
    ].join('\n')
    const storyStep = (
      id: string,
      role: 'setup' | 'action' | 'check',
      line: number,
    ): ReadableStoryItem => ({
      id,
      role,
      text: id,
      spans: [{ text: id }],
      fidelity: 'derived',
      source: { file: sourceFile, startLine: line, endLine: line, snippet: id },
    })
    const formatted: ExtractedTest = {
      ...TEST,
      bodyLine: 22,
      bodySource,
      codeDisplay: formatCodeForDisplayWithLineMap(bodySource, 22),
      readable: {
        ...TEST.readable,
        story: {
          steps: [
            storyStep('set transaction identifier', 'setup', 23),
            storyStep('send separate calls', 'action', 28),
            storyStep('drain notifier queue', 'action', 30),
            storyStep('check message count', 'check', 32),
            storyStep('check message pattern', 'check', 33),
            storyStep('check transaction identifier', 'check', 34),
          ],
        },
      },
    }
    act(() => root.render(<TestPresentation test={formatted} sourceFile={sourceFile} />))

    await act(async () => {
      ;(container.querySelector('[data-testid="test-presentation-code-tab"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })

    const lines = Array.from(container.querySelectorAll<HTMLElement>('[data-code-line]'))
    expect(lines.map((line) => line.dataset.codeSequence)).toEqual([
      '01',
      '',
      '',
      '',
      '02',
      '03',
      '04',
      '05',
      '06',
    ])
    expect(lines.map((line) => line.dataset.codeSequenceLabel).filter(Boolean)).toEqual([
      '01',
      '02',
      '03',
      '04',
      '05',
      '06',
    ])
  })

  it('keeps physical Code numbering when an older readable payload has no story', async () => {
    const withoutStory: ExtractedTest = {
      ...TEST,
      readable: { ...TEST.readable, story: undefined },
    }
    act(() => root.render(<TestPresentation test={withoutStory} sourceFile="/repo/e2e/checkout.spec.ts" />))

    await act(async () => {
      ;(container.querySelector('[data-testid="test-presentation-code-tab"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })

    const line = container.querySelector<HTMLElement>('[data-code-line]')
    expect(line?.dataset.codeSequence).toBe('01')
    expect(line?.dataset.codeSequenceLabel).toBe('01')
  })

  it('highlights every line in an exact same-file source range', async () => {
    act(() => root.render(<TestPresentation test={TEST} sourceFile="/repo/e2e/checkout.spec.ts" />))

    await act(async () => {
      ;(container.querySelector('[data-testid="readable-story-item-checkout-step"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('e2e/checkout.spec.ts:L10–12')
    // Code mode omits the callback's standalone wrapper braces, leaving only
    // the executable source row while its file label keeps the full L10–12 range.
    expect(container.querySelectorAll('[data-selected-line="true"]')).toHaveLength(1)
    expect(container.textContent).toContain('Full test')
  })

  it('does not apply test-run highlights when helper source happens to equal the full body', async () => {
    const helperCollision: ExtractedTest = {
      ...TEST,
      readable: {
        ...TEST.readable,
        story: {
          steps: [{
            id: 'same-source-helper',
            role: 'action',
            text: 'Run matching helper',
            spans: [{ text: 'Run matching helper' }],
            fidelity: 'derived',
            source: {
              file: '/repo/e2e/helpers/matching.ts',
              startLine: 30,
              endLine: 32,
              snippet: TEST.bodySource,
            },
          }],
        },
        nodes: [{
          id: 'same-source-helper',
          kind: 'leaf',
          role: 'helper',
          text: 'Run matching helper',
          fidelity: 'derived',
          source: {
            file: '/repo/e2e/helpers/matching.ts',
            startLine: 30,
            endLine: 32,
            snippet: TEST.bodySource,
          },
        }],
      },
    }
    act(() => root.render(
      <TestPresentation
        test={helperCollision}
        sourceFile="/repo/e2e/checkout.spec.ts"
        executionHighlight={{ kind: 'running', bodyLine: 2 }}
        changedLines={new Set([2])}
      />,
    ))

    await act(async () => {
      ;(container.querySelector('[data-testid="readable-story-item-same-source-helper"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('helpers/matching.ts:L30–32')
    expect(container.querySelectorAll('[data-active-line="true"]')).toHaveLength(0)
    expect(container.querySelectorAll('[data-changed-line="true"]')).toHaveLength(0)
    expect(container.querySelectorAll('[data-selected-line="true"]')).toHaveLength(1)
  })

  it('keeps the Code view synchronized with light and dark themes', async () => {
    localStorage.setItem('canary-lab.theme', 'light')
    act(() => root.render(<TestPresentation test={TEST} sourceFile="/repo/e2e/checkout.spec.ts" />))
    await act(async () => {
      ;(container.querySelector('[data-testid="test-presentation-code-tab"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })
    expect(container.querySelector('[data-shiki-theme="one-light"]')).not.toBeNull()

    await act(async () => {
      applyTheme('dark')
      await Promise.resolve()
    })
    expect(container.querySelector('[data-shiki-theme="one-dark-pro"]')).not.toBeNull()
  })
})
