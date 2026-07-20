import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { linkFeatureDoc, writeFeatureDoc } from '../../../config/logic/feature-authoring'
import { publishWorkspaceEvent } from '../../../../shared/workspace-events'
import { renderPrompt } from '../../../../shared/prompts'
import type { StageAdapter, StageContext, StageOutcome } from '../conductor'
import { defaultSpawnAgent, featureDirFor, stageFeedback, type FlightStageDeps } from './context'

// Populate features/<f>/docs/ — the prd-source checkpoint is a two-path FORK:
//   manual — the user supplies docs (UI drop zone / MCP write_feature_doc),
//            then releases with `continue`; no agent runs.
//   agent  — `collect-repo-docs` or `infer-from-diff` spawns a collector agent
//            guided by the frozen intent: it reads the repos (or the branch
//            diff vs base) and writes ONE feature-named requirements doc
//            (<feature>-prd.md / <feature>-from-diff.md), which then feeds the
//            same distillation as user-dropped docs.
// Intent-referenced local paths ("refer to ~/…/prd.md") are still symlinked in
// before parking, so the user's original stays the live source. Yolo flights
// skip the fork and use the deterministic gather chain (repo-doc sweep → diff
// → description) — no human moment to fork on.
// Non-yolo flights ALWAYS park — even when docs exist — so the human gets one
// deliberate moment before the PRD summary runs; `continue` is the
// zero-friction release.

const MAX_REPO_DOCS = 10
const MAX_DOC_BYTES = 200 * 1024
const MAX_DIFF_BYTES = 400 * 1024

function userDocs(featureDir: string): string[] {
  const docsDir = path.join(featureDir, 'docs')
  try {
    return fs
      .readdirSync(docsDir)
      .filter((f) => !f.startsWith('_') && /\.(md|markdown|txt)$/i.test(f))
      .filter((f) => {
        try {
          return fs.statSync(path.join(docsDir, f)).size > 0
        } catch {
          return false // dangling symlink — the docs UI surfaces it as broken
        }
      })
  } catch {
    return []
  }
}

/** Local doc paths the intent references ("… refer to ~/Documents/prd.md").
 *  Absolute or ~-relative, no spaces (a quoted path with spaces is out of
 *  scope — the Requirements checkpoint's add-path input covers it). */
