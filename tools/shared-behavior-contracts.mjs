// Targeted ownership contracts complement consumer parity tests; not a clone detector.
export const sharedBehaviors = [
  { file: 'apps/web/src/features/runs/state/RunsContext.tsx', owner: '@/shared/state/record-stream', symbols: ['useRecordStream'] },
  { file: 'apps/web/src/features/runs/components/DirtyReviewDialog.tsx', owner: '@shared/test-review', symbols: ['normalizeRunTestReview'] },
  { file: 'apps/web-server/src/mcp/tool-groups/test-review.ts', owner: '../../../../../shared/test-review', symbols: ['normalizeRunTestReview', 'testReviewUrl'] },
  { file: 'apps/web-server/src/features/runs/routes/runs-test-review.ts', owner: '../../../../../../shared/test-review', symbols: ['deriveRunReviewCapabilities'] },
  { file: 'apps/web-server/src/features/flights/routes/flight-decision-origin.ts', owner: '../../../../../../shared/flights/ownership', symbols: ['isExternallyDriven'] },
  ...['RequirementsFork', 'FlightDetail', 'StageDetail', 'CheckpointControls', 'FlightChipState'].map((name) => ({ file: `apps/web/src/features/flights/components/${name}.tsx`, owner: '@shared/flights/ownership', symbols: ['isExternallyDriven'] })),
  { file: 'apps/web/src/features/runs/utils/run-detail-playback.ts', owner: '@shared/playback-identity', symbols: ['buildPlaybackIdentity', 'latestPlaybackAttempt'] },
  { file: 'apps/web-server/src/features/runs/logic/run-detail.ts', owner: '../../../../../../shared/playback-identity', symbols: ['buildPlaybackIdentity', 'reconcilePlaybackCases'] },
  { file: 'apps/web-server/src/features/evaluation/logic/test-review/packet.ts', owner: '../../../../../../../shared/playback-identity', symbols: ['reconcilePlaybackCases', 'latestPlaybackAttempt'] },
]

export function checkSharedBehaviors(read, rules = sharedBehaviors) {
  const problems = []
  for (const { file, owner, symbols } of rules) {
    const text = read(file)
    const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
    for (const symbol of symbols) {
      const imports = [...code.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)]
      if (!imports.some((match) => match[2] === owner && match[1].split(',').some((item) => item.trim() === symbol))
        || !new RegExp(`\\b${symbol}\\s*\\(`).test(code)) problems.push(`${file}: import and call ${symbol} from ${owner}`)
    }
    if (/\b(?:interface|type)\s+TestReview\b/.test(code)) problems.push(`${file}: use the shared RunTestReview contract`)
  }
  return problems
}
