// Pure validators for the Configure step of the Add Test wizard. The wizard
// component invokes these on every render to compute its submit-disabled
// state and the per-field error strings.

export interface ConfigureInput {
  prdText: string
  repos: { name: string; localPath: string }[]
  featureName?: string
  // The name the backend would auto-derive if `featureName` is blank — used so
  // conflict checks fire even when the user leaves the field empty.
  derivedFeatureName?: string
}

export interface ConfigureValidation {
  ok: boolean
  errors: {
    repos?: string
    featureName?: string
  }
}

const FEATURE_NAME_RE = /^[a-zA-Z0-9_-]+$/

export function validateConfigure(
  input: ConfigureInput,
  existingFeatureNames: string[] = [],
): ConfigureValidation {
  const errors: ConfigureValidation['errors'] = {}
  if (input.repos.length === 0) errors.repos = 'Pick at least one repo'
  const fname = input.featureName?.trim()
  if (fname && !FEATURE_NAME_RE.test(fname)) {
    errors.featureName = 'Feature name must be alphanumeric, dashes, or underscores'
  } else {
    const effectiveName = fname || input.derivedFeatureName?.trim() || ''
    if (effectiveName) {
      const taken = existingFeatureNames.some(
        (n) => n.toLowerCase() === effectiveName.toLowerCase(),
      )
      if (taken) {
        errors.featureName = `A feature named "${effectiveName}" already exists`
      }
    }
  }
  return {
    ok: Object.keys(errors).length === 0,
    errors,
  }
}

// Slugify a PRD's first non-empty line into a feature-name candidate. Mirrors
// the server-side `slugifyFeatureName` so the placeholder shown in the UI
// matches what the backend would derive on accept.
export function slugifyFeatureName(prdText: string): string {
  const firstLine = (prdText.split('\n').find((l) => l.trim()) ?? '').trim()
  const words = firstLine
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .slice(0, 4)
  const slug = words.join('-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  return slug || 'untitled-feature'
}
