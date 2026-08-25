import { CSS_BASE } from './styles-base'
import { CSS_CASE } from './styles-case'
import { CSS_CHROME } from './styles-chrome'
import { CSS_REPORT } from './styles-report'

// The report stylesheet, assembled in cascade order: tokens and reset first,
// then the persistent chrome, then the report body, then the case cards. Order
// is load-bearing — every later section reads custom properties declared in
// CSS_BASE and relies on the specificity of what precedes it.
export const ASSERTION_HTML_CSS = `${CSS_BASE}${CSS_CHROME}${CSS_REPORT}${CSS_CASE}`
