// Every component test in the `dom` project drives React through `act()`.
// React only flushes effects synchronously inside `act()` — and stays quiet
// about it — when this global is set, so the flag belongs to the environment
// rather than to each test file. A file that needs the opposite sets it locally.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
