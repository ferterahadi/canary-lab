/**
 * Every empty-state string in the app, in one file.
 *
 * Not an indirection for its own sake — it is the only arrangement in which the
 * set can be held to a single shape. Copy written at its call site drifts: one
 * pane gets a three-clause explanation, its neighbour gets six words, and the
 * two render at different heights even though the component is identical. Side
 * by side, a body that has drifted is visible in the diff, and
 * `empty-state-copy.test.ts` holds the band mechanically.
 *
 * The band is `BODY_MIN_CHARS`–`BODY_MAX_CHARS`. It is not arbitrary: at the
 * body width and type size fixed in `EmptyState.tsx`, that range wraps to
 * exactly three lines, so every card reserves and fills the same box. Widen the
 * band and the panes stop being the same height.
 *
 * Titles are capped rather than banded — a title is one centred line, so its
 * length changes nothing about the card's geometry, only whether it wraps.
 */
import type { EmptyReason } from './EmptyState'

export interface EmptyCopy {
  reason: EmptyReason
  title: string
  body: string
}

/** The three-line band. See the file header for why it is these numbers. */
export const BODY_MIN_CHARS = 136
export const BODY_MAX_CHARS = 140
/** Wraps to a second line past this at the fixed body width. */
export const TITLE_MAX_CHARS = 40

export const EMPTY_COPY = {
  lifecycle: {
    reason: 'not-yet',
    title: 'No lifecycle events yet',
    body: 'Canary Lab records one row per moment that matters — a service coming up, the test process starting, a recovery attempt, the final verdict.',
  },
  playback: {
    reason: 'not-captured',
    title: 'No playback events captured',
    body: 'Structured Playwright events are written as each test resolves. This run wrote none, so the Terminal tab holds the raw output that survived.',
  },
  changesPassed: {
    reason: 'nothing-to-report',
    title: 'Nothing needed changing',
    body: 'This tab lists the files a repair agent edited, one card per repo. The run passed on its own, so no agent started and nothing was touched.',
  },
  changesNoEdits: {
    reason: 'not-captured',
    title: 'Nothing was changed in your code',
    body: 'A repair agent ran on this run, but no file edits were captured from it. What the agent was reasoning about is still in the Heal agent tab.',
  },
  journalPassed: {
    reason: 'nothing-to-report',
    title: 'Nothing to repair',
    body: 'The journal holds one entry per repair attempt — what looked broken, what changed, whether it worked. This run passed, so none was written.',
  },
  journalNoEntries: {
    reason: 'not-captured',
    title: 'No journal entries were written',
    body: 'A repair agent ran on this run, but it closed without writing an entry. What each cycle concluded is still readable in the Heal agent tab.',
  },
  journalLoading: {
    reason: 'not-yet',
    title: 'Reading the journal',
    body: "The journal is read from this run's own directory on disk. Entries land here the moment that read returns, one card per repair attempt made.",
  },
  healPassed: {
    reason: 'nothing-to-report',
    title: 'No repairs needed',
    body: 'Every test passed on the very first attempt, so a repair agent was never started. Nothing in your code was read, changed, or committed here.',
  },
  healNeverRan: {
    reason: 'never-ran',
    title: 'No repair agent ran',
    body: 'This run ended before any repair cycle began — it was aborted early, or heal is switched off for this suite in its own configuration file.',
  },
  agentNone: {
    reason: 'never-ran',
    title: 'No agent session was recorded',
    body: 'No agent was started under this run, or one ran outside Canary Lab and wrote nowhere it can be read back from. There is no transcript here.',
  },
  agentWaiting: {
    reason: 'not-yet',
    title: 'Waiting for the first output',
    body: 'The session is starting. Thinking, tool calls and results stream in the moment the agent writes its first line — nothing waits for the end.',
  },
  agentLoading: {
    reason: 'not-yet',
    title: 'Reading the session log',
    body: "This run's session log is read from the agent CLI's own store on disk. Thinking, tool calls and results appear here once that read returns.",
  },
  agentUnreadable: {
    reason: 'not-captured',
    title: "Couldn't read the session log",
    body: "The agent's transcript is read from the CLI's own session file on disk. This run named one, but it could not be opened for reading here.",
  },
  dirtyNoTestFiles: {
    reason: 'nothing-to-report',
    title: 'No changed test files',
    body: 'No uncommitted test edits remain in this working tree. Existing run results still describe exactly the tests each of those runs executed.',
  },
  paneServiceIdle: {
    reason: 'not-yet',
    title: 'Nothing logged yet',
    body: "This service's stdout and stderr stream here, line by line, the moment it writes something. Nothing has arrived from it during this run yet.",
  },
  panePlaywrightIdle: {
    reason: 'not-yet',
    title: 'Playwright has written nothing',
    body: 'The raw test output streams here line by line once the run reaches its test phase. Nothing has arrived from Playwright during this run yet.',
  },
  paneAgentIdle: {
    reason: 'not-yet',
    title: 'No repair agent running',
    body: 'If the tests fail, a repair agent starts here and its reasoning streams live. The tests have not failed on this run, so none is running yet.',
  },
  paneServiceMissing: {
    reason: 'not-captured',
    title: 'No service log captured',
    body: 'This run ended before the service pane wrote anything to disk, or its buffer has since been cleaned up. The Run Logs tab holds the story.',
  },
  panePlaywrightMissing: {
    reason: 'not-captured',
    title: 'No Playwright log captured',
    body: 'This run ended before the Playwright pane wrote anything to disk, or its buffer was cleaned up. The Playback tab holds the structured runs.',
  },
  paneAgentMissing: {
    reason: 'not-captured',
    title: 'No agent log captured',
    body: 'This run ended before the agent pane wrote anything to disk, or its buffer has since been cleaned up. The Journal tab holds each conclusion.',
  },
  stageWaiting: {
    reason: 'not-yet',
    title: 'Waiting for activity',
    body: 'This step is running now. Its agent thinking, tool calls and system lines appear on the rail below as soon as the first of them is written.',
  },
  stageNotStarted: {
    reason: 'not-yet',
    title: 'No activity yet',
    body: 'This step has not started yet. It runs once the steps it depends on have settled, and everything it then does is recorded on the rail below.',
  },
  stageNoActivity: {
    reason: 'not-captured',
    title: 'No activity recorded',
    body: 'This step settled without leaving a session log or any system lines behind, so there is no rail to replay — only the outcome it recorded.',
  },
  discoveryNoActivity: {
    reason: 'not-captured',
    title: 'No repair activity recorded',
    body: 'This discovery repair left no session log and no system lines behind. Its own status line is below, and the outcome is on the record above.',
  },
  portifyNoTranscript: {
    reason: 'nothing-to-report',
    title: 'Nothing to replay here',
    body: 'Port work leaves no agent transcript of its own. What it produced is the side-by-side boot and the port changes recorded above this rail.',
  },
} as const satisfies Record<string, EmptyCopy>

/**
 * The one entry whose body carries a number. Singular and plural are written to
 * land within a character of each other so a run with 1 cycle and a run with 12
 * render the same three lines — `empty-state-copy.test.ts` checks the whole
 * plausible range rather than one example.
 */
export function healNoTranscriptCopy(healCycles: number): EmptyCopy {
  return {
    reason: 'not-captured',
    title: 'No transcript found',
    body:
      healCycles === 1
        ? 'This run went through 1 repair cycle, but no session log for it could be read. The Journal tab still holds whatever that cycle concluded.'
        : `This run went through ${healCycles} repair cycles, but no session log for it could be read. The Journal tab still holds what each of them concluded.`,
  }
}
