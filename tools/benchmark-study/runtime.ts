import fs from 'node:fs'
import path from 'node:path'
import { inside, json, quote, sourceRoot, write } from './files'

export const services = ['catalog', 'inventory', 'checkout'] as const

export function runtimeEnvironment(root: string, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // An unreadable first PATH entry can stop shell lookup before it reaches Node.
  // npm run prepends the source checkout, which study agents cannot access.
  const entries = [path.dirname(process.execPath), ...(inherited.PATH ?? '').split(path.delimiter)]
    .filter((entry) => path.isAbsolute(entry) && !inside(sourceRoot, entry))
    .filter((entry) => { try { return !inside(sourceRoot, fs.realpathSync(entry)) } catch { return false } })
  const tmp = path.join(root, '.tmp')
  fs.mkdirSync(tmp, { recursive: true })
  return { PATH: [...new Set(entries)].join(path.delimiter), TMPDIR: tmp }
}

export function serviceInvocation(name: string): { command: string; args: string[] } {
  return { command: process.execPath, args: ['--import', 'tsx', `${name}-service/server.ts`] }
}
export function serviceCommand(name: string): string {
  const invocation = serviceInvocation(name)
  return [invocation.command, ...invocation.args].map(quote).join(' ')
}
export const playwrightCommand = (): string => `${quote(process.execPath)} node_modules/@playwright/test/cli.js test --config suite/playwright.config.ts`

export function writeRunbook(root: string, allocated: Record<string, number>, environment: NodeJS.ProcessEnv): { start: string; test: string } {
  json(path.join(root, 'runtime.json'), { allocated, environment: { ...runtimeEnvironment(root), ...environment } })
  const exports = Object.entries({ ...runtimeEnvironment(root), ...environment }).map(([key, value]) => `export ${key}=${quote(value!)}`).join('\n')
  write(path.join(root, 'environment.sh'), `${exports}\n`)
  const start = services.map((name) => `(cd app && PORT=${allocated[name]} ${serviceCommand(name)}) > ${name}.log 2>&1 &`).join('\n')
  const test = playwrightCommand()
  write(path.join(root, 'RUNBOOK.md'), `# Local storefront\n\nThe three services are initially stopped. Run from this directory. These commands use the installed TypeScript loader directly and avoid the tsx CLI's IPC socket.\n\n\`\`\`sh\nsource ./environment.sh\n${start}\n\`\`\`\n\nWait for HTTP 200 at each service's root URL: ${services.map((name) => `http://127.0.0.1:${allocated[name]}/`).join(', ')}. Raw output is in the corresponding service log. Stop/restart your own service processes after application edits.\n\nRun tests: \`${test}\`. Inspect Playwright traces under test-results. Requirements are in app/REQUIREMENTS.md. Application changes belong under app/. The suite and configuration are fixed.\n`)
  return { start, test }
}
