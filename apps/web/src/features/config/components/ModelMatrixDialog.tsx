import type { ProjectConfigResponse } from '@shared/project-config'
import { useMountedIdentity } from '@/shared/state/use-mounted-identity'
import { useState } from 'react'
import * as configApi from '@/shared/api/config'
import { MODEL_STAGE_KEYS, type AgentModelsConfig, type ModelAgentKind } from '@shared/agent-models'
import { Modal } from '@/shared/ui/Overlays'
import { agentTitle } from './settings-options'
import { ModelPlanEditor } from './ModelPlanEditor'
import { toSavedPlans, useModelPlanDraft } from './model-plan-draft'
import { displayError } from '@/shared/api/error-message'

// The per-agent model matrix (2.2.0 model cockpit): the shared editor over all
// nine stages, saved as the workspace defaults. Stacked over Project Settings
// and routed as its `models` qualifier, so a refresh keeps it open. Saves ONLY
// the `agentModels` block (the PUT field-merges server-side), so an unsaved
// Settings draft behind it is never clobbered.

interface Props {
  agent: ModelAgentKind
  /** The whole saved block — Save rewrites this agent's plans inside it, so the
   *  other agent's plans survive the round-trip (the PUT replaces the block). */
  agentModels: AgentModelsConfig
  onClose: () => void
  /** Fired with the server's response after a successful save — the settings
   *  dialog behind updates its summary lines from it. */
  onSaved: (config: ProjectConfigResponse) => void
}

export function ModelMatrixDialog({ agent, agentModels, onClose, onSaved }: Props) {
  const mounted = useMountedIdentity(agent)
  const plan = useModelPlanDraft(agent, MODEL_STAGE_KEYS, agentModels)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onSave = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const next = await configApi.putProjectConfig({ agentModels: { ...agentModels, [agent]: toSavedPlans(plan.draft) } })
      if (!mounted()) return
      onSaved(next)
      onClose()
    } catch (e: unknown) {
      if (mounted()) setError(displayError(e, 'Save failed'))
    } finally {
      if (mounted()) setSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Default models"
      eyebrow={agentTitle(agent)}
      ariaLabel={`Configure models for ${agentTitle(agent)}`}
      testId="model-matrix-dialog"
      width={620}
      stableScrollGutter
      footer={
        <>
          {error && <span className="cl-type-meta mr-auto text-danger">{error}</span>}
          <button type="button" onClick={onClose} className="cl-button px-3 py-1">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => { void onSave() }}
            disabled={!plan.dirty || saving}
            data-testid="model-matrix-save"
            className="cl-button-primary px-3.5 py-1"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="px-4 py-3">
        <ModelPlanEditor agent={agent} stages={MODEL_STAGE_KEYS} plan={plan} />
      </div>
    </Modal>
  )
}
