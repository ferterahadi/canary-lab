import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { BenchmarkArm, BenchmarkManifest, BenchmarkReport, SabotageLevel, SabotageSkillSummary } from '../api/benchmark-types'
import { cell } from './BenchmarkArmMatrix'
import { Centered } from './BenchmarkConfigScreen'
import { FAILED, HEALED } from './BenchmarkDetail'

export function ReportView({ m }: { m: BenchmarkManifest }) {
  const rep = m.report
  const iters = useMemo(() => {
    const map = new Map<number, { A?: typeof m.results[number]; B?: typeof m.results[number] }>()
    for (const r of m.results) {
      const e = map.get(r.iteration) ?? {}
      e[r.arm] = r
      map.set(r.iteration, e)
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0])
  }, [m.results])
  if (!rep) return <Centered>No report yet.</Centered>
  const verdict = benchmarkVerdict(rep)
  const toneColor = verdict.tone === 'win' ? HEALED : verdict.tone === 'loss' ? FAILED : 'var(--text-primary)'
  const heroBorder = verdict.tone === 'even'
    ? 'var(--border-default)'
    : `color-mix(in srgb, ${toneColor} 45%, var(--border-default))`
  const heroBg = verdict.tone === 'even'
    ? 'color-mix(in srgb, var(--text-muted) 5%, transparent)'
    : `color-mix(in srgb, ${toneColor} 8%, transparent)`
  const bothTokens = rep.harness.totalTokens != null && rep.baseline.totalTokens != null
  return (
    <div style={{ maxWidth: 880, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
        <button
          className="cl-button"
          style={{ padding: '6px 12px' }}
          onClick={() => downloadText(`${m.benchmarkId}.md`, benchmarkReportMarkdown(m, verdict.headline), 'text/markdown')}
        >
          ⬇ Export report
        </button>
      </div>
      <div style={{ border: `1px solid ${heroBorder}`, background: heroBg, borderRadius: 'var(--radius-xl)', padding: '20px 22px', marginBottom: 16 }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: toneColor, lineHeight: 1.05, letterSpacing: '-.01em' }}>{verdict.headline}</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 7, lineHeight: 1.5, maxWidth: 620 }}>{verdict.detail}</div>

        {/* Head-to-head bars: each metric on a shared scale so the gap that
            actually decides the winner is visible, not buried in fine print. */}
        <div style={{ marginTop: 18, display: 'grid', gridTemplateColumns: '96px 1fr 1fr', alignItems: 'center', gap: '0 16px' }}>
          <div />
          <ArmHeading emoji="🐤" label="Harness" color="var(--boot)" />
          <ArmHeading emoji="⚙" label="Baseline" color="var(--assistant)" />
        </div>
        <div style={{ marginTop: 2 }}>
          <CompareRow label="Healed" hValue={rep.harness.iterationsHealed} bValue={rep.baseline.iterationsHealed}
            hText={`${rep.harness.iterationsHealed}/${rep.harness.iterationsTotal}`} bText={`${rep.baseline.iterationsHealed}/${rep.baseline.iterationsTotal}`} betterIsLower={false} />
          <CompareRow label="Repair time" hValue={rep.harness.totalWallClockMs} bValue={rep.baseline.totalWallClockMs}
            hText={fmtSecs(rep.harness.totalWallClockMs)} bText={fmtSecs(rep.baseline.totalWallClockMs)} betterIsLower />
          <CompareRow label="Avg cycles" hValue={rep.harness.avgHealCycles} bValue={rep.baseline.avgHealCycles}
            hText={rep.harness.avgHealCycles.toFixed(1)} bText={rep.baseline.avgHealCycles.toFixed(1)} betterIsLower />
          {bothTokens && (
            <CompareRow label="Tokens" hValue={rep.harness.totalTokens!} bValue={rep.baseline.totalTokens!}
              hText={fmtTokens(rep.harness.totalTokens!)} bText={fmtTokens(rep.baseline.totalTokens!)} betterIsLower />
          )}
        </div>

        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border-default)' }}>
          sabotage <span style={{ fontFamily: 'var(--font-mono)' }}>{m.sabotageSha?.slice(0, 7)}</span> · model <span style={{ fontFamily: 'var(--font-mono)' }}>{m.agent} (pinned)</span> · tests read-only ✓
        </div>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, border: '1px solid var(--border-default)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
        <thead><tr>{['Iter', '🐤 harness', 'cycles', 'time', '⚙ baseline', 'cycles', 'time'].map((h, i) => (
          <th key={h} style={{ textAlign: i === 0 ? 'left' : 'right', padding: '9px 12px', background: 'var(--bg-elevated)', color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '.4px', fontWeight: 600, borderBottom: '1px solid var(--border-default)' }}>{h}</th>
        ))}</tr></thead>
        <tbody>
          {iters.map(([n, e]) => (
            <tr key={n}>
              <td style={cell()}>#{n}</td>
              <td style={cell(true, e.A?.healed ? 'var(--success)' : 'var(--danger)')}>{e.A ? (e.A.healed ? '✓ healed' : '✗ failed') : '—'}</td>
              <td style={cell(true)}>{e.A?.healCycles ?? '—'}</td>
              <td style={cell(true)}>{e.A ? `${Math.round(e.A.wallClockMs / 1000)}s` : '—'}</td>
              <td style={cell(true, e.B?.healed ? 'var(--success)' : 'var(--danger)')}>{e.B ? (e.B.healed ? '✓ healed' : '✗ failed') : '—'}</td>
              <td style={cell(true)}>{e.B?.healCycles ?? '—'}</td>
              <td style={cell(true)}>{e.B ? `${Math.round(e.B.wallClockMs / 1000)}s` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function ArmHeading({ emoji, label, color }: { emoji: string; label: string; color: string }) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontWeight: 600 }}>
      <span>{emoji}</span><span style={{ color }}>{label}</span>
    </div>
  )
}

