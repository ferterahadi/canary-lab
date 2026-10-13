// Shared branding for the "this agent runs in the user's own client" panels
// (external heal, external draft, external portify). The clientKind union is
// identical across heal / draft / portify, so the label, tint, session
// shortener, and brand monogram live here once instead of being copied per
// panel.

import type { ClientKind } from '@shared/run-mode'

export type ExternalClientKind = ClientKind

// The four named clients render identically everywhere; only the label for an
// unknown ('other') client is surface-specific — the heal hero card says
// "AI Agent", while other surfaces use "External agent" (the default).
// Callers pass `otherLabel` to keep their copy.
export function clientLabel(kind: ExternalClientKind, otherLabel = 'External agent'): string {
  switch (kind) {
    case 'claude': return 'Claude'
    case 'codex': return 'Codex'
    case 'claude-pty': return 'Claude (runner)'
    case 'codex-pty': return 'Codex (runner)'
    case 'other': return otherLabel
  }
}

export function clientTint(kind: ExternalClientKind): string {
  if (kind.startsWith('claude')) return '#d39965'
  if (kind.startsWith('codex')) return '#7aa2f7'
  return 'var(--border-focus)'
}

// The "Open Claude/Codex" CTA targets an interactive client the user can launch.
// Runner-spawned PTY agents (`*-pty`) and undetected (`other`) clients have no
// app to open, so they get no CTA. Shared by every external panel that offers
// the jump-to-agent affordance (heal, coverage).
export function clientKindToDesktopAgent(kind: ExternalClientKind): 'claude' | 'codex' | null {
  if (kind === 'claude') return 'claude'
  if (kind === 'codex') return 'codex'
  return null
}

// The client's 32px mark on an external-agent card's title strip: the app's
// own icon for Claude/Codex, a tinted monitor glyph for any other client.
export function BrandMark({
  clientKind,
  tint,
}: {
  clientKind: ExternalClientKind
  tint: string
}) {
  const isClaude = clientKind.startsWith('claude')
  const isCodex = clientKind.startsWith('codex')

  if (isClaude || isCodex) {
    const src = isClaude ? '/brand/claude.webp' : '/brand/codex.webp'
    const alt = clientLabel(clientKind)
    return (
      <div
        className="relative h-8 w-8 shrink-0 overflow-hidden rounded-lg"
        style={{
          border: `1px solid color-mix(in srgb, ${tint} 30%, var(--border-default))`,
        }}
      >
        <img src={src} alt={alt} className="h-full w-full object-cover" />
      </div>
    )
  }

  return (
    <div
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
      style={{
        background: `linear-gradient(135deg, color-mix(in srgb, ${tint} 22%, transparent), color-mix(in srgb, ${tint} 8%, transparent))`,
        border: `1px solid color-mix(in srgb, ${tint} 38%, var(--border-default))`,
        color: tint,
      }}
      role="img"
      aria-label="External agent session"
    >
      <svg viewBox="0 0 32 32" width="30" height="30" fill="none" aria-hidden="true" className="h-5 w-5">
        <rect x="6" y="8" width="20" height="14" rx="3" fill="currentColor" opacity="0.13" />
        <rect x="6" y="8" width="20" height="14" rx="3" stroke="currentColor" strokeWidth="2" />
        <path d="M11 13h10M11 17h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.72" />
        <path d="M16 22v3M11.5 25h9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </div>
  )
}
