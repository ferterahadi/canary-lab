// Pure validators for the Configure step of the Add Test wizard. The wizard
// component invokes these on every render to compute its submit-disabled
// state and the per-field error strings.

export interface ConfigureInput {
  prdText: string
  repos: { name: string; localPath: string }[]
  skills: string[]
  featureName?: string
}

export interface ConfigureValidation {
  ok: boolean
  errors: {
    prdText?: string
    repos?: string
    featureName?: string
  }
  // Whether the PRD is long enough to call the recommender. Decoupled from
  // form validity — the user can submit with no skills, but the recommender
  // needs ≥30 chars to give useful results.
  recommenderReady: boolean
}

const MIN_PRD_FOR_RECOMMEND = 30
const FEATURE_NAME_RE = /^[a-zA-Z0-9_-]+$/

export function validateConfigure(input: ConfigureInput): ConfigureValidation {
  const errors: ConfigureValidation['errors'] = {}
  const prd = input.prdText.trim()
  if (!prd) errors.prdText = 'PRD text is required'
  if (input.repos.length === 0) errors.repos = 'Pick at least one repo'
  const fname = input.featureName?.trim()
  if (fname && !FEATURE_NAME_RE.test(fname)) {
    errors.featureName = 'Feature name must be alphanumeric, dashes, or underscores'
  }
  return {
    ok: Object.keys(errors).length === 0,
    errors,
    recommenderReady: prd.length >= MIN_PRD_FOR_RECOMMEND,
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
