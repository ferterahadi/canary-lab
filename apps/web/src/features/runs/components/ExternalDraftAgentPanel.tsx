import type { DraftRecord, ExternalDraftStage } from '@shared/draft-types'
import { clientLabel, type ExternalClientKind } from '@/shared/ui/external-client-branding'
import { shortSession } from '@/shared/lib/format'
import { ExternalAgentCard, ExternalAgentError, ExternalClientCta, ExternalMetaFact, pillPalette, ExternalStatusPill } from '@/shared/ui/ExternalAgentCard'

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
  const stage = draft.externalStage ?? 'scaffolding'

  return (
    <ExternalAgentCard
      clientKind={clientKind}
      fill
      eyebrow="External agent session"
      headline={headlineFor(clientKind)}
      subtitle={draft.externalConversationName ?? undefined}
      statusPill={<ExternalStatusPill label={stageLabel(stage)} palette={stagePalette(stage)} />}
      meta={
        draft.externalSessionId && (
          <ExternalMetaFact label="Session" title={draft.externalSessionId}>
            <span style={{ fontFamily: 'var(--font-mono)' }}>{shortSession(draft.externalSessionId)}</span>
          </ExternalMetaFact>
        )
      }
      body={bodyCopy(stage, stageView, clientKind)}
      action={draft.externalSessionUrl && (
        <ExternalClientCta label={`Open ${clientLabel(clientKind)}`} href={draft.externalSessionUrl} />
      )}
    >
      {draft.errorMessage && stage === 'error' && (
        <ExternalAgentError>{draft.errorMessage}</ExternalAgentError>
      )}
    </ExternalAgentCard>
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

function stagePalette(stage: ExternalDraftStage) {
  if (stage === 'error') return pillPalette('var(--danger)')
  if (stage === 'applied') return pillPalette('var(--success)')
  if (stage === 'ready') return pillPalette('var(--accent)')
  return pillPalette('var(--border-focus)')
}

function bodyCopy(
  stage: ExternalDraftStage,
  stageView: Props['stageView'],
  clientKind: ExternalClientKind,
): string {
  const agent = clientLabel(clientKind)
  if (stage === 'error') {
    return `The ${agent} session reported an error. Check the conversation window for details and retry from there.`
  }
  if (stage === 'applied') {
    return `The ${agent} session applied the test files for this suite. You can close the wizard or continue with another step.`
  }
  if (stage === 'ready') {
    const noun = stageView === 'planning' ? 'plan' : 'spec'
    return `The ${agent} session is ready to apply the ${noun}. Apply runs through the wizard once you accept on this side.`
  }
  if (stage === 'validating') {
    return `${agent} is validating the generated files. Live progress is streaming in your ${agent} window — this panel updates when the stage advances.`
  }
  if (stage === 'authoring-tests') {
    return `${agent} is drafting tests for this suite. Follow the conversation in your ${agent} window — Canary Lab does not have a local transcript for external authoring sessions.`
  }
  // scaffolding
  return `${agent} is scaffolding the suite. The live transcript lives in your ${agent} window; this panel tracks the high-level stage.`
}

function headlineFor(kind: ExternalClientKind): string {
  return clientLabel(kind)
}
