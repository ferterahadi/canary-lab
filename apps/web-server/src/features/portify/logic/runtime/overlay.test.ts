import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { runGit } from '../../../orchestration/logic/git-repo'
import {
  OVERLAY_VERSION,
  overlayDir,
  patchFileName,
  overlayExists,
  writeOverlay,
  readOverlay,
  removeOverlay,
  blobShaAt,
  captureTouchedFiles,
  checkStaleness,
} from './overlay'

const roots: string[] = []
afterEach(() => {
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }) } catch { /* ignore */ } }
  roots.length = 0
})

function tmpDir(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  roots.push(root)
  return root
}

async function tmpRepo(initialFile: { name: string; body: string }): Promise<string> {
  const root = tmpDir('portify-overlay-git-')
  fs.writeFileSync(path.join(root, initialFile.name), initialFile.body)
  await runGit(root, ['init', '-q'])
  await runGit(root, ['config', 'user.email', 't@t'])
  await runGit(root, ['config', 'user.name', 'test'])
  await runGit(root, ['add', '-A'])
  await runGit(root, ['commit', '-q', '-m', 'init', '--no-verify'])
  return root
}

function headSha(repoRoot: string): Promise<string> {
  return runGit(repoRoot, ['rev-parse', 'HEAD']).then((r) => r.stdout.trim())
}

describe('patchFileName', () => {
  it('slugifies a repo name into a .patch filename', () => {
    expect(patchFileName('api-server')).toBe('api-server.patch')
    expect(patchFileName('My Repo!!')).toBe('my-repo.patch')
    expect(patchFileName('!!!')).toBe('repo.patch')
  })
})

describe('overlay write/read round-trip', () => {
  it('persists meta + per-repo patch and reads them back', () => {
    const featureDir = tmpDir('portify-overlay-feat-')
    const patch = 'diff --git a/app.js b/app.js\n@@ -1 +1 @@\n-const PORT = 3007\n+const PORT = process.env.PORT\n'

    const meta = writeOverlay(featureDir, {
      featureName: 'my_feature',
      agent: 'claude',
      capturedAt: '2026-06-14T00:00:00.000Z',
      repos: [
        { name: 'api', baseSha: 'abc123', patch, touchedFiles: [{ path: 'app.js', sha: 'deadbeef' }] },
      ],
    })

    expect(meta.version).toBe(OVERLAY_VERSION)
    expect(meta.repos[0].patch).toBe('api.patch')
    expect(fs.existsSync(path.join(overlayDir(featureDir), 'api.patch'))).toBe(true)
    expect(fs.existsSync(path.join(overlayDir(featureDir), 'meta.json'))).toBe(true)

    const loaded = readOverlay(featureDir)
    expect(loaded).not.toBeNull()
    expect(loaded!.meta.featureName).toBe('my_feature')
    expect(loaded!.meta.agent).toBe('claude')
    expect(loaded!.patches['api']).toBe(patch)
  })

  it('overwrites a prior overlay and clears orphaned patch files', () => {
    const featureDir = tmpDir('portify-overlay-feat-')
    writeOverlay(featureDir, {
      featureName: 'f', agent: 'claude', capturedAt: 't1',
      repos: [{ name: 'gone', baseSha: 's', patch: 'x', touchedFiles: [] }],
    })
    expect(fs.existsSync(path.join(overlayDir(featureDir), 'gone.patch'))).toBe(true)

    writeOverlay(featureDir, {
      featureName: 'f', agent: 'claude', capturedAt: 't2',
      repos: [{ name: 'kept', baseSha: 's', patch: 'y', touchedFiles: [] }],
    })
    // The orphaned patch from the first write is gone; only the new one remains.
    expect(fs.existsSync(path.join(overlayDir(featureDir), 'gone.patch'))).toBe(false)
    expect(fs.existsSync(path.join(overlayDir(featureDir), 'kept.patch'))).toBe(true)
    expect(readOverlay(featureDir)!.meta.capturedAt).toBe('t2')
  })
})

describe('overlayExists / readOverlay edge cases', () => {
  it('treats a meta.json whose repos field is not an array as absent', () => {
    const featureDir = tmpDir('portify-overlay-feat-')
    const dir = path.join(featureDir, 'portify')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'meta.json'),
      JSON.stringify({ version: 1, featureName: 'f', agent: 'claude', capturedAt: 't', repos: 'not-an-array' }),
    )
    expect(overlayExists(featureDir)).toBe(false)
    expect(readOverlay(featureDir)).toBeNull()
  })

  it('reports false with no overlay and null on read', () => {
    const featureDir = tmpDir('portify-overlay-feat-')
    expect(overlayExists(featureDir)).toBe(false)
    expect(readOverlay(featureDir)).toBeNull()
  })

  it('reports false for an overlay with zero repos', () => {
    const featureDir = tmpDir('portify-overlay-feat-')
    writeOverlay(featureDir, { featureName: 'f', agent: 'claude', capturedAt: 't', repos: [] })
    expect(overlayExists(featureDir)).toBe(false)
    expect(readOverlay(featureDir)).toBeNull()
  })

  it('treats a missing patch file as a corrupt (absent) overlay', () => {
    const featureDir = tmpDir('portify-overlay-feat-')
    writeOverlay(featureDir, {
      featureName: 'f', agent: 'claude', capturedAt: 't',
      repos: [{ name: 'api', baseSha: 's', patch: 'x', touchedFiles: [] }],
    })
    fs.rmSync(path.join(overlayDir(featureDir), 'api.patch'))
    expect(readOverlay(featureDir)).toBeNull()
  })

  it('removeOverlay deletes the directory', () => {
    const featureDir = tmpDir('portify-overlay-feat-')
    writeOverlay(featureDir, {
      featureName: 'f', agent: 'claude', capturedAt: 't',
      repos: [{ name: 'api', baseSha: 's', patch: 'x', touchedFiles: [] }],
    })
    expect(fs.existsSync(overlayDir(featureDir))).toBe(true)
    removeOverlay(featureDir)
    expect(fs.existsSync(overlayDir(featureDir))).toBe(false)
  })
})

