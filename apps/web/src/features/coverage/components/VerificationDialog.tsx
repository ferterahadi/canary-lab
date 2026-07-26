import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import * as api from '@/shared/api/client'
import type { VerificationConfig, VerificationTarget } from '@/shared/api/types'
import { Modal, Section } from '@/shared/ui/atoms'

// The dialog is built from the app's shared dialog chrome — `Modal` (backdrop,
// eyebrow + title header, scrollable body, pinned footer) and `Section` (titled
// bordered block) — so it reads as the same tool as the config editor and the
// flight launcher. It used to carry its own `cl-verify-*` skin (gradient top
// rail, tinted header wash, shadowed slab cards, green mode chips), which was
// the only surface in the app styled that way.

interface VerificationDialogProps {
  feature: string
  envs: string[]
  disabled?: boolean
  disabledReason?: string
  onClose: () => void
  onStart: (input: {
    configId?: string
    targetUrls?: Record<string, string>
    playwrightEnvsetId?: string
  }) => Promise<void>
  /** Bumped on a `verification-config-changed` event (MCP/other-tab edit). Re-lists
   *  the saved configs WITHOUT touching the current selection or in-progress edits. */
  refreshKey?: number
}

export function VerificationDialog({
  feature,
  envs,
  disabled,
  disabledReason,
  onClose,
  onStart,
  refreshKey,
}: VerificationDialogProps) {
  const [configs, setConfigs] = useState<VerificationConfig[]>([])
  const [selectedConfigId, setSelectedConfigId] = useState<string | null>(null)
  const [targets, setTargets] = useState<VerificationTarget[]>([])
  const [defaultTargetUrls, setDefaultTargetUrls] = useState<Record<string, string>>({})
  const [targetUrls, setTargetUrls] = useState<Record<string, string>>({})
  const [playwrightEnvsetId, setPlaywrightEnvsetId] = useState(envs[0] ?? '')
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // What the CURRENTLY selected envset seeded into the form — the baseline
  // `reseedTargetUrls` compares against to tell "still the envset's value" from
  // "the user's own". A ref, not state: the re-seed reads it inside a setState
  // updater, and writing it must not re-fire the effect that maintains it.
  const seededUrls = useRef<Record<string, string>>({})

  const selectedConfig = useMemo(
    () => configs.find((config) => config.id === selectedConfigId) ?? null,
    [configs, selectedConfigId],
  )

  const configuredTargetCount = useMemo(
    () => targets.filter((target) => (targetUrls[target.id] ?? '').trim()).length,
    [targetUrls, targets],
  )

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([
      api.listVerificationConfigs(feature),
      api.getVerificationTargets(feature, playwrightEnvsetId || undefined),
    ]).then(([loadedConfigs, targetIndex]) => {
      if (cancelled) return
      setConfigs(loadedConfigs)
      setTargets(targetIndex.targets)
      setDefaultTargetUrls(targetIndex.targetUrls)
      if (loadedConfigs.length > 0) {
        const first = loadedConfigs[0]
        setSelectedConfigId(first.id)
        setName(first.name)
        setPlaywrightEnvsetId(first.playwrightEnvsetId)
        setTargetUrls(first.targetUrls)
        // Saved values, not an envset seed — see `selectConfig`.
        seededUrls.current = {}
      } else {
        setSelectedConfigId(null)
        setName('')
        setTargetUrls(targetIndex.targetUrls)
        seededUrls.current = targetIndex.targetUrls
      }
    }).catch((err) => {
      if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load verification settings')
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  // Load once per feature. Envset changes fetch targets in the effect below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feature])

  // A `verification-config-changed` event (this config edited via MCP or another
  // tab) bumps refreshKey. Re-list the saved configs so a new/renamed config shows
  // live — but DELIBERATELY do not reset selectedConfigId / name / targetUrls, so
  // the editing user's current selection and unsaved edits survive (cl_ws-driven-
  // state + don't clobber local state). Skip the initial mount (the loader above
  // already fetched).
  const refreshMounted = useRef(false)
  useEffect(() => {
    if (!refreshMounted.current) { refreshMounted.current = true; return }
    let cancelled = false
    api.listVerificationConfigs(feature)
      .then((loaded) => { if (!cancelled) setConfigs(loaded) })
      .catch(() => {})
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])

  // `envs` arrives with the parent's async feature list, so the initial state is
  // '' on first render. A `<select>` whose React value matches no option still
  // DISPLAYS its first one, so the dialog claimed "local" while actually holding
  // no envset — and the seeded URLs came from the server's no-envset fallback,
  // which is not the same map. Adopt the first envset the moment the list lands.
  useEffect(() => {
    if (!playwrightEnvsetId && envs.length > 0) setPlaywrightEnvsetId(envs[0])
  }, [envs, playwrightEnvsetId])

  useEffect(() => {
    if (!playwrightEnvsetId) return
    let cancelled = false
    api.getVerificationTargets(feature, playwrightEnvsetId)
      .then((targetIndex) => {
        if (cancelled) return
        setTargets(targetIndex.targets)
        setDefaultTargetUrls(targetIndex.targetUrls)
        // Switching envset actually swaps its URLs in. The old merge kept every
        // previous value (`{...next, ...prev}`), so after the first load the
        // picker only ever changed the target LIST — picking `staging` left the
        // localhost URLs sitting there.
        //
        // Read the outgoing seed into a local FIRST: `setTargetUrls`'s updater
        // runs later, during render, so advancing the ref before the call would
        // hand the updater the new seed as the "previous" one and match nothing.
        const previousSeed = seededUrls.current
        seededUrls.current = targetIndex.targetUrls
        setTargetUrls((prev) => reseedTargetUrls(prev, previousSeed, targetIndex.targetUrls))
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [feature, playwrightEnvsetId])

  const selectConfig = useCallback((config: VerificationConfig): void => {
    setSelectedConfigId(config.id)
    setName(config.name)
    setPlaywrightEnvsetId(config.playwrightEnvsetId)
    setTargetUrls(config.targetUrls)
    // A saved config's URLs are somebody's deliberate values, not an envset's
    // seed — so a later envset switch must never overwrite them.
    seededUrls.current = {}
    setError(null)
  }, [])

  const startNewConfig = useCallback((): void => {
    setSelectedConfigId(null)
    setName('')
    setTargetUrls(defaultTargetUrls)
    seededUrls.current = defaultTargetUrls
    setError(null)
  }, [defaultTargetUrls])

  const save = useCallback(async (): Promise<void> => {
    if (!name.trim()) {
      setError('Configuration name is required.')
      return
    }
    if (!playwrightEnvsetId) {
      setError('Choose an envset.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const body = { name: name.trim(), targetUrls, playwrightEnvsetId }
      const saved = selectedConfigId
        ? await api.updateVerificationConfig(feature, selectedConfigId, body)
        : await api.createVerificationConfig(feature, body)
      setConfigs((prev) => {
        const idx = prev.findIndex((config) => config.id === saved.id)
        if (idx === -1) return [...prev, saved]
        const next = prev.slice()
        next[idx] = saved
        return next
      })
      setSelectedConfigId(saved.id)
      setName(saved.name)
      setPlaywrightEnvsetId(saved.playwrightEnvsetId)
      setTargetUrls(saved.targetUrls)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }, [feature, name, playwrightEnvsetId, selectedConfigId, targetUrls])

  const start = useCallback(async (): Promise<void> => {
    if (!playwrightEnvsetId) {
      setError('Choose an envset.')
      return
    }
    setStarting(true)
    setError(null)
    try {
      await onStart({
        ...(selectedConfigId ? { configId: selectedConfigId } : {}),
        playwrightEnvsetId,
        targetUrls,
      })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed to start')
    } finally {
      setStarting(false)
    }
  }, [onClose, onStart, playwrightEnvsetId, selectedConfigId, targetUrls])

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Verify deployment"
      title={feature}
      // The two mode facts used to be green chips in the header. Green means
      // "verified" everywhere else in the app, and these say what verification
      // does NOT do — so they belong in the purpose line, as prose.
      description="Health-checks a deployed environment, then runs the suite against it. No local boot, no healing."
      width={580}
      testId="verification-dialog"
      footer={(
        <div className="flex w-full items-center justify-between gap-3">
          <span className="min-w-0 truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {selectedConfig
              ? <>Using <span style={{ color: 'var(--text-primary)' }}>{selectedConfig.name}</span></>
              : 'Unsaved verification settings'}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <button type="button" onClick={onClose} className="cl-button px-3 py-1 text-xs">Cancel</button>
            <button
              type="button"
              data-testid="verification-start"
              onClick={() => void start()}
              disabled={Boolean(disabled) || starting || loading}
              title={disabled ? disabledReason : undefined}
              className="cl-button-primary px-3.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
            >
              {starting ? 'Starting…' : 'Start verify'}
            </button>
          </span>
        </div>
      )}
    >
      {loading ? (
        <div className="p-4 text-xs" style={{ color: 'var(--text-muted)' }}>Loading verification settings…</div>
      ) : (
        <div className="flex flex-col gap-3 p-4">
          <Section title="Start from">
            <SectionHint>Reuse a saved setup, or start fresh.</SectionHint>
            <select
              aria-label="Start from"
              value={selectedConfigId ?? ''}
              onChange={(e) => {
                const id = e.target.value
                if (!id) {
                  startNewConfig()
                  return
                }
                const config = configs.find((item) => item.id === id)
                if (config) selectConfig(config)
              }}
              className="themed-select cl-input mt-2 w-full px-2.5 py-1.5 pr-8 text-xs"
            >
              <option value="">New configuration</option>
              {configs.map((config) => (
                <option key={config.id} value={config.id}>{config.name}</option>
              ))}
            </select>
          </Section>

          <Section
            title="Services"
            right={targets.length > 0 ? (
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {configuredTargetCount} of {targets.length} with a URL
              </span>
            ) : undefined}
          >
            <SectionHint>Health-check URL for each service.</SectionHint>
            {targets.length === 0 ? (
              <div
                className="mt-2 rounded-md border border-dashed px-3 py-3 text-[11.5px]"
                style={{ borderColor: 'var(--border-default)', color: 'var(--text-muted)' }}
              >
                No services discovered.
              </div>
            ) : (
              // Rows sit on the section's own surface — hairline dividers, no
              // per-row slab — the app's list anatomy (see the flight
              // launcher's stage list).
              <div className="mt-2 overflow-hidden rounded-md border" style={{ borderColor: 'var(--border-default)' }}>
                {targets.map((target, i) => (
                  <label
                    key={target.id}
                    className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 ${i > 0 ? 'border-t' : ''}`}
                    style={{ borderColor: 'var(--border-default)' }}
                  >
                    <span
                      className="w-[150px] shrink-0 truncate text-[12px]"
                      style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}
                      title={target.name}
                    >
                      {target.name}
                    </span>
                    <input
                      value={targetUrls[target.id] ?? ''}
                      onChange={(e) => setTargetUrls((prev) => ({ ...prev, [target.id]: e.target.value }))}
                      placeholder="https://service.example.com/health"
                      aria-label={`Health-check URL for ${target.name}`}
                      spellCheck={false}
                      className="cl-input min-w-[180px] flex-1 px-2.5 py-1.5 text-[11.5px]"
                      style={{ fontFamily: 'var(--font-mono)' }}
                    />
                  </label>
                ))}
              </div>
            )}
          </Section>

          {/* "Envset" is the app's own noun for this thing — the Envsets config
              tab creates them and the sibling Run menu picks one with "Choose
              envset". It also no longer only feeds Playwright:
              `deriveVerificationTargets` reads the envset to work out which
              services exist and what env var each URL is injected as, so this
              picker drives the Services list above too. */}
          <Section title="Envset">
            <SectionHint>Which env file the tests run with — it also decides which services appear above.</SectionHint>
            <select
              aria-label="Envset"
              value={playwrightEnvsetId}
              onChange={(e) => setPlaywrightEnvsetId(e.target.value)}
              className="themed-select cl-input mt-2 w-full px-2.5 py-1.5 pr-8 text-xs"
              disabled={envs.length === 0}
            >
              {envs.length === 0 ? (
                <option value="">No envsets configured</option>
              ) : envs.map((env) => (
                <option key={env} value={env}>{env}</option>
              ))}
            </select>
          </Section>

          <Section title="Save this setup">
            <SectionHint>
              {selectedConfigId ? 'Updates the loaded configuration.' : 'Name it to reuse later (optional).'}
            </SectionHint>
            <div className="mt-2 flex gap-2">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Beta, Staging, Production…"
                aria-label="Configuration name"
                className="cl-input min-w-0 flex-1 px-2.5 py-1.5 text-xs"
              />
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving}
                className="cl-button shrink-0 px-3 py-1.5 text-xs disabled:cursor-wait disabled:opacity-60"
              >
                {saving ? 'Saving…' : selectedConfigId ? 'Update' : 'Save'}
              </button>
            </div>
          </Section>

          {error && (
            <div
              data-testid="verification-error"
              className="rounded border px-2.5 py-2 text-[11.5px]"
              style={{ borderColor: 'color-mix(in srgb, var(--danger) 40%, var(--border-default))', color: 'var(--danger)' }}
            >
              {error}
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

/** Fold a newly-picked envset's seeded URLs into the form.
 *
 *  A target still holding what the previous envset put there — or holding
 *  nothing — takes the new envset's value, so switching `local` → `staging`
 *  actually swaps the URLs. Anything else is the user's (typed by hand, or
 *  loaded from a saved config, which seeds `previousSeed` as empty) and
 *  survives untouched. A stale URL the previous envset seeded for a target the
 *  new one doesn't know about is dropped rather than left behind pointing at
 *  the wrong environment.
 *
 *  Exported for direct unit tests — the merge rule is the whole behavior. */
export function reseedTargetUrls(
  current: Record<string, string>,
  previousSeed: Record<string, string>,
  nextSeed: Record<string, string>,
): Record<string, string> {
  const next = { ...current }
  for (const [id, url] of Object.entries(nextSeed)) {
    const held = current[id]
    if (held === undefined || held === '' || held === previousSeed[id]) next[id] = url
  }
  for (const [id, url] of Object.entries(previousSeed)) {
    if (!(id in nextSeed) && current[id] === url) delete next[id]
  }
  return next
}

/** The one-line purpose note under a section's title. */
function SectionHint({ children }: { children: ReactNode }) {
  return <p className="text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>{children}</p>
}
