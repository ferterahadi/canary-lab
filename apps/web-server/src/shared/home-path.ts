import os from 'node:os'
import path from 'node:path'

/** Expand only this server's home. Validation and relative-path bases belong
 * to callers; named-user shell syntax is deliberately not interpreted. */
export function expandHomePath(value: string, options: { homeDir?: string; backslash?: boolean } = {}): string {
  if (value === '~') return options.homeDir ?? os.homedir()
  if (value.startsWith('~/') || (options.backslash && value.startsWith('~\\'))) {
    return path.join(options.homeDir ?? os.homedir(), value.slice(2))
  }
  return value
}
