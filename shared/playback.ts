// The reporter and readers share the persisted event format, including older records without IDs.
export interface RunSummaryRunningStep {
  title: string
  category: string
  location?: string
  locations?: string[]
}

/** Optional observations from one reporter process and one Playwright attempt. */
export interface FlowStamp {
  stream: string
  instance?: string
  sequence: number
  retry: number
  execution?: number
  stepId?: number
  parentId?: number
  revision?: string
  column?: number
  outcome?: 'completed' | 'failed' | 'skipped'
}

export type PlaywrightPlaybackEvent = { flow?: FlowStamp } & (
  | {
      type: 'test-begin'
      time: string
      test: { id?: string; name: string; title: string; location: string }
      /** `RunExecutionRef.index` of the Playwright invocation that ran this
       *  attempt. Absent on events recorded before it was stamped. */
      execution?: number
    }
  | {
      type: 'step-begin' | 'step-end'
      time: string
      test: { id?: string; name: string; title: string }
      step: RunSummaryRunningStep
    }
  | {
      type: 'test-end'
      time: string
      test: { id?: string; name: string; title: string; location: string }
      status: string
      passed: boolean
      durationMs: number
      retry: number
      /** Same stamp as on `test-begin`. */
      execution?: number
      error?: { message: string; snippet?: string }
      attachments?: Array<{ name: string; contentType?: string; path?: string }>
    }
)
