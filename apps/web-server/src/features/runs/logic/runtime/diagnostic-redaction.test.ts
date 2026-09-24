import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  classifyBootEvidence,
  diagnosticExcerpt,
  redactDiagnosticText,
} from './diagnostic-redaction'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-boot-evidence-')))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('diagnostic evidence', () => {
  it('bounds excerpts and redacts credentials before persistence', () => {
    const logPath = path.join(tmpDir, 'service.log')
    fs.writeFileSync(logPath, `${'x'.repeat(128)}\nTOKEN=private-value\nBearer bearer-value`)

    const evidence = diagnosticExcerpt(logPath, 64)

    expect(evidence.truncated).toBe(true)
    expect(Buffer.byteLength(evidence.excerpt ?? '')).toBeLessThanOrEqual(64)
    expect(evidence.excerpt).toContain('TOKEN=[REDACTED]')
    expect(evidence.excerpt).toContain('Bearer [REDACTED]')
    expect(evidence.excerpt).not.toContain('private-value')
    expect(evidence.excerpt).not.toContain('bearer-value')
  })

  it('redacts URL credentials and command flags', () => {
    expect(redactDiagnosticText('postgres://user:pass@db --api-key abc\nAuthorization: Basic credential\nCookie: sid=value; other=secret')).toBe(
      'postgres://user:[REDACTED]@db --api-key [REDACTED]\nAuthorization: [REDACTED]\nCookie: [REDACTED]',
    )
  })

  it('trims every replacement character when a byte limit begins inside a multi-byte character', () => {
    const logPath = path.join(tmpDir, 'emoji.log')
    fs.writeFileSync(logPath, '😀')

    const evidence = diagnosticExcerpt(logPath, 2)

    expect(evidence).toEqual({ excerpt: '', truncated: true })
  })
})

describe('classifyBootEvidence', () => {
  it.each([
    [{ reason: 'process-exited' as const, excerpt: '' }, 'empty-output'],
    [{ reason: 'process-exited' as const, excerpt: 'killed', signal: 'SIGKILL' }, 'abrupt-signal'],
    [{ reason: 'process-exited' as const, excerpt: 'seed database\nError: insert failed', exitCode: 1 }, 'seed-failure'],
    [{ reason: 'process-exited' as const, excerpt: 'build\nTS2322: wrong type', exitCode: 1 }, 'compiler-failure'],
    [{ reason: 'process-exited' as const, excerpt: 'startup rejected\nError: database unavailable', exitCode: 1 }, 'rejected-startup'],
    [{ reason: 'process-exited' as const, excerpt: 'wrapper exited', exitCode: 1 }, 'underlying-cause-not-preserved'],
    [{ reason: 'process-exited' as const, excerpt: 'boot\nError: port in use', exitCode: 0 }, 'underlying-cause-not-preserved'],
  ])('classifies %j as %s', (input, expected) => {
    expect(classifyBootEvidence(input)).toBe(expected)
  })

  // A classification exists to say something `reason` does not. Evidence that
  // only confirms the reason must add no value at all, or the UI and the heal
  // packet would print the reason twice under two labels.
  it.each([
    [{ reason: 'health-timeout' as const, excerpt: 'listening delayed\nretrying health probe' }],
    [{ reason: 'process-exited' as const, excerpt: 'boot failed\nError: port in use', exitCode: 1 }],
  ])('adds no classification when the evidence only restates the reason (%j)', (input) => {
    expect(classifyBootEvidence(input)).toBeNull()
  })
})
