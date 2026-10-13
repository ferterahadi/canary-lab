/** The text of anything a `catch` received. A thrown non-Error (a string, a
 *  rejected plain value) is stringified unless the caller names the copy to show
 *  instead — a UI line reads better as "Save failed" than as "[object Object]". */
export function errorMessage(err: unknown, fallback?: string): string {
  if (err instanceof Error) return err.message
  return fallback ?? String(err)
}
