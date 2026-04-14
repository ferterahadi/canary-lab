import http from 'http'
import https from 'https'
import os from 'os'
import type { StartCommand } from './types'

export interface StartTab {
  dir: string
  command: string
  name: string
}

export function resolvePath(p: string): string {
  return p.startsWith('~/') ? p.replace('~', os.homedir()) : p
}

export function normalizeStartCommand(
  command: string | StartCommand,
  fallbackName: string,
): StartCommand {
  if (typeof command === 'string') {
    return {
      command,
      name: fallbackName,
    }
  }

  return {
    ...command,
    name: command.name ?? fallbackName,
  }
}

export async function isHealthy(url: string, timeoutMs = 1500): Promise<boolean> {
  const client = url.startsWith('https://') ? https : http

  return await new Promise((resolve) => {
    const req = client.get(
      url,
      { timeout: timeoutMs },
      (res) => {
        res.resume()
        resolve((res.statusCode ?? 0) < 500)
      },
    )

    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })

    req.on('error', () => resolve(false))
  })
}

