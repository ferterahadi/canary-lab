import fs from 'fs'
import path from 'path'

// Crash-safe file write: stage to a sibling `.tmp` then atomically rename over
// the target, so a reader never observes a half-written file. Parent dirs are
// created as needed. Consolidated from the per-store copies (portify, coverage,
// benchmark, manifest).
export function atomicWrite(file: string, body: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  if (mode !== undefined && fs.existsSync(tmp)) fs.chmodSync(tmp, mode)
  fs.writeFileSync(tmp, body, { mode })
  fs.renameSync(tmp, file)
}

// The JSON every store here writes: two-space indent plus a trailing newline,
// so a file diffs cleanly and matches what an editor would save.
export function atomicWriteJson(file: string, value: unknown, mode?: number): void {
  atomicWrite(file, JSON.stringify(value, null, 2) + '\n', mode)
}
