import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import * as workspaceApi from '@/shared/api/workspace'
import { IconButton } from '@/shared/ui/atoms'
import { ChevronRightIcon, TrashIcon } from '@/shared/ui/Icons'
import { ComplexValueBadge, FieldRow, TextInput } from '@/shared/ui/FormFields'
import { FolderPicker, FolderPickerModal } from './FolderPicker'
import { TemplatedInput } from './TemplatedInput'
import { useMountedIdentity } from '@/shared/state/use-mounted-identity'
import { useRepoPathProbe } from '../state/use-repo-path-probe'
import type { RepoEdit } from './repo-editor-rows'
import { BranchControl } from './RepoBranchControl'
import { HealthEditor } from './RepoProbeEditors'
import { CommandSlice, Health, Probe, RepoSlice, deriveRepoName, nextRepoName, summarizeRepo } from './repo-slice'

// ─── layout primitives ─────────────────────────────────────────────────────

/** A collapsible zone with a tree-style left rule when open and a compact
 *  one-line summary when collapsed. Keeps the dense Service form navigable
 *  without nesting boxes inside boxes. */
export function Disclosure({
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
export function Chip({ children, title, tone = 'muted' }: { children: ReactNode; title?: string; tone?: 'muted' | 'accent' }) {
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

// ─── repo card ────────────────────────────────────────────────────────────

export function RepoCard({
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
  onChange: (next: RepoEdit) => void
  onRemove: () => void
}) {
  const [open, setOpen] = useState(true)
  const [remotePath, setRemotePath] = useState<string | null>(null)
  const pendingClone = useRef(false)
  const [cloneError, setCloneError] = useState<string | null>(null)
  const [cloning, setCloning] = useState(false)
  const [cloneTargetOpen, setCloneTargetOpen] = useState(false)

  const derivedName = deriveRepoName(repo.localPath, repo.cloneUrl)
  const isExpr = typeof repo.localPath === 'object' && repo.localPath != null && '$expr' in repo.localPath
  const localPathStr = typeof repo.localPath === 'string' ? repo.localPath : ''
  const summary = summarizeRepo(repo)

  const current = useMountedIdentity(JSON.stringify([feature, localPathStr, repo.cloneUrl]))
  const mounted = useMountedIdentity(feature)
  const probe = useRepoPathProbe(isExpr ? '' : localPathStr, remotePath)
  const pathExists = probe.existence.confirmed ? probe.existence.value?.exists ?? null : null
  useEffect(() => {
    if (!probe.remote.confirmed || !probe.remote.value?.cloneUrl || remotePath !== localPathStr) return
    const cloneUrl = probe.remote.value.cloneUrl
    onChange((latest) => latest.localPath === remotePath && !latest.cloneUrl ? { ...latest, cloneUrl } : latest)
    setRemotePath(null)
  }, [probe.remote.confirmed, probe.remote.value, remotePath, localPathStr, onChange])
  useEffect(() => { setCloneError(null); setCloneTargetOpen(false) }, [feature, localPathStr, repo.cloneUrl])

  const handleLocalPathChange = (absolutePath: string): void => {
    setRemotePath(repo.cloneUrl ? null : absolutePath)
    onChange((latest) => ({ ...latest, localPath: absolutePath,
      name: nextRepoName(latest.name, deriveRepoName(latest.localPath, latest.cloneUrl), absolutePath, latest.cloneUrl),
    }))
  }

  const handleClone = async (parentDir: string): Promise<void> => {
    if (!repo.cloneUrl || pendingClone.current) return
    pendingClone.current = true
    const repoName = derivedName || 'repo'
    setCloning(true)
    setCloneError(null)
    try {
      const r = await workspaceApi.cloneRepository({ cloneUrl: repo.cloneUrl, parentDir, repoName })
      if (!current()) return
      onChange((latest) => ({ ...latest, localPath: r.localPath,
        name: latest.name === repo.name ? nextRepoName(latest.name, derivedName, r.localPath, latest.cloneUrl) : latest.name,
      }))
      probe.existence.refresh()
      setCloneTargetOpen(false)
    } catch (e) {
      if (current()) setCloneError(e instanceof Error ? e.message : 'clone failed')
    } finally {
      pendingClone.current = false
      if (mounted()) setCloning(false)
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
          {/* The app's row-label size, not `text-sm` — 14px is the DIALOG title's
              voice, and a repo two levels inside that dialog outsized the
              section heading that holds it. */}
          <span className="block truncate text-[12.5px] font-medium" style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
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
                    className="cl-button rounded-md px-2 py-1 text-[10px] uppercase tracking-wider"
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
                  background: 'color-mix(in srgb, var(--warning) 8%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--warning) 40%, transparent)',
                  color: 'var(--warning)',
                }}
              >
                <span className="flex-1">Folder not found on this machine.</span>
                <button
                  type="button"
                  disabled={cloning}
                  onClick={() => setCloneTargetOpen(true)}
                  className="cl-button rounded-md px-2 py-1 text-[10px] uppercase tracking-wider"
                  style={{
                    color: 'var(--warning)',
                    border: '1px solid color-mix(in srgb, var(--warning) 50%, transparent)',
                  }}
                >
                  {cloning ? 'Cloning…' : 'Clone…'}
                </button>
              </div>
            )}
            {(probe.existence.error || probe.remote.error) && <div role="status" className="text-xs text-warning">
              {probe.existence.error || probe.remote.error}
              <button type="button" className="cl-button ml-2 px-2" onClick={() => { probe.existence.refresh(); probe.remote.refresh() }}>Retry</button>
            </div>}
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
                onChange={(s) => { setRemotePath(null); onChange({ ...repo, cloneUrl: s || undefined }) }}
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

export function CommandCard({
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
