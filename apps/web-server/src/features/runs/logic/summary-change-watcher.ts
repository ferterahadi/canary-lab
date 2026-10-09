import path from 'path'
import { startRunFileWatcher, type WatchDirectory, type RunFileWatcher } from './run-file-watcher'

export interface SummaryChangeWatcherOptions {
  summaryPath: string
  onChange(): void
  onError?(error: Error): void
  watchDirectory?: WatchDirectory
}

export function startSummaryChangeWatcher(options: SummaryChangeWatcherOptions): RunFileWatcher {
  return startRunFileWatcher({
    directory: path.dirname(options.summaryPath),
    filenames: [path.basename(options.summaryPath)],
    onChange: options.onChange,
    onError: options.onError,
    watchDirectory: options.watchDirectory,
  })
}
