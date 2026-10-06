/** Messages the page sends the Swift extension that hosts it. */
export type QuickLookHostMessage =
  | { action: 'ready' }
  | { action: 'open' }
  | { action: 'openLink'; url: string }

interface WebKitMessageHandlers {
  zennotes?: { postMessage(message: QuickLookHostMessage): void }
}

export function postToHost(message: QuickLookHostMessage): void {
  const handlers = (window as unknown as { webkit?: { messageHandlers?: WebKitMessageHandlers } }).webkit
    ?.messageHandlers
  handlers?.zennotes?.postMessage(message)
}

/** The links a preview hands to the browser; everything else stays inert. */
export function isOutsideLink(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href.trim())
}
