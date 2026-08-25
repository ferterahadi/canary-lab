function indentWrapped(text, indent, width = 88) {
  const available = Math.max(20, width - indent.length)
  const words = text.trim().split(/\s+/)
  const lines = []
  let current = ''

  for (const word of words) {
    if (!current || current.length + word.length + 1 <= available) {
      current = current ? `${current} ${word}` : word
      continue
    }
    lines.push(`${indent}${current}`)
    current = word
  }
  if (current) lines.push(`${indent}${current}`)
  return lines
}

export function renderInteractiveGuide({
  base,
  agent,
  featureName,
  appDir,
  flightAppDir,
  projectDir,
  intent,
}) {
  return [
    '',
    '✓ Demo ready',
    `  Dashboard  ${base}`,
    `  Agent      ${agent}`,
    `  Workspace  ${projectDir}`,
    '',
    '1. Repair loop — heal a shipped Playwright suite',
    `  Open       ${base}/?feature=${featureName}`,
    `  Repository ${appDir}`,
    '  Action     Start a run. Two journeys pass; five expose chained defects',
    '             across catalog, inventory, and checkout.',
    '',
    '2. Full Flight — build a suite from product intent',
    `  Open       ${base}/?dialog=flight-new`,
    `  Repository ${flightAppDir}`,
    '  Action     Paste the intent, pick the repository, select Plan flight.',
    '  Intent',
    ...indentWrapped(intent, '    '),
    '',
    '3. Desktop agent (optional) — drive this demo over MCP',
    '  Register   Run in another terminal, then restart the desktop app:',
    `             cd "${projectDir}" && npx canary-lab setup --force --agent all`,
    '  Confirm    A new session lists Canary_Lab in its MCP tools. Any cwd works.',
    '  Then       Open Getting Started and paste its "In your agent" command.',
    '  Note       Each demo makes a new workspace — re-register when it changes.',
    '',
    'Nothing has run yet. You control both journeys.',
    'Press Ctrl-C to stop Canary Lab; the workspace is retained.',
    'After stopping, run `npm run demo:clean` from the source checkout to remove retained demos.',
  ].join('\n')
}
