import fs from 'fs'
import os from 'os'
import path from 'path'
import { FeatureAuthoringContext, findFeature, isWithin } from './feature-authoring'
import { publishWorkspaceEvent } from '../../../shared/workspace-events'

// Docs feed the PRD summary, so every successful docs write announces
// `coverage-changed` — the Docs rail and the coverage headline both re-read on
// it. Emitted HERE rather than at the call sites (three surfaces write docs:
// the flight's docs stage, the coverage routes, the MCP authoring tools) so no
// path can land a doc silently. See FeatureAuthoringContext.workspaceEvents.
function announceDocsChanged(ctx: FeatureAuthoringContext, feature: string): void {
  publishWorkspaceEvent(ctx.workspaceEvents, { type: 'coverage-changed', feature })
}

// Write a prose doc (distilled session, plan, notes) into a feature's `docs/`
// directory. The one home for feature-scoped documentation — the scaffold
// otherwise has no place for it, and the draft-apply path rejects non-spec
// files. Create-or-replace: the caller picks a slug; re-writing the same
// relPath overwrites. Markdown only; path-traversal hardened.
export function writeFeatureDoc(ctx: FeatureAuthoringContext, input: {
  feature: string
  relPath: string
  content: string
}): { ok: true; writtenPath: string; relativePath: string } | { ok: false; error: string } {
  const feature = findFeature(ctx.featuresDir, input.feature)
  if (!feature?.featureDir) return { ok: false, error: 'feature not found' }
  if (typeof input.content !== 'string' || input.content.trim() === '') {
    return { ok: false, error: 'content must be a non-empty string' }
  }
  const resolved = resolveDocRelPath(input.relPath)
  if (!resolved.ok) return { ok: false, error: resolved.error }
  const docsDir = path.join(feature.featureDir, 'docs')
  const dest = path.join(docsDir, resolved.rel)
  if (!isWithin(docsDir, dest)) return { ok: false, error: 'relPath must not escape the docs directory' }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  // Never write THROUGH a symlink into the user's original file — replace the
  // link with a real file instead.
  try {
    if (fs.lstatSync(dest).isSymbolicLink()) fs.rmSync(dest)
  } catch {
    /* absent — plain create */
  }
  fs.writeFileSync(dest, input.content, 'utf8')
  announceDocsChanged(ctx, feature.name)
  return { ok: true, writtenPath: dest, relativePath: path.relative(feature.featureDir, dest) }
}

// Symlink a LOCAL doc into a feature's docs/, so the user's original stays the
// live source (edits show up on the next PRD summary without a re-import).
// Falls back to a copy where symlinks aren't permitted (Windows without
// developer mode) and reports which happened. Same traversal hardening as
// writeFeatureDoc; the flight's docs stage and the Requirements UI both land
// here — one home for linked docs.
export function linkFeatureDoc(ctx: FeatureAuthoringContext, input: {
  feature: string
  /** Absolute or ~-relative path of the doc to link. */
  targetPath: string
  /** Name inside docs/ — defaults to the target's basename. */
  relPath?: string
}): { ok: true; writtenPath: string; relativePath: string; linked: boolean } | { ok: false; error: string } {
  const feature = findFeature(ctx.featuresDir, input.feature)
  if (!feature?.featureDir) return { ok: false, error: 'feature not found' }
  const expanded =
    input.targetPath === '~' || input.targetPath.startsWith('~/')
      ? path.join(os.homedir(), input.targetPath.slice(1))
      : input.targetPath
  let real: string
  try {
    real = fs.realpathSync(path.resolve(expanded))
  } catch {
    return { ok: false, error: `target does not exist: ${input.targetPath}` }
  }
  if (!fs.statSync(real).isFile()) return { ok: false, error: 'target is not a file' }
  if (!/\.(md|markdown|txt)$/i.test(real)) {
    return { ok: false, error: 'only .md / .markdown / .txt docs can be linked' }
  }
  const resolved = resolveDocRelPath(input.relPath ?? path.basename(real), { allowTxt: true })
  if (!resolved.ok) return { ok: false, error: resolved.error }
  const docsDir = path.join(feature.featureDir, 'docs')
  const dest = path.join(docsDir, resolved.rel)
  if (!isWithin(docsDir, dest)) return { ok: false, error: 'relPath must not escape the docs directory' }
  if (isWithin(docsDir, real)) return { ok: false, error: 'target is already inside the docs directory' }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  try {
    fs.lstatSync(dest)
    fs.rmSync(dest) // replace an existing doc/link of the same name
  } catch {
    /* absent */
  }
  let linked = true
  try {
    fs.symlinkSync(real, dest)
  } catch {
    fs.copyFileSync(real, dest)
    linked = false
  }
  announceDocsChanged(ctx, feature.name)
  return { ok: true, writtenPath: dest, relativePath: path.relative(feature.featureDir, dest), linked }
}

// Delete a SOURCE doc from a feature's `docs/`. Refuses generated artifacts
// (`_`-prefixed: _prd-*, _coverage-*) — those are engine-managed, not user docs —
// and is path-traversal hardened the same way as writeFeatureDoc.
export function deleteFeatureDoc(ctx: FeatureAuthoringContext, input: {
  feature: string
  relPath: string
}): { ok: true; relativePath: string } | { ok: false; error: string } {
  const feature = findFeature(ctx.featuresDir, input.feature)
  if (!feature?.featureDir) return { ok: false, error: 'feature not found' }
  const resolved = resolveDocRelPath(input.relPath)
  if (!resolved.ok) return { ok: false, error: resolved.error }
  if (path.basename(resolved.rel).startsWith('_')) {
    return { ok: false, error: 'cannot delete a generated artifact' }
  }
  const docsDir = path.join(feature.featureDir, 'docs')
  const dest = path.join(docsDir, resolved.rel)
  if (!isWithin(docsDir, dest)) return { ok: false, error: 'relPath must not escape the docs directory' }
  // lstat, not exists: a dangling symlink (its target moved) must still be
  // deletable. rmSync on a symlink removes the link only — never the target.
  try {
    fs.lstatSync(dest)
  } catch {
    return { ok: false, error: 'doc not found' }
  }
  fs.rmSync(dest)
  announceDocsChanged(ctx, feature.name)
  return { ok: true, relativePath: path.relative(feature.featureDir, dest) }
}

// Resolve a caller-supplied doc path to a path relative to the feature's
// `docs/` dir. Accepts an optional leading `docs/` so both "notes.md" and
// "docs/notes.md" land in the same place. Rejects absolute paths and
// non-markdown extensions; traversal is caught by the `isWithin` guard at the
// call site (so `../x.md` resolves and then fails the within-docs check).
export function resolveDocRelPath(
  relPath: string,
  opts?: { allowTxt?: boolean },
): { ok: true; rel: string } | { ok: false; error: string } {
  const trimmed = (relPath ?? '').trim()
  if (!trimmed) return { ok: false, error: 'relPath required' }
  if (path.isAbsolute(trimmed)) return { ok: false, error: 'relPath must be relative' }
  const rel = trimmed.replace(/^\.?[/\\]?docs[/\\]/i, '')
  // Written docs stay markdown-only (imports convert to .md); a LINKED doc
  // keeps its original name, so plain-text sources are allowed there.
  const extRe = opts?.allowTxt ? /\.(md|markdown|txt)$/i : /\.(md|markdown)$/i
  if (!extRe.test(rel)) {
    return { ok: false, error: opts?.allowTxt ? 'relPath must end in .md, .markdown or .txt' : 'relPath must end in .md or .markdown' }
  }
  return { ok: true, rel }
}
