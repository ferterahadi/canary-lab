import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { RestartHealButton } from './RestartHealButton'

describe('RestartHealButton', () => {
  it('renders the Restart Heal button without stale guidance text', () => {
    const html = renderToStaticMarkup(<RestartHealButton runId="r1" />)
    expect(html).toContain('Restart Heal')
    expect(html).not.toContain('Type guidance for the agent in the pane after it spawns')
    // No stray input field — the REPL owns input once the new orchestrator
    // spawns, so the button is the only control here.
    expect(html).not.toContain('<input')
  })
})
