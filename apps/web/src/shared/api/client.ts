// Typed fetch wrappers around the Fastify server's REST endpoints. Pure
// functions — they accept a `fetch` impl via injection so tests can stub it.
// Production callers use the default (the global `fetch`).
//
// This module is the barrel: the wrappers live in per-domain siblings so no
// single file owns every endpoint. Import from here (or from the domain
// module directly) — the exported surface is identical either way.

export { ApiError } from './internal'
export type { FetchLike, ClientOptions } from './internal'

export * from './features'
export * from './coverage'
export * from './benchmark'
export * from './portify'
export * from './config'
export * from './workspace'
export * from './runs'
export * from './verification'
export * from './evaluation'
export * from './agent-sessions'
export * from './cleanup'
export * from './wizard'
export * from './flights'
