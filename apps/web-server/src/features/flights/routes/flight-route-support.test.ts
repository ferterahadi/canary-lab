import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveFlightModels } from './flight-route-support'

describe('resolveFlightModels', () => {
  let projectRoot: string

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-flight-models-'))
    fs.writeFileSync(path.join(projectRoot, 'canary-lab.config.json'), JSON.stringify({
      agentModels: {
        claude: { heal: { model: 'opus', effort: 'high' }, report: { model: 'haiku', effort: null } },
        codex: {},
      },
    }))
  })

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true })
  })

  it('takes the saved plan when the launch sends no override', () => {
    expect(resolveFlightModels(projectRoot, 'claude', undefined)).toEqual({
      heal: { model: 'opus', effort: 'high' },
      report: { model: 'haiku', effort: null },
    })
  })

  it('lays override entries over the saved plan', () => {
    expect(resolveFlightModels(projectRoot, 'claude', { heal: { model: 'sonnet', effort: 'low' } })).toEqual({
      heal: { model: 'sonnet', effort: 'low' },
      report: { model: 'haiku', effort: null },
    })
  })

  it('an explicit agent default turns a saved pin off and leaves no entry behind', () => {
    // Absent = agent default is the stored shape `stageModels` reads, so the
    // override removes the key rather than persisting `{ null, null }`.
    expect(resolveFlightModels(projectRoot, 'claude', {
      heal: { model: null, effort: null },
      scout: { model: null, effort: null },
    })).toEqual({ report: { model: 'haiku', effort: null } })
  })
})
