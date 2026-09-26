import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { deleteSuite } from './feature-deletion'
import { deleteFeature } from './feature-authoring'
import { FlightRunStore } from '../../flights/logic/store'
import { removeFlightRecordsForFeature } from '../../flights/logic/flight-queue'
import type { FlightManifest } from '../../flights/logic/types'

let dir: string
let featuresDir: string
let suite: string
let flights: FlightRunStore
let flight: FlightManifest
let remove: ReturnType<typeof vi.fn<(feature: string) => ReturnType<typeof removeFlightRecordsForFeature>>>
const publish = vi.fn()
const input = { feature: 'checkout', confirmName: 'checkout' }
const deps = () => ({ featuresDir, workspaceEvents: { publish }, removeFlightRecordsFor: remove })

function config(featureDir: string | undefined): void {
  fs.writeFileSync(path.join(suite, 'feature.config.cjs'),
    `exports.config = { name: 'checkout', repos: [], featureDir: ${JSON.stringify(featureDir)} }`)
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'suite-deletion-')))
  featuresDir = path.join(dir, 'features')
  suite = path.join(featuresDir, 'checkout')
  fs.mkdirSync(suite, { recursive: true })
  config(suite)
  flights = new FlightRunStore(path.join(dir, 'logs'))
  flight = { flightId: 'saved', feature: 'checkout', repoPaths: [], description: 'fixture',
    opts: { env: 'local', coverageTarget: 100, yolo: false }, status: 'done', currentStage: null, stages: [],
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }
  flights.save(flight)
  remove = vi.fn((feature) => removeFlightRecordsForFeature(flights, feature))
  publish.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

it.each([
  { label: 'missing suite', feature: 'missing', confirmName: 'missing', statusCode: 404, error: 'feature not found' },
  { label: 'missing suite and wrong confirmation', feature: 'missing', confirmName: 'wrong', statusCode: 404, error: 'feature not found' },
  { label: 'wrong confirmation', feature: 'checkout', confirmName: 'wrong', statusCode: 400, error: 'confirmName must match the feature name' },
  { label: 'absent confirmation', feature: 'checkout', statusCode: 400, error: 'confirmName must match the feature name' },
])('refuses $label before calling cleanup', ({ label: _label, statusCode, error, ...request }) => {
  expect(deleteSuite(deps(), request)).toEqual({ ok: false, statusCode, error })
  expect(remove).not.toHaveBeenCalled()
  expect(flights.get('saved')).toEqual(flight)
  expect(fs.existsSync(suite)).toBe(true)
  expect(publish).not.toHaveBeenCalled()
})

it('treats a suite without a declared directory as missing', () => {
  config(undefined)
  expect(deleteSuite(deps(), input)).toEqual({ ok: false, statusCode: 404, error: 'feature not found' })
  expect(remove).not.toHaveBeenCalled()
  expect(flights.get('saved')).toEqual(flight)
  expect(publish).not.toHaveBeenCalled()
})

it.each(['root', 'outside'] as const)('refuses the %s directory before removing history', (target) => {
  const featureDir = target === 'root' ? featuresDir : path.join(dir, 'outside')
  fs.mkdirSync(featureDir, { recursive: true })
  config(featureDir)
  expect(deleteSuite(deps(), input)).toEqual({ ok: false, statusCode: 400, error: 'feature directory is outside the features root', featureDir })
  expect(remove).not.toHaveBeenCalled()
  expect(flights.get('saved')).toEqual(flight)
  expect(fs.existsSync(featureDir)).toBe(true)
  expect(publish).not.toHaveBeenCalled()
})

it.each(['running', 'waiting-for-approval'] as const)('keeps all records and files when a Flight is %s', (status) => {
  flights.save({ ...flight, flightId: 'active', status })
  expect(deleteSuite(deps(), input)).toEqual({ ok: false, statusCode: 409, error: `flight active is ${status} — pause it before deleting the suite` })
  expect(flights.list()).toHaveLength(2)
  expect(fs.existsSync(suite)).toBe(true)
  expect(publish).not.toHaveBeenCalled()
})

it('removes all eligible Flight records before the directory, then announces deletion once', () => {
  flights.save({ ...flight, flightId: 'paused', status: 'paused', pauseReason: 'user' })
  const removed: string[] = []
  flights.onEvent((event) => {
    if (event.kind === 'removed') {
      expect(fs.existsSync(suite)).toBe(true)
      removed.push(event.flightId!)
    }
  })
  publish.mockImplementation(() => {
    expect(fs.existsSync(suite)).toBe(false)
    expect(flights.list()).toEqual([])
  })
  expect(deleteSuite(deps(), input)).toEqual({ ok: true, featureDir: suite, flightRecordsRemoved: 2 })
  expect(removed.sort()).toEqual(['paused', 'saved'])
  expect(remove).toHaveBeenCalledExactlyOnceWith('checkout')
  expect(publish).toHaveBeenCalledExactlyOnceWith({ type: 'feature-deleted', feature: 'checkout' })
})

it('deletes a suite with no Flight history', () => {
  flights.remove('saved')
  expect(deleteSuite(deps(), input)).toEqual({ ok: true, featureDir: suite, flightRecordsRemoved: 0 })
  expect(fs.existsSync(suite)).toBe(false)
  expect(publish).toHaveBeenCalledExactlyOnceWith({ type: 'feature-deleted', feature: 'checkout' })
})

it('supports directory-only callers without a Flight hook or publisher', () => {
  expect(deleteSuite({ featuresDir }, input)).toEqual({ ok: true, featureDir: suite, flightRecordsRemoved: 0 })
  expect(flights.get('saved')).toEqual(flight)
  expect(fs.existsSync(suite)).toBe(false)
})

it('keeps the legacy helper result and confirmation-first precedence', () => {
  const context = { projectRoot: dir, featuresDir, workspaceEvents: { publish } }
  expect(deleteFeature(context, { feature: 'missing', confirmName: 'wrong' }))
    .toEqual({ ok: false, error: 'confirmName must match the feature name' })
  expect(deleteFeature(context, { feature: 'missing', confirmName: 'missing' })).toEqual({ ok: false, error: 'feature not found' })
  expect(deleteFeature(context, input)).toEqual({ ok: true, featureDir: suite })
  expect(flights.get('saved')).toEqual(flight)
})

it('propagates cleanup failures without deleting the directory or publishing success', () => {
  const error = new Error('Flight store unavailable')
  remove.mockImplementation(() => { throw error })
  expect(() => deleteSuite(deps(), input)).toThrow(error)
  expect(fs.existsSync(suite)).toBe(true)
  expect(flights.get('saved')).toEqual(flight)
  expect(publish).not.toHaveBeenCalled()
})

it('propagates directory removal failure without publishing success or rolling back Flight cleanup', () => {
  const error = new Error('Directory is read-only')
  const rm = fs.rmSync
  vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
    if (target === suite) throw error
    rm(target, options)
  })
  expect(() => deleteSuite(deps(), input)).toThrow(error)
  expect(flights.list()).toEqual([])
  expect(fs.existsSync(suite)).toBe(true)
  expect(publish).not.toHaveBeenCalled()
})
