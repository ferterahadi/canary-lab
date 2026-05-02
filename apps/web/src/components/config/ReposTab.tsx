import { useEffect, useState } from 'react'
import * as api from '../../api/client'
import type { ConfigValue, ParsedConfigDoc } from '../../api/client'
import {
  ChevronRightIcon,
  ComplexValueBadge,
  FieldRow,
  IconButton,
  NumberInput,
  PlusIcon,
  SectionHeader,
  Select,
  TextInput,
  TrashIcon,
} from './atoms'
import { FolderPicker, FolderPickerModal } from './FolderPicker'
import { SaveBar } from './SaveBar'
import { useEditableSlice } from './useEditableSlice'

/** Derive a repo's display name from its localPath basename, falling back
 *  to the cloneUrl basename (strip `.git`). Returns '' if neither yields one. */
function deriveRepoName(localPath: ProbePath, cloneUrl: string | undefined): string {
  if (typeof localPath === 'string' && localPath.trim()) {
    const base = localPath.replace(/\/$/, '').split('/').pop()
    if (base) return base
  }
  if (cloneUrl) {
    const match = /([^/:]+?)(?:\.git)?\/?$/.test(cloneUrl)
      ? cloneUrl.replace(/\/$/, '').replace(/\.git$/, '').split(/[/:]/).pop()
      : null
    if (match) return match
  }
  return ''
}

// ─── slice types ─────────────────────────────────────────────────────────

type ProbePath = string | { $expr: string }

interface HttpProbe { url: string; timeoutMs?: number; deadlineMs?: number }
interface TcpProbe { port: number; host?: string; timeoutMs?: number; deadlineMs?: number }
type Probe = { type: 'http'; http: HttpProbe } | { type: 'tcp'; tcp: TcpProbe }

type Health =
  | { mode: 'none' }
  | { mode: 'single'; probe: Probe }
  | { mode: 'per-env'; byEnv: Record<string, Probe> }

interface CommandSlice {
  name: string
  command: string
  envs?: string[]
  health: Health
}

interface RepoSlice {
  name: string
  localPath: ProbePath
  cloneUrl?: string
  envs?: string[]
  startCommands: CommandSlice[]
}

// ─── parsers ──────────────────────────────────────────────────────────────

function parseProbe(v: ConfigValue | undefined): Probe | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const obj = v as { [k: string]: ConfigValue }
  if ('http' in obj && obj.http && typeof obj.http === 'object' && !Array.isArray(obj.http)) {
    const h = obj.http as { [k: string]: ConfigValue }
    return {
      type: 'http',
      http: {
        url: typeof h.url === 'string' ? h.url : '',
        ...(typeof h.timeoutMs === 'number' ? { timeoutMs: h.timeoutMs } : {}),
        ...(typeof h.deadlineMs === 'number' ? { deadlineMs: h.deadlineMs } : {}),
      },
    }
  }
  if ('tcp' in obj && obj.tcp && typeof obj.tcp === 'object' && !Array.isArray(obj.tcp)) {
    const t = obj.tcp as { [k: string]: ConfigValue }
    return {
      type: 'tcp',
      tcp: {
        port: typeof t.port === 'number' ? t.port : 0,
        ...(typeof t.host === 'string' ? { host: t.host } : {}),
        ...(typeof t.timeoutMs === 'number' ? { timeoutMs: t.timeoutMs } : {}),
        ...(typeof t.deadlineMs === 'number' ? { deadlineMs: t.deadlineMs } : {}),
      },
    }
  }
  return null
}

function parseHealth(v: ConfigValue | undefined): Health {
  if (!v) return { mode: 'none' }
  const single = parseProbe(v)
  if (single) return { mode: 'single', probe: single }
  if (typeof v === 'object' && !Array.isArray(v)) {
    const byEnv: Record<string, Probe> = {}
    for (const [k, child] of Object.entries(v)) {
      const p = parseProbe(child)
      if (p) byEnv[k] = p
    }
    if (Object.keys(byEnv).length > 0) return { mode: 'per-env', byEnv }
  }
  return { mode: 'none' }
}

