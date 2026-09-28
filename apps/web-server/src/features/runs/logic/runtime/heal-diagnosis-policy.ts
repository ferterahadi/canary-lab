import { diagnosisPolicy, type DiagnosisPolicy } from '../../../../../../../shared/diagnosis-policy'
import { renderPrompt } from '../../../../shared/prompts'

export function renderDiagnosisPolicy(policy: DiagnosisPolicy = 'per-failure'): string {
  return renderPrompt(`heal-diagnosis-${diagnosisPolicy(policy)}.md`, {}).trim()
}
