import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, relative, resolve } from 'node:path'
import ts from 'typescript'
import { sourceFileEnglish, UnsupportedSyntaxKindError } from '../apps/web-server/src/shared/controlled-english/ast-to-ir'
import {
  CONTROLLED_ENGLISH_TYPESCRIPT_VERSION,
  parseSource,
} from '../apps/web-server/src/shared/controlled-english/compiler-context'
import { renderEnglish } from '../apps/web-server/src/shared/controlled-english/english-renderer'
import { compileSemanticSource } from '../apps/web-server/src/shared/controlled-english/semantic-context'
import {
  composeCatchHeader,
  composeFinallyHeader,
  composeIfHeader,
  composeIfPath,
  composeLoopHeader,
  composeStatementEnglish,
  composeSwitchHeader,
  composeSwitchPath,
  composeTryHeader,
} from '../apps/web-server/src/shared/controlled-english/structured-english'

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

function translate(file: string, source: string): { syntax: string; structured: string[] } {
  const { sourceFile } = parseSource(file, source)
  const semantic = compileSemanticSource(file, source)
  const structured: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node)) {
      structured.push(composeIfHeader(node, semantic).text)
      structured.push(composeIfPath('then', node.thenStatement, semantic).text)
      if (node.elseStatement) structured.push(composeIfPath('otherwise', node.elseStatement, semantic).text)
    } else if (ts.isSwitchStatement(node)) {
      structured.push(composeSwitchHeader(node, semantic).text)
      structured.push(...node.caseBlock.clauses.map((clause) => composeSwitchPath(clause, semantic).text))
    } else if (ts.isTryStatement(node)) {
      structured.push(composeTryHeader(node, semantic).text)
      if (node.catchClause) structured.push(composeCatchHeader(node.catchClause, semantic).text)
      if (node.finallyBlock) structured.push(composeFinallyHeader(node.finallyBlock, semantic).text)
    } else if (
      ts.isForStatement(node)
      || ts.isForInStatement(node)
      || ts.isForOfStatement(node)
      || ts.isWhileStatement(node)
      || ts.isDoStatement(node)
    ) {
      structured.push(composeLoopHeader(node, semantic).text)
    } else if (ts.isStatement(node)) {
      const block = composeStatementEnglish(node, semantic)
      if (block) structured.push(block.text)
    }
    node.forEachChild(visit)
  }
  visit(semantic.sourceFile)
  return { syntax: renderEnglish(sourceFileEnglish(sourceFile)), structured }
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
let structuredBlocks = 0

for (const file of files) {
  try {
    const source = readFileSync(file, 'utf8')
    const first = translate(file, source)
    const second = translate(file, source)
    if (JSON.stringify(first) !== JSON.stringify(second)) {
      failures.push({
        file: displayPath(file),
        kind: 'nondeterministic',
        message: 'Two fresh parses produced different English.',
      })
      continue
    }
    englishLines += first.syntax.split('\n').length
    structuredBlocks += first.structured.length
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
  structuredBlocks,
  unsupportedConstructs: count('unsupported'),
  crashes: count('crash'),
  nondeterministicRenders: count('nondeterministic'),
  failures,
}, null, 2))

if (failures.length > 0) process.exitCode = 1
