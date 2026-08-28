import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { buildHealPromptMap, buildOrchestratorHealPrompt, renderPlaywrightMcpHint, renderTraceExtractHint } from './auto-heal'
import { renderPersonalWikiMap } from '../../../../../../../shared/runtime/personal-wiki'

function writeRunManifest(runDir: string, body: Record<string, unknown>): void {
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({
    runId: 'r1',
    feature: 'f',
    startedAt: '2026-01-01T00:00:00Z',
    status: 'running',
    healCycles: 0,
    services: [],
    ...body,
  }))
}

describe('buildHealPromptMap', () => {
  let tmp: string
  let runDir: string
  let projectRoot: string

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-heal-map-')))
    runDir = path.join(tmp, 'run')
    projectRoot = path.join(tmp, 'project')
    fs.mkdirSync(runDir, { recursive: true })
    fs.mkdirSync(projectRoot, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('maps available service-mode resources and omits unavailable placeholders', () => {
    const featureDir = path.join(projectRoot, 'features', 'checkout')
    writeRunManifest(runDir, {
      featureDir,
      repoPaths: ['/repo/app'],
    })
    fs.mkdirSync(path.join(featureDir, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(runDir, 'heal-index.md'), '# Heal Index\n')
    fs.writeFileSync(path.join(runDir, 'e2e-summary.json'), '{}\n')
    fs.writeFileSync(path.join(runDir, 'diagnosis-journal.md'), '# Journal\n')
    fs.mkdirSync(path.join(runDir, 'failed', 'checkout-fails'), { recursive: true })
    fs.writeFileSync(path.join(runDir, 'failed', 'checkout-fails', 'api.log'), 'slice')
    fs.mkdirSync(path.join(runDir, 'failed', 'checkout-fails', 'trace-extract'), { recursive: true })
    fs.writeFileSync(path.join(runDir, 'failed', 'checkout-fails', 'trace-extract', 'failure-summary.md'), 'trace')
    fs.mkdirSync(path.join(runDir, 'failed', 'checkout-fails', 'playwright-mcp'), { recursive: true })
    fs.writeFileSync(path.join(runDir, 'failed', 'checkout-fails', 'playwright-mcp', 'snapshot.png'), 'png')
    fs.writeFileSync(path.join(runDir, 'svc-api.log'), 'full log')
    const wikiPath = path.join(tmp, 'wiki')
    fs.mkdirSync(wikiPath, { recursive: true })

    const healPrompt = buildHealPromptMap({
      projectRoot,
      runDir,
      personalWikiPath: wikiPath,
    })

    expect(healPrompt).toMatchObject({
      source: 'canary-lab/heal-agent-map',
      mode: 'service',
      runDir,
      runDirRel: '../run',
      startHere: [
        {
          id: 'heal-index',
          field: 'healIndexMarkdown',
          path: path.join(runDir, 'heal-index.md'),
        },
      ],
      boundaries: {
        fixTarget: expect.stringContaining('Fix service/app code, not tests.'),
        signalPolicy: {
          serviceOrRuntimeChange: 'restart',
          testOrConfigOnlyChange: 'rerun',
          mechanism: 'call signal_run; do not write signal files directly',
        },
      },
    })
    expect(healPrompt.resources.map((entry) => entry.id)).toEqual([
      'failed-slices',
      'trace-extract',
      'playwright-mcp',
      'full-service-log',
      'journal',
      'feature-docs',
      'personal-wiki',
    ])
    expect(JSON.stringify(healPrompt)).not.toContain('{{')
    expect(JSON.stringify(healPrompt)).not.toContain('null')
  })

  it('prefers the run-level playwright-mcp dir over a per-failure one', () => {
    writeRunManifest(runDir, { repoPaths: [] })
    fs.writeFileSync(path.join(runDir, 'e2e-summary.json'), '{}\n')
    fs.mkdirSync(path.join(runDir, 'failed', 'checkout-fails', 'playwright-mcp'), { recursive: true })
    fs.writeFileSync(path.join(runDir, 'failed', 'checkout-fails', 'playwright-mcp', 'snapshot.png'), 'png')
    const mcpDir = path.join(runDir, 'playwright-mcp')
    fs.mkdirSync(mcpDir, { recursive: true })
    fs.writeFileSync(path.join(mcpDir, 'snapshot.png'), 'png')

    const healPrompt = buildHealPromptMap({ projectRoot, runDir })

    const entry = healPrompt.resources.find((r) => r.id === 'playwright-mcp')
    expect(entry?.path).toBe(`${mcpDir}/`)
  })

  it('falls back to summary and test-mode boundaries when heal-index is unavailable', () => {
    writeRunManifest(runDir, { repoPaths: [] })
    fs.writeFileSync(path.join(runDir, 'e2e-summary.json'), '{}\n')
    fs.mkdirSync(path.join(runDir, 'failed', 'checkout-fails', 'playwright-mcp'), { recursive: true })
    fs.writeFileSync(path.join(runDir, 'failed', 'checkout-fails', 'playwright-mcp', '_attribution.json'), '[]')

    const healPrompt = buildHealPromptMap({ projectRoot, runDir })

    expect(healPrompt.mode).toBe('test')
    expect(healPrompt.startHere).toEqual([
      {
        id: 'summary',
        field: 'summary',
        path: path.join(runDir, 'e2e-summary.json'),
        purpose: 'Raw Playwright summary. Use when heal-index.md is missing or incomplete.',
      },
    ])
    expect(healPrompt.resources).toEqual([])
    expect(healPrompt.boundaries.fixTarget).toContain('This feature has no editable service repos')
    expect(healPrompt.boundaries.fixTarget).toContain('Read the failing test spec and its helpers')
  })
})

describe('buildOrchestratorHealPrompt', () => {
  let tmp: string
  let runDir: string
  let projectRoot: string

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-heal-')))
    runDir = path.join(tmp, 'run')
    projectRoot = path.join(tmp, 'project')
    fs.mkdirSync(runDir, { recursive: true })
    fs.mkdirSync(projectRoot, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('throws synchronously when the packaged prompt template is missing', () => {
    expect(() => buildOrchestratorHealPrompt({
      agent: 'claude',
      projectRoot,
      runDir,
      promptPath: path.join(tmp, 'missing.md'),
    })).toThrow(/Prompt template not found/)
  })

  it('returns a buildCyclePrompt that writes the rendered run-scoped prompt', () => {
    const build = buildOrchestratorHealPrompt({ agent: 'claude', projectRoot, runDir })
    const prompt = build({ cycle: 1, outputDir: path.join(runDir, 'out') })
    // Prompt file was written under runDir.
    const promptPath = path.join(runDir, 'heal-prompt.md')
    expect(fs.existsSync(promptPath)).toBe(true)
    const promptBody = fs.readFileSync(promptPath, 'utf-8')
    expect(promptBody).toContain(`Run directory:\n- \`${runDir}\` (\`../run\` from the project root)`)
    expect(promptBody).toContain(path.join(runDir, 'heal-index.md'))
    expect(promptBody).toContain(path.join(runDir, 'e2e-summary.json'))
    expect(promptBody).toContain(path.join(runDir, 'failed'))
    expect(promptBody).toContain(path.join(runDir, 'diagnosis-journal.md'))
    expect(promptBody).toContain(path.join(runDir, 'signals', '.restart'))
    expect(promptBody).toContain(path.join(runDir, 'signals', '.rerun'))
    expect(promptBody).not.toContain('{{')
    // Returned prompt is the same content the orchestrator pty.write()s.
    expect(prompt).toBe(promptBody)
  })

  it('shows the cycle budget ("of N") — default AUTO_HEAL_MAX_CYCLES, overridable', () => {
    // Regression: maxCycles was never threaded from the factory into the
    // addendum, so the PTY agent saw "Cycle N." with no budget to pace against.
    const dflt = buildOrchestratorHealPrompt({ agent: 'claude', projectRoot, runDir })
    expect(dflt({ cycle: 1, outputDir: path.join(runDir, 'out') })).toContain('Cycle 1 of 10.')
    const capped = buildOrchestratorHealPrompt({ agent: 'claude', projectRoot, runDir, maxCycles: 4 })
    expect(capped({ cycle: 2, outputDir: path.join(runDir, 'out') })).toContain('Cycle 2 of 4.')
  })

  it('renders service-mode copy when manifest.repoPaths is non-empty', () => {
    writeRunManifest(runDir, { repoPaths: ['/some/repo'] })
    const build = buildOrchestratorHealPrompt({ agent: 'claude', projectRoot, runDir })
    const prompt = build({ cycle: 1, outputDir: path.join(runDir, 'out') })
    expect(prompt).toContain('Fix service/app code, not tests.')
    expect(prompt).toContain('Do not read the test spec unless')
    expect(prompt).toContain('Do NOT Read the test spec file')
    expect(prompt).not.toContain('no editable service repos')
    expect(prompt).toContain('The signal requests runner verification')
    expect(prompt).toContain('Do not start services or run Playwright')
    expect(prompt).toContain('targeted Playwright verification after the signal')
  })

  it('surfaces feature docs when the accepted feature has preserved context', () => {
    const featureDir = path.join(projectRoot, 'features', 'context_docs')
    fs.mkdirSync(path.join(featureDir, 'docs'), { recursive: true })
    writeRunManifest(runDir, {
      feature: 'context_docs',
      featureDir,
      repoPaths: ['/some/repo'],
    })
    const build = buildOrchestratorHealPrompt({ agent: 'claude', projectRoot, runDir })
    const prompt = build({ cycle: 1, outputDir: path.join(runDir, 'out') })
    expect(prompt).toContain('Feature context docs:')
    expect(prompt).toContain(path.join(featureDir, 'docs'))
    expect(prompt).toContain('uploaded Add Test documents and additional notes')
  })

  it('renders test-mode copy when manifest.repoPaths is empty', () => {
    writeRunManifest(runDir, { repoPaths: [] })
    const build = buildOrchestratorHealPrompt({ agent: 'claude', projectRoot, runDir })
    const prompt = build({ cycle: 1, outputDir: path.join(runDir, 'out') })
    expect(prompt).toContain('This feature has no editable service repos')
    expect(prompt).toContain('Read the failing test spec and its helpers')
    // The service-mode prohibition must be absent in test mode (both the
    // static rule and the per-cycle addendum reinforcement).
    expect(prompt).not.toContain('Fix service/app code, not tests.')
    expect(prompt).not.toContain('Do not read the test spec unless')
    expect(prompt).not.toContain('Do NOT Read the test spec file')
  })

  it('defaults to service-mode copy when manifest.json is missing', () => {
    // A transient I/O glitch or a test fixture without a manifest must not
    // silently flip to test-mode for a feature that does have editable repos.
    const build = buildOrchestratorHealPrompt({ agent: 'claude', projectRoot, runDir })
    const prompt = build({ cycle: 1, outputDir: path.join(runDir, 'out') })
    expect(prompt).toContain('Fix service/app code, not tests.')
    expect(prompt).not.toContain('no editable service repos')
  })

  it('auto-heal does not depend on project CLAUDE.md / AGENTS.md', () => {
    fs.writeFileSync(path.join(projectRoot, 'CLAUDE.md'), 'custom user notes without markers')
    fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), 'custom codex notes without markers')

    expect(() => buildOrchestratorHealPrompt({ agent: 'claude', projectRoot, runDir })).not.toThrow()
    expect(() => buildOrchestratorHealPrompt({ agent: 'codex', projectRoot, runDir })).not.toThrow()
  })

  it('appends restart user guidance to the rendered heal prompt', () => {
    const build = buildOrchestratorHealPrompt({ agent: 'codex', projectRoot, runDir })
    build({ cycle: 1, outputDir: path.join(runDir, 'out'), userGuidance: 'focus on the webhook fallback' })
    const promptBody = fs.readFileSync(path.join(runDir, 'heal-prompt.md'), 'utf-8')
    expect(promptBody).toContain('User guidance for this restarted heal cycle')
    expect(promptBody).toContain('focus on the webhook fallback')
  })

  it('appends prior cross-agent session context to the rendered heal prompt', () => {
    const build = buildOrchestratorHealPrompt({ agent: 'codex', projectRoot, runDir })
    build({
      cycle: 1,
      outputDir: path.join(runDir, 'out'),
      priorAgentSessionContext: 'Previous claude session sid:\nASSISTANT: check CNS_V1_BASE_URL',
    })
    const promptBody = fs.readFileSync(path.join(runDir, 'heal-prompt.md'), 'utf-8')
    expect(promptBody).toContain('Previous agent session context from another agent')
    expect(promptBody).toContain('Previous claude session sid:')
    expect(promptBody).toContain('check CNS_V1_BASE_URL')
  })

  it('includes configured personal wiki context in the rendered heal prompt', () => {
    const wiki = path.join(tmp, 'wiki')
    const build = buildOrchestratorHealPrompt({
      agent: 'codex',
      projectRoot,
      runDir,
      personalWikiPath: wiki,
    })
    build({ cycle: 1, outputDir: path.join(runDir, 'out') })
    const promptBody = fs.readFileSync(path.join(runDir, 'heal-prompt.md'), 'utf-8')
    expect(promptBody).toContain(`- \`${wiki}\``)
    expect(promptBody).toContain('cross-linked markdown')
    expect(promptBody).toContain('follow links rather than re-grepping')
    expect(promptBody).toContain('Consult when the current failure seems related to prior work.')
  })

  it('omits personal wiki context when no wiki path is configured', () => {
    const build = buildOrchestratorHealPrompt({ agent: 'codex', projectRoot, runDir })
    build({ cycle: 1, outputDir: path.join(runDir, 'out') })
    const promptBody = fs.readFileSync(path.join(runDir, 'heal-prompt.md'), 'utf-8')
    expect(promptBody).not.toContain('cross-linked markdown')
    expect(promptBody).not.toContain('{{personalWikiMap}}')
  })

  it('omits the playwright-mcp bullet when no failure dir has MCP artifacts', () => {
    const build = buildOrchestratorHealPrompt({ agent: 'claude', projectRoot, runDir })
    const prompt = build({ cycle: 1, outputDir: path.join(runDir, 'out') })
    expect(prompt).not.toContain('playwright-mcp/')
    expect(prompt).not.toContain('browser captures (console / DOM snapshots / network)')
  })

  it('emits the playwright-mcp bullet when a legacy per-failure dir has MCP artifacts', () => {
    const mcpDir = path.join(runDir, 'failed', 'test-case-broken', 'playwright-mcp')
    fs.mkdirSync(mcpDir, { recursive: true })
    fs.writeFileSync(path.join(mcpDir, 'snapshot.png'), 'fake')
    const build = buildOrchestratorHealPrompt({ agent: 'claude', projectRoot, runDir })
    const prompt = build({ cycle: 1, outputDir: path.join(runDir, 'out') })
    expect(prompt).toContain('playwright-mcp/')
    expect(prompt).toContain('browser captures (console / DOM snapshots / network)')
  })

  it('prefers the run-level playwright-mcp dir when it has artifacts', () => {
    const mcpDir = path.join(runDir, 'playwright-mcp')
    fs.mkdirSync(mcpDir, { recursive: true })
    fs.writeFileSync(path.join(mcpDir, 'snapshot.png'), 'fake')
    const build = buildOrchestratorHealPrompt({ agent: 'claude', projectRoot, runDir })
    const prompt = build({ cycle: 1, outputDir: path.join(runDir, 'out') })
    expect(prompt).toContain(`${mcpDir}/`)
    expect(prompt).toContain('new MCP captures land here too')
  })

  it('treats playwright-mcp dirs containing only `_attribution.json` as empty', () => {
    const mcpDir = path.join(runDir, 'failed', 'test-case-x', 'playwright-mcp')
    fs.mkdirSync(mcpDir, { recursive: true })
    fs.writeFileSync(path.join(mcpDir, '_attribution.json'), '[]')
    const build = buildOrchestratorHealPrompt({ agent: 'claude', projectRoot, runDir })
    const prompt = build({ cycle: 1, outputDir: path.join(runDir, 'out') })
    expect(prompt).not.toContain('playwright-mcp/')
  })

  it('omits the trace-extract bullet when no failure dir has a failure-summary.md', () => {
    const build = buildOrchestratorHealPrompt({ agent: 'claude', projectRoot, runDir })
    const prompt = build({ cycle: 1, outputDir: path.join(runDir, 'out') })
    expect(prompt).not.toContain('trace-extract/failure-summary.md')
  })

  it('emits the trace-extract bullet when at least one failure has a failure-summary.md', () => {
    const traceDir = path.join(runDir, 'failed', 'test-case-broken', 'trace-extract')
    fs.mkdirSync(traceDir, { recursive: true })
    fs.writeFileSync(path.join(traceDir, 'failure-summary.md'), '# Failure summary')
    const build = buildOrchestratorHealPrompt({ agent: 'claude', projectRoot, runDir })
    const prompt = build({ cycle: 1, outputDir: path.join(runDir, 'out') })
    expect(prompt).toContain('trace-extract/failure-summary.md')
    expect(prompt).toContain('curated trace extract')
  })

  it('agent-agnostic: rendered prompt body is the same for claude and codex', () => {
    // The prompt is the conversation content; the agent flag only controls
    // the spawn command. Renderers must not branch on agent.
    const buildC = buildOrchestratorHealPrompt({ agent: 'claude', projectRoot, runDir })
    const promptC = buildC({ cycle: 1, outputDir: path.join(runDir, 'out') })
    const buildX = buildOrchestratorHealPrompt({ agent: 'codex', projectRoot, runDir })
    const promptX = buildX({ cycle: 1, outputDir: path.join(runDir, 'out') })
    expect(promptC).toBe(promptX)
  })

  it('omits the stuck-cycle escalation when consecutiveSameFailures is not supplied', () => {
    // Default path: prior cycles, but no streak threading. Escalation stays
    // hidden so we don't surface it spuriously to legacy callers.
    fs.writeFileSync(
      path.join(runDir, 'e2e-summary.json'),
      JSON.stringify({ failed: [{ name: 'test-a' }] }),
    )
    const build = buildOrchestratorHealPrompt({ agent: 'claude', projectRoot, runDir })
    const prompt = build({ cycle: 5, outputDir: path.join(runDir, 'out') })
    expect(prompt).not.toContain('Escalation:')
  })

  it('emits the stuck-cycle escalation when consecutiveSameFailures crosses the threshold', () => {
    // End-to-end: the orchestrator's streak value flows through the cycle
    // prompt builder into the addendum block. Concrete failedDir path is
    // present in the escalation bullet so the agent can Read directly.
    fs.writeFileSync(
      path.join(runDir, 'e2e-summary.json'),
      JSON.stringify({ failed: [{ name: 'test-a' }, { name: 'test-b' }] }),
    )
    const build = buildOrchestratorHealPrompt({ agent: 'claude', projectRoot, runDir })
    const prompt = build({
      cycle: 2, // becomes cycle 3 in the addendum after the +1 mapping
      outputDir: path.join(runDir, 'out'),
      consecutiveSameFailures: 3,
    })
    expect(prompt).toContain('Escalation: cycle 3 — these tests have now failed 3 times in a row despite 2 fix attempts: test-a, test-b.')
    // The failedDir path the addendum embeds is the same one the static
    // template uses — confirms threading through buildHealAddendum.
    expect(prompt).toContain(`${path.join(runDir, 'failed')}/<slug>/trace-extract/snapshot-at-failure.txt`)
  })
})

describe('renderPlaywrightMcpHint', () => {
  let tmp: string
  beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-'))) })
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  it('returns empty string when failed dir does not exist', () => {
    expect(renderPlaywrightMcpHint(path.join(tmp, 'nonexistent'))).toBe('')
  })

  it('returns empty string when no failure dir has a non-empty playwright-mcp/', () => {
    fs.mkdirSync(path.join(tmp, 'a'), { recursive: true })
    fs.mkdirSync(path.join(tmp, 'b', 'playwright-mcp'), { recursive: true })
    expect(renderPlaywrightMcpHint(tmp)).toBe('')
  })

  it('returns a bullet when any failure dir has files in playwright-mcp/', () => {
    fs.mkdirSync(path.join(tmp, 'a', 'playwright-mcp'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'a', 'playwright-mcp', 'snap.png'), 'fake')
    expect(renderPlaywrightMcpHint(tmp)).toContain('playwright-mcp/')
  })
})

describe('renderTraceExtractHint', () => {
  let tmp: string
  beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-trace-'))) })
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  it('returns empty string when no failure dir has trace-extract/failure-summary.md', () => {
    fs.mkdirSync(path.join(tmp, 'a'), { recursive: true })
    expect(renderTraceExtractHint(tmp)).toBe('')
  })

  it('returns a bullet when at least one failure has a failure-summary.md', () => {
    fs.mkdirSync(path.join(tmp, 'a', 'trace-extract'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'a', 'trace-extract', 'failure-summary.md'), 'x')
    expect(renderTraceExtractHint(tmp)).toContain('failure-summary.md')
  })
})

describe('buildPersonalWikiMap', () => {
  it('returns an empty section for unset paths', () => {
    expect(renderPersonalWikiMap(null)).toBe('')
    expect(renderPersonalWikiMap('')).toBe('')
  })
})
