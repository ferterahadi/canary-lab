import ts from 'typescript'

// The controlled-English language is versioned against the compiler that
// defines its source grammar. The inventory and vocabulary are written for
// this exact TypeScript release; `syntax-kinds.test.ts` fails the build when
// the installed compiler no longer matches, forcing a deliberate re-audit
// instead of a silent drift onto a different grammar.
export const CONTROLLED_ENGLISH_TYPESCRIPT_VERSION = '5.9.3'

export function installedTypescriptVersion(): string {
  return ts.version
}

export interface ParsedSource {
  sourceFile: ts.SourceFile
  scriptKind: ts.ScriptKind
}

export function scriptKindForFile(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.cjs')) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

/** Parse source for translation. The translator is a parser-level tool by
 *  design: no binder, no type checker, so every emitted fact is a Level-1
 *  syntax fact (see docs/controlled-english/semantic-boundaries.md).
 *  `setParentNodes: true` because translation reads upward (e.g. whether an
 *  expression sits in a condition slot). */
export function parseSource(file: string, source: string): ParsedSource {
  const scriptKind = scriptKindForFile(file)
  return {
    sourceFile: ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind),
    scriptKind,
  }
}
