import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import * as api from '../../../shared/api/client'
import type { ConfigValue, ParsedConfigDoc } from '../../../shared/api/client'
import {
  ChevronRightIcon,
  ComplexValueBadge,
  FieldRow,
  HintIcon,
  IconButton,
  NumberInput,
  PlusIcon,
  SectionHeader,
  Segmented,
  TextInput,
  TrashIcon,
} from './atoms'
import { FolderPicker, FolderPickerModal } from './FolderPicker'
import { SaveBar } from './SaveBar'
import { TemplatedInput } from './TemplatedInput'
import { useEditableSlice } from './useEditableSlice'
import { useRuns } from '../../runs/state/RunsContext'
import { isActiveRunStatus } from '../../../../../../shared/run-state'

/** Derive a repo's display name from its localPath basename, falling back
 *  to the cloneUrl basename (strip `.git`). Returns '' if neither yields one. */
export function deriveRepoName(localPath: ProbePath, cloneUrl: string | undefined): string {
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

function nextRepoName(
  currentName: string,
  currentDerivedName: string,
  nextLocalPath: ProbePath,
  cloneUrl: string | undefined,
): string {
  return currentName && currentName !== currentDerivedName
    ? currentName
    : deriveRepoName(nextLocalPath, cloneUrl)
}

function sameProbePath(a: ProbePath, b: ProbePath): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b
  return a.$expr === b.$expr
}

// ─── slice types ─────────────────────────────────────────────────────────

export type ProbePath = string | { $expr: string }

interface HttpProbe { url: string; timeoutMs?: number; deadlineMs?: number }
interface TcpProbe { port: number; host?: string; timeoutMs?: number; deadlineMs?: number }
type Probe = { type: 'http'; http: HttpProbe } | { type: 'tcp'; tcp: TcpProbe }

type Health =
  | { mode: 'none' }
  | { mode: 'single'; probe: Probe }
  | { mode: 'per-env'; byEnv: Record<string, Probe> }

export interface PortSlotSlice {
  name: string
  env?: string
}

export interface CommandSlice {
  name: string
  command: string
  envs?: string[]
  ports?: PortSlotSlice[]
  health: Health
}

export interface RepoSlice {
  name: string
  localPath: ProbePath
  cloneUrl?: string
  branch?: string
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

function parsePorts(v: ConfigValue | undefined): PortSlotSlice[] | undefined {
  if (!Array.isArray(v)) return undefined
  const slots = v
    .map((item): PortSlotSlice | null => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null
      const obj = item as { [k: string]: ConfigValue }
      if (typeof obj.name !== 'string') return null
      return {
        name: obj.name,
        ...(typeof obj.env === 'string' ? { env: obj.env } : {}),
      }
    })
    .filter((s): s is PortSlotSlice => s != null)
  return slots.length > 0 ? slots : undefined
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
    ports: parsePorts(obj.ports),
    health: parseHealth(obj.healthCheck),
  }
}

