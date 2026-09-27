import fs from 'fs'
import { readFeatureConfig, writeFeatureConfig, type ConfigValue } from '../../../../shared/config-ast'
import { readOverlayOriginalConfig, removeOverlay } from './overlay'
import { FEATURE_CONFIG_NAMES, findExistingConfig } from '../../../config/logic/config-file'
import { syncEnvsInConfig } from '../../../config/logic/envset-config'

// Shared "un-portify" core, called by both the REST route
// (DELETE /api/features/:name/portify-overlay) and the MCP `remove_portification`
// tool so they can't drift. Always auto-cleans, never prompts:
//   • snapshot present (every overlay saved since snapshots shipped) → restore the
//     pre-Portify config, then derive environments from current folders.
//   • legacy overlay (no snapshot) → best-effort strip the declared `ports` slots
//     so they don't linger. The `${port.x}` health-check tokens can't be
//     un-rewritten without the snapshot; re-run Portify to regenerate cleanly.
// The overlay is deleted after successful restoration. Emitting features-changed is the caller's job.

/** Remove every `ports: [...]` slot from a parsed feature config's start
 *  commands. Returns the new value, or null when there was nothing to strip. */
export function stripPortSlots(value: ConfigValue): ConfigValue | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as { [k: string]: ConfigValue }
  if (!Array.isArray(v.repos)) return null
  let changed = false
  const repos = v.repos.map((repo) => {
    if (!repo || typeof repo !== 'object' || Array.isArray(repo)) return repo
    const r = repo as { [k: string]: ConfigValue }
    if (!Array.isArray(r.startCommands)) return repo
    const startCommands = r.startCommands.map((cmd) => {
      if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd) || !('ports' in cmd)) return cmd
      changed = true
      const { ports: _ports, ...rest } = cmd as { [k: string]: ConfigValue }
      return rest as ConfigValue
    })
    return { ...r, startCommands } as ConfigValue
  })
  return changed ? ({ ...v, repos } as ConfigValue) : null
}

/** Revert a feature's port-ification: restore the pre-Portify config (snapshot)
 *  or, for a legacy overlay, strip the declared slots; then delete the overlay.
 *  `reverted` is true when the feature config was changed. */
export function revertPortification(featureDir: string): { reverted: boolean } {
  const snapshot = readOverlayOriginalConfig(featureDir)
  const cfgPath = findExistingConfig(featureDir, FEATURE_CONFIG_NAMES)?.path
  let reverted = false
  if (snapshot != null && cfgPath) {
    fs.writeFileSync(cfgPath, snapshot)
    // Environment folders may have changed since this snapshot, including an
    // earlier Flight reset. Keep the backup until synchronization succeeds.
    syncEnvsInConfig(featureDir)
    reverted = true
  } else if (cfgPath) {
    const source = fs.readFileSync(cfgPath, 'utf-8')
    const stripped = stripPortSlots(readFeatureConfig(source).value)
    if (stripped) {
      try {
        fs.writeFileSync(cfgPath, writeFeatureConfig(source, stripped))
        reverted = true
      } catch { /* leave config as-is if the AST write fails */ }
    }
  }
  removeOverlay(featureDir)
  return { reverted }
}
