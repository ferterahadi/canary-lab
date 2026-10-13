import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { trackTempDirs } from '../../../../../../tools/test-helpers/temp-dir'
import { buildFeatureConfigApp, type FeatureConfigAppOptions } from './__fixtures__/feature-config-app'

const tempDir = trackTempDirs('cl-fcfg-')

let tmpDir: string

let featuresDir: string

const makeApp = (opts: FeatureConfigAppOptions = {}) => buildFeatureConfigApp(featuresDir, opts)

beforeEach(() => {
  tmpDir = tempDir()
  featuresDir = path.join(tmpDir, 'features')
  fs.mkdirSync(featuresDir, { recursive: true })
})

describe('GET /api/workspace/git-remote — origin block with a non-url line first', () => {
  it('skips non-url lines before finding the url= line', async () => {
    const repoDir = path.join(tmpDir, 'reordered-remote')
    fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true })
    fs.writeFileSync(
      path.join(repoDir, '.git', 'config'),
      `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n\turl = git@github.com:org/reordered.git\n`,
    )
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'GET',
        url: `/api/workspace/git-remote?path=${encodeURIComponent(repoDir)}`,
      })
      expect(r.statusCode).toBe(200)
      expect(r.json()).toEqual({ cloneUrl: 'git@github.com:org/reordered.git' })
    } finally {
      await app.close()
    }
  })
})