export function parseRepo(v: ConfigValue): RepoSlice | null {
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
    branch: typeof obj.branch === 'string' ? obj.branch : undefined,
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

function serializePorts(ports: PortSlotSlice[] | undefined): ConfigValue | undefined {
  if (!ports) return undefined
  const slots = ports
    .filter((p) => p.name.trim())
    .map((p): ConfigValue => {
      const out: { [k: string]: ConfigValue } = { name: p.name.trim() }
      if (p.env && p.env.trim()) out.env = p.env.trim()
      return out
    })
  return slots.length > 0 ? slots : undefined
}

function serializeCommand(c: CommandSlice): ConfigValue {
  const out: { [k: string]: ConfigValue } = { command: c.command }
  if (c.name) out.name = c.name
  if (c.envs && c.envs.length > 0) out.envs = c.envs
  const ports = serializePorts(c.ports)
  if (ports !== undefined) out.ports = ports
  const hc = serializeHealth(c.health)
  if (hc !== undefined) out.healthCheck = hc
  return out
}

export function serializeRepo(r: RepoSlice): ConfigValue {
  const out: { [k: string]: ConfigValue } = {
    name: r.name,
    localPath: r.localPath as ConfigValue,
  }
  if (r.cloneUrl) out.cloneUrl = r.cloneUrl
  if (r.branch) out.branch = r.branch
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
  const { runs } = useRuns()
  const activeRun = runs.some((run) =>
    run.feature === feature && isActiveRunStatus(run.status))
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
    return <div className="p-4 text-xs" style={{ color: 'var(--danger)' }}>{ed.error}</div>
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
        <SectionHeader>Services</SectionHeader>
        <div className="px-4 py-3 flex flex-col gap-3">
          {repos.length === 0 && (
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>No services configured.</div>
          )}
          {repos.map((repo, i) => {
            const persistedRepo = ed.baseline?.repos.find((r) => sameProbePath(r.localPath, repo.localPath))
            return (
              <RepoCard
                key={i}
                feature={feature}
                repo={repo}
                repoLookupName={persistedRepo?.name}
                rootEnvs={rootEnvs}
                activeRun={activeRun}
                onChange={(next) => ed.setDraft((d) => ({
                  ...d,
                  repos: d.repos.map((r, j) => j === i ? next : r),
                }))}
                onRemove={() => ed.setDraft((d) => ({
                  ...d,
                  repos: d.repos.filter((_, j) => j !== i),
                }))}
              />
            )
          })}
          <button
            type="button"
            onClick={addRepo}
            className="self-start inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[11px] uppercase tracking-wider transition-colors duration-150"
            style={{ color: 'var(--text-muted)', border: '1px dashed var(--border-default)' }}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-primary)' }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)' }}
          >
            <PlusIcon />
            Add Service
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

// ─── layout primitives ─────────────────────────────────────────────────────

/** A collapsible zone with a tree-style left rule when open and a compact
 *  one-line summary when collapsed. Keeps the dense Service form navigable
 *  without nesting boxes inside boxes. */
function Disclosure({
  title,
  summary,
  defaultOpen = true,
  children,
}: {
  title: string
  summary?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 py-1 text-left"
        aria-expanded={open}
      >
        <span
          className="inline-flex h-4 w-4 shrink-0 items-center justify-center transition-transform duration-150"
          style={{ color: 'var(--text-muted)', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
        >
          <ChevronRightIcon />
        </span>
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
          {title}
        </span>
        {!open && summary != null && (
          <span className="ml-2 min-w-0 flex-1 truncate text-[11px]" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            {summary}
          </span>
        )}
      </button>
      {open && (
        <div
          className="mt-1 flex flex-col"
          style={{ marginLeft: 7, paddingLeft: 13, borderLeft: '1px solid var(--border-default)' }}
        >
          {children}
        </div>
      )}
    </div>
  )
}

/** Small mono pill used in the collapsed repo-card overview. */
function Chip({ children, title, tone = 'muted' }: { children: ReactNode; title?: string; tone?: 'muted' | 'accent' }) {
  return (
    <span
      title={title}
      className="inline-flex max-w-[200px] items-center gap-1 truncate rounded px-1.5 py-0.5 text-[10px]"
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-default)',
        color: tone === 'accent' ? 'var(--accent)' : 'var(--text-muted)',
        fontFamily: 'var(--font-mono)',
      }}
    >
      {children}
    </span>
  )
}

interface RepoSummary {
  path: string
  branch?: string
  ports: string[]
  health?: string
  command?: string
}

