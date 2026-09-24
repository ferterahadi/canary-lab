import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { prepareRequirementsDraft, readRequirementsDraft, saveRequirementsDraft, clearRequirementsDraft } from './requirements-draft'

let root: string
let featureDir: string
let flightDir: string
const outName = 'checkout-prd.md'
const reply = JSON.stringify({ requirements: [{ id: 'R7', title: 'Checkout', text: 'It should check out.', pathTypes: ['happy'] }] })
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-requirements-draft-'))
  featureDir = path.join(root, 'feature')
  flightDir = path.join(root, 'flight')
  fs.mkdirSync(path.join(featureDir, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(featureDir, 'docs', 'source.md'), 'Checkout is supported.')
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

it('keeps all source docs in the prompt and preserves the previous id spine', () => {
  fs.writeFileSync(path.join(featureDir, 'docs', '_prd-summary.json'), JSON.stringify({ requirements: [{ id: 'R7', title: 'Checkout', text: 'It should check out.', pathTypes: ['happy'] }] }))
  const prepared = prepareRequirementsDraft(featureDir, flightDir, outName)
  expect(prepared.prompt).toContain(path.join(featureDir, 'docs', 'source.md'))
  expect(prepared.prompt).toContain(path.join(featureDir, 'docs', outName))
  expect(prepared.prompt).toContain('R7')
  fs.writeFileSync(path.join(featureDir, 'docs', outName), 'It should check out.')
  expect(saveRequirementsDraft(featureDir, flightDir, outName, prepared.input, reply)).toBe(true)
  expect(readRequirementsDraft(featureDir, flightDir)?.requirements[0].id).toBe('R7')
  clearRequirementsDraft(flightDir)
  expect(readRequirementsDraft(featureDir, flightDir)).toBeNull()
})

it.each(['doc', 'prior summary'] as const)('does not reuse a draft when the %s changes during collection', (what) => {
  const prepared = prepareRequirementsDraft(featureDir, flightDir, outName)
  const target = what === 'doc' ? 'source.md' : '_prd-summary.json'
  fs.writeFileSync(path.join(featureDir, 'docs', target), what === 'doc' ? 'Now refunds too.' : '{"requirements":[]}')
  expect(saveRequirementsDraft(featureDir, flightDir, outName, prepared.input, reply)).toBe(false)
  expect(readRequirementsDraft(featureDir, flightDir)).toBeNull()
})

it.each(['doc', 'prior summary', 'malformed'] as const)('rejects a saved draft after %s changes before summary assembly', (what) => {
  const prepared = prepareRequirementsDraft(featureDir, flightDir, outName)
  expect(saveRequirementsDraft(featureDir, flightDir, outName, prepared.input, reply)).toBe(true)
  if (what === 'malformed') {
    const target = path.join(flightDir, 'docs', 'requirements-draft.json')
    const draft = JSON.parse(fs.readFileSync(target, 'utf-8'))
    fs.writeFileSync(target, JSON.stringify({ ...draft, submission: { requirements: [] } }))
  } else {
    fs.writeFileSync(path.join(featureDir, 'docs', what === 'doc' ? 'source.md' : '_prd-summary.json'), what === 'doc' ? 'Changed.' : '{"requirements":[]}')
  }
  expect(readRequirementsDraft(featureDir, flightDir)).toBeNull()
})

it('falls back for old handoffs, prose-only replies, invalid JSON and empty requirement lists', () => {
  const prepared = prepareRequirementsDraft(featureDir, flightDir, outName)
  expect(saveRequirementsDraft(featureDir, flightDir, outName, undefined, reply)).toBe(false)
  for (const answer of ['Collected checkout docs.', '{bad json}', '{"requirements":[]}']) {
    expect(saveRequirementsDraft(featureDir, flightDir, outName, prepared.input, answer)).toBe(false)
  }
  expect(readRequirementsDraft(featureDir, flightDir)).toBeNull()
})

it('a new collector attempt discards the previous draft', () => {
  const prepared = prepareRequirementsDraft(featureDir, flightDir, outName)
  saveRequirementsDraft(featureDir, flightDir, outName, prepared.input, reply)
  prepareRequirementsDraft(featureDir, flightDir, outName)
  expect(readRequirementsDraft(featureDir, flightDir)).toBeNull()
})
