import { describe, expect, it } from 'vitest'
import { renderInteractiveGuide } from './smoke-demo-output.mjs'

const guide = renderInteractiveGuide({
  base: 'http://127.0.0.1:7421',
  agent: 'codex',
  featureName: 'storefront-journey',
  appDir: '/tmp/demo-project/demo-app',
  flightAppDir: '/tmp/demo-project/flight-app',
  projectDir: '/tmp/demo-project',
  intent: 'Test borrowing, returning, and refusing a loan when every copy is unavailable. Unknown resources are fixture support, not requirements.',
})

describe('demo terminal guide', () => {
  it('leads with the launch details and gives each journey one action', () => {
    expect(guide).toContain('✓ Demo ready\n  Dashboard  http://127.0.0.1:7421')
    expect(guide).toContain('1. Repair loop — heal a shipped Playwright suite')
    expect(guide).toContain('2. Full Flight — build a suite from product intent')
    expect(guide.match(/  Action/g)).toHaveLength(2)
  })

  it('keeps the tester in control and preserves the workspace', () => {
    expect(guide).toContain('Nothing has run yet. You control both journeys.')
    expect(guide).toContain('Press Ctrl-C to stop Canary Lab; the workspace is retained.')
    expect(guide).toContain('After stopping, run `npm run demo:clean` from the source checkout to remove retained demos.')
    expect(guide).toContain('  Workspace  /tmp/demo-project')
  })

  it('wraps the intent for terminal scanning', () => {
    const lines = guide.split('\n')
    const start = lines.indexOf('  Intent') + 1
    const end = lines.findIndex((line, index) => index >= start && !line.startsWith('    '))
    const intentLines = lines.slice(start, end)
    expect(intentLines.length).toBeGreaterThan(1)
    expect(intentLines.every((line) => line.length <= 88)).toBe(true)
  })

  it('tells a desktop-agent tester how to register this workspace', () => {
    expect(guide).toContain('3. Desktop agent (optional) — drive this demo over MCP')
    expect(guide).toContain('cd "/tmp/demo-project" && npx canary-lab setup --force --agent all')
  })
})
