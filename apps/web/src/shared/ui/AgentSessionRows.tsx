import { Suspense, lazy, memo, type ReactNode } from 'react'
import type { AgentSessionEvent } from '@/shared/api/agent-sessions'
import { LOG_KIND_LABEL, type ExternalSessionActivity, type LogLine } from './activity-log'
import { clientLabel } from './external-client-branding'
import { useExternalClientAction } from './ExternalAgentCard'

// The markdown stack (react-markdown + remark-gfm → micromark) is the heaviest
// dependency in the bundle and only agent prose needs it — loaded lazily so a
// cold page paint never waits on it. The Suspense fallback renders the raw
// text, so a row is readable during the one-time chunk load.
const LazyReactMarkdown = lazy(async () => {
  const [{ default: ReactMarkdown }, { default: remarkGfm }] = await Promise.all([
    import('react-markdown'),
    import('remark-gfm'),
  ])
  // Module-scope plugin identity, not an inline `[remarkGfm]` literal:
  // react-markdown re-parses the whole remark→rehype pipeline whenever the
  // plugin array's IDENTITY changes, so a per-render literal defeated every
  // cache it has. With the timeline appending one event per WS frame over an
  // unwindowed list, that was O(rows × markdown parse) per incoming event.
  const plugins = [remarkGfm]
  return {
    default: function MarkdownText({ text }: { text: string }) {
      return <ReactMarkdown remarkPlugins={plugins}>{text}</ReactMarkdown>
    },
  }
})

function MarkdownBody({ text }: { text: string }) {
  return (
    <Suspense fallback={<pre className="agentts-mdfallback">{text}</pre>}>
      <LazyReactMarkdown text={text} />
    </Suspense>
  )
}

// ─── Timeline rows ───────────────────────────────────────────────────────────
// Every Activity entry — conductor line, agent event, task prompt, external
// session lifecycle — renders as ONE row shape: glyph · kind · verb · one-line
// summary · time. A row never expands in place. When its summary is cut it
// opens the entry in the log modal, so a long payload can't push the rest of
// the rail off screen; when the summary is already the whole entry
// (`line.whole`) the row is plain text that wraps, with nothing to open.

export interface LogGlyph {
  icon: ReactNode
  /** A token colour; the glyph is the row's only hue. */
  color: string
}

// memo: events are append-only — a new WS frame appends one entry and never
// mutates the earlier ones, so every existing row bails out on identity and an
// append re-renders one row instead of the whole transcript.
export const LogRow = memo(function LogRow({ activityId, line, glyph, timestamp, selected = false, onOpen, testId }: {
  activityId?: string
  line: LogLine
  glyph: LogGlyph
  timestamp?: string
  selected?: boolean
  onOpen: () => void
  testId?: string
}) {
  const kind = LOG_KIND_LABEL[line.kind]
  const cells = <>
    <span className="agentts-logicon" style={{ color: line.danger ? 'var(--danger)' : glyph.color }} aria-hidden="true">{glyph.icon}</span>
    <span className="agentts-logkind">{kind}</span>
    <span className="agentts-logverb">{line.verb}</span>
    <span className="agentts-logsum">{line.summary}</span>
    {timestamp !== undefined && <Timestamp value={timestamp} />}
  </>
  return (
    <li className="agentts-row" data-kind={line.kind} data-activity-id={activityId} data-testid={testId}>
      {line.whole ? (
        <div className="agentts-log" data-whole="true" data-danger={line.danger ? 'true' : 'false'}>{cells}</div>
      ) : (
        <button
          type="button"
          className="agentts-log"
          data-selected={selected ? 'true' : 'false'}
          data-danger={line.danger ? 'true' : 'false'}
          aria-haspopup="dialog"
          aria-current={selected ? 'true' : undefined}
          aria-label={`${kind} · ${line.verb}${line.summary ? ` — ${line.summary}` : ''}`}
          title={line.summary || undefined}
          onClick={onOpen}
        >
          {cells}
          <Chevron open={false} className="agentts-chev" />
        </button>
      )}
    </li>
  )
})

export function GlyphSvg({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  )
}

export const SYSTEM_GLYPH: LogGlyph = {
  icon: <GlyphSvg><path d="M3.5 4.5l3 3-3 3" /><path d="M8.5 11h4.5" /></GlyphSvg>,
  color: 'var(--text-muted)',
}

const SUBAGENT_ICON = <GlyphSvg><circle cx="4" cy="4" r="1.6" /><circle cx="12" cy="12" r="1.6" /><path d="M4 5.6V9a3 3 0 003 3h3.4" /></GlyphSvg>

/** The glyph types an agent event the way the old rail's node markers did, in
 *  the same hues: prompt in the boot hue, prose in the assistant hue, tool
 *  calls in the tool hue, results muted. */
