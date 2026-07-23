import * as fs from 'fs';
import * as path from 'path';
import { getEnvSetsDir, loadConfig, resolveVars } from './switch';

/**
 * Hydrate a feature's captured envset into per-run / verify WORKTREES.
 *
 * The env-switcher's targets are ABSOLUTE real-repo paths, and worktrees are
 * cut from committed HEAD — so a worktree boot never sees the envset the
 * real-path apply wrote (uncommitted). Any service whose checked-in config
 * differs from the captured one (e.g. a docker-compose `db` hostname vs the
 * captured `localhost` datasource) then dies in the worktree while booting
 * green at its real path. This helper closes that gap: each slot whose real
 * target lies under a mapped git root is written to the SAME relative path
 * inside that root's worktree.
 *
 * Two call sites, two port-token policies:
 *  - run boots pass `resolve` (one port map exists) so `${port.*}` tokens
 *    follow the run's allocation, byte-identical to the real-path apply;
 *  - the portify double-boot passes NO `resolve` — one shared file cannot
 *    carry two instances' port maps, and resolving with either map risks a
 *    false PASS with the instances cross-wired. Tokens are left verbatim
 *    (inert when the service wires ports per-process, which is exactly what
 *    portify enforces) and reported via `portTokenSlots` so a failed verify
 *    can hint at the file-bound wiring.
 */

export interface WorktreeRootMap {
  /** Git toplevel of the source repo (symlink-resolved by git). */
  sourceRoot: string
  /** Toplevel of the worktree standing in for that root. */
  worktreeRoot: string
}

export interface HydrateResult {
  /** Worktree-absolute paths written (one per hydrated slot). */
  written: string[]
  /** Slots left with unresolved `${port.*}` tokens (no `resolve` given). */
  portTokenSlots: string[]
  /** Revert every write: prior bytes restored, created files unlinked. */
  restore(): void
}

const NOOP_RESULT: HydrateResult = { written: [], portTokenSlots: [], restore: () => {} }

/** Realpath that tolerates a not-yet-existing tail: canonicalize the deepest
 *  existing ancestor and re-join the remainder, so containment checks agree
 *  with git's symlink-resolved roots (macOS /var → /private/var). */
function realpathDeep(p: string): string {
  let dir = p
  const tail: string[] = []
  while (!fs.existsSync(dir)) {
    const parent = path.dirname(dir)
    if (parent === dir) return p // hit the root without finding anything real
    tail.unshift(path.basename(dir))
    dir = parent
  }
  try { dir = fs.realpathSync(dir) } catch { /* keep as-is */ }
  return tail.length > 0 ? path.join(dir, ...tail) : dir
}

function isUnder(child: string, root: string): boolean {
  const rel = path.relative(root, child)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

export function hydrateEnvsetIntoWorktrees(opts: {
  /** Absolute featureDir (getEnvSetsDir/loadConfig accept it directly). */
  featureDir: string
  setName: string
  roots: WorktreeRootMap[]
  /** `${port.*}` transform; absent = verbatim copy + portTokenSlots report. */
  resolve?: (content: string) => string
}): HydrateResult {
  const envSetsDir = getEnvSetsDir(opts.featureDir)
  // No envsets configured → nothing to hydrate (mirrors applyFeatureEnvset).
  if (!fs.existsSync(path.join(envSetsDir, 'envsets.config.json'))) return NOOP_RESULT

  const config = loadConfig(opts.featureDir)
  const setDir = path.join(envSetsDir, opts.setName)
  const rootsReal = opts.roots.map((r) => ({ ...r, sourceRootReal: realpathDeep(r.sourceRoot) }))

  const written: string[] = []
  const portTokenSlots: string[] = []
  const undo: Array<{ dest: string; prior: Buffer | null }> = []

  for (const slot of config.feature.slots) {
    const sourcePath = path.join(setDir, slot)
    if (!fs.existsSync(sourcePath)) continue // slot absent from this set
    const targetReal = realpathDeep(resolveVars(config.slots[slot].target, config.appRoots))
    const root = rootsReal.find((r) => isUnder(targetReal, r.sourceRootReal))
    // Targets outside every mapped root (e.g. the feature's own .env under
    // featureDir) are the real-path apply's business, not the worktree's.
    if (!root) continue

    const dest = path.join(root.worktreeRoot, path.relative(root.sourceRootReal, targetReal))
    const content = fs.readFileSync(sourcePath, 'utf-8')
    const resolved = opts.resolve ? opts.resolve(content) : content
    if (!opts.resolve && /\$\{port\./.test(content)) portTokenSlots.push(slot)

    undo.push({ dest, prior: fs.existsSync(dest) ? fs.readFileSync(dest) : null })
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, resolved)
    written.push(dest)
  }

  return {
    written,
    portTokenSlots,
    // Reverse order so a slot written twice (duplicate targets) unwinds clean.
    restore: () => {
      for (const { dest, prior } of [...undo].reverse()) {
        try {
          if (prior === null) fs.rmSync(dest, { force: true })
          else fs.writeFileSync(dest, prior)
        } catch { /* best-effort — worktrees are disposable */ }
      }
    },
  }
}
