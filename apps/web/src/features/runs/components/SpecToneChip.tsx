import { Chip } from '@/shared/ui/StatusChip'
import { SPEC_TONE, type SpecEditTone } from '../utils/spec-integrity'

export function SpecToneChip({ tone }: { tone: SpecEditTone }) {
  const style = SPEC_TONE[tone]
  return <Chip chrome="border" tone={style.color} icon={<span aria-hidden="true">{style.glyph}</span>} label={tone === 'weaker' ? `${style.label} · hint` : style.label} title={style.title} testId={`dirty-review-tone-${tone}`} />
}

