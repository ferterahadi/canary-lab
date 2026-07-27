import * as api from '@/shared/api/client'
import { parsePort } from './settings-options'

// The restart moves through three honest phases the UI can narrate: the old
// server releasing the port, the new server binding it, and the reconnect.
export type RestartPhase = 'stopping' | 'waiting' | 'reconnecting'

// How many times we probe the new origin before giving up and navigating
// anyway. Shared with the progress UI so "probe N of M" stays truthful.
export const RESTART_MAX_PROBES = 40

// After this many probes the new server is taking unusually long; the UI
// switches to a "still starting" hint and surfaces a manual escape hatch.
export const RESTART_SLOW_AFTER = 8

// Poll the new origin until it answers, then navigate the tab to it. The old
// server shuts down ~moments after the port change, and the new one needs a
// beat to bind, so an immediate redirect could hit a dead port. `onProgress`
// lets the caller narrate which phase we're in (and how many probes deep).
export function defaultRedirect(
  newOrigin: string,
  onProgress?: (phase: RestartPhase, attempt: number) => void,
): void {
  let tries = 0
  const poll = (): void => {
    tries += 1
    onProgress?.('waiting', tries)
    fetch(`${newOrigin}/api/project-config`)
      .then((r) => {
        if (r.ok) { onProgress?.('reconnecting', tries); window.location.href = newOrigin; return }
        throw new Error('not ready')
      })
      .catch(() => {
        if (tries < RESTART_MAX_PROBES) setTimeout(poll, 500)
        else { onProgress?.('reconnecting', tries); window.location.href = newOrigin }
      })
  }
  // Hold on "stopping" for a beat before the first probe: it gives the dying
  // process time to release the socket (so probe #1 isn't wasted on it) and
  // makes the stopping step visible rather than flashing past.
  onProgress?.('stopping', 0)
  setTimeout(poll, 450)
}

