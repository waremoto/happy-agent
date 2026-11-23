// Hoja export: Markdown download and print-to-PDF. The Markdown export is the source itself (git's bytes, frontmatter
// included); PDF is the browser's print of the rendered page with Hoja's print stylesheet (chrome hidden).

/** A safe file name for a doc title: letters, digits, dashes; `.md` appended. */
export function markdownFilename(title = '') {
  const base = String(title).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
  return `${base || 'document'}.md`
}

/** The text of a Markdown export: the source with a title heading added only when it has none. */
export function markdownExport(text = '', title = '') {
  const src = String(text)
  const hasTitle = /^\s{0,3}#\s/m.test(src.split('\n').find(l => l.trim()) ?? '')
  const t = String(title).trim()
  const body = !hasTitle && t ? `# ${t}\n\n${src.replace(/^\n+/, '')}` : src
  return body.endsWith('\n') ? body : `${body}\n`
}

/** Browser: download `text` as a file. */
export function downloadText(name, text, type = 'text/markdown;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * Browser: print one element as the page (PDF through the print dialog). Everything else is hidden by the
 * `hoja-printing` class, which hoja.css styles for print; the class is removed after printing.
 */
export function printElement(el, title = '') {
  const root = document.documentElement
  const before = document.title
  el.classList.add('hoja-print-target')
  root.classList.add('hoja-printing')
  if (title) document.title = title
  const done = () => {
    el.classList.remove('hoja-print-target')
    root.classList.remove('hoja-printing')
    document.title = before
    window.removeEventListener('afterprint', done)
  }
  window.addEventListener('afterprint', done)
  window.print()
  // Some browsers never fire afterprint for a cancelled dialog.
  setTimeout(done, 60_000)
}
