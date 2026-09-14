# Grammar Assistant Milestone 0 Reconnaissance

Date: 2026-08-01
Upstream baseline: `87f60a5` (`main`, ZenNotes `2.20.2`)

## Outcome

The proposed grammar assistant fits ZenNotes' current architecture. The feature should live primarily in a self-contained `packages/app-core/src/grammar/` subsystem, with narrow hooks into the primary `EditorPane`, settings, command, panel, and host-bridge surfaces.

Two assumptions in the original brief need adjustment before implementation:

1. A note can be open in multiple pane-local CodeMirror views. The coordinator and normalized diagnostic state must therefore be shared and keyed by vault/document identity, while decorations and replacement dispatch remain local to each `EditorView`.
2. The desktop renderer's Content Security Policy blocks direct requests to `http://127.0.0.1`, and renderer requests would also be subject to CORS. LanguageTool transport should go through a narrow host bridge instead of broadening the renderer CSP.

Neither adjustment changes the intended native CodeMirror experience or requires an external overlay.

## Baseline verification

Environment used for reconnaissance:

- Node `v24.16.0` (the repository requires Node 22 or newer; CI uses Node 22)
- repository package manager: npm `10.9.2`
- Go `1.26.0` (the module minimum is Go 1.22)

Results before any feature implementation:

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed: 7/7 workspaces |
| `npm run test:run` | Passed: 6/6 test tasks; app-core 1,285 tests, shared-domain 1,302 tests, desktop 507 tests, plus Go server tests |
| `npm run build` | Passed: desktop, web, shared packages, and Go server |
| isolated `npm run dev` smoke run | Renderer dev server started; Electron reached `ready-to-show` and `did-finish-load`; stopped intentionally after 35 seconds |

The first dependency install encountered registry timeouts and left the Electron binary incomplete. Reusing the checksum-verified cached Electron `41.2.1` archive repaired the install; the full suite then passed. This was an environment/install failure, not a source failure.

Existing non-fatal output includes CodeMirror/jsdom geometry warnings in passing Vim tests, the existing JSXGraph `eval` build warning, and Turbo warnings for typecheck-only packages that declare no output files.

## Repository boundaries

The source-of-truth boundary is documented in `docs/monorepo-architecture.md` and `docs/reference/runtime-and-package-map.md`:

- `packages/app-core`: shared React product UI and editor behavior
- `packages/bridge-contract`: typed contract between the shared UI and its host
- `apps/desktop`: Electron main/preload, local filesystem, updater, and packaging
- `apps/web` + `apps/server`: browser bridge and Go host for self-hosted mode
- `packages/shared-domain`: cross-runtime types and portable preference definitions

The grammar domain, Markdown extraction, coordinator, editor extension, and review UI belong in `app-core`. Only outbound provider transport, secrets, and packaging/update policy belong in runtime-specific code.

## Editor and document lifecycle

### CodeMirror construction

`packages/app-core/src/components/EditorPane.tsx` is the primary integration seam.

- `buildEditorKeymap()` builds the configurable CodeMirror keymap and is reconfigured when Vim mode or overrides change.
- `markdownEditingExtensions()` installs CodeMirror 6 Markdown support with ZenNotes' custom language resolver and Markdown editor plugins.
- `EditorState.create()` creates pane-local compartments and extensions.
- `EditorView.updateListener` persists ordinary `docChanged` transactions through `updateNoteBody(path, doc)`.
- `EditorView` is stored in the pane's local `viewRef`; the global `editorViewRef` represents only the active pane.

Current dependency versions are CodeMirror state `^6.5.0`, view `^6.35.3`, language `^6.10.6`, Markdown `^6.3.1`, commands `^6.7.1`, and Replit Vim `^6.3.0`.

### Edit, split, and preview

`EditorPane.tsx` derives the display from per-pane/per-note mode state in `store.ts`:

- Edit renders CodeMirror.
- Split renders the same pane-local CodeMirror view plus the React preview.
- Preview renders the React preview without CodeMirror.

`noteContents` is shared across panes, but each `EditorPane` owns its own `EditorView`. A correction must be dispatched to the host pane's local view as a normal CodeMirror transaction; the existing store synchronization will propagate the new note body to other panes.

### Required session model

Create a small grammar session registry outside the large application store. Key each session by a stable vault identity plus note path and track:

- current full-document fingerprint and monotonic generation;
- segment fingerprints and source ranges;
- one in-flight/cached provider check per unchanged segment;
- normalized diagnostics independent of any one pane;
- pane/view subscriptions with reference counting.

Each view keeps its own CodeMirror state field/decorations and subscribes to the shared session. Before applying a replacement, verify the session key, generation, source range, expected original text, and current segment fingerprint. This makes a stale result displayable only until invalidated and never applicable to a different note or range.

