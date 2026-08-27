import fs from 'fs'
import path from 'path'
import type { WorktreeHandle } from './repo-worktree'

export const HEAL_AGENT_ISOLATION_SETTINGS = 'heal-agent-isolation.settings.json'

function uniqueResolved(paths: readonly string[]): string[] {
  return [...new Set(paths.map((candidate) => path.resolve(candidate)))]
}

function isSameOrAncestor(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function canonicalLocalPath(handle: WorktreeHandle): string {
  const relative = path.relative(handle.worktreeRoot, handle.localPath)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`worktree path for "${handle.repoName}" escapes its worktree root`)
  }
  return path.resolve(handle.sourceRoot, relative)
}

// Claude permission rules read a single leading slash as settings-file-relative;
// the doubled slash marks a filesystem-absolute path. POSIX-only on purpose: the
// sandbox block below sets failIfUnavailable, which Claude Code cannot satisfy on
// Windows (sandboxing is macOS/Linux only), so heal isolation never runs there
// and a drive-letter arm would be dead code no POSIX test can reach.
function claudeAbsolutePermissionPath(candidate: string): string {
  return `/${path.resolve(candidate)}`
}

export interface HealAgentIsolationArgs {
  runDir: string
  writableDirs: readonly string[]
  featureDir: string
  featureDirReadOnly: boolean
  worktrees: readonly WorktreeHandle[]
}

/** Write invocation-local Claude settings that make the authored suite and any
 * canonical checkout read-only. The CLI is also started without user/project
 * settings sources, so a broad personal allow rule cannot reopen these paths. */
export function writeHealAgentIsolationSettings(args: HealAgentIsolationArgs): string {
  const writableDirs = uniqueResolved(args.writableDirs)
  const featureDir = path.resolve(args.featureDir)
  const worktreeProtectedDirs = uniqueResolved(args.worktrees.map(canonicalLocalPath))

  for (const protectedDir of worktreeProtectedDirs) {
    const shadowed = writableDirs.find((writableDir) => isSameOrAncestor(protectedDir, writableDir))
    if (shadowed) {
      throw new Error(
        `cannot isolate heal agent: protected source path ${protectedDir} contains writable path ${shadowed}`,
      )
    }
  }

  // A worktree's canonical source mirror must sit fully outside every writable
  // dir (checked above): worktree isolation only works when the pristine
  // checkout and its disposable copy are disjoint, so any overlap there is a
  // setup bug and fails closed. The feature dir is different — with no
  // worktree in play, its writable repo path can legitimately BE the feature
  // dir, or live nested inside it (a service repo co-located in the suite's
  // own tree; a feature whose single repo root doubles as the feature dir —
  // see makeFeature() fixtures across the runtime test suite). Neither leaves
  // a suite-only remainder to protect, so leave the feature dir writable
  // rather than emit a deny entry that contradicts its own allow entry.
  const featureDirIsDisjoint = !writableDirs.some((writableDir) => isSameOrAncestor(featureDir, writableDir))

  const protectedDirs = uniqueResolved([
    ...(args.featureDirReadOnly && featureDirIsDisjoint ? [featureDir] : []),
    ...worktreeProtectedDirs,
  ])

  const settingsPath = path.join(args.runDir, HEAL_AGENT_ISOLATION_SETTINGS)
  const settings = {
    permissions: {
      deny: protectedDirs.map((candidate) => `Edit(${claudeAbsolutePermissionPath(candidate)}/**)`),
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        allowWrite: writableDirs,
        denyWrite: protectedDirs,
      },
    },
  }
  fs.mkdirSync(args.runDir, { recursive: true })
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
  return settingsPath
}
