import { EventEmitter } from 'events'
import fs from 'fs'
import { describe, expect, it, vi } from 'vitest'
import {
  startSummaryChangeWatcher,
  type WatchDirectory,
} from './summary-change-watcher'

interface FakeWatch {
  watchDirectory: WatchDirectory
  emitFile(filename: string | Buffer | null): void
  emitError(error: Error): void
  close: ReturnType<typeof vi.fn>
}

function fakeWatch(options: { closeError?: Error } = {}): FakeWatch {
  const emitter = new EventEmitter()
  const close = vi.fn(() => {
    if (options.closeError) throw options.closeError
  })
  let listener: Parameters<WatchDirectory>[2] | undefined
  const watchDirectory: WatchDirectory = (_directory, _watchOptions, nextListener) => {
    listener = nextListener
    return Object.assign(emitter, { close }) as unknown as fs.FSWatcher
  }
  return {
    watchDirectory,
    emitFile(filename) {
      if (!listener) throw new Error('watch listener was not attached')
      listener('rename', filename)
    },
    emitError: (error) => emitter.emit('error', error),
    close,
  }
}

async function nextTurn(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

describe('startSummaryChangeWatcher', () => {
  it('uses the production fs.watch adapter when no test seam is supplied', async () => {
    const watch = fakeWatch()
    const onChange = vi.fn()
    const fsWatch = vi.spyOn(fs, 'watch').mockImplementation(((...args: unknown[]) => {
      const [directory, options, listener] = args as Parameters<WatchDirectory>
      return watch.watchDirectory(directory, options, listener)
    }) as typeof fs.watch)
    const handle = startSummaryChangeWatcher({
      summaryPath: '/logs/runs/r-1/e2e-summary.json',
      onChange,
    })

    try {
      watch.emitFile('e2e-summary.json')
      await nextTurn()
      expect(onChange).toHaveBeenCalled()
    } finally {
      handle.close()
      fsWatch.mockRestore()
    }
  })

  it('coalesces final-summary events and ignores other run artifacts', async () => {
    const watch = fakeWatch()
    const onChange = vi.fn()
    const handle = startSummaryChangeWatcher({
      summaryPath: '/logs/runs/r-1/e2e-summary.json',
      onChange,
      watchDirectory: watch.watchDirectory,
    })

    watch.emitFile('playwright.log')
    await nextTurn()
    expect(onChange).not.toHaveBeenCalled()

    watch.emitFile('e2e-summary.json')
    watch.emitFile(Buffer.from('e2e-summary.json'))
    await nextTurn()
    expect(onChange).toHaveBeenCalledTimes(1)

    // Some platforms omit the filename. Treat that as a possible summary
    // change; the consumer's read decides whether anything actually changed.
    watch.emitFile(null)
    await nextTurn()
    expect(onChange).toHaveBeenCalledTimes(2)

    handle.close()
    watch.emitFile('e2e-summary.json')
    await nextTurn()
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(watch.close).toHaveBeenCalledTimes(1)
    handle.close()
    expect(watch.close).toHaveBeenCalledTimes(1)
  })

  it('reports setup, watcher, callback, and close failures without throwing', async () => {
    const setupError = new Error('cannot watch')
    const onSetupError = vi.fn(() => { throw new Error('logger failed') })
    expect(() => startSummaryChangeWatcher({
      summaryPath: '/missing/e2e-summary.json',
      onChange: vi.fn(),
      onError: onSetupError,
      watchDirectory: () => { throw setupError },
    })).not.toThrow()
    expect(onSetupError).toHaveBeenCalledWith(setupError)

    const onNonError = vi.fn()
    startSummaryChangeWatcher({
      summaryPath: '/missing/e2e-summary.json',
      onChange: vi.fn(),
      onError: onNonError,
      watchDirectory: () => { throw 'string failure' },
    })
    expect(onNonError).toHaveBeenCalledWith(new Error('string failure'))
    expect(() => startSummaryChangeWatcher({
      summaryPath: '/missing/e2e-summary.json',
      onChange: vi.fn(),
      watchDirectory: () => { throw setupError },
    })).not.toThrow()

    const closeError = new Error('cannot close')
    const watch = fakeWatch({ closeError })
    const callbackError = new Error('subscriber failed')
    const onError = vi.fn()
    const handle = startSummaryChangeWatcher({
      summaryPath: '/logs/runs/r-1/e2e-summary.json',
      onChange: () => { throw callbackError },
      onError,
      watchDirectory: watch.watchDirectory,
    })

    const watcherError = new Error('watcher failed')
    watch.emitError(watcherError)
    watch.emitFile('e2e-summary.json')
    await nextTurn()
    handle.close()

    expect(onError.mock.calls.map(([error]) => error)).toEqual([
      watcherError,
      callbackError,
      closeError,
    ])
  })

  it('cancels a scheduled notification when closed before the next turn', async () => {
    const watch = fakeWatch()
    const onChange = vi.fn()
    const handle = startSummaryChangeWatcher({
      summaryPath: '/logs/runs/r-1/e2e-summary.json',
      onChange,
      watchDirectory: watch.watchDirectory,
    })

    watch.emitFile('e2e-summary.json')
    handle.close()
    await nextTurn()

    expect(onChange).not.toHaveBeenCalled()
  })
})
