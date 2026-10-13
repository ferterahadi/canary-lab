/** One human decision shared by MCP forms and the browser inbox. */
export interface ApprovalField {
  type?: string
  title?: string
  description?: string
  enum?: Array<string | number | boolean>
  minLength?: number
  maxLength?: number
}
export interface Approval {
  id: string
  reviewUrl: string
  command: string
  feature?: string
  message: string
  schema: { properties?: Record<string, ApprovalField>; required?: string[] }
  status: 'pending' | 'answering' | 'answered' | 'expired' | 'failed'
  startedAt: string
  expiresAt: string
  answer?: Record<string, unknown>
  error?: string
}
