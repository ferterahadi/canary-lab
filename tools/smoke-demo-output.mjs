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
    '1. Repair loop — diagnose a shipped Playwright suite',
    `  Open       ${base}/?feature=${featureName}`,
    `  Repository ${appDir}`,
    '  Action     Start a run. Two journeys pass immediately; five expose',
    '             chained defects across catalog, inventory, and checkout.',
    '             Each repair reveals the next broken contract.',
    '',
    '2. Full Flight — create and run a suite from product intent',
    `  Open       ${base}/?dialog=flight-new`,
    `  Repository ${flightAppDir}`,
    '  Action     Paste the intent, choose the repository, then select Plan flight.',
    '             Canary scans, writes tests, prepares concurrency, runs, heals,',
    '             and exports the evaluation.',
    '  Intent',
    ...indentWrapped(intent, '    '),
    '',
    'Nothing has run yet. You control both journeys.',
    'Press Ctrl-C to stop Canary Lab; the workspace is retained.',
  ].join('\n')
}
