import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import ts from 'typescript'
import { __testReviewExportInternals, buildEvaluationLlmPrompt, buildTestReviewPacket, createEvaluationHtml, evaluationCodexArgs } from './test-review-export'
import { detail, testEndEvent } from './__fixtures__/test-review-fixtures'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-review-')))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('test review export', () => {
  it('builds Codex rewrite args with supported read-only flags', () => {
    expect(evaluationCodexArgs('rewrite prompt')).toEqual([
      'exec',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      'rewrite prompt',
    ])
    expect(evaluationCodexArgs('rewrite prompt')).not.toContain('--full-auto')
    expect(evaluationCodexArgs('rewrite prompt')).not.toContain('--model')
    expect(evaluationCodexArgs('rewrite prompt')).not.toContain('--json')
    expect(evaluationCodexArgs('rewrite prompt', '/tmp/evaluation-output.txt', '/tmp/evaluation-schema.json')).toEqual([
      'exec',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--output-last-message',
      '/tmp/evaluation-output.txt',
      '--output-schema',
      '/tmp/evaluation-schema.json',
      'rewrite prompt',
    ])
  })

  it('builds a constrained LLM prompt from technical evidence', () => {
    const templatePath = path.join(tmpDir, 'evaluation-rewrite.md')
    fs.writeFileSync(templatePath, 'Prompt from file\nEvidence:\n{{evidence}}\nText slots:\n{{textSlots}}\n{{sourceHtmlSection}}')
    const packet = buildTestReviewPacket(detail({ featureDir: tmpDir, title: 'call missed -> SMS fallback' }))
    const prompt = buildEvaluationLlmPrompt({
      packet,
      templatePath,
      sourceHtml: '<html>technical report</html>',
      flowcharts: [{ testName: packet.tests[0].name, steps: ['Start', 'Action: postSendCall', 'Result: passed'] }],
    })

    expect(prompt).toContain('Prompt from file')
    expect(prompt).toContain('"feature": "checkout"')
    expect(prompt).toContain('"title": "call missed -> SMS fallback"')
    expect(prompt).toContain('"checkStrength": "1 not graded"')
    expect(prompt).toContain('"flowSteps"')
    expect(prompt).toContain('Text slots')
    expect(prompt).toContain('"id": "cases.0.title"')
    expect(prompt).toContain('Current generated HTML to rewrite from.')
    expect(prompt).toContain('<html>technical report</html>')
  })

  it('loads the packaged evaluation rewrite prompt by default', () => {
    const packet = buildTestReviewPacket(detail({ featureDir: tmpDir, title: 'call missed -> SMS fallback' }))
    const prompt = buildEvaluationLlmPrompt({
      packet,
      sourceHtml: '<html>technical report</html>',
      flowcharts: [{ testName: packet.tests[0].name, steps: ['Start', 'Action: postSendCall', 'Result: passed'] }],
    })

    expect(prompt).toContain('Rewrite the human-facing text slots')
    expect(prompt).toContain('Return strict JSON')
    expect(prompt).toContain('"id": "cases.0.title"')
  })

  it('uses validated generated narrative when provided', async () => {
    const body = await createEvaluationHtml(detail({ featureDir: tmpDir }), {
      narrative: {
        featureTitle: 'Generated feature title',
        summary: 'Generated plain-language summary.',
        cases: [{
          title: 'Generated product title',
          whatWasChecked: 'Generated scenario explanation.',
          whyItMatters: 'Generated stakeholder impact.',
          confidence: 'Generated confidence note.',
          flowSteps: [{ title: 'Generated flow step', detail: 'Generated flow detail' }],
        }],
      },
    })

    expect(body).toContain('Generated feature title')
    expect(body).toContain('Generated plain-language summary.')
    expect(body).toContain('Generated product title')
    expect(body).toContain('Generated flow step')
  })

  it('covers internal rewrite parsing and audience wording branches', () => {
    const packet = buildTestReviewPacket(detail({ featureDir: tmpDir }))

    expect(__testReviewExportInternals.parseEvaluationRewrite('before ```json\n{"summary":"s","cases":[]}\n``` after')).toEqual({
      summary: 's',
      cases: [],
    })
    expect(__testReviewExportInternals.parseEvaluationRewrite('no object')).toBeUndefined()
    expect(__testReviewExportInternals.parseEvaluationRewrite('{not json}')).toBeUndefined()

    expect(__testReviewExportInternals.parseEvaluationTextSlotRewrite('```json\n{"slots":[{"id":"summary","text":" New "},{"id":1,"text":"bad"},{"id":"x","text":2}]}\n```')).toEqual([
      { id: 'summary', text: ' New ' },
    ])
    expect(__testReviewExportInternals.parseEvaluationTextSlotRewrite('{"slots":[null,0,false,{"id":"summary","text":"ok"}]}')).toEqual([
      { id: 'summary', text: 'ok' },
    ])
    expect(__testReviewExportInternals.parseEvaluationTextSlotRewrite('{"slots":[]}')).toBeUndefined()
    expect(__testReviewExportInternals.parseEvaluationTextSlotRewrite('{"slots":{}}')).toBeUndefined()
    expect(__testReviewExportInternals.parseEvaluationTextSlotRewrite('not json')).toBeUndefined()
    expect(__testReviewExportInternals.previewAgentOutput('')).toBe('<empty output>')
    expect(__testReviewExportInternals.previewAgentOutput('x'.repeat(510))).toBe(`${'x'.repeat(500)}...`)
    expect(__testReviewExportInternals.renderPromptTemplate('{{known}} {{missing}}', { known: 'yes' })).toBe('yes {{missing}}')
    expect(__testReviewExportInternals.evaluationAgentModel('claude')).toBeNull()
    expect(__testReviewExportInternals.evaluationAgentModel('codex')).toBeNull()

    expect(__testReviewExportInternals.normalizeEvaluationRewrite(undefined, packet)).toBeNull()
    expect(__testReviewExportInternals.normalizeEvaluationRewrite({ summary: 'x', cases: [] }, packet)).toBeNull()
    expect(__testReviewExportInternals.normalizeEvaluationRewrite({
      featureTitle: 1,
      summary: 'x',
      cases: [{
        title: 't',
        whatWasChecked: 'w',
        whyItMatters: 'm',
        confidence: 'c',
        flowSteps: [{ title: 'step', detail: 1 }, null, { title: 2 }],
      }],
    } as never, packet)).toEqual({
      summary: 'x',
      cases: [{
        title: 't',
        whatWasChecked: 'w',
        whyItMatters: 'm',
        confidence: 'c',
        flowSteps: [{ title: 'step' }],
      }],
    })
    expect(__testReviewExportInternals.normalizeEvaluationRewrite({
      summary: 'x',
      cases: [{ title: 't', whatWasChecked: 'w', whyItMatters: 'm' }],
    } as never, packet)).toBeNull()
    expect(__testReviewExportInternals.evaluationTextSlots({
      summary: 'Summary',
      cases: [{
        title: 'Title',
        whatWasChecked: 'Checked',
        whyItMatters: 'Matters',
        confidence: 'Confidence',
        flowSteps: [{ title: 'Step without detail' }, { title: 'Step with detail', detail: 'Detail' }],
      }],
    })).toContainEqual({ id: 'cases.0.flowSteps.1.detail', text: 'Detail' })
    expect(__testReviewExportInternals.evaluationTextSlots({
      summary: 'Summary only',
      cases: [{ title: 'Title', whatWasChecked: 'Checked', whyItMatters: 'Matters', confidence: 'Confidence' }],
    })).toEqual([
      { id: 'summary', text: 'Summary only' },
      { id: 'cases.0.title', text: 'Title' },
      { id: 'cases.0.whatWasChecked', text: 'Checked' },
      { id: 'cases.0.whyItMatters', text: 'Matters' },
      { id: 'cases.0.confidence', text: 'Confidence' },
    ])
    expect(__testReviewExportInternals.applyEvaluationTextSlotRewrite({
      featureTitle: 'Base feature',
      summary: 'Base summary',
      cases: [{
        title: 'Base title',
        whatWasChecked: 'Base checked',
        whyItMatters: 'Base matters',
        confidence: 'Base confidence',
        flowSteps: [{ title: 'Base step' }, { title: 'Base detailed', detail: 'Base detail' }],
      }],
    }, [
      { id: 'featureTitle', text: 'New feature' },
      { id: 'cases.0.whatWasChecked', text: 'New checked' },
      { id: 'cases.0.flowSteps.0.detail', text: 'New detail' },
      { id: 'cases.0.flowSteps.1.title', text: 'New detailed title' },
    ])).toMatchObject({
      featureTitle: 'New feature',
      summary: 'Base summary',
      cases: [{
        title: 'Base title',
        whatWasChecked: 'New checked',
        whyItMatters: 'Base matters',
        confidence: 'Base confidence',
        flowSteps: [
          { title: 'Base step', detail: 'New detail' },
          { title: 'New detailed title', detail: 'Base detail' },
        ],
      }],
    })
    expect(__testReviewExportInternals.applyEvaluationTextSlotRewrite({
      summary: 'Base summary',
      cases: [{
        title: 'Base title',
        whatWasChecked: 'Base checked',
        whyItMatters: 'Base matters',
        confidence: 'Base confidence',
      }],
    }, [
      { id: 'featureTitle', text: '   ' },
      { id: 'summary', text: 'New summary' },
      { id: 'cases.0.title', text: 'New title' },
      { id: 'cases.0.whyItMatters', text: 'New matters' },
      { id: 'cases.0.confidence', text: 'New confidence' },
    ])).toEqual({
      summary: 'New summary',
      cases: [{
        title: 'New title',
        whatWasChecked: 'Base checked',
        whyItMatters: 'New matters',
        confidence: 'New confidence',
      }],
    })

    const failed = detail({ featureDir: tmpDir, title: 'fails checkout' })
    failed.manifest.status = 'failed'
    failed.summary = { complete: true, total: 1, passed: 0, failed: [{ name: 'test-case-fails-checkout', error: { message: 'boom' } }] }
    const failedEventForPrompt = testEndEvent(failed)
    failedEventForPrompt.status = 'failed'
    failedEventForPrompt.passed = false
    const failedPacket = buildTestReviewPacket(failed)
    const promptTemplate = path.join(tmpDir, 'prompt.md')
    fs.writeFileSync(promptTemplate, '{{evidence}}\n{{textSlots}}\n{{sourceHtmlSection}}\n{{unknown}}')
    const failedPrompt = buildEvaluationLlmPrompt({
      packet: failedPacket,
      templatePath: promptTemplate,
      flowcharts: [{ testName: 'different-test', steps: ['unused'] }],
    })
    expect(failedPrompt).toContain('"failureMessages"')
    expect(failedPrompt).toContain('[]')
    expect(failedPrompt).toContain('{{unknown}}')

    expect(__testReviewExportInternals.audienceTitle('B. authAPI warn incl auto-resolved -> done')).toBe('Auth api warning including automatically resolved then done')
    // Only code-shaped words get split apart. Acronyms, prose abbreviations and
    // ordinary words stay verbatim — splitting them produced titles like
    // "stops issuing ot ps" and "e g. English".
    expect(__testReviewExportInternals.audienceTitle('stops issuing OTPs, e.g. after a burst')).toBe('Stops issuing OTPs, e.g. after a burst')
    expect(__testReviewExportInternals.audienceTitle('reads res.body and user_id')).toBe('Reads res body and user identifier')
    expect(__testReviewExportInternals.audienceFlowDetail('2 nested assertions')).toBe('2 checks inside this shared step')
    expect(__testReviewExportInternals.audienceFlowDetail('1 nested assertion')).toBe('1 check inside this shared step')
    expect(__testReviewExportInternals.audienceFlowDetail('strict unknown nested assertion')).toBe('exact not graded included checks')
    expect(__testReviewExportInternals.audienceFlowDetail('const ids = makeIds()')).toBe('Uses the recorded test step.')
    expect(__testReviewExportInternals.audienceFlowTitle({ kind: 'start', title: 'Checkout starts' } as never, packet.tests[0])).toBe('Start the scenario')
    expect(__testReviewExportInternals.audienceFlowTitle({ kind: 'end', title: 'Result: failed' } as never, packet.tests[0])).toBe('Run result: failed')
    expect(__testReviewExportInternals.audienceFlowTitle({ kind: 'assertion', title: 'strict assertion' } as never, packet.tests[0])).toBe('Check the expected outcome')
    expect(__testReviewExportInternals.audienceFlowTitle({ kind: 'helper', title: 'Helper: makeIds', detail: 'const ids = makeIds()' } as never, packet.tests[0])).toBe('Prepare unique identifiers')
    expect(__testReviewExportInternals.audienceFlowTitle({ kind: 'setup', title: 'Setup' } as never, packet.tests[0])).toBe('Prepare the scenario')
    expect(__testReviewExportInternals.audienceFlowTitle({ kind: 'action', title: 'Action', detail: 'await page.click()' } as never, packet.tests[0])).toBe('Click the relevant control')
    expect(__testReviewExportInternals.audienceFlowTitle({ kind: 'action', title: 'Action' } as never, packet.tests[0])).toBe('Run the next step')

    expect(__testReviewExportInternals.readableAction('await expect(page.locator(".ready")).toBeVisible()', packet.tests[0])).toBe('Check the expected outcome')
    expect(__testReviewExportInternals.readableAction('await page.click()', packet.tests[0])).toBe('Click the relevant control')
    expect(__testReviewExportInternals.readableAction('await page.fill()', packet.tests[0])).toBe('Enter the required value')
    expect(__testReviewExportInternals.readableAction('await page.waitForURL(/done/)', packet.tests[0])).toBe('Wait for for url')
    expect(__testReviewExportInternals.readableAction('test.skip()', packet.tests[0])).toBe('Skip if required test setup is missing')
    expect(__testReviewExportInternals.readableAction('route request', packet.tests[0])).toBe('Prepare test data or mocks')
    expect(__testReviewExportInternals.readableAction('void anything', packet.tests[0])).toBe('Passes checkout')

    expect(__testReviewExportInternals.readableActionName('newClock', 'const start = new Date()')).toBe('Record the start time')
    expect(__testReviewExportInternals.actionFromIdentifier('expectOrder')).toBe('check order')
    expect(__testReviewExportInternals.actionFromIdentifier('assert')).toBe('check the expected outcome')
    expect(__testReviewExportInternals.actionFromIdentifier('mock')).toBe('prepare test data')
    expect(__testReviewExportInternals.actionFromIdentifier('create', 'const ids = makeIds()')).toBe('prepare unique identifiers')
    expect(__testReviewExportInternals.actionFromIdentifier('createUserId')).toBe('prepare unique identifiers')
    expect(__testReviewExportInternals.actionFromIdentifier('send')).toBe('send the request')
    expect(__testReviewExportInternals.actionFromIdentifier('postSendCall')).toBe('send call')
    expect(__testReviewExportInternals.actionFromIdentifier('read')).toBe('read the saved record')
    expect(__testReviewExportInternals.actionFromIdentifier('findOrder')).toBe('read order')
    expect(__testReviewExportInternals.actionFromIdentifier('poll')).toBe('wait for the expected result')
    expect(__testReviewExportInternals.actionFromIdentifier('waitReceipt')).toBe('wait for receipt')
    expect(__testReviewExportInternals.actionFromIdentifier('restore')).toBe('restore test data')
    expect(__testReviewExportInternals.actionFromIdentifier('enableFlag')).toBe('enable flag')
    expect(__testReviewExportInternals.actionFromIdentifier('with')).toBe('check the related records')
    expect(__testReviewExportInternals.actionFromIdentifier('hasClickTarget')).toBe('click the relevant control')
    expect(__testReviewExportInternals.actionFromIdentifier('')).toBe('')

    expect(__testReviewExportInternals.readableCreatedObject([], 'orderIds')).toBe('unique identifiers')
    expect(__testReviewExportInternals.readableCreatedObject([], undefined)).toBe('test data')
    expect(__testReviewExportInternals.readableHelperName('')).toBe('')

    expect(__testReviewExportInternals.classifyAssertion('expect(x).toBeHidden()', 'toBeHidden')).toBe('moderate')
    expect(__testReviewExportInternals.classifyAssertion('expect(count).toBeTruthy()')).toBe('shallow')
    expect(__testReviewExportInternals.classifyAssertion('expect(foo).toBeTruthy()')).toBe('unknown')

    expect(__testReviewExportInternals.confidenceForAssertions([{ kind: 'direct', label: 'x', quality: 'moderate', rationale: '', snippet: '' }])).toContain('behavioral')
    expect(__testReviewExportInternals.confidenceForAssertions([{ kind: 'direct', label: 'x', quality: 'unknown', rationale: '', snippet: '' }])).toContain('Review the engineering evidence')
    expect(__testReviewExportInternals.qualityLabel('moderate')).toBe('behavioral')
    expect(__testReviewExportInternals.qualitySummary([])).toBe('')
    expect(__testReviewExportInternals.qualitySummaryForAudience([{ kind: 'direct', label: 'x', quality: 'shallow', rationale: '', snippet: '' }])).toBe('1 surface-level')
    expect(__testReviewExportInternals.rationaleForAudience('Static analysis could not confidently classify this assertion.')).toContain("couldn't auto-rate")
    expect(__testReviewExportInternals.rationaleForAudience('other')).toBe('other')

    expect(__testReviewExportInternals.resultColor('failed')).toMatchObject({ stroke: 'var(--flow-fail-line)' })
    expect(__testReviewExportInternals.resultColor('aborted')).toMatchObject({ stroke: 'var(--flow-neutral-line)' })
    expect(__testReviewExportInternals.statusClass('')).toBe('unknown')
    expect(__testReviewExportInternals.formatMs(999)).toBe('999ms')
    expect(__testReviewExportInternals.wrapSvgText('', 10)).toEqual([''])
    expect(__testReviewExportInternals.wrapSvgText('averyverylongword', 5)).toEqual(['avery', 'veryl', 'ongwo', 'rd'])
    expect(__testReviewExportInternals.applyFlowStepRewrite([
      { kind: 'start', title: 'Original start' },
      { kind: 'action', title: 'Original action', detail: 'Original detail' },
    ] as never, [])).toEqual([
      { kind: 'start', title: 'Original start' },
      { kind: 'action', title: 'Original action', detail: 'Original detail' },
    ])
    expect(__testReviewExportInternals.applyFlowStepRewrite([
      { kind: 'start', title: 'Original start' },
      { kind: 'action', title: 'Original action', detail: 'Original detail' },
    ] as never, [{ title: 'New start' }, { title: '', detail: 'Ignored detail' }])).toEqual([
      { kind: 'start', title: 'New start' },
      { kind: 'action', title: 'Original action', detail: 'Original detail' },
    ])
    expect(__testReviewExportInternals.flowNodesForTest({
      ...packet.tests[0],
      testBody: '',
      assertions: [],
    })).toContainEqual(expect.objectContaining({ title: 'Source unavailable', detail: 'No static source match' }))
    expect(__testReviewExportInternals.renderAssertionHtml({
      kind: 'direct',
      label: 'unknown',
      quality: 'unknown',
      rationale: 'Static analysis could not confidently classify this assertion.',
      snippet: 'expect(value).toBeTruthy()',
    })).not.toContain('helper-ref')
    expect(__testReviewExportInternals.renderAssertionHtml({
      kind: 'helper',
      label: 'expectHelper',
      quality: 'strict',
      rationale: 'Uses toHaveText matcher.',
      snippet: 'expectHelper(page)',
      helperSnippet: 'function expectHelper() {}',
      helperName: 'expectHelper',
      nested: [],
    })).toContain('helper-ref')
    expect(__testReviewExportInternals.addCodeLineMarkers('<pre>plain</pre>')).toBe('<pre>plain</pre>')
    expect(__testReviewExportInternals.addCodeLineMarkers('<pre><code>a\n\nb</code></pre>')).toContain('<span class="line-source"> </span>')
    const functionSrc = ts.createSourceFile('helpers.ts', 'const helper = () => true\nconst value = 1', ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const [helperStmt, valueStmt] = functionSrc.statements
    expect(__testReviewExportInternals.functionLikeBody(helperStmt)).toBeDefined()
    expect(__testReviewExportInternals.functionLikeBody(valueStmt)).toBeUndefined()
  })
})