function summarizeRepo(repo: RepoSlice): RepoSummary {
  const path = typeof repo.localPath === 'string'
    ? (repo.localPath.replace(/\/$/, '').split('/').pop() || repo.localPath)
    : 'expr'
  const ports = repo.startCommands
    .flatMap((c) => (c.ports ?? []).map((p) => p.name.trim()))
    .filter((n): n is string => Boolean(n))
  const healthCmd = repo.startCommands.find((c) => c.health.mode !== 'none')
  const health = ((): string | undefined => {
    const h = healthCmd?.health
    if (!h || h.mode === 'none') return undefined
    if (h.mode === 'per-env') return 'per-env'
    return h.probe.type === 'http' ? (h.probe.http.url || 'http') : `tcp:${h.probe.tcp.port}`
  })()
  const command = repo.startCommands.map((c) => c.command.trim()).filter(Boolean)[0]
  return { path, branch: repo.branch, ports, health, command }
}

// ─── repo card ────────────────────────────────────────────────────────────

function RepoCard({
  feature,
  repo,
  repoLookupName,
  rootEnvs,
  activeRun,
  onChange,
  onRemove,
}: {
  feature: string
  repo: RepoSlice
  repoLookupName: string | undefined
  rootEnvs: string[]
  activeRun: boolean
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
  const summary = summarizeRepo(repo)

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
    const nextName = nextRepoName(repo.name, derivedName, absolutePath, repo.cloneUrl)
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
      onChange({
        ...repo,
        localPath: r.localPath,
        name: nextRepoName(repo.name, derivedName, r.localPath, repo.cloneUrl),
      })
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
        className="flex items-start gap-2 px-3 py-2"
        style={{ borderBottom: open ? '1px solid var(--border-default)' : 'none' }}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? 'Collapse' : 'Expand'}
          className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded transition-transform duration-150"
          style={{ color: 'var(--text-muted)', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
        >
          <ChevronRightIcon />
        </button>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="min-w-0 flex-1 text-left"
        >
          <span className="block truncate text-sm font-medium" style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
            {repo.name || derivedName || '(unnamed repo)'}
          </span>
          {!open && (
            <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <Chip title="Local path">{summary.path}</Chip>
              {summary.branch && <Chip title="Branch">⎇ {summary.branch}</Chip>}
              {summary.ports.length > 0 && (
                <Chip title="Port slots" tone="accent">🔌 {summary.ports.join(' · ')}</Chip>
              )}
              {summary.health && <Chip title="Health check">⊳ {summary.health}</Chip>}
              {summary.command && <Chip title="Start command">▸ {summary.command}</Chip>}
            </span>
          )}
        </button>
        <IconButton ariaLabel="Remove repo" variant="danger" onClick={onRemove}>
          <TrashIcon />
        </IconButton>
      </header>

      {open && (
        <div className="flex flex-col gap-3 px-3 pb-3 pt-2.5">
          <Disclosure
            title="Source"
            summary={[summary.path, summary.branch].filter(Boolean).join(' · ')}
          >
            <FieldRow label="Name">
              <TextInput
                value={repo.name}
                placeholder={derivedName || 'service-name'}
                onChange={(name) => onChange({ ...repo, name })}
              />
            </FieldRow>

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

            <BranchControl
              feature={feature}
              repo={repo}
              repoLookupName={repoLookupName}
              localPathStr={localPathStr}
              isExpr={isExpr}
              activeRun={activeRun}
              onChange={onChange}
            />

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
              <div className="mt-1 mb-2 text-[10px]" style={{ color: 'var(--danger)' }}>{cloneError}</div>
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
          </Disclosure>

          <Disclosure
            title="Runtime"
            summary={summary.command ?? '(no start command)'}
          >
            <div className="flex flex-col gap-2 pt-1">
              {repo.startCommands.map((cmd, i) => (
                <CommandCard
                  key={i}
                  feature={feature}
                  cmd={cmd}
                  rootEnvs={rootEnvs}
                  onChange={(next) => onChange({
                    ...repo,
                    startCommands: repo.startCommands.map((c, j) => j === i ? next : c),
                  })}
                />
              ))}
            </div>
          </Disclosure>
        </div>
      )}
    </div>
  )
}

function BranchControl({
  feature,
  repo,
  repoLookupName,
  localPathStr,
  isExpr,
  activeRun,
  onChange,
}: {
  feature: string
  repo: RepoSlice
  repoLookupName: string | undefined
  localPathStr: string
  isExpr: boolean
  activeRun: boolean
  onChange: (next: RepoSlice) => void
}) {
  const [status, setStatus] = useState<api.GitRepoStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [switching, setSwitching] = useState(false)
  const [suggestionsOpen, setSuggestionsOpen] = useState(false)
  const [switchHovered, setSwitchHovered] = useState(false)
  const repoName = repoLookupName || repo.name || deriveRepoName(repo.localPath, repo.cloneUrl)
  const target = repo.branch ?? ''

  const loadStatus = (): void => {
    if (!repoName || isExpr || !localPathStr) {
      setStatus(null)
      setError(null)
      return
    }
    api.getRepoGitStatus(feature, repoName)
      .then((next) => {
        setStatus(next)
        setError(null)
      })
      .catch((e: unknown) => {
        setStatus(null)
        setError(e instanceof Error ? e.message : 'Failed to load git status')
      })
  }

  useEffect(() => {
    let cancelled = false
    if (!repoName || isExpr || !localPathStr) {
      setStatus(null)
      setError(null)
      return
    }
    api.getRepoGitStatus(feature, repoName)
      .then((next) => {
        if (cancelled) return
        setStatus(next)
        setError(null)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setStatus(null)
        setError(e instanceof Error ? e.message : 'Failed to load git status')
      })
    return () => { cancelled = true }
  }, [feature, repoName, isExpr, localPathStr])

  const doCheckout = async (): Promise<void> => {
    const branch = target.trim()
    if (!repoName || !branch) return
    setSwitching(true)
    setError(null)
    try {
      const next = await api.checkoutRepoBranch(feature, repoName, branch)
      setStatus(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Checkout failed')
    } finally {
      setSwitching(false)
    }
  }

  const branches = [
    ...(status?.localBranches ?? []),
    ...(status?.remoteBranches ?? []),
  ].filter((branch, index, arr) => arr.indexOf(branch) === index)
  const normalizedTarget = target.trim().toLowerCase()
  const visibleBranches = branches
    .filter((branch) => !normalizedTarget || branch.toLowerCase().includes(normalizedTarget))
    .slice(0, 80)

  const canSwitch = Boolean(repoName && target.trim())
    && status?.isGitRepo === true
    && !status.dirty
    && !activeRun
    && !switching
    && status.currentBranch !== target.trim()

  // Explain *why* Switch is disabled, surfaced as a native hover tooltip.
  const switchDisabledReason: string | undefined = (() => {
    if (canSwitch || switching) return undefined
    if (!repoName) return 'Set a folder for this service first'
    if (!target.trim()) return 'Enter a branch name to switch to'
    if (!status?.isGitRepo) return 'Not a git repository'
    if (status.dirty) {
      const n = status.dirtyFiles.length
      return `Commit or stash ${n} uncommitted ${n === 1 ? 'change' : 'changes'} to enable`
    }
    if (activeRun) return 'Disabled while this feature is running'
    if (status.currentBranch === target.trim()) return 'Already on this branch'
    return undefined
  })()

  return (
    <FieldRow label="Branch" hint="Optional branch Canary Lab expects before starting this repo's services.">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-start gap-2">
          <div className="relative min-w-0 flex-1">
            <input
              type="text"
              value={target}
              placeholder={status?.currentBranch ?? 'feature/my-branch'}
              onFocus={() => setSuggestionsOpen(true)}
              onClick={() => setSuggestionsOpen(true)}
              onBlur={() => window.setTimeout(() => setSuggestionsOpen(false), 120)}
              onChange={(e) => {
                setSuggestionsOpen(true)
                onChange({ ...repo, branch: e.target.value || undefined })
              }}
              className="w-full rounded-md px-2.5 py-1.5 text-xs outline-none"
              style={{
                backgroundColor: 'var(--bg-elevated)',
                border: '1px solid var(--border-default)',
                color: 'var(--text-primary)',
                fontFamily: 'var(--font-mono)',
              }}
            />
            {suggestionsOpen && visibleBranches.length > 0 && (
              <div
                className="absolute left-0 right-0 top-[calc(100%+4px)] z-50 max-h-44 overflow-y-auto rounded-md py-1 text-xs shadow-lg scrollbar-thin"
                style={{
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-default)',
                  color: 'var(--text-secondary)',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {visibleBranches.map((branch) => (
                  <button
                    key={branch}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      onChange({ ...repo, branch })
                      setSuggestionsOpen(false)
                    }}
                    className="block w-full truncate px-2.5 py-1.5 text-left"
                    style={{
                      color: branch === target ? 'var(--text-primary)' : 'var(--text-secondary)',
                      background: branch === target ? 'var(--bg-selected)' : 'transparent',
                    }}
                  >
                    {branch}
                  </button>
                ))}
              </div>
            )}
          </div>
          {/* Custom tooltip driven by React state — Tailwind JIT didn't pick up
              group-hover utilities, and native title tooltips don't fire on
              disabled buttons. State-driven render is bulletproof. */}
          <span
            className="relative shrink-0 inline-flex"
            style={{ cursor: switchDisabledReason ? 'help' : 'default' }}
            onMouseEnter={() => setSwitchHovered(true)}
            onMouseLeave={() => setSwitchHovered(false)}
          >
            <button
              type="button"
              disabled={!canSwitch}
              onClick={doCheckout}
              className="rounded-md px-2.5 py-1.5 text-[10px] uppercase tracking-wider"
              style={{
                color: canSwitch ? 'var(--text-primary)' : 'var(--text-muted)',
                border: '1px solid var(--border-default)',
                opacity: canSwitch ? 1 : 0.55,
                pointerEvents: canSwitch || switching ? undefined : 'none',
              }}
            >
              {switching ? 'Switching…' : 'Switch'}
            </button>
            {switchHovered && switchDisabledReason && (
              <span
                role="tooltip"
                className="pointer-events-none absolute left-1/2 bottom-[calc(100%+6px)] -translate-x-1/2 whitespace-nowrap rounded-md px-2 py-1 text-[10px]"
                style={{
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-default)',
                  color: 'var(--text-primary)',
                  zIndex: 60,
                  boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
                }}
              >
                {switchDisabledReason}
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={loadStatus}
            aria-label="Refresh git status"
            title="Refresh git status"
            className="shrink-0 inline-flex items-center justify-center rounded-md px-2.5 py-1.5 text-xs leading-none"
            style={{ color: 'var(--text-muted)', border: '1px solid var(--border-default)' }}
          >
            ↻
          </button>
        </div>
        {status?.isGitRepo && status.dirty && status.dirtyFiles.length > 0 && (
          <div className="text-[10px]" style={{ color: '#f59e0b', fontFamily: 'var(--font-mono)' }}>
            {status.dirtyFiles.length} uncommitted
          </div>
        )}
        {activeRun && (
          <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            Switch disabled while this feature is running
          </div>
        )}
        {error && <div className="text-[10px]" style={{ color: 'var(--danger)' }}>{error}</div>}
      </div>
    </FieldRow>
  )
}

function CommandCard({
  feature,
  cmd,
  rootEnvs,
  onChange,
}: {
  feature: string
  cmd: CommandSlice
  rootEnvs: string[]
  onChange: (next: CommandSlice) => void
}) {
  return (
    <div
      className="rounded-md p-2.5"
      style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }}
    >
      <FieldRow label="Command" hintAsIcon hint="Runs in the repo's local path. Chain with && for multiple steps. Use ${slot.key} to reference envset values. Declare injectable ports in the Ports tab.">
        <TemplatedInput
          value={cmd.command}
          feature={feature}
          placeholder="npx tsx scripts/server.ts"
          onChange={(command) => onChange({ ...cmd, command })}
        />
      </FieldRow>
      <div className="mt-2">
        <HealthEditor
          feature={feature}
          health={cmd.health}
          rootEnvs={rootEnvs}
          onChange={(health) => onChange({ ...cmd, health })}
        />
      </div>
    </div>
  )
}