## Markdown syntax and prose extraction

ZenNotes already installs the CodeMirror/Lezer Markdown language. Existing helpers such as `packages/app-core/src/lib/cm-auto-pairs.ts` use `syntaxTree(state)` and ancestor node names including `FencedCode` and `InlineCode`, proving that exact source ranges are available at the editor layer.

There is no existing complete prose extractor. The new extractor should:

1. walk the Lezer tree for structural ranges;
2. reuse or adapt existing focused helpers for ZenNotes-specific math, wikilinks, front matter, tables, callouts, and rendered block constructs;
3. produce independent prose segments with an explicit provider-offset-to-CodeMirror-position map;
4. add characterization tests for every syntax-node assumption before relying on it.

The parser is intentionally deferred for three seconds when a document is at least 120,000 characters and live preview is off. Automatic grammar checking must wait until the Markdown compartment is restored for such documents. It must not fall back to regex-parsing the complete document on the main thread. A later manual large-note path may parse/chunk off the interaction-critical path.

LanguageTool offsets must be normalized against JavaScript UTF-16 positions with tests covering emoji, astral characters, combining marks, CRLF, and multiple replacements. Do not infer byte or code-point equivalence.

## Provider transport amendment

`apps/desktop/src/renderer/index.html` currently limits `connect-src` to the app and ZenNotes custom schemes. A renderer-side fetch to the planned default `http://127.0.0.1:8081/v2` would be blocked, and allowing arbitrary endpoints in CSP would unnecessarily widen the renderer's network authority.

Use a provider-neutral transport in `app-core` backed initially by an optional desktop bridge method:

- define request/response wire types and optional capability in `packages/bridge-contract`;
- add dedicated grammar IPC channels in `packages/bridge-contract/src/ipc.ts`;
- expose check/cancel calls in `apps/desktop/src/preload/index.ts`;
- implement the LanguageTool HTTP request in a small `apps/desktop/src/main/grammar/` module and register it in the existing IPC setup;
- use request IDs plus main-process `AbortController`s so superseded checks are actually cancelled across the IPC boundary;
- use Node/Electron's existing HTTP/fetch support; add no dependency.

The host must validate `http:`/`https:` endpoints, enforce timeouts and response-size limits, avoid logging submitted text, and guard redirects. Loopback endpoints should remain the default. Remote endpoints require the explicit privacy warning already specified in the brief.

The self-hosted web runtime cannot safely inherit the desktop transport automatically. Its CSP and browser CORS rules require either a same-origin Go proxy with an outbound allowlist or a separately configured direct-CORS mode. Implement desktop transport first; add the web/server transport as a deliberate later slice without weakening the web security policy.

Desktop already has an OS-backed secret pattern in `apps/desktop/src/main/secret-store.ts` using optional keytar and Electron `safeStorage`. If a future remote provider requires credentials, generalize that pattern. API keys must not enter portable `config.toml`, localStorage, diagnostic logs, or the synced grammar settings object.

## Panels, commands, settings, and theming

### Review panel

Model `GrammarReviewPanel` on `packages/app-core/src/components/OutlinePanel.tsx`, not on the Connections domain state. Outline establishes the correct pattern:

- panel lives inside `EditorPane`, so each split pane targets its local view;
- `onJump`/`onApply` callbacks are owned by the host pane;
- width, focus, cursor, resize, and empty states use the shared panel conventions.

Add a distinct grammar panel identifier, width, cursor, and focus state. Render it beside the existing right panels in `EditorPane.tsx`. Keep normalized diagnostics in the grammar session registry; store only ordinary application preferences and panel UI state in `store.ts`.

### Commands and Vim

Use the existing command and keymap surfaces:

- `packages/app-core/src/lib/keymaps.ts`: remappable command IDs/defaults
- `packages/app-core/src/lib/commands.ts`: command-palette actions
- `packages/app-core/src/components/CommandPalette.tsx`: palette presentation
- `packages/app-core/src/App.tsx`: global shortcut routing for panel-level actions
- `EditorPane.tsx` / `buildEditorKeymap()`: editor-local next/previous/show/apply actions
- `packages/app-core/src/lib/vim-nav.ts`: panel type, DOM marker, and visible-panel ordering
- `packages/app-core/src/components/VimNav.tsx`: focused-panel `j`/`k`/`Enter`/`Esc` routing
- `packages/app-core/src/lib/panel-rows.ts`: indexed grammar-card rows and cursor movement shared by Vim and pane navigation

