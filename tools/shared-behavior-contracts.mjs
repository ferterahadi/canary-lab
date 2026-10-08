// Targeted ownership contracts complement consumer parity tests; not a clone detector.
export const sharedBehaviors = [
  { file: 'apps/web/src/features/runs/components/RunsColumn.tsx', owner: '@/shared/ui/Overlays', symbols: ['ConfirmModal'], usage: 'jsx' },
  ...['features/runs/components/ReviewEvaluationMenu.tsx', 'features/runs/components/use-runs-column.ts',
    'features/config/components/TokenPicker.tsx', 'features/cleanup/components/CleanupTableParts.tsx',
    'features/flights/components/FlightControls.tsx', 'features/flights/components/ModelPlanPopover.tsx'].map((file) => ({
    file: `apps/web/src/${file}`, owner: '@/shared/ui/Overlays', symbols: ['usePopoverDismiss'],
  })),
  { file: 'tools/benchmark-study/files.ts', owner: '../../shared/lib/atomic-write', symbols: ['atomicWriteJson'] },
  { file: 'apps/web-server/src/features/runs/routes/runs-read.ts', owner: '../../../../../../shared/run-capture-state', symbols: ['deriveRunCaptureState'] },
  { file: 'apps/web/src/features/runs/components/ChangesTab.tsx', owner: '@shared/run-capture-state', symbols: ['deriveRunCaptureState'] },
  { file: 'apps/web-server/src/shared/repo-identity.ts', owner: './home-path', symbols: ['expandHomePath'] },
  { file: 'apps/web-server/src/shared/launcher-startup.ts', owner: './home-path', symbols: ['expandHomePath'] },
  { file: 'apps/web-server/src/features/config/routes/workspace-fs-routes.ts', owner: '../../../shared/home-path', symbols: ['expandHomePath'] },
  { file: 'apps/web-server/src/features/config/routes/envset-routes.ts', owner: '../../../shared/home-path', symbols: ['expandHomePath'] },
  { file: 'apps/web-server/src/features/config/logic/feature-docs-authoring.ts', owner: '../../../shared/home-path', symbols: ['expandHomePath'] },
  { file: 'apps/web-server/src/features/runs/logic/runtime/launcher/project-config.ts', owner: '../../../../../shared/home-path', symbols: ['expandHomePath'] },
  { file: 'apps/cli/e2e-flight-drive.ts', owner: '../../shared/flights/types', symbols: ['isActiveFlightStatus'] },
  { file: 'apps/web/src/features/flights/lib/workspace-flights.ts', owner: '@shared/flights/types', symbols: ['isActiveFlightStatus'] },
  { file: 'apps/web/src/features/flights/components/FlightControls.tsx', owner: '@shared/flights/types', symbols: ['isActiveFlightStatus'] },
  { file: 'apps/web/src/features/flights/components/FlightChipState.tsx', owner: '@shared/flights/types', symbols: ['isActiveFlightStatus'] },
  { file: 'apps/web/src/features/flights/components/FlightDetail.tsx', owner: '@shared/flights/types', symbols: ['isActiveFlightStatus'] },
  { file: 'apps/web-server/src/mcp/tool-groups/flight.ts', owner: '../../../../../shared/flights/types', symbols: ['isActiveFlightStatus'] },
  { file: 'apps/web-server/src/features/flights/routes/flights-plan.ts', owner: '../../../../../../shared/flights/types', symbols: ['isActiveFlightStatus'] },
  { file: 'apps/web-server/src/features/flights/ws/flights-stream.ts', owner: '../../../../../../shared/flights/types', symbols: ['isActiveFlightStatus'] },
  { file: 'apps/web-server/src/features/runs/logic/runtime/run-spawn.ts', owner: '../../../../shared/process-tree', symbols: ['signalProcessTree'] },
  { file: 'apps/web-server/src/features/runs/logic/runtime/run-heal-controls.ts', owner: './run-spawn', symbols: ['killTree'] },
  { file: 'apps/web-server/src/features/runs/logic/runtime/orchestrator.ts', owner: './run-spawn', symbols: ['killTree'] },
  { file: 'apps/web-server/src/features/portify/logic/runtime/agent.ts', owner: '../../../agent-sessions/logic/agent-process', symbols: ['runAgentProcess'] },
  { file: 'apps/web-server/src/features/benchmark/logic/runtime/runner.ts', owner: '../../../agent-sessions/logic/agent-process', symbols: ['runAgentProcess'] },
  ...['RepoScanPanel', 'StageFacts'].map((name) => ({ file: `apps/web/src/features/flights/components/${name}.tsx`, owner: '@shared/lib/repository-paths', symbols: ['distinctRepoPaths'] })),
  { file: 'apps/web-server/src/shared/repo-identity.ts', owner: '../../../../shared/lib/repository-paths', symbols: ['distinctRepoPaths'] },
  ...['routes/flights-read.ts', 'logic/workspace-evidence.ts'].map((file) => ({ file: `apps/web-server/src/features/flights/${file}`, owner: '../../../shared/repo-identity', symbols: ['configuredRepoPaths'] })),
  { file: 'apps/web/src/features/flights/components/FailingTests.tsx', owner: '@shared/test-annotations', symbols: ['tokenizeTestAnnotations'] },
  { file: 'apps/web-server/src/features/evaluation/logic/test-review/text.ts', owner: '../../../../../../../shared/test-annotations', symbols: ['tokenizeTestAnnotations'] },
  ...['features/flights/components/FailingTests.tsx', 'features/runs/utils/test-step-status.ts'].map((file) => ({ file: `apps/web/src/${file}`, owner: '@shared/summary-test-identity', symbols: ['findSummaryTest'] })),
  { file: 'apps/web/src/features/runs/components/RunPlaybackPanels.tsx', owner: '../utils/run-detail-playback', symbols: ['playbackFocusCase'] },
  { file: 'apps/web/src/features/runs/utils/run-view-model.ts', owner: '@shared/run-state', symbols: ['deriveRunActionAvailability'] },
  { file: 'apps/web-server/src/features/runs/logic/run-actions.ts', owner: '../../../../../../shared/run-state', symbols: ['deriveRunActionAvailability'] },
  { file: 'apps/web-server/src/features/runs/routes/external-heal.ts', owner: '../logic/run-actions', symbols: ['buildRunActionsResponse'] },
  { file: 'apps/web-server/src/mcp/tool-groups/reads.ts', owner: '../../features/runs/logic/run-actions', symbols: ['buildRunActionsResponse'] },
  { file: 'apps/web/src/features/runs/utils/test-step-status.ts', owner: '@shared/lib/source-location', symbols: ['parseSourceLocation'] },
  { file: 'apps/web-server/src/features/runs/logic/runtime/launcher/project-config.ts', owner: '../../../../../../../../shared/lib/atomic-write', symbols: ['atomicWriteJson'] },
  { file: 'apps/web-server/src/features/config/logic/envset-config.ts', owner: '../../../../../../shared/lib/atomic-write', symbols: ['atomicWriteJson'] },
  { file: 'apps/web-server/src/features/coverage/logic/coverage/prd-summary-render.ts', owner: '../../../../../../../shared/lib/atomic-write', symbols: ['atomicWriteJson'] },
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
  for (const { file, owner, symbols, usage } of rules) {
    const text = read(file)
    const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
    for (const symbol of symbols) {
      const imports = [...code.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)]
      if (!imports.some((match) => match[2] === owner && match[1].split(',').some((item) => item.trim() === symbol))
        || !(usage === 'jsx' ? new RegExp(`<${symbol}(?:\\s|/|>)`) : new RegExp(`\\b${symbol}\\s*\\(`)).test(code)) problems.push(`${file}: import and call ${symbol} from ${owner}`)
    }
    if (/\b(?:interface|type)\s+TestReview\b/.test(code)) problems.push(`${file}: use the shared RunTestReview contract`)
  }
  return problems
}

