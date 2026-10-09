/** A non-literal expression in a config file (e.g. `__dirname`,
 *  `process.env.CI ? 2 : 1`), carried as its source text. */
export interface ExprPlaceholder { $expr: string }

/** A config file value as the server parses it. `$expr` placeholders are
 *  read-only in the UI; the server round-trips them through the AST unchanged. */
export type ConfigValue =
  | null
  | boolean
  | number
  | string
  | ExprPlaceholder
  | ConfigValue[]
  | { [k: string]: ConfigValue }
