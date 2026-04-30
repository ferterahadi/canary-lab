import path from 'path'
import fs from 'fs'

// Pure path-resolution for the GET /api/tests/draft/:id/files/* endpoint.
//
// Defence in depth: even after rejecting paths with `..` segments, we
// `path.resolve` the candidate and verify it stays under the draft's
// `generated/` directory. That defeats both `..` segments we missed and
// absolute-path injection from misconfigured route matchers.

export type ResolveResult =
  | { ok: true; absolute: string }
  | { ok: false; reason: 'invalid-path' | 'outside-draft' | 'not-found' }

export function resolveDraftFile(
  logsDir: string,
  draftId: string,
  requestPath: string,
): ResolveResult {
  if (!requestPath || requestPath.startsWith('/') || requestPath.startsWith('\\')) {
    return { ok: false, reason: 'invalid-path' }
  }
  // Normalise to forward slashes then split — reject any `..` segment.
  const segments = requestPath.split(/[\\/]+/)
  if (segments.some((s) => s === '..' || s === '')) {
    return { ok: false, reason: 'invalid-path' }
  }

  const generatedRoot = path.resolve(logsDir, 'drafts', draftId, 'generated')
  const candidate = path.resolve(generatedRoot, requestPath)

  // Defence in depth: ensure the resolved path is strictly under generatedRoot.
  const rootWithSep = generatedRoot.endsWith(path.sep) ? generatedRoot : generatedRoot + path.sep
  if (candidate !== generatedRoot && !candidate.startsWith(rootWithSep)) {
    return { ok: false, reason: 'outside-draft' }
  }

  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    return { ok: false, reason: 'not-found' }
  }
  return { ok: true, absolute: candidate }
}
