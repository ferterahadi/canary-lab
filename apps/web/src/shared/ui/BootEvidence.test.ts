import { describe, expect, it } from 'vitest'
import { COMPILER_FAILURE_NEXT_ACTION } from '@shared/run-state'
import { bootFailureSummary, bootNextAction, bootProcessLabel, compilerErrors } from './BootEvidence'

describe('bootFailureSummary', () => {
  it('names a failed build over the timeout a live watcher reports', () => {
    expect(bootFailureSummary({ reason: 'compiler-failed' })).toBe('Service build failed before it became ready.')
    expect(bootFailureSummary({ reason: 'health-timeout', classification: 'compiler-failure' })).toBe('Service build failed before it became ready.')
    expect(bootFailureSummary({ reason: 'health-timeout' })).toBe('Service did not become ready before the timeout.')
    expect(bootFailureSummary({ reason: 'spawn-failed' })).toBe('Service could not be started.')
    expect(bootFailureSummary({ reason: 'process-exited' })).toBe('Service exited before becoming ready.')
    expect(bootFailureSummary({ reason: 'dependency-incompatible' })).toBe('Startup was blocked by incompatible dependencies.')
  })
})

describe('bootNextAction', () => {
  it('derives the compiler advice on read, so an old record reads like a fresh one', () => {
    expect(bootNextAction({ reason: 'health-timeout', classification: 'compiler-failure', nextAction: 'Check the health URL.' })).toBe(COMPILER_FAILURE_NEXT_ACTION)
    expect(bootNextAction({ reason: 'health-timeout', nextAction: 'Check the health URL.' })).toBe('Check the health URL.')
  })
})

describe('compilerErrors', () => {
  it('reads webpack headers with their message, stopping at the code frame', () => {
    const excerpt = [
      'webpack 5.97.1 compiled with 2 errors',
      'ERROR in ./apps/api/src/app.ts:3:1',
      'TS2322: Type string is not',
      '  assignable to number.',
      '  1 | import x',
      '> 3 | const a: number = "b"',
      'ERROR in ./libs/util.ts:9:4',
      'Module not found',
      'webpack compiled with 1 error',
    ].join('\n')
    expect(compilerErrors(excerpt)).toEqual([
      { file: 'apps/api/src/app.ts', line: 3, column: 1, code: 'TS2322', message: 'Type string is not assignable to number.' },
      { file: 'libs/util.ts', line: 9, column: 4, message: 'Module not found' },
    ])
  })

  it('reads both tsc formats and keeps one row per location however often it repeats', () => {
    const excerpt = [
      'src/a.ts:1:2 - error TS1117: Duplicate key.',
      './src/b.ts(4,5): error TS2305: No export.',
      'src/a.ts:1:2 - error TS1117: Duplicate key.',
      'ERROR in src/b.ts:4:5',
      'TS2305: No export.',
    ].join('\r\n')
    expect(compilerErrors(excerpt)).toEqual([
      { file: 'src/a.ts', line: 1, column: 2, code: 'TS1117', message: 'Duplicate key.' },
      { file: 'src/b.ts', line: 4, column: 5, code: 'TS2305', message: 'No export.' },
    ])
  })

  it('finds nothing in output without compiler errors', () => {
    expect(compilerErrors(undefined)).toEqual([])
    expect(compilerErrors('Error: listen EADDRINUSE')).toEqual([])
    expect(compilerErrors('ERROR in ./src/a.ts:1:1')).toEqual([{ file: 'src/a.ts', line: 1, column: 1, message: '' }])
  })
})

describe('bootProcessLabel', () => {
  it('prefers the signal, then the exit code, then says nothing was captured', () => {
    expect(bootProcessLabel({ reason: 'process-exited', signal: 'SIGTERM', exitCode: 1 })).toBe('signal SIGTERM')
    expect(bootProcessLabel({ reason: 'process-exited', exitCode: 1 })).toBe('exit 1')
    expect(bootProcessLabel({ reason: 'health-timeout' })).toBe('not captured')
  })
})
