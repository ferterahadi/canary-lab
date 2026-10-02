import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, expect, it } from 'vitest'
import { buildOrchestratorHealPrompt } from './auto-heal'
import { renderDiagnosisPolicy } from './heal-diagnosis-policy'
import { diagnosisPolicy, DIAGNOSIS_POLICIES } from '../../../../../../../shared/diagnosis-policy'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

it('defaults to parent-only, keeps per-failure selectable and rejects unsupported policies', () => {
  expect(diagnosisPolicy(undefined)).toBe('parent-only')
  expect(renderDiagnosisPolicy()).toBe(renderDiagnosisPolicy('parent-only'))
  expect(renderDiagnosisPolicy()).not.toContain('sub-agent per failure')
  expect(renderDiagnosisPolicy('per-failure')).toContain('sub-agent per failure')
  expect(() => diagnosisPolicy('automatic')).toThrow('Unsupported')
  expect(renderDiagnosisPolicy('parent-only')).toContain('do not spawn diagnosis children')
  expect(renderDiagnosisPolicy('adaptive')).toContain('at most two concurrent children')
})

it('renders each policy through the real loader, preserves service guardrails and recovers the recorded policy after resume', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-policy-test-')); roots.push(root)
  for (const policy of DIAGNOSIS_POLICIES) {
    const runDir = path.join(root, policy); fs.mkdirSync(runDir)
    const manifest = { repoPaths: [path.join(root, 'app')], diagnosisPolicy: policy }
    fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest))
    const build = buildOrchestratorHealPrompt({ agent: 'codex', projectRoot: root, runDir })
    const prompt = build({ cycle: 1, outputDir: runDir })
    expect(prompt).toContain(renderDiagnosisPolicy(policy))
    expect(prompt).toContain('Fix service/app code, not tests.')
    expect(prompt).toContain('Do not read the test spec')
    expect(prompt).toContain('The signal is not a claim that the fix already passes')
    expect(prompt).not.toContain('{{diagnosisPolicyGuidance}}')
    if (policy !== 'per-failure') expect(prompt).not.toContain('sub-agent per failure')
    const resumed = buildOrchestratorHealPrompt({ agent: 'codex', projectRoot: root, runDir, diagnosisPolicy: 'per-failure' })
    expect(resumed({ cycle: 2, outputDir: runDir })).toContain(renderDiagnosisPolicy(policy))
    fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({ ...manifest, repoPaths: [] }))
    expect(build({ cycle: 2, outputDir: runDir })).toContain('This feature has no editable service repos.')
  }
})
