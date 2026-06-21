import fs from 'fs'
import path from 'path'

// Crash-safe file write: stage to a sibling `.tmp` then atomically rename over
// the target, so a reader never observes a half-written file. Parent dirs are
// created as needed. Consolidated from the per-store copies (portify, coverage,
// benchmark, manifest).
export function atomicWrite(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, body)
  fs.renameSync(tmp, file)
}
