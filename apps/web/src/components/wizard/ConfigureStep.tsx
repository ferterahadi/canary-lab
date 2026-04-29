import { useEffect, useMemo, useState } from 'react'
import * as api from '../../api/client'
import type {
  DraftRepo,
  Feature,
  SkillRecommendation,
  SkillSummary,
} from '../../api/types'
import { slugifyFeatureName, validateConfigure } from '../../lib/wizard-validation'

export interface ConfigureSubmit {
  prdText: string
  repos: DraftRepo[]
  skills: string[]
  featureName?: string
}

interface Props {
  features: Feature[]
  initial?: Partial<ConfigureSubmit>
  onSubmit: (payload: ConfigureSubmit) => void
  onCancel: () => void
  submitting: boolean
  errorMessage?: string | null
}

// Step 1: gather PRD, repos, skills, optional feature name. The recommender
// fires once the PRD crosses the 30-char threshold; the user can switch to
// manual mode and pick from the full skill list.
export function ConfigureStep({
  features,
  initial,
  onSubmit,
  onCancel,
  submitting,
  errorMessage,
}: Props): JSX.Element {
  const [prdText, setPrdText] = useState(initial?.prdText ?? '')
  const [repoKeys, setRepoKeys] = useState<Set<string>>(
    () => new Set((initial?.repos ?? []).map((r) => repoKey(r))),
  )
  const [featureName, setFeatureName] = useState(initial?.featureName ?? '')
  const [skillMode, setSkillMode] = useState<'auto' | 'manual'>('auto')
  const [allSkills, setAllSkills] = useState<SkillSummary[]>([])
  const [recommendations, setRecommendations] = useState<SkillRecommendation[]>([])
  const [recLoading, setRecLoading] = useState(false)
  const [selectedSkills, setSelectedSkills] = useState<Set<string>>(
    () => new Set(initial?.skills ?? []),
  )

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

  // Load full skill catalog once.
  useEffect(() => {
    let cancelled = false
    api.listSkills().then((s) => {
      if (!cancelled) setAllSkills(s)
    }).catch(() => {/* swallow — manual mode shows empty list */})
    return () => { cancelled = true }
  }, [])

  const repoList = [...repoKeys]
    .map((k) => parseRepoKey(k))
    .filter((r): r is DraftRepo => r !== null)

  const validation = validateConfigure({
    prdText,
    repos: repoList,
    skills: [...selectedSkills],
    featureName: featureName || undefined,
  })

  // Auto-fire recommender when PRD is long enough, debounced.
  useEffect(() => {
    if (skillMode !== 'auto') return
    if (!validation.recommenderReady) {
      setRecommendations([])
      return
    }
    let cancelled = false
    setRecLoading(true)
    const handle = setTimeout(() => {
      api.recommendSkills({ prdText, topN: 5 })
        .then((recs) => {
          if (cancelled) return
          setRecommendations(recs)
          // Pre-select recommended skills the first time we get them. The
          // user can uncheck to override.
          setSelectedSkills((prev) => {
            const next = new Set(prev)
            for (const r of recs) next.add(r.skillId)
            return next
          })
        })
        .catch(() => { /* leave list empty on error */ })
        .finally(() => { if (!cancelled) setRecLoading(false) })
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [prdText, skillMode, validation.recommenderReady])

  const toggleRepo = (key: string): void => {
    setRepoKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const toggleSkill = (id: string): void => {
    setSelectedSkills((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const submit = (): void => {
    if (!validation.ok) return
    onSubmit({
      prdText: prdText.trim(),
      repos: repoList,
      skills: [...selectedSkills],
      featureName: featureName.trim() || undefined,
    })
  }

  const featureNamePlaceholder = prdText.trim()
    ? slugifyFeatureName(prdText)
    : 'auto-derived from PRD'

  const recIds = new Set(recommendations.map((r) => r.skillId))

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto p-6">
        <div className="mx-auto max-w-3xl space-y-6">
          <section>
            <label className="block text-xs font-medium uppercase tracking-wide text-zinc-400" htmlFor="prd">
              PRD / Description
            </label>
            <p className="mt-1 text-xs text-zinc-500">
              Describe the feature, user flow, and the assertion you want covered.
            </p>
            <textarea
              id="prd"
              rows={12}
              value={prdText}
              onChange={(e) => setPrdText(e.target.value)}
              placeholder="As a user I want to…"
              className="mt-2 w-full resize-y rounded border border-zinc-700 bg-zinc-950 p-2 font-mono text-xs text-zinc-100 focus:border-zinc-500 focus:outline-none"
            />
            {validation.errors.prdText && (
              <div className="mt-1 text-xs text-rose-400">{validation.errors.prdText}</div>
            )}
          </section>

          <section>
            <div className="text-xs font-medium uppercase tracking-wide text-zinc-400">Repos</div>
            <p className="mt-1 text-xs text-zinc-500">
              Pick the repos this test should cover.
            </p>
            <div className="mt-2 space-y-1">
              {allRepos.length === 0 ? (
                <div className="text-xs text-zinc-500">No repos detected in any feature.</div>
              ) : (
                allRepos.map(({ repo, feature }) => {
                  const key = repoKey(repo)
                  return (
                    <label
                      key={key}
                      className="flex items-center gap-2 rounded border border-zinc-800 bg-zinc-900/60 px-2 py-1.5 text-xs text-zinc-200"
                    >
                      <input
                        type="checkbox"
                        checked={repoKeys.has(key)}
                        onChange={() => toggleRepo(key)}
                      />
                      <span className="font-medium">{repo.name}</span>
                      <span className="text-zinc-600">({feature})</span>
                      <span className="ml-auto truncate font-mono text-[10px] text-zinc-500">
                        {repo.localPath}
                      </span>
                    </label>
                  )
                })
              )}
            </div>
            {validation.errors.repos && (
              <div className="mt-1 text-xs text-rose-400">{validation.errors.repos}</div>
            )}
          </section>

          <section>
            <div className="flex items-center justify-between">
              <div className="text-xs font-medium uppercase tracking-wide text-zinc-400">Skills</div>
              <div className="flex items-center gap-1 text-xs">
                <ModeButton active={skillMode === 'auto'} onClick={() => setSkillMode('auto')}>
                  Auto
                </ModeButton>
                <ModeButton active={skillMode === 'manual'} onClick={() => setSkillMode('manual')}>
                  Manual
                </ModeButton>
              </div>
            </div>
            {skillMode === 'auto' ? (
              <div className="mt-2 space-y-1">
                {!validation.recommenderReady ? (
                  <div className="text-xs text-zinc-500">
                    Write at least 30 characters of PRD to get recommendations.
                  </div>
                ) : recLoading ? (
                  <div className="text-xs text-zinc-500">Scoring skills…</div>
                ) : recommendations.length === 0 ? (
                  <div className="text-xs text-zinc-500">No matches yet.</div>
                ) : (
                  recommendations.map((rec) => {
                    const meta = allSkills.find((s) => s.id === rec.skillId)
                    return (
                      <label
                        key={rec.skillId}
                        className="flex items-start gap-2 rounded border border-zinc-800 bg-zinc-900/60 p-2 text-xs"
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={selectedSkills.has(rec.skillId)}
                          onChange={() => toggleSkill(rec.skillId)}
                        />
                        <div className="flex-1">
                          <div className="font-medium text-zinc-100">
                            {meta?.name ?? rec.skillId}
                            <span className="ml-2 font-mono text-[10px] text-zinc-500">
                              score {rec.score}
                            </span>
                          </div>
                          <div className="text-zinc-400">{rec.reasoning}</div>
                        </div>
                      </label>
                    )
                  })
                )}
                {validation.recommenderReady && (
                  <button
                    type="button"
                    onClick={() => {
                      setRecLoading(true)
                      api.recommendSkills({ prdText, topN: 5 })
                        .then(setRecommendations)
                        .catch(() => {/* surfaced via empty list */})
                        .finally(() => setRecLoading(false))
                    }}
                    className="mt-1 rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800"
                  >
                    Run again
                  </button>
                )}
              </div>
            ) : (
              <div className="mt-2 max-h-72 space-y-1 overflow-y-auto rounded border border-zinc-800 p-2">
                {allSkills.length === 0 ? (
                  <div className="text-xs text-zinc-500">No skills available.</div>
                ) : (
                  allSkills.map((s) => (
                    <label key={s.id} className="flex items-start gap-2 text-xs text-zinc-200">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={selectedSkills.has(s.id)}
                        onChange={() => toggleSkill(s.id)}
                      />
                      <div className="flex-1">
                        <div className="font-medium">
                          {s.name}
                          {recIds.has(s.id) && (
                            <span className="ml-2 rounded bg-emerald-500/15 px-1 text-[10px] text-emerald-400">
                              recommended
                            </span>
                          )}
                        </div>
                        <div className="text-zinc-500">{s.description}</div>
                      </div>
                    </label>
                  ))
                )}
              </div>
            )}
          </section>

          <section>
            <label className="block text-xs font-medium uppercase tracking-wide text-zinc-400" htmlFor="featureName">
              Feature name (optional)
            </label>
            <input
              id="featureName"
              type="text"
              value={featureName}
              onChange={(e) => setFeatureName(e.target.value)}
              placeholder={featureNamePlaceholder}
              className="mt-2 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100 focus:border-zinc-500 focus:outline-none"
            />
            {validation.errors.featureName && (
              <div className="mt-1 text-xs text-rose-400">{validation.errors.featureName}</div>
            )}
          </section>

          {errorMessage && (
            <div className="rounded border border-rose-500/40 bg-rose-500/10 p-2 text-xs text-rose-300">
              {errorMessage}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-zinc-800 px-6 py-3">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!validation.ok || submitting}
          className="rounded bg-emerald-600 px-3 py-1.5 text-xs text-zinc-50 hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? 'Creating draft…' : 'Generate plan'}
        </button>
      </div>
    </div>
  )
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded border px-2 py-0.5 text-[11px] ${
        active
          ? 'border-zinc-500 bg-zinc-800 text-zinc-100'
          : 'border-zinc-800 text-zinc-400 hover:bg-zinc-900'
      }`}
    >
      {children}
    </button>
  )
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