Do not add raw always-on window handlers for editor actions. `j`, `k`, `Enter`, and `Esc` should operate only while the grammar panel/card owns focus. Editor focus must retain current Vim semantics.

### Settings

The settings path spans:

- `packages/app-core/src/components/SettingsModal.tsx`
- `Prefs`, `DEFAULT_PREFS`, validation, and setters in `packages/app-core/src/store.ts`
- `PORTABLE_PREF_KEYS` and `PORTABLE_DEFAULTS` in `packages/shared-domain/src/app-config.ts`
- TOML parsing/serialization in `apps/desktop/src/main/app-config.ts`
- mirror tests in `packages/app-core/src/lib/portable-config-defaults.test.ts` and `apps/desktop/src/main/app-config.test.ts`

Endpoint, language, enablement, categories, ignored rules, dictionary, and safe debounce settings can be portable. Credentials cannot. The master toggle remains off by default.

### Theme styling

Add grammar styles to `packages/app-core/src/styles/index.css` using the existing `--z-*` RGB tokens and `data-theme`/`data-theme-mode` system. Decorations should use CodeMirror classes and theme-aware underlines; the selected issue may use a stronger existing accent/background token.

## Smallest viable patch surface

New self-contained files for Milestones 1-4 should be grouped under:

```text
packages/app-core/src/grammar/
  types.ts
  prose.ts
  document-sessions.ts
  coordinator.ts
  provider.ts
  transports/bridge.ts
  providers/languagetool.ts
  editor-extension.ts
  commands.ts
  test-support.ts
  *.test.ts
packages/app-core/src/components/GrammarReviewPanel.tsx
apps/desktop/src/main/grammar/languagetool-transport.ts
```

Existing files expected to receive narrow registration or contract changes:

```text
packages/app-core/src/components/EditorPane.tsx
packages/app-core/src/components/SettingsModal.tsx
packages/app-core/src/components/CommandPalette.tsx
packages/app-core/src/components/VimNav.tsx
packages/app-core/src/lib/commands.ts
packages/app-core/src/lib/keymaps.ts
packages/app-core/src/lib/panel-rows.ts
packages/app-core/src/lib/vim-nav.ts
packages/app-core/src/store.ts
packages/app-core/src/styles/index.css
packages/shared-domain/src/app-config.ts
packages/bridge-contract/src/bridge.ts
packages/bridge-contract/src/ipc.ts
apps/desktop/src/preload/index.ts
apps/desktop/src/main/index.ts
apps/desktop/src/main/app-config.ts
```

The navigation registration must include focused-panel and row-navigation tests, particularly `packages/app-core/src/lib/vim-nav.test.ts` plus the existing panel-row coverage. A focusable grammar panel is not complete until both `<C-w>`/`Alt` pane traversal and panel-owned `j`/`k`/`Enter` behavior recognize it.

The first proof of concept should not touch preview rendering, vault file I/O, autosave, updater code, or existing Connections/Outline domain models.

## Packaging, identity, and downstream updates

`apps/desktop/package.json` builds AppImage, deb, pacman, rpm, and tar.gz packages. `npm run dist:linux` performs the production checks before running electron-builder. `.github/workflows/release.yml` builds Linux x64 and arm64 and already uploads `*.tar.gz`; the "missing tar.gz upload" warning in `packaging/PUBLISHING.md` is stale.

The current package keeps the official identity and update source:

- app id: `com.adibhanna.zennotes`
- product/executable: `ZenNotes`
- electron-builder publish source: `ZenNotes/zennotes`
- updater: enabled for packaged builds and checks GitHub releases automatically

A downstream build must not ship with that updater configuration, or an official update can replace the grammar-enabled build. For the first personal package, disable update initialization/check/download/install surfaces at build time and show a clear "managed by downstream releases" status. Preserve the existing user-data and vault paths initially, after backing up the real config during package smoke tests. A dedicated downstream GitHub update feed can replace this later.

The downstream sync workflow should use the brief's `upstream-main`, `grammar-main`, and temporary `sync/<version>` branches, run `npm run build:prod` plus `npm run dist:linux`, and publish nothing after a conflict or failed check.

## Milestone 1 entry criteria

Proceed with Milestone 1 using these constraints:

1. Start with tests for provider normalization, syntax-tree prose segmentation, UTF-16 offset mapping, cancellation, and stale-generation rejection.
2. Build the host transport and provider-neutral contract before editor UI.
3. Keep diagnostics console/test-visible only until the extraction and stale-result invariants pass.
4. Use a document-keyed shared session registry and pane-local CodeMirror extensions.
5. Make no provider request while grammar checking is disabled.
6. Do not broaden renderer CSP to make the proof of concept work.

With those amendments, no material architecture conflict blocks implementation.
