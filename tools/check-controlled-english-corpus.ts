import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, relative, resolve } from 'node:path'
import { sourceFileEnglish, UnsupportedSyntaxKindError } from '../apps/web-server/src/shared/controlled-english/ast-to-ir'
import {
  CONTROLLED_ENGLISH_TYPESCRIPT_VERSION,
  parseSource,
} from '../apps/web-server/src/shared/controlled-english/compiler-context'
import { renderEnglish } from '../apps/web-server/src/shared/controlled-english/english-renderer'

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])
const SKIPPED_DIRECTORIES = new Set(['.git', 'coverage', 'dist', 'node_modules'])

interface CorpusFailure {
  file: string
  kind: 'unsupported' | 'crash' | 'nondeterministic'
  message: string
}

function displayPath(file: string): string {
  const fromRepository = relative(process.cwd(), file)
  return fromRepository.startsWith('..') ? file : fromRepository
}

function sourceFilesUnder(root: string): string[] {
  if (!statSync(root).isDirectory()) return SOURCE_EXTENSIONS.has(extname(root)) ? [root] : []
  const files: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue
    const path = resolve(root, entry.name)
    if (entry.isDirectory()) files.push(...sourceFilesUnder(path))
    else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) files.push(path)
  }
  return files
}

function translate(file: string, source: string): string {
  const { sourceFile } = parseSource(file, source)
  return renderEnglish(sourceFileEnglish(sourceFile))
}

const requestedRoots = process.argv.slice(2)
const roots = (requestedRoots.length === 0 ? ['apps', 'templates'] : requestedRoots).map((root) => resolve(root))
const failures: CorpusFailure[] = []
const discoveredFiles = new Set<string>()
for (const root of roots) {
  try {
    for (const file of sourceFilesUnder(root)) discoveredFiles.add(file)
  } catch (error) {
    failures.push({
      file: displayPath(root),
      kind: 'crash',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}
const files = [...discoveredFiles].sort()
let englishLines = 0

for (const file of files) {
  try {
    const source = readFileSync(file, 'utf8')
    const first = translate(file, source)
    const second = translate(file, source)
    if (first !== second) {
      failures.push({
        file: displayPath(file),
        kind: 'nondeterministic',
        message: 'Two fresh parses produced different English.',
      })
      continue
    }
    englishLines += first.split('\n').length
  } catch (error) {
    failures.push({
      file: displayPath(file),
      kind: error instanceof UnsupportedSyntaxKindError ? 'unsupported' : 'crash',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

const count = (kind: CorpusFailure['kind']): number => failures.filter((failure) => failure.kind === kind).length
console.log(JSON.stringify({
  typescriptVersion: CONTROLLED_ENGLISH_TYPESCRIPT_VERSION,
  roots: roots.map(displayPath),
  files: files.length,
  englishLines,
  unsupportedConstructs: count('unsupported'),
  crashes: count('crash'),
  nondeterministicRenders: count('nondeterministic'),
  failures,
}, null, 2))

if (failures.length > 0) process.exitCode = 1
