// Completed answers render as markdown; streaming text is plain, so a
// half-open fence never flashes (spec §10.4).

import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { useMemo } from 'react'

marked.setOptions({ gfm: true, breaks: false })

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(text, { async: false }) as string
    return DOMPurify.sanitize(raw)
  }, [text])
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
}
