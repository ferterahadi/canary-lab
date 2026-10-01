// A suite's docs listing, as GET /api/features/:name/docs returns it.
export interface FeatureDoc {
  relPath: string
  /** Absolute path on disk — used to open the doc in the configured editor. */
  absPath: string
  /** A generated PRD artifact (`_prd-*`) vs a source doc the user added. */
  generated: boolean
  sizeBytes: number
  /** A symlink to a doc that lives elsewhere (the user's original is the live
   *  source). Absent for plain files. */
  linked?: boolean
  /** The symlink's target, when linked (shown in the docs UI tooltip). */
  linkTarget?: string
  /** A symlink whose target no longer exists — surfaced, never crashed on. */
  broken?: boolean
}

export interface FeatureDocsListing {
  feature: string
  docs: FeatureDoc[]
  hasPrdSummary: boolean
  prdSummaryGeneratedAt?: string
  /** Source-doc count (excludes generated artifacts). */
  sourceDocCount: number
  docsDrift: boolean
}
