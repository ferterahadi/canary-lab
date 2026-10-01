import { useEffect, useRef, useState } from 'react'
import * as api from '@/shared/api/client'
import { ApiError } from '@/shared/api/internal'
import { useLiveResource } from '@/shared/state/use-live-resource'

type BrowserKind = 'files' | 'folders'
const normalized = (path: string) => {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '..') parts.pop()
    else if (part && part !== '.') parts.push(part)
  }
  return `/${parts.join('/')}`
}
async function readDirectory(kind: BrowserKind, dir: string): Promise<api.FsBrowseResponse | null> {
  try {
    const result = kind === 'files' ? await api.browseDir(dir) : await api.listWorkspaceDirs(dir).then((value) => ({
      dir: value.absolute ?? value.root, parent: value.parent ?? null,
      entries: value.dirs.map((name) => ({ name, isDir: true })),
    }))
    // Older servers signal a missing directory by returning an empty home
    // fallback with no parent. Never certify that fallback as the requested path.
    const requested = dir.trim()
    const expanded = requested.startsWith('/') ? requested : `${result.dir}/${requested.replace(/^~(?:\/|$)/, '')}`
    if (requested && !result.parent && result.entries.length === 0 && normalized(expanded) !== normalized(result.dir)) return null
    return result
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null
    throw error
  }
}

/** Directory observations own ordering; text entry and accepted listings have
 * separate lifetimes so an old response cannot rewrite newly typed input. */
export function useFilesystemBrowser({ session, kind, initialPath = '', enabled = true }: {
  session: string; kind: BrowserKind; initialPath?: string; enabled?: boolean
}) {
  const [request, setRequest] = useState({ session, dir: initialPath, revision: 0, textVersion: 0 })
  const [input, setInput] = useState({ session, value: initialPath })
  const textVersion = useRef(0)
  const active = request.session === session ? request : { session, dir: initialPath, revision: 0, textVersion: textVersion.current }
  const resource = useLiveResource(null, enabled ? JSON.stringify([session, kind, active.dir]) : null,
    () => readDirectory(kind, active.dir), { refreshKey: active.revision })
  const [accepted, setAccepted] = useState<{ session: string; value: api.FsBrowseResponse | null } | null>(null)
  useEffect(() => {
    if (!enabled || !resource.confirmed) return
    setAccepted({ session, value: resource.value })
    if (resource.value && textVersion.current === active.textVersion) setInput({ session, value: resource.value.dir })
  }, [enabled, resource.confirmed, resource.value, session, active.textVersion])
  const navigate = (dir: string) => {
    const version = ++textVersion.current
    setInput({ session, value: dir })
    setRequest({ session, dir, revision: active.revision + 1, textVersion: version })
  }
  const missing = enabled && resource.confirmed && resource.value === null
  return {
    browse: resource.confirmed ? resource.value : accepted?.session === session ? accepted.value : null,
    pathInput: input.session === session ? input.value : initialPath,
    setPathInput: (value: string) => { textVersion.current++; setInput({ session, value }) },
    requestedPath: active.dir,
    navigate,
    retry: () => setRequest({ ...active, revision: active.revision + 1 }),
    confirmed: enabled && resource.confirmed && resource.value !== null,
    loading: enabled && !resource.confirmed && !resource.error,
    error: missing ? 'This directory is no longer available.' : resource.error,
  }
}
