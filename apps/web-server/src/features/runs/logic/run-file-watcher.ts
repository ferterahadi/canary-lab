import fs from 'fs'

export interface RunFileWatcher {
  close(): void
}

export type WatchDirectory = (
  directory: string,
  options: { persistent: false },
  listener: (eventType: string, filename: string | Buffer | null) => void,
) => fs.FSWatcher

export interface RunFileWatcherOptions {
  directory: string
  filenames: readonly string[]
  onChange(): void
  onError?(error: Error): void
  /** Test seam for fs.watch; production callers leave this unset. */
  watchDirectory?: WatchDirectory
}

/**
 * Watch the run directory rather than individual files. Artifact writers
 * can write a temporary file and atomically rename it over the final
 * path, which replaces the file inode and invalidates a file-level watcher.
 *
 * This is a latency hint, not a new source of truth: consumers still read the
 * persisted artifact after the notification, and the browser keeps its
 * periodic detail refresh as a fallback for coalesced or dropped fs events.
 */
export function startRunFileWatcher(options: RunFileWatcherOptions): RunFileWatcher {
  const watchDirectory = options.watchDirectory ?? ((directory, watchOptions, listener) => (
    fs.watch(directory, watchOptions, listener)
  ))
  const filenames = new Set(options.filenames)
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
      options.directory,
      { persistent: false },
      (_eventType, filename) => {
        if (filename != null && !filenames.has(String(filename))) return
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
