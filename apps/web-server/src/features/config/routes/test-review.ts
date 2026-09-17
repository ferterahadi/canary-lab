import fs from 'fs'
import path from 'path'
import type { FastifyInstance } from 'fastify'
import type { TestFileReview, ReviewSource } from '../../../../../../shared/test-review'
import { loadFeatures, listSpecFiles } from '../../../shared/feature-loader'
import { extractTestsFromSource, extractTestPredicatesFromSource, extractTestMetadataFromSource } from '../../../shared/ast-extractor'
import { translateReadableSource } from '../../../shared/readable-tests/translator'
import { diffSpecPredicates } from '../../../shared/verification-strength/differential'
import { getGitRoot, runGit } from '../../../shared/git-repo'
import { readManifest } from '../../runs/logic/runtime/manifest'
import { runDirFor } from '../../runs/logic/runtime/run-paths'
import { suiteReviewFiles } from '../../runs/logic/runtime/suite-review'
import { diffSourceText } from '../../runs/logic/dirty-specs/text-diff'
import { changedTestNames } from '../../runs/logic/dirty-specs/detect'
import type { FeaturesRouteDeps } from './features-route-deps'
import { compareTestDeclarations, meaningfulChangeLines, pairTestDeclarations } from '../logic/test-declaration-changes'

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

function runSnapshot(deps: FeaturesRouteDeps, feature: string, runId: string | undefined): { dir: string } | { status: number; error: string } {
  if (!deps.logsDir || !runId || !/^[\w.-]+$/.test(runId) || runId === '.' || runId === '..') return { status: 400, error: 'Invalid run' }
  const manifest = readManifest(path.join(runDirFor(deps.logsDir, runId), 'manifest.json'))
  if (!manifest || manifest.feature !== feature) return { status: 404, error: 'Run not found for this suite' }
  if (manifest.suiteSnapshot?.kind !== 'taken' || !fs.existsSync(manifest.suiteSnapshot.dir)) return { status: 409, error: 'This run’s test snapshot is unavailable. Choose committed changes or open the file in your editor.' }
  return { dir: manifest.suiteSnapshot.dir }
}

