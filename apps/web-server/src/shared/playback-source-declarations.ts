import fs from 'fs'
import ts from 'typescript'
import { scanSpecFiles, readSpecSource } from '../../../../shared/spec-files'
import type { PlaybackSourceDeclaration } from '../../../../shared/playback-identity'
import { parseSource } from './controlled-english/compiler-context'
import { readDisplayTestTitle } from './test-title'
import { isTestCall, testFunctionBody } from './test-declaration'

/** Shared declaration walk; run-detail reads never analyze assertions or imports. */
export function playbackSourceNodes(src: ts.SourceFile): Array<{ node: ts.CallExpression; title: string; body: ts.ConciseBody }> {
  const out: Array<{ node: ts.CallExpression; title: string; body: ts.ConciseBody }> = []
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && isTestCall(node)) {
      const title = readDisplayTestTitle(node, src)
      const body = testFunctionBody(node)
      if (title && body) out.push({ node, title, body })
      return
    }
    node.forEachChild(visit)
  }
  visit(src)
  return out
}

export function readPlaybackSourceDeclarations(dir: string | undefined): PlaybackSourceDeclaration[] {
  if (!dir || !fs.existsSync(dir)) return []
  const out: PlaybackSourceDeclaration[] = []
  try {
    for (const file of scanSpecFiles(dir)) {
      try {
        const src = parseSource(file, readSpecSource(file)).sourceFile
        out.push(...playbackSourceNodes(src).map(({ title }) => ({ file, title })))
      } catch { /* Unreadable source cannot establish identity; retain the recorded evidence. */ }
    }
  } catch { /* A removed suite leaves playback readable without source hints. */ }
  return out
}
