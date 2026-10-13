import fs from 'fs'

/** Historical paths may no longer exist; preserve their authored spelling. */
export function realpathOrSelf(input: string): string {
  try { return fs.realpathSync(input) } catch { return input }
}
