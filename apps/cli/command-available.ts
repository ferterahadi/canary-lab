import { execFileSync } from 'child_process'

export function commandAvailable(command: string): boolean {
  const lookup = process.platform === 'win32' ? 'where' : 'which'
  try {
    execFileSync(lookup, [command], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
