import { useMemo, useState } from 'react'
import * as api from '../../api/client'
import type {
  DraftPrdDocument,
  DraftRepo,
  Feature,
} from '../../api/types'
import { slugifyFeatureName, validateConfigure } from '../../lib/wizard-validation'
import { FolderPicker } from '../config/FolderPicker'

export interface ConfigureSubmit {
  prdText: string
  agentPrdText?: string
  prdDocuments?: DraftPrdDocument[]
  repos: DraftRepo[]
  skills: string[]
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
  const [repoKeys, setRepoKeys] = useState<Set<string>>(
    () => new Set((initial?.repos ?? []).map((r) => repoKey(r))),
  )
  const [repoPathDraft, setRepoPathDraft] = useState('')
  const [repoAddError, setRepoAddError] = useState<string | null>(null)
  const [repoAdding, setRepoAdding] = useState(false)
  const [featureName, setFeatureName] = useState(initial?.featureName ?? '')

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

  const repoList = [...repoKeys]
    .map((k) => parseRepoKey(k))
    .filter((r): r is DraftRepo => r !== null)

  const validation = validateConfigure({
    prdText,
    repos: repoList,
    featureName: featureName || undefined,
  })

  const toggleRepo = (key: string): void => {
    setRepoKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
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
        setRepoAddError('That folder does not exist')
        return
      }
      const name = repoNameFromPath(localPath).trim()
      if (!name) {
        setRepoAddError('Repository name is required')
        return
      }
      setRepoKeys((prev) => {
        const next = new Set(prev)
        next.add(repoKey({ name, localPath }))
        return next
      })
      setRepoPathDraft('')
    } catch (e) {
      setRepoAddError(e instanceof Error ? e.message : 'Failed to add repository')
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
        skills: [],
        featureName: featureName.trim() || undefined,
      })
    } catch (e) {
      setExtractError(e instanceof Error ? e.message : 'Failed to extract PRD documents')
    } finally {
      setExtracting(false)
    }
  }

  const featureNamePlaceholder = prdText.trim()
    ? slugifyFeatureName(prdText)
    : repoList[0]
      ? `${repoNameFromPath(repoList[0].localPath)}-e2e`
      : 'auto-derived from selected repo'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto p-6">
        <div className="mx-auto grid max-w-6xl gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(360px,440px)]">
          <div className="space-y-4">
            <section className="rounded-lg border border-zinc-200 bg-white/70 p-4 dark:border-zinc-800 dark:bg-zinc-950/40">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-zinc-700 dark:text-zinc-300">1. Optional context</div>
                  <p className="mt-1 text-xs text-zinc-500">Add PRDs, notes, or acceptance criteria if you have them. If this is blank, Canary Lab infers coverage from the selected repos.</p>
                </div>
                {prdFiles.length > 0 && <span className="rounded bg-sky-500/10 px-2 py-1 text-[11px] text-sky-500">{prdFiles.length} queued</span>}
              </div>
              <div
                className="mt-3 rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-4 text-xs text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900/40 dark:text-zinc-400"
                onDragOver={(e) => {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'copy'
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  addFiles(e.dataTransfer.files)
                }}
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="font-medium text-zinc-800 dark:text-zinc-200">Drop docs here</div>
                    <div className="mt-0.5">Supports .txt, .md, .pdf, and .docx.</div>
                  </div>
                  <label className="shrink-0 cursor-pointer rounded border border-zinc-300 px-2 py-1 text-[11px] text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900">
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
                      <li key={`${file.name}:${i}`} className="flex items-center gap-2 rounded bg-white px-2 py-1 font-mono text-[11px] dark:bg-zinc-950">
                        <span className="min-w-0 flex-1 truncate">{file.name}</span>
                        <span className="text-zinc-400">{formatBytes(file.size)}</span>
                        <button type="button" onClick={() => removeFile(i)} className="text-zinc-500 hover:text-rose-400">Remove</button>
                      </li>
                    ))}
                  </ul>
                )}
                {prdDocuments.length > 0 && prdFiles.length === 0 && (
                  <div className="mt-2 text-[11px] text-zinc-500">
                    Extracted {prdDocuments.length} document{prdDocuments.length === 1 ? '' : 's'}.
                  </div>
                )}
                {extractError && <div className="mt-2 text-[11px] text-rose-400">{extractError}</div>}
              </div>
              <label className="mt-4 block text-xs font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400" htmlFor="prd">
                Additional notes only
              </label>
              <textarea
                id="prd"
                rows={10}
                value={prdText}
                onChange={(e) => setPrdText(e.target.value)}
                placeholder="Paste extra requirements, links, user flows, acceptance criteria, or edge cases. Uploaded docs stay attached above and will not be copied here."
                className="mt-2 w-full resize-y rounded border border-zinc-300 bg-white p-3 font-mono text-xs text-zinc-900 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
              />
            </section>
          </div>

          <aside className="space-y-4">
            <section className="rounded-lg border border-zinc-200 bg-white/70 p-4 dark:border-zinc-800 dark:bg-zinc-950/40">
              <div className="text-xs font-semibold uppercase tracking-wide text-zinc-700 dark:text-zinc-300">2. Repositories under test</div>
              <p className="mt-1 text-xs text-zinc-500">Select known repos or add any local folder. Canary Lab does not assume repos live in `~/Documents`.</p>

              <div className="mt-3 rounded border border-zinc-200 p-3 dark:border-zinc-800">
                <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">Add a repo folder</div>
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
                  className="mt-2 w-full rounded border border-zinc-300 bg-white px-2 py-1.5 font-mono text-[11px] text-zinc-900 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                />
                <div className="mt-2 flex justify-end">
                  <button
                    type="button"
                    onClick={() => void addRepoPath()}
                    disabled={repoAdding}
                    className="rounded bg-sky-600 px-3 py-1.5 text-xs text-white hover:bg-sky-500 disabled:opacity-50"
                  >
                    {repoAdding ? 'Adding...' : 'Add path'}
                  </button>
                </div>
                {repoAddError && <div className="mt-2 text-[11px] text-rose-400">{repoAddError}</div>}
              </div>

              {repoList.length > 0 && (
                <div className="mt-3">
                  <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">Selected</div>
                  <div className="mt-2 space-y-1">
                    {repoList.map((repo) => {
                      const key = repoKey(repo)
                      return (
                        <div key={key} className="flex items-center gap-2 rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-1.5 text-xs">
                          <span className="min-w-0 flex-1 truncate font-medium text-zinc-800 dark:text-zinc-200">{repo.name}</span>
                          <span className="min-w-0 flex-[1.6] truncate font-mono text-[10px] text-zinc-500">{repo.localPath}</span>
                          <button type="button" onClick={() => toggleRepo(key)} className="text-zinc-500 hover:text-rose-400">Remove</button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              <div className="mt-3">
                <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">Known from existing features</div>
                <div className="mt-2 max-h-72 space-y-1 overflow-y-auto">
                  {allRepos.length === 0 ? (
                    <div className="text-xs text-zinc-500">No existing feature repos yet. Add a folder above.</div>
                  ) : (
                    allRepos.map(({ repo, feature }) => {
                      const key = repoKey(repo)
                      const selected = repoKeys.has(key)
                      return (
                        <label
                          key={key}
                          className={`flex items-center gap-2 rounded border px-2 py-1.5 text-xs ${selected ? 'border-emerald-500/30 bg-emerald-500/10' : 'border-zinc-200 bg-zinc-100/60 dark:border-zinc-800 dark:bg-zinc-900/60'} text-zinc-800 dark:text-zinc-200`}
                        >
                          <input type="checkbox" checked={selected} onChange={() => toggleRepo(key)} />
                          <span className="min-w-0 flex-1 truncate font-medium">{repo.name}</span>
                          <span className="truncate text-zinc-400 dark:text-zinc-600">from {feature}</span>
                        </label>
                      )
                    })
                  )}
                </div>
              </div>
              {validation.errors.repos && <div className="mt-2 text-xs text-rose-400">{validation.errors.repos}</div>}
            </section>

            <section className="rounded-lg border border-zinc-200 bg-white/70 p-4 dark:border-zinc-800 dark:bg-zinc-950/40">
              <label className="block text-xs font-semibold uppercase tracking-wide text-zinc-700 dark:text-zinc-300" htmlFor="featureName">
                Feature name
              </label>
              <p className="mt-1 text-xs text-zinc-500">Optional folder name for the generated Canary Lab feature.</p>
              <input
                id="featureName"
                type="text"
                value={featureName}
                onChange={(e) => setFeatureName(e.target.value)}
                placeholder={featureNamePlaceholder}
                className="mt-2 w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-xs text-zinc-900 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
              />
              {validation.errors.featureName && <div className="mt-1 text-xs text-rose-400">{validation.errors.featureName}</div>}
            </section>
          </aside>

          {errorMessage && (
            <div className="lg:col-span-2 rounded border border-rose-500/40 bg-rose-500/10 p-2 text-xs text-rose-300">
              {errorMessage}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-zinc-200 dark:border-zinc-800 px-6 py-3">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-800"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!validation.ok || submitting || extracting}
          className="rounded bg-emerald-600 px-3 py-1.5 text-xs text-zinc-50 hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting || extracting ? 'Starting draft...' : 'Draft test plan'}
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

function repoKey(r: DraftRepo): string {
  return JSON.stringify([r.name, r.localPath])
}

function parseRepoKey(k: string): DraftRepo | null {
  try {
    const arr = JSON.parse(k) as unknown
    if (!Array.isArray(arr) || arr.length !== 2) return null
    const [name, localPath] = arr
    if (typeof name !== 'string' || typeof localPath !== 'string') return null
    return { name, localPath }
  } catch {
    return null
  }
}

function repoNameFromPath(localPath: string): string {
  const trimmed = localPath.replace(/[\\/]+$/g, '')
  const parts = trimmed.split(/[\\/]+/)
  return parts[parts.length - 1] || 'repo'
}
