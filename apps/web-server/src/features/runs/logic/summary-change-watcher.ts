import fs from 'fs'
import path from 'path'

export interface SummaryChangeWatcher {
  close(): void
}

export type WatchDirectory = (
  directory: string,
  options: { persistent: false },
  listener: (eventType: string, filename: string | Buffer | null) => void,
) => fs.FSWatcher

export interface SummaryChangeWatcherOptions {
  summaryPath: string
  onChange(): void
  onError?(error: Error): void
  /** Test seam for fs.watch; production callers leave this unset. */
  watchDirectory?: WatchDirectory
}

/**
 * Watch the run directory rather than the summary file itself. The Playwright
 * reporter writes `<summary>.tmp` and atomically renames it over the final
 * path, which replaces the file inode and invalidates a file-level watcher.
 *
 * This is a latency hint, not a new source of truth: consumers still read the
 * complete JSON artifact after the notification, and the browser keeps its
 * periodic detail refresh as a fallback for coalesced or dropped fs events.
 */
export function startSummaryChangeWatcher(options: SummaryChangeWatcherOptions): SummaryChangeWatcher {
  const watchDirectory = options.watchDirectory ?? ((directory, watchOptions, listener) => (
    fs.watch(directory, watchOptions, listener)
  ))
  const summaryName = path.basename(options.summaryPath)
  let watcher: fs.FSWatcher | null = null
  let scheduled: ReturnType<typeof setImmediate> | null = null
  let closed = false

  const reportError = (error: unknown): void => {
    try {
      options.onError?.(error instanceof Error ? error : new Error(String(error)))
    } catch {
      // A logging failure cannot take down a running Playwright process.
    }
  }

  const flush = (): void => {
    scheduled = null
    try {
      options.onChange()
    } catch (error) {
      reportError(error)
    }
  }

  const schedule = (): void => {
    if (closed || scheduled) return
    // Atomic rename can produce more than one directory event. One read on the
    // next turn observes the final file and avoids duplicate full-detail pushes.
    scheduled = setImmediate(flush)
  }

  try {
    watcher = watchDirectory(
      path.dirname(options.summaryPath),
      { persistent: false },
      (_eventType, filename) => {
        if (filename != null && path.basename(String(filename)) !== summaryName) return
        schedule()
      },
    )
    watcher.on('error', reportError)
  } catch (error) {
    reportError(error)
  }

  return {
    close(): void {
      if (closed) return
      closed = true
      if (scheduled) {
        clearImmediate(scheduled)
        scheduled = null
      }
      try {
        watcher?.close()
      } catch (error) {
        reportError(error)
      }
      watcher = null
    },
  }
}
