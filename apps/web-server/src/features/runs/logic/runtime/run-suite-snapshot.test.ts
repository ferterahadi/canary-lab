// The run-start suite snapshot (D9): the run executes a copy of
// features/<suite>/ taken before any service or agent starts, so a spec edited
// mid-run cannot reach the process that produces the verdict.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { snapshotSuite, suiteDigest } from './run-suite-snapshot'
import { makeHealLoopContext } from './__fixtures__/heal-loop-context'
import type { RunContext } from './run-context'
import type { RunnerLog } from './runner-log'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-suite-snap-')))
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function ctxFor(state: Partial<RunContext> = {}, opts: Record<string, unknown> = {}) {
  const made = makeHealLoopContext({ root: tmpDir, opts, state })
  fs.mkdirSync(made.ctx.runDir, { recursive: true })
  return made
}

function write(dir: string, rel: string, body: string): void {
  const abs = path.join(dir, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body)
}

function fakeRunnerLog(): RunnerLog & { warnings: string[] } {
  const warnings: string[] = []
  return {
    warnings,
    warn: (m: string) => { warnings.push(m) },
    info: () => {},
    error: () => {},
  } as unknown as RunnerLog & { warnings: string[] }
}

const SPEC_A = "test('a', async () => { expect(1).toBe(1) })\n"

describe('snapshotSuite', () => {
  it('copies the suite under the run dir and points the run at the copy', () => {
    const { ctx, sink } = ctxFor()
    const live = ctx.feature.featureDir
    write(live, 'e2e/a.spec.ts', SPEC_A)
    write(live, 'e2e/helpers/api.ts', 'export const api = 1\n')
    write(live, 'playwright.config.ts', 'export default {}\n')
    write(live, 'feature.config.cjs', 'module.exports = {}\n')

    snapshotSuite(ctx)

    expect(ctx.suiteDir).toBe(ctx.paths.suiteSnapshotDir)
    expect(fs.readFileSync(path.join(ctx.suiteDir, 'e2e', 'a.spec.ts'), 'utf8')).toBe(SPEC_A)
    expect(fs.existsSync(path.join(ctx.suiteDir, 'e2e', 'helpers', 'api.ts'))).toBe(true)
    expect(fs.existsSync(path.join(ctx.suiteDir, 'playwright.config.ts'))).toBe(true)
    expect(sink.patches).toEqual([{
      suiteSnapshot: {
        kind: 'taken',
        dir: ctx.paths.suiteSnapshotDir,
        takenAt: expect.any(String),
        digest: suiteDigest(live),
      },
    }])
  })

  it('leaves envsets, node_modules and .git out of the copy', () => {
    // Envsets carry secrets and are read from the live dir by the env switcher;
    // node_modules resolves by walking up from the copy exactly as it does from
    // features/<suite>/; .git is never suite content.
    const { ctx } = ctxFor()
    const live = ctx.feature.featureDir
    write(live, 'e2e/a.spec.ts', SPEC_A)
    write(live, 'envsets/local/api.env', 'SECRET=1\n')
    write(live, 'node_modules/pkg/index.js', '')
    write(live, '.git/HEAD', 'ref: refs/heads/main\n')

    snapshotSuite(ctx)

    expect(fs.readdirSync(ctx.suiteDir).sort()).toEqual(['e2e'])
  })

  it('a mid-run edit to the live spec leaves the copy untouched', () => {
    const { ctx } = ctxFor()
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)

    snapshotSuite(ctx)
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', "test('a', async () => {})\n")

    expect(fs.readFileSync(path.join(ctx.suiteDir, 'e2e', 'a.spec.ts'), 'utf8')).toBe(SPEC_A)
  })

  it('replaces a stale copy so a re-snapshot (adopt) carries exactly the current suite', () => {
    const { ctx } = ctxFor()
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)
    write(ctx.paths.suiteSnapshotDir, 'e2e/old.spec.ts', 'gone\n')

    snapshotSuite(ctx)

    expect(fs.existsSync(path.join(ctx.suiteDir, 'e2e', 'old.spec.ts'))).toBe(false)
    expect(fs.existsSync(path.join(ctx.suiteDir, 'e2e', 'a.spec.ts'))).toBe(true)
  })

  it('falls back to the live dir, records why on the manifest, and warns when the copy fails', () => {
    // The boundary is best-effort at boot: a run that cannot copy its suite
    // still runs, but the manifest says so — a silent fallback would let the
    // UI and MCP results claim a boundary that was never there.
    const runnerLog = fakeRunnerLog()
    const { ctx, sink } = ctxFor({}, { runnerLog })
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)
    vi.spyOn(fs, 'copyFileSync').mockImplementation(() => { throw new Error('EACCES: denied') })

    snapshotSuite(ctx)

    expect(ctx.suiteDir).toBe(ctx.feature.featureDir)
    expect(sink.patches).toEqual([{
      suiteSnapshot: { kind: 'unavailable', at: expect.any(String), reason: expect.stringContaining('EACCES') },
    }])
    expect(runnerLog.warnings[0]).toContain('EACCES')
  })

  it('stringifies a non-Error throw rather than recording "undefined"', () => {
    const { ctx, sink } = ctxFor()
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)
    vi.spyOn(fs, 'copyFileSync').mockImplementation(() => { throw 'disk full' })

    snapshotSuite(ctx)

    expect(sink.patches[0]).toMatchObject({ suiteSnapshot: { kind: 'unavailable', reason: 'disk full' } })
  })
})

describe('suiteDigest', () => {
  it('changes when any spec changes and ignores file order', () => {
    const a = path.join(tmpDir, 'a')
    const b = path.join(tmpDir, 'b')
    write(a, 'e2e/x.spec.ts', SPEC_A)
    write(a, 'e2e/y.spec.ts', SPEC_A)
    write(b, 'e2e/y.spec.ts', SPEC_A)
    write(b, 'e2e/x.spec.ts', SPEC_A)
    expect(suiteDigest(a)).toBe(suiteDigest(b))

    write(b, 'e2e/x.spec.ts', "test('a', async () => {})\n")
    expect(suiteDigest(a)).not.toBe(suiteDigest(b))
  })
})
