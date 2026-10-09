import fs from 'fs'
import path from 'path'
import type { FeatureConfig } from '../../../../../../../../shared/launcher/types'
import type { RunManifest } from '../../../../../../../../shared/run-manifest'
import { findFeature } from '../../../../../shared/feature-loader'
import { runManifest } from '../../__fixtures__/run-manifest'
import { diffContentForFeatureRepos, snapshotFeatureRepos } from '../../runtime/feature-repo-diff'
import { truncateDiffForJournal, writeFullDiffPatch } from '../../runtime/heal-journal'
import { readManifest, writeManifest } from '../../runtime/manifest'
import { buildRunPaths, runDirFor, runManifestPath } from '../../runtime/run-paths'
import { git, initGitRepo } from '../../../../../../../../tools/test-helpers/git-repo'
import { writeFeatureFixture } from '../../../../../../../../tools/test-helpers/feature-fixture'

export const SPEC = [
  "import { test, expect } from '@playwright/test'",
  '',
  "test('cart totals two items', async ({ page }) => {",
  "  await page.goto('/cart')",
  "  await expect(page.getByText('Total')).toBeVisible()",
  '})',
  '',
].join('\n')
export const HELPER = 'export const price = (cents: number) => cents / 100\n'
export const SERVER = 'export function total(items: number[]) {\n  return items.reduce((a, b) => a + b, 0)\n}\n'

export interface CycleRunOptions {
  /** Give the suite an app repo, so each cycle's diff carries two trees. */
  app?: boolean
}

/** A real run of the `demo` suite: a workspace repo holding the suite, an app
 * repo, and a run dir. Each `cycle` takes the snapshot the heal loop takes,
 * runs the edit, and records the diff the way the journal writer does, so
 * every `index` line and `# repo:` key in it is genuine. */
export function cycleRun(root: string, { app = true }: CycleRunOptions = {}) {
  const workspace = path.join(root, 'workspace')
  const featuresDir = path.join(workspace, 'features')
  const appDir = path.join(root, 'app')
  const logsDir = path.join(root, 'logs')
  const runId = '2026-01-01T0000-test'
  const runDir = runDirFor(logsDir, runId)
  if (app) {
    fs.mkdirSync(path.join(appDir, 'src'), { recursive: true })
    fs.writeFileSync(path.join(appDir, 'src', 'server.ts'), SERVER)
    initGitRepo(appDir)
  }
  const featureDir = writeFeatureFixture(featuresDir, 'demo', app ? { repos: [{ name: 'app', localPath: appDir }] } : {}, { specs: { 'cart.spec.ts': SPEC } })
  fs.mkdirSync(path.join(featureDir, 'helpers'))
  fs.writeFileSync(path.join(featureDir, 'helpers', 'util.ts'), HELPER)
  initGitRepo(workspace)
  const feature = (): FeatureConfig => findFeature(featuresDir, 'demo')!
  fs.mkdirSync(runDir, { recursive: true })
  writeManifest(runManifestPath(runDir), runManifest({ runId, feature: 'demo', featureDir, repoPaths: app ? [appDir] : [] }))
  let iterations = 0

  return {
    workspace, featuresDir, featureDir, appDir, logsDir, runId, runDir, feature,
    suiteDir: path.join(runDir, 'suite'),
    journalPath: buildRunPaths(runDir).diagnosisJournalPath,
    manifest: (): RunManifest => readManifest(runManifestPath(runDir))!,
    updateManifest(patch: Partial<RunManifest>): void {
      writeManifest(runManifestPath(runDir), { ...readManifest(runManifestPath(runDir))!, ...patch })
    },
    /** Write a file in the suite or the app and stage it, as a new file needs
     * to be for `git diff <snapshot>` to show it. */
    write(dir: string, rel: string, content: string): void {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
      fs.writeFileSync(path.join(dir, rel), content)
      git(dir, 'add', '--', rel)
    },
    /** Copy the live suite into the run, as the run-start copy and every
     * adoption do. */
    takeSuite(at = '2026-01-01T00:00:00.000Z'): void {
      fs.rmSync(path.join(runDir, 'suite'), { recursive: true, force: true })
      fs.cpSync(featureDir, path.join(runDir, 'suite'), { recursive: true })
      this.updateManifest({ suiteSnapshot: { kind: 'taken', dir: path.join(runDir, 'suite'), takenAt: at, digest: 'd' } })
    },
    /** `journal: 'none'` records the entry without its diff, as runs from
     * before diffs were captured did; `cut` makes the journal's size cap fall
     * that many bytes before the end of the diff. */
    async cycle(edit: () => void, { journal = 'patch', cut, at = `2026-01-01T00:0${iterations + 1}:00.000Z` }: { journal?: 'patch' | 'inline' | 'none'; cut?: number; at?: string } = {}): Promise<{ iteration: number; diff: string }> {
      const snapshots = await snapshotFeatureRepos(feature())
      edit()
      const diff = (await diffContentForFeatureRepos(snapshots)).trim()
      const iteration = ++iterations
      const section = [`## Iteration ${iteration} — ${at}`, '', '- outcome: pending', '']
      if (diff && journal !== 'none') section.push('### Diff', '', '```diff', truncateDiffForJournal(diff, cut === undefined ? undefined : Buffer.byteLength(diff) - cut), '```', '')
      fs.appendFileSync(this.journalPath, `${section.join('\n')}\n`)
      if (diff && journal === 'patch') writeFullDiffPatch(this.journalPath, iteration, diff)
      return { iteration, diff }
    },
  }
}

export type CycleRun = ReturnType<typeof cycleRun>
