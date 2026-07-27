import { Fragment, useEffect, useState } from 'react'
import * as api from '@/shared/api/client'
import { BranchSuggestInput, branchSuggestions, useRepoGitStatus } from '@/features/config'
import { PANEL_CARD_CLASS, PANEL_CARD_STYLE } from '@/shared/ui/PanelCard'
import {
  PLAYWRIGHT_RETAINED_ARTIFACT_MODES,
  PLAYWRIGHT_SCREENSHOT_MODES,
} from '@shared/configs/playwright-modes'
import { STAGE_COLUMN } from './stage-meta'
import { PANEL_KICKER_CLASS } from './RepoScanPanel'

// ─── Feature Setup: the editable config digest (R43) ────────────────────────
// The fields the user cares about at approval time, editable IN PLACE — every
// edit writes the REAL feature.config.cjs / playwright config through the same
// PUT the FeatureConfigEditor uses, so this panel and "Advanced setup" are two
// lenses on one document (features-changed keeps both live).

export function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

export const PW_MODES = PLAYWRIGHT_RETAINED_ARTIFACT_MODES

export const PW_SCREENSHOT_MODES = PLAYWRIGHT_SCREENSHOT_MODES

// A block IS a config repo — the same unit the Advanced setup Service tab
// renders, so every field here maps 1:1 onto a field there (Name ↔ NAME,
// Branch ↔ BRANCH, Start command ↔ RUNTIME COMMAND) and edits meet in one doc.
export interface CommandRow {
  cmdIdx: number
  name: string | null
  command: string
  health: string | null
}

export interface RepoBlock {
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

export function RowLabel({ label, info }: { label: string; info?: string }) {
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

export function ReadRow({ label, value, mono, info }: { label: string; value: string; mono?: boolean; info?: string }) {
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
export function ServiceBlock({ feature, block, allowEdit, refreshKey, divider, onRename, onBranch, onCommand }: {
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
export function NameInput({ value, onSave, testId }: {
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
export function BranchRow({ feature, repoName, value, refreshKey, onSave, testId }: {
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
export function SetupField({ label, value, editable, onSave, testId }: {
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

export function NumberRow({ label, value, editable, onSave, testId }: {
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

export function ModeRow({ label, value, modes = PW_MODES, editable, onSave, testId }: {
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