// One metric, harness vs baseline, on a shared scale (so bar lengths are
// directly comparable across the row). The better value is flagged ✓ — for
// time/cycles/tokens lower wins, for healed higher wins.
export function CompareRow({ label, hValue, bValue, hText, bText, betterIsLower }: {
  label: string; hValue: number; bValue: number; hText: string; bText: string; betterIsLower: boolean
}) {
  const max = Math.max(hValue, bValue, 0.0001)
  const hPct = Math.max(4, (hValue / max) * 100)
  const bPct = Math.max(4, (bValue / max) * 100)
  const tie = hValue === bValue
  const hBetter = !tie && (betterIsLower ? hValue < bValue : hValue > bValue)
  const bBetter = !tie && !hBetter
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '96px 1fr 1fr', alignItems: 'center', gap: '0 16px', padding: '6px 0' }}>
      <div style={{ fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.4px', fontWeight: 600 }}>{label}</div>
      <Bar pct={hPct} color="var(--boot)" text={hText} better={hBetter} />
      <Bar pct={bPct} color="var(--assistant)" text={bText} better={bBetter} />
    </div>
  )
}

export function Bar({ pct, color, text, better }: { pct: number; color: string; text: string; better: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ flex: 1, minWidth: 0, height: 7, borderRadius: 9999, background: 'color-mix(in srgb, var(--text-muted) 16%, transparent)', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', borderRadius: 9999, background: color, transition: 'width 320ms cubic-bezier(.2,.7,.3,1)' }} />
      </div>
      <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', fontWeight: better ? 700 : 500, color: better ? 'var(--text-primary)' : 'var(--text-muted)', whiteSpace: 'nowrap', flex: 'none' }}>
        {text}{better && <span style={{ color: HEALED, marginLeft: 4 }}>✓</span>}
      </span>
    </div>
  )
}

