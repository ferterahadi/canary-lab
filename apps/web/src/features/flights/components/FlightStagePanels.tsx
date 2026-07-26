import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import * as api from '@/shared/api/client'
import type { FlightManifest, FlightStageStatus, PrdSourceAttempt, PrdSourceCheckpointData } from '@/shared/api/client'
import type { FeatureDocsListing } from '@/shared/api/types'
import { BranchSuggestInput, branchSuggestions, useRepoGitStatus } from '@/features/config'
import { AddDocsTile, DocPill, DocsDropOverlay, EmptyDropzone, readAsBase64, useDocDrop } from '@/features/coverage/components/CoverageDocsRail'
import { PANEL_CARD_CLASS, PANEL_CARD_STYLE, PANEL_KICKER_CLASS as SHARED_KICKER_CLASS } from '@/shared/ui/PanelCard'
import { StepList, StepRow } from '@/shared/ui/StepList'
import { STAGE_COLUMN, StageStatusChip } from './stage-meta'

// Stage-specific panels for the flight detail view (R57/R58/R59) — each one a
// lens onto the SAME data its full surface owns (feature.config.cjs via the
// config-doc API, docs/ via the docs API), so edits here and edits there are
// the same write and stay live-synced through the existing WorkspaceEvents.

// ─── Repo Scan: intent then repos (R72c) ─────────────────────────────────────
// Keep the user-authored intent distinct from the repos the agent inspected.
// Env files and locations remain per-repo facts. Read-only: repos + intent
// freeze when the flight first starts.

function repoBaseName(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p
}

// Card chrome + kicker come from the shared primitive (shared/ui/PanelCard) so
// these panels and the stage facts card are literally the same surface.
const PANEL_KICKER_CLASS = `mb-1 ${SHARED_KICKER_CLASS}`

export function RepoScanPanel({
  flight,
  envFiles = [],
  onChangeInputs,
}: {
  flight: FlightManifest
  envFiles?: string[]
  /** R75: opens the launcher (prefilled, editable) — changing intent/repos is
   *  a full restart, and the launcher is its one home. */
  onChangeInputs?: () => void
}) {
  // Attribute each scanned env file to the repo that contains it.
  const envsFor = (repo: string): string[] =>
    envFiles
      .filter((f) => f === repo || f.startsWith(repo.replace(/[\\/]+$/, '') + '/'))
      .map((f) => f.slice(repo.replace(/[\\/]+$/, '').length + 1) || repoBaseName(f))
  const claimed = new Set(flight.repoPaths.flatMap((r) => envFiles.filter((f) => f.startsWith(r.replace(/[\\/]+$/, '') + '/'))))
  const orphans = envFiles.filter((f) => !claimed.has(f))

  return (
    <section
      data-testid="repo-scan-panel"
      className={`flex flex-col gap-2.5 ${STAGE_COLUMN}`}
      title="Repos and intent froze when this flight started — Change… reopens them and re-flies from the beginning."
    >
      <div
        data-testid="flight-intent-card"
        className={PANEL_CARD_CLASS}
        style={PANEL_CARD_STYLE}
      >
        <div className="flex items-baseline gap-2">
          <div className={PANEL_KICKER_CLASS}>
            Flight input
          </div>
          <div className="flex-1" />
          {onChangeInputs && (
            <button
              type="button"
              data-testid="flight-inputs-change"
              onClick={onChangeInputs}
              className="text-[10.5px] underline-offset-2 transition-colors hover:underline text-accent"
              title="Change what this flight tests — opens the intent + repos prefilled; the flight re-flies from the beginning"
            >
              Change…
            </button>
          )}
        </div>
        <h3 className="mb-1.5 text-[12.5px] font-semibold">Intent · what to test</h3>
        <p
          data-testid="flight-intent"
          className="m-0 max-w-[76ch] text-[12px] leading-relaxed text-secondary"
        >
          {flight.description}
        </p>
      </div>

      <div
        data-testid="repo-scan-card"
        className={PANEL_CARD_CLASS}
        style={PANEL_CARD_STYLE}
      >
        <div className={PANEL_KICKER_CLASS}>
          {flight.repoPaths.length === 1 ? 'Repo · scanned' : `Repos · ${flight.repoPaths.length} scanned`}
        </div>
        <StepList>
          {flight.repoPaths.map((p) => {
            const envs = envsFor(p)
            return (
              <StepRow
                key={p}
                testId={`repo-card-${repoBaseName(p)}`}
                state="done"
                title={repoBaseName(p)}
                sub={
                  <span className="grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-2 gap-y-0.5">
                    <span className="cl-rubric">Location</span>
                    <span className="max-w-[340px] truncate text-[10px] text-secondary font-mono" title={p}>
                      {p}
                    </span>
                    {envs.length > 0 && (
                      <>
                        <span className="cl-rubric">Env</span>
                        <span className="max-w-[340px] truncate text-[10px] text-secondary font-mono" title={envs.join('\n')}>
                          {envs.join(' · ')}
                        </span>
                      </>
                    )}
                  </span>
                }
              />
            )
          })}
        </StepList>
        {orphans.length > 0 && (
          <div className="mt-2 border-t pt-2 text-[10px] border-line text-muted font-mono" title={orphans.join('\n')}>
            env outside repos: {orphans.map(repoBaseName).join(' · ')}
          </div>
        )}
      </div>
    </section>
  )
}

