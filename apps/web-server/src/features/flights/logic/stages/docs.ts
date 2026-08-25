import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { linkFeatureDoc, writeFeatureDoc } from '../../../config/logic/feature-authoring'
import { publishWorkspaceEvent } from '../../../../shared/workspace-events'
import { renderPrompt } from '../../../../shared/prompts'
import { detectBaseBranch } from '../../../../shared/git-repo'
import type { PrdSourceAttempt } from '../types'
import type { StageAdapter, StageContext, StageOutcome } from '../conductor'
import { defaultSpawnAgent, featureDirFor, stageFeedback, type FlightStageDeps, stageJobRef } from './context'
import { agentSpawnJob } from './stage-jobs'
import { externalWorkCheckpoint, handsOffToClient, parkedOnExternalWork, rejectStaleSubmit } from './externalizable'
import { agentProgressSink } from './agent-progress'
import { CHECKPOINT_OPTIONS } from '../types'

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
// Non-yolo flights ALWAYS EMIT the checkpoint — even when docs exist — so the
// fork is never silently skipped. Whether a HUMAN sees it is autopilot's call,
// not this stage's: autopilot (on by default) answers `continue` when docs
// exist and `collect-repo-docs` when they don't. So the park reaches a person
// when autopilot is off, or on a re-park — including the re-park a collector
// that came back empty produces. See AUTOPILOT_CHOICE in ../flight-drive.ts.

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

const MODE_LABEL = {
  'collect-repo-docs': 'collect repo docs',
  'infer-from-diff': 'infer from diff',
} as const

/** Prose form of an attempt, for `message` (CLI/MCP + older clients). The
 *  agent's reason is already a sentence, so it's emitted verbatim rather
 *  than wrapped in punctuation we'd have to guess at — the previous version
 *  appended a period and produced "…in either repo..".
 *
 *  Module-scoped and exported because `reason` is optional on the persisted
 *  shape: a record written by an older build can carry `empty` with no reason,
 *  which today's collector never produces, so the fallback is only reachable
 *  (and only assertable) from here. */
export function describeAttempt(attempt: PrdSourceAttempt): string {
  if (attempt.outcome === 'no-diff') return 'No meaningful diff vs the base branch was found.'
  if (attempt.outcome === 'no-output') return 'The agent did not produce a requirements doc.'
  const reason = attempt.reason?.trim() ?? ''
  if (!reason) return 'The agent searched and found nothing relevant.'
  return `The agent found nothing relevant: ${/[.!?]$/.test(reason) ? reason : `${reason}.`}`
}

/** Log form of a rejected attempt — deliberately NOT `describeAttempt`.
 *  The activity band is append-only, so a rejected attempt sits above
 *  whatever ran next with nothing marking it as finished business: three
 *  bare "found nothing relevant" lines above a healthy distillation read as
 *  a live failure. So each line names its attempt, states the verdict as
 *  terminal, and says what the flight did about it (re-parked) plus the two
 *  ways out — answering "what happens next?" in the line itself. */
export function attemptLogLine(attempt: PrdSourceAttempt): string {
  const why =
    attempt.outcome === 'no-diff'
      ? 'no meaningful diff vs the base branch in any repo'
      : attempt.outcome === 'no-output'
        ? 'the agent produced no requirements doc'
        : attempt.reason?.trim() || 'the agent searched and found nothing relevant'
  return `[docs] agent attempt (${MODE_LABEL[attempt.mode]}) came back empty — ${why.replace(/[.\s]+$/, '')}. Back to your choice: add docs yourself, or retry with feedback.\n`
}

function diffVsBase(repo: string, base: string): string | null {
  const current = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!current || current === base) return null
  const diff = git(repo, ['diff', `${base}...HEAD`, '--stat', '-p'])
  if (!diff || diff.length < 40) return null
  return diff.length > MAX_DIFF_BYTES ? diff.slice(0, MAX_DIFF_BYTES) + '\n…(truncated)' : diff
}