// The honest verdict: lead with reliability when the arms differ on it, else
// fall back to the speed gap (the real story on a reliability tie). Tone drives
// the hero colour so a tie/loss isn't dressed up in win-green.
export function benchmarkVerdict(rep: BenchmarkReport): { headline: string; detail: string; tone: 'win' | 'even' | 'loss' } {
  const h = rep.harness
  const b = rep.baseline
  const speedMult = h.totalWallClockMs > 0 && b.totalWallClockMs > 0 ? b.totalWallClockMs / h.totalWallClockMs : null
  if (b.iterationsHealed === 0 && h.iterationsHealed > 0) {
    return { headline: 'Healed where the baseline couldn’t', detail: `Harness fixed ${h.iterationsHealed}/${h.iterationsTotal}; the baseline never reached green.`, tone: 'win' }
  }
  if (h.iterationsHealed > b.iterationsHealed && rep.reliabilityMultiple != null) {
    return { headline: `${rep.reliabilityMultiple.toFixed(1)}× more reliable repair`, detail: `Harness healed ${h.iterationsHealed}/${h.iterationsTotal} vs ${b.iterationsHealed}/${b.iterationsTotal} for the baseline.`, tone: 'win' }
  }
  if (h.iterationsHealed < b.iterationsHealed) {
    return { headline: 'Baseline healed more often', detail: `Harness ${h.iterationsHealed}/${h.iterationsTotal} vs baseline ${b.iterationsHealed}/${b.iterationsTotal} — context didn’t help here.`, tone: 'loss' }
  }
  // Reliability tied — speed is the story.
  if (speedMult != null && speedMult >= 1.15) {
    return { headline: `${speedMult.toFixed(1)}× faster repair`, detail: `Same reliability (${h.iterationsHealed}/${h.iterationsTotal} healed) — harness reached green in ${fmtSecs(h.totalWallClockMs)} vs ${fmtSecs(b.totalWallClockMs)}.`, tone: 'win' }
  }
  if (speedMult != null && speedMult <= 1 / 1.15) {
    return { headline: 'Matched on reliability', detail: `Both healed ${h.iterationsHealed}/${h.iterationsTotal}; the baseline was a touch faster (${fmtSecs(b.totalWallClockMs)} vs ${fmtSecs(h.totalWallClockMs)}).`, tone: 'even' }
  }
  return { headline: 'Matched the baseline', detail: `Both arms healed ${h.iterationsHealed}/${h.iterationsTotal} in comparable time.`, tone: 'even' }
}

export function fmtSecs(ms: number): string {
  return `${Math.round(ms / 1000)}s`
}

export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`
}

// ─── small helpers ───────────────────────────────────────────────────────────

/** Trigger a client-side file download (no server round-trip). */
export function downloadText(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/** Render the benchmark report as a shareable markdown artifact. */
export function benchmarkReportMarkdown(m: BenchmarkManifest, headline: string): string {
  const rep = m.report
  const secs = (ms: number) => `${Math.round(ms / 1000)}s`
  const lines: string[] = []
  lines.push(`# Canary Lab Benchmark — \`${m.feature}\` (${m.level} sabotage)`)
  lines.push('')
  if (rep) {
    lines.push(`**${headline}**`)
    lines.push('')
    lines.push('| Arm | Healed | Avg cycles | Total time |')
    lines.push('| --- | --- | --- | --- |')
    lines.push(`| 🐤 Harness | ${rep.harness.iterationsHealed}/${rep.harness.iterationsTotal} | ${rep.harness.avgHealCycles.toFixed(1)} | ${secs(rep.harness.totalWallClockMs)} |`)
    lines.push(`| ⚙ Baseline | ${rep.baseline.iterationsHealed}/${rep.baseline.iterationsTotal} | ${rep.baseline.avgHealCycles.toFixed(1)} | ${secs(rep.baseline.totalWallClockMs)} |`)
    lines.push('')
  }
  lines.push(`Sabotage \`${m.sabotageSha?.slice(0, 7) ?? '—'}\` · skill \`${m.skill}\` · model \`${m.agent}\` (pinned) · tests read-only ✓`)
  lines.push('')
  lines.push('## Per-iteration')
  lines.push('')
  lines.push('| Iter | Harness | cycles | time | Baseline | cycles | time |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- |')
  const byIter = new Map<number, { A?: typeof m.results[number]; B?: typeof m.results[number] }>()
  for (const r of m.results) {
    const e = byIter.get(r.iteration) ?? {}
    e[r.arm] = r
    byIter.set(r.iteration, e)
  }
  for (const [n, e] of [...byIter.entries()].sort((a, b) => a[0] - b[0])) {
    const cell = (r?: typeof m.results[number]) =>
      r ? `${r.healed ? '✓ healed' : '✗ failed'} | ${r.healCycles} | ${secs(r.wallClockMs)}` : '— | — | —'
    lines.push(`| #${n} | ${cell(e.A)} | ${cell(e.B)} |`)
  }
  lines.push('')
  lines.push(`_Generated by Canary Lab · benchmark \`${m.benchmarkId}\`_`)
  return lines.join('\n') + '\n'
}
