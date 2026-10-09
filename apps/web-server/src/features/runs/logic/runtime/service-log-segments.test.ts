import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'fs'
import { preserveAndTruncateServiceLog } from './service-log-segments'
import { makeHealLoopContext } from './__fixtures__/heal-loop-context'
import type { RunContext } from './run-context'
import type { RunnerLog } from './runner-log'
import { trackTempDirs } from '../../../../../../../tools/test-helpers/temp-dir'

const tempDir = trackTempDirs('cl-svc-seg-')
let tmpDir: string

beforeEach(() => {
  tmpDir = tempDir()
})

function ctxFor(state: Partial<RunContext> = {}, opts: Record<string, unknown> = {}) {
  const { ctx } = makeHealLoopContext({ root: tmpDir, opts, state })
  fs.mkdirSync(ctx.runDir, { recursive: true })
  return ctx
}

describe('preserveAndTruncateServiceLog', () => {
  it('keeps each execution\'s output in its own segment while the live log restarts empty', () => {
    const ctx = ctxFor({ currentExecution: { index: 1, afterCycle: 0 } })
    const live = ctx.paths.serviceLog('api')
    fs.writeFileSync(live, 'boot\n<test-case-a>\nPOST /pay 500\n</test-case-a>\n')
    preserveAndTruncateServiceLog(ctx, 'api')
    ctx.currentExecution = { index: 2, afterCycle: 1 }
    fs.writeFileSync(live, '<test-case-a>\nPOST /pay 200\n</test-case-a>\n')
    preserveAndTruncateServiceLog(ctx, 'api')

    expect(fs.readFileSync(live, 'utf-8')).toBe('')
    expect(fs.readFileSync(ctx.paths.serviceLogSegment('api', 1), 'utf-8')).toContain('POST /pay 500')
    expect(fs.readFileSync(ctx.paths.serviceLogSegment('api', 2), 'utf-8')).toContain('POST /pay 200')
  })

  it('appends a second truncation with no execution in between instead of overwriting', () => {
    const ctx = ctxFor({ currentExecution: { index: 1, afterCycle: 0 } })
    const live = ctx.paths.serviceLog('api')
    fs.writeFileSync(live, 'first\n')
    preserveAndTruncateServiceLog(ctx, 'api')
    fs.writeFileSync(live, 'restart output\n')
    preserveAndTruncateServiceLog(ctx, 'api')
    expect(fs.readFileSync(ctx.paths.serviceLogSegment('api', 1), 'utf-8')).toBe('first\nrestart output\n')
  })

  it('files boot output before any execution as segment 0 and resumes numbering after a restart', () => {
    const fresh = ctxFor()
    fs.writeFileSync(fresh.paths.serviceLog('api'), 'boot only\n')
    preserveAndTruncateServiceLog(fresh, 'api')
    expect(fs.readFileSync(fresh.paths.serviceLogSegment('api', 0), 'utf-8')).toBe('boot only\n')

    fs.writeFileSync(fresh.paths.manifestPath, JSON.stringify({ playwrightExecutions: 3 }))
    fs.writeFileSync(fresh.paths.serviceLog('api'), 'from the previous process\n')
    preserveAndTruncateServiceLog(fresh, 'api')
    expect(fs.existsSync(fresh.paths.serviceLogSegment('api', 3))).toBe(true)
  })

  it('keeps an empty segment for a quiet log, nothing for a never-created one, and stays quiet about both', () => {
    const warn = vi.fn()
    const ctx = ctxFor({}, { runnerLog: { warn, info: () => {}, error: () => {} } as unknown as RunnerLog })
    preserveAndTruncateServiceLog(ctx, 'never-started')
    fs.writeFileSync(ctx.paths.serviceLog('quiet'), '')
    preserveAndTruncateServiceLog(ctx, 'quiet')
    // An empty segment says "retained, printed nothing" — a missing one would
    // read as a run that predates segments.
    expect(fs.readFileSync(ctx.paths.serviceLogSegment('quiet', 0), 'utf-8')).toBe('')
    expect(fs.existsSync(ctx.paths.serviceLogSegment('never-started', 0))).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  })

  it('warns when the segment cannot be written and still empties the live log', () => {
    const warn = vi.fn()
    const ctx = ctxFor({}, { runnerLog: { warn, info: () => {}, error: () => {} } as unknown as RunnerLog })
    fs.writeFileSync(ctx.paths.serviceLog('api'), 'output\n')
    // A plain file where the segment directory belongs.
    fs.writeFileSync(`${ctx.runDir}/service-logs`, 'blocking file')
    preserveAndTruncateServiceLog(ctx, 'api')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('preserve service log api failed'))
    expect(fs.readFileSync(ctx.paths.serviceLog('api'), 'utf-8')).toBe('')
  })
})
