import path from 'path'

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export interface TestEntry {
  id?: string
  name: string
  status: string
  passed: boolean
  error?: {
    message: string
    snippet?: string
  }
  durationMs?: number
  location?: string
  locations?: string[]
  retry?: number
  logFiles?: string[]
  /** Repo-relative path to `failed/<slug>/error.txt` — the full, untruncated
   *  error message + snippet. Populated by enrichment; the in-JSON `error`
   *  stays full too, this is the agent-friendly direct pointer. */
  errorFile?: string
  /** Repo-relative path to the curated failure-summary.md produced from this
   *  test's Playwright trace.zip. Populated in onEnd after async extraction. */
  traceSummaryFile?: string
}

export interface RunningStep {
  title: string
  category: string
  location?: string
  locations?: string[]
}

export interface RunningTest {
  id?: string
  name: string
  location: string
  step?: RunningStep
}

export type PlaybackEvent =
  | {
      type: 'test-begin'
      time: string
      test: { id?: string; name: string; title: string; location: string }
    }
  | {
      type: 'step-begin' | 'step-end'
      time: string
      test: { id?: string; name: string; title: string }
      step: RunningStep
    }
  | {
      type: 'test-end'
      time: string
      test: { id?: string; name: string; title: string; location: string }
      status: string
      passed: boolean
      durationMs: number
      retry: number
      error?: { message: string; snippet?: string }
      attachments?: Array<{ name: string; contentType?: string; path?: string }>
    }
