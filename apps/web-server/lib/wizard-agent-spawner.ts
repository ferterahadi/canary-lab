import fs from 'fs'
import path from 'path'
import type { PaneBroker } from './pane-broker'

// Pure helpers for the Add Test wizard's plan / spec agents:
//
//   - Template loading + `{{placeholder}}` substitution
//   - Repo / skill / plan formatters that turn structured input into the
//     plain-text the prompt template embeds
//   - The tee-to-disk reducer that fans pty output into a log file + an
//     optional PaneBroker
//   - Shell quoting + claude argv construction for `claude -p <prompt>`
//
// All side effects are scoped to fs + an optional PaneBroker. The pty driver
// itself lives in `wizard-agent-runner.ts` (excluded from coverage) and
// composes these helpers.

export const PROMPTS_DIR = path.resolve(__dirname, '..', 'prompts')

export const STAGE1_TEMPLATE = path.join(PROMPTS_DIR, 'stage1-plan.md')
export const STAGE2_TEMPLATE = path.join(PROMPTS_DIR, 'stage2-spec.md')
export const REFINE_TEMPLATE = path.join(PROMPTS_DIR, 'stage3-refine.md')

export function loadTemplate(file: string): string {
  return fs.readFileSync(file, 'utf8')
}

// Substitute `{{name}}` placeholders. Unknown placeholders are left as-is
// (the agent will see them as `{{whatever}}` in the prompt — harmless).
export function substitute(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match
  })
}

export interface RepoSummary {
  name: string
  localPath: string
}

export function formatRepos(repos: RepoSummary[]): string {
  if (repos.length === 0) return '(none)'
  return repos.map((r) => `- ${r.name} (${r.localPath})`).join('\n')
}

export function formatPlan(plan: unknown): string {
  return JSON.stringify(plan, null, 2)
}

export function formatSkills(
  skills: { id: string; content: string }[],
): string {
  if (skills.length === 0) return '(no skills selected)'
  return skills
    .map((s) => `--- skill: ${s.id} ---\n${s.content.trim()}\n--- end skill ---`)
    .join('\n\n')
}

export function buildPlanPrompt(input: {
  prdText: string
  repos: RepoSummary[]
  template?: string
}): string {
  const template = input.template ?? loadTemplate(STAGE1_TEMPLATE)
  return substitute(template, {
    prdText: input.prdText,
    repos: formatRepos(input.repos),
  })
}

export function buildSpecPrompt(input: {
  plan: unknown
  skills: { id: string; content: string }[]
  repos: RepoSummary[]
  template?: string
}): string {
  const template = input.template ?? loadTemplate(STAGE2_TEMPLATE)
  return substitute(template, {
    plan: formatPlan(input.plan),
    skills: formatSkills(input.skills),
    repos: formatRepos(input.repos),
  })
}

export function buildRefinePrompt(input: {
  prdText: string
  plan: unknown
  repos: RepoSummary[]
  filePath: string
  fileContent: string
  selectedText: string
  suggestion: string
  template?: string
}): string {
  const template = input.template ?? loadTemplate(REFINE_TEMPLATE)
  return substitute(template, {
    prdText: input.prdText,
    plan: formatPlan(input.plan),
    repos: formatRepos(input.repos),
    filePath: input.filePath,
    fileContent: input.fileContent,
    selectedText: input.selectedText,
    suggestion: input.suggestion,
  })
}

// Tee reducer: every chunk produced by the pty is appended to `logPath` and
// optionally pushed to a PaneBroker keyed by `paneId`. Returned object exposes
// the accumulated stream so the route layer can parse it once the agent exits.
//
// Kept synchronous (`appendFileSync`) because pty chunks are small and the
// alternative — async writes — opens up out-of-order writes and lost output
// if the process exits before the queue drains.
export interface TeeSink {
  push(chunk: string): void
  fullStream(): string
}

export function createTeeSink(opts: {
  logPath: string
  broker?: PaneBroker | null
  paneId?: string
}): TeeSink {
  // Ensure the log directory exists & file is truncated for this run.
  fs.mkdirSync(path.dirname(opts.logPath), { recursive: true })
  fs.writeFileSync(opts.logPath, '', 'utf8')
  let acc = ''
  return {
    push(chunk: string): void {
      acc += chunk
      try {
        fs.appendFileSync(opts.logPath, chunk, 'utf8')
      } catch {
        // The agent log is best-effort — losing a chunk to disk should not
        // fail the run. The accumulated `acc` is the source of truth for
        // downstream parsers.
      }
      if (opts.broker && opts.paneId) {
        opts.broker.push(opts.paneId, chunk)
      }
    },
    fullStream(): string {
      return acc
    },
  }
}

// Build the argv used to invoke `claude -p`. `claude` takes the prompt as a
// positional argument; `-p` enables print-and-exit mode. Verified against
// `claude --help` (Anthropic CLI). We intentionally do not use any other
// flags — keeps the spawn deterministic and easy to mock.
export function buildClaudeArgs(prompt: string): string[] {
  return ['-p', prompt]
}

// Shell-escape a single argument for /bin/bash. The pty wrapper invokes
// `bash -c <cmd>`, so we need the full command as a string.
export function shellQuote(arg: string): string {
  // Wrap in single quotes; escape any embedded single quotes by closing,
  // inserting an escaped quote, and reopening. Standard POSIX trick.
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

export function buildClaudeCommand(prompt: string, claudeBin = 'claude'): string {
  return `${claudeBin} ${buildClaudeArgs(prompt).map(shellQuote).join(' ')}`
}

export function buildCodexArgs(prompt: string): string[] {
  return ['exec', '--skip-git-repo-check', '--full-auto', prompt]
}

export function buildCodexCommand(prompt: string, codexBin = 'codex'): string {
  return `${codexBin} ${buildCodexArgs(prompt).map(shellQuote).join(' ')}`
}

export function buildWizardCommand(
  agent: 'claude' | 'codex',
  prompt: string,
  bins: { claudeBin?: string; codexBin?: string } = {},
): string {
  return agent === 'claude'
    ? buildClaudeCommand(prompt, bins.claudeBin)
    : buildCodexCommand(prompt, bins.codexBin)
}

export function paneIdForDraft(draftId: string): string {
  return `draft:${draftId}`
}