// ─── Feature Setup: the editable config digest (R43) ────────────────────────
// The fields the user cares about at approval time, editable IN PLACE — every
// edit writes the REAL feature.config.cjs / playwright config through the same
// PUT the FeatureConfigEditor uses, so this panel and "Advanced setup" are two
// lenses on one document (features-changed keeps both live).

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

const PW_MODES = ['on', 'off', 'retain-on-failure', 'on-first-retry'] as const
const PW_SCREENSHOT_MODES = ['off', 'on', 'only-on-failure'] as const

// A block IS a config repo — the same unit the Advanced setup Service tab
// renders, so every field here maps 1:1 onto a field there (Name ↔ NAME,
// Branch ↔ BRANCH, Start command ↔ RUNTIME COMMAND) and edits meet in one doc.
interface CommandRow {
  cmdIdx: number
  name: string | null
  command: string
  health: string | null
}
interface RepoBlock {
  repoIdx: number
  name: string
  path: string | null
  branch: string | null
  commands: CommandRow[]
}

export function FeatureSetupPanel({
  feature,
  editable,
  refreshKey,
  onOpenAdvanced,
}: {
  feature: string
  /** False while the flight is mid-run (edits then would race the conductor). */
  editable: boolean
  /** Bumped on features-changed so an Advanced-setup save shows here live. */
  refreshKey?: number
  /** Opens FeatureConfigEditor. When absent the hint stays plain text — the
   *  sentence must never name a surface the user has no way to reach. */
  onOpenAdvanced?: () => void
}) {
  const [config, setConfig] = useState<unknown>(null)
  const [playwright, setPlaywright] = useState<unknown>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    Promise.all([
      api.getFeatureConfigDoc(feature).catch(() => null),
      api.getPlaywrightConfig(feature).catch(() => null),
    ]).then(([configDoc, playwrightDoc]) => {
      if (!alive) return
      setConfig(configDoc?.parsed.value ?? null)
      setPlaywright(playwrightDoc?.parsed.value ?? null)
    })
    return () => { alive = false }
  }, [feature, refreshKey])

  const saveConfig = (next: unknown): void => {
    setConfig(next) // optimistic; features-changed refetches the truth
    api.putFeatureConfigDoc(feature, next as never)
      .then(() => setError(null))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }
  const savePlaywright = (next: unknown): void => {
    setPlaywright(next)
    api.putPlaywrightConfig(feature, next as never)
      .then(() => setError(null))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }

  const cfg = asRecord(config)
  const repos = Array.isArray(cfg?.repos) ? (cfg!.repos as unknown[]) : []

  const blocks: RepoBlock[] = []
  repos.forEach((r, repoIdx) => {
    const repo = asRecord(r)
    if (!repo) return
    const startCommands = Array.isArray(repo.startCommands) ? repo.startCommands : []
    const commands: CommandRow[] = []
    startCommands.forEach((sc, cmdIdx) => {
      const svc = asRecord(sc)
      if (!svc || typeof svc.command !== 'string') return
      const health = asRecord(svc.health)
      const healthText = health
        ? [typeof health.type === 'string' ? health.type : null,
           typeof health.url === 'string' ? health.url : null,
           typeof health.path === 'string' ? health.path : null]
            .filter(Boolean).join(' ') || null
        : null
      commands.push({
        cmdIdx,
        name: typeof svc.name === 'string' ? svc.name : null,
        command: svc.command,
        health: healthText,
      })
    })
    if (commands.length === 0) return
    blocks.push({
      repoIdx,
      name: typeof repo.name === 'string' ? repo.name : `repo-${repoIdx + 1}`,
      path: typeof repo.localPath === 'string' ? repo.localPath : null,
      branch: typeof repo.branch === 'string' ? repo.branch : null,
      commands,
    })
  })

  // Every block edit is one write to the same on-disk config the Advanced
  // setup editor works on — that shared doc IS the sync.
  const mutateRepo = (repoIdx: number, fn: (repo: Record<string, unknown>) => void): void => {
    if (!cfg) return
    const next = structuredClone(cfg) as Record<string, unknown>
    const repo = asRecord((next.repos as unknown[])[repoIdx])
    if (!repo) return
    fn(repo)
    saveConfig(next)
  }
  const setRepoName = (block: RepoBlock, name: string): void => mutateRepo(block.repoIdx, (repo) => { repo.name = name })
  const setBranch = (block: RepoBlock, branch: string): void => mutateRepo(block.repoIdx, (repo) => { repo.branch = branch })
  const setCommand = (block: RepoBlock, cmd: CommandRow, command: string): void =>
    mutateRepo(block.repoIdx, (repo) => {
      const sc = Array.isArray(repo.startCommands) ? asRecord(repo.startCommands[cmd.cmdIdx]) : null
      if (sc) sc.command = command
    })

  const pw = asRecord(playwright)
  const pwUse = asRecord(pw?.use)
  const setPw = (patch: { workers?: number; retries?: number; video?: string; trace?: string; screenshot?: string }): void => {
    if (!pw) return
    const next = structuredClone(pw) as Record<string, unknown>
    if (patch.workers !== undefined) next.workers = patch.workers
    if (patch.retries !== undefined) next.retries = patch.retries
    if (patch.video !== undefined || patch.trace !== undefined || patch.screenshot !== undefined) {
      const use = asRecord(next.use) ?? {}
      if (patch.video !== undefined) use.video = patch.video
      if (patch.trace !== undefined) use.trace = patch.trace
      if (patch.screenshot !== undefined) use.screenshot = patch.screenshot
      next.use = use
    }
    savePlaywright(next)
  }

  if (!cfg && !pw) return null

  return (
    <section data-testid="feature-setup-panel" className={`flex flex-col gap-2.5 ${STAGE_COLUMN}`}>
      {/* R58 + Repo-scan shape: ONE services card mirroring the repos card —
          kicker, then a block per repo (the Advanced setup Service unit):
          editable name, location, branch picker, start command(s). */}
      {blocks.length > 0 && (
        <div data-testid="setup-services-card" className={PANEL_CARD_CLASS} style={PANEL_CARD_STYLE}>
          <div className={PANEL_KICKER_CLASS}>
            {blocks.length === 1 ? 'Service' : `Services · ${blocks.length}`}
          </div>
          <div className="flex flex-col">
            {blocks.map((block, index) => (
              <ServiceBlock
                key={block.repoIdx}
                feature={feature}
                block={block}
                allowEdit={editable}
                refreshKey={refreshKey}
                divider={index > 0}
                onRename={(v) => setRepoName(block, v)}
                onBranch={(v) => setBranch(block, v)}
                onCommand={(cmd, v) => setCommand(block, cmd, v)}
              />
            ))}
          </div>
        </div>
      )}

      {pw && (
        <div data-testid="setup-playwright" className={PANEL_CARD_CLASS} style={PANEL_CARD_STYLE}>
          <div className={PANEL_KICKER_CLASS}>
            Playwright
          </div>
          <div className="grid grid-cols-[110px_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 text-[11.5px]">
            <NumberRow label="Workers" value={typeof pw.workers === 'number' ? pw.workers : null} editable={editable} onSave={(n) => setPw({ workers: n })} testId="setup-pw-workers" />
            <NumberRow label="Retries" value={typeof pw.retries === 'number' ? pw.retries : null} editable={editable} onSave={(n) => setPw({ retries: n })} testId="setup-pw-retries" />
            <ModeRow label="Video" value={typeof pwUse?.video === 'string' ? pwUse.video : null} editable={editable} onSave={(v) => setPw({ video: v })} testId="setup-pw-video" />
            <ModeRow label="Trace" value={typeof pwUse?.trace === 'string' ? pwUse.trace : null} editable={editable} onSave={(v) => setPw({ trace: v })} testId="setup-pw-trace" />
            {/* Playwright's own default when unset is 'off' — show it honestly
                so the setting is discoverable; a change writes use.screenshot. */}
            <ModeRow label="Screenshot" value={typeof pwUse?.screenshot === 'string' ? pwUse.screenshot : 'off'} modes={PW_SCREENSHOT_MODES} editable={editable} onSave={(v) => setPw({ screenshot: v })} testId="setup-pw-screenshot" />
          </div>
        </div>
      )}

      {editable && (
        <div className="text-[10.5px] text-muted">
          Synced live with{' '}
          {onOpenAdvanced ? (
            <button
              type="button"
              data-testid="setup-open-advanced"
              onClick={onOpenAdvanced}
              className="underline underline-offset-2 text-accent"
            >
              Advanced setup
            </button>
          ) : (
            'Advanced setup'
          )}
          {' '}— the full config editor. Edits apply both ways.
        </div>
      )}
      {error && <div className="text-[11px] text-danger">{error}</div>}
    </section>
  )
}