export function docsStage(deps: FlightStageDeps): StageAdapter {
  // Carries the bus: the doc writers announce their own writes, so the stage
  // does not chase them with a publish (see FeatureAuthoringContext).
  const ctxAuthoring = {
    projectRoot: deps.projectRoot,
    featuresDir: deps.featuresDir,
    workspaceEvents: deps.workspaceEvents,
  }

  const write = (feature: string, relPath: string, content: string): string | null => {
    const result = writeFeatureDoc(ctxAuthoring, { feature, relPath, content })
    return result.ok ? null : result.error
  }

  // Only ever called with `auto` (the yolo path) or `description-only` (the
  // checkpoint choice). The legacy `use-repo-docs` source is gone — that choice
  // now degrades to the collect-repo-docs AGENT path, see onCheckpointResponse.
  const gather = (ctx: StageContext, source: 'auto' | 'description-only'): StageOutcome => {
    const m = ctx.manifest()
    const featureDir = featureDirFor(deps, m.feature)
    const written: string[] = []
    let resolved: string = source

    if (source === 'auto') {
      for (const { repo, file } of findRepoDocs(m.repoPaths)) {
        const rel = `${path.basename(repo)}-${path.basename(file)}`.toLowerCase()
        const err = write(m.feature, rel, fs.readFileSync(file, 'utf-8'))
        if (!err) written.push(rel)
      }
      if (written.length > 0) resolved = 'repo-docs'
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
      if (written.length > 0) resolved = 'diff-vs-base'
    }

    if (written.length === 0) {
      const err = write(m.feature, 'description.md', `# ${m.feature}\n\n${m.description}\n`)
      if (err) return { kind: 'failed', error: err }
      written.push('description.md')
      resolved = 'description-only'
    }

    ctx.appendLog(`[docs] ${written.length} doc(s) from ${resolved}\n`)
    const docs = userDocs(featureDir)
    if (docs.length === 0) return { kind: 'failed', error: 'no docs landed in features/<f>/docs/' }
    return { kind: 'done', evidence: { source: resolved, docs } }
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
    return linked
  }


  /** Park on the two-path fork. `attempt` carries a prior collector run's
   *  outcome so a failed collection re-parks with the reason in the user's
   *  face instead of a silent bounce.
   *
   *  The outcome rides on `data.lastAttempt`, NOT concatenated into `message`:
   *  a UI can only give the verdict its own treatment — and flip its
   *  recommendation away from the path that just failed — if it can tell an
   *  empty-handed retry from a first visit. `message` still carries the prose
   *  form for the CLI/MCP surfaces and older clients. */
  const park = (ctx: StageContext, linked: string[], attempt?: PrdSourceAttempt): StageOutcome => {
    const m = ctx.manifest()
    const docs = userDocs(featureDirFor(deps, m.feature))
    const hasDocs = docs.length > 0
    const base = hasDocs
      ? `${docs.length} requirement doc(s) ready for "${m.feature}"${linked.length > 0 ? ` (${linked.length} linked from your intent)` : ''}. Add more, then continue — or have an agent gather requirements guided by the intent.`
      : `No requirement docs yet for "${m.feature}". Add docs yourself, or have an agent gather them guided by the intent.`
    const note = attempt ? describeAttempt(attempt) : ''
    return {
      kind: 'checkpoint',
      checkpoint: {
        kind: 'prd-source',
        message: note ? `${note} ${base}` : base,
        // The one checkpoint that offers a SUBSET of its kind's vocabulary:
        // with no docs present there is nothing for `continue` to continue
        // with, so the option is withheld rather than shown and then rejected.
        options: [...CHECKPOINT_OPTIONS['prd-source']].filter((o) => hasDocs || o !== 'continue'),
        data: { docs, linked, intent: m.description, lastAttempt: attempt },
      },
    }
  }

  /** Settle a collector attempt from what landed ON DISK. Shared verbatim by the
   *  local-agent path and the external hand-off, and that sharing is the point:
   *  the verdict is "did the doc get written", checked by Canary, not "did the
   *  producer say it worked". An external client writes {{outPath}} with its own
   *  file tools exactly as the local agent does, so there is nothing to trust
   *  differently. `reply` is the producer's final message, mined for the
   *  NOTHING_FOUND reason when no file appeared. */
  const settleCollected = (
    ctx: StageContext,
    mode: 'collect-repo-docs' | 'infer-from-diff',
    plan: { outName: string; outPath: string },
    reply: string,
  ): StageOutcome => {
    const m = ctx.manifest()
    const wrote = fs.existsSync(plan.outPath) && fs.statSync(plan.outPath).size > 0
    if (!wrote) {
      const reason = /NOTHING_FOUND:?\s*(.*)/.exec(reply)?.[1]?.trim()
      const attempt: PrdSourceAttempt = reason
        ? { mode, outcome: 'empty', reason }
        : { mode, outcome: 'no-output' }
      ctx.appendLog(attemptLogLine(attempt))
      return park(ctx, [], attempt)
    }
    // Written by the producer's own file tools rather than through
    // writeFeatureDoc, so this one still announces by hand — there is no writer
    // between the agent and the disk to carry it.
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'coverage-changed', feature: m.feature })
    // Symmetric with attemptLogLine: the accepted attempt says so, so the band
    // reads as a sequence of verdicts rather than undifferentiated noise.
    ctx.appendLog(`[docs] agent attempt (${MODE_LABEL[mode]}) succeeded — wrote docs/${plan.outName}\n`)
    return {
      kind: 'done',
      evidence: {
        source: mode === 'collect-repo-docs' ? 'agent-repo-docs' : 'agent-diff',
        docs: userDocs(featureDirFor(deps, m.feature)),
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
    forceInternal?: boolean,
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
        const attempt: PrdSourceAttempt = { mode, outcome: 'no-diff' }
        ctx.appendLog(attemptLogLine(attempt))
        return park(ctx, [], attempt)
      }
      repoTargets = targets.map((t) => `- ${t.repo} (diff vs ${t.base})`).join('\n')
    }

    const outName = mode === 'collect-repo-docs' ? `${m.feature}-prd.md` : `${m.feature}-from-diff.md`
    const outPath = path.join(docsDir, outName)
    fs.mkdirSync(docsDir, { recursive: true })
    // Respond-carried feedback wins; a Continue → from-a-step note targeting
    // this stage is the fallback (the fork re-parks first, so the choice that
    // follows should still carry the note).
    const note = feedback ?? stageFeedback(m, 'docs')
    const feedbackNote = note ? `Feedback on the previous attempt — take it into account: ${note}` : ''
    const prompt =
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
          })
    const plan = { outName, outPath }

    // Hand off unless the caller forced the local path (the client answered
    // `run-internally`). The client gets the SAME rendered prompt — including its
    // fan-out rule and its NOTHING_FOUND contract — and writes the same outPath,
    // so `settleCollected` judges both producers identically.
    if (forceInternal !== true && handsOffToClient(ctx)) {
      ctx.appendLog(`[docs] handed the ${MODE_LABEL[mode]} step to the external client…\n`)
      return externalWorkCheckpoint(ctx, 'docs', prompt, {
        message: `Ask your user first: if they have a PRD/spec to supply, write THAT to ${outPath} instead of gathering — never invent one. Otherwise gather requirement docs (${MODE_LABEL[mode]}) in your own client and write the doc to the same path, then respond. Reply NOTHING_FOUND on \`data\` if there is nothing relevant.`,
        context: { mode, outPath, outName, intent: m.description },
      })
    }

    // Trailing "…" is load-bearing: StageActivity splits the band after the
    // last tagged line ending in an ellipsis when no agent chunks mirrored in.
    ctx.appendLog(`[docs] agent attempt (${MODE_LABEL[mode]}) — ${mode === 'collect-repo-docs' ? 'reading the repos' : 'reading the git diff'} guided by the intent…\n`)
    const { text } = await spawnAgent({
      prompt,
      // The collector reads product repos but writes the requirements artifact
      // under this Canary workspace's features/. Launching inside the first
      // product repo makes that sibling output path read-only for sandboxed
      // agents such as Codex.
      cwd: deps.projectRoot,
      stageDir: path.join(ctx.flightDir, 'docs'),
      job: stageJobRef(deps, m, 'docs'),
      onChunk: agentProgressSink(ctx),
      signal: ctx.signal,
      agent: m.opts.agent,
    })
    return settleCollected(ctx, mode, plan, text)
  }

  return {
    // The collector agent, when one is live (this stage also parks on prd-source
    // and on an external hand-off, where it owns no local spawn — the scope lookup
    // no-ops for both).
    teardown: (ctx) => agentSpawnJob(ctx, 'docs'),
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
      // Releasing the external hand-off, NOT the human prd-source fork. Read the
      // mode back off the checkpoint rather than re-deriving it: the client may
      // have taken minutes, and the fork's own state has moved on.
      if (parkedOnExternalWork(ctx, 'docs')) {
        // Under `data.context`, which is where externalWorkCheckpoint puts a
        // stage's own payload (`data` itself holds the transport fields —
        // stage, prompt, handOffId, promptPath). Reading it one level too high
        // made outPath ALWAYS undefined, so every external docs submit fell
        // into the no-output-path branch below and settled the stage `failed`
        // — the "Docs extraction failed" pause. The other four hand-off stages
        // all read `.context`; this was the odd one out, and its unit test hid
        // it by hand-building a flat fixture the parker never writes.
        const handOff = (m.stages.find((s) => s.key === 'docs')?.checkpoint?.data as
          | { context?: { mode?: 'collect-repo-docs' | 'infer-from-diff'; outPath?: string; outName?: string } }
          | undefined)?.context
        const mode = handOff?.mode ?? 'collect-repo-docs'
        if (choice === 'run-internally') {
          ctx.appendLog('[docs] client handed the step back — collecting here\n')
          return collect(ctx, mode, response.feedback, true)
        }
        const stale = rejectStaleSubmit(ctx, 'docs', response)
        if (stale) return stale
        // A hand-off with no output path cannot be judged — there is no file to
        // look for. Settling `failed` here broke the rule that an external
        // submission always RE-PARKS: `checkpointResponse` persists, so a
        // resume replays this same answer, fails identically, and only a full
        // redo clears it. Re-asking is both the recovery and the correct
        // verdict — `collect` mints a fresh hand-off with a valid outPath.
        if (!handOff?.outPath || !handOff.outName) {
          ctx.appendLog('[docs] hand-off lost its output path — re-asking with a fresh one\n')
          return collect(ctx, mode)
        }
        // Same on-disk check the local agent's result goes through. `data` is only
        // mined for a NOTHING_FOUND reason — it never decides the verdict.
        const reply = typeof response.data === 'string' ? response.data : JSON.stringify(response.data ?? '')
        return settleCollected(ctx, mode, { outName: handOff.outName, outPath: handOff.outPath }, reply)
      }
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
    // R78 restart wipe: the ENTIRE docs dir goes — hand-added files, symlinks
    // pointing at the user's own PRD (links only, never their targets), agent-
    // collected docs, and the generated `_` artifacts. Explicit user ruling:
    // re-adding inputs on every retry IS the purpose of restart.
    async reset(ctx) {
      const m = ctx.manifest()
      const docsDir = path.join(featureDirFor(deps, m.feature), 'docs')
      if (!fs.existsSync(docsDir)) return
      fs.rmSync(docsDir, { recursive: true, force: true })
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'coverage-changed', feature: m.feature })
    },
  }
}