describe('test review export — additional branch coverage', () => {
  it('falls back to the title-cased feature name when the narrative omits a feature title', async () => {
    const html = await createEvaluationHtml(detail({ featureDir: tmpDir, feature: 'checkout_flow' }), {
      narrative: {
        summary: 'Summary without a feature title.',
        cases: [{
          title: 'Case one',
          whatWasChecked: 'Checked.',
          whyItMatters: 'Matters.',
          confidence: 'Confidence.',
        }],
      },
    })

    expect(html).toContain('<h1>Checkout Flow</h1>')
    expect(html).toContain('Summary without a feature title.')
  })

  it('ignores a JSON candidate that is an object without a `cases` array', () => {
    // The rewrite envelope is anchored on `cases`, so an agent answer whose only
    // parseable object is some other shape must not be mistaken for a rewrite.
    expect(__testReviewExportInternals.parseEvaluationRewrite('{"summary":"looks fine","tests":3}'))
      .toBeUndefined()
  })

  it('ignores a JSON candidate that is not an object at all', () => {
    // extractJsonCandidates parses whatever a fenced block contains, including a
    // bare scalar or null — neither of which can carry a `slots` array.
    expect(__testReviewExportInternals.parseEvaluationTextSlotRewrite('```json\n42\n```')).toBeUndefined()
    expect(__testReviewExportInternals.parseEvaluationTextSlotRewrite('```json\nnull\n```')).toBeUndefined()
  })
})
