import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { writeFeatureDoc } from '../../../config/logic/feature-authoring'
import { publishWorkspaceEvent } from '../../../../shared/workspace-events'
import type { StageAdapter, StageContext, StageOutcome } from '../conductor'
import { featureDirFor, type FlightStageDeps } from './context'

// Populate features/<f>/docs/ from the PRD-source hierarchy:
//   (0) docs already present (user-dropped, or MCP-path conversation docs) →
//   (1) requirement-bearing repo docs (README, docs/**.md) →
//   (2) the code diff vs the base branch, when a meaningful one exists →
//   (3) the flight description alone.
// Non-yolo flights park on the prd-source checkpoint so the user can drop a
// real PRD before canary infers one. Everything lands through the same
// writeFeatureDoc used by the UI + MCP, feeding the same PRD engine.

const MAX_REPO_DOCS = 10
const MAX_DOC_BYTES = 200 * 1024
const MAX_DIFF_BYTES = 400 * 1024

function userDocs(featureDir: string): string[] {
  const docsDir = path.join(featureDir, 'docs')
  try {
    return fs
      .readdirSync(docsDir)
      .filter((f) => !f.startsWith('_') && /\.(md|markdown|txt)$/i.test(f))
      .filter((f) => fs.statSync(path.join(docsDir, f)).size > 0)
  } catch {
    return []
  }
}

function findRepoDocs(repoPaths: string[]): Array<{ repo: string; file: string }> {
  const found: Array<{ repo: string; file: string }> = []
  for (const repo of repoPaths) {
    const candidates = ['README.md', 'readme.md', 'Readme.md'].map((f) => path.join(repo, f))
    const docsDir = path.join(repo, 'docs')
    try {
      for (const entry of fs.readdirSync(docsDir)) {
        if (/\.md$/i.test(entry)) candidates.push(path.join(docsDir, entry))
      }
    } catch {
      /* no docs dir */
    }
    for (const file of candidates) {
      if (found.length >= MAX_REPO_DOCS) return found
      try {
        const stat = fs.statSync(file)
        if (stat.isFile() && stat.size > 0 && stat.size <= MAX_DOC_BYTES) {
          found.push({ repo, file })
        }
      } catch {
        /* absent */
      }
    }
  }
  return found
}

function git(repo: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 }).trim()
  } catch {
    return null
  }
}

function detectBaseBranch(repo: string, override?: string): string | null {
  if (override) return override
  const head = git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (head) return head.replace(/^origin\//, '')
  for (const candidate of ['main', 'master']) {
    if (git(repo, ['rev-parse', '--verify', '--quiet', candidate]) !== null) return candidate
  }
  return null
}

function diffVsBase(repo: string, base: string): string | null {
  const current = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!current || current === base) return null
  const diff = git(repo, ['diff', `${base}...HEAD`, '--stat', '-p'])
  if (!diff || diff.length < 40) return null
  return diff.length > MAX_DIFF_BYTES ? diff.slice(0, MAX_DIFF_BYTES) + '\n…(truncated)' : diff
}

export function docsStage(deps: FlightStageDeps): StageAdapter {
  const ctxAuthoring = { projectRoot: deps.projectRoot, featuresDir: deps.featuresDir }

  const write = (feature: string, relPath: string, content: string): string | null => {
    const result = writeFeatureDoc(ctxAuthoring, { feature, relPath, content })
    return result.ok ? null : result.error
  }

  const gather = (ctx: StageContext, source: string): StageOutcome => {
    const m = ctx.manifest()
    const featureDir = featureDirFor(deps, m.feature)
    const written: string[] = []

    if (source === 'use-repo-docs' || source === 'auto') {
      for (const { repo, file } of findRepoDocs(m.repoPaths)) {
        const rel = `${path.basename(repo)}-${path.basename(file)}`.toLowerCase()
        const err = write(m.feature, rel, fs.readFileSync(file, 'utf-8'))
        if (!err) written.push(rel)
      }
      if (written.length > 0) source = 'repo-docs'
      else if (source === 'use-repo-docs') ctx.appendLog('[docs] no requirement-bearing repo docs found — falling back\n')
    }

    if (written.length === 0 && source !== 'description-only') {
      for (const repo of m.repoPaths) {
        const base = detectBaseBranch(repo, m.opts.base)
        const diff = base ? diffVsBase(repo, base) : null
        if (diff) {
          const rel = `diff-${path.basename(repo)}-vs-${base}.md`.toLowerCase()
          const content = `# ${m.description}\n\nRequirements are to be inferred from this change set (${path.basename(repo)}, diff vs ${base}).\n\n\`\`\`diff\n${diff}\n\`\`\`\n`
          const err = write(m.feature, rel, content)
          if (!err) written.push(rel)
        }
      }
      if (written.length > 0) source = 'diff-vs-base'
    }

    if (written.length === 0) {
      const err = write(m.feature, 'description.md', `# ${m.feature}\n\n${m.description}\n`)
      if (err) return { kind: 'failed', error: err }
      written.push('description.md')
      source = 'description-only'
    }

    publishWorkspaceEvent(deps.workspaceEvents, { type: 'coverage-changed', feature: m.feature })
    ctx.appendLog(`[docs] ${written.length} doc(s) from ${source}\n`)
    const docs = userDocs(featureDir)
    if (docs.length === 0) return { kind: 'failed', error: 'no docs landed in features/<f>/docs/' }
    return { kind: 'done', evidence: { source, docs } }
  }

  return {
    async run(ctx) {
      const m = ctx.manifest()
      const existing = userDocs(featureDirFor(deps, m.feature))
      if (existing.length > 0) {
        return { kind: 'done', evidence: { source: 'existing', docs: existing } }
      }
      if (m.opts.yolo) return gather(ctx, 'auto')

      const repoDocs = findRepoDocs(m.repoPaths)
      return {
        kind: 'checkpoint',
        checkpoint: {
          kind: 'prd-source',
          message: `No PRD docs yet for "${m.feature}". Drop doc files into features/${m.feature}/docs/ and retry, or pick a source to infer from.`,
          options: ['use-repo-docs', 'infer-from-diff', 'description-only', 'retry'],
          data: { repoDocsDetected: repoDocs.map((d) => d.file) },
        },
      }
    },
    async onCheckpointResponse(ctx, response) {
      const m = ctx.manifest()
      // The user may have dropped docs while we waited — hierarchy rung 0.
      const existing = userDocs(featureDirFor(deps, m.feature))
      if (existing.length > 0) return { kind: 'done', evidence: { source: 'dropped', docs: existing } }
      const choice = response.choice ?? ''
      if (choice === 'retry') return this.run!(ctx)
      if (['use-repo-docs', 'infer-from-diff', 'description-only'].includes(choice)) {
        return gather(ctx, choice === 'infer-from-diff' ? 'diff' : choice)
      }
      return this.run!(ctx)
    },
  }
}
