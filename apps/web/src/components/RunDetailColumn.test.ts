import { describe, expect, it, vi } from 'vitest'
import { downloadEvaluationReport, evaluationFilename, evaluationHref, canRestartHeal, isEvaluationExportable, servicePrimaryLabel, serviceTabLabelParts, shortLocation } from './RunDetailColumn'

describe('canRestartHeal', () => {
  it('is enabled only for terminal runs that can be restarted', () => {
    expect(canRestartHeal('failed')).toBe(true)
    expect(canRestartHeal('aborted')).toBe(true)
    expect(canRestartHeal('running')).toBe(false)
    expect(canRestartHeal('healing')).toBe(false)
    expect(canRestartHeal('passed')).toBe(false)
  })
})

describe('evaluation export helpers', () => {
  it('is only available after a run reaches terminal state', () => {
    expect(isEvaluationExportable('passed')).toBe(true)
    expect(isEvaluationExportable('failed')).toBe(true)
    expect(isEvaluationExportable('aborted')).toBe(true)
    expect(isEvaluationExportable('running')).toBe(false)
    expect(isEvaluationExportable('healing')).toBe(false)
  })

  it('builds a zip download filename from feature and run id', () => {
    expect(evaluationFilename('shop redeeming', '2026:05:06 run')).toBe(
      'canary-lab-evaluation-shop-redeeming-2026-05-06-run.zip',
    )
    expect(evaluationHref('2026:05:06 run')).toBe('/api/runs/2026%3A05%3A06%20run/evaluation.html')
  })

  it('downloads the generated report through the evaluation endpoint', async () => {
    const click = vi.fn()
    const appended: Array<{ href: string; download: string; style: { display: string }; click: () => void; remove: () => void }> = []
    const removed: typeof appended = []
    const documentRef = {
      body: {
        appendChild: (el: typeof appended[number]) => appended.push(el),
      },
      createElement: () => {
        const link = {
          href: '',
          download: '',
          style: { display: '' },
          click,
          remove: () => removed.push(link),
        }
        return link
      },
    } as unknown as Document
    const fetchImpl = vi.fn().mockResolvedValue(new Response(new Blob(['zip']), { status: 200 }))
    const urlApi = {
      createObjectURL: vi.fn().mockReturnValue('blob:report'),
      revokeObjectURL: vi.fn(),
    }

    await downloadEvaluationReport('shop redeeming', '2026:05:06 run', { fetchImpl, documentRef, urlApi })

    expect(fetchImpl).toHaveBeenCalledWith('/api/runs/2026%3A05%3A06%20run/evaluation.html')
    expect(appended).toHaveLength(1)
    expect(appended[0].download).toBe('canary-lab-evaluation-shop-redeeming-2026-05-06-run.zip')
    expect(appended[0].href).toBe('blob:report')
    expect(click).toHaveBeenCalledTimes(1)
    expect(removed).toHaveLength(1)
    expect(urlApi.revokeObjectURL).toHaveBeenCalledWith('blob:report')
  })
})

describe('shortLocation', () => {
  it('keeps the final two path segments for compact runtime labels', () => {
    expect(shortLocation('/Users/dev/workspace/e2e/helpers/login.ts:209')).toBe('helpers/login.ts:209')
    expect(shortLocation('checkout.spec.ts:12')).toBe('checkout.spec.ts:12')
  })
})

describe('service labels', () => {
  it('uses only the repo name when the command has its own name', () => {
    const service = {
      repoName: 'mighty-cns',
      name: 'mighty-cns gateway stack',
      safeName: 'mighty-cns-gateway-stack',
      command: 'yarn start:all:dev',
      cwd: '/Users/dev/Documents/mighty-cns',
      logPath: '/tmp/svc.log',
    }

    expect(servicePrimaryLabel(service)).toBe('mighty-cns')
  })

  it('falls back to the service name for older manifests', () => {
    const service = {
      name: 'api',
      safeName: 'api',
      command: 'npm run dev',
      cwd: '/repo/api',
      logPath: '/tmp/api.log',
    }

    expect(servicePrimaryLabel(service)).toBe('api')
  })

  it('can use a repo fallback for older manifests that have branch snapshots', () => {
    const service = {
      name: 'mighty-cns gateway stack',
      safeName: 'mighty-cns-gateway-stack',
      command: 'yarn start:all:dev',
      cwd: '/Users/dev/Documents/mighty-cns',
      logPath: '/tmp/svc.log',
    }

    expect(servicePrimaryLabel(service, 'mighty-cns')).toBe('mighty-cns')
  })

  it('builds service tab labels from repo name and branch only', () => {
    const service = {
      repoName: 'mighty-cns',
      name: 'mighty-cns gateway stack',
      safeName: 'mighty-cns-gateway-stack',
      command: 'yarn start:all:dev',
      cwd: '/Users/dev/Documents/mighty-cns',
      logPath: '/tmp/svc.log',
    }

    expect(serviceTabLabelParts(service, {
      name: 'mighty-cns',
      path: '/Users/dev/Documents/mighty-cns',
      branch: 'release/2.8.2',
      expectedBranch: 'release/2.8.2',
      detached: false,
      dirty: false,
      dirtyFiles: [],
    })).toEqual({
      primary: 'mighty-cns',
      branch: 'release/2.8.2',
    })
  })
})
