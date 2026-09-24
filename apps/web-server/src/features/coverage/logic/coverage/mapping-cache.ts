import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import ts from 'typescript'
import { extractTestMappingContext } from '../../../../shared/ast-extractor'
import type { Requirement, VariantDimension } from '../../../../../../../shared/coverage/types'
import { fingerprintRequirement } from './fingerprints'
import type { AnnotateTestInput } from './annotate-engine'
import { docsDirFor, readDocsCollection } from './docs-collection'
import { PRD_SUMMARY_JSON } from './prd-summary-render'
import { CoverageInputReads } from './input-reads'

export interface MappingTestInput extends AnnotateTestInput {
  file: string
  bodySource: string
  assertions: string[]
  annotations?: { requirements?: string[]; pathTypes?: string[]; variants?: string[] }
}

export interface MappingInferenceCache {
  version: 2
  /** Test name -> input fingerprint -> the requirement meanings examined. A
   * negative answer is reusable too; absence means the pair was never read. */
  tests: Record<string, { fingerprint: string; requirements: Record<string, string> }>
}

export interface MappingInferenceSnapshot {
  tests: Record<string, string>
  requirements: Record<string, string>
  sourceRevision?: string
  readable?: boolean
}

function hash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function portableRelative(featureDir: string, file: string): string {
  return path.relative(featureDir, file).split(path.sep).join('/')
}

/** Read semantic dependency content rather than mtimes: an imported helper can
 * change while its test body stays identical. Compiler configuration is used to
 * resolve the import graph, but configuration bytes and absolute locations are
 * not part of the mapping identity. */
function sourceContext(featureDir: string, file: string, options: ts.CompilerOptions, reads: CoverageInputReads, host: ts.ModuleResolutionHost): string {
  const files = new Map<string, string>()
  const visit = (absolute: string, spec: boolean): void => {
    const key = portableRelative(featureDir, absolute)
    if (files.has(key)) return
    const source = reads.text(absolute)
    files.set(key, spec ? extractTestMappingContext(absolute, source) : source)
    for (const dependency of ts.preProcessFile(source, true, true).importedFiles) {
      const resolved = ts.resolveModuleName(dependency.fileName, absolute, options, host).resolvedModule
      if (resolved && !resolved.isExternalLibraryImport) visit(resolved.resolvedFileName, false)
      else if (!resolved && dependency.fileName.startsWith('.')) {
        const unresolved = path.resolve(path.dirname(absolute), dependency.fileName)
        files.set(portableRelative(featureDir, unresolved), 'unresolved')
      }
    }
  }
  visit(path.resolve(featureDir, file), true)
  return hash([...files].sort(([a], [b]) => a.localeCompare(b)))
}

export function mappingInferenceSnapshot(
  featureDir: string,
  tests: MappingTestInput[],
  requirements: Requirement[],
  variantDimension?: VariantDimension,
  reads = new CoverageInputReads(),
): MappingInferenceSnapshot {
  const requirementHashes = Object.fromEntries(requirements.filter((r) => !r.deprecated)
    .map((r) => [r.id, hash([fingerprintRequirement(r), variantDimension])]))
  try {
    const host = {
      ...ts.sys,
      fileExists: (file: string) => reads.isFile(file),
      directoryExists: (dir: string) => reads.isDirectory(dir),
      realpath: (file: string) => reads.realpath(file),
      // Track raw bytes while preserving TypeScript's BOM/encoding handling.
      readFile: (file: string) => { reads.optional(file); return ts.sys.readFile(file) },
    }
    const config = ts.findConfigFile(featureDir, host.fileExists)
    // Resolve inherited options without enumerating compilation inputs. A
    // fatal config read throws into the optional-cache fallback below, so a
    // successful parse always returns options.
    const options = config
      ? ts.getParsedCommandLineOfConfigFile(config, {}, {
          ...host,
          readDirectory: () => [],
          onUnRecoverableConfigFileDiagnostic: (diagnostic) => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')) },
        })!.options
      : {}
    const contexts = new Map<string, string>()
    const fingerprints: Record<string, string> = {}
    for (const test of tests) {
      let context = contexts.get(test.file)
      if (context === undefined) {
        context = sourceContext(featureDir, test.file, options, reads, host)
        contexts.set(test.file, context)
      }
      fingerprints[test.name] = hash({
        file: portableRelative(featureDir, path.resolve(featureDir, test.file)),
        body: test.bodySource,
        assertions: test.assertions,
        annotations: test.annotations,
        context,
      })
    }
    const summaryPath = path.join(docsDirFor(featureDir), PRD_SUMMARY_JSON)
    const sourceRevision = hash([readDocsCollection(featureDir).docsHash, fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, 'utf-8') : null])
    return { tests: fingerprints, requirements: requirementHashes, sourceRevision, readable: true }
  } catch {
    // Reuse is optional. If any source/config input cannot be read, re-examine
    // the suite without certifying those inputs in the cache.
    return { tests: {}, requirements: requirementHashes, readable: false }
  }
}

export function unexaminedMappingTests(
  tests: MappingTestInput[],
  snapshot: MappingInferenceSnapshot,
  cache: MappingInferenceCache | undefined,
): MappingTestInput[] {
  return tests.filter((test) => {
    const prior = cache?.version === 2 ? cache.tests?.[test.name] : undefined
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
    const old = prior?.version === 2 ? prior.tests?.[name] : undefined
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
  return { version: 2, tests }
}
