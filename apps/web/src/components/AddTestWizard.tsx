import { useCallback, useEffect, useState } from 'react'
import * as api from '../api/client'
import type { DraftRecord, Feature } from '../api/types'
import { isPollingForStep, isTerminalDraft, nextStepForStatus, type WizardStep } from '../lib/wizard-state'
import { slugifyFeatureName } from '../lib/wizard-validation'
import { ConfigureStep, type ConfigureSubmit } from './wizard/ConfigureStep'
import { PlanReviewStep } from './wizard/PlanReviewStep'
import { SpecReviewStep } from './wizard/SpecReviewStep'
import { DoneStep } from './wizard/DoneStep'
import { Stepper } from './wizard/Stepper'

interface Props {
  features: Feature[]
  onClose: (result: { acceptedFeature?: string }) => void
}

// Full-screen overlay wizard. We don't have shadcn Dialog wired up yet, so
// we use a fixed-positioned overlay instead — same UX, smaller dependency
// footprint. The wizard owns the draft id and the polling loop; each step
// component receives the current draft + a small set of callbacks.
export function AddTestWizard({ features, onClose }: Props): JSX.Element {
  const [step, setStep] = useState<WizardStep>('configure')
  const [draft, setDraft] = useState<DraftRecord | null>(null)
  const [configureInput, setConfigureInput] = useState<ConfigureSubmit | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [acting, setActing] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)

  // ----- draft polling -----
  useEffect(() => {
    if (!draft) return
    if (!isPollingForStep(step, draft.status)) return
    let cancelled = false
    const tick = (): void => {
      api.getDraft(draft.draftId)
        .then((d) => {
          if (cancelled) return
          setDraft(d)
        })
        .catch(() => { /* keep last snapshot on transient errors */ })
    }
    const id = setInterval(tick, 1000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [draft, step])

  // ----- step transitions driven by status -----
  useEffect(() => {
    if (!draft) return
    const next = nextStepForStatus(draft.status)
    // Don't yank the user back to configure on rejected/error — keep them
    // on the current step so they can act (retry / cancel).
    if (draft.status === 'rejected' || draft.status === 'error') return
    if (next !== step) setStep(next)
  }, [draft, step])

  // ----- handlers -----
  const handleConfigureSubmit = useCallback(async (input: ConfigureSubmit): Promise<void> => {
    setSubmitting(true)
    setErrorMessage(null)
    try {
      const { draftId } = await api.createDraft({
        prdText: input.prdText,
        repos: input.repos,
        skills: input.skills,
        featureName: input.featureName,
      })
      setConfigureInput(input)
      const fresh = await api.getDraft(draftId)
      setDraft(fresh)
      // The backend transitions to `planning` immediately when skills are
      // supplied — let the polling effect drive UI from there.
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : 'Failed to create draft')
    } finally {
      setSubmitting(false)
    }
  }, [])

  const handleAcceptPlan = useCallback(async (): Promise<void> => {
    if (!draft) return
    setActing(true)
    try {
      await api.acceptPlan(draft.draftId)
      const fresh = await api.getDraft(draft.draftId)
      setDraft(fresh)
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : 'Accept failed')
    } finally {
      setActing(false)
    }
  }, [draft])

  const handleAcceptSpec = useCallback(async (): Promise<void> => {
    if (!draft) return
    setActing(true)
    try {
      const featureName = configureInput?.featureName ?? slugifyFeatureName(draft.prdText)
      await api.acceptSpec(draft.draftId, featureName)
      const fresh = await api.getDraft(draft.draftId)
      setDraft(fresh)
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : 'Accept failed')
    } finally {
      setActing(false)
    }
  }, [draft, configureInput])

  const handleRejectAndClose = useCallback(async (): Promise<void> => {
    if (draft) {
      try { await api.rejectDraft(draft.draftId) } catch { /* may already be rejected */ }
      try { await api.deleteDraft(draft.draftId) } catch { /* already gone */ }
    }
    onClose({})
  }, [draft, onClose])

  const handleRetry = useCallback(async (): Promise<void> => {
    if (!draft || !configureInput) return
    setActing(true)
    try {
      try { await api.rejectDraft(draft.draftId) } catch { /* noop */ }
      try { await api.deleteDraft(draft.draftId) } catch { /* noop */ }
      const { draftId } = await api.createDraft({
        prdText: configureInput.prdText,
        repos: configureInput.repos,
        skills: configureInput.skills,
        featureName: configureInput.featureName,
      })
      const fresh = await api.getDraft(draftId)
      setDraft(fresh)
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : 'Retry failed')
    } finally {
      setActing(false)
    }
  }, [draft, configureInput])

  const handleRunNow = useCallback(async (): Promise<void> => {
    const featureName = draft?.featureName ?? configureInput?.featureName
    if (!featureName) {
      onClose({ acceptedFeature: undefined })
      return
    }
    setStarting(true)
    try {
      await api.startRun(featureName)
    } catch { /* surfaced via runs column on next poll */ }
    setStarting(false)
    onClose({ acceptedFeature: featureName })
  }, [draft, configureInput, onClose])

  const requestCancel = (): void => {
    if (!draft || isTerminalDraft(draft.status)) {
      onClose({})
      return
    }
    setConfirmCancel(true)
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
    <div className="fixed inset-0 z-50 flex flex-col bg-zinc-950">
      <header className="flex items-center justify-between border-b border-zinc-800 px-6 py-3">
        <div className="text-sm font-medium text-zinc-100">Add test</div>
        <button
          type="button"
          onClick={requestCancel}
          className="rounded border border-zinc-800 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
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
            acting={acting}
          />
        )}
        {step === 'spec' && draft && (
          <SpecReviewStep
            draft={draft}
            featureName={featureNameForStep}
            onAccept={handleAcceptSpec}
            onReject={handleRejectAndClose}
            acting={acting}
          />
        )}
        {step === 'done' && (
          <DoneStep
            featureName={featureNameForStep}
            onRunNow={handleRunNow}
            onClose={() => onClose({ acceptedFeature: featureNameForStep })}
            starting={starting}
          />
        )}
      </div>

      {confirmCancel && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-[360px] rounded border border-zinc-700 bg-zinc-900 p-4 shadow-xl">
            <div className="text-sm font-medium text-zinc-100">Discard this draft?</div>
            <p className="mt-2 text-xs text-zinc-400">
              The in-progress draft will be rejected and removed.
            </p>
            <div className="mt-4 flex justify-end gap-2 text-xs">
              <button
                type="button"
                onClick={() => setConfirmCancel(false)}
                className="rounded border border-zinc-700 px-3 py-1 text-zinc-300 hover:bg-zinc-800"
              >
                Keep editing
              </button>
              <button
                type="button"
                onClick={() => { setConfirmCancel(false); void handleRejectAndClose() }}
                className="rounded bg-rose-600 px-3 py-1 text-zinc-50 hover:bg-rose-500"
              >
                Discard
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
