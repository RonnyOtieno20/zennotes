/** What the Quick Look extension embeds in #zen-quicklook-data. */
export interface QuickLookPayload {
  /** The file name without its extension. */
  title: string
  markdown: string
  /** The note's path inside its vault, or its file name outside one. */
  notePath: string
  /** A Markdown reference, as written and as decoded, mapped to the
   *  zenql:// URL the extension serves its file from. */
  assets: Record<string, string>
  /** The text of ~/.config/zennotes/config.toml, or '' when there is none. */
  config: string
}

export const QUICKLOOK_ASSET_PREFIX = 'zenql://app/asset/'

export function readQuickLookPayload(doc: Pick<Document, 'getElementById'> = document): QuickLookPayload | null {
  const text = doc.getElementById('zen-quicklook-data')?.textContent
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as Partial<QuickLookPayload>
    if (typeof parsed.markdown !== 'string') return null
    return {
      title: typeof parsed.title === 'string' && parsed.title ? parsed.title : 'Untitled',
      markdown: parsed.markdown,
      notePath: typeof parsed.notePath === 'string' && parsed.notePath ? parsed.notePath : 'note.md',
      assets: localAssets(parsed.assets),
      config: typeof parsed.config === 'string' ? parsed.config : ''
    }
  } catch {
    return null
  }
}

/** Only URLs the extension itself serves: the page has no network, and a
 *  payload never points it anywhere else. */
function localAssets(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const assets: Record<string, string> = {}
  for (const [ref, url] of Object.entries(value)) {
    if (typeof url === 'string' && url.startsWith(QUICKLOOK_ASSET_PREFIX)) assets[ref] = url
  }
  return assets
}
