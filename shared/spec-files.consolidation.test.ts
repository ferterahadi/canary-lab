import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

/** A directory walk paired with a local filename matcher recreates inventory
 * policy. Generic snapshot/doc walkers and calls to the shared scanner are legal. */
function independentSpecScan(text: string): boolean {
  const source = ts.createSourceFile('source.ts', text, ts.ScriptTarget.Latest, true)
  let walks = false
  let matchesSpecs = false
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text
        : ts.isIdentifier(node.expression) ? node.expression.text : ''
      if (/^(readdir|glob)(Sync)?$/.test(name)) walks = true
    }
    if (ts.isStringLiteralLike(node) || node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      const value = node.getText(source)
      if (value.includes('.spec.') || value.includes('.test.') || /spec\\\.|test\\\.|spec\|test|test\|spec/.test(value)) matchesSpecs = true
    }
    node.forEachChild(visit)
  }
  visit(source)
  return walks && matchesSpecs
}

it('rejects a duplicated walker and matcher, while allowing shared adapters and unrelated walks', () => {
  expect(independentSpecScan("fs.readdirSync(dir).filter(file => file.endsWith('.spec.ts'))")).toBe(true)
  expect(independentSpecScan("for (const file of globSync(root)) if (/\\.(spec|test)\\.tsx?$/.test(file)) out.push(file)")).toBe(true)
  expect(independentSpecScan("import { listSpecFiles } from './spec-files'; listSpecFiles(root)")).toBe(false)
  expect(independentSpecScan("fs.readdirSync(dir).filter(file => file.endsWith('.md'))")).toBe(false)
  expect(independentSpecScan("// readdirSync and .spec.ts are explained here\nlistSpecFiles(root)")).toBe(false)
})

it('keeps production spec enumeration in one shared module', () => {
  const root = path.resolve(__dirname, '..')
  const duplicates: string[] = []
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '__fixtures__', 'dist'].includes(entry.name)) continue
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (/\.(ts|tsx|mjs)$/.test(file) && !/\.test\.[tj]sx?$/.test(file)) {
        const relative = path.relative(root, file)
        if (relative !== 'shared/spec-files.ts' && independentSpecScan(fs.readFileSync(file, 'utf8'))) duplicates.push(relative)
      }
    }
  }
  for (const dir of ['apps', 'shared']) visit(path.join(root, dir))
  expect(duplicates).toEqual([])
})
