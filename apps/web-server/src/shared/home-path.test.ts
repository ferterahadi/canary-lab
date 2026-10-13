import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, expect, it, vi } from 'vitest'
import { trackTempDirs } from '../../../../tools/test-helpers/temp-dir'
import { expandHomePath } from './home-path'
import { resolvePath } from './launcher-startup'
import { resolveRepoPath } from './repo-identity'
import { buildServiceSpecs } from '../features/runs/logic/runtime/service-specs'
import { normalizePersonalWikiPath } from '../features/runs/logic/runtime/launcher/project-config'
import { registerWorkspaceFsRoutes } from '../features/config/routes/workspace-fs-routes'

const tmp = trackTempDirs('home-path-')
afterEach(() => vi.restoreAllMocks())

it('shares expansion across repository resolution, service construction, and filesystem reads', async () => {
  const home = tmp()
  fs.mkdirSync(path.join(home, 'service space'))
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  const cases = [
    ['~', home], ['~/service space', path.join(home, 'service space')],
    ['~/missing', path.join(home, 'missing')], [home, home],
    ['relative', 'relative'], ['~alice/app', '~alice/app'], ['~\\service', '~\\service'], ['', ''],
  ]
  const app = Fastify()
  await registerWorkspaceFsRoutes(app, { featuresDir: home })
  try {
    for (const [input, expected] of cases) {
      expect(expandHomePath(input, { homeDir: home })).toBe(expected)
      expect(resolveRepoPath(input)).toBe(expected)
      expect(resolvePath(input)).toBe(expected)
      const specs = buildServiceSpecs({ name: 'test', description: '', envs: [], featureDir: home,
        repos: [{ name: 'service', localPath: input, startCommands: ['node server.js'] }] }, home)
      expect(specs[0].cwd).toBe(expected)
      const response = await app.inject(`/api/workspace/path-exists?path=${encodeURIComponent(input)}`)
      if (path.isAbsolute(expected)) {
        expect(response.statusCode).toBe(200)
        expect(response.json()).toEqual({ exists: fs.existsSync(expected) })
      } else expect(response.statusCode).toBe(400)
    }
  } finally { await app.close() }
})

it('keeps the personal-wiki backslash adapter explicit and validation outside expansion', () => {
  const home = tmp()
  const wiki = path.join(home, 'wiki')
  fs.mkdirSync(wiki)
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  expect(expandHomePath('~\\wiki')).toBe('~\\wiki')
  expect(expandHomePath('~\\wiki', { backslash: true })).toBe(wiki)
  expect(expandHomePath('~\\wiki', { homeDir: home, backslash: true })).toBe(wiki)
  expect(expandHomePath('~', { homeDir: home })).toBe(home)
  expect(normalizePersonalWikiPath('  ~\\wiki  ')).toBe(wiki)
  expect(normalizePersonalWikiPath('~/missing')).toBeNull()
  expect(expandHomePath(' ~')).toBe(' ~')
})
