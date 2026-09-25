import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'

/** A committed deletion is evidence of retirement; a missing working-tree
 * config while HEAD still tracks it may be an accidental removal. */
export function isCommittedSuiteRetirement(featuresDir: string, feature: string): boolean {
  if (!/^[\w.-]+$/.test(feature) || feature === '.' || feature === '..') return false
  try {
    const realFeaturesDir = fs.existsSync(featuresDir) ? fs.realpathSync(featuresDir)
      : path.join(fs.realpathSync(path.dirname(featuresDir)), path.basename(featuresDir))
    const config = path.join(realFeaturesDir, feature, 'feature.config.cjs')
    if (fs.existsSync(config)) return false
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: fs.existsSync(realFeaturesDir) ? realFeaturesDir : path.dirname(realFeaturesDir),
      encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const relative = path.relative(root, config).split(path.sep).join('/')
    if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) return false
    const inHead = execFileSync('git', ['ls-tree', '--name-only', 'HEAD', '--', relative], {
      cwd: root, encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (inHead) return false
    const deletion = execFileSync('git', ['log', '-1', '--format=%H', '--diff-filter=D', 'HEAD', '--', relative], {
      cwd: root, encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return !!deletion
  } catch {
    // Without repository evidence, absence is not proof of retirement.
    return false
  }
}
