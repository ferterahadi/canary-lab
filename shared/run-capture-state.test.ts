import { expect, it } from 'vitest'
import { runCaptureCases } from './__fixtures__/run-capture-state'
import { deriveRunCaptureState } from './run-capture-state'

it.each(runCaptureCases)('derives capture finality: $name', ({ run, runStopped, finalCapture }) => {
  expect(deriveRunCaptureState(run)).toEqual({ runStopped, finalCapture })
})
