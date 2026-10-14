export const DEMO_TOUR_DIR = 'inbox/demo'
export const DEMO_TOUR_START_PATH = 'inbox/demo/00 Start Here.md'
export const DEMO_TOUR_ASSET_PATH = 'zennotes-demo-card.svg'

// The tour used to name its notes "NN <long dash> Title" (U+2014); it now writes
// "NN Title". Vaults seeded back then still hold the old files, and a self-hosted
// server that has not caught up still writes them, so the lookups below also
// accept the old name. The match is exact on purpose: removing and regenerating
// the tour delete the files it matches.
const OLDER_DEMO_TOUR_NOTE = /^(inbox\/demo\/\d{2}b?) \u2014 (.+\.md)$/

/** The current name of a demo tour note path. Any other path comes back unchanged. */
export function currentDemoTourPath(path: string): string {
  const match = OLDER_DEMO_TOUR_NOTE.exec(path)
  return match ? `${match[1]} ${match[2]}` : path
}

/** True for the tour's start note under its current or its older name. */
export function isDemoTourStartPath(path: string): boolean {
  return currentDemoTourPath(path) === DEMO_TOUR_START_PATH
}