function parseCommand(v: ConfigValue): CommandSlice | null {
  if (typeof v === 'string') {
    return { name: '', command: v, health: { mode: 'none' } }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const obj = v as { [k: string]: ConfigValue }
  return {
    name: typeof obj.name === 'string' ? obj.name : '',
    command: typeof obj.command === 'string' ? obj.command : '',
    envs: Array.isArray(obj.envs)
      ? obj.envs.filter((x): x is string => typeof x === 'string')
      : undefined,
    health: parseHealth(obj.healthCheck),
  }
}

function parseRepo(v: ConfigValue): RepoSlice | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const obj = v as { [k: string]: ConfigValue }
  const lp = obj.localPath
  const localPath: ProbePath = (() => {
    if (typeof lp === 'string') return lp
    if (lp && typeof lp === 'object' && !Array.isArray(lp) && '$expr' in lp) {
      return { $expr: (lp as { $expr: string }).$expr }
    }
    return ''
  })()
  return {
    name: typeof obj.name === 'string' ? obj.name : '',
    localPath,
    cloneUrl: typeof obj.cloneUrl === 'string' ? obj.cloneUrl : undefined,
    envs: Array.isArray(obj.envs)
      ? obj.envs.filter((x): x is string => typeof x === 'string')
      : undefined,
    startCommands: Array.isArray(obj.startCommands)
      ? obj.startCommands.map(parseCommand).filter((c): c is CommandSlice => c != null)
      : [],
  }
}

// ─── serializers ──────────────────────────────────────────────────────────

function serializeProbe(p: Probe): ConfigValue {
  if (p.type === 'http') {
    const out: { [k: string]: ConfigValue } = { url: p.http.url }
    if (p.http.timeoutMs != null) out.timeoutMs = p.http.timeoutMs
    if (p.http.deadlineMs != null) out.deadlineMs = p.http.deadlineMs
    return { http: out }
  }
  const out: { [k: string]: ConfigValue } = { port: p.tcp.port }
  if (p.tcp.host) out.host = p.tcp.host
  if (p.tcp.timeoutMs != null) out.timeoutMs = p.tcp.timeoutMs
  if (p.tcp.deadlineMs != null) out.deadlineMs = p.tcp.deadlineMs
  return { tcp: out }
}

function serializeHealth(h: Health): ConfigValue | undefined {
  if (h.mode === 'none') return undefined
  if (h.mode === 'single') return serializeProbe(h.probe)
  const out: { [k: string]: ConfigValue } = {}
  for (const [k, p] of Object.entries(h.byEnv)) out[k] = serializeProbe(p)
  return out
}

function serializeCommand(c: CommandSlice): ConfigValue {
  const out: { [k: string]: ConfigValue } = { command: c.command }
  if (c.name) out.name = c.name
  if (c.envs && c.envs.length > 0) out.envs = c.envs
  const hc = serializeHealth(c.health)
  if (hc !== undefined) out.healthCheck = hc
  return out
}

function serializeRepo(r: RepoSlice): ConfigValue {
  const out: { [k: string]: ConfigValue } = {
    name: r.name,
    localPath: r.localPath as ConfigValue,
  }
  if (r.cloneUrl) out.cloneUrl = r.cloneUrl
  if (r.envs && r.envs.length > 0) out.envs = r.envs
  if (r.startCommands.length > 0) out.startCommands = r.startCommands.map(serializeCommand)
  return out
}

// ─── component ────────────────────────────────────────────────────────────

interface Slice {
  repos: RepoSlice[]
  rootEnvs: string[] // top-level envs[] used for the per-env health-check editor
}