// Narrate the restart as it happens instead of a single static line. The header
// shows the actual port hop (old → new), each step fills in as we pass it, and
// the active step carries a live, bounded readout ("probe 6 of 40") so the user
// can tell forward progress from a hang. If the new server is slow to bind we
// switch to a reassuring hint and surface a manual link to the new origin.
export function RestartProgress({
  phase,
  attempt,
  fromPort,
  origin,
}: {
  phase: RestartPhase
  attempt: number
  fromPort: number
  origin: string
}) {
  const toPort = parsePort(origin)
  const slow = phase === 'waiting' && attempt >= RESTART_SLOW_AFTER
  const steps: { key: RestartPhase; label: string; detail: string }[] = [
    {
      key: 'stopping',
      label: 'Stopping the current server',
      detail: `Releasing port ${fromPort} from the old process`,
    },
    {
      key: 'waiting',
      label: toPort != null ? `Binding port ${toPort}` : 'Binding the new port',
      detail: slow
        ? `Probe ${attempt} of ${RESTART_MAX_PROBES} — still booting`
        : `Probe ${attempt} of ${RESTART_MAX_PROBES} — waiting for the server to answer`,
    },
    {
      key: 'reconnecting',
      label: 'Reconnecting',
      detail: `Reopening ${origin}`,
    },
  ]
  const currentIdx = steps.findIndex((s) => s.key === phase)

  return (
    <div
      role="status"
      aria-live="polite"
      className="mt-3 overflow-hidden rounded-lg"
      style={{
        border: '1px solid color-mix(in srgb, var(--accent) 32%, var(--border-default))',
        background: 'color-mix(in srgb, var(--accent) 6%, var(--bg-elevated))',
        animation: 'fm-fade-up 220ms ease',
      }}
    >
      {/* Header: live dot + title on the left, the port hop on the right. */}
      <div className="flex items-center justify-between gap-3 px-3 pt-3 pb-2.5">
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="canary-pulse inline-block rounded-full"
            style={{ width: 7, height: 7, background: 'var(--accent)' }}
          />
          <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
            Restarting Canary Lab
          </span>
        </div>
        <div
          className="flex items-center gap-1.5 rounded-full px-2 py-0.5"
          style={{ background: 'color-mix(in srgb, var(--accent) 10%, transparent)', fontFamily: 'var(--font-mono)', fontSize: 10.5 }}
        >
          <span style={{ color: 'var(--text-muted)', textDecoration: 'line-through', textDecorationColor: 'color-mix(in srgb, var(--text-muted) 60%, transparent)' }}>:{fromPort}</span>
          <span aria-hidden="true" style={{ color: 'var(--text-muted)' }}>→</span>
          <span style={{ color: 'var(--accent)', fontWeight: 600 }}>:{toPort ?? '—'}</span>
        </div>
      </div>

      {/* Stepper with a rail that fills as steps complete. */}
      <ol className="flex flex-col px-3">
        {steps.map((s, i) => {
          const state = i < currentIdx ? 'done' : i === currentIdx ? 'active' : 'pending'
          const isLast = i === steps.length - 1
          const labelColor =
            state === 'active' ? 'var(--text-primary)'
            : state === 'done' ? 'var(--text-secondary)'
            : 'var(--text-muted)'
          return (
            <li key={s.key} className="flex gap-2.5">
              <div className="flex flex-col items-center" style={{ width: 14, flex: 'none' }}>
                <span className="flex items-center justify-center" style={{ marginTop: 1 }}>
                  <RestartStepGlyph state={state} />
                </span>
                {!isLast && (
                  <span
                    aria-hidden="true"
                    style={{
                      width: 1.5,
                      flex: 1,
                      minHeight: 12,
                      marginTop: 3,
                      marginBottom: 1,
                      borderRadius: 1,
                      background: i < currentIdx ? 'var(--accent)' : 'var(--border-default)',
                    }}
                  />
                )}
              </div>
              <div className="min-w-0" style={{ paddingBottom: isLast ? 0 : 12 }}>
                <div
                  className="text-xs leading-tight"
                  style={{ color: labelColor, fontWeight: state === 'active' ? 600 : 500 }}
                >
                  {s.label}
                </div>
                {state === 'active' && (
                  <div
                    className="mt-1 break-all leading-tight"
                    style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 10.5 }}
                  >
                    {s.detail}
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ol>

      {/* Footer: indeterminate activity bar + what to expect / escape hatch. */}
      <div className="px-3 pt-1 pb-3">
        {phase !== 'reconnecting' && (
          <div
            className="h-[3px] w-full overflow-hidden rounded-full"
            style={{ background: 'color-mix(in srgb, var(--accent) 14%, transparent)' }}
          >
            <div
              style={{
                height: '100%',
                width: '38%',
                borderRadius: 9999,
                background: 'var(--accent)',
                animation: 'cl-indeterminate 1.15s ease-in-out infinite',
              }}
            />
          </div>
        )}
        <div className="mt-2 text-[10.5px] leading-snug" style={{ color: 'var(--text-muted)' }}>
          {phase === 'reconnecting'
            ? 'Connected — reopening the new address now.'
            : slow
              ? 'Taking longer than usual. The new server may still be starting — this tab will switch over as soon as it answers.'
              : 'This tab reloads automatically once the new server answers.'}
        </div>
        {origin && (slow || phase === 'reconnecting') && (
          <a
            href={origin}
            className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium"
            style={{ color: 'var(--accent)', fontFamily: 'var(--font-mono)' }}
          >
            Open {origin}
            <span aria-hidden="true">→</span>
          </a>
        )}
      </div>
    </div>
  )
}

export function RestartStepGlyph({ state }: { state: 'done' | 'active' | 'pending' }) {
  if (state === 'done') {
    return (
      <span
        aria-hidden="true"
        className="inline-flex items-center justify-center rounded-full"
        style={{ width: 14, height: 14, background: 'var(--accent)', color: '#fff', fontSize: 9, fontWeight: 700 }}
      >
        ✓
      </span>
    )
  }
  if (state === 'active') {
    return (
      <span
        aria-hidden="true"
        className="inline-block rounded-full"
        style={{
          width: 14,
          height: 14,
          border: '1.5px solid color-mix(in srgb, var(--accent) 25%, transparent)',
          borderTopColor: 'var(--accent)',
          animation: 'cl-spin 0.7s linear infinite',
        }}
      />
    )
  }
  return (
    <span
      aria-hidden="true"
      className="inline-block rounded-full"
      style={{ width: 14, height: 14, border: '1.5px solid var(--border-default)' }}
    />
  )
}
