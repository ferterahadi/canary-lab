import { describe, expect, it } from 'vitest'
import { readWatchCompilerFailure } from './watch-compiler-result'

describe('watch compiler result', () => {
  it('detects a completed failed webpack build across PTY chunks', () => {
    const first = readWatchCompilerFailure('', '[2] webpack 5.89.0 compiled with 8 er')
    expect(first.failed).toBe(false)
    expect(readWatchCompilerFailure(first.tail, 'rors in 10819 ms\r\n').failed).toBe(true)
  })

  it('does not turn ordinary error text or a successful build into a failure', () => {
    const output = [
      'No errors found',
      '{"error":null}',
      'expected authentication error for invalid input',
      'webpack 5.89.0 compiled successfully in 200 ms',
      'webpack 5.89.0 compiled with 0 errors in 200 ms',
    ].join('\n') + '\n'
    expect(readWatchCompilerFailure('', output).failed).toBe(false)
  })

  it('recognizes an ANSI-colored completed result', () => {
    expect(readWatchCompilerFailure('', '\u001b[31mwebpack 5.89.0 compiled with 1 error in 100 ms\u001b[0m\n').failed).toBe(true)
  })
})