export function ReposTab({ feature }: { feature: string }) {
  const ed = useEditableSlice<ParsedConfigDoc, Slice>({
    load: () => api.getFeatureConfigDoc(feature),
    extract: (doc) => {
      const v = (doc.parsed.value ?? {}) as { [k: string]: ConfigValue }
      const repos = Array.isArray(v.repos)
        ? v.repos.map(parseRepo).filter((r): r is RepoSlice => r != null)
        : []
      const rootEnvs = Array.isArray(v.envs)
        ? v.envs.filter((x): x is string => typeof x === 'string')
        : []
      return { repos, rootEnvs }
    },
    merge: (doc, slice) => {
      const current = (doc.parsed.value ?? {}) as { [k: string]: ConfigValue }
      const repos = slice.repos.map(serializeRepo)
      return { ...current, repos }
    },
    save: (payload) => api.putFeatureConfigDoc(feature, payload as ConfigValue),
    deps: [feature],
  })

  if (ed.error && !ed.draft) {
    return <div className="p-4 text-xs" style={{ color: '#ef4444' }}>{ed.error}</div>
  }
  if (ed.loading || !ed.draft) {
    return <div className="p-4 text-xs" style={{ color: 'var(--text-muted)' }}>Loading…</div>
  }

  const { repos, rootEnvs } = ed.draft

  const addRepo = (): void => {
    ed.setDraft((d) => ({
      ...d,
      repos: [
        ...d.repos,
        {
          name: '',
          localPath: '',
          startCommands: [{ name: '', command: '', health: { mode: 'none' } }],
        },
      ],
    }))
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
        <SectionHeader>Repositories</SectionHeader>
        <div className="px-4 py-3 flex flex-col gap-3">
          {repos.length === 0 && (
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>No repositories configured.</div>
          )}
          {repos.map((repo, i) => (
            <RepoCard
              key={i}
              repo={repo}
              rootEnvs={rootEnvs}
              onChange={(next) => ed.setDraft((d) => ({
                ...d,
                repos: d.repos.map((r, j) => j === i ? next : r),
              }))}
              onRemove={() => ed.setDraft((d) => ({
                ...d,
                repos: d.repos.filter((_, j) => j !== i),
              }))}
            />
          ))}
          <button
            type="button"
            onClick={addRepo}
            className="self-start inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[11px] uppercase tracking-wider transition-colors duration-150"
            style={{ color: 'var(--text-muted)', border: '1px dashed var(--border-default)' }}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-primary)' }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)' }}
          >
            <PlusIcon />
            Add repository
          </button>
        </div>
      </div>

      <SaveBar
        dirty={ed.dirty}
        saving={ed.saving}
        error={ed.error}
        savedAt={ed.savedAt}
        onSave={ed.doSave}
        onDiscard={ed.discard}
      />
    </div>
  )
}

// ─── repo card ────────────────────────────────────────────────────────────