export const forbiddenSharedCopies = [
  { file: 'apps/web/src/features/runs/components/RunActionsKebab.tsx', pattern: /function\s+ConfirmDialog\b/,
    invalid: 'function ConfirmDialog() {}', valid: 'function RunActionsKebab() {}', message: 'use the shared confirmation component' },
  { file: 'apps/web-server/src/features/runs/routes/runs-read.ts', pattern: /function\s+captureIsFinal\b/,
    invalid: 'function captureIsFinal() {}', valid: 'deriveRunCaptureState(manifest)', message: 'use shared capture finality' },
  { file: 'apps/web/src/features/runs/components/RepairedRepoCard.tsx', pattern: /runStopped\s*&&\s*!provisional/,
    invalid: 'runStopped && !provisional', valid: 'canUseFinalCapture', message: 'consume shared capture finality from ChangesTab' },
  { file: 'tools/benchmark-study/files.ts', pattern: /fs\.renameSync\s*\(/,
    invalid: 'fs.renameSync(temporary, target)', valid: 'atomicWriteJson(file, value)', message: 'delegate JSON replacement to atomicWriteJson' },
  ...['features/portify/logic/runtime/prepare-workflow.ts', 'features/benchmark/logic/runtime/runner.ts',
    'features/runs/logic/runtime/run-heal-controls.ts', 'features/runs/logic/runtime/orchestrator.ts',
    'features/runs/logic/runtime/run-spawn.ts'].map((file) => ({
    file: `apps/web-server/src/${file}`, pattern: /\.kill\s*\(/,
    invalid: "child.kill('SIGTERM')", valid: "handle.stop('SIGTERM')",
    message: 'use the owned agent handle or shared process-tree adapter',
  })),
  ...['apps/cli/e2e-flight-drive.ts', 'apps/web/src/features/flights/lib/workspace-flights.ts',
    'apps/web/src/features/flights/components/FlightControls.tsx', 'apps/web/src/features/flights/components/FlightChipState.tsx',
    'apps/web/src/features/flights/components/FlightDetail.tsx', 'apps/web-server/src/mcp/tool-groups/flight.ts',
    'apps/web-server/src/features/flights/routes/flights-plan.ts', 'apps/web-server/src/features/flights/ws/flights-stream.ts'].map((file) => ({
    file, pattern: /\b(flight|entry|latest|f|a|b)\.status\s*===\s*['"]running['"]\s*\|\|\s*\1\.status\s*===\s*['"]waiting-for-approval['"]|(?<![\w.])status\s*===\s*['"]running['"]\s*\|\|\s*status\s*===\s*['"]waiting-for-approval['"]/,
    invalid: "flight.status === 'running' || flight.status === 'waiting-for-approval'",
    valid: "stage.status === 'running' || stage.status === 'waiting-for-approval'",
    message: 'use isActiveFlightStatus for flight-level activity',
  })),
]

export function checkForbiddenSharedCopies(read, rules = forbiddenSharedCopies) {
  return rules.filter(({ file, pattern }) => pattern.test(read(file).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')))
    .map(({ file, message }) => `${file}: ${message}`)
}
