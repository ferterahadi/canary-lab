import { EditorState, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'

/** A read-only listing still supports text selection, keyboard navigation and copy. */
export function createReaderEditor(parent: HTMLElement, doc: string, label: string, extensions: Extension[]) {
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorView.contentAttributes.of({ tabindex: '0', 'aria-label': label, 'aria-readonly': 'true' }),
        ...extensions,
      ],
    }),
  })
}

/** Token HTML comes from Shiki highlighting the complete source, so a diff can
 * project a multiline token onto the right row without re-tokenizing fragments. */
export function readerSyntaxMarks(html: string, from: number): Range<Decoration>[] {
  const template = document.createElement('template')
  template.innerHTML = html
  const marks: Range<Decoration>[] = []
  for (const token of template.content.childNodes) {
    const end = from + (token.textContent?.length ?? 0)
    const style = token instanceof HTMLElement && token.getAttribute('style')
    if (style && end > from) marks.push(Decoration.mark({ attributes: { style } }).range(from, end))
    from = end
  }
  return marks
}

export function readerLabelMarks(text: string, at: number): Range<Decoration>[] {
  return [...text.matchAll(/^\w+|\b\d+(?:\.\d+)?\b|\b[A-Z][A-Z_]{2,}\b/g)].map((match) => {
    const kind = match.index === 0 ? 'verb' : /^\d/.test(match[0]) ? 'number' : 'string'
    return Decoration.mark({ class: 'outline-' + kind }).range(at + match.index, at + match.index + match[0].length)
  })
}
