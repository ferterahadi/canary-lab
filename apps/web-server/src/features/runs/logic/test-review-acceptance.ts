import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import type { TestReviewGitReceipt } from '../../../../../../shared/test-review'
import { getGitRoot, runGit } from '../../../shared/git-repo'

export interface GitReviewPlan {
  revision: string
  files: Array<{ file: string; change: 'added' | 'deleted' | 'modified' }>
  before: Map<string, Buffer>
  after: Map<string, Buffer>
}

function validReviewFile(file: string): boolean {
  return !!file && !path.isAbsolute(file) && !file.split(/[\\/]/).includes('..')
}

function digest(files: Map<string, Buffer>): string {
  const hash = createHash('sha256')
  for (const name of [...files.keys()].sort()) {
    hash.update(JSON.stringify([name, createHash('sha256').update(files.get(name)!).digest('hex')]))
  }
  return hash.digest('hex')
}

function reviewRevision(before: Map<string, Buffer>, after: Map<string, Buffer>): string {
  return createHash('sha256').update(`${digest(before)}:${digest(after)}`).digest('hex')
}

function readFile(file: string): Buffer | undefined {
  try { return fs.readFileSync(file) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function gitLocation(featureDir: string): Promise<{ root: string; realDir: string }> {
  const root = await getGitRoot(featureDir)
  if (!root) throw Object.assign(new Error('Feature is not inside a Git repository.'), { statusCode: 409 })
  return { root, realDir: fs.realpathSync(featureDir) }
}

/** HEAD versus live bytes for the exact feature files already disclosed by the
 * browser. This is the suite-only counterpart of the run-start suite review. */
export async function buildGitReview(featureDir: string, reviewedFiles: string[]): Promise<GitReviewPlan> {
  const files = [...new Set(reviewedFiles)].sort()
  if (files.some((file) => !validReviewFile(file))) {
    throw Object.assign(new Error('Reviewed file is outside the suite.'), { statusCode: 400 })
  }
  const { root, realDir } = await gitLocation(featureDir)
  const before = new Map<string, Buffer>()
  const after = new Map<string, Buffer>()
  const changes: GitReviewPlan['files'] = []
  for (const file of files) {
    const absolute = path.join(realDir, file)
    const current = readFile(absolute)
    if (current) after.set(file, current)
    const repoRelative = path.relative(root, absolute)
    const head = await runGit(root, ['show', `HEAD:${repoRelative}`])
    const recorded = head.code === 0 ? Buffer.from(head.stdout) : undefined
    if (recorded) before.set(file, recorded)
    if (recorded?.equals(current ?? Buffer.alloc(0)) && current !== undefined) continue
    changes.push({ file, change: !recorded ? 'added' : !current ? 'deleted' : 'modified' })
  }
  return { revision: reviewRevision(before, after), files: changes, before, after }
}

function reviewedRepoPaths(root: string, featureDir: string, files: string[]): string[] {
  if (files.length === 0 || files.some((file) => !validReviewFile(file))) {
    throw Object.assign(new Error('No valid reviewed files were supplied.'), { statusCode: 409 })
  }
  return [...new Set(files)].sort().map((file) => {
    const absolute = path.resolve(featureDir, file)
    return path.relative(root, absolute)
  })
}

/** Commit only the paths the human saw. Unrelated staged work remains staged.
 * A clean result is idempotent, not approval: the caller still has to persist
 * the explicit revision-bound decision receipt. */
export async function commitReviewedFiles(feature: string, featureDir: string, files: string[]): Promise<TestReviewGitReceipt> {
  const { root, realDir } = await gitLocation(featureDir)
  const repoPaths = reviewedRepoPaths(root, realDir, files)
  const add = await runGit(root, ['add', '-A', '--', ...repoPaths])
  if (add.code !== 0) throw Object.assign(new Error((add.stderr || add.stdout).trim() || 'Git could not stage the reviewed files.'), { statusCode: 500 })

  for (const repoPath of repoPaths) {
    const liveExists = fs.existsSync(path.join(root, repoPath))
    const indexed = await runGit(root, ['ls-files', '--error-unmatch', '--', repoPath])
    if (liveExists && indexed.code !== 0) {
      throw Object.assign(new Error(`Git could not record reviewed file ${repoPath}.`), { statusCode: 409 })
    }
  }

  const staged = await runGit(root, ['diff', '--cached', '--quiet', '--', ...repoPaths])
  if (staged.code === 0) {
    const head = await runGit(root, ['rev-parse', '--verify', 'HEAD'])
    if (head.code !== 0) throw Object.assign(new Error('No Git commit exists for the reviewed files.'), { statusCode: 409 })
    return { status: 'already-committed', commit: head.stdout.trim() }
  }
  if (staged.code !== 1) throw Object.assign(new Error((staged.stderr || staged.stdout).trim() || 'Git could not inspect the reviewed files.'), { statusCode: 500 })

  const commit = await runGit(root, ['commit', '--only', '-m', `test: accept reviewed suite changes for "${feature}"`, '--', ...repoPaths])
  if (commit.code !== 0) throw Object.assign(new Error((commit.stderr || commit.stdout).trim() || 'Git could not commit the reviewed files.'), { statusCode: 500 })
  const head = await runGit(root, ['rev-parse', '--verify', 'HEAD'])
  if (head.code !== 0) throw Object.assign(new Error('Git committed the review but could not report its revision.'), { statusCode: 500 })
  return { status: 'committed', commit: head.stdout.trim() }
}

/** Restore the exact HEAD bytes the suite-only comparison disclosed. */
export async function restoreGitReview(featureDir: string, plan: GitReviewPlan): Promise<string[]> {
  const { root, realDir } = await gitLocation(featureDir)
  const restored: string[] = []
  const tracked = plan.files.filter((change) => plan.before.has(change.file))
    .map((change) => path.relative(root, path.resolve(realDir, change.file)))
  if (tracked.length > 0) {
    const restore = await runGit(root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...tracked])
    if (restore.code !== 0) throw Object.assign(new Error((restore.stderr || restore.stdout).trim() || 'Git could not restore the reviewed files.'), { statusCode: 500 })
  }
  for (const change of plan.files) {
    const target = path.resolve(realDir, change.file)
    if (!target.startsWith(`${realDir}${path.sep}`)) throw Object.assign(new Error('Reviewed file is outside the suite.'), { statusCode: 400 })
    if (!plan.before.has(change.file)) {
      await runGit(root, ['rm', '--cached', '--ignore-unmatch', '--', path.relative(root, target)])
      fs.rmSync(target, { force: true })
    }
    restored.push(change.file)
  }
  return restored
}
