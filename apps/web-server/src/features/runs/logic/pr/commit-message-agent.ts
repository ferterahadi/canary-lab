import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { pickAvailableHealAgent, type HealAgent } from '../runtime/auto-heal'
import { COMMIT_MESSAGE_MODELS, modelArgs, modelFor } from '../../../agent-sessions/logic/agent-models'
import { recoverAgentAnswer, agentActivityPath } from '../../../agent-sessions/logic/agent-producer'
import { extractJsonCandidates } from '../../../agent-sessions/logic/agent-json'
import { runAgentProcess, buildClaudeAgenticArgs } from '../../../agent-sessions/logic/agent-process'
import { promptPath, renderPrompt } from '../../../../shared/prompts'
import type { RunSummaryFailedEntry } from '../run-detail'

// Write the commit message and pull-request description for a captured repair,
// by reading the diff.
//
// The templated strings this replaces said the same sentence on every PR
// ("canary-lab heal fixes from run <id>"), which told a reviewer only that a
// machine did it — the one thing the branch name already said. What a reviewer
// needs is the defect: what was broken, what it cost, why this diff corrects it.
// That has to be read out of the patch, so it is an agent's job.
//
// Everything here is best-effort. `writeFixCommitMessage` returns null on any
// failure — no agent installed, a timeout, unparseable output — and the caller
// falls back to the deterministic template. A pull request that opens with a
// dull message beats one that does not open.

export const COMMIT_MESSAGE_TEMPLATE = 'fix-commit-message.md'
export const COMMIT_MESSAGE_SCHEMA_PATH = promptPath('fix-commit-message.schema.json')

// Idle (inactivity) window. Shorter than the repair agent's: this pass reads one
// diff and answers, so a long silence means it is stuck, not thinking.
export const COMMIT_MESSAGE_IDLE_TIMEOUT_MS = 2 * 60 * 1000

/**
 * How much diff the prompt carries. A repair is normally tens of lines, but a
 * dependency bump or a generated file can run to megabytes, and pasting that
 * wholesale would blow the context window and cost far more than the message is
 * worth. Past the cap the agent is told the diff was clipped, so it describes
 * what it can see instead of confidently summarising a file it never read.
 */
export const MAX_DIFF_CHARS = 60_000

export interface FixCommitMessage {
  commitSubject: string
  commitBody: string
  prTitle: string
  prBody: string
}

export interface FixCommitMessageInput {
  feature: string
  repoName: string
  runId: string
  baseSha: string
  patchPath: string
  fileNames?: string[]
  /** Failures from the run that triggered the repair, when the summary still
   *  carries them — a healed run can end green with an empty list. */
  failed?: RunSummaryFailedEntry[]
  /** Working directory for the spawn. The repo itself, so a read-only agent can
   *  open the files the diff names for context it cannot get from the hunks. */
  cwd?: string
  signal?: AbortSignal
}

/** The message for one repo's captured fix, or null if no agent could write
 *  one. Never throws: every failure path is a fallback, not an error. */
export async function writeFixCommitMessage(input: FixCommitMessageInput): Promise<FixCommitMessage | null> {
  const agent = pickAvailableHealAgent()
  if (agent !== 'claude' && agent !== 'codex') return null

  let diff: string
  try {
    diff = fs.readFileSync(input.patchPath, 'utf-8')
  } catch {
    return null
  }
  if (!diff.trim()) return null

  const prompt = renderPrompt(COMMIT_MESSAGE_TEMPLATE, {
    feature: input.feature,
    repoName: input.repoName,
    runId: input.runId,
    baseSha: input.baseSha ? input.baseSha.slice(0, 12) : 'unknown',
    fileCount: String(input.fileNames?.length ?? 0),
    fileList: bulletList(input.fileNames ?? []),
    failureEvidence: failureEvidenceSection(input.failed ?? []),
    diff: clipDiff(diff),
  })

  try {
    const output = await runCommitMessageAgent(agent, prompt, input.cwd, input.signal)
    return parseFixCommitMessage(output)
  } catch {
    return null
  }
}

export function bulletList(names: string[]): string {
  return names.length ? names.map((n) => `  - \`${n}\``).join('\n') : '  - (not recorded)'
}

/** The failing tests as prose, heading included — the whole section drops out
 *  when a healed run's summary no longer lists any, rather than leaving an
 *  empty heading for the agent to invent content under. */
export function failureEvidenceSection(failed: RunSummaryFailedEntry[]): string {
  if (failed.length === 0) return ''
  const lines = failed.slice(0, 10).map((f) => {
    const where = f.location ? ` (${f.location})` : ''
    const why = f.error?.message ? `\n  ${firstLines(f.error.message, 4)}` : ''
    return `- \`${f.name}\`${where}${why}`
  })
  return `## Failing test evidence\n\nThese are the tests that were failing before the repair:\n\n${lines.join('\n')}\n`
}

