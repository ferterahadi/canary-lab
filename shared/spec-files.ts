import fs from 'node:fs'
import path from 'node:path'

/** Version 1 describes historical run hashes; never reinterpret that evidence. */
export type SpecInventoryVersion = 1 | 2
export const SPEC_INVENTORY_VERSION: SpecInventoryVersion = 2

const SPEC_FILE = /\.(?:spec|test)\.(?:[cm]?[jt]s|[jt]sx)$/
export const SPEC_SCAN_EXCLUDED = new Set(['node_modules', '.git', 'dist', 'logs', 'test-results', 'playwright-report'])

export function isSpecFile(file: string): boolean { return SPEC_FILE.test(file) }

export interface SpecScanOptions {
  version?: SpecInventoryVersion
  excludedDirectories?: ReadonlySet<string>
}

/** One traversal for suite inventory and tools with an explicitly selected root.
 * Descendant links are omitted, like the run snapshot copier. The selected root
 * may itself be linked; paths retain its spelling for caller identity checks. */
export function scanSpecFiles(root: string, options: SpecScanOptions = {}): string[] {
  const version = options.version ?? SPEC_INVENTORY_VERSION
  const excluded = options.excludedDirectories ?? SPEC_SCAN_EXCLUDED
  const files: string[] = []
  const visit = (dir: string): void => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) }
    catch (error) {
      if (dir === path.resolve(root) && (error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (version === 2 && !excluded.has(entry.name)) visit(file)
      } else if (entry.isFile() && (version === 1 ? entry.name.endsWith('.spec.ts') : isSpecFile(entry.name))) {
        files.push(file)
      }
    }
  }
  visit(path.resolve(root))
  return files.sort()
}

export function listSpecFiles(featureDir: string, version: SpecInventoryVersion = SPEC_INVENTORY_VERSION): string[] {
  return scanSpecFiles(path.join(featureDir, 'e2e'), { version })
}

/** Callers own read-error presentation; never convert unreadable evidence to empty text here. */
export function readSpecSource(file: string): string { return fs.readFileSync(file, 'utf8') }
