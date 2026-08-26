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

function claudeAbsolutePermissionPath(candidate: string): string {
  const absolute = path.resolve(candidate).replace(/\\/g, '/')
  return absolute.startsWith('/') ? `/${absolute}` : absolute
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
  const protectedDirs = uniqueResolved([
    ...(args.featureDirReadOnly ? [args.featureDir] : []),
    ...args.worktrees.map(canonicalLocalPath),
  ])

  for (const protectedDir of protectedDirs) {
    const shadowed = writableDirs.find((writableDir) => isSameOrAncestor(protectedDir, writableDir))
    if (shadowed) {
      throw new Error(
        `cannot isolate heal agent: protected source path ${protectedDir} contains writable path ${shadowed}`,
      )
    }
  }

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
