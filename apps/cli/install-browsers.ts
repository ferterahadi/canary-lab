import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { section, warn, info, dim } from '../../shared/cli-ui/ui'
import { runAsScript } from './run-as-script'

// The one place that names which browsers a Canary Lab workspace needs. The
// scaffold's `postinstall` calls this so `npm install` leaves the workspace
// ready to run — there is no separate browser step for a user to forget.
const BROWSERS = ['chromium']

// Playwright's own CLI honours PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD only on the
// path npm-install takes into `@playwright/test`; an explicit `playwright
// install` always downloads. Since this command runs FROM a postinstall, it has
// to honour the variable itself — that is how the contributor smoke gates keep
// a throwaway workspace from writing into the developer's shared browser cache.
function skipRequested(env: NodeJS.ProcessEnv): boolean {
  const raw = env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD
  return raw !== undefined && raw !== '' && raw !== '0' && raw.toLowerCase() !== 'false'
}

// npm puts node_modules/.bin on PATH for lifecycle scripts and `npm run`, but a
// direct `./node_modules/.bin/canary-lab install-browsers` gets no such help.
function resolvePlaywrightBin(cwd: string): string {
  const binName = process.platform === 'win32' ? 'playwright.cmd' : 'playwright'
  const local = path.join(cwd, 'node_modules', '.bin', binName)
  return fs.existsSync(local) ? local : binName
}

export async function main(
  _argv: string[] = process.argv.slice(2),
  deps: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  const cwd = deps.cwd ?? process.cwd()
  const env = deps.env ?? process.env

  if (skipRequested(env)) {
    info('Skipping Playwright browser download (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD is set).')
    return
  }

  section('Installing Playwright browsers')
  try {
    execFileSync(resolvePlaywrightBin(cwd), ['install', ...BROWSERS], { cwd, stdio: 'inherit' })
  } catch (err) {
    // Never fail the caller. This runs inside `npm install`, and a flaky CDN or
    // a proxy must not leave the workspace half-installed with no package.json.
    warn(`Playwright browser install failed: ${(err as Error).message}`)
    warn(`Run it yourself once you have network: ${dim('npm run install:browsers')}`)
  }
}

runAsScript(module, main)
