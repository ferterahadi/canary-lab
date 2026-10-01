import { expect, it } from 'vitest'
import { recoverCandidateResources, recoveryLabel, type ContainerRecoveryPlan, type DockerRun } from './container-recovery'
import type { CommandResult } from '../files'

const plan: ContainerRecoveryPlan = { privateDir: '/tmp/synthetic-study', executable: 'docker', env: {},
  owner: 'synthetic-owner', volume: 'synthetic-volume', containers: ['synthetic-build', 'synthetic-host'] }
const result = (code: number, stdout = '', stderr = ''): CommandResult => ({ code, stdout, stderr, signal: null, timedOut: false })

it('removes running owned containers before their volume, including creation without a saved evaluator record', async () => {
  const resources = new Map(plan.containers.map((name) => [name, { Id: name, Config: { Labels: { [recoveryLabel]: plan.owner } },
    State: { Running: true, Pid: 123 } }]))
  let volume = true
  const removed: string[] = []
  const run: DockerRun = async (args) => {
    if (args[1] === 'inspect') {
      if (args[0] === 'volume') return volume ? result(0, JSON.stringify([{ Labels: { [recoveryLabel]: plan.owner } }]))
        : result(1, '', 'get synthetic-volume: no such volume\n')
      const value = resources.get(args[2])
      return value ? result(0, JSON.stringify([value])) : result(1, '', `No such container: ${args[2]}`)
    }
    if (args[0] === 'kill') resources.get(args[1])!.State = { Running: false, Pid: 0 }
    if (args[0] === 'rm') { resources.delete(args[1]); removed.push(args[1]) }
    if (args[0] === 'volume' && args[1] === 'rm') { expect(resources.size).toBe(0); volume = false; removed.push(args[2]) }
    return result(0)
  }
  await recoverCandidateResources(plan, run)
  expect(removed).toEqual(['synthetic-host', 'synthetic-build', 'synthetic-volume'])
})

it.each(['permission denied', 'Cannot connect to the Docker daemon', 'malformed daemon response'])(
  'does not certify resource absence on %s', async (error) => {
    await expect(recoverCandidateResources(plan, async () => result(1, '', error))).rejects.toThrow('could not inspect')
  })

it.each(['container', 'volume'])('preserves an unrelated %s with the same name', async (kind) => {
  const mutations: string[][] = []
  const run: DockerRun = async (args) => {
    if (args[1] === 'inspect') {
      if (args[0] === kind) return result(0, JSON.stringify([{ Id: args[2], Config: { Labels: {} }, Labels: {}, State: { Running: true, Pid: 10 } }]))
      return result(1, '', `No such container: ${args[2]}`)
    }
    mutations.push(args)
    return result(0)
  }
  await expect(recoverCandidateResources(plan, run)).rejects.toThrow(`unowned ${kind}`)
  expect(mutations).toEqual([])
})

it('refuses cleanup certification while a container still has live processes', async () => {
  const run: DockerRun = async (args) => args[1] === 'inspect'
    ? result(0, JSON.stringify([{ Id: 'synthetic-host', Config: { Labels: { [recoveryLabel]: plan.owner } },
      State: { Running: true, Pid: 123 } }])) : result(0)
  await expect(recoverCandidateResources(plan, run)).rejects.toThrow('did not stop')
})

it.each(['[]', '[{}]', 'null'])('does not certify malformed successful inspection %s', async (stdout) => {
  await expect(recoverCandidateResources(plan, async () => result(0, stdout))).rejects.toThrow('malformed')
})