function RepoCard({
  repo,
  rootEnvs,
  onChange,
  onRemove,
}: {
  repo: RepoSlice
  rootEnvs: string[]
  onChange: (next: RepoSlice) => void
  onRemove: () => void
}) {
  const [open, setOpen] = useState(true)
  const [pathExists, setPathExists] = useState<boolean | null>(null)
  const [cloneError, setCloneError] = useState<string | null>(null)
  const [cloning, setCloning] = useState(false)
  const [cloneTargetOpen, setCloneTargetOpen] = useState(false)

  const derivedName = deriveRepoName(repo.localPath, repo.cloneUrl)
  const isExpr = typeof repo.localPath === 'object' && repo.localPath != null && '$expr' in repo.localPath
  const localPathStr = typeof repo.localPath === 'string' ? repo.localPath : ''

  // Probe whether the configured localPath actually exists on this machine.
  // Drives the "missing folder — clone?" warning below.
  useEffect(() => {
    if (isExpr || !localPathStr) {
      setPathExists(null)
      return
    }
    let cancelled = false
    api.checkPathExists(localPathStr)
      .then((r) => { if (!cancelled) setPathExists(r.exists) })
      .catch(() => { if (!cancelled) setPathExists(null) })
    return () => { cancelled = true }
  }, [isExpr, localPathStr])

  // When the user picks a localPath that has a .git/config, prefill cloneUrl.
  const handleLocalPathChange = (absolutePath: string): void => {
    const nextName = deriveRepoName(absolutePath, repo.cloneUrl)
    const next: RepoSlice = { ...repo, localPath: absolutePath, name: nextName }
    onChange(next)
    if (!repo.cloneUrl) {
      api.getGitRemote(absolutePath)
        .then((r) => {
          if (r.cloneUrl) onChange({ ...next, cloneUrl: r.cloneUrl })
        })
        .catch(() => { /* ignore; field stays editable */ })
    }
  }

  const handleClone = async (parentDir: string): Promise<void> => {
    if (!repo.cloneUrl) return
    const repoName = deriveRepoName(repo.localPath, repo.cloneUrl) || 'repo'
    setCloning(true)
    setCloneError(null)
    try {
      const r = await api.cloneRepository({ cloneUrl: repo.cloneUrl, parentDir, repoName })
      onChange({ ...repo, localPath: r.localPath, name: deriveRepoName(r.localPath, repo.cloneUrl) })
      setPathExists(true)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'clone failed'
      setCloneError(msg)
    } finally {
      setCloning(false)
      setCloneTargetOpen(false)
    }
  }

  return (
    <div className="rounded-md" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}>
      <header
        className="flex items-center gap-2 px-3 py-2"
        style={{ borderBottom: open ? '1px solid var(--border-default)' : 'none' }}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? 'Collapse' : 'Expand'}
          className="inline-flex h-5 w-5 items-center justify-center rounded transition-transform duration-150"
          style={{ color: 'var(--text-muted)', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
        >
          <ChevronRightIcon />
        </button>
        <span className="flex-1 truncate text-sm font-medium" style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
          {repo.name || derivedName || '(unnamed repo)'}
        </span>
        <IconButton ariaLabel="Remove repo" variant="danger" onClick={onRemove}>
          <TrashIcon />
        </IconButton>
      </header>

      {open && (
        <div className="px-3 pb-3">
          <FieldRow label="Local path" hint="Click to pick a folder">
            {isExpr ? (
              <div className="flex items-center gap-2">
                <ComplexValueBadge source={(repo.localPath as { $expr: string }).$expr} />
                <button
                  type="button"
                  onClick={() => onChange({ ...repo, localPath: '' })}
                  className="rounded-md px-2 py-1 text-[10px] uppercase tracking-wider"
                  style={{ color: 'var(--text-muted)', border: '1px solid var(--border-default)' }}
                >
                  Override
                </button>
              </div>
            ) : (
              <FolderPicker value={localPathStr} onChange={handleLocalPathChange} />
            )}
          </FieldRow>

          {pathExists === false && repo.cloneUrl && !isExpr && (
            <div
              className="mt-1 mb-2 flex items-center gap-2 rounded-md px-2.5 py-2 text-[11px]"
              style={{
                background: 'color-mix(in srgb, #f59e0b 8%, transparent)',
                border: '1px solid color-mix(in srgb, #f59e0b 40%, transparent)',
                color: '#f59e0b',
              }}
            >
              <span className="flex-1">Folder not found on this machine.</span>
              <button
                type="button"
                disabled={cloning}
                onClick={() => setCloneTargetOpen(true)}
                className="rounded-md px-2 py-1 text-[10px] uppercase tracking-wider"
                style={{
                  color: '#f59e0b',
                  border: '1px solid color-mix(in srgb, #f59e0b 50%, transparent)',
                  opacity: cloning ? 0.5 : 1,
                }}
              >
                {cloning ? 'Cloning…' : 'Clone…'}
              </button>
            </div>
          )}
          {cloneError && (
            <div className="mt-1 mb-2 text-[10px]" style={{ color: '#ef4444' }}>{cloneError}</div>
          )}
          {cloneTargetOpen && (
            <FolderPickerModal
              initialPath=""
              title={`Choose parent folder for ${deriveRepoName(repo.localPath, repo.cloneUrl) || 'repo'}`}
              confirmLabel="Clone here"
              onCancel={() => setCloneTargetOpen(false)}
              onConfirm={handleClone}
            />
          )}

          <FieldRow label="Clone URL" hint="Auto-filled from .git/config when present">
            <TextInput
              value={repo.cloneUrl ?? ''}
              placeholder="git@github.com:org/repo.git"
              onChange={(s) => onChange({ ...repo, cloneUrl: s || undefined })}
            />
          </FieldRow>

          <div className="mt-3 mb-1 text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
            Start command
          </div>
          <div className="flex flex-col gap-2">
            {repo.startCommands.map((cmd, i) => (
              <CommandCard
                key={i}
                cmd={cmd}
                rootEnvs={rootEnvs}
                onChange={(next) => onChange({
                  ...repo,
                  startCommands: repo.startCommands.map((c, j) => j === i ? next : c),
                })}
                onRemove={() => onChange({
                  ...repo,
                  startCommands: repo.startCommands.filter((_, j) => j !== i),
                })}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function CommandCard({
  cmd,
  rootEnvs,
  onChange,
  onRemove,
}: {
  cmd: CommandSlice
  rootEnvs: string[]
  onChange: (next: CommandSlice) => void
  onRemove: () => void
}) {
  return (
    <div
      className="rounded-md p-2.5"
      style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }}
    >
      <FieldRow label="Command" hint="Runs in the repo's local path. Chain with && for multiple steps.">
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <TextInput
              value={cmd.command}
              placeholder="npx tsx scripts/server.ts"
              onChange={(command) => onChange({ ...cmd, command })}
            />
          </div>
          <IconButton ariaLabel="Remove command" variant="danger" onClick={onRemove}>
            <TrashIcon />
          </IconButton>
        </div>
      </FieldRow>
      <div className="mt-2">
        <HealthEditor
          health={cmd.health}
          rootEnvs={rootEnvs}
          onChange={(health) => onChange({ ...cmd, health })}
        />
      </div>
    </div>
  )
}

// ─── health-check editor ─────────────────────────────────────────────────

function HealthEditor({
  health,
  rootEnvs,
  onChange,
}: {
  health: Health
  rootEnvs: string[]
  onChange: (next: Health) => void
}) {
  const modeOptions: ReadonlyArray<{ value: Health['mode']; label: string }> = [
    { value: 'none', label: 'No health check' },
    { value: 'single', label: 'Single probe' },
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
      <div className="flex items-center gap-2 px-2.5 py-1.5" style={{ borderBottom: health.mode === 'none' ? 'none' : '1px solid var(--border-default)' }}>
        <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>health check</span>
        <Select<Health['mode']>
          value={health.mode}
          onChange={setMode}
          options={modeOptions}
        />
      </div>
      {health.mode === 'single' && (
        <div className="px-2.5 py-2">
          <ProbeEditor probe={health.probe} onChange={(probe) => onChange({ mode: 'single', probe })} />
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

function ProbeEditor({
  probe,
  onChange,
}: {
  probe: Probe
  onChange: (next: Probe) => void
}) {
  const switchType = (t: 'http' | 'tcp'): void => {
    if (t === probe.type) return
    if (t === 'http') onChange({ type: 'http', http: { url: '' } })
    else onChange({ type: 'tcp', tcp: { port: 0 } })
  }
  return (
    <div>
      <div className="mb-2 inline-flex rounded-md" style={{ border: '1px solid var(--border-default)' }}>
        {(['http', 'tcp'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => switchType(t)}
            className="px-2.5 py-1 text-[10px] uppercase tracking-wider"
            style={{
              color: probe.type === t ? 'var(--text-primary)' : 'var(--text-muted)',
              background: probe.type === t ? 'var(--bg-elevated)' : 'transparent',
            }}
          >
            {t}
          </button>
        ))}
      </div>
      {probe.type === 'http' ? (
        <div className="flex flex-col gap-1.5">
          <FieldRow label="URL" layout="inline">
            <TextInput
              value={probe.http.url}
              placeholder="http://localhost:4000/"
              onChange={(url) => onChange({ ...probe, http: { ...probe.http, url } })}
            />
          </FieldRow>
          <FieldRow label="Timeout (ms)" layout="inline">
            <NumberInput
              value={probe.http.timeoutMs ?? 1500}
              onChange={(n) => onChange({ ...probe, http: { ...probe.http, timeoutMs: n } })}
            />
          </FieldRow>
          <FieldRow label="Deadline (ms)" layout="inline">
            <NumberInput
              value={probe.http.deadlineMs ?? 60000}
              onChange={(n) => onChange({ ...probe, http: { ...probe.http, deadlineMs: n } })}
            />
          </FieldRow>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <FieldRow label="Port" layout="inline">
            <NumberInput
              value={probe.tcp.port}
              onChange={(port) => onChange({ ...probe, tcp: { ...probe.tcp, port } })}
            />
          </FieldRow>
          <FieldRow label="Host" layout="inline">
            <TextInput
              value={probe.tcp.host ?? ''}
              placeholder="127.0.0.1"
              onChange={(host) => onChange({ ...probe, tcp: { ...probe.tcp, host: host || undefined } })}
            />
          </FieldRow>
          <FieldRow label="Timeout (ms)" layout="inline">
            <NumberInput
              value={probe.tcp.timeoutMs ?? 1500}
              onChange={(n) => onChange({ ...probe, tcp: { ...probe.tcp, timeoutMs: n } })}
            />
          </FieldRow>
        </div>
      )}
    </div>
  )
}
