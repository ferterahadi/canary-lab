import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import ts from 'typescript'
import { extractTestMappingContext } from '../../../../shared/ast-extractor'
import type { Requirement, VariantDimension } from '../../../../../../../shared/coverage/types'
import { fingerprintRequirement } from './fingerprints'
import type { AnnotateTestInput } from './annotate-engine'

export interface MappingTestInput extends AnnotateTestInput {
  file: string
  bodySource: string
  assertions: string[]
  annotations?: { requirements?: string[]; pathTypes?: string[]; variants?: string[] }
}

export interface MappingInferenceCache {
  version: 1
  /** Test name -> input fingerprint -> the requirement meanings examined. A
   * negative answer is reusable too; absence means the pair was never read. */
  tests: Record<string, { fingerprint: string; requirements: Record<string, string> }>
}

export interface MappingInferenceSnapshot {
  tests: Record<string, string>
  requirements: Record<string, string>
}

function hash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** Read dependency content rather than mtimes: an imported helper can change
 * while its test body stays identical. Package/config inputs also invalidate
 * reuse, and unresolved local imports stay in the hash until they resolve. */
function sourceContext(featureDir: string, file: string, options: ts.CompilerOptions): string {
  const files = new Map<string, string>()
  const visit = (absolute: string, spec: boolean): void => {
    if (files.has(absolute)) return
    const source = fs.readFileSync(absolute, 'utf-8')
    files.set(absolute, spec ? extractTestMappingContext(absolute, source) : source)
    for (const dependency of ts.preProcessFile(source, true, true).importedFiles) {
      const resolved = ts.resolveModuleName(dependency.fileName, absolute, options, ts.sys).resolvedModule
      if (resolved && !resolved.isExternalLibraryImport) visit(resolved.resolvedFileName, false)
      else if (!resolved && dependency.fileName.startsWith('.')) files.set(path.resolve(path.dirname(absolute), dependency.fileName), 'unresolved')
    }
  }
  visit(path.resolve(featureDir, file), true)
  return hash([...files].sort(([a], [b]) => a.localeCompare(b)))
}

/** Data files and dynamically loaded helpers inside e2e have no static import
 * edge. Include that support tree, excluding top-level specs (hashed per test)
 * and dependency/output directories. An unreadable input disables reuse. */
function supportContext(featureDir: string): string {
  const files: Array<[string, string]> = []
  const visited = new Set<string>()
  const walk = (dir: string): void => {
    const real = fs.realpathSync(dir)
    if (visited.has(real)) return
    visited.add(real)
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'test-results', 'playwright-report'].includes(entry.name)) continue
      const target = path.join(dir, entry.name)
      if (fs.statSync(target).isDirectory()) walk(target)
      else if (!(dir === path.join(featureDir, 'e2e') && entry.name.endsWith('.spec.ts'))) {
        files.push([path.relative(featureDir, target), fs.readFileSync(target).toString('base64')])
      }
    }
  }
  const dir = path.join(featureDir, 'e2e')
  if (fs.existsSync(dir)) walk(dir)
  return hash(files.sort(([a], [b]) => a.localeCompare(b)))
}

export function mappingInferenceSnapshot(
  featureDir: string,
  tests: MappingTestInput[],
  requirements: Requirement[],
  variantDimension?: VariantDimension,
): MappingInferenceSnapshot {
  const requirementHashes = Object.fromEntries(requirements.filter((r) => !r.deprecated)
    .map((r) => [r.id, hash([fingerprintRequirement(r), variantDimension])]))
  try {
    const config = ts.findConfigFile(featureDir, ts.sys.fileExists)
    // Resolve inherited options without enumerating compilation inputs. A
    // fatal config read throws into the optional-cache fallback below, so a
    // successful parse always returns options.
    const options = config
      ? ts.getParsedCommandLineOfConfigFile(config, {}, {
          ...ts.sys,
          readDirectory: () => [],
          onUnRecoverableConfigFileDiagnostic: (diagnostic) => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')) },
        })!.options
      : {}
    const environment: Array<[string, string]> = []
    for (let dir = featureDir; ; dir = path.dirname(dir)) {
      for (const name of ['feature.config.cjs', 'playwright.config.ts', 'playwright.config.js', 'tsconfig.json', 'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock']) {
        const target = path.join(dir, name)
        if (fs.existsSync(target)) environment.push([target, fs.readFileSync(target, 'utf-8')])
      }
      if (path.dirname(dir) === dir) break
    }
    const support = supportContext(featureDir)
    const contexts = new Map<string, string>()
    const fingerprints: Record<string, string> = {}
    for (const test of tests) {
      let context = contexts.get(test.file)
      if (context === undefined) {
        context = sourceContext(featureDir, test.file, options)
        contexts.set(test.file, context)
      }
      fingerprints[test.name] = hash({ file: test.file, body: test.bodySource, assertions: test.assertions, annotations: test.annotations, context, support, environment, options })
    }
    return { tests: fingerprints, requirements: requirementHashes }
  } catch {
    // Reuse is optional. If any source/config input cannot be read, re-examine
    // the suite without certifying those inputs in the cache.
    return { tests: {}, requirements: requirementHashes }
  }
}

export function unexaminedMappingTests(
  tests: MappingTestInput[],
  snapshot: MappingInferenceSnapshot,
  cache: MappingInferenceCache | undefined,
): MappingTestInput[] {
  return tests.filter((test) => {
    const prior = cache?.version === 1 ? cache.tests?.[test.name] : undefined
    return !snapshot.tests[test.name] || prior?.fingerprint !== snapshot.tests[test.name]
      || Object.entries(snapshot.requirements).some(([id, fingerprint]) => prior.requirements?.[id] !== fingerprint)
  })
}

/** Keep only tests still present with unchanged inputs; record only the roster
 * actually examined, so narrowing one pass cannot certify the rest of a suite. */
export function rememberMappingInference(
  snapshot: MappingInferenceSnapshot,
  roster: readonly string[],
  prior: MappingInferenceCache | undefined,
): MappingInferenceCache {
  const tests: MappingInferenceCache['tests'] = {}
  const examined = new Set(roster)
  for (const [name, fingerprint] of Object.entries(snapshot.tests)) {
    const old = prior?.version === 1 ? prior.tests?.[name] : undefined
    const unchanged = old?.fingerprint === fingerprint
    if (examined.has(name) || unchanged) {
      tests[name] = {
        fingerprint,
        requirements: {
          ...(unchanged ? old.requirements : {}),
          ...(examined.has(name) ? snapshot.requirements : {}),
        },
      }
    }
  }
  return { version: 1, tests }
}
