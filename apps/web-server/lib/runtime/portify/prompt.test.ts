import { describe, expect, it } from 'vitest'
import type { FeatureConfig } from '../../../../../shared/launcher/types'
import { buildPortifyPrompt, buildPortifyRetryPrompt } from './prompt'

const feature: FeatureConfig = {
  name: 'cns',
  description: 'd',
  envs: ['local'],
  featureDir: '/work/features/cns',
  repos: [{
    name: 'mighty-cns',
    localPath: '~/mighty-cns',
    startCommands: ['yarn start:all:dev', { command: 'yarn worker', name: 'worker' }],
  }],
}

describe('buildPortifyPrompt', () => {
  it('names the feature, lists repos with their worktree edit path, and the config path', () => {
    const prompt = buildPortifyPrompt(feature, [{ name: 'mighty-cns', editPath: '/wt/mighty-cns' }])
    expect(prompt).toContain('"cns"')
    expect(prompt).toContain('edit source in: /wt/mighty-cns')
    expect(prompt).toContain('/work/features/cns/feature.config.cjs')
    expect(prompt).toContain('yarn start:all:dev')
    expect(prompt).toContain('${port.<slot>}')
  })

  it('falls back to the canonical path when no edit target is given', () => {
    const prompt = buildPortifyPrompt(feature, [])
    expect(prompt).toContain('edit source in: ~/mighty-cns')
  })

  it('handles a repo with no start commands', () => {
    const f: FeatureConfig = { ...feature, repos: [{ name: 'svc', localPath: '~/svc' }] }
    const prompt = buildPortifyPrompt(f, [{ name: 'svc', editPath: '/wt/svc' }])
    expect(prompt).toContain('(no start commands)')
  })

  it('handles a feature with no repos at all', () => {
    const f: FeatureConfig = { ...feature, repos: undefined }
    const prompt = buildPortifyPrompt(f, [])
    expect(prompt).toContain('"cns"')
  })
})

describe('buildPortifyRetryPrompt', () => {
  it('embeds the verification failure detail and the config path', () => {
    const prompt = buildPortifyRetryPrompt(feature, 'port 3007 still bound')
    expect(prompt).toContain('did not pass verification')
    expect(prompt).toContain('port 3007 still bound')
    expect(prompt).toContain('/work/features/cns/feature.config.cjs')
  })
})