function RowLabel({ label, info }: { label: string; info?: string }) {
  return (
    <span className="cl-rubric flex items-center gap-1">
      {label}
      {info && (
        <span
          aria-label={`${label} explained`}
          title={info}
          className="inline-flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full border border-accent/40 text-[9px] font-semibold text-accent"
        >
          i
        </span>
      )}
    </span>
  )
}

function ReadRow({ label, value, mono, info }: { label: string; value: string; mono?: boolean; info?: string }) {
  return (
    <>
      <RowLabel label={label} info={info} />
      {/* Same metrics as the edit-mode inputs (border + px-2 py-1) with the
          chrome transparent — arming ✎ swaps text for inputs WITHOUT the rows
          jumping (no height or x-offset change). */}
      <span
        className={`min-w-0 truncate rounded border border-transparent px-2 py-1 text-secondary${mono ? ' font-mono' : ''}`}
        title={value}
      >
        {value}
      </span>
    </>
  )
}

/** One service block: the SAME four aligned rows in read and edit mode —
 *  Name / Repo / Branch / Start command — never a floating title. Fields are
 *  read-only text until the pencil arms the block; every input then spans the
 *  full value column (one width for all), and each field still saves itself
 *  on blur/Enter through the shared config PUT. */
function ServiceBlock({ feature, block, allowEdit, refreshKey, divider, onRename, onBranch, onCommand }: {
  feature: string
  block: RepoBlock
  /** False while the flight runs — hides the pencil entirely. */
  allowEdit: boolean
  refreshKey?: number
  divider: boolean
  onRename: (name: string) => void
  onBranch: (branch: string) => void
  onCommand: (cmd: CommandRow, command: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const active = allowEdit && editing
  const commandLabel = (cmd: CommandRow): string =>
    block.commands.length > 1 && cmd.name ? `Start · ${cmd.name}` : 'Start command'
  return (
    <div
      data-testid={`setup-service-${block.name}`}
      className={`flex min-w-0 flex-col ${divider ? 'mt-2 border-t pt-2' : ''}`}
      style={divider ? { borderColor: 'var(--border-default)' } : undefined}
    >
      <div className="grid grid-cols-[110px_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 text-[11.5px]">
        <RowLabel label="Name" />
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 flex-1">
            {active ? (
              <NameInput value={block.name} onSave={onRename} testId={`setup-service-name-${block.name}`} />
            ) : (
              // Input-matching metrics (transparent chrome) — see ReadRow.
              <span className="block truncate rounded border border-transparent px-2 py-1 text-[11.5px] font-semibold font-mono" title={block.name}>
                {block.name}
              </span>
            )}
          </div>
          {allowEdit && (
            <button
              type="button"
              data-testid={`setup-edit-${block.name}`}
              aria-label={editing ? 'Done editing' : 'Edit service'}
              title={editing ? 'Done editing' : 'Edit name, branch and start command'}
              onClick={() => setEditing(!editing)}
              className="cl-button shrink-0 px-1.5 py-0.5 text-[11px]"
            >
              {editing ? '✓' : '✎'}
            </button>
          )}
        </div>
        {block.path && <ReadRow label="Repo" value={block.path} mono />}
        {active ? (
          <BranchRow
            feature={feature}
            repoName={block.name}
            value={block.branch ?? ''}
            refreshKey={refreshKey}
            onSave={onBranch}
            testId={`setup-branch-${block.name}`}
          />
        ) : (
          block.branch && <ReadRow label="Branch" value={block.branch} mono />
        )}
        {block.commands.map((cmd) => (
          <Fragment key={cmd.cmdIdx}>
            <SetupField
              label={commandLabel(cmd)}
              value={cmd.command}
              editable={active}
              onSave={(v) => onCommand(cmd, v)}
              testId={`setup-command-${cmd.name ?? `${block.name}-${cmd.cmdIdx}`}`}
            />
            {cmd.health && <ReadRow label="Health check" value={cmd.health} mono />}
          </Fragment>
        ))}
      </div>
    </div>
  )
}

/** The Name input — writes repos[].name, the SAME field the Advanced setup
 *  Service tab's NAME edits. */
function NameInput({ value, onSave, testId }: {
  value: string
  onSave: (value: string) => void
  testId: string
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])
  return (
    <input
      type="text"
      data-testid={testId}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (draft.trim() !== '' && draft.trim() !== value) onSave(draft.trim()) }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      spellCheck={false}
      className="cl-input w-full px-2 py-1 text-[11.5px] font-mono"
    />
  )
}

