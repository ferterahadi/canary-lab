import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { trackTempDirs } from '../../../../../../tools/test-helpers/temp-dir'
import { detail, lineOf, testEndEvent } from './__fixtures__/test-review-fixtures'
import { createEvaluationHtml } from './test-review-export'

const tempDir = trackTempDirs('cl-export-visual-')

it('exports both branches, a collapsed helper and offline source beyond the narrative step limit', async () => {
  const featureDir = tempDir()
  const spec = path.join(featureDir, 'e2e', 'order.spec.ts')
  fs.mkdirSync(path.dirname(spec))
  const source = [
    "import { reserve } from './reserve'",
    "test('orders', async () => {",
    '  if (available) await reserve(); else await cancel()',
    ...Array.from({ length: 30 }, (_, i) => '  await record(' + i + ')'),
    '})',
  ].join('\n')
  fs.writeFileSync(spec, source)
  fs.writeFileSync(path.join(path.dirname(spec), 'reserve.ts'), 'export async function reserve() { await holdOrder() }')
  const html = await createEvaluationHtml(detail({ featureDir, title: 'orders', eventLocation: spec + ':' + lineOf(source, "test('orders'") }))
  const visual = html.slice(html.indexOf('<section class="subsection visual-flow">'), html.indexOf('<summary>Step summary'))
  expect(visual).toContain('>Yes</text>')
  expect(visual).toContain('>No</text>')
  expect(visual).toContain('1 source step</summary>')
  expect(visual).toContain('await holdOrder()')
  expect(visual).toContain('await record(29)')
  const links = [...visual.matchAll(/href="#([^"]+)"/g)].map(match => match[1])
  expect(links.length).toBeGreaterThan(60)
  for (const link of links) expect(visual).toContain('id="' + link + '"')
})

it('keeps a same-title never-run case separate and overlays only the recorded source revision', async () => {
  const featureDir = tempDir()
  const e2e = path.join(featureDir, 'e2e')
  fs.mkdirSync(e2e)
  const first = path.join(e2e, 'first.spec.ts')
  const second = path.join(e2e, 'second.spec.ts')
  const source = "test('orders', async () => {\n  await submit()\n})"
  fs.writeFileSync(first, source)
  fs.writeFileSync(second, source.replace('submit', 'neverCalled'))
  const run = detail({ featureDir, title: 'orders', eventLocation: first + ':1' })
  run.manifest.suiteSnapshot = { kind: 'taken', dir: featureDir, digest: 'snapshot', takenAt: run.manifest.startedAt }
  const end = testEndEvent(run)
  const identity = { ...end.test, id: 'first' }
  const flow = { stream: 'worker', execution: 1, retry: 1, revision: createHash('sha256').update(source).digest('hex') }
  const step = { category: 'pw:api', title: 'submit', location: first + ':2' }
  run.playbackEvents = [
    { type: 'test-begin', time: end.time, test: identity, flow: { ...flow, sequence: 0 } },
    { type: 'step-begin', time: end.time, test: identity, flow: { ...flow, sequence: 1, stepId: 1 }, step },
    { type: 'step-end', time: end.time, test: identity, flow: { ...flow, sequence: 2, stepId: 1, outcome: 'completed' }, step },
    { ...end, test: identity, retry: 1, flow: { ...flow, sequence: 3 } },
  ]
  run.summary = { ...run.summary!, total: 2, passedIds: ['first'], knownTests: [identity, { ...identity, id: 'second', location: second + ':1' }] }
  const html = await createEvaluationHtml(run)
  const cases = html.split('<article class="case"').slice(1).map(card => card.split('</article>')[0])
  expect(cases).toHaveLength(2)
  expect(cases[0]).toContain('data-status="passed"')
  expect(cases[0]).toContain('Attempt 2 · recorded step observations')
  expect(cases[0]).toContain('Observed ×1')
  expect(cases[0]).not.toContain('neverCalled')
  expect(cases[1]).toContain('data-status="notRun"')
  expect(cases[1]).toContain('neverCalled')
  expect(cases[1]).toContain('Historical step evidence unavailable')
  expect(cases[1]).not.toContain('Observed ×1')
  fs.writeFileSync(first, source.replace('submit', 'laterEdit'))
  const stale = await createEvaluationHtml(run)
  expect(stale).not.toContain('Observed ×1')
  expect(stale).toContain('Historical step evidence unavailable')
})
