import { useState } from 'react'
import { useOpenAgentApp } from '@/shared/state/use-open-agent-app'
import * as runsApi from '@/shared/api/runs'
import { displayError } from '@/shared/api/error-message'
import { CopyField } from '@/shared/ui/CopyField'

interface Props {
  runId: string
  signalPaths: { rerun: string; restart: string }
}

export function ManualHealBanner({ runId, signalPaths }: Props) {
  const { opening, error: err, setError: setErr, open: onOpen } = useOpenAgentApp()
  const [cancelling, setCancelling] = useState(false)

  const onCopyFailed = (): void => setErr('Could not copy to clipboard')

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

  return (
    <div
      className="mx-3 mt-3 mb-2 rounded-md p-3 text-xs"
      style={{
        background: 'color-mix(in srgb, var(--warning) 10%, transparent)',
        border: '1px solid color-mix(in srgb, var(--warning) 40%, transparent)',
        color: 'var(--text-primary)',
      }}
    >
      <div className="font-semibold" style={{ color: 'var(--warning)' }}>
        Tests failed — auto-heal is set to <strong>Manual</strong>
      </div>
      <div className="mt-1.5" style={{ color: 'var(--text-secondary)' }}>
        Open Claude or Codex in this project, type <code>self heal</code>, and
        when done write to one of the per-run signal files below.
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => onOpen('claude')}
          disabled={opening !== null}
          className="rounded-md px-2 py-1 text-[10px] uppercase tracking-wider"
          style={{
            color: 'var(--text-primary)',
            border: '1px solid var(--border-default)',
            opacity: opening === 'claude' ? 0.6 : 1,
          }}
        >
          {opening === 'claude' ? 'Opening…' : 'Open Claude'}
        </button>
        <button
          type="button"
          onClick={() => onOpen('codex')}
          disabled={opening !== null}
          className="rounded-md px-2 py-1 text-[10px] uppercase tracking-wider"
          style={{
            color: 'var(--text-primary)',
            border: '1px solid var(--border-default)',
            opacity: opening === 'codex' ? 0.6 : 1,
          }}
        >
          {opening === 'codex' ? 'Opening…' : 'Open Codex'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={cancelling}
          className="rounded-md px-2 py-1 text-[10px] uppercase tracking-wider"
          style={{ color: 'var(--danger)', border: '1px solid color-mix(in srgb, var(--danger) 40%, transparent)' }}
        >
          {cancelling ? 'Cancelling…' : 'Cancel'}
        </button>
      </div>
      <div className="mt-2.5 flex flex-col gap-1">
        <CopyField
          label="Rerun (test/config-only fix)"
          labelPlacement="inline"
          value={signalPaths.rerun}
          onCopyFailed={onCopyFailed}
        />
        <CopyField
          label="Restart (service/app fix)"
          labelPlacement="inline"
          value={signalPaths.restart}
          onCopyFailed={onCopyFailed}
        />
      </div>
      {err && <div className="mt-2 text-[11px]" style={{ color: 'var(--danger)' }}>{err}</div>}
    </div>
  )
}
