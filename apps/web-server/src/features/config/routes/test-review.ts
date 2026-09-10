import fs from 'fs'
import path from 'path'
import type { FastifyInstance } from 'fastify'
import type { TestFileReview, ReviewSource } from '../../../../../../shared/test-review'
import { loadFeatures } from '../../../shared/feature-loader'
import { extractTestsFromSource, extractTestPredicatesFromSource } from '../../../shared/ast-extractor'
import { diffSpecPredicates } from '../../../shared/verification-strength/differential'
import { getGitRoot, runGit } from '../../../shared/git-repo'
import { readManifest } from '../../runs/logic/runtime/manifest'
import { runDirFor } from '../../runs/logic/runtime/run-paths'
import { diffSourceText } from '../../runs/logic/dirty-specs/text-diff'
import type { FeaturesRouteDeps } from './features-route-deps'

/** Resolve existing parents too: a deleted file behind a symlink must not
 * bypass the same boundary as a readable file. */
function confinedFile(root: string, relative: string): string {
  const realRoot = fs.realpathSync(root)
  const target = path.resolve(realRoot, relative)
  let parent = target
  while (!fs.existsSync(parent)) parent = path.dirname(parent)
  const realTarget = path.resolve(fs.realpathSync(parent), path.relative(parent, target))
  if (!realTarget.startsWith(`${realRoot}${path.sep}`)) throw new Error('Test file is outside the suite')
  return realTarget
}

function readSource(file: string): string {
  try { return fs.readFileSync(file, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

export async function testReviewRoutes(app: FastifyInstance, deps: FeaturesRouteDeps): Promise<void> {
  app.get<{ Params: { name: string }; Querystring: { file?: string; runId?: string; summary?: string } }>('/api/features/:name/test-review', async (req, reply) => {
    const feature = loadFeatures(deps.featuresDir).find((item) => item.name === req.params.name)
    if (!feature) return reply.code(404).send({ error: 'Suite not found' })
    const file = req.query.file
    if (!file || path.isAbsolute(file) || file.split(/[\\/]/).includes('..') || !/\.(spec|test)\.[cm]?[jt]sx?$/.test(file)) {
      return reply.code(400).send({ error: 'A suite-relative test file is required' })
    }
    let currentPath: string
    try { currentPath = confinedFile(feature.featureDir, file) } catch {
      return reply.code(400).send({ error: 'Test file is outside the suite' })
    }
    const afterSource = readSource(currentPath)
    let beforeSource: string
    let baseline: TestFileReview['baseline'] = 'head'
    if (req.query.runId) {
      const runId = req.query.runId
      if (!deps.logsDir || !/^[\w.-]+$/.test(runId) || runId === '.' || runId === '..') return reply.code(400).send({ error: 'Invalid run' })
      const manifest = readManifest(path.join(runDirFor(deps.logsDir, runId), 'manifest.json'))
      if (!manifest || manifest.feature !== feature.name) return reply.code(404).send({ error: 'Run not found for this suite' })
      if (manifest.suiteSnapshot?.kind !== 'taken' || !fs.existsSync(manifest.suiteSnapshot.dir)) return reply.code(409).send({ error: 'This run’s test snapshot is unavailable. Choose committed changes or open the file in your editor.' })
      beforeSource = readSource(confinedFile(manifest.suiteSnapshot.dir, file))
      baseline = 'run-start'
    } else {
      const root = await getGitRoot(feature.featureDir)
      if (!root) return reply.code(409).send({ error: 'No committed baseline is available for this suite' })
      const head = await runGit(root, ['rev-parse', '--verify', 'HEAD'])
      if (head.code !== 0) return reply.code(409).send({ error: 'No committed baseline is available for this suite' })
      const relative = path.relative(root, currentPath)
      const listing = await runGit(root, ['ls-tree', '--name-only', 'HEAD', '--', relative])
      if (listing.code !== 0) throw new Error('Could not read the committed test tree')
      if (listing.stdout.trim()) {
        const source = await runGit(root, ['show', `HEAD:${relative}`])
        if (source.code !== 0) throw new Error('Could not read the committed test file')
        beforeSource = source.stdout
      } else beforeSource = ''
    }
    if (req.query.summary === 'true') return { changed: beforeSource !== afterSource }
    const extract = (source: string): ReviewSource => {
      const result = extractTestsFromSource(file, source, feature.semanticRules)
      return { source, tests: result.tests.map((test) => ({ name: test.name, line: test.line, endLine: test.endLine ?? test.line, readable: test.readable })), ...(result.parseError ? { parseError: result.parseError } : {}) }
    }
    const result: TestFileReview = {
      file, currentPath, baseline,
      before: extract(beforeSource), after: extract(afterSource),
      patch: await diffSourceText(beforeSource, afterSource, Math.max(beforeSource.split('\n').length, afterSource.split('\n').length)),
      assessment: diffSpecPredicates(extractTestPredicatesFromSource(file, beforeSource), extractTestPredicatesFromSource(file, afterSource)),
    }
    return result
  })
}