/** The Branch row — the SAME picker the Advanced setup Service tab renders
 *  (local + remote branches from the repo's git status), committing straight
 *  to repos[].branch on selection or blur. Only mounted while its block is
 *  armed, so the git status is fetched exactly when it can be used. */
function BranchRow({ feature, repoName, value, refreshKey, onSave, testId }: {
  feature: string
  repoName: string
  value: string
  refreshKey?: number
  onSave: (value: string) => void
  testId: string
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])
  const { status } = useRepoGitStatus(feature, repoName, { refreshKey })
  const commit = (next: string): void => {
    const v = next.trim()
    if (v !== '' && v !== value) onSave(v)
  }
  return (
    <>
      <RowLabel label="Branch" />
      <BranchSuggestInput
        value={draft}
        branches={branchSuggestions(status)}
        placeholder={status?.currentBranch ?? undefined}
        testId={testId}
        inputClassName="cl-input w-full px-2 py-1 text-[11.5px]"
        inputStyle={{ fontFamily: 'var(--font-mono)' }}
        onChange={setDraft}
        onSelect={commit}
        onBlur={() => commit(draft)}
      />
    </>
  )
}

/** Text field that saves on blur/Enter (never per keystroke — one PUT per edit). */
function SetupField({ label, value, editable, onSave, testId }: {
  label: string
  value: string
  editable: boolean
  onSave: (value: string) => void
  testId: string
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])
  if (!editable) return <ReadRow label={label} value={value} mono />
  return (
    <>
      <RowLabel label={label} />
      <input
        type="text"
        data-testid={testId}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { if (draft.trim() !== '' && draft !== value) onSave(draft) }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
        spellCheck={false}
        className="w-full rounded border bg-transparent px-2 py-1 text-[11.5px] outline-none border-line text-primary font-mono"
      />
    </>
  )
}