export function eventGlyph(event: AgentSessionEvent, hasThreads = false): LogGlyph {
  switch (event.kind) {
    case 'user-message':
      return { icon: <GlyphSvg><path d="M6 4l4 4-4 4" /></GlyphSvg>, color: 'var(--boot)' }
    case 'assistant-message':
      return event.apiError
        ? { icon: <GlyphSvg><path d="M8 3.5v5" /><path d="M8 11.5v.5" /></GlyphSvg>, color: 'var(--danger)' }
        : { icon: <GlyphSvg><circle cx="8" cy="8" r="3.2" fill="currentColor" stroke="none" /></GlyphSvg>, color: 'var(--assistant)' }
    case 'assistant-thinking':
      return { icon: <GlyphSvg><circle cx="8" cy="8" r="3.6" strokeDasharray="2 1.6" /></GlyphSvg>, color: 'var(--text-muted)' }
    case 'tool-call':
      return hasThreads
        ? { icon: SUBAGENT_ICON, color: 'var(--accent)' }
        : { icon: <GlyphSvg>{toolGlyph(event.name)}</GlyphSvg>, color: 'var(--warning)' }
    case 'tool-result':
      return event.isError
        ? { icon: <GlyphSvg><path d="M5 5l6 6M11 5l-6 6" /></GlyphSvg>, color: 'var(--danger)' }
        : { icon: <GlyphSvg><path d="M3.5 8.5l3 3 6-6.5" /></GlyphSvg>, color: 'var(--text-muted)' }
  }
}

/** External lifecycle glyphs: a ring at start, the outcome at the end. */
export function externalGlyph(phase: 'start' | 'end', status: ExternalSessionActivity['status']): LogGlyph {
  const color = status === 'done' || status === 'ready' ? 'var(--success)'
    : status === 'failed' ? 'var(--danger)'
    : status === 'aborted' ? 'var(--text-muted)'
    : 'var(--running)'
  if (phase === 'start') return { icon: <GlyphSvg><circle cx="8" cy="8" r="3" /></GlyphSvg>, color: status === 'running' ? color : 'var(--text-muted)' }
  if (status === 'done' || status === 'ready') return { icon: <GlyphSvg><path d="M3.5 8.5l3 3 6-6.5" /></GlyphSvg>, color }
  if (status === 'failed') return { icon: <GlyphSvg><path d="M5 5l6 6M11 5l-6 6" /></GlyphSvg>, color }
  return { icon: <GlyphSvg><path d="M4.5 8h7" /></GlyphSvg>, color }
}

// Assistant/prompt prose is genuine markdown (headers, GFM tables, status
// bullets, inline code). Render it as such; tool payloads stay raw <pre>.
// react-markdown does not emit raw HTML by default, so untrusted-ish agent
// output can't inject markup.
// memo on `text`: prose rows are immutable once streamed, so a parent
// re-render must not re-run the markdown pipeline for every row again.
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="agentts-prose agentts-md">
      <MarkdownBody text={text} />
    </div>
  )
})

export function Chevron({ open, className }: { open: boolean; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      width="11"
      height="11"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .18s ease', flex: 'none' }}
    >
      <path d="M6 4l4 4-4 4" />
    </svg>
  )
}

export function toolGlyph(name: string): React.ReactNode {
  const n = (name || '').toLowerCase()
  if (/bash|shell|exec|run|command|terminal/.test(n)) return <><path d="M3 5l3 3-3 3" /><path d="M8.5 11H13" /></>
  if (/edit|write|update|create|patch|apply/.test(n)) return <path d="M3 11l7.5-7.5 2 2L5 13H3z" />
  if (/read|view|cat|open/.test(n)) return <path d="M4 2.5h5l3 3v8H4z" />
  if (/grep|glob|search|find|list|ls/.test(n)) return <><circle cx="6.6" cy="6.6" r="3.1" /><path d="M11 11l3 3" /></>
  if (/web|fetch|url|http|browse/.test(n)) return <><circle cx="8" cy="8" r="5" /><path d="M3 8h10M8 3c2.2 2.6 2.2 7.4 0 10" /></>
  return <circle cx="8" cy="8" r="2.4" fill="currentColor" stroke="none" />
}

export function Timestamp({ value }: { value: string }) {
  if (!value || Number.isNaN(Date.parse(value))) return <span className="agentts-time">Time unavailable</span>
  const d = new Date(value)
  const hh = d.getHours().toString().padStart(2, '0')
  const mm = d.getMinutes().toString().padStart(2, '0')
  const ss = d.getSeconds().toString().padStart(2, '0')
  const display = `${hh}:${mm}:${ss}`
  return (
    <span className="agentts-time" title={value}>{display}</span>
  )
}

/** "Open in Claude/Codex": the exact session when the client sent a link, else
 *  the client app. One home for the session divider and the log modal, which
 *  both have to send the reader to where the conversation actually lives. */
export function ExternalOpenAction({ session }: { session: ExternalSessionActivity }) {
  const { action, error } = useExternalClientAction({ clientKind: session.clientKind, sessionUrl: session.sessionUrl })
  const agent = clientLabel(session.clientKind, 'External agent')
  if (action?.kind === 'link') {
    return (
      <a href={action.href} target="_blank" rel="noreferrer" className="agentts-extaction" aria-label={`Open ${agent} session`}>
        Open in {agent} <span aria-hidden>→</span>
      </a>
    )
  }
  if (!action) return null
  return (
    <>
      <button
        type="button"
        className="agentts-extaction"
        title={`No exact session link was provided; opens the ${agent} app.`}
        disabled={action.busy}
        onClick={action.open}
      >
        {action.busy ? 'Opening…' : `Open ${agent} app`} {!action.busy && <span aria-hidden>→</span>}
      </button>
      {error && <span className="agentts-exterror" role="alert">{error}</span>}
    </>
  )
}
