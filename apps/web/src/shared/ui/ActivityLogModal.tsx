import { useState, type ReactNode } from 'react'
import type { AgentSessionEvent, SubagentThread } from '@/shared/api/agent-sessions'
import {
  LOG_KIND_LABEL,
  describeEvent,
  externalLifecycle,
  formatJson,
  isoSpan,
  languageFor,
  numberedLines,
  shortSession,
  systemVerb,
  toolFilePath,
  type ExternalSessionActivity,
  type LogLine,
  type SystemLine,
} from './activity-log'
import { ExternalOpenAction, LogRow, Markdown, eventGlyph } from './AgentSessionRows'
import type { CodeLanguage } from './code-highlighter'
import { clientLabel } from './external-client-branding'
import { Modal } from './Overlays'
import { useCodeHighlight } from './use-code-highlight'

// The full content of one Activity row. The rail shows each entry as a single
// line; this is where everything the line left out lives — the whole payload,
// coloured by what it is, with the facts that place it (session, tool, file).

/** The session an agent event belongs to, as its divider names it. */
export interface LogSessionFacts {
  label?: string
  agent: string | null
  model?: string
  sessionId: string
}

export type LogEntry =
  | {
    kind: 'event'
    id: string
    event: AgentSessionEvent
    session: LogSessionFacts
    /** Subagents spawned by this tool call. */
    threads?: SubagentThread[]
    /** The call's result, or the result's call — the other half of a tool use. */
    pair?: { id: string; event: AgentSessionEvent }
  }
  | { kind: 'external'; id: string; session: ExternalSessionActivity; phase: 'start' | 'end' }
  | { kind: 'system'; id: string; line: SystemLine }

export function ActivityLogModal({ entry, onClose, onOpenEntry }: {
  entry: LogEntry
  onClose: () => void
  /** Jump to another entry (a tool call's result, or a result's call). */
  onOpenEntry: (id: string) => void
}) {
  // Keyed by entry so a jump to the pair starts on its own thread state.
  return <LogModalContent key={entry.id} entry={entry} onClose={onClose} onOpenEntry={onOpenEntry} />
}

interface NestedPick { thread: SubagentThread; index: number }

function LogModalContent({ entry, onClose, onOpenEntry }: {
  entry: LogEntry
  onClose: () => void
  onOpenEntry: (id: string) => void
}) {
  // A subagent's own event opens INSIDE this modal with a way back — a second
  // modal stacked over the first would hide the thread it came from.
  const [nested, setNested] = useState<NestedPick | null>(null)
  const view = nested
    ? nestedView(nested, entry)
    : entryView(entry, onOpenEntry, (thread, index) => setNested({ thread, index }))
  return (
    <Modal
      open
      onClose={onClose}
      eyebrow={LOG_KIND_LABEL[view.line.kind]}
      title={view.line.verb}
      description={view.context}
      width={860}
      viewportInset={6}
      testId="activity-log-modal"
      headerActions={<>
        {nested && (
          <button type="button" className="cl-button min-h-7 shrink-0 px-2 py-0.5" onClick={() => setNested(null)} data-testid="activity-log-back">
            <span aria-hidden>←</span> {nested.thread.agentType}
          </button>
        )}
        <CopyButton text={view.copyText} />
      </>}
      subheader={view.meta.length > 0 ? <MetaBand facts={view.meta} /> : undefined}
    >
      <div className="agentts-modalbody">{view.body}</div>
    </Modal>
  )
}

interface EntryView {
  line: LogLine
  context: string
  meta: Array<{ label: string; value: ReactNode }>
  body: ReactNode
  copyText: string
}

