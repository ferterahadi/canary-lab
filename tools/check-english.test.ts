import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { auditEnglishWorkspace, main, resolveEnglishWorkspace } from './check-english'

const temporary: string[] = []
const initialExitCode = process.exitCode

afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  process.exitCode = initialExitCode
})

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'english-audit-'))
  temporary.push(root)
  fs.mkdirSync(path.join(root, 'features', 'example', 'e2e'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { 'canary-lab': '*' } }))
  return fs.realpathSync(root)
}

function registry(...paths: string[]) {
  return { version: 1 as const, workspaces: paths.map((root) => ({ name: path.basename(root), path: root, createdAt: '', updatedAt: '' })) }
}

describe('English audit command', () => {
  it('uses an explicit workspace before environment or registry defaults', () => {
    const first = workspace(); const second = workspace()
    expect(resolveEnglishWorkspace({ workspace: first, env: { CANARY_LAB_PROJECT_ROOT: second }, registry: registry(second) })).toBe(first)
    expect(resolveEnglishWorkspace({ cwd: process.cwd(), env: { CANARY_LAB_PROJECT_ROOT: second }, registry: registry(first) })).toBe(second)
  })

  it('discovers the current workspace or a unique registered workspace', () => {
    const root = workspace()
    expect(resolveEnglishWorkspace({ cwd: path.join(root, 'features'), env: {}, registry: registry() })).toBe(root)
    expect(resolveEnglishWorkspace({ cwd: os.tmpdir(), env: {}, registry: registry(root, path.join(root, 'deleted')) })).toBe(root)
  })

  it('refuses absent, invalid and ambiguous workspaces without substituting repository fixtures', () => {
    const first = workspace(); const second = workspace()
    expect(() => resolveEnglishWorkspace({ cwd: os.tmpdir(), env: {}, registry: registry() })).toThrow('No Canary Lab workspace found')
    expect(() => resolveEnglishWorkspace({ cwd: os.tmpdir(), env: {}, registry: registry(first, second) })).toThrow('Multiple Canary Lab workspaces found')
    expect(() => resolveEnglishWorkspace({ workspace: path.join(first, 'missing'), env: {}, registry: registry(first) })).toThrow('Not a Canary Lab workspace')
  })

  it('reads supporting code and specs without evaluating either or modifying workspace files', () => {
    const root = workspace()
    const support = path.join(root, 'features', 'example', 'feature.config.cjs')
    const spec = path.join(root, 'features', 'example', 'e2e', 'example.spec.ts')
    const source = "throw new Error('This configuration must never be executed by the audit')"
    fs.writeFileSync(support, source)
    fs.writeFileSync(spec, "test('value', () => { expect(1).toBe(1) })")
    fs.mkdirSync(path.join(root, 'features', 'example', 'node_modules'))
    fs.writeFileSync(path.join(root, 'features', 'example', 'node_modules', 'excluded.js'), 'invalid (')
    const result = auditEnglishWorkspace(root)
    expect(result.map((file) => file.file).sort()).toEqual(['features/example/e2e/example.spec.ts', 'features/example/feature.config.cjs'])
    expect(result.flatMap((file) => file.issues)).toEqual([])
    expect(fs.readFileSync(support, 'utf8')).toBe(source)
  })

  it('fails for empty inventories and unresolved linked source', () => {
    const root = workspace()
    expect(() => auditEnglishWorkspace(root)).toThrow('No JavaScript or TypeScript')
    fs.symlinkSync(path.join(root, 'package.json'), path.join(root, 'features', 'example', 'linked.ts'))
    expect(() => auditEnglishWorkspace(root)).toThrow('linked suite input')
  })

  it('prints machine-readable results and exits unsuccessfully when any file has a gap', async () => {
    const root = workspace()
    fs.writeFileSync(path.join(root, 'features', 'example', 'e2e', 'broken.spec.ts'), 'const = ;')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['--workspace', root, '--json'])
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({ workspace: root, files: 1, gaps: expect.any(Number) })
    expect(process.exitCode).toBe(1)
  })

  it('rejects unknown arguments and missing workspace values', async () => {
    await expect(main(['--unknown'])).rejects.toThrow('Unknown or incomplete argument')
    await expect(main(['--workspace'])).rejects.toThrow('Unknown or incomplete argument')
  })
})
