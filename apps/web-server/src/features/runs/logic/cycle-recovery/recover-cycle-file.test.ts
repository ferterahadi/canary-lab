import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { cycleRun, HELPER, SERVER, SPEC, type CycleRun } from './__fixtures__/cycle-run'
import { cycleDiffs } from './cycle-sources'
import { resolveCycleTree, type CycleTree } from './cycle-tree'
import { recoverCycleFile, type RecoveredCycleFile } from './recover-cycle-file'
import { git } from '../../../../../../../tools/test-helpers/git-repo'
import { trackTempDirs } from '../../../../../../../tools/test-helpers/temp-dir'

const tempDir = trackTempDirs('cl-recover-')

const SPEC_PATH = 'e2e/cart.spec.ts'
const HELPER_PATH = 'helpers/util.ts'

function edit(dir: string, rel: string, from: string, to: string): void {
  const file = path.join(dir, rel)
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(from, to))
}

/** Recover the cycle's file whose diff path ends with `suffix`, resolving its
 * tree the way the route does. */
async function recover(run: CycleRun, iteration: number, suffix: string, tree?: CycleTree): Promise<RecoveredCycleFile> {
  const diffs = cycleDiffs(run.runDir)
  const file = diffs.get(iteration)!.files.find((item) => item.path.endsWith(suffix))!
  const manifest = run.manifest()
  return recoverCycleFile({
    file, iteration, diffs,
    tree: tree ?? await resolveCycleTree(file.repo, manifest, run.feature()),
    suiteDir: manifest.suiteSnapshot?.kind === 'taken' ? manifest.suiteSnapshot.dir : null,
  })
}

const specAt = (...edits: Array<[string, string]>) => edits.reduce((text, [from, to]) => text.replace(from, to), SPEC)

