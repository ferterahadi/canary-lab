// Shared branding for the "this agent runs in the user's own client" panels
// (external heal, external draft, external portify). The clientKind union is
// identical across heal / draft / portify, so the label, tint, session
// shortener, and brand monogram live here once instead of being copied per
// panel.

import type { ClientKind } from '../../../../../../shared/run-mode'

export type ExternalClientKind = ClientKind

// The four named clients render identically everywhere; only the label for an
// unknown ('other') client is surface-specific — the heal hero card says
// "AI Agent", the run timeline says "External", the draft/portify cards say
// "External Client" (the default). Callers pass `otherLabel` to keep their copy.
export function clientLabel(kind: ExternalClientKind, otherLabel = 'External Client'): string {
  switch (kind) {
    case 'claude-cli': return 'Claude CLI'
    case 'claude-desktop': return 'Claude Desktop'
    case 'codex-cli': return 'Codex CLI'
    case 'codex-desktop': return 'Codex Desktop'
    case 'other': return otherLabel
  }
}

export function clientTint(kind: ExternalClientKind): string {
  if (kind.startsWith('claude')) return '#d39965'
  if (kind.startsWith('codex')) return '#7aa2f7'
  return 'var(--border-focus)'
}

export function shortSession(sessionId: string): string {
  if (sessionId.length <= 12) return sessionId
  return `${sessionId.slice(0, 6)}…${sessionId.slice(-4)}`
}

export function BrandMark({
  clientKind,
  tint,
  elevated = false,
}: {
  clientKind: ExternalClientKind
  tint: string
  // The standalone heal hero card lifts the generic ('other') monogram with a
  // soft shadow; the embedded draft/portify cards stay flat. No effect on the
  // claude/codex monogram (which is flat everywhere).
  elevated?: boolean
}) {
  const isClaude = clientKind.startsWith('claude')
  const isCodex = clientKind.startsWith('codex')

  if (isClaude || isCodex) {
    const src = isClaude ? '/brand/claude.webp' : '/brand/codex.webp'
    const alt = clientLabel(clientKind)
    return (
      <div
        className="relative h-10 w-10 shrink-0 overflow-hidden rounded-lg @[320px]:h-12 @[320px]:w-12 @[320px]:rounded-xl @[480px]:h-14 @[480px]:w-14"
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
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg @[320px]:h-12 @[320px]:w-12 @[320px]:rounded-xl @[480px]:h-14 @[480px]:w-14"
      style={{
        background: `linear-gradient(135deg, color-mix(in srgb, ${tint} 22%, transparent), color-mix(in srgb, ${tint} 8%, transparent))`,
        border: `1px solid color-mix(in srgb, ${tint} 38%, var(--border-default))`,
        color: tint,
        ...(elevated
          ? { boxShadow: `inset 0 0 0 1px color-mix(in srgb, white 7%, transparent), 0 10px 24px color-mix(in srgb, ${tint} 14%, transparent)` }
          : {}),
      }}
      role="img"
      aria-label="External client"
    >
      <svg viewBox="0 0 32 32" width="30" height="30" fill="none" aria-hidden="true" className="h-7 w-7 @[320px]:h-8 @[320px]:w-8">
        <rect x="6" y="8" width="20" height="14" rx="3" fill="currentColor" opacity="0.13" />
        <rect x="6" y="8" width="20" height="14" rx="3" stroke="currentColor" strokeWidth="2" />
        <path d="M11 13h10M11 17h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.72" />
        <path d="M16 22v3M11.5 25h9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </div>
  )
}
