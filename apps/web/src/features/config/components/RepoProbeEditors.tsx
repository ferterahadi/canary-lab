import { FieldRow, HintIcon, NumberInput, Segmented } from '@/shared/ui/atoms'
import { TemplatedInput } from './TemplatedInput'
import { Disclosure } from './RepoCard'
import type { Health, Probe } from './repo-slice'

// ─── health-check editor ─────────────────────────────────────────────────

export function HealthEditor({
  feature,
  health,
  rootEnvs,
  onChange,
}: {
  feature: string
  health: Health
  rootEnvs: string[]
  onChange: (next: Health) => void
}) {
  const modeOptions: ReadonlyArray<{ value: Health['mode']; label: string }> = [
    { value: 'none', label: 'Off' },
    { value: 'single', label: 'Single' },
    ...(rootEnvs.length > 1 ? [{ value: 'per-env' as const, label: 'Per env' }] : []),
  ]

  const setMode = (mode: Health['mode']): void => {
    if (mode === 'none') onChange({ mode: 'none' })
    if (mode === 'single') onChange({
      mode: 'single',
      probe: health.mode === 'single'
        ? health.probe
        : { type: 'http', http: { url: '' } },
    })
    if (mode === 'per-env') onChange({
      mode: 'per-env',
      byEnv: health.mode === 'per-env'
        ? health.byEnv
        : Object.fromEntries(rootEnvs.map((e) => [e, { type: 'http', http: { url: '' } } as Probe])),
    })
  }

  return (
    <div className="rounded-md" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}>
      <div className="flex items-center justify-between gap-2 px-2.5 py-1.5" style={{ borderBottom: health.mode === 'none' ? 'none' : '1px solid var(--border-default)' }}>
        <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
          health check
          <HintIcon
            label="What is health check?"
            hint="A probe the runner uses to decide when this service is ready. Playwright tests start only after every health check passes; if a probe fails before its deadline, the run aborts."
          />
        </span>
        <Segmented<Health['mode']>
          ariaLabel="Health check mode"
          value={health.mode}
          onChange={setMode}
          options={modeOptions}
        />
      </div>
      {health.mode === 'single' && (
        <div className="px-2.5 py-2">
          <ProbeEditor feature={feature} probe={health.probe} onChange={(probe) => onChange({ mode: 'single', probe })} />
        </div>
      )}
      {health.mode === 'per-env' && (
        <div className="flex flex-col">
          {Object.entries(health.byEnv).map(([env, p]) => (
            <div key={env} className="px-2.5 py-2" style={{ borderBottom: '1px solid var(--border-default)' }}>
              <div className="mb-1.5 text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
                {env}
              </div>
              <ProbeEditor
                feature={feature}
                probe={p}
                onChange={(probe) => onChange({
                  mode: 'per-env',
                  byEnv: { ...health.byEnv, [env]: probe },
                })}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function ProbeEditor({
  feature,
  probe,
  onChange,
}: {
  feature: string
  probe: Probe
  onChange: (next: Probe) => void
}) {
  const switchType = (t: 'http' | 'tcp'): void => {
    if (t === probe.type) return
    if (t === 'http') onChange({ type: 'http', http: { url: '' } })
    else onChange({ type: 'tcp', tcp: { port: 0 } })
  }
  // The type toggle prefixes the address field so "what kind of probe + where"
  // reads as one left-to-right unit instead of two stacked rows.
  const typeToggle = (
    <Segmented<'http' | 'tcp'>
      ariaLabel="Probe type"
      value={probe.type}
      onChange={switchType}
      options={[
        { value: 'http', label: 'HTTP' },
        { value: 'tcp', label: 'TCP' },
      ]}
    />
  )
  return probe.type === 'http' ? (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        {typeToggle}
        <span className="flex-1">
          <TemplatedInput
            value={probe.http.url}
            feature={feature}
            placeholder="http://localhost:4000/"
            onChange={(url) => onChange({ ...probe, http: { ...probe.http, url } })}
          />
        </span>
      </div>
      <Disclosure
        title="Advanced"
        defaultOpen={false}
        summary={`${probe.http.timeoutMs ?? 1500}ms per try · ${probe.http.deadlineMs ?? 60000}ms total`}
      >
        <FieldRow
          label="Timeout (ms)"
          layout="inline"
          labelWidth={104}
          hint="How long to wait for a single probe attempt before treating it as failed. Lower = fail-fast per try."
        >
          <NumberInput
            value={probe.http.timeoutMs ?? 1500}
            min={0}
            onChange={(n) => onChange({ ...probe, http: { ...probe.http, timeoutMs: n } })}
          />
        </FieldRow>
        <FieldRow
          label="Deadline (ms)"
          layout="inline"
          labelWidth={104}
          hint="Total budget to keep retrying the probe until it succeeds. If the service isn't ready by then, the run aborts."
        >
          <NumberInput
            value={probe.http.deadlineMs ?? 60000}
            min={0}
            onChange={(n) => onChange({ ...probe, http: { ...probe.http, deadlineMs: n } })}
          />
        </FieldRow>
      </Disclosure>
    </div>
  ) : (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        {typeToggle}
        <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>port</span>
        <span style={{ width: 120 }}>
          <NumberInput
            value={probe.tcp.port}
            min={1}
            max={65535}
            onChange={(port) => onChange({ ...probe, tcp: { ...probe.tcp, port } })}
          />
        </span>
      </div>
      <FieldRow label="Host" layout="inline" labelWidth={56}>
        <TemplatedInput
          value={probe.tcp.host ?? ''}
          feature={feature}
          placeholder="127.0.0.1"
          onChange={(host) => onChange({ ...probe, tcp: { ...probe.tcp, host: host || undefined } })}
        />
      </FieldRow>
      <Disclosure
        title="Advanced"
        defaultOpen={false}
        summary={`${probe.tcp.timeoutMs ?? 1500}ms per try`}
      >
        <FieldRow
          label="Timeout (ms)"
          layout="inline"
          labelWidth={104}
          hint="How long to wait for a single TCP connect attempt before treating it as failed."
        >
          <NumberInput
            value={probe.tcp.timeoutMs ?? 1500}
            min={0}
            onChange={(n) => onChange({ ...probe, tcp: { ...probe.tcp, timeoutMs: n } })}
          />
        </FieldRow>
      </Disclosure>
    </div>
  )
}
