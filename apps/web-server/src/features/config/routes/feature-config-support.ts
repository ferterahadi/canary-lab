import os from 'os'
import path from 'path'

export { PLAYWRIGHT_CONFIG_NAMES } from '../../../shared/playwright-config'
export { FEATURE_CONFIG_NAMES, findExistingConfig, type ResolvedConfigPath } from '../logic/config-file'
export { listEnvFolders, syncEnvsInConfig, readEnvsetsConfig, writeEnvsetsConfig, type EnvsetsConfigJson } from '../logic/envset-config'

export const SLOT_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/

/** A slot is one file name inside `envsets/<env>/`, so it must be a single path
 *  segment that names a file. The character class bars a separator; `.` and
 *  `..` are barred on top of it because they name a *directory* — without that
 *  second rule `path.join(envsetsDir, env, slot)` resolves to `envsets/<env>`
 *  or to `envsetsDir` itself, and the write lands on a directory (EISDIR).
 *  Together the two rules are what make the joined path provably a file inside
 *  `envsetsDir`, so callers that build a path this way need no `isWithin`
 *  re-check. Routes taking a raw `:slot` param still do — see `envset-routes`. */
export function isValidSlotName(name: string): boolean {
  return SLOT_NAME_PATTERN.test(name) && name !== '.' && name !== '..'
}

export { buildAppRoots } from '../logic/envset-runtime'

export function shortenHome(p: string): string {
  const home = os.homedir()
  if (home && (p === home || p.startsWith(home + path.sep))) {
    return '~' + p.slice(home.length)
  }
  return p
}
