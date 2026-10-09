/** Byte count in binary units with one decimal above a kibibyte: `512 B`,
 *  `1.5 KB`, `2.0 MB`. The text the heal prompt and the upgrade report print;
 *  the web UI's `formatBytes` is a different (unit-trimming) rule on purpose. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** A test duration: whole milliseconds under a second, else seconds with one
 *  decimal (`250ms`, `2.4s`). Playwright reports integer durations, so the
 *  rounding only matters for a fractional value from elsewhere. */
export function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}
