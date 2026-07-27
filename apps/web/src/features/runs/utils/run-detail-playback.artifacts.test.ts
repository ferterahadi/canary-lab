import { describe, expect, it } from 'vitest'
import type {
  PlaywrightArtifactGroup,
  PlaywrightPlaybackEvent,
  RepoBranchSnapshot,
  ServiceManifestEntry,
} from '@/shared/api/types'

import {
  DEFAULT_PLAYWRIGHT_ARTIFACT_POLICY,
  artifactsForPlayback,
  branchForService,
  branchLabel,
  branchTooltip,
  playbackTests,
} from './run-detail-playback'

function artifact(kind: PlaywrightArtifactGroup['artifacts'][number]['kind'], name: string, mtimeMs: number | undefined = 0, artifactPath = `/tmp/${name}`): PlaywrightArtifactGroup['artifacts'][number] {
  return {
    name,
    kind,
    path: artifactPath,
    url: `/artifacts/${name}`,
    sizeBytes: 1,
    mtimeMs,
  }
}

function repo(repoPath: string, branch: string | null): RepoBranchSnapshot {
  return {
    name: 'repo',
    path: repoPath,
    branch,
    detached: false,
    dirty: false,
  }
}

function service(cwd: string): Pick<ServiceManifestEntry, 'cwd'> {
  return { cwd }
}

describe('artifactsForPlayback', () => {
  const groups: PlaywrightArtifactGroup[] = [
    {
      testName: 'auth.spec.ts:login',
      artifacts: [
        artifact('screenshot', 'screen.png', 1),
        artifact('screenshot', 'canary-lab-final-page-login.png', 2),
        artifact('trace', 'trace.zip'),
        artifact('video', 'video.webm'),
        artifact('other', 'notes.txt'),
      ],
    },
  ]

  it('uses default policy when no run policy exists', () => {
    expect(artifactsForPlayback('auth.spec.ts:login', groups, undefined)).toEqual({
      screenshotMode: DEFAULT_PLAYWRIGHT_ARTIFACT_POLICY.screenshot,
      screenshots: [artifact('screenshot', 'canary-lab-final-page-login.png', 2)],
      links: [artifact('trace', 'trace.zip')],
    })
  })

  it('hides screenshots and retained links disabled by policy', () => {
    expect(artifactsForPlayback('auth.spec.ts:login', groups, {
      screenshot: 'off',
      video: 'off',
      trace: 'off',
    })).toEqual({
      screenshotMode: 'off',
      screenshots: [],
      links: [],
    })
  })

  it('includes retained video links when policy enables them', () => {
    expect(artifactsForPlayback('auth.spec.ts:login', groups, {
      screenshot: 'on',
      video: 'on-first-retry',
      trace: 'retain-on-failure',
    })).toEqual({
      screenshotMode: 'on',
      screenshots: [artifact('screenshot', 'canary-lab-final-page-login.png', 2)],
      links: [artifact('trace', 'trace.zip'), artifact('video', 'video.webm')],
    })
  })

  it('returns empty artifacts when the test has no artifact group', () => {
    expect(artifactsForPlayback('missing', groups, {
      screenshot: 'on',
      video: 'on',
      trace: 'on',
    })).toEqual({
      screenshotMode: 'on',
      screenshots: [],
      links: [],
    })
  })

  it('falls back to the newest screenshot when no final-page screenshot exists', () => {
    const groupsWithoutFinal: PlaywrightArtifactGroup[] = [
      {
        testName: 'auth.spec.ts:login',
        artifacts: [
          artifact('screenshot', 'older.png'),
          artifact('screenshot', 'newer.png', 3),
        ],
      },
    ]

    expect(artifactsForPlayback('auth.spec.ts:login', groupsWithoutFinal, {
      screenshot: 'only-on-failure',
      video: 'off',
      trace: 'off',
    }).screenshots).toEqual([artifact('screenshot', 'newer.png', 3)])
  })

  it('keeps screenshot ordering stable when mtimes are missing', () => {
    // Pass mtimeMs as explicit undefined via cast to bypass the default in `artifact()`,
    // exercising the `?? 0` fallback in the sort comparator.
    const missingMtime = (name: string): PlaywrightArtifactGroup['artifacts'][number] => ({
      name,
      kind: 'screenshot',
      path: `/tmp/${name}`,
      url: `/artifacts/${name}`,
      sizeBytes: 1,
      mtimeMs: undefined as unknown as number,
    })
    const groupsWithoutMtime: PlaywrightArtifactGroup[] = [
      {
        testName: 'auth.spec.ts:login',
        artifacts: [missingMtime('first.png'), missingMtime('second.png')],
      },
    ]

    const result = artifactsForPlayback('auth.spec.ts:login', groupsWithoutMtime, {
      screenshot: 'on',
      video: 'off',
      trace: 'off',
    }).screenshots
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('first.png')
  })

  it('prefers the deterministic final-page screenshot over attachment duplicates', () => {
    const groupsWithAttachmentDuplicate: PlaywrightArtifactGroup[] = [
      {
        testName: 'auth.spec.ts:login',
        artifacts: [
          artifact('screenshot', 'canary-lab-final-page-hash.png', 5, 'case/attachments/canary-lab-final-page-hash.png'),
          artifact('screenshot', 'canary-lab-final-page-login.png', 2, 'case/canary-lab-final-page-login.png'),
          artifact('screenshot', 'test-finished-1.png', 6, 'case/test-finished-1.png'),
        ],
      },
    ]

    expect(artifactsForPlayback('auth.spec.ts:login', groupsWithAttachmentDuplicate, {
      screenshot: 'on',
      video: 'off',
      trace: 'off',
    }).screenshots).toEqual([
      artifact('screenshot', 'canary-lab-final-page-login.png', 2, 'case/canary-lab-final-page-login.png'),
    ])
  })
})

