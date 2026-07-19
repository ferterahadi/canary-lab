import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import * as api from '../../../shared/api/client'
import type { FlightManifest, FlightStageStatus } from '../../../shared/api/client'
import type { FeatureDocsListing } from '../../../shared/api/types'
import { BranchSuggestInput, branchSuggestions, useRepoGitStatus } from '../../config/components/BranchSuggestInput'
import { DocPill, readAsBase64 } from '../../coverage/components/CoverageDocsRail'
import { StageStatusChip } from './stage-meta'

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

const REPO_SCAN_CARD_CLASS = 'w-full rounded border px-3 py-2.5'
const REPO_SCAN_CARD_STYLE = { borderColor: 'var(--border-default)', background: 'var(--bg-surface)' }
const REPO_SCAN_KICKER_CLASS = 'mb-1 text-[9.5px] font-semibold uppercase tracking-[0.11em]'

export function RepoScanPanel({
  flight,
  envFiles = [],
}: {
  flight: FlightManifest
  envFiles?: string[]
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
      className="flex w-full max-w-[76ch] flex-col gap-2.5"
      title="Repos and intent are set when the flight first starts — delete the flight to test different ones."
    >
      <div
        data-testid="flight-intent-card"
        className={REPO_SCAN_CARD_CLASS}
        style={REPO_SCAN_CARD_STYLE}
      >
        <div className={REPO_SCAN_KICKER_CLASS} style={{ color: 'var(--text-muted)' }}>
          Flight input
        </div>
        <h3 className="mb-1.5 text-[12.5px] font-semibold">Intent · what to test</h3>
        <p
          data-testid="flight-intent"
          className="m-0 max-w-[76ch] text-[12px] leading-relaxed"
          style={{ color: 'var(--text-secondary)' }}
        >
          {flight.description}
        </p>
      </div>

      <div
        data-testid="repo-scan-card"
        className={REPO_SCAN_CARD_CLASS}
        style={REPO_SCAN_CARD_STYLE}
      >
        <div className={REPO_SCAN_KICKER_CLASS} style={{ color: 'var(--text-muted)' }}>
          {flight.repoPaths.length === 1 ? 'Repo · scanned' : `Repos · ${flight.repoPaths.length} scanned`}
        </div>
        <div className="flex flex-col">
          {flight.repoPaths.map((p, index) => {
            const envs = envsFor(p)
            return (
              <div
                key={p}
                data-testid={`repo-card-${repoBaseName(p)}`}
                className={`flex min-w-0 flex-col gap-1 ${index > 0 ? 'mt-2 border-t pt-2' : ''}`}
                style={index > 0 ? { borderColor: 'var(--border-default)' } : undefined}
              >
                <span className="text-[12.5px] font-semibold">{repoBaseName(p)}</span>
                <span className="grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-[9px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Location</span>
                  <span className="max-w-[340px] truncate text-[10px]" title={p} style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
                    {p}
                  </span>
                  {envs.length > 0 && (
                    <>
                      <span className="text-[9px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Env</span>
                      <span className="max-w-[340px] truncate text-[10px]" title={envs.join('\n')} style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
                        {envs.join(' · ')}
                      </span>
                    </>
                  )}
                </span>
              </div>
            )
          })}
        </div>
        {orphans.length > 0 && (
          <div className="mt-2 border-t pt-2 text-[10px]" style={{ borderColor: 'var(--border-default)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }} title={orphans.join('\n')}>
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
}: {
  feature: string
  /** False while the flight is mid-run (edits then would race the conductor). */
  editable: boolean
  /** Bumped on features-changed so an Advanced-setup save shows here live. */
  refreshKey?: number
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
    <section data-testid="feature-setup-panel" className="flex w-full max-w-[76ch] flex-col gap-2.5">
      {/* R58 + Repo-scan shape: ONE services card mirroring the repos card —
          kicker, then a block per repo (the Advanced setup Service unit):
          editable name, location, branch picker, start command(s). */}
      {blocks.length > 0 && (
        <div data-testid="setup-services-card" className={REPO_SCAN_CARD_CLASS} style={REPO_SCAN_CARD_STYLE}>
          <div className={REPO_SCAN_KICKER_CLASS} style={{ color: 'var(--text-muted)' }}>
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
        <div data-testid="setup-playwright" className={REPO_SCAN_CARD_CLASS} style={REPO_SCAN_CARD_STYLE}>
          <div className={REPO_SCAN_KICKER_CLASS} style={{ color: 'var(--text-muted)' }}>
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
        <div className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
          Synced live with Advanced setup — edits apply both ways.
        </div>
      )}
      {error && <div className="text-[11px]" style={{ color: 'var(--danger)' }}>{error}</div>}
    </section>
  )
}

function RowLabel({ label, info }: { label: string; info?: string }) {
  return (
    <span className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
      {label}
      {info && (
        <span
          aria-label={`${label} explained`}
          title={info}
          className="inline-flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full text-[9px] font-semibold"
          style={{ color: 'rgb(56, 189, 248)', border: '1px solid color-mix(in srgb, rgb(56, 189, 248) 40%, transparent)' }}
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
      <span className="min-w-0 truncate" title={value} style={{ color: 'var(--text-secondary)', fontFamily: mono ? 'var(--font-mono)' : undefined }}>
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
              <span className="block truncate text-[12px] font-semibold" title={block.name} style={{ fontFamily: 'var(--font-mono)' }}>
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
      className="w-full rounded border bg-transparent px-2 py-1 text-[11.5px] outline-none"
      style={{ borderColor: 'var(--border-default)', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}
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
        inputClassName="w-full rounded border bg-transparent px-2 py-1 text-[11.5px] outline-none"
        inputStyle={{ borderColor: 'var(--border-default)', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}
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
        className="w-full rounded border bg-transparent px-2 py-1 text-[11.5px] outline-none"
        style={{ borderColor: 'var(--border-default)', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}
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
        className="w-20 rounded border bg-transparent px-2 py-1 text-[11.5px] outline-none"
        style={{ borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
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
        className="w-44 rounded border bg-transparent px-2 py-1 text-[11.5px] outline-none"
        style={{ borderColor: 'var(--border-default)', color: 'var(--text-primary)', background: 'var(--bg-base)' }}
      >
        {[...new Set([value, ...modes])].map((mode) => (
          <option key={mode} value={mode}>{mode}</option>
        ))}
      </select>
    </>
  )
}

// ─── Requirements: the docs manager (R44/R59) ────────────────────────────────
// List / add / link / remove requirement docs right where the flight pauses
// for them (user-confirmed 2026-07-07: adding docs HERE stays — the ledger's
// rail is the other lens on the same folder). Same REST endpoints as the
// coverage rail + MCP tools; linked docs carry the ↗ marker (the user's
// original is the live source); the distilled-summary chip narrates the
// folded prd-summary half.

export function FlightDocsPanel({
  feature,
  locked,
  refreshKey,
  onChanged,
  summaryStatus,
}: {
  feature: string
  /** True while the PRD summary is being generated from these docs. */
  locked: boolean
  /** Bumped on coverage-changed so out-of-band doc writes show live. */
  refreshKey?: number
  onChanged?: () => void
  /** The folded prd-summary stage's status — rendered as the summary chip. */
  summaryStatus?: FlightStageStatus
}) {
  const [listing, setListing] = useState<FeatureDocsListing | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pathInput, setPathInput] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

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

  const linkPath = (): void => {
    const value = pathInput.trim()
    if (!value) return
    setBusy(true)
    setError(null)
    api.linkFeatureDocPath(feature, value)
      .then(() => { setPathInput(''); load(); onChanged?.() })
      .catch((err: unknown) => {
        const body = err instanceof api.ApiError ? (err.body as { error?: string } | null) : null
        setError(body?.error ?? (err instanceof Error ? err.message : String(err)))
      })
      .finally(() => setBusy(false))
  }

  const removeDoc = (relPath: string): void => {
    setBusy(true)
    api.deleteFeatureDoc(feature, relPath)
      .then(() => { load(); onChanged?.() })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }

  const openDoc = (absPath: string): void => {
    api.openEditor({ file: absPath }).catch(() => {})
  }

  const disabled = busy || locked
  const sourceDocs = (listing?.docs ?? []).filter((d) => !d.generated)

  return (
    <section data-testid="flight-docs-panel" className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <h3 className="text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
          Requirement docs
        </h3>
        {sourceDocs.length > 0 && (
          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            {sourceDocs.length} source{sourceDocs.length === 1 ? '' : 's'}
          </span>
        )}
        <div className="flex-1" />
        {summaryStatus && summaryStatus !== 'pending' && (
          <span className="flex items-center gap-1.5 text-[10px]" style={{ color: 'var(--text-muted)' }} data-testid="docs-summary-chip">
            Summary
            <StageStatusChip status={summaryStatus} />
          </span>
        )}
      </div>
      <input
        ref={fileInputRef}
        data-testid="flight-doc-file-input"
        type="file"
        multiple
        accept=".md,.markdown,.txt,.pdf,.docx"
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) void importFiles(e.target.files)
          e.target.value = ''
        }}
      />
      {sourceDocs.length === 0 && (
        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          No docs yet — add files, or link a local PRD by path.
        </div>
      )}
      {sourceDocs.map((d) => (
        <DocPill
          key={d.relPath}
          relPath={d.relPath}
          dirPrefix={`features/${feature}/docs/`}
          generated={d.generated}
          sizeBytes={d.sizeBytes}
          linked={d.linked}
          linkTarget={d.linkTarget}
          broken={d.broken}
          busy={disabled}
          onOpen={() => openDoc(d.absPath)}
          onRemove={locked ? undefined : () => removeDoc(d.relPath)}
          removeTitle="Remove doc"
        />
      ))}
      {!locked && (
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            data-testid="flight-doc-link-input"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); linkPath() } }}
            placeholder="/absolute/path/to/prd.md"
            disabled={disabled}
            className="min-w-0 flex-1 rounded border bg-transparent px-2 py-1 text-[11px] outline-none"
            style={{ borderColor: 'var(--border-default)', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}
          />
          <button
            type="button"
            data-testid="flight-doc-link"
            onClick={linkPath}
            disabled={disabled || pathInput.trim() === ''}
            className="cl-button px-2 py-1 text-xs"
          >
            Link
          </button>
          <button
            type="button"
            data-testid="flight-doc-add-files"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
            className="cl-button px-2 py-1 text-xs"
          >
            Add files…
          </button>
        </div>
      )}
      {error && <div className="text-[11px]" style={{ color: 'var(--danger)' }}>{error}</div>}
    </section>
  )
}
