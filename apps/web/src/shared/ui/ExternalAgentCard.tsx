import { useCallback, useState, type ReactNode } from 'react'
import * as workspaceApi from '@/shared/api/workspace'
import { BrandMark, clientTint, clientKindToDesktopAgent, type ExternalClientKind } from '@/shared/ui/external-client-branding'

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

export function ExternalStatusPill({ label, palette }: { label: string; palette: PillPalette }) {
  // The run-detail status chip's shape, in the caller's palette: a tint fill
  // with its own ink, no outline — the same register as READY / FAILED.
  return (
    <span className="cl-status-chip" style={{ color: palette.fg, background: palette.bg }}>
      {label}
    </span>
  )
}

// The "Open Claude/Codex →" action on the card's footer strip — a neutral
// `.cl-button`, as every other card action. Two variants: a link (href, e.g.
// portify/draft sessionUrl) or a button (onClick, e.g. heal's openAgentApp,
// which is stateful and reports its own busy/error).
export function ExternalClientCta(
  props:
    | { label: string; href: string }
    | { label: string; onClick: () => void; busy?: boolean; busyLabel?: string },
) {
  const className = 'cl-button inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px]'
  const face = (
    <>
      <span>{props.label}</span>
      <span aria-hidden>→</span>
    </>
  )
  if ('href' in props) {
    return (
      <a href={props.href} target="_blank" rel="noreferrer" className={className}>
        {face}
      </a>
    )
  }
  const busy = props.busy ?? false
  return (
    <button type="button" onClick={props.onClick} disabled={busy} className={className}>
      {busy ? (props.busyLabel ?? 'Opening…') : face}
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
      await workspaceApi.openAgentApp(agent)
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not open ${agent}`)
    } finally {
      setOpening(null)
    }
  }, [])
  return { opening, error, open }
}

export type ExternalClientAction =
  | { kind: 'link'; href: string }
  | { kind: 'app'; agent: 'claude' | 'codex'; open: () => Promise<void>; busy: boolean }
  | null

export function useExternalClientAction({ clientKind, sessionUrl }: {
  clientKind: ExternalClientKind
  sessionUrl?: string
}): { action: ExternalClientAction; error: string | null } {
  const { opening, error, open } = useOpenAgentApp()
  const agent = clientKindToDesktopAgent(clientKind)
  const action: ExternalClientAction = sessionUrl
    ? { kind: 'link', href: sessionUrl }
    : agent ? { kind: 'app', agent, open: () => open(agent), busy: opening !== null } : null
  return { action, error }
}

interface ExternalAgentCardProps {
  clientKind: ExternalClientKind
  eyebrow: string
  headline: string
  // Optional secondary line under the headline (e.g. conversation name).
  subtitle?: string
  // The status chip on the title strip — typically <ExternalStatusPill …/>.
  statusPill?: ReactNode
  // The body's first line: labelled facts (session id, heartbeat, cycle count).
  meta?: ReactNode
  body?: ReactNode
  // Extra blocks rendered after the body, in caller order (worktree paths,
  // failure detail, tracked log).
  children?: ReactNode
  // The footer strip — the "Open Claude/Codex" CTA. Omitted, the card ends on
  // its body.
  action?: ReactNode
  // Wrap the card in the full-pane scroll container (heal/draft/portify fill
  // their pane). Embedded callers (coverage) leave this false and get the bare
  // card inside a minimal @container so the container queries still resolve.
  fill?: boolean
}

/** One labelled fact on the card's meta line: a rubric label, then the value. */
export function ExternalMetaFact({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1.5" title={title}>
      <span className="cl-rubric">{label}</span>
      <span className="min-w-0 truncate" style={{ color: 'var(--text-secondary)' }}>{children}</span>
    </span>
  )
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
  action,
  fill = false,
}: ExternalAgentCardProps) {
  // The run-detail card anatomy — title strip, body, action strip — so an
  // external session reads as one more card in the pane, not a hero banner.
  // The brand mark carries the client's identity; the surfaces stay neutral.
  const card = (
    <div className="cl-card overflow-hidden">
      <div className="cl-card-head" style={{ gap: 10, paddingBlock: 10 }}>
        <BrandMark clientKind={clientKind} tint={clientTint(clientKind)} />
        <div className="min-w-0 flex-1">
          <div className="cl-rubric truncate">{eyebrow}</div>
          <h2
            className="m-0 mt-0.5 truncate text-[13px] font-semibold"
            style={{ color: 'var(--text-primary)', lineHeight: 1.25 }}
          >
            {headline}
          </h2>
          {subtitle && (
            <div className="mt-0.5 truncate text-[11px]" style={{ color: 'var(--text-secondary)' }} title={subtitle}>
              {subtitle}
            </div>
          )}
        </div>
        {statusPill}
      </div>

      {(meta || body || children) && (
        <div className="cl-card-body">
          {meta && (
            <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
              {meta}
            </div>
          )}
          {body && (
            <p
              className={`m-0 text-xs leading-relaxed ${meta ? 'mt-2' : ''}`}
              style={{ color: 'var(--text-secondary)' }}
            >
              {body}
            </p>
          )}
          {children}
        </div>
      )}

      {action && <div className="cl-card-foot">{action}</div>}
    </div>
  )

  if (fill) {
    return (
      <div className="@container flex h-full min-h-0 flex-col overflow-y-auto p-4">
        {card}
      </div>
    )
  }
  return <div className="@container">{card}</div>
}