// ─── port-slot table (display-only) ─────────────────────────────────────────

/**
 * Read-only view of a start-command's injectable port slots. Slots are authored
 * in the feature config file (well-behaved services that read a port from env)
 * or written by Portify (hardcoded-port services it rewrites) — never hand-edited
 * in the UI, which only confused (the env/reference relationship is expert-dense
 * and nobody types it here). The Ports tab renders this; editing happens in the
 * config or via Portify.
 */
export function PortSlotTable({
  ports,
  emptyHint,
}: {
  ports: PortSlotSlice[]
  /** Overrides the default "(none — …)" line shown when there are no slots.
   *  The Ports tab passes a Portify-aware nudge here for not-yet-portified
   *  features. */
  emptyHint?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {ports.length === 0 && (
        emptyHint ?? (
          <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            (none — service uses its hardcoded port; can't run concurrently)
          </div>
        )
      )}
      {ports.length > 0 && (
        <div className="flex items-center gap-1.5 px-0.5 text-[9px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
          <span className="flex-1">Slot name</span>
          <span className="flex-1">Env var</span>
          <span className="flex-1">Reference</span>
        </div>
      )}
      {ports.map((slot, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <span className="flex-1 truncate px-0.5 py-1 text-[11px]" style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }} title={slot.name}>
            {slot.name || '—'}
          </span>
          <span className="flex-1 truncate px-0.5 py-1 text-[11px]" style={{ color: slot.env ? 'var(--text-primary)' : 'var(--text-muted)', fontFamily: 'var(--font-mono)' }} title={slot.env ?? ''}>
            {slot.env || '—'}
          </span>
          <PortSlotToken name={slot.name} env={slot.env} />
        </div>
      ))}
    </div>
  )
}

