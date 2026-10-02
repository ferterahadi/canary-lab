import type { Attempt, StudyManifest } from './types'

export interface StudyAdapter {
  authorize(manifest: StudyManifest): void
  preflight(manifest: StudyManifest): Promise<void>
  check(manifest: StudyManifest): Promise<void>
  setup(manifest: StudyManifest, attempt: Attempt, root: string): Promise<void>
  integrity(manifest: StudyManifest, attempt: Attempt, root: string): { changedFiles: string[]; contamination: string[] }
  verify(manifest: StudyManifest, attempt: Attempt, root: string, signal: AbortSignal): Promise<{ success: boolean; evidence: string }>
}
