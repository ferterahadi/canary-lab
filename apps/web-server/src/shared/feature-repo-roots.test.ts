import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { trackTempDirs } from '../../../../tools/test-helpers/temp-dir'
import { initGitRepo } from '../../../../tools/test-helpers/git-repo'
import { featureRepoRoots } from './feature-repo-roots'

const temp = trackTempDirs('cl-feature-roots-')

describe('feature repository roots', () => {
  it('deduplicates repository roots across suites and skips unresolvable repositories', async () => {
    const root = temp()
    const first = initGitRepo(path.join(root, 'first'), { commit: 'empty' })
    const second = initGitRepo(path.join(root, 'second'), { commit: 'empty' })
    const subdir = path.join(first, 'nested')
    fs.mkdirSync(subdir)
    const features = path.join(root, 'features')
    const configs = [
      { name: 'alpha', repos: [{ localPath: subdir }, { localPath: path.join(root, 'missing') }] },
      { name: 'beta', repos: [{ localPath: first }, { localPath: second }] },
      { name: 'empty' },
    ]
    for (const config of configs) {
      const dir = path.join(features, config.name)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'feature.config.cjs'), `exports.config = ${JSON.stringify(config)}`)
    }
    expect(await featureRepoRoots(features)).toEqual([first, second])
  })

  it('returns no roots for a missing features directory', async () => {
    expect(await featureRepoRoots(path.join(temp(), 'missing'))).toEqual([])
  })
})
