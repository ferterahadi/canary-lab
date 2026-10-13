import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The repository root. `fileURLToPath`, not `URL.pathname`, so a checkout
 *  under a path with spaces resolves to the real directory. */
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const TEST_FILE = /\.test\.tsx?$/

/**
 * Every file under `dir`, depth-first in `readdirSync` order, following
 * symlinks. Each checker passes only the filters it already applied, so the
 * list it sees is unchanged.
 *
 * @param {string} dir absolute directory to walk
 * @param {object} [options]
 * @param {RegExp} [options.ext] keep only files whose name matches
 * @param {string[]} [options.skip] entry names dropped before they are read
 * @param {boolean} [options.excludeTests] drop `*.test.ts(x)` files
 * @param {string} [options.relativeTo] return paths relative to this root, `/`-joined
 * @param {(absPath: string, name: string) => boolean} [options.onEntry]
 *   runs before `skip`; return false to drop the entry (and anything under it)
 * @returns {string[]}
 */
export function walk(dir, { ext, skip = [], excludeTests = false, relativeTo, onEntry } = {}) {
  const out = []
  const visit = (current) => {
    for (const name of readdirSync(current)) {
      const p = path.join(current, name)
      if (onEntry && !onEntry(p, name)) continue
      if (skip.includes(name)) continue
      if (statSync(p).isDirectory()) visit(p)
      else if ((!ext || ext.test(name)) && !(excludeTests && TEST_FILE.test(name))) out.push(p)
    }
  }
  visit(dir)
  return relativeTo === undefined ? out : out.map((p) => path.relative(relativeTo, p).split(path.sep).join('/'))
}