const INTENT_PATH_RE = /(?:~|\/)[^\s"'`,;]+\.(?:md|markdown|txt)\b/gi

export function intentDocPaths(description: string): string[] {
  const hits = description.match(INTENT_PATH_RE) ?? []
  const expanded = hits.map((p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p))
  return [...new Set(expanded)].filter((p) => {
    try {
      return fs.statSync(p).isFile()
    } catch {
      return false
    }
  })
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
          // Feature-named so the doc reads as this suite's artifact, not a
          // stray repo file (multi-repo keeps the repo qualifier for dedupe).
          const rel = `${m.feature}-from-diff${m.repoPaths.length > 1 ? `-${path.basename(repo)}` : ''}.md`.toLowerCase()
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

  /** Rung 0.5 — symlink local docs the intent references into docs/. */
  const linkIntentDocs = (ctx: StageContext): string[] => {
    const m = ctx.manifest()
    const linked: string[] = []
    for (const target of intentDocPaths(m.description)) {
      const result = linkFeatureDoc(ctxAuthoring, { feature: m.feature, targetPath: target })
      if (result.ok) {
        linked.push(result.relativePath)
        ctx.appendLog(`[docs] ${result.linked ? 'linked' : 'copied'} ${target} → docs/${path.basename(result.relativePath)}\n`)
      } else {
        ctx.appendLog(`[docs] could not link ${target}: ${result.error}\n`)
      }
    }
    if (linked.length > 0) {
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'coverage-changed', feature: m.feature })
    }
    return linked
  }

  /** Park on the two-path fork. `note` carries a prior attempt's outcome
   *  ("agent found nothing relevant…") so a failed collection re-parks with
   *  the reason in the user's face instead of a silent bounce. */
  const park = (ctx: StageContext, linked: string[], note?: string): StageOutcome => {
    const m = ctx.manifest()
    const docs = userDocs(featureDirFor(deps, m.feature))
    const hasDocs = docs.length > 0
    const base = hasDocs
      ? `${docs.length} requirement doc(s) ready for "${m.feature}"${linked.length > 0 ? ` (${linked.length} linked from your intent)` : ''}. Add more, then continue — or have an agent gather requirements guided by the intent.`
      : `No requirement docs yet for "${m.feature}". Add docs yourself, or have an agent gather them guided by the intent.`
    return {
      kind: 'checkpoint',
      checkpoint: {
        kind: 'prd-source',
        message: note ? `${note} ${base}` : base,
        options: hasDocs
          ? ['continue', 'collect-repo-docs', 'infer-from-diff']
          : ['collect-repo-docs', 'infer-from-diff'],
        data: { docs, linked, intent: m.description },
      },
    }
  }

  /** The agent path of the fork: spawn a collector guided by the intent —
   *  read the repos (collect) or the branch diff vs base (infer) — writing ONE
   *  feature-named requirements doc. Success flows straight into distillation
   *  (same as user-dropped docs); an empty-handed agent re-parks with the
   *  reason. `feedback` is the user's "what went wrong last time" note. */
  const spawnAgent = deps.spawnAgent ?? defaultSpawnAgent
  const collect = async (
    ctx: StageContext,
    mode: 'collect-repo-docs' | 'infer-from-diff',
    feedback?: string,
  ): Promise<StageOutcome> => {
    const m = ctx.manifest()
    const featureDir = featureDirFor(deps, m.feature)
    const docsDir = path.join(featureDir, 'docs')

    let repoTargets = ''
    if (mode === 'infer-from-diff') {
      const targets = m.repoPaths
        .map((repo) => ({ repo, base: detectBaseBranch(repo, m.opts.base) }))
        .filter((t): t is { repo: string; base: string } => t.base !== null && diffVsBase(t.repo, t.base) !== null)
      if (targets.length === 0) {
        ctx.appendLog('[docs] no meaningful diff vs base in any repo — nothing to infer from.\n')
        return park(ctx, [], 'No meaningful diff vs the base branch was found.')
      }
      repoTargets = targets.map((t) => `- ${t.repo} (diff vs ${t.base})`).join('\n')
    }

    const outName = mode === 'collect-repo-docs' ? `${m.feature}-prd.md` : `${m.feature}-from-diff.md`
    const outPath = path.join(docsDir, outName)
    fs.mkdirSync(docsDir, { recursive: true })
    ctx.appendLog(`[docs] ${mode === 'collect-repo-docs' ? 'collecting repo docs' : 'inferring from the git diff'} guided by the intent…\n`)
    // Respond-carried feedback wins; a Continue → from-a-step note targeting
    // this stage is the fallback (the fork re-parks first, so the choice that
    // follows should still carry the note).
    const note = feedback ?? stageFeedback(m, 'docs')
    const feedbackNote = note ? `Feedback on the previous attempt — take it into account: ${note}` : ''
    const { text } = await spawnAgent({
      prompt:
        mode === 'collect-repo-docs'
          ? renderPrompt('flight-collect-docs.md', {
              feature: m.feature,
              description: m.description,
              repoPaths: m.repoPaths.map((p) => `- ${p}`).join('\n'),
              outPath,
              feedbackNote,
            })
          : renderPrompt('flight-infer-diff.md', {
              feature: m.feature,
              description: m.description,
              repoTargets,
              outPath,
              feedbackNote,
            }),
      cwd: m.repoPaths[0],
      stageDir: path.join(ctx.flightDir, 'docs'),
      onChunk: ctx.appendLog,
      signal: ctx.signal,
    })

    const wrote = fs.existsSync(outPath) && fs.statSync(outPath).size > 0
    if (!wrote) {
      const reason = /NOTHING_FOUND:?\s*(.*)/.exec(text)?.[1]?.trim()
      const note = reason
        ? `The agent found nothing relevant: ${reason}.`
        : 'The agent did not produce a requirements doc.'
      ctx.appendLog(`[docs] ${note}\n`)
      return park(ctx, [], note)
    }
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'coverage-changed', feature: m.feature })
    ctx.appendLog(`[docs] wrote docs/${outName}\n`)
    const docs = userDocs(featureDir)
    return {
      kind: 'done',
      evidence: { source: mode === 'collect-repo-docs' ? 'agent-repo-docs' : 'agent-diff', docs },
    }
  }

  return {
    async run(ctx) {
      const m = ctx.manifest()
      const linked = linkIntentDocs(ctx)
      const existing = userDocs(featureDirFor(deps, m.feature))
      if (m.opts.yolo) {
        if (existing.length > 0) {
          return { kind: 'done', evidence: { source: linked.length > 0 ? 'intent-linked' : 'existing', docs: existing } }
        }
        return gather(ctx, 'auto')
      }
      // Requirements always pause (non-yolo): one deliberate moment to add
      // docs, even when some already exist — `continue` releases immediately.
      return park(ctx, linked)
    },
    async onCheckpointResponse(ctx, response) {
      const m = ctx.manifest()
      const existing = userDocs(featureDirFor(deps, m.feature))
      const choice = response.choice ?? ''
      if (choice === 'continue') {
        if (existing.length > 0) {
          return { kind: 'done', evidence: { source: 'user-confirmed', docs: existing } }
        }
        return park(ctx, []) // nothing to continue with — re-park
      }
      if (choice === 'collect-repo-docs' || choice === 'infer-from-diff') {
        return collect(ctx, choice, response.feedback)
      }
      // Legacy choices from older MCP clients degrade to the nearest path.
      if (choice === 'use-repo-docs') return collect(ctx, 'collect-repo-docs', response.feedback)
      if (choice === 'description-only') return gather(ctx, choice)
      return this.run!(ctx)
    },
  }
}
