import fs from 'node:fs'
import path from 'node:path'
import { command, inside, json } from './files'

// Claude background Bash jobs can leave its original process group. A port
// identifies a candidate only; its cwd must prove this attempt owns it.
export async function stopAttemptServices(root: string, ports: number[]): Promise<void> {
  const result = await command('/usr/sbin/lsof', ['-nP', ...ports.map((port) => `-iTCP:${port}`), '-sTCP:LISTEN', '-t'], { cwd: root })
  if (result.code !== 0 && result.code !== 1) throw new Error(`Could not inspect attempt services: ${result.stderr}`)
  const pids = [...new Set(result.stdout.trim().split('\n').filter((value) => /^\d+$/.test(value)).map(Number))]
  const evidence = []
  for (const pid of pids) {
    const cwd = await command('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { cwd: root })
    const directory = cwd.stdout.split('\n').find((line) => line.startsWith('n'))?.slice(1)
    const owned = directory && inside(fs.realpathSync(root), directory)
    evidence.push({ pid, cwd: directory ?? null, owned: Boolean(owned) })
    if (!owned) continue
    try { process.kill(pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
  }
  json(path.join(root, 'service-cleanup.json'), evidence)
  if (evidence.some((row) => !row.owned)) throw new Error('An allocated port is owned by another process; preserved it, inspect service-cleanup.json')
}
