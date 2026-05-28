import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import * as api from '../api/client'
import type { VerificationConfig, VerificationTarget } from '../api/types'
import { CloseIcon } from './config/atoms'

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
}

export function VerificationDialog({
  feature,
  envs,
  disabled,
  disabledReason,
  onClose,
  onStart,
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
      } else {
        setSelectedConfigId(null)
        setName('')
        setTargetUrls(targetIndex.targetUrls)
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

  useEffect(() => {
    if (!playwrightEnvsetId) return
    let cancelled = false
    api.getVerificationTargets(feature, playwrightEnvsetId)
      .then((targetIndex) => {
        if (cancelled) return
        setTargets(targetIndex.targets)
        setDefaultTargetUrls(targetIndex.targetUrls)
        setTargetUrls((prev) => ({ ...targetIndex.targetUrls, ...prev }))
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [feature, playwrightEnvsetId])

  const selectConfig = useCallback((config: VerificationConfig): void => {
    setSelectedConfigId(config.id)
    setName(config.name)
    setPlaywrightEnvsetId(config.playwrightEnvsetId)
    setTargetUrls(config.targetUrls)
    setError(null)
  }, [])

  const startNewConfig = useCallback((): void => {
    setSelectedConfigId(null)
    setName('')
    setTargetUrls(defaultTargetUrls)
    setError(null)
  }, [defaultTargetUrls])

  const save = useCallback(async (): Promise<void> => {
    if (!name.trim()) {
      setError('Configuration name is required.')
      return
    }
    if (!playwrightEnvsetId) {
      setError('Choose a Playwright envset.')
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
      setError('Choose a Playwright envset.')
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
    <div className="cl-modal-backdrop absolute inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      <div className="cl-modal cl-verify-modal flex max-h-[90vh] flex-col overflow-hidden p-0">
        <div className="cl-verify-header flex items-start justify-between gap-4 px-5 py-4 sm:px-6">
          <div className="min-w-0">
            <div className="cl-rubric">Deployment check</div>
            <h2 className="mt-1 truncate text-base font-semibold" style={{ color: 'var(--text-primary)' }}>Verify deployment</h2>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
              <span className="truncate text-xs" style={{ color: 'var(--text-muted)' }}>{feature}</span>
              <span className="cl-verify-mode-chip">No local boot</span>
              <span className="cl-verify-mode-chip">No healing</span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close verify deployment"
            className="cl-icon-button h-8 w-8 shrink-0"
          >
            <CloseIcon size={14} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto text-sm scrollbar-thin">
          {loading ? (
            <div className="px-6 py-10 text-xs" style={{ color: 'var(--text-muted)' }}>Loading verification settings...</div>
          ) : (
            <div className="space-y-4 p-4 sm:p-5">
              <section className="cl-verify-section">
                <SectionTitle>Start from</SectionTitle>
                <p className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>Reuse a saved setup, or start fresh.</p>
                <select
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
                  className="cl-input mt-2 w-full px-3 py-2 text-xs"
                >
                  <option value="">New configuration</option>
                  {configs.map((config) => (
                    <option key={config.id} value={config.id}>{config.name}</option>
                  ))}
                </select>
              </section>

              <section className="cl-verify-section">
                <div className="flex items-center justify-between gap-3">
                  <SectionTitle>Services</SectionTitle>
                  <span className="cl-verify-count">{configuredTargetCount} configured</span>
                </div>
                <p className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>Health-check URL for each service.</p>
                {targets.length === 0 ? (
                  <div className="cl-verify-empty mt-2 rounded-md border border-dashed px-3 py-4 text-xs" style={{ borderColor: 'var(--border-default)', color: 'var(--text-muted)' }}>No services discovered.</div>
                ) : (
                  <div className="mt-2 space-y-2">
                    {targets.map((target) => (
                      <div key={target.id} className="cl-verify-target-row">
                        <div className="min-w-0">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="cl-verify-service-dot" aria-hidden="true" />
                            <div className="truncate text-xs font-semibold" style={{ color: 'var(--text-primary)' }} title={target.name}>{target.name}</div>
                          </div>
                        </div>
                        <input
                          value={targetUrls[target.id] ?? ''}
                          onChange={(e) => setTargetUrls((prev) => ({ ...prev, [target.id]: e.target.value }))}
                          placeholder="https://service.example.com/health"
                          className="cl-input min-w-0 px-3 py-2 text-xs"
                          style={{ fontFamily: 'var(--font-mono)' }}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="cl-verify-section">
                <SectionTitle>Playwright</SectionTitle>
                <p className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>Which env file to run tests with.</p>
                <select
                  value={playwrightEnvsetId}
                  onChange={(e) => setPlaywrightEnvsetId(e.target.value)}
                  className="cl-input mt-2 w-full px-3 py-2 text-xs"
                  disabled={envs.length === 0}
                >
                  {envs.length === 0 ? (
                    <option value="">No envsets configured</option>
                  ) : envs.map((env) => (
                    <option key={env} value={env}>{env}</option>
                  ))}
                </select>
              </section>

              <section className="cl-verify-section">
                <SectionTitle>Save this setup</SectionTitle>
                <p className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {selectedConfigId ? 'Updates the loaded configuration.' : 'Name it to reuse later (optional).'}
                </p>
                <div className="mt-2 flex gap-2">
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Beta, Staging, Production..."
                    className="cl-input min-w-0 flex-1 px-3 py-2 text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => void save()}
                    disabled={saving}
                    className="cl-button px-3 py-2 text-xs disabled:cursor-wait disabled:opacity-60"
                  >
                    {saving ? 'Saving...' : selectedConfigId ? 'Update' : 'Save'}
                  </button>
                </div>
              </section>
            </div>
          )}
          {error && (
            <div className="mx-5 mb-5 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
              {error}
            </div>
          )}
        </div>
        <div className="cl-verify-footer flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 text-xs" style={{ color: 'var(--text-muted)' }}>
            {selectedConfig ? (
              <span className="truncate">Selected config: <span style={{ color: 'var(--text-primary)' }}>{selectedConfig.name}</span></span>
            ) : (
              <span className="truncate">Unsaved verification settings</span>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="cl-button px-3 py-1.5 text-xs">Cancel</button>
            <button
              type="button"
              onClick={() => void start()}
              disabled={Boolean(disabled) || starting || loading}
              title={disabled ? disabledReason : undefined}
              className="cl-button-primary px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-50"
            >
              {starting ? 'Starting...' : 'Start Verify'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
      {children}
    </h3>
  )
}
