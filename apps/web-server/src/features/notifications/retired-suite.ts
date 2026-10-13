import { isPathUnder } from '../../shared/path-containment'
import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'

const git = promisify(execFile)

/** A committed deletion is evidence of retirement; a missing working-tree
 * config while HEAD still tracks it may be an accidental removal. */
export async function isCommittedSuiteRetirement(featuresDir: string, feature: string): Promise<boolean> {
  if (!/^[\w.-]+$/.test(feature) || feature === '.' || feature === '..') return false
  try {
    const realFeaturesDir = fs.existsSync(featuresDir) ? fs.realpathSync(featuresDir)
      : path.join(fs.realpathSync(path.dirname(featuresDir)), path.basename(featuresDir))
    const config = path.join(realFeaturesDir, feature, 'feature.config.cjs')
    if (fs.existsSync(config)) return false
    const root = (await git('git', ['rev-parse', '--show-toplevel'], {
      cwd: fs.existsSync(realFeaturesDir) ? realFeaturesDir : path.dirname(realFeaturesDir),
      encoding: 'utf8', timeout: 1500,
    })).stdout.trim()
    const relative = path.relative(root, config).split(path.sep).join('/')
    if (!isPathUnder(config, root, false)) return false
    const inHead = (await git('git', ['ls-tree', '--name-only', 'HEAD', '--', relative], {
      cwd: root, encoding: 'utf8', timeout: 1500,
    })).stdout.trim()
    if (inHead) return false
    const deletion = (await git('git', ['log', '-1', '--format=%H', '--diff-filter=D', 'HEAD', '--', relative], {
      cwd: root, encoding: 'utf8', timeout: 1500,
    })).stdout.trim()
    return !!deletion
  } catch {
    // Without repository evidence, absence is not proof of retirement.
    return false
  }
}
