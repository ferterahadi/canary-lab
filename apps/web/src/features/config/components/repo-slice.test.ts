import { describe, expect, it } from 'vitest'
import { parseRepo, serializeRepo } from './repo-slice'

describe('repo keys the Service tab does not edit', () => {
  it('survives a parse and serialize round trip', () => {
    const dependencyPreparation = {
      mode: 'isolated',
      prepareCommand: 'npm run prepare:canary',
      validateCommand: 'npm run validate:canary',
      generatorInputs: ['prisma/schema.prisma'],
    }
    // `track` is the regression this guards: it was already being dropped on
    // every save before `dependencyPreparation` existed.
    const parsed = parseRepo({
      name: 'api',
      localPath: '/repo',
      track: 'upstream',
      dependencyPreparation,
      startCommands: [{ command: 'npm run dev' }],
    })

    expect(parsed?.passthrough).toEqual({ track: 'upstream', dependencyPreparation })
    expect(parsed && serializeRepo(parsed)).toMatchObject({ track: 'upstream', dependencyPreparation })
  })

  it('lets an edited key win over its passthrough copy', () => {
    const parsed = parseRepo({ name: 'api', localPath: '/repo', branch: 'main', startCommands: [] })
    const edited = serializeRepo({ ...parsed!, branch: 'feature' })

    expect(edited).toMatchObject({ branch: 'feature' })
  })
})