function firstLines(text: string, n: number): string {
  return text.split('\n').slice(0, n).join('\n  ').trim()
}

export function clipDiff(diff: string): string {
  if (diff.length <= MAX_DIFF_CHARS) return diff
  return `${diff.slice(0, MAX_DIFF_CHARS)}\n\n[... diff clipped at ${MAX_DIFF_CHARS} characters — describe only the changes shown above ...]`
}

/** First candidate carrying a `commitSubject` string — the envelope's anchor, so
 *  brace-bearing prose around the answer cannot shadow it. Every field must be a
 *  non-empty string: a half-filled object would put an empty title on a real
 *  pull request, which is worse than the template it replaced. */
export function parseFixCommitMessage(output: string): FixCommitMessage | null {
  for (const candidate of extractJsonCandidates(output)) {
    if (!candidate || typeof candidate !== 'object') continue
    const c = candidate as Partial<FixCommitMessage>
    if (!isFilled(c.commitSubject)) continue
    if (!isFilled(c.commitBody) || !isFilled(c.prTitle) || !isFilled(c.prBody)) continue
    return {
      commitSubject: c.commitSubject.trim(),
      commitBody: c.commitBody.trim(),
      prTitle: c.prTitle.trim(),
      prBody: c.prBody.trim(),
    }
  }
  return null
}

function isFilled(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

/** Spawn via the shared runner — same argv builder, idle clock and answer
 *  recovery as every other non-interactive agent here. Read-only on both arms:
 *  this pass describes a diff, and one that could edit the repo it is
 *  describing would be able to make its own description true. */
export function runCommitMessageAgent(
  agent: HealAgent,
  prompt: string,
  cwd?: string,
  signal?: AbortSignal,
): Promise<string> {
  const outputDir = agent === 'codex' ? fs.mkdtempSync(path.join(os.tmpdir(), 'canary-commit-msg-')) : undefined
  const outputPath = outputDir ? path.join(outputDir, 'last-message.txt') : undefined
  const claudeSessionId = agent === 'claude' ? crypto.randomUUID() : undefined
  const args = agent === 'claude'
    ? buildClaudeAgenticArgs(prompt, { model: COMMIT_MESSAGE_MODELS.claude, sessionId: claudeSessionId, readOnly: true })
    : [
        'exec',
        '--skip-git-repo-check',
        '--sandbox', 'read-only',
        ...modelArgs(modelFor(COMMIT_MESSAGE_MODELS, 'codex')),
        ...(outputPath ? ['--output-last-message', outputPath] : []),
        '--output-schema', COMMIT_MESSAGE_SCHEMA_PATH,
        '-',
      ]

  let idled = false
  const handle = runAgentProcess({
    command: agent,
    args,
    ...(cwd ? { cwd } : {}),
    ...(agent === 'codex' ? { stdin: prompt } : {}),
    idleMs: COMMIT_MESSAGE_IDLE_TIMEOUT_MS,
    ...(agentActivityPath(agent, cwd, claudeSessionId) ? { activityPath: agentActivityPath(agent, cwd, claudeSessionId)! } : {}),
    onIdle: () => { idled = true },
  })

  return new Promise<string>((resolve, reject) => {
    let settled = false
    const rmOutputDir = (): void => { if (outputDir) fs.rmSync(outputDir, { recursive: true, force: true }) }
    const settleErr = (err: Error): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      rmOutputDir()
      reject(err)
    }
    const settleOk = (output: string): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      rmOutputDir()
      resolve(output)
    }
    function onAbort(): void { handle.stop(); settleErr(new Error('commit message generation cancelled')) }
    if (signal?.aborted) { onAbort(); return }
    signal?.addEventListener('abort', onAbort, { once: true })

    handle.done.then(
      ({ code, signal: sig, stdout, stderr }) => {
        if (idled) { settleErr(new Error(`commit message agent idle for ${COMMIT_MESSAGE_IDLE_TIMEOUT_MS}ms`)); return }
        if (code !== 0) {
          settleErr(new Error(`commit message agent failed with ${sig ?? `exit code ${code}`}${stderr ? `\n${stderr}` : ''}`))
          return
        }
        // Read codex's output file BEFORE settleOk() removes the temp dir.
        let finalOutput = recoverAgentAnswer(agent, stdout)
        if (outputPath && fs.existsSync(outputPath)) {
          const fromFile = fs.readFileSync(outputPath, 'utf-8')
          if (fromFile.trim()) finalOutput = fromFile
        }
        settleOk(finalOutput)
      },
      (err: Error) => settleErr(new Error(`commit message agent failed: ${err.message}`)),
    )
  })
}
