import fs from 'fs'
import { applyHunks } from '../../../../../../../shared/lib/unified-diff'
import type { CycleFileRecovery, CyclePatchOnlyReason, ParsedCycleFile } from '../../../../../../../shared/test-view/cycle-review'
import { gitBlobSha1, isZeroBlob, matchesBlob } from '../../../../shared/git-blob'
import { readGitBlob } from '../../../../shared/git-repo'
import { confinedFile } from '../../../../shared/path-containment'
import type { CycleDiff } from './cycle-sources'
import { suiteRelativePath, type CycleTree } from './cycle-tree'

export interface RecoverCycleFileInput {
  file: ParsedCycleFile
  iteration: number
  tree: CycleTree
  diffs: ReadonlyMap<number, CycleDiff>
  /** The run's suite copy, when one was taken. */
  suiteDir: string | null
}

export interface RecoveredCycleFile {
  recovery: CycleFileRecovery
  /** Both are present unless the recovery is patch-only. */
  before?: string
  after?: string
}

interface Link { iteration: number; file: ParsedCycleFile }

const nameBefore = (file: ParsedCycleFile): string => file.previousPath ?? file.path

/** The same file in every recorded cycle, following renames both ways. */
function fileChain(file: ParsedCycleFile, iteration: number, diffs: ReadonlyMap<number, CycleDiff>): Link[] {
  const links: Link[] = [{ iteration, file }]
  const cycles = [...diffs.keys()]
  let name = nameBefore(file)
  for (const k of cycles.filter((k) => k < iteration).reverse()) {
    const entry = diffs.get(k)!.files.find((item) => item.path === name)
    if (!entry) continue
    links.unshift({ iteration: k, file: entry })
    name = nameBefore(entry)
  }
  name = file.path
  for (const k of cycles.filter((k) => k > iteration)) {
    const entry = diffs.get(k)!.files.find((item) => nameBefore(item) === name)
    if (!entry) continue
    links.push({ iteration: k, file: entry })
    name = entry.path
  }
  return links
}

type Walk = { ok: true; text: string } | { ok: false; link: number }

/** Move a file's text between two points of its chain. Point `i` is the file
 * just before `links[i]`; going back undoes each link in reverse order. */
function walk(text: string, links: readonly Link[], from: number, to: number): Walk {
  let current = text
  const step = (i: number, direction: 'forward' | 'reverse'): boolean => {
    if (links[i].file.truncated) return false
    const result = applyHunks(current, links[i].file.hunks, direction)
    if (result.ok) current = result.text
    return result.ok
  }
  for (let i = from; i < to; i++) if (!step(i, 'forward')) return { ok: false, link: i }
  for (let i = from - 1; i >= to; i--) if (!step(i, 'reverse')) return { ok: false, link: i }
  return { ok: true, text: current }
}

/** The suite copy holds the file as it was at the last adoption, which may
 * be any point of the chain: it is placed by its blob id, never assumed to be
 * the run's start. With no ids at all, an unbroken run of recorded cycles
 * from the start is the only placement on offer. */
function replayFromSuite(links: readonly Link[], at: number, tree: Extract<CycleTree, { kind: 'feature-dir' }>, suiteDir: string, diffs: ReadonlyMap<number, CycleDiff>): { before?: string; after?: string; reason?: CyclePatchOnlyReason } {
  const read = (name: string): string | null | undefined => {
    const rel = suiteRelativePath(tree, name)
    if (rel === null) return undefined
    try {
      const file = confinedFile(suiteDir, rel)
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
    } catch {
      // Outside the suite copy, or not a readable file: the copy cannot place it.
      return undefined
    }
  }
  const holds = (text: string | null | undefined, sha: string): boolean =>
    isZeroBlob(sha) ? text === null : typeof text === 'string' && matchesBlob(gitBlobSha1(text), sha)
  let anchor: { point: number; text: string } | undefined
  for (const [i, { file }] of links.entries()) {
    if (!file.blobs) continue
    const before = read(nameBefore(file))
    if (holds(before, file.blobs.before)) { anchor = { point: i, text: before ?? '' }; break }
    const after = read(file.path)
    if (holds(after, file.blobs.after)) { anchor = { point: i + 1, text: after ?? '' }; break }
  }
  if (!anchor && links.every((link) => !link.file.blobs)) {
    const first = links[0].iteration
    const unbroken = Array.from({ length: links[at].iteration - first + 1 }, (_, i) => first + i).every((k) => diffs.has(k))
    const start = read(nameBefore(links[0].file))
    if (unbroken && start !== undefined) anchor = { point: 0, text: start ?? '' }
  }
  if (!anchor) return { reason: 'mismatch' }
  const before = walk(anchor.text, links, anchor.point, at)
  const after = walk(anchor.text, links, anchor.point, at + 1)
  const failed = [before, after].find((side): side is Extract<Walk, { ok: false }> => !side.ok)
  return {
    ...(before.ok ? { before: before.text } : {}),
    ...(after.ok ? { after: after.text } : {}),
    ...(failed ? { reason: failed.link === at ? (links[at].file.truncated ? 'truncated' : 'apply-failed') : 'chain-broken' } : {}),
  }
}

