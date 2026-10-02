import fs from 'fs'
import path from 'path'

/** The number of entries in the captured envset — `env` when named, otherwise the
 *  first non-empty envset directory (the derived rail asks "was the environment
 *  ever captured", not "for this specific env"). */
export function capturedEnvsetCount(featureDir: string, env?: string): number | undefined {
  const envsetsDir = path.join(featureDir, 'envsets')
  const count = (dir: string): number => {
    try {
      return fs.readdirSync(dir).length
    } catch {
      return 0
    }
  }
  if (env !== undefined) {
    const captured = count(path.join(envsetsDir, env))
    return captured > 0 ? captured : undefined
  }
  let dirs: fs.Dirent[]
  try {
    dirs = fs.readdirSync(envsetsDir, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const captured = count(path.join(envsetsDir, d.name))
    if (captured > 0) return captured
  }
  return undefined
}

