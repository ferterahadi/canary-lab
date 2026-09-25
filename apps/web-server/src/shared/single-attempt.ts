import fs from 'fs'
import path from 'path'
import type { SingleAttemptPolicy } from '../../../../shared/launcher/types'

/** The suite supplies the receipt location; Canary only checks whether the
 *  first attempt claimed it. Reject traversal before a run can use the policy. */
export function validateSingleAttempt(policy: SingleAttemptPolicy | undefined): void {
  if (!policy) return
  const receipt = policy.receipt
  if (typeof receipt !== 'string' || !receipt || path.isAbsolute(receipt)
    || receipt.split(/[\\/]/).some((part) => !part || part === '.' || part === '..')) {
    throw new Error('singleAttempt.receipt must be a run-relative path without empty or parent segments')
  }
}

export function claimedSingleAttempt(runDir: string, policy: SingleAttemptPolicy | undefined): boolean {
  if (!policy) return false
  validateSingleAttempt(policy)
  return fs.existsSync(path.join(runDir, policy.receipt))
}

/** New runs pin the policy in their manifest. Older manifests predate the
 *  field, so consult only that run's named suite config before allowing a
 *  terminal restart. A malformed or unavailable config cannot prove a claim. */
export function policyForRunManifest(manifest: {
  singleAttempt?: SingleAttemptPolicy
  featureDir?: string
  feature: string
}): SingleAttemptPolicy | undefined {
  if (manifest.singleAttempt) return manifest.singleAttempt
  const featureDir = manifest.featureDir
  if (!featureDir) return undefined
  if (path.basename(featureDir) !== manifest.feature) return undefined
  const candidate = ['feature.config.cjs', 'feature.config.js', 'feature.config.ts']
    .map((name) => path.join(featureDir, name))
    .find((file) => fs.existsSync(file))
  if (!candidate) return undefined
  try {
    delete require.cache[require.resolve(candidate)]
    const mod = require(candidate)
    const config = mod.config ?? mod.default
    if (config?.name !== manifest.feature) return undefined
    validateSingleAttempt(config.singleAttempt)
    return config.singleAttempt
  } catch {
    return undefined
  }
}

export const NEW_RUN_REQUIRED_MESSAGE =
  'This run already claimed its one external-effect attempt. The repair was not verified. Review its captured changes, promote the fix, then start a fresh run without run_ref after the required approval.'

export const NEW_RUN_REQUIRED_NEXT_STEPS = [
  'Call get_run to inspect the terminal result and captured changes.',
  'Review and promote the app fix, then obtain the suite-required approval for another external-effect attempt.',
  'After approval, call start_run without run_ref to create a fresh run ID.',
]
