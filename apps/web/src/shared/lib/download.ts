export interface DownloadOptions {
  documentRef?: Document
  urlApi?: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>
}

export function downloadBlob(blob: Blob, filename: string, options: DownloadOptions = {}): void {
  const documentRef = options.documentRef ?? document
  const urlApi = options.urlApi ?? URL
  const href = urlApi.createObjectURL(blob)
  let link: HTMLAnchorElement | undefined
  try {
    link = documentRef.createElement('a')
    link.href = href
    link.download = filename
    link.style.display = 'none'
    documentRef.body.appendChild(link)
    link.click()
  } finally {
    // Revoke even if DOM creation or cleanup fails after allocating the URL.
    try { link?.remove() } finally { urlApi.revokeObjectURL(href) }
  }
}