function timeOf(iso: string | undefined): string {
  const time = Date.parse(iso ?? '')
  if (!Number.isFinite(time)) return 'Time unavailable'
  return new Date(time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function sessionName(session: LogSessionFacts): string {
  return session.label ?? (session.agent ? `${session.agent} session` : 'Agent session')
}

function entryView(entry: LogEntry, onOpenEntry: (id: string) => void, onPickNested: (thread: SubagentThread, index: number) => void): EntryView {
  if (entry.kind === 'external') {
    const { session, phase } = entry
    const client = clientLabel(session.clientKind, 'External agent')
    const lifecycle = externalLifecycle(session.status, phase)
    const duration = isoSpan(session.startedAt, session.endedAt)
    const message = phase === 'start' && session.status !== 'running' ? `${session.actionLabel ?? 'External agent session'} started.` : session.message
    return {
      line: { kind: 'system', verb: lifecycle, summary: message },
      context: `${session.actionLabel ?? 'External agent session'} · ${timeOf(phase === 'start' ? session.startedAt : session.endedAt)}`,
      meta: [
        { label: 'client', value: client },
        ...(session.sessionId ? [{ label: 'session', value: <span title={session.sessionId}>{shortSession(session.sessionId)}</span> }] : []),
        ...(session.startedAt ? [{ label: 'started', value: timeOf(session.startedAt) }] : []),
        ...(session.endedAt ? [{ label: 'ended', value: timeOf(session.endedAt) }] : []),
        ...(duration ? [{ label: 'took', value: duration }] : []),
      ],
      body: (
        <div className="agentts-extdetail">
          <p className="agentts-prose">{message}</p>
          <p className="agentts-extnote">
            The conversation itself lives in {client}. Canary Lab records only when this work started and ended.
          </p>
          <ExternalOpenAction session={session} />
        </div>
      ),
      copyText: message,
    }
  }
  if (entry.kind === 'system') {
    // Only a line too long for its row opens — usually raw output a producer
    // forwarded. Pretty-print it when it is JSON, so it reads as a record.
    const { tag, timestamp, text } = entry.line
    const lang = languageFor(undefined, text)
    const source = lang === 'json' ? formatJson(JSON.parse(text)) : text
    return {
      line: { kind: 'system', verb: systemVerb(tag), summary: text },
      context: `Canary Lab · ${timeOf(timestamp)}`,
      meta: tag ? [{ label: 'source', value: tag }] : [],
      body: <CodeView source={source} lang={lang} />,
      copyText: text,
    }
  }
  const { event, session, pair, threads } = entry
  const line = describeEvent(event, threads)
  const context = `${sessionName(session)} · ${timeOf(event.timestamp)}`
  const sessionFact = { label: 'session', value: <span title={session.sessionId}>{[session.model ?? session.agent, shortSession(session.sessionId)].filter(Boolean).join(' · ')}</span> }
  // The other half of a tool use links to its own modal — unless it is a
  // one-liner with no modal, in which case its whole line is the fact.
  const pairLine = pair ? describeEvent(pair.event) : null
  const pairLink = (label: string) => !pair || !pairLine ? [] : pairLine.whole
    ? [{ label, value: <span className="agentts-pairtext" title={pairLine.summary} data-testid="activity-log-pair">{pairLine.verb} · {pairLine.summary}</span> }]
    : [{ label, value: <button type="button" className="agentts-pairlink" onClick={() => onOpenEntry(pair.id)} data-testid="activity-log-pair">{pairLine.verb} {label === 'result' ? '↓' : '↑'}</button> }]
  switch (event.kind) {
    case 'user-message':
      // The task prompt is a source text handed to the agent, so it reads as
      // the source it is — numbered, coloured as markdown — not as rendered
      // prose, which hides the structure the agent actually received.
      return { line, context, meta: [sessionFact], body: <CodeView source={event.text} lang="markdown" />, copyText: event.text }
    case 'assistant-message':
      return {
        line, context, meta: [sessionFact],
        body: event.apiError ? <PlainBlock text={event.text} /> : <Markdown text={event.text} />,
        copyText: event.text,
      }
    case 'assistant-thinking':
      return { line, context, meta: [sessionFact], body: <div className="agentts-thinkbody"><Markdown text={event.text} /></div>, copyText: event.text }
    case 'tool-call': {
      const input = formatJson(event.input)
      return {
        line, context,
        meta: [{ label: 'tool', value: event.name || 'tool' }, ...pairLink('result'), sessionFact],
        body: <>
          {threads?.map((thread) => <SubagentBands key={thread.agentId} thread={thread} input={event.input} onPick={(index) => onPickNested(thread, index)} />)}
          <Band title={threads?.length ? 'Tool input' : undefined}>
            <CodeView source={input} lang={typeof event.input === 'string' ? null : 'json'} />
          </Band>
        </>,
        copyText: input,
      }
    }
    case 'tool-result': {
      const call = pair?.event.kind === 'tool-call' ? pair.event : undefined
      const path = call ? toolFilePath(call.input) : undefined
      const numbered = numberedLines(event.output)
      const text = numbered ? numbered.lines.join('\n') : event.output
      const lang = languageFor(path, text)
      return {
        line, context,
        meta: [
          ...pairLink('of'),
          ...(path ? [{ label: 'file', value: path }] : []),
          ...(numbered ? [{ label: 'lines', value: `${numbered.numbers[0]}–${numbered.numbers.at(-1)}` }] : []),
          sessionFact,
        ],
        body: <>
          <CodeView source={text || '(empty)'} lang={text ? lang : null} numbers={numbered?.numbers} />
          {numbered?.tail && <Band title="After the file"><PlainBlock text={numbered.tail} /></Band>}
        </>,
        copyText: event.output,
      }
    }
  }
}

function nestedView({ thread, index }: NestedPick, parent: LogEntry): EntryView {
  const event = thread.events[index]
  const session: LogSessionFacts = parent.kind === 'event'
    ? { ...parent.session, label: `${thread.agentType} subagent` }
    : { agent: null, sessionId: '' }
  const toolId = event.kind === 'tool-call' || event.kind === 'tool-result' ? event.toolId : undefined
  const pairIndex = toolId === undefined ? -1 : thread.events.findIndex((other, at) => at !== index && other
    && (other.kind === 'tool-call' || other.kind === 'tool-result') && other.toolId === toolId)
  // Nested pairs are not rail rows, so their link is informational only — the
  // whole thread is one step back.
  const view = entryView({
    kind: 'event', id: `nested:${index}`, event, session,
    ...(pairIndex >= 0 ? { pair: { id: `nested:${pairIndex}`, event: thread.events[pairIndex] } } : {}),
  }, () => undefined, () => undefined)
  return { ...view, meta: view.meta.filter((fact) => fact.label !== 'result' && fact.label !== 'of') }
}

function SubagentBands({ thread, input, onPick }: { thread: SubagentThread; input: unknown; onPick: (index: number) => void }) {
  const prompt = input && typeof input === 'object' && typeof (input as Record<string, unknown>).prompt === 'string'
    ? (input as Record<string, string>).prompt
    : thread.description
  const events = thread.events.map((event, index) => ({ event, index })).filter(({ event }) => Boolean(event))
  return <>
    <Band title={`Task given · ${thread.agentType}`}>
      <Markdown text={prompt} />
    </Band>
    <Band title={`Thread · ${events.length} event${events.length === 1 ? '' : 's'}`}>
      <ol className="agentts-rail agentts-nestrail" data-testid="activity-log-thread">
        {events.map(({ event, index }) => (
          <LogRow key={index} line={describeEvent(event)} glyph={eventGlyph(event)} timestamp={event.timestamp} onOpen={() => onPick(index)} />
        ))}
      </ol>
    </Band>
  </>
}

function Band({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="agentts-band">
      {title && <h3 className="agentts-bandtitle">{title}</h3>}
      {children}
    </section>
  )
}

function MetaBand({ facts }: { facts: EntryView['meta'] }) {
  return (
    <dl className="agentts-modalmeta" data-testid="activity-log-meta">
      {facts.map((fact) => (
        <div key={fact.label} className="agentts-metafact">
          <dt>{fact.label}</dt>
          <dd>{fact.value}</dd>
        </div>
      ))}
    </dl>
  )
}

function PlainBlock({ text }: { text: string }) {
  return <pre className="agentts-plain">{text}</pre>
}

/** A payload with a line-number gutter. Numbers are the file's own when the
 *  tool reported them (a Read of lines 40–80 starts at 40), else 1..n. Lines
 *  wrap, and a wrapped line hangs under its text rather than its number. */
export function CodeView({ source, lang, numbers }: { source: string; lang: CodeLanguage | null; numbers?: number[] }) {
  const highlighted = useCodeHighlight(lang ? source : '', lang ?? 'typescript')
  const plain = source.split('\n')
  // Shiki emits one `.line` per source line; on any disagreement show plain text
  // rather than shift colours onto the wrong lines.
  const html = lang && highlighted && highlighted.lines.length === plain.length ? highlighted.lines : null
  return (
    <div className="agentts-code" data-lang={lang ?? 'text'} data-testid="activity-log-code">
      {plain.map((text, at) => (
        <div key={at} className="agentts-codeline">
          <span className="agentts-ln" aria-hidden="true">{numbers?.[at] ?? at + 1}</span>
          {html
            // Shiki escaped the source it highlighted; this is its markup verbatim.
            // eslint-disable-next-line no-restricted-syntax
            ? <span className="agentts-lc" dangerouslySetInnerHTML={{ __html: html[at] || ' ' }} />
            : <span className="agentts-lc">{text || ' '}</span>}
        </div>
      ))}
    </div>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const onCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // The content stays visible and selectable when clipboard access is denied.
    }
  }
  return (
    <button type="button" className="cl-button min-h-7 shrink-0 px-2 py-0.5" onClick={() => void onCopy()} data-testid="activity-log-copy">
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

