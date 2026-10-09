import { vi } from 'vitest'

/**
 * Module factory for `vi.mock('<…>/shared/editor-launch', …)`: route tests must
 * never open a real editor, and every launch reports `vscode`.
 */
export function editorLaunchMock() {
  return { launchEditorDir: vi.fn(() => 'vscode') }
}
