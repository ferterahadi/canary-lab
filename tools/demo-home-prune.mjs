import fs from 'fs'
import path from 'path'

// Registry files in `~/.canary-lab` that can end up naming a demo workspace, and
// the key each keeps its list under.
const REGISTRY_FILES = [
  ['active-servers.json', 'servers'],
  ['workspaces.json', 'workspaces'],
]

function canonicalPath(target) {
  try {
    return fs.realpathSync(target)
  } catch {
    // A stale registry entry may already be gone; path.resolve still preserves
    // the previous lexical comparison without making best-effort cleanup fail.
    return path.resolve(target)
  }
}

// Remove every entry in the user's REAL `~/.canary-lab` that points inside a
// finished demo's root.
//
// The demo runs its children under CANARY_LAB_HOME=<demoRoot> so its own state
// stays out of the real home. Two things still land there, and neither is the
// demo overstepping:
//   • The live-server record is machine-wide on purpose (see active-servers.ts),
//     so an MCP client in any session can reach the demo server. The server
//     unregisters itself on a clean exit; this is the belt-and-braces path for a
//     SIGKILL, which would otherwise leave a dead entry behind.
//   • CONTRIBUTING's `canary-lab setup --force --agent all` is run BY HAND, in a
//     normal shell with no isolation env, so it registers the workspace in the
//     real registry. Old disposable demos need that entry removed; retained
//     interactive demos deliberately keep it.
//
// Returns the files it actually changed, so the caller can report them. Never
// throws: a malformed or read-only registry must not turn a demo exit into a
// failure.
export function pruneDemoStateFromRealHome(
  registryDir,
  demoRoot,
  onWarn = () => {},
  { preserveWorkspaceRegistration = false } = {},
) {
  // macOS exposes the same temp directory through `/var` and `/private/var`.
  // Registry writers can record either spelling, so compare filesystem identity
  // while the retained demo workspace still exists instead of comparing aliases.
  const ownedRoot = canonicalPath(demoRoot)
  const ownedPrefix = ownedRoot + path.sep
  const changed = []
  for (const [file, key] of REGISTRY_FILES) {
    if (file === 'workspaces.json' && preserveWorkspaceRegistration) continue
    const target = path.join(registryDir, file)
    if (!fs.existsSync(target)) continue
    try {
      const parsed = JSON.parse(fs.readFileSync(target, 'utf-8'))
      const entries = parsed?.[key]
      if (!Array.isArray(entries)) continue
      // `projectRoot` for a server record, `path` for a workspace one.
      const kept = entries.filter((entry) => {
        const location = entry?.projectRoot ?? entry?.path
        if (typeof location !== 'string') return true
        const canonicalLocation = canonicalPath(location)
        return canonicalLocation !== ownedRoot && !canonicalLocation.startsWith(ownedPrefix)
      })
      if (kept.length === entries.length) continue
      fs.writeFileSync(target, `${JSON.stringify({ ...parsed, [key]: kept }, null, 2)}\n`)
      changed.push(file)
    } catch (error) {
      onWarn(`could not prune ${target}: ${error.message}`)
    }
  }
  return changed
}
