import fs from 'fs'
import path from 'path'
import { readManifest } from '../../runs/logic/runtime/manifest'
import { runDirFor } from '../../runs/logic/runtime/run-paths'
import { readRunSummary } from '../../runs/logic/run-detail'
import type { PlaywrightListEntry } from '../../runs/logic/playwright-list'

/** Read the reporter's roster without evaluating historical spec modules. */
export function recordedTestList(logsDir: string | undefined, feature: string, runId: string): { dir?: string; tests: PlaywrightListEntry[] } {
  const fail = (message: string, statusCode: number): never => { throw Object.assign(new Error(message), { statusCode }) }
  if (!logsDir || !/^[\w.-]+$/.test(runId) || runId === '.' || runId === '..') return fail('Invalid run', 400)
  const runDir = runDirFor(logsDir, runId)
  const manifest = readManifest(path.join(runDir, 'manifest.json'))
  if (!manifest || manifest.feature !== feature) return fail('Run not found for this suite', 404)
  // Older runs saved results before source snapshots existed. Their locations
  // identify tests, but must never authorize reading today's workspace source.
  const dir = manifest.suiteSnapshot?.kind === 'taken' && fs.existsSync(manifest.suiteSnapshot.dir)
    ? fs.realpathSync(manifest.suiteSnapshot.dir)
    : undefined
  const known = readRunSummary(runDir)?.knownTests
  const tests = (known ?? []).map((test): PlaywrightListEntry => {
    const location = /^(.*?):(\d+)(?::\d+)?$/.exec(test.location ?? '')
    if (!location || !test.title) return fail('This run’s recorded test locations are unavailable.', 409)
    const file = path.resolve(location[1])
    // The roster is data, not authority to read outside the saved suite.
    if (dir && (!file.startsWith(`${dir}${path.sep}`) || (fs.existsSync(file) && !fs.realpathSync(file).startsWith(`${dir}${path.sep}`)))) return fail('Recorded test source is outside the saved suite.', 409)
    const line = Number(location[2])
    return { file, line, title: test.title, originFile: file, originLine: line }
  })
  return { dir, tests }
}
