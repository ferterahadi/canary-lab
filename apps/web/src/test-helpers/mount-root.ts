import { afterEach, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

export interface MountedRoot {
  container: HTMLDivElement
  root: Root
}

/** Test scaffolding: a fresh container and React root for every test, unmounted
 *  and removed after it. `attach` puts the container in `document.body`, which a
 *  test needs for anything that reads layout, focus or portals; a detached one is
 *  the faster default for markup-only assertions.
 *
 *  The pair arrives through `onMount` rather than as a return value because the
 *  callers keep their own `container` / `root` bindings: the values change per
 *  test, and renaming them would rewrite every assertion that reads them. Call it
 *  where the file's `beforeEach` / `afterEach` pair sat, so hook order is kept. */
export function mountRoot({ attach, onMount }: {
  attach: boolean
  onMount: (mounted: MountedRoot) => void
}): void {
  let mounted: MountedRoot
  beforeEach(() => {
    const container = document.createElement('div')
    if (attach) document.body.appendChild(container)
    mounted = { container, root: createRoot(container) }
    onMount(mounted)
  })
  afterEach(() => {
    act(() => mounted.root.unmount())
    mounted.container.remove()
  })
}
