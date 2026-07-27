import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'node:url'
import {
  captureFinalPageScreenshot,
  logMarkerFixture,
  logMarkerFixtureEntry,
  pageFixture,
  pageFixtureEntry,
  playwrightStep,
  shouldCaptureFinalPageScreenshot,
  slugify,
  withLogMarkers,
  wrapWithCallSite,
  type CallSiteStep,
} from './log-marker-fixture'

const THIS_FILE = fileURLToPath(import.meta.url)

const tmpDirs: string[] = []
function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-lm-'))
  tmpDirs.push(dir)
  return fs.realpathSync(dir)
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

describe('slugify (log-marker-fixture)', () => {
  it('lowercases and replaces non-alphanumeric runs with a single dash', () => {
    expect(slugify('Test: edge CASE')).toBe('test-edge-case')
  })
  it('trims leading/trailing dashes', () => {
    expect(slugify('-foo-')).toBe('foo')
  })
})

describe('withLogMarkers', () => {
  it('no-ops when manifest is missing (run still invoked)', async () => {
    let ran = false
    await withLogMarkers('a test', '/does/not/exist.json', async () => {
      ran = true
    })
    expect(ran).toBe(true)
  })

  it('wraps run() output with open/close tags in each service log from manifest', async () => {
    const dir = mkTmp()
    const logA = path.join(dir, 'a.log')
    const logB = path.join(dir, 'b.log')
    fs.writeFileSync(logA, 'pre-a\n')
    fs.writeFileSync(logB, 'pre-b\n')
    const manifestPath = path.join(dir, 'manifest.json')
    fs.writeFileSync(manifestPath, JSON.stringify({ serviceLogs: [logA, logB] }))

    await withLogMarkers('My Case', manifestPath, async () => {
      fs.appendFileSync(logA, 'during-a\n')
      fs.appendFileSync(logB, 'during-b\n')
    })

    expect(fs.readFileSync(logA, 'utf-8')).toBe(
      'pre-a\n<test-case-my-case>\nduring-a\n</test-case-my-case>\n',
    )
    expect(fs.readFileSync(logB, 'utf-8')).toBe(
      'pre-b\n<test-case-my-case>\nduring-b\n</test-case-my-case>\n',
    )
  })

  it('supports current run manifests with services[].logPath', async () => {
    const dir = mkTmp()
    const log = path.join(dir, 'svc-api.log')
    fs.writeFileSync(log, 'pre\n')
    const manifestPath = path.join(dir, 'manifest.json')
    fs.writeFileSync(manifestPath, JSON.stringify({ services: [{ logPath: log }] }))

    await withLogMarkers('My Case', manifestPath, async () => {
      fs.appendFileSync(log, 'during\n')
    })

    expect(fs.readFileSync(log, 'utf-8')).toBe(
      'pre\n<test-case-my-case>\nduring\n</test-case-my-case>\n',
    )
  })


  it('skips close tag when run() throws (current behavior — no try/finally)', async () => {
    const dir = mkTmp()
    const log = path.join(dir, 's.log')
    fs.writeFileSync(log, '')
    const manifestPath = path.join(dir, 'manifest.json')
    fs.writeFileSync(manifestPath, JSON.stringify({ serviceLogs: [log] }))

    await expect(
      withLogMarkers('oops', manifestPath, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    expect(fs.readFileSync(log, 'utf-8')).toBe('<test-case-oops>\n')
  })
})

describe('shouldCaptureFinalPageScreenshot', () => {
  const info = (screenshot: unknown, status = 'passed', expectedStatus = 'passed') => ({
    project: { use: { screenshot } },
    status,
    expectedStatus,
  }) as never

  it('captures when screenshot mode is on', () => {
    expect(shouldCaptureFinalPageScreenshot(info('on'))).toBe(true)
  })

  it('does not capture when screenshot mode is off', () => {
    expect(shouldCaptureFinalPageScreenshot(info('off'))).toBe(false)
  })

  it('captures only unexpected outcomes for only-on-failure', () => {
    expect(shouldCaptureFinalPageScreenshot(info('only-on-failure'))).toBe(false)
    expect(shouldCaptureFinalPageScreenshot(info('only-on-failure', 'failed', 'passed'))).toBe(true)
  })
})

function fakeTestInfo(over: Record<string, unknown> = {}) {
  return {
    title: 'My Case',
    file: '/specs/login.spec.ts',
    project: { use: { screenshot: 'on' } },
    status: 'passed',
    expectedStatus: 'passed',
    outputPath: (name: string) => path.join('/out', name),
    attach: vi.fn(async () => { /* noop */ }),
    ...over,
  }
}

describe('captureFinalPageScreenshot', () => {
  it('writes a slugged screenshot and attaches it to the report', async () => {
    const dir = mkTmp()
    const testInfo = fakeTestInfo({ outputPath: (name: string) => path.join(dir, name) })
    const page = { screenshot: vi.fn(async () => undefined) }

    await captureFinalPageScreenshot(page as never, testInfo as never)

    expect(page.screenshot).toHaveBeenCalledWith({
      path: path.join(dir, 'canary-lab-final-page-my-case.png'),
      fullPage: true,
    })
    expect(testInfo.attach).toHaveBeenCalledWith('canary-lab-final-page', {
      path: path.join(dir, 'canary-lab-final-page-my-case.png'),
      contentType: 'image/png',
    })
  })

  it('does nothing when the project has screenshots off', async () => {
    const testInfo = fakeTestInfo({ project: { use: { screenshot: 'off' } } })
    const page = { screenshot: vi.fn(async () => undefined) }
    await captureFinalPageScreenshot(page as never, testInfo as never)
    expect(page.screenshot).not.toHaveBeenCalled()
    expect(testInfo.attach).not.toHaveBeenCalled()
  })

  it('swallows a screenshot failure — the terminal output is the real evidence', async () => {
    // A page that already closed or crashed must not turn a passing test into
    // a failing one over a best-effort visual aid.
    const testInfo = fakeTestInfo()
    const page = { screenshot: vi.fn(async () => { throw new Error('page closed') }) }
    await expect(captureFinalPageScreenshot(page as never, testInfo as never)).resolves.toBeUndefined()
    expect(testInfo.attach).not.toHaveBeenCalled()
  })
})

describe('wrapWithCallSite', () => {
  const recordingStep = (): { step: CallSiteStep; calls: Array<{ title: string; line: number }> } => {
    const calls: Array<{ title: string; line: number }> = []
    const step: CallSiteStep = (title, body, options) => {
      calls.push({ title, line: options.location.line })
      return body()
    }
    return { step, calls }
  }

  it('passes non-function and symbol-keyed properties straight through', () => {
    const { step } = recordingStep()
    const marker = Symbol('marker')
    const target = { url: 'https://example.test', [marker]: () => 'raw' }
    const wrapped = wrapWithCallSite(target, THIS_FILE, step)
    expect(wrapped.url).toBe('https://example.test')
    expect(wrapped[marker]()).toBe('raw')
  })

  it('reports an async call as a step located at the caller in the spec file', async () => {
    const { step, calls } = recordingStep()
    const target = { goto: async (url: string) => `went to ${url}` }
    const wrapped = wrapWithCallSite(target, THIS_FILE, step)

    await expect(wrapped.goto('/login')).resolves.toBe('went to /login')
    expect(calls).toHaveLength(1)
    expect(calls[0].title).toBe('page.goto')
    expect(calls[0].line).toBeGreaterThan(0)
  })

  it('does not emit a step when the call site is outside the spec file', async () => {
    // No frame means the summary reporter has nothing to highlight, so the
    // call must pass through untouched rather than produce a located step
    // pointing at somebody else's file.
    const { step, calls } = recordingStep()
    const target = { goto: async () => 'ok' }
    const wrapped = wrapWithCallSite(target, '/not/in/this/stack.spec.ts', step)

    await expect(wrapped.goto()).resolves.toBe('ok')
    expect(calls).toEqual([])
  })

  it('returns synchronous results untouched', () => {
    const { step, calls } = recordingStep()
    const wrapped = wrapWithCallSite({ isClosed: () => false }, THIS_FILE, step)
    expect(wrapped.isClosed()).toBe(false)
    expect(calls).toEqual([])
  })

  it('re-wraps locator-returning calls so a chained call keeps the original site', async () => {
    const { step, calls } = recordingStep()
    const locator = { click: async () => 'clicked' }
    const target = { locator: () => locator }
    const wrapped = wrapWithCallSite(target, THIS_FILE, step)

    const found = wrapped.locator()
    // `locator()` itself is synchronous, so it emits no step of its own; the
    // chained `click()` inherits the frame captured at the `locator()` site.
    expect(calls).toEqual([])
    await expect(found.click()).resolves.toBe('clicked')
    expect(calls).toHaveLength(1)
    expect(calls[0].title).toBe('page.click')
  })

  it('re-wraps a locator even when no call site was found', async () => {
    // Nothing to inherit and nothing to capture: the chain must still be
    // wrapped so a later call from inside the spec can locate itself.
    const { step, calls } = recordingStep()
    const locator = { click: async () => 'clicked' }
    const wrapped = wrapWithCallSite({ locator: () => locator }, '/not/in/this/stack.spec.ts', step)

    await expect(wrapped.locator().click()).resolves.toBe('clicked')
    expect(calls).toEqual([])
  })
})

describe('pageFixture', () => {
  it('hands the test a wrapped page and screenshots the real one afterwards', async () => {
    const dir = mkTmp()
    const order: string[] = []
    const page = {
      goto: async () => { order.push('goto'); return 'ok' },
      screenshot: vi.fn(async () => { order.push('screenshot'); return undefined }),
    }
    const testInfo = fakeTestInfo({ outputPath: (name: string) => path.join(dir, name) })
    const noopStep: CallSiteStep = (_title, body) => body()

    await pageFixture(page as never, async (wrapped) => {
      expect(wrapped).not.toBe(page)
      await (wrapped as unknown as { goto: () => Promise<string> }).goto()
    }, testInfo as never, noopStep)

    // The screenshot must come after the test body is done with the page, and
    // must be taken against the real page rather than the proxy.
    expect(order).toEqual(['goto', 'screenshot'])
    expect(page.screenshot).toHaveBeenCalledOnce()
  })
})

describe('logMarkerFixture', () => {
  it('brackets the test body with markers in each service log', async () => {
    const dir = mkTmp()
    const log = path.join(dir, 'api.log')
    fs.writeFileSync(log, '')
    const manifestPath = path.join(dir, 'manifest.json')
    fs.writeFileSync(manifestPath, JSON.stringify({ serviceLogs: [log] }))

    let used = false
    await logMarkerFixture(async () => {
      used = true
      fs.appendFileSync(log, 'body\n')
    }, { title: 'My Case' }, manifestPath)

    expect(used).toBe(true)
    expect(fs.readFileSync(log, 'utf-8')).toBe('<test-case-my-case>\nbody\n</test-case-my-case>\n')
  })

  it('still runs the test body when no manifest exists', async () => {
    let used = false
    await logMarkerFixture(async () => { used = true }, { title: 'x' }, '/does/not/exist.json')
    expect(used).toBe(true)
  })
})

describe('base.extend wiring', () => {
  it('pageFixtureEntry unwraps the fixture bag and runs the page fixture', async () => {
    const dir = mkTmp()
    const page = { screenshot: vi.fn(async () => undefined) }
    const testInfo = fakeTestInfo({ outputPath: (name: string) => path.join(dir, name) })

    let handed: unknown
    await pageFixtureEntry(
      { page } as never,
      async (wrapped) => { handed = wrapped },
      testInfo as never,
    )

    expect(handed).not.toBe(page)
    expect(page.screenshot).toHaveBeenCalledOnce()
  })

  it('logMarkerFixtureEntry runs the marker fixture against the default manifest path', async () => {
    // No manifest at the resolved default path in this checkout, so the
    // fixture degrades to a no-op and the body still runs — which is exactly
    // the behaviour when specs are run directly with Playwright.
    let used = false
    await logMarkerFixtureEntry({}, async () => { used = true }, { title: 'x' } as never)
    expect(used).toBe(true)
  })

  it('playwrightStep delegates to Playwright test.step', async () => {
    // Outside a worker `test.step` cannot run, and that rejection IS the proof
    // of delegation — reproducing a worker is the one thing a unit test can't do.
    await expect(Promise.resolve(playwrightStep(
      'page.goto',
      () => undefined,
      { location: { file: '/specs/login.spec.ts', line: 1, column: 1 } },
    ))).rejects.toThrow()
  })
})
