import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { beforeEach, expect, it } from 'vitest'
import { trackTempDirs } from './test-helpers/temp-dir'

const repo = path.resolve(import.meta.dirname, '..')
const tempDir = trackTempDirs('wire-contract-')
let temp: string
beforeEach(() => { temp = tempDir() })

// Feed deliberate source drift to the actual checker without modifying the checkout.
it.each([
  ['apps/web/src/shared/api/workspace-socket.ts', "export type WorkspaceEvent = { type: 'changed' }", 'WorkspaceEvent'],
  ['apps/web-server/src/shared/ws/workspace-stream.ts', "export type WorkspaceStreamFrame = { type: 'connected' }", 'WorkspaceStreamFrame'],
  ['apps/web/src/shared/api/config.ts', 'export interface GettingStartedSessionState { active: null }', 'GettingStartedSessionState'],
  ['apps/web-server/src/features/config/routes/onboarding.ts', "export type OnboardingWorkflowId = 'run'", 'OnboardingWorkflowId'],
  ['apps/web/src/shared/api/benchmark.ts', 'export interface BenchmarkIndexEntry { benchmarkId: string }', 'BenchmarkIndexEntry'],
  ['apps/web-server/src/features/benchmark/logic/runtime/types.ts', "export type BenchmarkStatus = 'done'", 'BenchmarkStatus'],
  ['apps/web/src/shared/api/benchmark.ts', "export type SabotageLevel = 'min'", 'SabotageLevel'],
  ['apps/web/src/shared/api/runs.ts', 'interface RunManifest { runId: string }', 'RunManifest'],
  ['apps/web-server/src/features/runs/logic/run-detail.ts', 'export type RunSummary = { total: number }', 'RunSummary'],
  ['apps/web/src/features/benchmark/state/benchmark-state.ts', 'bypass', 'BenchmarkIndexEntry'],
  ['apps/web-server/src/features/benchmark/logic/runtime/store.ts', 'bypass', 'BenchmarkIndexEntry'],
  ['apps/web/src/shared/api/portify.ts', "export interface PortifyIndexEntry { workflowId: string }", 'PortifyIndexEntry'],
  ['apps/web-server/src/features/portify/logic/runtime/types.ts', "export type PortifyStatus = 'editing'", 'PortifyStatus'],
  ['apps/web/src/features/portify/state/portify-state.ts', 'bypass', 'PortifyIndexEntry'],
  ['apps/web-server/src/features/portify/logic/runtime/store.ts', 'bypass', 'PortifyIndexEntry'],
])('rejects drift in %s: %s', (file, mutation, typeName) => {
  const checker = fs.readFileSync(path.join(repo, 'tools/check-wire-contracts.mjs'), 'utf8')
    .replace("import { REPO, walk } from './lib/fs.mjs'", `import { walk } from ${JSON.stringify(path.join(repo, 'tools/lib/fs.mjs'))}\nconst REPO = ${JSON.stringify(repo)}`)
    .replace("return readFileSync(path.join(REPO, rel), 'utf8')", `
      const source = readFileSync(path.join(REPO, rel), 'utf8')
      if (rel !== ${JSON.stringify(file)}) return source
      return ${mutation === 'bypass'
        // A bypass on either form: calling the converter, or handing it to the
        // shared record-index store as its `entryOf`.
        ? "source.replace(/(?:portify|benchmark)IndexEntry\\(/g, 'localProjection(').replace(/entryOf: (?:portify|benchmark)IndexEntry/g, 'entryOf: localProjection')"
        : `source + ${JSON.stringify('\n' + mutation)}`}
    `)
  const script = path.join(temp, 'check.mjs')
  fs.writeFileSync(script, checker)
  fs.copyFileSync(path.join(repo, 'tools/shared-behavior-contracts.mjs'), path.join(temp, 'shared-behavior-contracts.mjs'))
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(typeName)
  expect(result.stderr).toContain(mutation === 'bypass' ? 'must use it' : 'declares its own copy')
})

it('accepts the canonical wire declarations', () => {
  const result = spawnSync(process.execPath, [path.join(repo, 'tools/check-wire-contracts.mjs')], { encoding: 'utf8' })
  expect(result.status).toBe(0)
})
