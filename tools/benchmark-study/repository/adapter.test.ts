import fs from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { command, sha } from '../files'
import { prepareRepositoryStudy, subjectPackageName, verifyRepositoryFixture } from './adapter'
import { trackTempDirs } from '../../test-helpers/temp-dir'

const tempDir = trackTempDirs('repository-fixture-')

async function fixture(): Promise<string> {
  const root = tempDir()
  const files = [
    'prepare.sh', 'host/package.json', 'host/yarn.lock', 'host/fixture.env', 'package-stub/package.json',
    'oracle/playwright.config.ts', 'oracle/e2e/encoding.spec.ts', 'held-out/overlap.patch', 'held-out/independent.patch',
  ]
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), `synthetic ${file}\n`)
  }
  const source = path.join(root, 'archive-input')
  fs.mkdirSync(source)
  fs.writeFileSync(path.join(source, 'package.json'), '{}\n')
  const archive = await command('tar', ['-czf', path.join(root, 'source.tar.gz'), '-C', source, 'package.json'], { cwd: root })
  expect(archive.code).toBe(0)
  fs.rmSync(source, { recursive: true })
  const hashes = Object.fromEntries([...files, 'source.tar.gz'].sort().map((file) => [file, sha(fs.readFileSync(path.join(root, file)))]))
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ schemaVersion: 1, candidate: 'nextjs-mcp',
    sourceCommit: 'a'.repeat(40), sourceArchive: 'source.tar.gz', filesSha256: hashes }))
  return root
}

it('accepts a complete frozen fixture and rejects changed, missing, extra, or linked inputs', async () => {
  const root = await fixture()
  await expect(verifyRepositoryFixture(root)).resolves.toMatchObject({ candidate: 'nextjs-mcp' })
  fs.writeFileSync(path.join(root, 'held-out/overlap.patch'), 'changed')
  await expect(verifyRepositoryFixture(root)).rejects.toThrow('inventory or SHA-256')
  fs.writeFileSync(path.join(root, 'held-out/overlap.patch'), 'synthetic held-out/overlap.patch\n')
  fs.rmSync(path.join(root, 'oracle/e2e/encoding.spec.ts'))
  await expect(verifyRepositoryFixture(root)).rejects.toThrow('inventory or SHA-256')
  fs.writeFileSync(path.join(root, 'oracle/e2e/encoding.spec.ts'), 'synthetic oracle/e2e/encoding.spec.ts\n')
  fs.writeFileSync(path.join(root, 'unexpected.txt'), 'extra')
  await expect(verifyRepositoryFixture(root)).rejects.toThrow('inventory or SHA-256')
  fs.rmSync(path.join(root, 'unexpected.txt'))
  fs.symlinkSync(path.join(root, 'source.tar.gz'), path.join(root, 'archive-alias'))
  await expect(verifyRepositoryFixture(root)).rejects.toThrow('Fixture symlink')
})

it('rejects archive links and output placement inside a protected source', async () => {
  const root = await fixture()
  const source = path.join(root, 'archive-input')
  fs.mkdirSync(source)
  fs.symlinkSync('/private/tmp/outside', path.join(source, 'escaping-link'))
  const archive = await command('tar', ['-czf', path.join(root, 'source.tar.gz'), '-C', source, 'escaping-link'], { cwd: root })
  expect(archive.code).toBe(0)
  fs.rmSync(source, { recursive: true })
  const manifestPath = path.join(root, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.filesSha256['source.tar.gz'] = sha(fs.readFileSync(path.join(root, 'source.tar.gz')))
  fs.writeFileSync(manifestPath, JSON.stringify(manifest))
  await expect(verifyRepositoryFixture(root)).rejects.toThrow('link or special file')
  await expect(prepareRepositoryStudy({ fixture: root, sourceCheckout: root, output: path.join(root, 'attempt') })).rejects.toThrow('overlaps a protected source')
})

it('links the host to the subject by its own package name and rejects unsafe names', () => {
  const root = tempDir('repository-subject-')
  for (const name of ['@example-org/subject-lib', 'subject-lib']) {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name }))
    expect(subjectPackageName(root)).toBe(name)
  }
  for (const name of [undefined, '', "x';process.exit(1);'", '../escape', '@scope/a/b', 'Upper']) {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name }))
    expect(() => subjectPackageName(root), String(name)).toThrow('no valid package name')
  }
})
