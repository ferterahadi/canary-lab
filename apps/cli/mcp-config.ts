import fs from 'fs'
import { atomicWrite } from '../../shared/lib/atomic-write'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function readMcpConfig(file: string): Record<string, unknown> {
  let source: string
  try {
    source = fs.readFileSync(file, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error(`Cannot read MCP configuration ${file}: ${(error as Error).message}`)
  }
  let config: unknown
  try {
    config = JSON.parse(source)
  } catch {
    throw new Error(`Invalid JSON in ${file}; configuration was left unchanged.`)
  }
  if (!isRecord(config) || (config.mcpServers !== undefined && !isRecord(config.mcpServers))) {
    throw new Error(`Invalid MCP configuration in ${file}; expected an object and an object-valued mcpServers. Configuration was left unchanged.`)
  }
  return config
}

export function writeMcpConfig(file: string, config: Record<string, unknown>): void {
  // Keep the pre-setup file outside the application's discovery path. Repeated
  // repairs must not replace the original recovery copy with an already-edited one.
  if (fs.existsSync(file)) {
    fs.accessSync(file, fs.constants.W_OK)
    try {
      fs.copyFileSync(file, `${file}.canary-lab-backup`, fs.constants.COPYFILE_EXCL)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600
  atomicWrite(file, `${JSON.stringify(config, null, 2)}\n`, mode)
  fs.chmodSync(file, mode)
}