/** Recover both full versions of one file in one cycle, or say why only its
 * diff can be shown. Each version is accepted only when it hashes to the blob
 * id the diff recorded, so a version is never guessed: from the run's suite
 * copy replayed through the cycles, then from git's copy of either side with
 * this cycle applied or undone. An added or deleted file has an empty side,
 * so its diff alone rebuilds it. */
export async function recoverCycleFile({ file, iteration, tree, diffs, suiteDir }: RecoverCycleFileInput): Promise<RecoveredCycleFile> {
  if (file.change === 'binary') return { recovery: { kind: 'patch-only', reason: 'binary' } }
  // Only a side that is still missing is ever checked, and the empty side of
  // an added or deleted file is known from the start, so the id checked here
  // is never the zero id.
  const accepts = (text: string, side: 'before' | 'after'): boolean =>
    !file.blobs || matchesBlob(gitBlobSha1(text), file.blobs[side])
  let before = file.change === 'added' ? '' : undefined
  let after = file.change === 'deleted' ? '' : undefined
  let fromGit: 'before-blob' | 'after-blob' | undefined
  const reasons: CyclePatchOnlyReason[] = file.truncated ? ['truncated'] : []
  const fill = (): void => {
    if (file.truncated || (before === undefined) === (after === undefined)) return
    const result = applyHunks((before ?? after)!, file.hunks, before === undefined ? 'reverse' : 'forward')
    const side = before === undefined ? 'before' : 'after'
    if (!result.ok || !accepts(result.text, side)) { reasons.push(result.ok ? 'mismatch' : 'apply-failed'); return }
    if (side === 'before') before = result.text
    else after = result.text
  }
  fill()

  if (tree.kind === 'feature-dir' && suiteDir && (before === undefined || after === undefined)) {
    const links = fileChain(file, iteration, diffs)
    const replay = replayFromSuite(links, links.findIndex((link) => link.iteration === iteration), tree, suiteDir, diffs)
    if (replay.reason) reasons.push(replay.reason)
    if (before === undefined && replay.before !== undefined) {
      if (accepts(replay.before, 'before')) before = replay.before
      else reasons.push('mismatch')
    }
    if (after === undefined && replay.after !== undefined) {
      if (accepts(replay.after, 'after')) after = replay.after
      else reasons.push('mismatch')
    }
    fill()
  }

  const gitDir = tree.kind === 'repo' ? tree.dir : tree.kind === 'feature-dir' ? tree.gitRoot : null
  if (before === undefined || after === undefined) {
    if (tree.kind === 'unknown') reasons.push('no-tree')
    else if (!gitDir) reasons.push('repo-missing')
    else {
      for (const side of ['before', 'after'] as const) {
        const sha = file.blobs?.[side]
        if ((side === 'before' ? before : after) !== undefined || !sha || isZeroBlob(sha)) continue
        const text = await readGitBlob(gitDir, sha)
        if (text === null || !accepts(text, side)) continue
        if (side === 'before') before = text
        else after = text
        fromGit ??= `${side}-blob`
      }
      if (!fromGit) reasons.push('blob-missing')
      fill()
    }
  }

  // A side still missing here always left a reason: the git step either
  // names why it read nothing, or read a side and `fill` says why the other
  // could not follow from it.
  if (before === undefined || after === undefined) return { recovery: { kind: 'patch-only', reason: reasons[0] } }
  const recovery: CycleFileRecovery = fromGit
    ? { kind: 'exact', from: fromGit, repo: gitDir! }
    : { kind: 'reconstructed', verified: file.blobs ? 'blob' : 'context' }
  return { recovery, before, after }
}