// Display of what a slot injects at run time: the `${port.<name>}` token to
// reference elsewhere (health-check URLs, envset files, inter-service config)
// and the env var the service reads. The actual port number is allocated per
// run and only exists while a run is active — settings shows the reference,
// not a concrete number. Click copies the token for pasting where it's needed.
function PortSlotToken({ name, env }: { name: string; env?: string }) {
  const [copied, setCopied] = useState(false)
  const ready = name.trim().length > 0
  const token = ready ? `\${port.${name.trim()}}` : '${port.…}'
  const label = env ? `Injected as ${env}; reference with ${token}` : `Reference with ${token}`
  const copy = (): void => {
    if (!ready) return
    void navigator.clipboard
      ?.writeText(token)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1200)
      })
      .catch(() => {})
  }
  // Box-less: in an otherwise plain-text row a bordered box reads as an
  // editable field — a false affordance now that nothing here is editable. The
  // token is the only interactive thing; cursor + hover underline carry that.
  return (
    <button
      type="button"
      onClick={copy}
      disabled={!ready}
      className="flex-1 truncate px-0.5 py-1 text-left text-[11px] transition-colors hover:underline"
      title={ready ? `${label} — click to copy` : label}
      aria-label={ready ? `${label} — click to copy` : label}
      style={{
        background: 'transparent',
        border: 'none',
        color: ready ? 'var(--text-secondary)' : 'var(--text-muted)',
        fontFamily: 'var(--font-mono)',
        cursor: ready ? 'copy' : 'default',
      }}
    >
      {copied ? 'copied ✓' : token}
    </button>
  )
}

// ─── health-check editor ─────────────────────────────────────────────────

function HealthEditor({
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

function ProbeEditor({
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