describe('recoverCycleFile from the run\'s suite copy', () => {
  it('replays a run-start copy forward through earlier cycles', async () => {
    const run = cycleRun(tempDir())
    run.takeSuite()
    await run.cycle(() => edit(run.featureDir, SPEC_PATH, "'/cart'", "'/basket'"))
    await run.cycle(() => edit(run.featureDir, SPEC_PATH, "'Total'", "'Sum'"))
    expect(await recover(run, 2, SPEC_PATH)).toEqual({
      recovery: { kind: 'reconstructed', verified: 'blob' },
      before: specAt(["'/cart'", "'/basket'"]),
      after: specAt(["'/cart'", "'/basket'"], ["'Total'", "'Sum'"]),
    })
  })

  it('undoes later cycles from a copy re-taken after them, as an adoption does', async () => {
    const run = cycleRun(tempDir())
    await run.cycle(() => edit(run.featureDir, SPEC_PATH, "'/cart'", "'/basket'"))
    await run.cycle(() => edit(run.featureDir, SPEC_PATH, "'Total'", "'Sum'"))
    run.takeSuite()
    expect(await recover(run, 1, SPEC_PATH)).toEqual({
      recovery: { kind: 'reconstructed', verified: 'blob' },
      before: SPEC, after: specAt(["'/cart'", "'/basket'"]),
    })
  })

  it('places a copy that lacks a file before the cycle that added it', async () => {
    const run = cycleRun(tempDir())
    run.takeSuite()
    await run.cycle(() => run.write(run.featureDir, 'e2e/new.spec.ts', 'one\ntwo\n'))
    await run.cycle(() => edit(run.featureDir, 'e2e/new.spec.ts', 'two', 'deux'))
    expect(await recover(run, 2, 'new.spec.ts')).toMatchObject({ recovery: { kind: 'reconstructed' }, before: 'one\ntwo\n', after: 'one\ndeux\n' })
  })

  it('follows a rename back to the cycle before it, and forward from it', async () => {
    const run = cycleRun(tempDir())
    // Enough lines that git still pairs the two paths after an edit.
    const money = ['export const one = 1', 'export const two = 2', 'export const three = 3', 'export const four = 4', ''].join('\n')
    run.write(run.featureDir, 'helpers/money.ts', money)
    git(run.workspace, 'commit', '-qm', 'money')
    run.takeSuite()
    await run.cycle(() => edit(run.featureDir, 'helpers/money.ts', 'one = 1', 'one = 1.0'))
    await run.cycle(() => {
      git(run.workspace, 'mv', 'features/demo/helpers/money.ts', 'features/demo/helpers/cash.ts')
      edit(run.featureDir, 'helpers/cash.ts', 'four = 4', 'four = 4.0')
    })
    expect(cycleDiffs(run.runDir).get(2)!.files[0]).toMatchObject({ change: 'renamed', previousPath: 'features/demo/helpers/money.ts' })
    const first = money.replace('one = 1', 'one = 1.0')
    expect(await recover(run, 2, 'cash.ts')).toMatchObject({ recovery: { kind: 'reconstructed' }, before: first, after: first.replace('four = 4', 'four = 4.0') })
    expect(await recover(run, 1, 'money.ts')).toMatchObject({ recovery: { kind: 'reconstructed' }, before: money })
  })

  it('skips cycles that did not touch the file, in both directions', async () => {
    const run = cycleRun(tempDir())
    run.takeSuite()
    await run.cycle(() => edit(run.featureDir, SPEC_PATH, "'/cart'", "'/basket'"))
    await run.cycle(() => edit(run.appDir, 'src/server.ts', ', 0)', ', 1)'))
    await run.cycle(() => edit(run.featureDir, SPEC_PATH, "'Total'", "'Sum'"))
    expect(await recover(run, 3, SPEC_PATH)).toMatchObject({ recovery: { kind: 'reconstructed' }, before: specAt(["'/cart'", "'/basket'"]) })
    run.takeSuite()
    expect(await recover(run, 1, SPEC_PATH)).toMatchObject({ recovery: { kind: 'reconstructed' }, before: SPEC })
  })

  it('places a copy taken after a later cycle deleted the file', async () => {
    const run = cycleRun(tempDir())
    await run.cycle(() => edit(run.featureDir, HELPER_PATH, 'cents / 100', 'cents / 100.0'))
    await run.cycle(() => git(run.workspace, 'rm', '-qf', 'features/demo/helpers/util.ts'))
    run.takeSuite()
    expect(await recover(run, 1, HELPER_PATH)).toEqual({
      recovery: { kind: 'reconstructed', verified: 'blob' },
      before: HELPER, after: HELPER.replace('cents / 100', 'cents / 100.0'),
    })
  })

  it('keeps a file\'s CRLF endings through the replay', async () => {
    const run = cycleRun(tempDir())
    const crlf = 'one\r\ntwo\r\n'
    run.write(run.featureDir, 'helpers/crlf.ts', crlf)
    git(run.workspace, 'commit', '-qm', 'crlf')
    run.takeSuite()
    await run.cycle(() => edit(run.featureDir, 'helpers/crlf.ts', 'two', 'deux'))
    expect(await recover(run, 1, 'crlf.ts')).toMatchObject({ recovery: { kind: 'reconstructed' }, before: crlf, after: 'one\r\ndeux\r\n' })
  })

  it('reads an earlier cycle the journal cut as a break, and falls back to git', async () => {
    const run = cycleRun(tempDir())
    run.takeSuite()
    await run.cycle(() => edit(run.featureDir, SPEC_PATH, "'/cart'", "'/basket'"), { journal: 'inline', cut: 30 })
    await run.cycle(() => edit(run.featureDir, SPEC_PATH, "'Total'", "'Sum'"))
    expect(cycleDiffs(run.runDir).get(1)!.truncated).toBe(true)
    expect(await recover(run, 2, SPEC_PATH)).toMatchObject({ recovery: { kind: 'exact', from: 'before-blob', repo: run.workspace } })
  })

  it('walks back from a later copy without crossing an earlier cut cycle', async () => {
    const run = cycleRun(tempDir())
    await run.cycle(() => edit(run.featureDir, SPEC_PATH, "'/cart'", "'/basket'"), { journal: 'inline', cut: 30 })
    await run.cycle(() => edit(run.featureDir, SPEC_PATH, "'Total'", "'Sum'"))
    run.takeSuite()
    expect(await recover(run, 2, SPEC_PATH)).toMatchObject({ recovery: { kind: 'reconstructed', verified: 'blob' }, before: specAt(["'/cart'", "'/basket'"]) })
  })

  it('shows a cut cycle from its diff alone, unless both sides can be read whole', async () => {
    const run = cycleRun(tempDir())
    run.takeSuite()
    await run.cycle(() => edit(run.featureDir, SPEC_PATH, "'/cart'", "'/basket'"), { journal: 'inline', cut: 30 })
    expect(await recover(run, 1, SPEC_PATH)).toEqual({ recovery: { kind: 'patch-only', reason: 'truncated' } })
    // A copy taken after the cycle holds its after side, and git the before.
    run.takeSuite()
    expect(await recover(run, 1, SPEC_PATH)).toMatchObject({ recovery: { kind: 'exact', from: 'before-blob' }, before: SPEC })
  })

  it('refuses a replay that lands on the wrong bytes, rather than show a guessed file', async () => {
    const run = cycleRun(tempDir())
    // Mixed endings come back joined with `\n`, so the after side cannot hash right.
    run.write(run.featureDir, 'helpers/mixed.ts', 'a\r\nb\nc\n')
    git(run.workspace, 'commit', '-qm', 'mixed')
    run.takeSuite()
    await run.cycle(() => edit(run.featureDir, 'helpers/mixed.ts', 'c', 'C'))
    expect(await recover(run, 1, 'mixed.ts')).toEqual({ recovery: { kind: 'patch-only', reason: 'mismatch' } })
  })

  it('never rebuilds from a copy edited by hand; git\'s blob is used instead', async () => {
    const run = cycleRun(tempDir())
    run.takeSuite()
    fs.appendFileSync(path.join(run.suiteDir, SPEC_PATH), '// local note\n')
    await run.cycle(() => edit(run.featureDir, SPEC_PATH, "'/cart'", "'/basket'"))
    expect(await recover(run, 1, SPEC_PATH)).toMatchObject({ recovery: { kind: 'exact', from: 'before-blob' }, before: SPEC })
  })

  it('says a cycle missing from the record broke the chain it sits in', async () => {
    const run = cycleRun(tempDir())
    run.takeSuite()
    await run.cycle(() => edit(run.featureDir, SPEC_PATH, "'/cart'", "'/basket'"))
    await run.cycle(() => edit(run.featureDir, SPEC_PATH, "'Total'", "'Sum'"), { journal: 'none' })
    await run.cycle(() => edit(run.featureDir, SPEC_PATH, 'toBeVisible', 'toBeHidden'))
    // The copy places cycle 1, whose replay then misses cycle 2's edit; git
    // still holds cycle 3's before side, written by its snapshot.
    expect(await recover(run, 3, SPEC_PATH)).toMatchObject({ recovery: { kind: 'exact', from: 'before-blob' } })
    const noGit: CycleTree = { kind: 'feature-dir', gitRoot: null, suitePrefix: 'features/demo' }
    expect(await recover(run, 3, SPEC_PATH, noGit)).toEqual({ recovery: { kind: 'patch-only', reason: 'apply-failed' } })
  })
})

