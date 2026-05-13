import { useCallback, useEffect, useState } from 'react'
import * as api from '../api/client'
import type { Feature, PlanStep } from '../api/types'
import { nextStepForStatus, type WizardStep } from '../lib/wizard-state'
import { slugifyFeatureName } from '../lib/wizard-validation'
import { useWizardDrafts } from '../state/WizardDraftContext'
import { ConfigureStep, type ConfigureSubmit } from './wizard/ConfigureStep'
import { PlanReviewStep } from './wizard/PlanReviewStep'
import { SpecReviewStep } from './wizard/SpecReviewStep'
import { DoneStep } from './wizard/DoneStep'
import { Stepper } from './wizard/Stepper'

interface Props {
  features: Feature[]
  onClose: () => void
  onAcceptedFeature?: (feature: string) => void
}

// Full-screen overlay wizard. We don't have shadcn Dialog wired up yet, so
// we use a fixed-positioned overlay instead — same UX, smaller dependency
// footprint. Draft ownership and polling live in WizardDraftProvider so this
// modal can be closed/reopened without interrupting server-side generation.
export function AddTestWizard({ features, onClose, onAcceptedFeature }: Props) {
  const {
    selectedDraft: draft,
    startDraft,
    cancelGeneration,
    acceptPlan,
    acceptSpec,
    rejectAndDelete,
  } = useWizardDrafts()
  const [step, setStep] = useState<WizardStep>('configure')
  const [configureInput, setConfigureInput] = useState<ConfigureSubmit | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [acting, setActing] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)

  // ----- step transitions driven by status -----
  useEffect(() => {
    if (!draft) {
      setStep('configure')
      return
    }
    const next = nextStepForStatus(draft.status)
    // Don't yank the user back to configure on rejected/error — keep them
    // on the current step so they can act (retry / cancel).
    if (draft.status === 'rejected' || draft.status === 'cancelled' || draft.status === 'error') {
      if (step === 'configure') setStep(draft.activeAgentStage === 'generating' ? 'spec' : 'plan')
      return
    }
    if (next !== step) setStep(next)
  }, [draft, step])

  // ----- handlers -----
  const handleConfigureSubmit = useCallback(async (input: ConfigureSubmit): Promise<void> => {
    setSubmitting(true)
    setErrorMessage(null)
    try {
      const createPayload = {
        prdText: input.agentPrdText ?? input.prdText,
        prdDocuments: input.prdDocuments,
        repos: input.repos,
        featureName: input.featureName,
      }
      await startDraft(createPayload)
      setConfigureInput(input)
      setStep('plan')
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : 'Failed to create draft')
    } finally {
      setSubmitting(false)
    }
  }, [startDraft])

  const handleAcceptPlan = useCallback(async (editedPlan?: PlanStep[]): Promise<void> => {
    if (!draft) return
    setActing(true)
    try {
      await acceptPlan(draft.draftId, editedPlan)
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : 'Accept failed')
    } finally {
      setActing(false)
    }
  }, [acceptPlan, draft])

  const handleAcceptSpec = useCallback(async (): Promise<void> => {
    if (!draft) return
    setActing(true)
    try {
      const featureName = configureInput?.featureName ?? draft.featureName ?? slugifyFeatureName(draft.prdText)
      await acceptSpec(draft.draftId, featureName)
      onAcceptedFeature?.(featureName)
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : 'Accept failed')
    } finally {
      setActing(false)
    }
  }, [acceptSpec, draft, configureInput, onAcceptedFeature])

  const handleCancelGeneration = useCallback(async (): Promise<void> => {
    if (!draft) return
    setActing(true)
    setErrorMessage(null)
    try {
      await cancelGeneration(draft.draftId)
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : 'Stop generation failed')
    } finally {
      setActing(false)
    }
  }, [cancelGeneration, draft])

  const handleRejectAndClose = useCallback(async (): Promise<void> => {
    if (draft) await rejectAndDelete(draft.draftId)
    onClose()
  }, [draft, onClose, rejectAndDelete])

  const handleRetry = useCallback(async (): Promise<void> => {
    if (!draft) return
    setActing(true)
    try {
      await rejectAndDelete(draft.draftId)
      const createPayload = {
        prdText: configureInput?.agentPrdText ?? configureInput?.prdText ?? draft.prdText,
        prdDocuments: configureInput?.prdDocuments ?? draft.prdDocuments,
        repos: configureInput?.repos ?? draft.repos,
        featureName: configureInput?.featureName ?? draft.featureName,
      }
      await startDraft(createPayload)
      setStep('plan')
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : 'Retry failed')
    } finally {
      setActing(false)
    }
  }, [configureInput, draft, rejectAndDelete, startDraft])

  const handleRunNow = useCallback(async (): Promise<void> => {
    const featureName = draft?.featureName ?? configureInput?.featureName
    if (!featureName) {
      onClose()
      return
    }
    setStarting(true)
    try {
      await api.startRun(featureName)
    } catch { /* surfaced via runs column on next poll */ }
    setStarting(false)
    onClose()
  }, [draft, configureInput, onClose])

  const requestCancel = (): void => {
    onClose()
  }

  const featureNameForStep =
    configureInput?.featureName?.trim()
      ? configureInput.featureName.trim()
      : draft?.featureName?.trim()
        ? draft.featureName.trim()
        : draft
          ? slugifyFeatureName(draft.prdText)
          : ''

  return (
    <div className="cl-panel fixed inset-0 z-50 flex flex-col">
      <header className="cl-shell-bar flex items-center justify-between px-6 py-3">
        <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Add test</div>
        <button
          type="button"
          onClick={requestCancel}
          className="cl-button px-2 py-1 text-xs"
        >
          Close
        </button>
      </header>
      <Stepper current={step} />
      <div className="flex-1 min-h-0">
        {step === 'configure' && (
          <ConfigureStep
            features={features}
            initial={configureInput ?? undefined}
            onSubmit={handleConfigureSubmit}
            onCancel={requestCancel}
            submitting={submitting}
            errorMessage={errorMessage}
          />
        )}
        {step === 'plan' && draft && (
          <PlanReviewStep
            draft={draft}
            onAccept={handleAcceptPlan}
            onReject={handleRejectAndClose}
            onRetry={handleRetry}
            onCancelGeneration={handleCancelGeneration}
            acting={acting}
          />
        )}
        {step === 'spec' && draft && (
          <SpecReviewStep
            draft={draft}
            featureName={featureNameForStep}
            onAccept={handleAcceptSpec}
            onReject={handleRejectAndClose}
            onRetry={handleRetry}
            onCancelGeneration={handleCancelGeneration}
            acting={acting}
          />
        )}
        {step === 'done' && (
          <DoneStep
            featureName={featureNameForStep}
            onRunNow={handleRunNow}
            onClose={onClose}
            starting={starting}
          />
        )}
      </div>
    </div>
  )
}
