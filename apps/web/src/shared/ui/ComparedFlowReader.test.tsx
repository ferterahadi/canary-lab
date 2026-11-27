// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { reviewSourceFor } from '../../../../web-server/src/shared/readable-tests/review-source'
import { reviewCaseKey } from '@shared/test-review'
import { TestPresentation } from './TestPresentation'
import type { ComparisonJump } from '../lib/workspace-view-state'

it('keeps additions, old paths, threshold edits and a helper change in one reader across expansion and refresh', async () => {
  const file = 'e2e/timing.spec.ts'
  const old = [
    'function waitForResponse() {',
    '  return wait(30000)',
    '}',
    "test('timing', async () => {",
    '  await waitForResponse()',
    '  expect(status).toBe(201)',
    '  expect(elapsedMs).toBeLessThan(1500)',
    "  expect(statusName).toBe('QUEUED')",
    '  saveResponse()',
    '})',
  ].join('\n')
  const make = (limit: number) => {
    const current = old
      .replace('wait(30000)', 'wait(15000)')
      .replace('1500)', limit + ')')
      .replace('  expect(elapsedMs)', '  expect(requestId).toBeTruthy()\n  expect(elapsedMs)')
      .replace("  expect(statusName).toBe('QUEUED')\n", '')
    const before = reviewSourceFor(file, old, undefined, { side: 'before', withTests: true })
    const after = reviewSourceFor(file, current, undefined, { side: 'after', withTests: true })
    const pair = { before: reviewCaseKey(before.tests[0]), after: reviewCaseKey(after.tests[0]) }
    return { before, after, declarationPairs: [pair] }
  }
  function Harness({ data }: { data: ReturnType<typeof make> }) {
    const [inspection, setInspection] = useState<ComparisonJump>()
    return (
      <TestPresentation
        view="aligned"
        mode="english"
        review={data}
        rows={[]}
        labels={{ before: 'Recorded', after: 'Current' }}
        scopedCase={data.declarationPairs[0]}
        inspection={inspection}
        onInspect={setInspection}
      />
    )
  }
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const click = async (el: Element, meta = false) =>
    act(async () => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: meta }))
    })
  const modal = () => document.querySelector('[data-testid="expanded-test-reader"]')!
  try {
    await act(async () => root.render(<Harness data={make(2000)} />))
    const rows = () => [...host.querySelectorAll('.cm-line[data-diff]')]
    expect(rows().map((row) => row.getAttribute('data-diff'))).toEqual(['inside', 'added', 'modified', 'removed'])
    expect(rows()[2].textContent).toMatch(/1\.5.*2|1500.*2000/)
    await click(rows()[0].querySelector('.outline-label')!)
    expect(host.querySelector('.cm-line[data-diff=modified]')?.textContent).toMatch(/30000.*15000/)
    await click(host.querySelector('[aria-label="Back to caller"]')!)
    await click(host.querySelector('.location-action')!)
    const group = (kind: string) => modal().querySelector('.cl-flow-shape[data-diff=' + kind + ']')!
    for (const k of ['inside', 'added', 'modified', 'removed']) expect(group(k)).toBeTruthy()
    expect(modal().querySelector('.cl-flow-edge[data-revision=before]')).toBeTruthy()
    expect(modal().querySelector('.cl-flow-edge[data-revision=after]')).toBeTruthy()
    await click(group('removed').querySelector('button')!, true)
    expect(modal().querySelector('[aria-label="Test source"]')?.textContent).toContain('QUEUED')
    await click(modal().querySelector('[aria-label="Back to caller"]')!)
    await click(group('inside').querySelector('button')!)
    expect(group('modified').textContent).toMatch(/30000.*15000/)
    await click(modal().querySelector('[aria-label="Back to caller"]')!)
    await act(async () => root.render(<Harness data={make(2500)} />))
    expect(group('modified').textContent).toMatch(/2\.5|2500/)
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})
