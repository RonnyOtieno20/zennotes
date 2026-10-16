# Selection-aware live tables

The Edit editor now uses `cm-live-tables.ts`. A table is a read-only block
replacement only while every cursor/selection is outside it. Entering any row
reveals the entire source, including inline, quote, and list markers. All edits
then belong to CodeMirror, its history, composition handling, and grammar layer.
Clicking a rendered cell places the cursor at that cell's source start.

The previous `cm-table.ts` renderer always replaced tables and supplied atomic
ranges. It ran a separate contenteditable cell editor, with custom key handling
and a mutable working copy serialized back on focus changes. Selection changes
alone did not reveal source. This disconnected cell editing from CodeMirror's
selection, native history/composition, and grammar decorations. Its renderer is
no longer installed by EditorPane; existing helper exports remain for table
commands and their tests.

The existing **Render tables in live preview** setting and its default (`true`)
are preserved. Off still keeps source visible. Existing saved preferences are
not migrated. The setting's visible description explains the new behavior.

## Safe browser fixture

From this worktree root, with dependencies available:

```sh
node node_modules/vite/bin/vite.js --config tooling/fixtures/live-tables/vite.config.mjs
```

Open http://127.0.0.1:5186. This fixture uses the real editor extensions, CSS,
Preview renderer, and Apple light/dark theme variables. Its document and grammar
diagnostic are in memory; no vault or desktop bridge is connected. Click cells,
use arrow keys, type and undo, select across tables, switch themes, and scroll
the wide table. Reload to reset all changes.

For the actual desktop app, isolate both configuration and Electron data before
launching from this worktree:

```sh
fixture_root=$(mktemp -d /tmp/zennotes-live-tables.XXXXXX)
ZENNOTES_USER_DATA_PATH="$fixture_root/user-data" \
ZENNOTES_CONFIG_DIR="$fixture_root/config" npm run dev:desktop
```

Create a throwaway vault under that temporary directory. Do not open a real
vault for this check. The desktop launch above was not run during implementation.

## Verification

All four package typechecks passed (exit 0):

```sh
npm run typecheck --workspace @zennotes/app-core
npm run typecheck --workspace @zennotes/bridge-contract
npm run typecheck --workspace @zennotes/shared-domain
npm run typecheck --workspace @zennotes/shared-ui
```

The focused regression command, from the worktree root:

```sh
npm run test:run --workspace @zennotes/app-core -- \
  --config ../../tooling/fixtures/live-tables/vitest.config.ts \
  src/lib/cm-live-tables.test.ts src/lib/cm-wysiwyg-compose.test.ts \
  src/lib/cm-live-preview.test.ts src/lib/cm-live-preview-media.test.ts \
  src/lib/cm-wikilink-render.test.ts src/lib/cm-math-render.test.ts \
  src/lib/cm-callout-fold.test.ts src/lib/markdown.test.ts \
  src/lib/markdown-table.test.ts src/lib/cm-table.test.ts \
  src/lib/cm-table-menu-rebuild.test.ts src/lib/table-to-database.test.ts \
  src/lib/cm-slash-commands.test.ts src/grammar/editor-extension.test.ts \
  src/grammar/prose.test.ts
```

Result: **15 files passed, 365 tests passed**. The first run with the base config
hit Vite's WASM filesystem restriction because this worktree reuses dependencies
through a symlink. The fixture test config explicitly allows the resolved
dependency directory; it changes no production behavior.

Coverage includes parser alignment/escapes/code pipes, incomplete delimiters,
list/quote nesting, selection and secondary cursors, switching, click offsets
after document changes, arrow/shift-arrow entry, undo/redo, composition-tagged
transactions, preference reconfiguration, grammar visibility/stale diagnostics,
and model reuse across 150 tables. Models are cached per current table source;
selection-only updates do not parse or render HTML. Document/parser changes
rescan the syntax tree and reuse unchanged models. No runtime performance
benchmark was performed.

Browser checks at 1280px and 700px verified light/dark rendering, inline Markdown,
nested tables, native cell clicks, down/right-arrow entry, typing/undo, source
underlines, absence of rendered underlines, and horizontal containment/scrolling.
Native Electron, an actual OS IME composition session, Vim integration, and a
large-note runtime benchmark remain unverified. No real notes were opened.
