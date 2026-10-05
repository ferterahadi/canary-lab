import fs from 'fs'
import path from 'path'

// Crash-safe file write: stage to a sibling `.tmp` then atomically rename over
// the target, so a reader never observes a half-written file. Callers own parent
// creation and temp naming; user configuration must not be invented on failure.
export function atomicReplace(file: string, body: string, options: {
  temporaryPath?: string
  mode?: number
  cleanupOnError?: boolean
} = {}): void {
  const tmp = options.temporaryPath ?? `${file}.tmp`
  const { mode } = options
  try {
    if (mode !== undefined && fs.existsSync(tmp)) fs.chmodSync(tmp, mode)
    fs.writeFileSync(tmp, body, { mode })
    fs.renameSync(tmp, file)
  } catch (error) {
    if (options.cleanupOnError) {
      try { fs.rmSync(tmp, { force: true }) } catch { /* cleanup must not replace the write failure */ }
    }
    throw error
  }
}

export function atomicWrite(file: string, body: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  atomicReplace(file, body, { mode })
}

// The JSON every store here writes: two-space indent plus a trailing newline,
// so a file diffs cleanly and matches what an editor would save.
export function atomicWriteJson(file: string, value: unknown, mode?: number): void {
  atomicWrite(file, JSON.stringify(value, null, 2) + '\n', mode)
}
