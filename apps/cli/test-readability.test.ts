import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkTestFiles, main } from './test-readability'

let root: string
let exitCode: typeof process.exitCode
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-readability-'))
  exitCode = process.exitCode
})
afterEach(() => {
  process.exitCode = exitCode
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

function write(relative: string, content = 'const first = 1, second = first + 1\n'): string {
  const file = path.join(root, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return file
}

describe('test-readability command', () => {
  it('audits without writes, fixes only the selected source, and is idempotent', async () => {
    const file = write('e2e/messages.spec.ts')
    const original = fs.readFileSync(file, 'utf8')
    const helper = write('e2e/helper.ts')
    write('e2e/notes.md', 'Notes')
    const recorded = write('logs/runs/run-1/messages.spec.ts')
    const fixture = write('__fixtures__/intentional.test.ts')
    const coverageTest = write('src/features/coverage/coverage.test.ts', 'const alreadyReadable = true\n')
    const reports = await checkTestFiles([root, file])
    expect(reports).toHaveLength(2)
    expect(reports[0]).toMatchObject({ file, changed: false, needsChanges: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(original)

    expect(await checkTestFiles([root], { fix: true })).toEqual([
      { file, changed: true, needsChanges: false, issues: [] },
      { file: coverageTest, changed: false, needsChanges: false, issues: [] },
    ])
    expect(fs.readFileSync(file, 'utf8')).toBe('const first = 1\nconst second = first + 1\n')
    expect(fs.readFileSync(helper, 'utf8')).toBe(original)
    expect(fs.readFileSync(recorded, 'utf8')).toBe(original)
    expect(fs.readFileSync(fixture, 'utf8')).toBe(original)
    expect(await checkTestFiles([file], { fix: true })).toEqual([
      { file, changed: false, needsChanges: false, issues: [] },
    ])
    expect(await checkTestFiles([helper], { fix: true })).toEqual([
      { file: helper, changed: true, needsChanges: false, issues: [] },
    ])
  })

  it('preserves other layout when only syntax rules are requested', async () => {
    const file = write('layout.test.ts', 'const first=1, second=2;\n')
    await checkTestFiles([file], { fix: true, rulesOnly: true })
    expect(fs.readFileSync(file, 'utf8')).toBe('const first=1;\nconst second=2;\n')
  })

  it('leaves invalid source intact and returns unresolved findings', async () => {
    const file = write('invalid.spec.ts', 'const broken = ;')
    expect(await checkTestFiles([file], { fix: true })).toEqual([
      expect.objectContaining({ changed: false, issues: [expect.objectContaining({ rule: 'syntax' })] }),
    ])
    expect(fs.readFileSync(file, 'utf8')).toBe('const broken = ;')
  })

  it('refuses artifacts, unsupported files, empty selections, and symbolic links', async () => {
    const artifact = write('logs/old.spec.ts')
    const file = write('e2e/real.spec.ts')
    const link = path.join(root, 'e2e/link.spec.ts')
    fs.symlinkSync(file, link)
    fs.mkdirSync(path.join(root, 'empty'))
    const notes = write('notes.md', 'notes')
    await expect(checkTestFiles([artifact], { fix: true })).rejects.toThrow('Refusing generated artifacts')
    await expect(checkTestFiles([link], { fix: true })).rejects.toThrow('Refusing a symbolic link')
    await expect(checkTestFiles([notes])).rejects.toThrow('Expected a JavaScript/TypeScript')
    await expect(checkTestFiles([path.join(root, 'empty')])).rejects.toThrow('No test files found')
    expect(await checkTestFiles([path.join(root, 'e2e')])).toHaveLength(1)
    const alias = path.join(root, 'alias')
    fs.symlinkSync(path.join(root, 'logs'), alias)
    await expect(checkTestFiles([path.join(alias, 'old.spec.ts')], { fix: true })).rejects.toThrow('Refusing generated artifacts')
    expect(await checkTestFiles([root])).toHaveLength(1)
  })

  it('does not overwrite a file edited while formatting is pending', async () => {
    const file = write('edited.spec.ts')
    const pending = checkTestFiles([file], { fix: true })
    fs.writeFileSync(file, '// concurrent author edit\n')
    await expect(pending).rejects.toThrow('File changed during inspection')
    expect(fs.readFileSync(file, 'utf8')).toBe('// concurrent author edit\n')
  })

  it('reports machine-readable findings and uses a failing exit code until safe fixes are applied', async () => {
    const file = write('cli.spec.ts')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main([file, '--json'])
    expect(process.exitCode).toBe(1)
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ errors: 1, needsChanges: 1, changed: 0 })
    log.mockClear()
    await main([file, '--fix'])
    expect(process.exitCode).toBe(0)
    expect(log.mock.calls.flat().join('\n')).toContain(`Updated ${file}`)
  })

  it('prints actionable findings while review warnings alone keep a successful exit code', async () => {
    const file = write('review.spec.ts', 'const value = first ? 1 : second ? 2 : 3\n')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main([file, '--rules-only'])
    expect(process.exitCode).toBe(0)
    expect(log.mock.calls.flat().join('\n')).toContain('warning no-nested-ternary:')
    fs.writeFileSync(file, 'const value = (first(), second())\n')
    await main([file, '--fix'])
    expect(process.exitCode).toBe(1)
    expect(fs.readFileSync(file, 'utf8')).toContain('(first(), second())')
  })

  it('explains usage and rejects unknown options or missing paths', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['--help'])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage: canary-lab test-readability'))
    await expect(main(['--wat'])).rejects.toThrow('Unknown option: --wat')
    await expect(main([])).rejects.toThrow('Usage:')
  })
})