describe('blobShaAt / captureTouchedFiles', () => {
  it('returns the blob hash for a tracked file and null for an unknown path', async () => {
    const repo = await tmpRepo({ name: 'app.js', body: 'const PORT = 3007\n' })
    const sha = await blobShaAt(repo, 'HEAD', 'app.js')
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
    expect(await blobShaAt(repo, 'HEAD', 'nope.js')).toBeNull()
  })

  it('records only files that existed at base (skips added files)', async () => {
    const repo = await tmpRepo({ name: 'app.js', body: 'const PORT = 3007\n' })
    const base = await headSha(repo)
    const touched = await captureTouchedFiles(repo, base, ['app.js', 'new-file.js'])
    expect(touched.map((t) => t.path)).toEqual(['app.js'])
    expect(touched[0].sha).toMatch(/^[0-9a-f]{40}$/)
  })
})

describe('checkStaleness', () => {
  it('reports not stale when touched files are unchanged since capture', async () => {
    const repo = await tmpRepo({ name: 'app.js', body: 'const PORT = 3007\n' })
    const base = await headSha(repo)
    const featureDir = tmpDir('portify-overlay-feat-')
    const touchedFiles = await captureTouchedFiles(repo, base, ['app.js'])
    writeOverlay(featureDir, {
      featureName: 'f', agent: 'claude', capturedAt: 't',
      repos: [{ name: 'api', baseSha: base, patch: 'x', touchedFiles }],
    })

    const res = await checkStaleness(featureDir, { api: repo })
    expect(res.stale).toBe(false)
    expect(res.changedFiles).toEqual([])
  })

  it('flags a touched file whose contents drifted since capture', async () => {
    const repo = await tmpRepo({ name: 'app.js', body: 'const PORT = 3007\n' })
    const base = await headSha(repo)
    const featureDir = tmpDir('portify-overlay-feat-')
    const touchedFiles = await captureTouchedFiles(repo, base, ['app.js'])
    writeOverlay(featureDir, {
      featureName: 'f', agent: 'claude', capturedAt: 't',
      repos: [{ name: 'api', baseSha: base, patch: 'x', touchedFiles }],
    })

    // The user edits + commits the same file after capture.
    fs.appendFileSync(path.join(repo, 'app.js'), '// later edit\n')
    await runGit(repo, ['commit', '-aqm', 'later', '--no-verify'])

    const res = await checkStaleness(featureDir, { api: repo })
    expect(res.stale).toBe(true)
    expect(res.changedFiles).toEqual([{ repo: 'api', path: 'app.js' }])
  })

  it('flags a touched file that was deleted since capture', async () => {
    const repo = await tmpRepo({ name: 'app.js', body: 'const PORT = 3007\n' })
    const base = await headSha(repo)
    const featureDir = tmpDir('portify-overlay-feat-')
    const touchedFiles = await captureTouchedFiles(repo, base, ['app.js'])
    writeOverlay(featureDir, {
      featureName: 'f', agent: 'claude', capturedAt: 't',
      repos: [{ name: 'api', baseSha: base, patch: 'x', touchedFiles }],
    })

    fs.rmSync(path.join(repo, 'app.js'))
    await runGit(repo, ['commit', '-aqm', 'rm', '--no-verify'])

    const res = await checkStaleness(featureDir, { api: repo })
    expect(res.stale).toBe(true)
    expect(res.changedFiles).toEqual([{ repo: 'api', path: 'app.js' }])
  })

  it('skips repos whose git root could not be resolved', async () => {
    const repo = await tmpRepo({ name: 'app.js', body: 'const PORT = 3007\n' })
    const base = await headSha(repo)
    const featureDir = tmpDir('portify-overlay-feat-')
    const touchedFiles = await captureTouchedFiles(repo, base, ['app.js'])
    writeOverlay(featureDir, {
      featureName: 'f', agent: 'claude', capturedAt: 't',
      repos: [{ name: 'api', baseSha: base, patch: 'x', touchedFiles }],
    })

    // No mapping for 'api' → skipped, not stale.
    const res = await checkStaleness(featureDir, {})
    expect(res.stale).toBe(false)
  })

  it('returns not stale when there is no overlay', async () => {
    const featureDir = tmpDir('portify-overlay-feat-')
    const res = await checkStaleness(featureDir, {})
    expect(res.stale).toBe(false)
  })
})
