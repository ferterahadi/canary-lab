import { DEFAULT_DIAGNOSIS_POLICY, diagnosisPolicy, type DiagnosisPolicy } from '../../../../../../../shared/diagnosis-policy'
import { renderPrompt } from '../../../../shared/prompts'

export function renderDiagnosisPolicy(policy: DiagnosisPolicy = DEFAULT_DIAGNOSIS_POLICY): string {
  return renderPrompt(`heal-diagnosis-${diagnosisPolicy(policy)}.md`, {}).trim()
}
