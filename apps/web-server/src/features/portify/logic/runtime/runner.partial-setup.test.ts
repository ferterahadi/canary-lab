import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Setup creates one worktree per git root, in order, assigning `group.handle`
// as it goes. If a later root fails, the earlier groups already own a worktree
// while the failed one and everything after it own nothing — so cleanup has to
// tear down exactly the handles that exist and step over the ones that don't.
// Only `git-ops` is substituted: creating a real second worktree cannot be made
// to fail deterministically.
const created: string[] = []
const discarded: string[] = []

vi.mock('./git-ops', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./git-ops')>()
  return {
    ...actual,
    createBranchAndWorktree: vi.fn(async (opts: { repoName: string; worktreesDir: string }) => {
      if (created.length >= 1) throw new Error(`worktree failed for ${opts.repoName}`)
      created.push(opts.repoName)
      const root = path.join(opts.worktreesDir, opts.repoName)
      fs.mkdirSync(root, { recursive: true })
      return { handle: { worktreeRoot: root, repoRoot: root, branch: 'b' }, snapshotRef: 'HEAD', baseSha: 'abc' }
    }),
    discardWorktree: vi.fn(async (handle: { worktreeRoot: string }) => {
      discarded.push(path.basename(handle.worktreeRoot))
    }),
  }
})

const { gitInit, makeRunner, waitForStatus, writeConfig, TERMINAL } =
  await import('./__fixtures__/runner.part4-fixtures')

const roots: string[] = []

afterEach(() => {
  created.length = 0
  discarded.length = 0
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true })
  vi.clearAllMocks()
})

/** One feature spanning TWO separate git roots, so setup builds two groups. */
async function twoRootFixture(): Promise<{ featuresDir: string; logsDir: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-partial-'))
  roots.push(root)
  const featuresDir = path.join(root, 'features')
  const featureDir = path.join(featuresDir, 'myfeat')
  const logsDir = path.join(root, 'logs')
  fs.mkdirSync(featureDir, { recursive: true })

  const repos: { name: string; localPath: string; slot: string; env: string }[] = []
  for (const [i, name] of ['app', 'api'].entries()) {
    const repo = path.join(root, name)
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'src', 'server.js'), `const PORT = process.env.PORT ?? ${3007 + i}\n`)
    await gitInit(repo)
    repos.push({ name, localPath: repo, slot: name, env: 'PORT' })
  }
  writeConfig(featureDir, repos)
  return { featuresDir, logsDir }
}

describe('portify setup that fails partway through the repo groups', () => {
  it('discards the worktrees it made and steps over the group that never got one', async () => {
    const { featuresDir, logsDir } = await twoRootFixture()
    const { store, runner } = makeRunner(featuresDir, logsDir)

    const { workflowId } = await runner.startPortify({ feature: 'myfeat', agent: 'claude', maxAttempts: 1 })
    expect(await waitForStatus(store, workflowId, TERMINAL)).toBe('failed')

    // The first root got a worktree, the second threw before one existed. Exactly
    // the created one is discarded: cleanup must not trip on the handle-less
    // group, which would leave the first worktree and its branch behind.
    expect(created).toHaveLength(1)
    expect(discarded).toEqual(created)
  })
})