function NumberRow({ label, value, editable, onSave, testId }: {
  label: string
  value: number | null
  editable: boolean
  onSave: (value: number) => void
  testId: string
}) {
  if (value === null) return null
  if (!editable) return <ReadRow label={label} value={String(value)} />
  return (
    <>
      <RowLabel label={label} />
      <input
        type="number"
        data-testid={testId}
        defaultValue={value}
        min={0}
        onBlur={(e) => {
          const n = Number(e.target.value)
          if (Number.isFinite(n) && n >= 0 && n !== value) onSave(n)
        }}
        className="cl-input w-20 px-2 py-1 text-[11.5px]"
      />
    </>
  )
}

function ModeRow({ label, value, modes = PW_MODES, editable, onSave, testId }: {
  label: string
  value: string | null
  /** Valid modes for this setting (video/trace share PW_MODES; screenshot differs). */
  modes?: readonly string[]
  editable: boolean
  onSave: (value: string) => void
  testId: string
}) {
  if (value === null) return null
  if (!editable) return <ReadRow label={label} value={value} />
  return (
    <>
      <RowLabel label={label} />
      <select
        data-testid={testId}
        value={value}
        onChange={(e) => onSave(e.target.value)}
        className="themed-select cl-input w-44 px-2 py-1 text-[11.5px]"
      >
        {[...new Set([value, ...modes])].map((mode) => (
          <option key={mode} value={mode}>{mode}</option>
        ))}
      </select>
    </>
  )
}

// ─── Requirements (R74): the two-path fork + the resting docs panel ──────────
// While the flight is parked on the prd-source checkpoint the FORK owns the
// surface: "I'll add docs myself" (drop zone, no agent) vs "Let the agent find
// them" (two intent-guided hints — collect docs from the repos / infer from
// the git diff — that spawn the server collector; its output streams in the
// stage's activity band). Outside the checkpoint the panel is a read-only
// lens: pills + the summary chip, locked once approved — changes go through
// Continue → from a step → Requirements.

/** Doc CRUD over a feature's docs/ folder — one loader shared by the fork's
 *  manual path and the resting panel (same REST the coverage rail uses). */