export async function testReviewRoutes(app: FastifyInstance, deps: FeaturesRouteDeps): Promise<void> {
  app.get<{ Params: { name: string }; Querystring: { runId?: string } }>('/api/features/:name/test-source-comparison', async (req, reply) => {
    const feature = loadFeatures(deps.featuresDir).find((item) => item.name === req.params.name)
    if (!feature) return reply.code(404).send({ error: 'Suite not found' })
    const snapshot = runSnapshot(deps, feature.name, req.query.runId)
    if ('error' in snapshot) return reply.code(snapshot.status).send({ error: snapshot.error })
    const relativeFiles = (root: string) => listSpecFiles(root).map((file) => path.relative(root, file))
    const files = [...new Set([...relativeFiles(feature.featureDir), ...relativeFiles(snapshot.dir)])].sort()
    try {
      const comparison = compareTestDeclarations(files.map((file) => ({ file,
        before: readSource(confinedFile(snapshot.dir, file)),
        after: readSource(confinedFile(feature.featureDir, file)),
      })))
      const supporting = suiteReviewFiles(snapshot.dir, feature.featureDir).files.filter(({ file }) => !files.includes(file))
      return { ...comparison, files: [...comparison.files, ...supporting.map(({ file }) => file)].sort(),
        differences: [...comparison.differences, ...supporting.map(({ file }) => ({ file, affectedTests: [] }))] }
    } catch (error) {
      if (error instanceof Error && error.message === 'Test file is outside the suite') return reply.code(400).send({ error: error.message })
      throw error
    }
  })
  app.get<{ Params: { name: string }; Querystring: { file?: string; runId?: string; summary?: string } }>('/api/features/:name/test-review', async (req, reply) => {
    const feature = loadFeatures(deps.featuresDir).find((item) => item.name === req.params.name)
    if (!feature) return reply.code(404).send({ error: 'Suite not found' })
    const file = req.query.file
    const supportingFile = !!file && !/\.(spec|test)\.[cm]?[jt]sx?$/.test(file)
    if (!file || path.isAbsolute(file) || file.split(/[\\/]/).includes('..') || (supportingFile && !req.query.runId)) {
      return reply.code(400).send({ error: 'A suite-relative test file is required' })
    }
    let currentPath: string
    try { currentPath = confinedFile(feature.featureDir, file) } catch {
      return reply.code(400).send({ error: 'Test file is outside the suite' })
    }
    let afterSource: string
    let beforeSource: string
    let baseline: TestFileReview['baseline'] = 'head'
    if (req.query.runId) {
      const snapshot = runSnapshot(deps, feature.name, req.query.runId)
      if ('error' in snapshot) return reply.code(snapshot.status).send({ error: snapshot.error })
      if (supportingFile) {
        const inventory = suiteReviewFiles(snapshot.dir, feature.featureDir)
        const old = inventory.before.get(file)
        const current = inventory.after.get(file)
        if (!old && !current) return reply.code(400).send({ error: 'File is not part of the reviewed suite' })
        if ([old, current].some((bytes) => bytes && (bytes.includes(0) || !Buffer.from(bytes.toString('utf8')).equals(bytes)))) {
          return reply.code(409).send({ error: 'Binary suite changes require a file viewer' })
        }
        const before = old?.toString('utf8') ?? ''
        const after = current?.toString('utf8') ?? ''
        if (req.query.summary === 'true') return { changed: before !== after, affectedTests: [], verdict: 'unclassifiable' }
        const readableSource = (source: string): ReviewSource => {
          if (!/\.[cm]?[jt]sx?$/.test(file)) return { source, tests: [] }
          const parsed = extractTestsFromSource(file, source, feature.semanticRules)
          return { source, tests: [], ...(!parsed.parseError
            ? { story: translateReadableSource(file, source, feature.semanticRules) }
            : { parseError: parsed.parseError }) }
        }
        return { file, currentPath, baseline: 'run-start', supportingFile: true,
          before: readableSource(before), after: readableSource(after),
          patch: await diffSourceText(before, after, Math.max(before.split('\n').length, after.split('\n').length)),
          assessment: { verdict: 'unclassifiable', tests: [] },
        } satisfies TestFileReview
      }
      afterSource = readSource(currentPath)
      beforeSource = readSource(confinedFile(snapshot.dir, file))
      baseline = 'run-start'
    } else {
      afterSource = readSource(currentPath)
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
    if (req.query.summary === 'true') {
      // The summary carries the affected test names, not just the boolean: the
      // Tests column marks the individual tests whose source moved since the
      // run, and re-deriving that client-side would mean shipping both
      // versions of the file to do an AST diff in the browser.
      const changed = beforeSource !== afterSource
      if (!changed) return { changed }
      return {
        changed,
        affectedTests: changedTestNames(file, beforeSource, afterSource),
        verdict: diffSpecPredicates(
          extractTestPredicatesFromSource(file, beforeSource),
          extractTestPredicatesFromSource(file, afterSource),
        ).verdict,
      }
    }
    const extract = (source: string): ReviewSource => {
      const result = extractTestsFromSource(file, source, feature.semanticRules)
      // `endLine` is optional on ExtractedTest only because the tests route
      // emits helper-defined entries with no AST match; every test that comes
      // out of `extractTestsFromSource` — the only producer here — carries one.
      // A `?? test.line` fallback would be an arm nothing could reach.
      return { source, ...(!result.parseError ? { story: translateReadableSource(file, source, feature.semanticRules) } : {}), tests: result.tests.map((test) => ({ name: test.name, line: test.line, endLine: test.endLine!, readable: test.readable })), ...(result.parseError ? { parseError: result.parseError } : {}) }
    }
    const beforePredicates = extractTestPredicatesFromSource(file, beforeSource)
    const afterPredicates = extractTestPredicatesFromSource(file, afterSource)
    const pairs = pairTestDeclarations(extractTestMetadataFromSource(file, beforeSource).tests, extractTestMetadataFromSource(file, afterSource).tests)
    // The review's advisory text must follow the same rename pairing as its
    // test navigation. Retained checks are not deletions just because a title moved.
    const pairedBefore = { ...beforePredicates, tests: beforePredicates.tests.map((test) => {
      const pair = pairs.find((item) => item.before?.line === test.line && item.before.name === test.name)
      return pair?.after ? { ...test, name: pair.after.name } : test
    }) }
    const { alignment, ...meaningfulChanges } = await meaningfulChangeLines(pairs)
    const result: TestFileReview = {
      file, currentPath, baseline,
      before: extract(beforeSource), after: extract(afterSource),
      patch: await diffSourceText(beforeSource, afterSource, Math.max(beforeSource.split('\n').length, afterSource.split('\n').length)),
      assessment: diffSpecPredicates(pairedBefore, afterPredicates),
      meaningfulChanges, comparisonAlignment: alignment,
    }
    return result
  })
}
