# Upstream PR plan for the Grammar Edition

Status: proposal, not started. Nothing here has been sent to the upstream
repository. The `upstream` remote is configured with push disabled, so any PR
has to be opened from a fork of ZenNotes that the maintainer controls.

## Scope of the fork

Measured against base commit `7537be3c` (`git diff --stat 7537be3c...HEAD`):

- 454 files changed: 183 added, 271 modified.
- +55,093 / -3,765 lines. Files with grammar, LanguageTool, downstream, or
  systemd in their path account for about 9,500 of the added lines (about
  17%). The rest is spread across modified upstream files and tests, which is
  why the PR split below is by feature, not by directory.
- The Grammar Edition is built from the `grammar-main` branch. Upstream
  releases are merged in by `scripts/downstream/sync-upstream.sh`.

Modified upstream files (the riskiest part to upstream, since they touch code
the maintainers own):

- `packages/app-core/src`: 149 files
- `apps/desktop/src`: 50 files
- `packages/shared-domain/src`: 39 files (mostly `workflows/`; not yet
  confirmed as grammar-related)
- `packages/bridge-contract/src`: 5 files

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
5. **Shared-domain workflow changes.** Only after it is confirmed whether
   these edits are grammar-related. If they are not, they should be split into
   their own unrelated PRs, or dropped if they are fork drift.
6. **Tooling and smoke tests.** Changes under `tooling/scripts/` (vim, perf,
   terminal, window-state). Some of these look fork-specific (for example, a
   test that opens windows on a Mac's built-in display). Review each one
   before proposing it.

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
- Version and release bumps in `package.json` files, `package-lock.json`,
  `packaging/aur`, `packaging/homebrew`, `packaging/nix`, and
  `apps/desktop/terminal-release.json`. Upstream owns these.
- `apps/desktop/src/main/downstream-edition.ts` and its test, if it only
  identifies the fork at runtime. To be confirmed when the file is read.

## Prerequisites

- A fork of ZenNotes under the maintainer's account, so PRs can be opened
  against upstream from it.
- Each PR rebased on the current upstream `main` at the time it is opened, not
  on `7537be3c`. The base commit is an internal reference only.
- Upstream CI (or a local equivalent) passing on each PR on its own.
- Agreement from the maintainer that a grammar feature is in scope at all. The
  LanguageTool integration is a large new surface. Without that, PRs 1 to 4
  should not be opened.

## Known issues to fix before any PR

- `scripts/downstream/update-grammar-linux.sh` has its own tag discovery that
  does not filter to `vX.Y.Z`. The sync script was fixed in `b6c023cc`, but
  the daily timer still runs the unfiltered version. The timer should call the
  same discovery, or the filter should be copied in.
- `sync-upstream.sh` no longer uses `-X ours`. A conflicting merge now aborts
  and lists the files. Conflicts must be resolved by hand, so a release that
  touches the same code as the fork will stop the sync until someone resolves
  it.
- Blank-line whitespace drift in `packages/app-core/src/store.ts` was restored
  in `73d75ed2`. Other whitespace-only changes may still be in the diff.

## Open questions

1. Is grammar checking wanted upstream at all, or should this stay a fork
   feature? This decides whether any of the PRs above are worth writing.
2. Are the `packages/shared-domain/src/workflows/` changes a grammar
   dependency, or unrelated drift from a workflow feature?
3. Should the LanguageTool transport support a remote server, or only the
   local systemd socket used here? The socket is Linux-specific.
4. Which of the `tooling/scripts/` changes are generally useful, and which
   only work on this machine?
5. Does `apps/desktop/src/main/downstream-edition.ts` need to exist upstream
   at all, or can the fork detect itself without it?
6. What is the upstream release cadence? A fast cadence makes the
   hand-resolved merge conflicts more frequent, which affects how often the
   fork needs to rebase its PRs.
