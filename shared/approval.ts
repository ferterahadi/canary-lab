/** One human decision shared by MCP forms and the browser inbox. */
export interface ApprovalField {
  type?: string
  title?: string
  description?: string
  enum?: Array<string | number | boolean>
  minLength?: number
  maxLength?: number
}
/** How the browser card names one answer option, keyed by its enum value. */
export interface ApprovalChoice {
  label?: string
  /** What happens next if the human picks this option. */
  detail?: string
}
/** Browser-card presentation only. The native MCP form keeps its plain schema,
 *  so a client never receives fields it was not built to render. */
export interface ApprovalDisplay {
  title: string
  choices?: Record<string, ApprovalChoice>
}
export interface Approval {
  id: string
  reviewUrl: string
  command: string
  feature?: string
  message: string
  display?: ApprovalDisplay
  schema: { properties?: Record<string, ApprovalField>; required?: string[] }
  status: 'pending' | 'answering' | 'answered' | 'expired' | 'failed'
  startedAt: string
  expiresAt: string
  answer?: Record<string, unknown>
  error?: string
}
