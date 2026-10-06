export type QuickLookAction = 'open' | 'lineDown' | 'lineUp' | 'halfDown' | 'halfUp' | 'top' | 'bottom'

export interface QuickLookKey {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  /** Milliseconds, as event.timeStamp. */
  timeStamp: number
}

/** How long the first `g` of `gg` waits for the second. */
const SEQUENCE_MS = 800

/**
 * What a key press does in the preview once it has focus. Enter opens the
 * note in ZenNotes in either mode. With Vim mode on, `o` opens too and the
 * Vim motions move through the note; with it off no single letter does
 * anything, so the arrows, Page Up/Down and Space scroll as in any page.
 */
export function createQuickLookKeys(vimMode: boolean): (key: QuickLookKey) => QuickLookAction | null {
  let pendingG: number | null = null
  return (event) => {
    const previous = pendingG
    pendingG = null
    if (event.metaKey || event.altKey) return null
    if (event.key === 'Enter' && !event.ctrlKey && !event.shiftKey) return 'open'
    if (!vimMode) return null
    if (event.ctrlKey) {
      if (event.key === 'd') return 'halfDown'
      if (event.key === 'u') return 'halfUp'
      return null
    }
    switch (event.key) {
      case 'o':
        return 'open'
      case 'j':
        return 'lineDown'
      case 'k':
        return 'lineUp'
      case 'G':
        return 'bottom'
      case 'g':
        if (previous !== null && event.timeStamp - previous <= SEQUENCE_MS) return 'top'
        pendingG = event.timeStamp
        return null
      default:
        return null
    }
  }
}
