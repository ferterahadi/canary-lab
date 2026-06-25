import { useEffect, useMemo, useState } from 'react'
import * as api from '../../../../shared/api/client'
import type {
  DraftPrdDocument,
  DraftRepo,
  Feature,
} from '../../../../shared/api/types'
import { slugifyFeatureName, validateConfigure } from '../../utils/wizard-validation'
import { FolderPicker } from '../../../config/components/FolderPicker'

export interface ConfigureSubmit {
  prdText: string
  agentPrdText?: string
  prdDocuments?: DraftPrdDocument[]
  repos: DraftRepo[]
  featureName?: string
}

interface Props {
  features: Feature[]
  initial?: Partial<ConfigureSubmit>
  onSubmit: (payload: ConfigureSubmit) => void | Promise<void>
  onCancel: () => void
  submitting: boolean
  errorMessage?: string | null
}

// Step 1: gather optional PRD context, repos, and optional feature name.
// The generation harness is built in; users do not need to choose prompt skills.
export function ConfigureStep({
  features,
  initial,
  onSubmit,
  onCancel,
  submitting,
  errorMessage,
}: Props) {
  const [prdText, setPrdText] = useState(initial?.prdText ?? '')
  const [prdDocuments, setPrdDocuments] = useState<DraftPrdDocument[]>(initial?.prdDocuments ?? [])
  const [prdFiles, setPrdFiles] = useState<File[]>([])
  const [extracting, setExtracting] = useState(false)
  const [extractError, setExtractError] = useState<string | null>(null)
  const [selectedRepos, setSelectedRepos] = useState<Map<string, DraftRepo>>(
    () => new Map((initial?.repos ?? []).map((r) => [repoKey(r), r])),
  )
  const [repoPathDraft, setRepoPathDraft] = useState('')
  const [repoAddError, setRepoAddError] = useState<string | null>(null)
  const [repoAdding, setRepoAdding] = useState(false)
  const [featureName, setFeatureName] = useState(initial?.featureName ?? '')
  const [dragOver, setDragOver] = useState(false)

  // Flatten all repos across features into the multiselect list, deduped by
  // (name, localPath).
  const allRepos = useMemo(() => {
    const seen = new Map<string, { repo: DraftRepo; feature: string }>()
    for (const f of features) {
      for (const r of f.repos) {
        const key = repoKey(r)
        if (!seen.has(key)) seen.set(key, { repo: r, feature: f.name })
      }
    }
    return [...seen.values()]
  }, [features])

  const repoList = [...selectedRepos.values()]

  const derivedFeatureName = prdText.trim()
    ? slugifyFeatureName(prdText)
    : repoList[0]
      ? `${repoNameFromPath(repoList[0].localPath)}-e2e`
      : ''

  const validation = validateConfigure(
    {
      prdText,
      repos: repoList,
      featureName: featureName || undefined,
      derivedFeatureName: derivedFeatureName || undefined,
    },
    features.map((f) => f.name),
  )

  const toggleRepo = (repo: DraftRepo): void => {
    setSelectedRepos((prev) => {
      const key = repoKey(repo)
      const next = new Map(prev)
      if (next.has(key)) next.delete(key)
      else next.set(key, repo)
      return next
    })
  }

  const updateSelectedRepo = (repo: DraftRepo): void => {
    setSelectedRepos((prev) => {
      const next = new Map(prev)
      next.set(repoKey(repo), repo)
      return next
    })
  }

  const addRepoPath = async (pathOverride?: string): Promise<void> => {
    const localPath = (pathOverride ?? repoPathDraft).trim()
    if (!localPath) {
      setRepoAddError('Choose or paste a repository folder')
      return
    }
    setRepoAdding(true)
    setRepoAddError(null)
    try {
      const exists = await api.checkPathExists(localPath)
      if (!exists.exists) {
        setRepoAddError('Path not found')
        return
      }
      const name = repoNameFromPath(localPath).trim()
      if (!name) {
        setRepoAddError('Repository name is required')
        return
      }
      setSelectedRepos((prev) => {
        const next = new Map(prev)
        const repo = { name, localPath }
        next.set(repoKey(repo), repo)
        return next
      })
      setRepoPathDraft('')
    } catch (e) {
      setRepoAddError(repoPathAddErrorMessage(e))
    } finally {
      setRepoAdding(false)
    }
  }

  const addFiles = (files: FileList | File[]): void => {
    const incoming = Array.from(files).filter((file) => isSupportedPrdFile(file))
    if (incoming.length === 0) return
    setExtractError(null)
    setPrdFiles((prev) => [...prev, ...incoming])
  }

  const removeFile = (index: number): void => {
    setPrdFiles((prev) => prev.filter((_, i) => i !== index))
  }

  const submit = async (): Promise<void> => {
    if (!validation.ok) return
    setExtracting(true)
    setExtractError(null)
    try {
      const notesText = prdText.trim()
      let agentPrdText = notesText
      let finalDocuments = prdDocuments
      if (prdFiles.length > 0) {
        const extracted = await api.extractPrdDocuments({ prdText, files: prdFiles })
        agentPrdText = extracted.prdText
        finalDocuments = extracted.documents
        setPrdDocuments(extracted.documents)
      }
      await onSubmit({
        prdText: notesText,
        agentPrdText,
        prdDocuments: finalDocuments,
        repos: repoList,
        featureName: featureName.trim() || undefined,
      })
    } catch (e) {
      setExtractError(e instanceof Error ? e.message : 'Failed to extract PRD documents')
    } finally {
      setExtracting(false)
    }
  }

  const featureNamePlaceholder = derivedFeatureName || 'auto-derived from selected repo'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto p-6">
        <div className="mx-auto grid max-w-6xl gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(360px,440px)]">
          <div className="space-y-4">
            <section className="cl-frame p-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="cl-frame-heading">1. Optional context</div>
                  <p className="mt-1 text-xs">Add PRDs, notes, or acceptance criteria if you have them. If this is blank, Canary Lab infers coverage from the selected repos.</p>
                </div>
              </div>
              <div
                className="mt-3 p-4 text-xs"
                style={{
                  border: dragOver ? '1px dashed var(--accent)' : '1px dashed var(--border-strong)',
                  background: dragOver ? 'var(--accent-soft)' : 'var(--bg-input)',
                  color: dragOver ? 'var(--text-primary)' : 'var(--text-secondary)',
                  borderRadius: 'var(--radius-md)',
                  transition: 'border-color 120ms ease, background 120ms ease, color 120ms ease',
                }}
                onDragOver={(e) => {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'copy'
                  setDragOver(true)
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  setDragOver(false)
                  addFiles(e.dataTransfer.files)
                }}
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="font-medium">Drop docs here</div>
                    <div className="mt-0.5">Supports .txt, .md, .pdf, and .docx.</div>
                  </div>
                  <label className="cl-button shrink-0 cursor-pointer px-2 py-1">
                    Browse files
                    <input
                      type="file"
                      multiple
                      accept=".txt,.md,.markdown,.pdf,.docx,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                      className="hidden"
                      onChange={(e) => {
                        if (e.target.files) addFiles(e.target.files)
                        e.currentTarget.value = ''
                      }}
                    />
                  </label>
                </div>
                {prdFiles.length > 0 && (
                  <ul className="mt-3 space-y-1">
                    {prdFiles.map((file, i) => (
                      <li
                        key={`${file.name}:${i}`}
                        className="flex items-center gap-2 px-2 py-1 font-mono text-[11px]"
                        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}
                      >
                        <span className="min-w-0 flex-1 truncate">{file.name}</span>
                        <span className="opacity-70">{formatBytes(file.size)}</span>
                        <button type="button" onClick={() => removeFile(i)} className="hover:opacity-100 opacity-70">Remove</button>
                      </li>
                    ))}
                  </ul>
                )}
                {prdDocuments.length > 0 && prdFiles.length === 0 && (
                  <div className="mt-2 text-[11px]">
                    Extracted {prdDocuments.length} document{prdDocuments.length === 1 ? '' : 's'}.
                  </div>
                )}
                {extractError && <div className="mt-2 text-[11px]" style={{ color: 'var(--danger)' }}>{extractError}</div>}
              </div>
              <label className="cl-frame-heading mt-3 block" htmlFor="prd">
                Additional notes only
              </label>
              <textarea
                id="prd"
                rows={4}
                value={prdText}
                onChange={(e) => setPrdText(e.target.value)}
                placeholder="Paste extra requirements, links, user flows, acceptance criteria, or edge cases. Uploaded docs stay attached above and will not be copied here."
                className="cl-input mt-2 w-full resize-y p-3 text-xs"
              />
            </section>
          </div>

          <aside className="space-y-4">
            <section className="cl-frame p-5">
              <div className="cl-frame-heading">2. Repositories under test</div>
              <p className="mt-1 text-xs">Select known repos or add any local folder. Canary Lab does not assume repos live in `~/Documents`.</p>

              <div
                className="mt-3 p-3"
                style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}
              >
                <div className="cl-frame-heading">Add a repo folder</div>
                <div className="mt-2">
                  <FolderPicker
                    value={repoPathDraft}
                    onChange={(p) => {
                      void addRepoPath(p)
                    }}
                    placeholder="Choose any local repository folder..."
                    title="Select repository folder"
                    confirmLabel="Use repository"
                  />
                </div>
                <input
                  value={repoPathDraft}
                  onChange={(e) => {
                    setRepoPathDraft(e.target.value)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void addRepoPath()
                  }}
                  placeholder="/absolute/path/to/repo or ~/path/to/repo"
                  className="cl-input mt-2 w-full px-2 py-1.5 text-[11px]"
                />
                <div className="mt-2 flex justify-end">
                  <button
                    type="button"
                    onClick={() => void addRepoPath()}
                    disabled={repoAdding}
                    className="cl-button-primary px-3 py-1.5 disabled:opacity-50"
                  >
                    {repoAdding ? 'Adding...' : 'Add path'}
                  </button>
                </div>
                {repoAddError && <div className="mt-2 text-[11px]" style={{ color: 'var(--danger)' }}>{repoAddError}</div>}
              </div>

              {repoList.length > 0 && (
                <div className="mt-3">
                  <div className="cl-frame-heading">Selected</div>
                  <div className="mt-2 space-y-1">
                    {repoList.map((repo) => {
                      const key = repoKey(repo)
                      return (
                        <div
                          key={key}
                          className="px-2 py-1.5 text-xs"
                          style={{
                            border: '1px solid var(--accent)',
                            background: 'var(--accent-soft)',
                            borderRadius: 'var(--radius-md)',
                          }}
                        >
                          <div className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate font-medium">{repo.name}</span>
                            <span className="min-w-0 flex-[1.6] truncate font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>{repo.localPath}</span>
                            <button type="button" onClick={() => toggleRepo(repo)} className="hover:opacity-100 opacity-70">Remove</button>
                          </div>
                          <RepoBranchPicker repo={repo} onChange={updateSelectedRepo} />
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              <div className="mt-3">
                <div className="cl-frame-heading">Known from existing features</div>
                <div className="mt-2 max-h-72 space-y-1 overflow-y-auto" style={{ scrollbarGutter: 'stable' }}>
                  {allRepos.length === 0 ? (
                    <div className="text-xs">No existing feature repos yet. Add a folder above.</div>
                  ) : (
                    allRepos.map(({ repo, feature }) => {
                      const key = repoKey(repo)
                      const selected = selectedRepos.has(key)
                      return (
                        <label
                          key={key}
                          className="flex items-center gap-2 px-2 py-1.5 text-xs"
                          style={{
                            border: `1px solid ${selected ? 'var(--accent)' : 'var(--border-default)'}`,
                            background: selected ? 'var(--accent-soft)' : 'var(--bg-input)',
                            color: 'var(--text-primary)',
                            borderRadius: 'var(--radius-md)',
                          }}
                        >
                          <input type="checkbox" checked={selected} onChange={() => toggleRepo(repo)} />
                          <span className="min-w-0 flex-1 truncate font-medium">{repo.name}</span>
                          {repo.branch && (
                            <span className="max-w-[110px] truncate font-mono text-[10px]" style={{ color: 'var(--text-muted)' }} title={repo.branch}>
                              {repo.branch}
                            </span>
                          )}
                          <span className="truncate opacity-70">from {feature}</span>
                        </label>
                      )
                    })
                  )}
                </div>
              </div>
              {validation.errors.repos && <div className="mt-2 text-xs" style={{ color: 'var(--danger)' }}>{validation.errors.repos}</div>}
            </section>

            <section className="cl-frame p-5">
              <label className="cl-frame-heading block" htmlFor="featureName">
                Feature name
              </label>
              <p className="mt-1 text-xs">Optional folder name for the generated Canary Lab feature.</p>
              <input
                id="featureName"
                type="text"
                value={featureName}
                onChange={(e) => setFeatureName(e.target.value)}
                placeholder={featureNamePlaceholder}
                className="cl-input mt-2 w-full px-2 py-1.5 text-xs"
              />
              {validation.errors.featureName && <div className="mt-1 text-xs" style={{ color: 'var(--danger)' }}>{validation.errors.featureName}</div>}
            </section>
          </aside>

          {errorMessage && (
            <div
              className="lg:col-span-2 p-3 text-xs"
              style={{
                border: '1px solid var(--danger)',
                background: 'color-mix(in srgb, var(--danger) 8%, transparent)',
                color: 'var(--danger)',
                fontFamily: 'var(--font-mono)',
                borderRadius: 6,
              }}
            >
              {errorMessage}
            </div>
          )}
        </div>
      </div>

      <div className="cl-panel-footer flex items-center justify-end gap-2 px-6 py-3">
        <button
          type="button"
          onClick={onCancel}
          className="cl-button px-3 py-1.5"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!validation.ok || submitting || extracting}
          className="cl-button-primary px-4 py-1.5 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting || extracting ? 'Starting draft…' : 'Draft test plan'}
        </button>
      </div>
    </div>
  )
}

function isSupportedPrdFile(file: File): boolean {
  const name = file.name.toLowerCase()
  return name.endsWith('.txt')
    || name.endsWith('.md')
    || name.endsWith('.markdown')
    || name.endsWith('.pdf')
    || name.endsWith('.docx')
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function RepoBranchPicker({
  repo,
  onChange,
}: {
  repo: DraftRepo
  onChange: (repo: DraftRepo) => void
}) {
  const [status, setStatus] = useState<api.GitRepoStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [switching, setSwitching] = useState(false)
  const [suggestionsOpen, setSuggestionsOpen] = useState(false)
  const target = repo.branch ?? ''

  const loadStatus = (): void => {
    api.getWorkspaceGitStatus(repo.localPath)
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
    api.getWorkspaceGitStatus(repo.localPath)
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
  }, [repo.localPath])

  const branches = [
    ...(status?.localBranches ?? []),
    ...(status?.remoteBranches ?? []),
  ].filter((branch, index, arr) => arr.indexOf(branch) === index)
  const normalizedTarget = target.trim().toLowerCase()
  const visibleBranches = branches
    .filter((branch) => !normalizedTarget || branch.toLowerCase().includes(normalizedTarget))
    .slice(0, 60)

  const canSwitch = Boolean(target.trim())
    && status?.isGitRepo === true
    && !status.dirty
    && !switching
    && status.currentBranch !== target.trim()

  const doCheckout = async (): Promise<void> => {
    const branch = target.trim()
    if (!branch) return
    setSwitching(true)
    setError(null)
    try {
      const next = await api.checkoutWorkspaceBranch(repo.localPath, branch)
      setStatus(next)
      onChange({ ...repo, branch })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Checkout failed')
    } finally {
      setSwitching(false)
    }
  }

  return (
    <div
      className="mt-2 p-2"
      style={{
        border: '1px solid var(--border-subtle)',
        background: 'var(--bg-overlay)',
        borderRadius: 'var(--radius-md)',
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="inline-flex max-w-[180px] items-center rounded px-2 py-1 font-mono text-[10px]"
          title={status?.isGitRepo ? status.currentBranch ?? 'detached HEAD' : 'Not a git repository'}
          style={{
            border: '1px solid var(--border-default)',
            color: status?.isGitRepo ? 'var(--text-secondary)' : 'var(--text-muted)',
          }}
        >
          <span className="truncate">
            {status?.isGitRepo ? status.currentBranch ?? 'detached HEAD' : 'No git status'}
          </span>
        </span>
        {status?.dirty && (
          <span className="text-[10px]" style={{ color: 'var(--warning)' }}>
            Dirty worktree
          </span>
        )}
      </div>
      <div className="mt-2 flex items-start gap-2">
        <div className="relative min-w-0 flex-1">
          <input
            value={target}
            onFocus={() => setSuggestionsOpen(true)}
            onClick={() => setSuggestionsOpen(true)}
            onBlur={() => window.setTimeout(() => setSuggestionsOpen(false), 120)}
            onChange={(e) => {
              setSuggestionsOpen(true)
              onChange({ ...repo, branch: e.target.value || undefined })
            }}
            placeholder={status?.currentBranch ?? 'feature/my-branch'}
            className="cl-input w-full px-2 py-1.5 text-[11px]"
          />
          {suggestionsOpen && visibleBranches.length > 0 && (
            <div className="cl-popover absolute left-0 right-0 top-[calc(100%+4px)] z-50 max-h-40 overflow-y-auto py-1 font-mono text-[11px]">
              {visibleBranches.map((branch) => (
                <button
                  key={branch}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onChange({ ...repo, branch })
                    setSuggestionsOpen(false)
                  }}
                  className="block w-full truncate px-2 py-1.5 text-left"
                  style={{
                    background: branch === target ? 'var(--accent-soft)' : 'transparent',
                    color: branch === target ? 'var(--text-primary)' : 'var(--text-secondary)',
                  }}
                >
                  {branch}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={doCheckout}
          disabled={!canSwitch}
          className="cl-button shrink-0 px-2 py-1.5 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {switching ? 'Switching...' : 'Switch'}
        </button>
        <button
          type="button"
          onClick={loadStatus}
          className="cl-button shrink-0 px-2 py-1.5"
        >
          Refresh
        </button>
      </div>
      {error && <div className="mt-1 text-[10px]" style={{ color: 'var(--danger)' }}>{error}</div>}
    </div>
  )
}

function repoKey(r: DraftRepo): string {
  return JSON.stringify([r.name, r.localPath])
}

function repoNameFromPath(localPath: string): string {
  const trimmed = localPath.replace(/[\\/]+$/g, '')
  const parts = trimmed.split(/[\\/]+/)
  return parts[parts.length - 1] || 'repo'
}

export function repoPathAddErrorMessage(err: unknown): string {
  if (err instanceof api.ApiError) {
    if (err.status === 400 || err.status === 404) return 'Path not found'
    const serverMessage = apiErrorBodyMessage(err.body)
    if (serverMessage) return serverMessage
  }
  return err instanceof Error ? err.message : 'Failed to add repository'
}

function apiErrorBodyMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const maybeMessage = (body as { error?: unknown; reason?: unknown }).error
    ?? (body as { error?: unknown; reason?: unknown }).reason
  return typeof maybeMessage === 'string' && maybeMessage.trim() ? maybeMessage : null
}
