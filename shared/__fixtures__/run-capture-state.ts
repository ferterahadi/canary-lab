import type { RunCaptureInput } from '../run-capture-state'

export const runCaptureCases: Array<{
  name: string
  run: RunCaptureInput
  runStopped: boolean
  finalCapture: boolean
}> = [
  { name: 'queued', run: { status: 'queued', endedAt: 'recorded' }, runStopped: false, finalCapture: false },
  { name: 'running', run: { status: 'running', endedAt: 'recorded' }, runStopped: false, finalCapture: false },
  { name: 'healing', run: { status: 'healing' }, runStopped: false, finalCapture: false },
  { name: 'passed', run: { status: 'passed', endedAt: 'recorded' }, runStopped: true, finalCapture: true },
  { name: 'failed', run: { status: 'failed', endedAt: 'recorded' }, runStopped: true, finalCapture: true },
  { name: 'aborted', run: { status: 'aborted', endedAt: 'recorded' }, runStopped: true, finalCapture: true },
  { name: 'terminal without teardown', run: { status: 'failed' }, runStopped: false, finalCapture: false },
  { name: 'empty end time', run: { status: 'passed', endedAt: '' }, runStopped: false, finalCapture: false },
  { name: 'provisional after stop', run: { status: 'failed', endedAt: 'recorded', fixCapture: { provisional: true } }, runStopped: true, finalCapture: false },
  { name: 'explicit final capture', run: { status: 'failed', endedAt: 'recorded', fixCapture: { provisional: false } }, runStopped: true, finalCapture: true },
  { name: 'legacy capture', run: { status: 'failed', endedAt: 'recorded', fixCapture: {} }, runStopped: true, finalCapture: true },
]
