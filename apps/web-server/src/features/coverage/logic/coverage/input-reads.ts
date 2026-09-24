import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

type Probe = { signature: string; read: () => string }
export type InputReadMemo = Map<string, string>
const signature = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const failedRead = (error: unknown) => `error:${String((error as NodeJS.ErrnoException)?.code ?? error)}`

/** Remember the inputs actually read, including missing resolution candidates.
 * Rechecking bytes and directory membership is cheaper than parsing tests and
 * rebuilding the ledger. No mtime shortcut: same-size/restored-mtime edits count. */
export class CoverageInputReads {
  private readonly probes = new Map<string, Probe>()
  private unstable = false

  private capture<T>(key: string, read: () => T, digest: (value: T) => string = signature): T {
    const probe = () => { try { return digest(read()) } catch (error) { return failedRead(error) } }
    const remember = (value: string) => {
      const before = this.probes.get(key)
      if (before && before.signature !== value) this.unstable = true
      if (!before) this.probes.set(key, { signature: value, read: probe })
    }
    try { const value = read(); remember(digest(value)); return value }
    catch (error) { remember(failedRead(error)); throw error }
  }

  read(file: string): Buffer {
    return this.capture(`file:${file}`, () => fs.readFileSync(file), (bytes) => crypto.createHash('sha256').update(bytes).digest('hex'))
  }

  text(file: string): string { return this.read(file).toString('utf8') }

  optional(file: string): void {
    try { this.read(file) } catch { /* Absence/errors are recorded too, so restoration invalidates the snapshot. */ }
  }

  exists(file: string): boolean { return this.capture(`exists:${file}`, () => fs.existsSync(file)) }
  isFile(file: string): boolean { return this.capture(`isFile:${file}`, () => { try { return fs.statSync(file).isFile() } catch { return false /* resolution candidate unavailable */ } }) }
  isDirectory(dir: string): boolean { return this.capture(`isDirectory:${dir}`, () => { try { return fs.statSync(dir).isDirectory() } catch { return false /* resolution candidate unavailable */ } }) }
  realpath(file: string): string { return this.capture(`realpath:${file}`, () => fs.realpathSync(file)) }

  directory(dir: string): fs.Dirent[] {
    return this.capture(`directory:${dir}`, () => fs.readdirSync(dir, { withFileTypes: true }),
      (entries) => signature(entries.map((entry) => [entry.name, entry.isDirectory(), entry.isSymbolicLink()]).sort()))
  }

  tree(dir: string, recursive: boolean, visited = new Set<string>()): void {
    if (!this.exists(dir)) return
    const real = this.realpath(dir)
    if (visited.has(real)) return
    visited.add(real)
    for (const entry of this.directory(dir)) {
      if (['node_modules', '.git', 'test-results', 'playwright-report'].includes(entry.name)) continue
      const target = path.join(dir, entry.name)
      if (this.isDirectory(target)) {
        if (recursive) this.tree(target, true, visited)
      } else this.optional(target)
    }
  }

  unchanged(memo: InputReadMemo = new Map()): boolean {
    if (this.unstable) return false
    for (const [key, probe] of this.probes) {
      let current = memo.get(key)
      if (current === undefined) { current = probe.read(); memo.set(key, current) }
      if (current !== probe.signature) return false
    }
    return true
  }
}
