import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { cycleRun, SPEC, type CycleRun } from './__fixtures__/cycle-run'
import { buildRunCycleReview } from './cycle-review-builder'
import { cyclePatchPath } from './cycle-sources'
import { runManifestPath } from '../runtime/run-paths'
import { git } from '../../../../../../../tools/test-helpers/git-repo'
import { trackTempDirs } from '../../../../../../../tools/test-helpers/temp-dir'

const tempDir = trackTempDirs('cl-cycle-builder-')

const build = (run: CycleRun, iteration: number) => buildRunCycleReview({ logsDir: run.logsDir, featuresDir: run.featuresDir }, run.runId, iteration)

function edit(dir: string, rel: string, from: string, to: string): void {
  const file = path.join(dir, rel)
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(from, to))
}

async function twoTreeCycle(run: CycleRun) {
  return run.cycle(() => {
    edit(run.featureDir, 'e2e/cart.spec.ts', "'/cart'", "'/basket'")
    edit(run.featureDir, 'helpers/util.ts', 'cents / 100', 'cents / 100.0')
    edit(run.appDir, 'src/server.ts', ', 0)', ', 1)')
    run.write(run.featureDir, 'data/seed.json', '{ "items": 2 }\n')
  })
}

describe('buildRunCycleReview', () => {
  it('serves each file with its role, its full versions, and English only for the suite\'s code', async () => {
    const run = cycleRun(tempDir())
    run.takeSuite()
    await twoTreeCycle(run)
    const review = (await build(run, 1))!
    expect(review).toMatchObject({ iteration: 1, source: 'patch', patchPath: cyclePatchPath(run.runDir, 1), truncated: false, healMode: 'service' })
    const byPath = Object.fromEntries(review.files.map((file) => [file.path.split('/').pop(), file]))
    expect(byPath['cart.spec.ts']).toMatchObject({ role: 'spec', language: 'typescript', recovery: { kind: 'reconstructed', verified: 'blob' }, executed: { kind: 'inert' } })
    expect(byPath['cart.spec.ts'].sources!.before.source).toBe(SPEC)
    expect(byPath['cart.spec.ts'].sources!.after.tests.map((test: { name: string }) => test.name)).toEqual(['cart totals two items'])
    expect(byPath['cart.spec.ts'].sources!.after.story?.steps.length).toBeGreaterThan(0)
    expect(byPath['cart.spec.ts'].sources!.patch).toContain("+  await page.goto('/basket')")
    expect(byPath['util.ts']).toMatchObject({ role: 'support', sources: { after: { tests: [] } } })
    expect(byPath['util.ts'].sources!.after.story).toBeDefined()
    expect(byPath['seed.json']).toMatchObject({ role: 'support', language: 'json', change: 'added', sources: { before: { source: '', tests: [] }, after: { tests: [] } } })
    expect(byPath['seed.json'].sources!.after.story).toBeUndefined()
    expect(byPath['server.ts']).toMatchObject({ role: 'app', recovery: { kind: 'exact', from: 'before-blob', repo: run.appDir }, sources: { after: { tests: [] } } })
    expect(byPath['server.ts'].sources!.after.story).toBeUndefined()
    expect(byPath['server.ts'].executed).toBeUndefined()
    expect(review.files.every((file) => !('hunks' in file))).toBe(true)
  })

  it('says whether the run executed a suite edit', async () => {
    const run = cycleRun(tempDir())
    const adopt = (at: string, by: 'human' | 'test-heal', files = ['e2e/cart.spec.ts']) =>
      run.updateManifest({ specEdits: { checkedAt: 'x', pending: [], adopted: [{ at, by, files }] } })
    await run.cycle(() => edit(run.featureDir, 'e2e/cart.spec.ts', "'/cart'", "'/basket'"), { at: '2026-01-01T00:01:00.000Z' })
    expect((await build(run, 1))!.files[0].executed).toEqual({ kind: 'live' })
    // The test-heal rule adopts just after the cycle's entry is written.
    run.takeSuite()
    adopt('2026-01-01T00:01:30.000Z', 'test-heal')
    await run.cycle(() => edit(run.featureDir, 'e2e/cart.spec.ts', "'Total'", "'Sum'"), { at: '2026-01-01T00:05:00.000Z' })
    expect((await build(run, 1))!.files[0].executed).toEqual({ kind: 'adopted', by: 'test-heal', at: '2026-01-01T00:01:30.000Z' })
    // That adoption falls inside cycle 2 too, but the copy holds cycle 1's version.
    expect((await build(run, 2))!.files[0].executed).toEqual({ kind: 'inert' })
    // A person adopting while cycle 2 was still open took its edit.
    run.takeSuite()
    adopt('2026-01-01T00:04:00.000Z', 'human')
    expect((await build(run, 2))!.files[0].executed).toEqual({ kind: 'adopted', by: 'human', at: '2026-01-01T00:04:00.000Z' })
    adopt('2026-01-01T00:00:30.000Z', 'human')
    expect((await build(run, 2))!.files[0].executed).toEqual({ kind: 'inert' })
    adopt('2026-01-01T00:04:00.000Z', 'human', ['helpers/util.ts'])
    expect((await build(run, 2))!.files[0].executed).toEqual({ kind: 'inert' })
  })

  it('reads a deleted file\'s absence from the copy as holding its after side', async () => {
    const run = cycleRun(tempDir())
    run.takeSuite()
    await run.cycle(() => git(run.workspace, 'rm', '-qf', 'features/demo/helpers/util.ts'), { at: '2026-01-01T00:01:00.000Z' })
    run.takeSuite()
    run.updateManifest({ specEdits: { checkedAt: 'x', pending: [], adopted: [{ at: '2026-01-01T00:00:30.000Z', by: 'human', files: ['helpers/util.ts'] }] } })
    expect((await build(run, 1))!.files[0].executed).toEqual({ kind: 'adopted', by: 'human', at: '2026-01-01T00:00:30.000Z' })
  })

  it('opens the window at the run\'s start when no earlier cycle was journaled, and reads the heal mode', async () => {
    const run = cycleRun(tempDir(), { app: false })
    const { diff } = await run.cycle(() => edit(run.featureDir, 'e2e/cart.spec.ts', "'/cart'", "'/basket'"))
    run.takeSuite()
    fs.rmSync(run.journalPath)
    fs.writeFileSync(cyclePatchPath(run.runDir, 4), diff)
    const adopt = (at: string) => run.updateManifest({ specEdits: { checkedAt: 'x', pending: [], adopted: [{ at, by: 'human', files: ['e2e/cart.spec.ts'] }] } })
    adopt('2026-01-01T00:00:01.000Z')
    expect((await build(run, 4))!).toMatchObject({ healMode: 'test', source: 'patch', files: [{ executed: { kind: 'adopted', by: 'human', at: '2026-01-01T00:00:01.000Z' } }] })
    adopt('2025-12-31T23:59:00.000Z')
    expect((await build(run, 4))!.files[0].executed).toEqual({ kind: 'inert' })
    // With no blob id to check the copy against, a mid-cycle adoption is not counted.
    fs.writeFileSync(cyclePatchPath(run.runDir, 4), diff.replace(/^index .*\n/m, ''))
    adopt('2026-01-01T00:00:01.000Z')
    expect((await build(run, 4))!.files[0].executed).toEqual({ kind: 'inert' })
    // Nor when the copy lacks the file the id names.
    fs.writeFileSync(cyclePatchPath(run.runDir, 4), diff)
    fs.rmSync(path.join(run.suiteDir, 'e2e/cart.spec.ts'))
    expect((await build(run, 4))!.files[0].executed).toEqual({ kind: 'inert' })
  })

  it('reads the journal\'s inline diff when no patch was kept, and says it was cut', async () => {
    const run = cycleRun(tempDir())
    await run.cycle(() => edit(run.appDir, 'src/server.ts', ', 0)', ', 1)'), { journal: 'inline', cut: 20 })
    const review = (await build(run, 1))!
    expect(review).toMatchObject({ source: 'journal', patchPath: null, truncated: true })
    expect(review.files[0]).toMatchObject({ truncated: true, recovery: { kind: 'patch-only', reason: 'truncated' } })
    expect(review.files[0].sources).toBeUndefined()
  })

  it('skips English for a very large file and keeps the code', async () => {
    const run = cycleRun(tempDir())
    const big = Array.from({ length: 5001 }, (_, i) => `export const v${i} = ${i}`).join('\n') + '\n'
    run.write(run.featureDir, 'helpers/big.ts', big)
    await run.cycle(() => edit(run.featureDir, 'helpers/big.ts', 'v0 = 0', 'v0 = -1'))
    const [file] = (await build(run, 1))!.files
    expect(file.sources!.before).toEqual({ source: big, tests: [], parseError: 'English skipped: file over 5000 lines' })
  })

  it('returns null for a cycle with no recorded diff', async () => {
    const run = cycleRun(tempDir())
    await run.cycle(() => undefined)
    expect(await build(run, 1)).toBeNull()
    expect(await build(run, 2)).toBeNull()
  })

  it('shows every file from its diff when the run\'s manifest is gone', async () => {
    const run = cycleRun(tempDir())
    await twoTreeCycle(run)
    fs.rmSync(runManifestPath(run.runDir))
    const review = (await build(run, 1))!
    expect(review.healMode).toBe('service')
    expect(review.files.filter((file) => file.change !== 'added').map((file) => [file.role, file.recovery])).toEqual([
      ['app', { kind: 'patch-only', reason: 'no-tree' }],
      ['app', { kind: 'patch-only', reason: 'no-tree' }],
      ['app', { kind: 'patch-only', reason: 'no-tree' }],
    ])
    expect(review.files.every((file) => file.executed === undefined)).toBe(true)
  })

  it('serves a repeat request from memory until an input changes', async () => {
    const run = cycleRun(tempDir())
    run.takeSuite()
    await run.cycle(() => edit(run.featureDir, 'e2e/cart.spec.ts', "'/cart'", "'/basket'"))
    const first = await build(run, 1)
    expect(await build(run, 1)).toBe(first)
    const suiteFile = path.join(run.suiteDir, 'e2e/cart.spec.ts')
    fs.utimesSync(suiteFile, new Date(), new Date(Date.now() + 60_000))
    expect(await build(run, 1)).not.toBe(first)
    fs.rmSync(suiteFile)
    const missing = await build(run, 1)
    expect(missing).not.toBe(first)
    expect(await build(run, 1)).toBe(missing)
  })

  it('reads again when a tree comes or goes, or the copy changes under an earlier name', async () => {
    const run = cycleRun(tempDir())
    run.takeSuite()
    await run.cycle(() => {
      git(run.workspace, 'mv', 'features/demo/helpers/util.ts', 'features/demo/helpers/money.ts')
      edit(run.appDir, 'src/server.ts', 'a + b', 'a + b + 0')
    })
    const first = await build(run, 1)
    fs.renameSync(run.appDir, `${run.appDir}-moved`)
    const moved = await build(run, 1)
    expect(moved).not.toBe(first)
    expect(moved!.files.find((file) => file.path === 'src/server.ts')!.recovery).toEqual({ kind: 'patch-only', reason: 'repo-missing' })
    const second = await build(run, 1)
    expect(second).toBe(moved)
    // The renamed file is read from the copy under its old name.
    fs.utimesSync(path.join(run.suiteDir, 'helpers/util.ts'), new Date(), new Date(Date.now() + 60_000))
    expect(await build(run, 1)).not.toBe(second)
  })

  it('keeps a bounded number of reviews in memory, dropping the oldest', async () => {
    const root = tempDir()
    const runs = Array.from({ length: 65 }, (_, i) => {
      const dir = path.join(root, `run-${i}`, 'logs', 'runs', 'r')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'diagnosis-journal.md'), `## Iteration 1\n\n### Diff\n\n\`\`\`diff\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b${i}\n\`\`\`\n`)
      return { logsDir: path.join(root, `run-${i}`, 'logs'), featuresDir: root }
    })
    const first = await buildRunCycleReview(runs[0], 'r', 1)
    expect(await buildRunCycleReview(runs[0], 'r', 1)).toBe(first)
    for (const deps of runs.slice(1)) await buildRunCycleReview(deps, 'r', 1)
    expect(await buildRunCycleReview(runs[0], 'r', 1)).not.toBe(first)
  })
})
