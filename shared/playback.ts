// The reporter and readers share the persisted event format, including older records without IDs.
export interface RunSummaryRunningStep {
  title: string
  category: string
  location?: string
  locations?: string[]
}

export type PlaywrightPlaybackEvent =
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
