// Pure naming rules for the portify overlay — the ephemeral patch set saved
// under `<featureDir>/portify/`. One home for the layout so the server (which
// writes the files: apps/web-server .../runtime/overlay.ts) and the web UI
// (which tells the user where they live: PortifyWizard's "Stored in" row)
// can never drift on a filename.

export const OVERLAY_DIRNAME = 'portify'

/** Filesystem-safe patch filename for a repo. */
export function patchFileName(repoName: string): string {
  const slug = repoName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'repo'
  return `${slug}.patch`
}
