import type { DraftRecord, ExternalDraftStage, ExternalHealClientKind } from '../../../shared/api/types'

interface Props {
  draft: DraftRecord
  // Which wizard stage is currently showing this panel — used to scope the
  // headline copy ("Plan" vs "Spec"). Visual language stays identical.
  stageView: 'planning' | 'generating'
}

// Draft-side analog of `ExternalHealPanel`. When the wizard's draft is driven
// by an external MCP client (Claude/Codex), the local agent transcript pane
// has nothing to render — the conversation lives in the user's own window.
// This panel surfaces that explicitly with the same elevated-card / brand
// monogram aesthetic the heal panel uses.
export function ExternalDraftAgentPanel({ draft, stageView }: Props) {
  const clientKind = draft.externalClientKind ?? 'other'
  const tint = clientTint(clientKind)
  const stage = draft.externalStage ?? 'scaffolding'

  return (
    <div className="@container flex h-full min-h-0 flex-col overflow-y-auto p-3 @[400px]:p-4">
      <div
        className="relative overflow-hidden rounded-xl p-3.5 @[320px]:rounded-2xl @[320px]:p-4 @[480px]:p-6"
        style={{
          background: `radial-gradient(120% 90% at 0% 0%, color-mix(in srgb, ${tint} 14%, transparent) 0%, transparent 55%), var(--bg-elevated)`,
          border: `1px solid color-mix(in srgb, ${tint} 24%, var(--border-default))`,
        }}
      >
        <div className="flex items-start gap-3 @[480px]:gap-4">
          <BrandMark clientKind={clientKind} tint={tint} />
          <div className="min-w-0 flex-1 pt-0.5">
            <div
              className="text-[9px] font-medium uppercase @[320px]:text-[10px]"
              style={{ color: 'var(--text-muted)', letterSpacing: '0.14em' }}
            >
              External authoring session
            </div>
            <h2
              className="mt-0.5 text-sm font-semibold @[320px]:mt-1 @[320px]:text-base @[480px]:mt-1.5 @[480px]:text-xl"
              style={{
                color: 'var(--text-primary)',
                letterSpacing: '-0.01em',
                lineHeight: 1.2,
              }}
            >
              {headlineFor(clientKind)}
            </h2>
            {draft.externalConversationName && (
              <div
                className="mt-1 truncate text-[11px] @[320px]:text-xs"
                style={{ color: 'var(--text-secondary)' }}
                title={draft.externalConversationName}
              >
                {draft.externalConversationName}
              </div>
            )}
          </div>
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[10px] @[320px]:mt-3 @[320px]:gap-x-2.5 @[320px]:text-[11px] @[480px]:mt-3.5">
          <StagePill stage={stage} />
          {draft.externalSessionId && (
            <span
              className="inline-flex items-center gap-1.5"
              style={{ color: 'var(--text-muted)' }}
            >
              <span aria-hidden style={{ opacity: 0.55 }}>·</span>
              <span style={{ fontFamily: 'var(--font-mono)' }} title={draft.externalSessionId}>
                {shortSession(draft.externalSessionId)}
              </span>
            </span>
          )}
        </div>

        <p
          className="mt-3 text-[11px] leading-relaxed @[320px]:mt-4 @[320px]:text-xs @[480px]:mt-5 @[480px]:text-[13px]"
          style={{ color: 'var(--text-secondary)' }}
        >
          {bodyCopy(stage, stageView, clientKind)}
        </p>

        {draft.externalSessionUrl && (
          <div className="mt-3 @[320px]:mt-4 @[480px]:mt-5">
            <a
              href={draft.externalSessionUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex w-full items-center justify-center gap-2 rounded-md px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider @[320px]:rounded-lg @[320px]:px-3.5 @[320px]:py-2 @[320px]:text-[11px] @[480px]:w-auto @[480px]:justify-start"
              style={{
                color: tint,
                background: `color-mix(in srgb, ${tint} 14%, transparent)`,
                border: `1px solid color-mix(in srgb, ${tint} 38%, transparent)`,
              }}
            >
              <span>Open {clientLabel(clientKind)}</span>
              <span aria-hidden>→</span>
            </a>
          </div>
        )}

        {draft.errorMessage && stage === 'error' && (
          <div
            className="mt-3 rounded-md px-3 py-2 text-[11px] @[320px]:mt-4"
            style={{
              color: 'var(--danger)',
              background: 'color-mix(in srgb, var(--danger) 10%, transparent)',
              border: '1px solid color-mix(in srgb, var(--danger) 30%, transparent)',
            }}
          >
            {draft.errorMessage}
          </div>
        )}
      </div>
    </div>
  )
}

function StagePill({ stage }: { stage: ExternalDraftStage }) {
  const palette = stagePalette(stage)
  return (
    <span
      className="rounded-full px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wider"
      style={{
        color: palette.fg,
        background: palette.bg,
        border: `1px solid ${palette.border}`,
      }}
    >
      {stageLabel(stage)}
    </span>
  )
}

function BrandMark({
  clientKind,
  tint,
}: {
  clientKind: ExternalHealClientKind
  tint: string
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

function stageLabel(stage: ExternalDraftStage): string {
  switch (stage) {
    case 'scaffolding': return 'Scaffolding'
    case 'authoring-tests': return 'Authoring tests'
    case 'validating': return 'Validating'
    case 'ready': return 'Ready'
    case 'applied': return 'Applied'
    case 'error': return 'Error'
  }
}

function stagePalette(stage: ExternalDraftStage): { fg: string; bg: string; border: string } {
  if (stage === 'error') {
    return {
      fg: 'var(--danger)',
      bg: 'color-mix(in srgb, var(--danger) 12%, transparent)',
      border: 'color-mix(in srgb, var(--danger) 40%, transparent)',
    }
  }
  if (stage === 'applied') {
    return {
      fg: 'var(--success)',
      bg: 'color-mix(in srgb, var(--success) 12%, transparent)',
      border: 'color-mix(in srgb, var(--success) 40%, transparent)',
    }
  }
  if (stage === 'ready') {
    return {
      fg: 'var(--accent)',
      bg: 'color-mix(in srgb, var(--accent) 12%, transparent)',
      border: 'color-mix(in srgb, var(--accent) 40%, transparent)',
    }
  }
  return {
    fg: 'var(--border-focus)',
    bg: 'color-mix(in srgb, var(--border-focus) 12%, transparent)',
    border: 'color-mix(in srgb, var(--border-focus) 40%, transparent)',
  }
}

function bodyCopy(
  stage: ExternalDraftStage,
  stageView: Props['stageView'],
  clientKind: ExternalHealClientKind,
): string {
  const agent = clientLabel(clientKind)
  if (stage === 'error') {
    return `The ${agent} session reported an error. Check the conversation window for details and retry from there.`
  }
  if (stage === 'applied') {
    return `The ${agent} session applied the test files for this feature. You can close the wizard or continue with another step.`
  }
  if (stage === 'ready') {
    const noun = stageView === 'planning' ? 'plan' : 'spec'
    return `The ${agent} session is ready to apply the ${noun}. Apply runs through the wizard once you accept on this side.`
  }
  if (stage === 'validating') {
    return `${agent} is validating the generated files. Live progress is streaming in your ${agent} window — this panel updates when the stage advances.`
  }
  if (stage === 'authoring-tests') {
    return `${agent} is drafting tests for this feature. Follow the conversation in your ${agent} window — Canary Lab does not have a local transcript for external authoring sessions.`
  }
  // scaffolding
  return `${agent} is scaffolding the feature. The live transcript lives in your ${agent} window; this panel tracks the high-level stage.`
}

function headlineFor(kind: ExternalHealClientKind): string {
  return kind === 'other' ? 'External Client' : clientLabel(kind)
}

function clientLabel(kind: ExternalHealClientKind): string {
  switch (kind) {
    case 'claude-cli': return 'Claude CLI'
    case 'claude-desktop': return 'Claude Desktop'
    case 'codex-cli': return 'Codex CLI'
    case 'codex-desktop': return 'Codex Desktop'
    case 'other': return 'External Client'
  }
}

function clientTint(kind: ExternalHealClientKind): string {
  if (kind.startsWith('claude')) return '#d39965'
  if (kind.startsWith('codex')) return '#7aa2f7'
  return 'var(--border-focus)'
}

function shortSession(sessionId: string): string {
  if (sessionId.length <= 12) return sessionId
  return `${sessionId.slice(0, 6)}…${sessionId.slice(-4)}`
}
