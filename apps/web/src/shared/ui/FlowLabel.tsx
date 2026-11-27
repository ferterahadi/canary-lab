export function FlowLabel({ label }: { label: string }) {
  const pieces = [],
    pattern = /^\w+|\b\d+(?:\.\d+)?\b(?:[ -](?:seconds?|characters?)\b)?|\b[A-Z][A-Z_]{2,}\b/g
  let end = 0
  for (const match of label.matchAll(pattern)) {
    const word = match[0]
    pieces.push(label.slice(end, match.index))
    if (/^\d/.test(word)) {
      const number = word.match(/^\d+(?:\.\d+)?/)![0]
      pieces.push(
        <span className="diagram-measure" key={match.index}>
          <span className="diagram-number">{number}</span>
          {word.slice(number.length)}
        </span>
      )
    } else {
      pieces.push(
        <span
          key={match.index}
          className={
            match.index === 0
              ? 'diagram-verb'
              : /\bis\s+$/.test(label.slice(0, match.index))
                ? 'diagram-string'
                : undefined
          }
        >
          {word}
        </span>
      )
    }
    end = match.index + word.length
  }
  return (
    <>
      {pieces}
      {label.slice(end)}
    </>
  )
}
