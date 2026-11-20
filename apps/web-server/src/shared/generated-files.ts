import fs from 'fs'
import path from 'path'
import { readFeatureConfig } from './config-ast'
import { FEATURE_CONFIG_NAMES } from './config-file'

// Fixed directories and a single filename wildcard keep a rotating series
// expressible without ever dropping a subtree, a spec, or executable code.
const outputPath = /^(?:[\w-][\w.-]*\/)+[\w*-][\w.*-]*\.(?:jsonl?|ndjson|log|txt)$/
const protectedDirectory = /(?:^|\/)(?:e2e|fixtures?|__fixtures__|envsets|node_modules)(?:\/|$)/

export class GeneratedFilesError extends Error {}

export function generatedFilePatterns(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every((p) => typeof p === 'string' && outputPath.test(p)
    && !protectedDirectory.test(p) && p.indexOf('*') === p.lastIndexOf('*'))) {
    throw new GeneratedFilesError('generatedFiles requires literal suite-relative output file paths with a fixed directory, at most one filename *, and a .json, .jsonl, .ndjson, .log or .txt extension outside test, fixture and envset directories.')
  }
  return [...new Set<string>(value)].sort()
}

function declaredPatterns(bytes: Buffer): string[] {
  if (!bytes.includes('generatedFiles')) return []
  let config
  try { config = readFeatureConfig(bytes.toString('utf8')).value } catch {
    // Legacy configs can be dynamic. If the literal cannot be located, every
    // file remains visible. The feature loader diagnoses a nonempty runtime
    // declaration that cannot be reproduced from the recorded source.
    return []
  }
  return generatedFilePatterns(config.generatedFiles)
}

/** Review reads historical config as data. Evaluating it would rerun workspace
 * code with the server's environment every time a review is opened. */
export function readGeneratedFiles(dir: string) {
  for (const name of FEATURE_CONFIG_NAMES) {
    const file = path.join(dir, name)
    const stat = fs.lstatSync(file, { throwIfNoEntry: false })
    if (!stat) continue
    if (!stat.isFile()) break
    const bytes = fs.readFileSync(file)
    return { name, bytes, patterns: declaredPatterns(bytes) }
  }
  return { name: undefined, bytes: undefined, patterns: [] as string[] }
}

export function sameGeneratedFiles(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((pattern, index) => pattern === b[index])
}

export function matchesGeneratedFile(file: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => path.posix.matchesGlob(file, pattern))
}
