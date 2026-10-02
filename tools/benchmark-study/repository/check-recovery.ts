import fs from 'node:fs'
import path from 'node:path'
import { json, readJson } from '../files'

export function reconcileRepositoryChecks(root: string, attemptId: string): void {
  const directory = path.join(root, 'receipts')
  if (!fs.existsSync(directory)) return
  for (const name of fs.readdirSync(directory)) {
    if (!name.startsWith(`${attemptId}-check-`) || !name.endsWith('.json')) continue
    const file = path.join(directory, name)
    const receipt = readJson<{ status: string }>(file)
    if (receipt.status === 'running') json(file, { ...receipt, status: 'interrupted', completedAt: new Date().toISOString(),
      reason: 'The owning scheduler exited; this check has no complete receipt' })
  }
}
