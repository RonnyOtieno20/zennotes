/**
 * What's New: a window on the first launch after every update, and on demand
 * from the palette ("What’s New in ZenNotes") and `:whatsnew`.
 *
 * The highlights are bundled on purpose (Adib, 2026-10-12): the window works
 * offline and opens at once, and its copy is reviewed in the release PR like
 * the code it describes. Add an entry in the release PR of every release
 * worth announcing. An update across several versions shows each entry in
 * between, newest first; a version without one still opens the window, with
 * the Cloud card and the link to its release notes on the website.
 *
 * Desktop only: the phones announce through their stores, and a self-hosted
 * web app updates with its server.
 */

export type UsageCountEvent = 'install' | 'update'

export interface WhatsNewEntry {
  version: string
  highlights: ReadonlyArray<{ title: string; body: string }>
}

/** What the window shows. */
export interface WhatsNewView {
  /** The version the window is about: the one just installed. */
  version: string
  entries: WhatsNewEntry[]
  /** The Cloud card, left out for someone already on Cloud. */
  showCloud: boolean
}

/** The ZenNotes Cloud card: a fixture of every What's New, not one release's
 *  news (Adib, 2026-10-12). */
export const CLOUD_ANNOUNCEMENT = {
  title: 'ZenNotes Cloud',
  body: 'Keep your vaults in sync on every device, backed up every day, and publish notes to the web.',
  settingsLabel: 'Set up ZenNotes Cloud',
  link: { label: 'Plans and pricing', url: 'https://zennotes.org/pricing' }
} as const

export const WHATS_NEW: readonly WhatsNewEntry[] = [
  {
    version: '2.70.0',
    highlights: [
      {
        title: 'React to task changes',
        body: 'The zn CLI that ZenNotes bundles on macOS and Linux is now 0.8.0. Its zn task watch prints a line each time a task’s status changes, so a script can act the moment a card moves to another column.'
      },
      {
        title: 'Assistants see the column',
        body: 'Through MCP, list_tasks now gives each task’s status: the column it sits in when the Kanban board is grouped by Custom status.'
      },
      {
        title: 'Quick capture with Vim',
        body: 'The Quick capture window’s shortcuts now work while Vim is in normal mode: Ctrl+P and Ctrl+N everywhere, and Ctrl+W on Linux and Windows. Its note picker shows each note’s name first and keeps the selection in view.'
      },
      {
        title: 'Ctrl+P in Search Notes',
        body: 'On Linux and Windows, Ctrl+P in Search Notes moves the selection up, as in every other list, instead of closing it. Escape closes it.'
      }
    ]
  },
  {
    version: '2.69.1',
    highlights: [
      {
        title: 'Renames on Windows',
        body: 'Renaming a note or an attachment to a name another one already has now always stops and says so on Windows, instead of sometimes replacing the other file.'
      }
    ]
  },
  {
    version: '2.69.0',
    highlights: [
      {
        title: 'Assistants reach your server',
        body: 'Settings → MCP → Server token lets Claude, Codex and other assistants use a ZenNotes Server that needs a token, with no terminal step.'
      },
      {
        title: 'Which Claude, which tab',
        body: 'The MCP integrations say which part of the Claude app they reach: its Code tab uses the Claude Code entry.'
      },
      {
        title: 'Setup for a server vault',
        body: 'Connecting to a ZenNotes Server during setup skips the layout step: the server’s vault already has one.'
      },
      {
        title: 'Clearer keys for a new note',
        body: 'The New note form in search names the keys that work in the field you are in.'
      },
      {
        title: 'Encrypted vaults say so',
        body: 'A Cloud vault that another device encrypted end to end reads as encrypted, not deleted.'
      }
    ]
  },
  {
    version: '2.68.0',
    highlights: [
      {
        title: 'Review an assistant’s edits',
        body: 'When Claude Code, Codex or another assistant changes a note through MCP, review each change in the note itself and keep or undo it.'
      },
      {
        title: 'Windows on ARM',
        body: 'A native build for Snapdragon and other ARM PCs, so ZenNotes no longer runs through emulation there.'
      },
      {
        title: 'Links on Windows',
        body: 'zennotes:// links open ZenNotes on Windows, and connecting ZenNotes Cloud finishes there.'
      },
      {
        title: 'Headings stay headings',
        body: 'Tab no longer turns a heading into a code block.'
      },
      {
        title: 'Table widths in Preview',
        body: 'Column widths you set in the editor carry into Preview, and a wide table scrolls instead of squeezing its columns.'
      }
    ]
  }
]

/** The version's entry on the website's releases page (an anchor per release). */
export const RELEASE_NOTES_URL = (version: string): string => `https://zennotes.org/releases#v${version}`

/** Dotted numeric parts compared left to right; a prerelease suffix
 *  (`2.68.0-beta.1`) sorts below its release. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): { parts: number[]; pre: string } => {
    const [core, ...rest] = v.replace(/^v/, '').split('-')
    return { parts: core.split('.').map((p) => Number.parseInt(p, 10) || 0), pre: rest.join('-') }
  }
  const x = split(a)
  const y = split(b)
  for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i += 1) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  if (x.pre === y.pre) return 0
  if (!x.pre) return 1
  if (!y.pre) return -1
  return x.pre < y.pre ? -1 : 1
}

/** The entries newer than `after` (all when null) up to `current`, newest first. */
export function whatsNewBetween(
  after: string | null,
  current: string,
  entries: readonly WhatsNewEntry[] = WHATS_NEW
): WhatsNewEntry[] {
  return entries
    .filter(
      (e) =>
        compareVersions(e.version, current) <= 0 &&
        (after === null || compareVersions(e.version, after) > 0)
    )
    .sort((a, b) => compareVersions(b.version, a.version))
}

/**
 * What the first launch of `current` does. `updated` opens the window. A fresh
 * install sees nothing (the onboarding is its welcome) but records the
 * version. A returning user who has never seen the window, because they come
 * from a version without it, gets every entry up to `current`; otherwise the
 * entries since the version they last saw. A downgrade shows nothing and
 * records the version, so the way back up opens the window again.
 *
 * `count` is the event for the anonymous usage count (Settings > About): once
 * per fresh install, once per update, nothing for a relaunch or a downgrade.
 */
export function whatsNewAtLaunch(input: {
  lastSeen: string | null
  current: string
  returningUser: boolean
  entries?: readonly WhatsNewEntry[]
}): { updated: boolean; entries: WhatsNewEntry[]; record: boolean; count: UsageCountEvent | null } {
  const { lastSeen, current, returningUser, entries = WHATS_NEW } = input
  const none = { updated: false, entries: [] as WhatsNewEntry[] }
  if (lastSeen !== null && compareVersions(lastSeen, current) === 0) return { ...none, record: false, count: null }
  if (lastSeen === null && !returningUser) return { ...none, record: true, count: 'install' }
  if (lastSeen !== null && compareVersions(lastSeen, current) > 0) return { ...none, record: true, count: null }
  return { updated: true, entries: whatsNewBetween(lastSeen, current, entries), record: true, count: 'update' }
}

/** The palette's entries: this version's, or the newest at or below it, or
 *  (a development build ahead of its notes) the newest there is. */
export function whatsNewOnDemand(current: string, entries: readonly WhatsNewEntry[] = WHATS_NEW): WhatsNewEntry[] {
  const upToNow = whatsNewBetween(null, current, entries)
  if (upToNow.length) return upToNow.slice(0, 1)
  const newest = [...entries].sort((a, b) => compareVersions(b.version, a.version))[0]
  return newest ? [newest] : []
}