describe('branch helpers', () => {
  const branches: RepoBranchSnapshot[] = [
    repo('/workspace', 'main'),
    repo('/workspace/apps/shop', 'checkout'),
    repo('/other', 'other'),
  ]

  it('selects the closest repo path for a service cwd', () => {
    expect(branchForService(service('/workspace'), branches)).toEqual(repo('/workspace', 'main'))
    expect(branchForService(service('/workspace/apps/shop/web'), branches)).toEqual(repo('/workspace/apps/shop', 'checkout'))
    expect(branchForService(service('/workspace/api'), branches)).toEqual(repo('/workspace', 'main'))
    expect(branchForService(service('/missing'), branches)).toBeNull()
    expect(branchForService(service('////'), [repo('/', 'root')])).toEqual(repo('/', 'root'))
    expect(branchForService(service('/workspace/apps/shop/web'), [
      repo('/workspace/apps/shop', 'checkout'),
      repo('/workspace', 'main'),
    ])).toEqual(repo('/workspace/apps/shop', 'checkout'))
  })

  it('formats branch labels and tooltips', () => {
    expect(branchLabel({ ...repo('/workspace', null), detached: true })).toBe('detached')
    expect(branchLabel(repo('/workspace', null))).toBe('unknown')
    expect(branchLabel(repo('/workspace', 'main'))).toBe('main')

    expect(branchTooltip(service('/workspace/app'), {
      ...repo('/workspace', 'feature/current'),
      expectedBranch: 'main',
      dirty: true,
    })).toBe([
      'repo: repo',
      'branch: feature/current',
      'expected: main',
      'dirty: yes',
      'mismatch: yes',
      'repo path: /workspace',
      'service cwd: /workspace/app',
    ].join('\n'))

    expect(branchTooltip(service('/workspace/app'), repo('/workspace/', 'main'))).toBe([
      'repo: repo',
      'branch: main',
      'repo path: /workspace/',
      'service cwd: /workspace/app',
    ].join('\n'))
  })
})
