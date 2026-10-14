# Upstream PR plan for the Grammar Edition

Status: proposal, not started. Nothing here has been sent to the upstream
repository. The `upstream` remote is configured with push disabled, so any PR
has to be opened from a fork of ZenNotes that the maintainer controls.

## Scope of the fork

Measured against the latest upstream release merged into `grammar-main`,
`v2.66.0` (`git diff --stat v2.66.0 grammar-main`):

- 81 files changed: 51 added, 30 modified. +10,618 / -49 lines.
- The Grammar Edition is built from the `grammar-main` branch. Upstream
  releases are merged in by `scripts/downstream/sync-upstream.sh`.

Modified upstream files (the riskiest part to upstream, since they touch code
the maintainers own):

- `packages/app-core/src`: 17 files
- `apps/desktop/src`: 5 files
- `packages/bridge-contract/src`: 2 files
- `packages/shared-domain/src`, `apps/web/src`: 1 file each
- `package.json`, `package-lock.json`, and the desktop and bridge-contract
  `package.json` files

## Proposed PR split

Each PR should build and pass its own tests without the later PRs.

1. **Bridge contract types.** `packages/bridge-contract/src/grammar.ts` and the
   grammar entries in `bridge.ts`. Types only, no runtime behaviour. Smallest
   and easiest to review first.
2. **Grammar core, no UI.** `packages/app-core/src/grammar/*` (coordinator,
   provider, preferences, prose extraction, document sessions, provider
   health, LanguageTool provider). Depends on PR 1.
3. **Desktop transport.** `apps/desktop/src/main/grammar/languagetool-transport.ts`
   and its preload wiring. Depends on PRs 1 and 2.
4. **Editor integration and UI.** `editor-extension.ts`, `editor-runtime.ts`,
   `GrammarReviewPanel.tsx`, `GrammarSettings.tsx`, and the store and
   `EditorPane.tsx` hooks. Depends on PRs 2 and 3.
5. **Keymaps and panel navigation.** The grammar shortcuts and panel wiring in
   `packages/shared-domain/src/keymaps-catalog.ts`, `lib/keymaps.ts`,
   `lib/commands.ts`, `lib/vim-nav.ts`, `lib/pane-nav.ts`,
   `lib/panel-rows.ts`, `VimNav.tsx`, `App.tsx`, and `SettingsModal.tsx`. Small
   enough to fold into PR 4 if the maintainer prefers fewer PRs.

## Exclusions (never upstreamed)

These exist only to build and ship the Grammar Edition. They should stay in
the fork:

- `scripts/downstream/**`: sync, reconcile, version, and Linux build scripts,
  plus the updater's systemd timer and service units.
- `packaging/downstream/grammar-edition.json`.
- `packaging/systemd/zennotes-languagetool*.{service,socket}`,
  `packaging/languagetool-server.properties`, and
  `scripts/grammar/install-languagetool.sh`. These run a local LanguageTool
  server, which is a deployment choice for this fork.
- `.github/workflows/grammar-downstream-sync.yml` and
  `.github/workflows/grammar-edition-release.yml`.
- `docs/grammar-assistant-*.md`. These are internal milestone notes.
- Version bumps in the `package.json` files and `package-lock.json`.
  Upstream owns these; keep only genuinely new dependencies, if any.
- `apps/desktop/src/main/downstream-edition.ts` and its test, and the
  fork-specific changes to `apps/desktop/src/main/updater.ts` and its Linux
  install test. These point the updater at the Grammar Edition's releases.

## Prerequisites

- A fork of ZenNotes under the maintainer's account, so PRs can be opened
  against upstream from it.
- Each PR rebased on the current upstream `main` at the time it is opened, not
  on `v2.66.0`. The fork's base release is an internal reference only.
- Upstream CI (or a local equivalent) passing on each PR on its own.
- Agreement from the maintainer that a grammar feature is in scope at all. The
  LanguageTool integration is a large new surface. Without that, PRs 1 to 4
  should not be opened.

## Known issues to fix before any PR

- `sync-upstream.sh` no longer uses `-X ours`. A conflicting merge now aborts
  and lists the files. Conflicts must be resolved by hand, so a release that
  touches the same code as the fork will stop the sync until someone resolves
  it.
- Blank-line whitespace drift in `packages/app-core/src/store.ts` was restored
  in `73d75ed2`. Other whitespace-only changes may still be in the diff.

## Open questions

1. Is grammar checking wanted upstream at all, or should this stay a fork
   feature? This decides whether any of the PRs above are worth writing.
2. Should the LanguageTool transport support a remote server, or only the
   local systemd socket used here? The socket is Linux-specific.
3. Does `apps/desktop/src/main/downstream-edition.ts` need to exist upstream
   at all, or can the fork detect itself without it?
4. What is the upstream release cadence? A fast cadence makes the
   hand-resolved merge conflicts more frequent, which affects how often the
   fork needs to rebase its PRs.
