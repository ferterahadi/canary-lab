import { useState } from 'react'
import type { LocalHealAgent } from '@shared/run-manifest'
import type { RunSummary } from '@shared/run-detail'
import { firstLineOf } from '@/shared/lib/format'
import { useOpenAgentApp } from '@/shared/state/use-open-agent-app'
import * as runsApi from '@/shared/api/runs'
import { displayError } from '@/shared/api/error-message'
import { useClipboardCopy } from '@/shared/state/use-clipboard-copy'
import { CheckIcon, CopyIcon } from '@/shared/ui/Icons'
import manualRepairTemplate from '../../../../../web-server/prompts/manual-repair-handoff.md?raw'

interface Props {
  primaryAgent?: LocalHealAgent | null
  summary?: RunSummary
  cycle?: number
  runId: string
  signalPaths: { rerun: string; restart: string }
}

export function ManualHealBanner({ runId, signalPaths, cycle, summary, primaryAgent = 'claude' }: Props) {
  const { opening, error: err, setError: setErr, open: onOpen } = useOpenAgentApp()
  const [cancelling, setCancelling] = useState(false)

  const { copy, copiedKey } = useClipboardCopy()
  const prompt = [
    `Self heal Canary Lab run ${runId} in this project.`,
    manualRepairTemplate.trim(),
    `Restart: ${signalPaths.restart}\nRerun: ${signalPaths.rerun}`,
  ].join('\n\n')
  const copyPrompt = async (): Promise<void> => {
    if (!await copy(prompt)) setErr('Could not copy to clipboard')
    else if (err === 'Could not copy to clipboard') setErr(null)
  }

  const onCancel = async (): Promise<void> => {
    setCancelling(true)
    setErr(null)
    try {
      await runsApi.cancelHealRun(runId)
    } catch (e: unknown) {
      setErr(displayError(e, 'Cancel failed'))
    } finally {
      setCancelling(false)
    }
  }

  const failures = summary?.failed
  const singleFailure = failures?.length === 1 ? failures[0] : undefined

  return (
    <section className="cl-manual-heal cl-card" aria-label="Manual repair">
      <div className="cl-heal-handoff">
        <div className="cl-heal-meta">
          <h3>Manual repair</h3>
          {cycle !== undefined && cycle > 0 && <span>Cycle {cycle}</span>}
        </div>
        {failures && failures.length > 0 && (
          <div className="cl-heal-failure">
            <span>{singleFailure ? 'Failed test' : `${failures.length} failed tests`}</span>
            {singleFailure && <div>
              <strong>{singleFailure.name}</strong>
              {singleFailure.error?.message && <p>{firstLineOf(singleFailure.error.message)}</p>}
            </div>}
          </div>
        )}
        <h4>1. Start the repair</h4>
        <p>Open this project in Claude or Codex.</p>
        <div className="cl-heal-actions">
          {(['claude', 'codex'] as const).map((agent) => (
            <button
              key={agent}
              type="button"
              className={agent === primaryAgent ? 'cl-button-primary' : 'cl-button'}
              disabled={opening !== null}
              onClick={() => onOpen(agent)}
            >
              {opening === agent ? 'Opening…' : agent === 'claude' ? 'Open Claude' : 'Open Codex'}
            </button>
          ))}
          <button
            type="button"
            className="cl-button cl-heal-cancel"
            disabled={cancelling}
            onClick={onCancel}
          >
            {cancelling ? 'Cancelling…' : 'Cancel'}
          </button>
        </div>
      </div>
      <div className="cl-heal-signals">
        <h4>2. Paste the prompt into your chat</h4>
        <div className="cl-heal-prompt-block">
          <textarea className="cl-heal-prompt" aria-label="Repair prompt" readOnly value={prompt} />
          <button
            type="button"
            className="cl-icon-button cl-heal-prompt-copy"
            data-copied={copiedKey === prompt}
            title={copiedKey === prompt ? 'Copied' : 'Copy prompt'}
            onClick={copyPrompt}
          >
            {copiedKey === prompt ? <CheckIcon size={14} /> : <CopyIcon />}
            <span className="sr-only" aria-live="polite">{copiedKey === prompt ? 'Copied' : 'Copy prompt'}</span>
          </button>
        </div>
      </div>
      {err && <p className="cl-heal-error" role="alert">{err}</p>}
    </section>
  )
}