function useFlightDocs(feature: string, refreshKey?: number, onChanged?: () => void) {
  const [listing, setListing] = useState<FeatureDocsListing | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback((keepError = false) => {
    api.listFeatureDocs(feature)
      .then((data) => { setListing(data); if (!keepError) setError(null) })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [feature])
  useEffect(() => { load() }, [load, refreshKey])

  const importFiles = useCallback(async (files: FileList) => {
    setBusy(true)
    setError(null)
    const failures: string[] = []
    for (const file of Array.from(files)) {
      try {
        const base64 = await readAsBase64(file)
        await api.importFeatureDoc(feature, { filename: file.name, contentType: file.type || undefined, base64 })
      } catch (e: unknown) {
        failures.push(`${file.name} (${e instanceof Error ? e.message : String(e)})`)
      }
    }
    if (failures.length > 0) setError(`import failed: ${failures.join(', ')}`)
    load(failures.length > 0)
    onChanged?.()
    setBusy(false)
  }, [feature, load, onChanged])

  const removeDoc = useCallback((relPath: string) => {
    setBusy(true)
    api.deleteFeatureDoc(feature, relPath)
      .then(() => { load(); onChanged?.() })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }, [feature, load, onChanged])

  const openDoc = useCallback((absPath: string) => {
    api.openEditor({ file: absPath }).catch(() => {})
  }, [])

  const sourceDocs = (listing?.docs ?? []).filter((d) => !d.generated)
  // The distilled artifact (_prd-summary.md/.json) — the stage's actual OUTPUT.
  // Filtered out of the source list on purpose; it gets its own card.
  const generatedDocs = (listing?.docs ?? []).filter((d) => d.generated)
  return { sourceDocs, generatedDocs, busy, error, importFiles, removeDoc, openDoc }
}

/** The resting Requirements panel — a read-only lens on docs/ while the stage
 *  runs or after it settles. No add/remove affordances here: while parked the
 *  fork owns editing; once approved the set is honestly frozen.
 *
 *  Two cards, because the stage has two halves the user thinks about
 *  separately: the source docs that went IN, and the distilled summary that
 *  came OUT. Before, only the inputs had a card and the output existed solely
 *  as a 10px "Summary ✓" chip — the stage's actual deliverable was the one
 *  thing you couldn't see or open. The summary chip now rides the output card
 *  it describes, so neither card reports the other's status. */
export function FlightDocsPanel({
  feature,
  approved,
  refreshKey,
  summaryStatus,
  requirementCount,
}: {
  feature: string
  /** Stage settled done — requirements approved, the doc set is frozen. */
  approved: boolean
  /** Bumped on coverage-changed so out-of-band doc writes show live. */
  refreshKey?: number
  /** The folded prd-summary stage's status — chips the distilled card. */
  summaryStatus?: FlightStageStatus
  /** Live requirement count from the folded prd-summary's evidence. */
  requirementCount?: number
}) {
  const docs = useFlightDocs(feature, refreshKey)
  const showDistilled = summaryStatus !== undefined && summaryStatus !== 'pending'
  return (
    <section data-testid="flight-docs-panel" className={`flex flex-col gap-2.5 ${STAGE_COLUMN}`}>
      <div className={PANEL_CARD_CLASS} style={PANEL_CARD_STYLE}>
        <div className="flex items-center gap-2">
          <div className={PANEL_KICKER_CLASS}>
            {docs.sourceDocs.length > 0 ? `Requirement docs · ${docs.sourceDocs.length}` : 'Requirement docs'}
          </div>
          <div className="flex-1" />
          {approved && (
            <span
              data-testid="docs-locked-chip"
              className="mb-1 rounded border px-1.5 py-px text-[9.5px] font-medium text-muted border-line"
            >
              Locked — approved
            </span>
          )}
        </div>
        {docs.sourceDocs.length === 0 ? (
          <div className="text-[11px] text-muted">No source docs.</div>
        ) : (
          <div className="flex flex-col gap-2">
            {docs.sourceDocs.map((d) => (
              <DocPill
                key={d.relPath}
                relPath={d.relPath}
                dirPrefix={`features/${feature}/docs/`}
                generated={d.generated}
                sizeBytes={d.sizeBytes}
                linked={d.linked}
                linkTarget={d.linkTarget}
                broken={d.broken}
                busy={false}
                onOpen={() => docs.openDoc(d.absPath)}
                removeTitle="Remove doc"
              />
            ))}
          </div>
        )}
        {approved && (
          <p className="mt-2 text-[10.5px] text-muted">
            To change these, use Continue → from a step → Requirements — later results are discarded from that point.
          </p>
        )}
        {docs.error && <div className="mt-2 text-[11px] text-danger">{docs.error}</div>}
      </div>

      {/* The output half. Rendered from `summaryStatus` alone (not from the
          artifact existing) so the running state has a card too — otherwise
          the panel is a blank gap for the whole distillation, which is the
          longest part of the stage. */}
      {showDistilled && (
        <div className={PANEL_CARD_CLASS} style={PANEL_CARD_STYLE} data-testid="flight-distilled-panel">
          <div className="flex items-center gap-2">
            <div className={PANEL_KICKER_CLASS}>
              {requirementCount != null ? `Distilled requirements · ${requirementCount}` : 'Distilled requirements'}
            </div>
            <div className="flex-1" />
            <span className="mb-1 flex items-center gap-1.5 text-[10px] text-muted" data-testid="docs-summary-chip">
              Summary
              <StageStatusChip status={summaryStatus} />
            </span>
          </div>

          {docs.generatedDocs.length > 0 ? (
            <div className="flex flex-col gap-2">
              {docs.generatedDocs.map((d) => (
                <DocPill
                  key={d.relPath}
                  relPath={d.relPath}
                  dirPrefix={`features/${feature}/docs/`}
                  generated={d.generated}
                  sizeBytes={d.sizeBytes}
                  linked={d.linked}
                  linkTarget={d.linkTarget}
                  broken={d.broken}
                  busy={false}
                  onOpen={() => docs.openDoc(d.absPath)}
                  removeTitle="Remove doc"
                />
              ))}
            </div>
          ) : (
            <div className="text-[11px] text-muted">
              {summaryStatus === 'running'
                ? 'Distilling the source docs into requirements — the agent’s progress is in Activity below.'
                : summaryStatus === 'failed'
                  ? 'Distillation failed before writing a summary — see Activity below.'
                  : 'No summary artifact on disk.'}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

/** The folded intent row — one truncated line, View/Fold to expand. The intent
 *  is frozen and guides both fork paths, so it rides every fork state. */
function IntentRow({ description }: { description: string }) {
  const [open, setOpen] = useState(false)
  return (
    <button
      type="button"
      data-testid="fork-intent"
      onClick={() => setOpen(!open)}
      className="flex w-full cursor-pointer items-center gap-2 rounded border border-line bg-transparent px-2.5 py-1.5 text-left"
      title={open ? 'Fold the intent' : 'View the full intent'}
    >
      <span className="cl-rubric shrink-0">
        Intent
      </span>
      {/* Prose, not code — the intent reads in the app face like every other
          sentence on the page (mono stays reserved for paths/commands). */}
      <span
        data-testid="fork-intent-text"
        className={`min-w-0 flex-1 text-[12px] text-secondary ${open ? 'leading-relaxed' : 'truncate'}`}
      >
        {description}
      </span>
      <span className="shrink-0 text-[10.5px] text-accent">
        {open ? 'Fold' : 'View'}
      </span>
    </button>
  )
}

/** One fork path card — a radio-like affordance that STAYS visible after the
 *  pick (R74 polish): the selected card lights sky + shows its dot filled, the
 *  other dims but remains clickable, so the previous choice is never hidden. */
function ForkPathCard({ testId, title, blurb, recommended, note, selected, dimmed, disabled, onPick }: {
  testId: string
  title: string
  blurb: string
  recommended?: boolean
  /** Neutral status chip (e.g. "Tried · empty") — states what happened on this
   *  path without the sky accent that marks a recommendation. */
  note?: string
  /** This card is the current pick — its content renders below the pair. */
  selected?: boolean
  /** A sibling is selected — recede without disappearing. */
  dimmed?: boolean
  disabled: boolean
  onPick: () => void
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      role="radio"
      aria-checked={Boolean(selected)}
      disabled={disabled}
      onClick={onPick}
      /* Neutral surfaces — the accent lives in the border + radio dot only. */
      className={[
        'relative flex min-w-0 flex-1 cursor-pointer items-start gap-2.5 rounded-md border p-3 text-left transition-all',
        selected ? 'border-accent/60 bg-selected' : 'border-line bg-transparent',
        dimmed ? 'opacity-60' : '',
      ].filter(Boolean).join(' ')}
    >
      <span
        aria-hidden="true"
        className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${selected ? 'border-accent' : 'border-line'}`}
      >
        {selected && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-1.5 text-[12.5px] font-semibold">
          {title}
          {recommended && !selected && (
            <span className="cl-badge-accent">
              Recommended
            </span>
          )}
          {note && !selected && (
            <span
              data-testid={`${testId}-note`}
              className="rounded-full border border-line px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-muted"
            >
              {note}
            </span>
          )}
        </span>
        <span className="text-[11px] leading-snug text-secondary">{blurb}</span>
      </span>
    </button>
  )
}

/** Read the structured outcome of the previous collector attempt off the
 *  parked checkpoint. Absent on a first visit, and on flights parked by an
 *  older server (which folded the reason into `message` instead) — both cases
 *  simply fall back to the neutral first-visit rendering. */
export function prdSourceAttempt(flight: FlightManifest): PrdSourceAttempt | null {
  const stage = flight.stages.find((s) => s.key === 'docs')
  const data = stage?.checkpoint?.data as PrdSourceCheckpointData | undefined
  return data?.lastAttempt ?? null
}

/** Headline for the verdict band — states what the agent DID, so the row reads
 *  as a finding rather than as an error the user caused. */
function attemptHeadline(attempt: PrdSourceAttempt): string {
  if (attempt.outcome === 'no-diff') return 'No diff vs base · nothing to infer from'
  if (attempt.outcome === 'no-output') return 'Agent ran · produced no document'
  return attempt.mode === 'infer-from-diff'
    ? 'Agent read the diff · found nothing'
    : 'Agent searched the repos · found nothing'
}

/** The empty-handed verdict, given its own row above the fork. Amber + a
 *  left-edge rule matches how the console marks "needs your attention"
 *  elsewhere, without the weight of a full tinted card. */
function AttemptVerdict({ attempt }: { attempt: PrdSourceAttempt }) {
  return (
    <div
      data-testid="prd-source-verdict"
      className="flex items-start gap-2 border-l-2 border-warning bg-warning/7 px-2.5 py-2"
    >
      <span aria-hidden="true" className="mt-px text-[11px] text-warning">⊘</span>
      <div className="flex min-w-0 flex-col gap-1">
        <span
          className="cl-rubric text-warning"
        >
          {attemptHeadline(attempt)}
        </span>
        {attempt.reason && (
          <span className="text-[12px] leading-snug text-primary">{attempt.reason}</span>
        )}
      </div>
    </div>
  )
}

/** The prd-source checkpoint as a two-path fork (R74). Owns the whole
 *  Requirements surface while the flight is parked: choose a path, then the
 *  path's state — manual drop zone (no agent) or the two agent hints. Every
 *  release goes through the same respond_flight_checkpoint the MCP path uses. */
export function RequirementsFork({
  flightId,
  flight,
  refreshKey,
  onResponded,
}: {
  flightId: string
  flight: FlightManifest
  /** Bumped on coverage-changed so out-of-band doc writes show live. */
  refreshKey?: number
  onResponded: () => void
}) {
  const [mode, setMode] = useState<'manual' | 'agent' | null>(null)
  /** Agent hint is *staged*, not fired — picking a card must never spawn the
   *  agent. The release goes through the confirm button, same as manual. */
  const [hint, setHint] = useState<'collect-repo-docs' | 'infer-from-diff' | null>(null)
  /** Outcome of the collector's last run, when this park follows a failed one.
   *  Drives both the verdict band and which path we recommend. */
  const lastAttempt = prdSourceAttempt(flight)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  /** A quick "Agent started" flash beside the button — appears on press and
   *  fades on its own (cl-flash-fade). The token forces a remount so a repeat
   *  press restarts the animation even if the previous flash hasn't finished. */
  const [startedFlash, setStartedFlash] = useState<number | null>(null)
  const docs = useFlightDocs(flight.feature, refreshKey)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const disabled = busy || docs.busy
  const { dragging, dropHandlers } = useDocDrop(disabled || mode !== 'manual', (files) => { void docs.importFiles(files) })

  const respond = (choice: string): void => {
    setBusy(true)
    setFailure(null)
    api.respondFlightCheckpoint(flightId, { choice })
      .then(() => onResponded())
      .catch((err: unknown) => setFailure(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }

  return (
    <section
      data-testid="requirements-fork"
      className={`relative flex flex-col gap-2.5 rounded-lg border p-3 border-line bg-surface ${STAGE_COLUMN}`}
      {...dropHandlers}
    >
      {lastAttempt && <AttemptVerdict attempt={lastAttempt} />}
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="text-[11px] text-warning">⏸</span>
        <span className="text-[12.5px] font-semibold">Where should requirements come from?</span>
      </div>
      <IntentRow description={flight.description} />

      <input
        ref={fileInputRef}
        data-testid="flight-doc-file-input"
        type="file"
        multiple
        accept=".md,.markdown,.txt,.pdf,.docx"
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) void docs.importFiles(e.target.files)
          e.target.value = ''
        }}
      />

      {/* Both path cards stay on screen — picking one lights it and unfolds
          its content below; the other recedes but never hides, so the current
          choice is always visible and reversible in one click. */}
      <div role="radiogroup" aria-label="Requirements source" className="flex flex-wrap gap-2.5">
        {/* The recommendation follows the evidence: once a collector has come
            back empty, pointing the user at the same collector again is the
            wrong default — the material it was asked to find isn't in these
            repos. The agent path stays available (a retry with feedback, or a
            different repo set, is legitimate) but stops being the suggestion. */}
        <ForkPathCard
          testId="fork-path-manual"
          title="I'll add docs myself"
          blurb="Drop PRD, spec, or ticket files. No agent runs."
          recommended={lastAttempt !== null}
          selected={mode === 'manual'}
          dimmed={mode === 'agent'}
          disabled={disabled}
          onPick={() => setMode('manual')}
        />
        <ForkPathCard
          testId="fork-path-agent"
          title="Let the agent find them"
          blurb={lastAttempt
            ? 'Retry with feedback, or point it at different repos.'
            : 'An agent gathers requirements guided by your intent.'}
          recommended={lastAttempt === null}
          note={lastAttempt ? (lastAttempt.outcome === 'no-diff' ? 'No diff' : 'Tried · empty') : undefined}
          selected={mode === 'agent'}
          dimmed={mode === 'manual'}
          disabled={disabled}
          onPick={() => setMode('agent')}
        />
      </div>

      {mode === 'manual' && (
        <>
          {docs.sourceDocs.length === 0 ? (
            <EmptyDropzone
              title="Add requirement docs"
              onPick={() => fileInputRef.current?.click()}
              dragging={dragging}
              busy={disabled}
            />
          ) : (
            <div className="flex flex-col gap-2">
              {docs.sourceDocs.map((d) => (
                <DocPill
                  key={d.relPath}
                  relPath={d.relPath}
                  dirPrefix={`features/${flight.feature}/docs/`}
                  generated={d.generated}
                  sizeBytes={d.sizeBytes}
                  linked={d.linked}
                  linkTarget={d.linkTarget}
                  broken={d.broken}
                  busy={disabled}
                  onOpen={() => docs.openDoc(d.absPath)}
                  onRemove={() => docs.removeDoc(d.relPath)}
                  removeTitle="Remove doc"
                />
              ))}
              <AddDocsTile testId="flight-doc-add-files" onPick={() => fileInputRef.current?.click()} disabled={disabled} />
            </div>
          )}
          <div className="flex justify-end">
            <button
              type="button"
              data-testid="fork-use-docs"
              disabled={disabled || docs.sourceDocs.length === 0}
              onClick={() => respond('continue')}
              className="cl-button-primary px-2.5 py-1 text-xs"
              title={docs.sourceDocs.length === 0 ? 'Add at least one doc first' : 'Approve these docs and distill the requirements'}
            >
              Use these docs → distill requirements
            </button>
          </div>
        </>
      )}

      {mode === 'agent' && (
        <>
          <div className="cl-rubric">
            How should the agent look?
          </div>
          <div className="flex flex-wrap gap-2.5">
            <ForkPathCard
              testId="fork-hint-collect-repo-docs"
              title="Collect docs from the repos"
              blurb="The agent copies in only the docs relevant to the intent."
              selected={hint === 'collect-repo-docs'}
              dimmed={hint === 'infer-from-diff'}
              disabled={disabled}
              onPick={() => setHint('collect-repo-docs')}
            />
            <ForkPathCard
              testId="fork-hint-infer-from-diff"
              title="Infer from the git diff"
              blurb="The agent cross-checks the branch diff vs base against the intent."
              selected={hint === 'infer-from-diff'}
              dimmed={hint === 'collect-repo-docs'}
              disabled={disabled}
              onPick={() => setHint('infer-from-diff')}
            />
          </div>
          <div className="flex items-center justify-end gap-2">
            {startedFlash !== null && (
              <span
                key={startedFlash}
                data-testid="fork-start-agent-flash"
                className="cl-flash-fade text-[11px] font-medium text-accent"
                onAnimationEnd={() => setStartedFlash(null)}
              >
                Agent started — output streams in the activity band below
              </span>
            )}
            <button
              type="button"
              data-testid="fork-start-agent"
              disabled={disabled || hint === null}
              onClick={() => {
                if (!hint) return
                respond(hint)
                setStartedFlash(Date.now())
              }}
              className="cl-button-primary px-2.5 py-1 text-xs"
              title={hint === null ? 'Pick how the agent should look first' : 'Start the agent with this approach'}
            >
              {busy ? 'Starting…' : 'Gather with agent'}
            </button>
          </div>
        </>
      )}

      {(failure ?? docs.error) && (
        <div className="text-[11px] text-danger">{failure ?? docs.error}</div>
      )}
      {dragging && mode === 'manual' && <DocsDropOverlay label="Drop to add requirement docs" />}
    </section>
  )
}

