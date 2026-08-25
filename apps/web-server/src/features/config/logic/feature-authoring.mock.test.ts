import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// A separate suite from feature-authoring.test.ts because `vi.mock` is per-file:
// these cases need `checkoutBranch` to fail in ways real git never produces, and
// the main suite deliberately runs against real git working trees.
//
// Both arms exercised here were previously excused with `/* v8 ignore */`
// pragmas whose reasons ("checkoutBranch rejects with Error instances",
// "checkoutBranch attaches statusCode") describe the CALLER's habits, not a
// guarantee the type system carries. `checkoutBranch` returns
// `Promise<Record<string, unknown>>`, so a rejection value is `unknown` — a
// non-Error throw and a statusCode-less Error are both representable, which
// makes these real branches rather than dead ones.

const checkoutBranchMock = vi.hoisted(() => vi.fn())

vi.mock('../../../shared/git-repo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/git-repo')>()
  return { ...actual, checkoutBranch: checkoutBranchMock }
})

const roots: string[] = []

afterEach(() => {
  checkoutBranchMock.mockReset()
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

// One feature with one repo, enough for findFeature + findRepo to resolve before
// the mocked checkoutBranch is reached.
function fixture(): { ctx: { projectRoot: string; featuresDir: string }; repoDir: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-fa-mock-')))
  roots.push(root)
  const featuresDir = path.join(root, 'features')
  const featureDir = path.join(featuresDir, 'checkout')
  const repoDir = path.join(root, 'app')
  fs.mkdirSync(featureDir, { recursive: true })
  fs.mkdirSync(repoDir, { recursive: true })
  fs.writeFileSync(
    path.join(featureDir, 'feature.config.cjs'),
    `module.exports = { config: { name: 'checkout', description: 'd', envs: ['local'], featureDir: __dirname, repos: [{ name: 'app', localPath: ${JSON.stringify(repoDir)} }] } }`,
  )
  return { ctx: { projectRoot: root, featuresDir }, repoDir }
}

const INPUT = { feature: 'checkout', repo: 'app', branch: 'main', confirm: true } as const

describe('checkoutFeatureRepoBranch — non-Error and statusCode-less rejections', () => {
  it('stringifies a rejection that is not an Error', async () => {
    const { ctx } = fixture()
    checkoutBranchMock.mockRejectedValue('git exploded')
    const { checkoutFeatureRepoBranch } = await import('./feature-authoring')

    const result = await checkoutFeatureRepoBranch(ctx, { ...INPUT })

    // String(err), not err.message — the value has no message to read.
    expect(result).toEqual({ error: 'git exploded', statusCode: 500 })
  })

  it('falls back to 500 for an Error carrying no statusCode', async () => {
    const { ctx } = fixture()
    checkoutBranchMock.mockRejectedValue(new Error('detached HEAD'))
    const { checkoutFeatureRepoBranch } = await import('./feature-authoring')

    const result = await checkoutFeatureRepoBranch(ctx, { ...INPUT })

    expect(result).toEqual({ error: 'detached HEAD', statusCode: 500 })
  })

  it('preserves a statusCode the rejection does carry', async () => {
    const { ctx } = fixture()
    checkoutBranchMock.mockRejectedValue(Object.assign(new Error('dirty tree'), { statusCode: 409 }))
    const { checkoutFeatureRepoBranch } = await import('./feature-authoring')

    const result = await checkoutFeatureRepoBranch(ctx, { ...INPUT })

    expect(result).toEqual({ error: 'dirty tree', statusCode: 409 })
  })
})