describe('recoverCycleFile from git', () => {
  it('reads the before blob and applies the cycle', async () => {
    const run = cycleRun(tempDir())
    await run.cycle(() => edit(run.appDir, 'src/server.ts', ', 0)', ', 1)'))
    expect(await recover(run, 1, 'server.ts')).toEqual({
      recovery: { kind: 'exact', from: 'before-blob', repo: run.appDir },
      before: SERVER, after: SERVER.replace(', 0)', ', 1)'),
    })
  })

  it('reads the after blob and undoes the cycle when the before blob was pruned', async () => {
    const run = cycleRun(tempDir())
    await run.cycle(() => edit(run.appDir, 'src/server.ts', ', 0)', ', 1)'))
    await run.cycle(() => edit(run.appDir, 'src/server.ts', 'a + b', 'a + b + 0'))
    git(run.appDir, 'commit', '-qam', 'keep the final state')
    git(run.appDir, 'prune', '--expire=now')
    expect(await recover(run, 2, 'server.ts')).toMatchObject({
      recovery: { kind: 'exact', from: 'after-blob', repo: run.appDir },
      before: SERVER.replace(', 0)', ', 1)'),
    })
  })

  it('says the blobs are gone when neither side survives', async () => {
    const run = cycleRun(tempDir())
    await run.cycle(() => edit(run.appDir, 'src/server.ts', ', 0)', ', 1)'))
    await run.cycle(() => edit(run.appDir, 'src/server.ts', 'a + b', 'a + b + 0'))
    git(run.appDir, 'prune', '--expire=now')
    expect(await recover(run, 2, 'server.ts')).toEqual({ recovery: { kind: 'patch-only', reason: 'blob-missing' } })
  })

  it('refuses a blob that does not survive being read as text', async () => {
    const run = cycleRun(tempDir())
    fs.writeFileSync(path.join(run.appDir, 'src', 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
    git(run.appDir, 'add', '-A')
    git(run.appDir, 'commit', '-qm', 'latin-1')
    await run.cycle(() => fs.appendFileSync(path.join(run.appDir, 'src', 'latin1.txt'), 'more\n'))
    expect(await recover(run, 1, 'latin1.txt')).toEqual({ recovery: { kind: 'patch-only', reason: 'blob-missing' } })
  })

  it('names a missing repository and an unknown tree', async () => {
    const run = cycleRun(tempDir())
    await run.cycle(() => edit(run.appDir, 'src/server.ts', ', 0)', ', 1)'))
    expect(await recover(run, 1, 'server.ts', { kind: 'repo', dir: null })).toEqual({ recovery: { kind: 'patch-only', reason: 'repo-missing' } })
    expect(await recover(run, 1, 'server.ts', { kind: 'unknown' })).toEqual({ recovery: { kind: 'patch-only', reason: 'no-tree' } })
  })

  it('says a hunk would not apply when a stripped line held only spaces', async () => {
    const run = cycleRun(tempDir())
    fs.writeFileSync(path.join(run.appDir, 'src', 'server.ts'), `${SERVER}   \n`)
    git(run.appDir, 'commit', '-qam', 'trailing spaces')
    await run.cycle(() => edit(run.appDir, 'src/server.ts', ', 0)', ', 1)'))
    expect(await recover(run, 1, 'server.ts')).toEqual({ recovery: { kind: 'patch-only', reason: 'apply-failed' } })
  })
})

describe('recoverCycleFile from the diff alone', () => {
  it('rebuilds an added or deleted file with no tree to read', async () => {
    const run = cycleRun(tempDir())
    await run.cycle(() => run.write(run.appDir, 'src/state.json', '{\n  "ok": true\n}\n'))
    await run.cycle(() => git(run.appDir, 'rm', '-qf', 'src/state.json'))
    const repoMissing: CycleTree = { kind: 'repo', dir: null }
    expect(await recover(run, 1, 'state.json', repoMissing)).toEqual({ recovery: { kind: 'reconstructed', verified: 'blob' }, before: '', after: '{\n  "ok": true\n}\n' })
    expect(await recover(run, 2, 'state.json', repoMissing)).toEqual({ recovery: { kind: 'reconstructed', verified: 'blob' }, before: '{\n  "ok": true\n}\n', after: '' })
  })

  it('shows a binary file from its diff', async () => {
    const run = cycleRun(tempDir())
    await run.cycle(() => run.write(run.appDir, 'logo.bin', '\u0000\u0001'))
    expect(await recover(run, 1, 'logo.bin')).toEqual({ recovery: { kind: 'patch-only', reason: 'binary' } })
  })
})

describe('recoverCycleFile without blob ids', () => {
  // A fragment with no `index` line: the copy is placed at the first recorded
  // cycle only when nothing between it and this cycle went unrecorded.
  const fragment = (from: string, to: string, file = 'features/demo/helpers/util.ts') => `--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-${from}\n+${to}`
  const entry = (n: number, diff?: string) => `## Iteration ${n} — 2026-01-01T00:0${n}:00.000Z\n\n${diff ? `### Diff\n\n\`\`\`diff\n${diff}\n\`\`\`\n` : ''}\n`
  const tree: CycleTree = { kind: 'feature-dir', gitRoot: '/no-git', suitePrefix: 'features/demo' }

  function headerlessRun(journal: string, suite: string | null) {
    const run = cycleRun(tempDir(), { app: false })
    fs.writeFileSync(run.journalPath, journal)
    run.takeSuite()
    if (suite === null) fs.rmSync(path.join(run.suiteDir, HELPER_PATH))
    else fs.writeFileSync(path.join(run.suiteDir, HELPER_PATH), suite)
    return run
  }

  it('accepts an unbroken replay from the start, checked by its context', async () => {
    const run = headerlessRun(entry(1, fragment('one', 'two')) + entry(2, fragment('two', 'three')), 'one\n')
    expect(await recover(run, 2, HELPER_PATH, tree)).toEqual({ recovery: { kind: 'reconstructed', verified: 'context' }, before: 'two\n', after: 'three\n' })
  })

  it('does not place the copy across an unrecorded cycle, or with nothing to read', async () => {
    const broken = headerlessRun(entry(1, fragment('one', 'two')) + entry(2) + entry(3, fragment('two', 'three')), 'one\n')
    const gitless: CycleTree = { ...tree, gitRoot: null }
    expect(await recover(broken, 3, HELPER_PATH, gitless)).toEqual({ recovery: { kind: 'patch-only', reason: 'mismatch' } })
    // With a git root but no ids, there is no blob to ask for.
    expect(await recover(broken, 3, HELPER_PATH, tree)).toEqual({ recovery: { kind: 'patch-only', reason: 'mismatch' } })
    const outside = headerlessRun(entry(1, fragment('one', 'two', 'elsewhere/util.ts')), 'one\n')
    expect(await recover(outside, 1, 'elsewhere/util.ts', gitless)).toEqual({ recovery: { kind: 'patch-only', reason: 'mismatch' } })
    const escaping = headerlessRun(entry(1, fragment('one', 'two', 'features/demo/../../escape.ts')), 'one\n')
    expect(await recover(escaping, 1, 'escape.ts', gitless)).toEqual({ recovery: { kind: 'patch-only', reason: 'mismatch' } })
  })

  it('reads a copy without the file as an empty start', async () => {
    const added = '--- /dev/null\n+++ b/features/demo/helpers/util.ts\n@@ -0,0 +1 @@\n+one'
    const run = headerlessRun(entry(1, added) + entry(2, fragment('one', 'two')), null)
    expect(await recover(run, 2, HELPER_PATH, tree)).toEqual({ recovery: { kind: 'reconstructed', verified: 'context' }, before: 'one\n', after: 'two\n' })
  })
})
