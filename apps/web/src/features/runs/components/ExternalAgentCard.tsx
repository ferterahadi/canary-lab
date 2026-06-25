import { useCallback, useState, type ReactNode } from 'react'
import * as api from '../../../shared/api/client'
import { BrandMark, clientTint, type ExternalClientKind } from './external-client-branding'

// The shared shell for every "an external MCP client is driving this in its own
// window" surface — external heal, draft authoring, port-ification, and coverage
// mapping. They all render the same elevated radial-gradient card with a brand
// monogram, eyebrow, headline, a status-pill row, body copy, optional extra
// blocks, and an "Open Claude/Codex" CTA. Each caller owns only its own status
// enum → label/palette, its copy, and its extra content (passed as children);
// the chrome lives here so the four surfaces can never drift apart.

export interface PillPalette {
  fg: string
  bg: string
  border: string
}

// The palette every external panel uses for a tinted status pill: a colour at
// 12% fill / 40% border. Pass a CSS colour or var.
export function pillPalette(color: string): PillPalette {
  return {
    fg: color,
    bg: `color-mix(in srgb, ${color} 12%, transparent)`,
    border: `color-mix(in srgb, ${color} 40%, transparent)`,
  }
}

export function StatusPill({ label, palette }: { label: string; palette: PillPalette }) {
  return (
    <span
      className="rounded-full px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wider"
      style={{ color: palette.fg, background: palette.bg, border: `1px solid ${palette.border}` }}
    >
      {label}
    </span>
  )
}

// The "Open Claude/Codex →" CTA. Two variants share one set of tinted styles: a
// link (href, e.g. portify/draft sessionUrl) or a button (onClick, e.g. heal's
// openAgentApp, which is stateful and reports its own busy/error).
export function ExternalClientCta(
  props:
    | { tint: string; label: string; href: string }
    | { tint: string; label: string; onClick: () => void; busy?: boolean; busyLabel?: string },
) {
  const className =
    'inline-flex w-full items-center justify-center gap-2 rounded-md px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider @[320px]:rounded-lg @[320px]:px-3.5 @[320px]:py-2 @[320px]:text-[11px] @[480px]:w-auto @[480px]:justify-start'
  const baseStyle = {
    color: props.tint,
    background: `color-mix(in srgb, ${props.tint} 14%, transparent)`,
    border: `1px solid color-mix(in srgb, ${props.tint} 38%, transparent)`,
  }
  if ('href' in props) {
    return (
      <a href={props.href} target="_blank" rel="noreferrer" className={className} style={baseStyle}>
        <span>{props.label}</span>
        <span aria-hidden>→</span>
      </a>
    )
  }
  const busy = props.busy ?? false
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={busy}
      className={className}
      style={{ ...baseStyle, opacity: busy ? 0.6 : 1 }}
    >
      {busy ? (
        (props.busyLabel ?? 'Opening…')
      ) : (
        <>
          <span>{props.label}</span>
          <span aria-hidden>→</span>
        </>
      )}
    </button>
  )
}

// Launch the user's Claude/Codex desktop app. Shared by every external panel
// whose CTA opens the client (heal, coverage) so the busy/error handling has one
// home instead of a per-panel copy.
export function useOpenAgentApp() {
  const [opening, setOpening] = useState<'claude' | 'codex' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const open = useCallback(async (agent: 'claude' | 'codex'): Promise<void> => {
    setOpening(agent)
    setError(null)
    try {
      await api.openAgentApp(agent)
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not open ${agent}`)
    } finally {
      setOpening(null)
    }
  }, [])
  return { opening, error, open }
}

interface ExternalAgentCardProps {
  clientKind: ExternalClientKind
  eyebrow: string
  headline: string
  // Optional secondary line under the headline (e.g. conversation name).
  subtitle?: string
  // The status pill — typically <StatusPill label={…} palette={…} />.
  statusPill?: ReactNode
  // Trailing items in the pill row (session id, heartbeat, cycle count).
  meta?: ReactNode
  body?: ReactNode
  // Extra blocks rendered after the body, in caller order (worktree paths,
  // failure detail, tracked log) — including the CTA, so callers control where
  // it sits relative to their extras.
  children?: ReactNode
  // Passed through to BrandMark; heal renders the elevated monogram.
  brandElevated?: boolean
  // Wrap the card in the full-pane scroll container (heal/draft/portify fill
  // their pane). Embedded callers (coverage) leave this false and get the bare
  // card inside a minimal @container so the container queries still resolve.
  fill?: boolean
}

export function ExternalAgentCard({
  clientKind,
  eyebrow,
  headline,
  subtitle,
  statusPill,
  meta,
  body,
  children,
  brandElevated,
  fill = false,
}: ExternalAgentCardProps) {
  const tint = clientTint(clientKind)
  const card = (
    <div
      className="relative overflow-hidden rounded-xl p-3.5 @[320px]:rounded-2xl @[320px]:p-4 @[480px]:p-6"
      style={{
        background: `radial-gradient(120% 90% at 0% 0%, color-mix(in srgb, ${tint} 14%, transparent) 0%, transparent 55%), var(--bg-elevated)`,
        border: `1px solid color-mix(in srgb, ${tint} 24%, var(--border-default))`,
      }}
    >
      <div className="flex items-start gap-3 @[480px]:gap-4">
        <BrandMark clientKind={clientKind} tint={tint} elevated={brandElevated} />
        <div className="min-w-0 flex-1 pt-0.5">
          <div
            className="text-[9px] font-medium uppercase @[320px]:text-[10px]"
            style={{ color: 'var(--text-muted)', letterSpacing: '0.14em' }}
          >
            {eyebrow}
          </div>
          <h2
            className="mt-0.5 text-sm font-semibold @[320px]:mt-1 @[320px]:text-base @[480px]:mt-1.5 @[480px]:text-xl"
            style={{ color: 'var(--text-primary)', letterSpacing: '-0.01em', lineHeight: 1.2 }}
          >
            {headline}
          </h2>
          {subtitle && (
            <div
              className="mt-1 truncate text-[11px] @[320px]:text-xs"
              style={{ color: 'var(--text-secondary)' }}
              title={subtitle}
            >
              {subtitle}
            </div>
          )}
        </div>
      </div>

      {(statusPill || meta) && (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[10px] @[320px]:mt-3 @[320px]:gap-x-2.5 @[320px]:text-[11px] @[480px]:mt-3.5">
          {statusPill}
          {meta}
        </div>
      )}

      {body && (
        <p
          className="mt-3 text-[11px] leading-relaxed @[320px]:mt-4 @[320px]:text-xs @[480px]:mt-5 @[480px]:text-[13px]"
          style={{ color: 'var(--text-secondary)' }}
        >
          {body}
        </p>
      )}

      {children}
    </div>
  )

  if (fill) {
    return (
      <div className="@container flex h-full min-h-0 flex-col overflow-y-auto p-3 @[400px]:p-4">
        {card}
      </div>
    )
  }
  return <div className="@container">{card}</div>
}
