import { describe, it, expect } from 'vitest'
import type { RepoPrerequisite } from './types'
import { portInjectability, startCommandPortSlotCounts } from './port-injectability'

function repo(startCommands: RepoPrerequisite['startCommands']): RepoPrerequisite {
  return { name: 'app', localPath: '/tmp/app', startCommands } as RepoPrerequisite
}

describe('portInjectability', () => {
  it('is none when the feature starts nothing', () => {
    expect(portInjectability(undefined)).toBe('none')
    expect(portInjectability([])).toBe('none')
    expect(portInjectability([repo([])])).toBe('none')
  })

  it('is none when no start command declares a slot', () => {
    expect(portInjectability([repo([{ command: 'npm run dev' }])])).toBe('none')
  })

  // A bare string command has nowhere to declare a port, so it can never count.
  it('treats a string start command as unslotted', () => {
    expect(portInjectability([repo(['npm run dev'])])).toBe('none')
    expect(portInjectability([repo(['npm run dev', { command: 'npm run api', ports: [{ name: 'api', env: 'PORT' }] }])]))
      .toBe('partial')
  })

  it('is declared when every start command carries a slot, across repos', () => {
    expect(portInjectability([
      repo([{ command: 'npm run dev:catalog', ports: [{ name: 'catalog', env: 'PORT' }] }]),
      repo([{ command: 'npm run dev:checkout', ports: [{ name: 'checkout', env: 'PORT' }] }]),
    ])).toBe('declared')
  })

  it('is partial when one command would still clash', () => {
    expect(portInjectability([
      repo([{ command: 'npm run dev:catalog', ports: [{ name: 'catalog', env: 'PORT' }] }]),
      repo([{ command: 'npm run dev:checkout' }]),
    ])).toBe('partial')
  })

  it('reports the raw counts the state band renders', () => {
    expect(startCommandPortSlotCounts([
      repo([{ command: 'a', ports: [{ name: 'a', env: 'PORT' }] }, { command: 'b' }]),
    ])).toEqual({ total: 2, slotted: 1 })
  })
})
