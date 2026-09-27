import type { RunFixCaptureRepo } from '../../../../../../shared/run-state'
import { porcelainPath } from '../../../shared/git-status-path'

/** Older captures persisted `git diff --name-only` output, including C quoting.
 * Mark normalized records so a literal quote in a new filename is never decoded
 * twice when a manifest is subsequently updated and saved. */
export function normalizeFixCaptureNames(repo: RunFixCaptureRepo): RunFixCaptureRepo {
  if (!repo.fileNames || repo.fileNamesFormat === 'literal') return repo
  return { ...repo, fileNames: repo.fileNames.map((name) => porcelainPath(` M ${name}`)), fileNamesFormat: 'literal' }
}
