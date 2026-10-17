# LanguageTool grammar UI

Desktop Harper is the reference: `9d39e495` (popup and editor bindings),
`f0d2fd5b` (dictionary persistence), and `803ae295` (settings capability handling).
The baseline is `grammar-main` at `f994ca6c`. No Android UI was used.

## Implementation

Both checkers use the extracted native Harper popup rows, message rendering,
numbered suggestions, active-row styling, mouse handling, and capture-phase keys
in `lib/grammar-popup.ts`. The native settings switch is extracted into
`components/SettingsSwitch.tsx` and used by Harper's existing settings rows and
LanguageTool. LanguageTool's sidebar remains its own panel, with category counts,
numbered replacements, context, dictionary and ignore actions. New styles live in
`grammar/ui.css`; `styles/index.css` is unchanged.

There is one Vim action registration, retaining existing keymap IDs and user
overrides. `]s` / `[s` traverse a sorted union of both engines' issue positions,
wrap at either end, and collapse identical positions into one stop. `z=` opens
the issue under the caret. LanguageTool wins an overlap (the tightest LT range
wins within that engine); otherwise Harper retains its native cursor/line
fallback. `zg` and `zG` act only on the selected engine's dictionary/ignore store.
No cross-engine dictionary or ignore synchronization is introduced. Both engines
can still run independently. Existing F8/Shift+F8, popup shortcuts, and Harper
commands remain; shared Grammar commands are also available in the palette.

While a popup is open, 1–9 apply only replacements, Escape closes it, and
j/k, arrows, Ctrl+n/p and Enter navigate/apply. Secondary actions never receive a
number. In the focused grammar sidebar, 1–9 apply a replacement from its current
card in both Vim and regular mode. Settings options, defaults and persistence
are retained; explicit keyboard popup access also works when automatic cards
are disabled in favor of the sidebar.

## Real Electron screenshots

All captures use `zztest-grammar-ui.md`, an isolated temporary vault/profile,
and a loopback mock LanguageTool server with spelling, grammar and style issues.
Harper comparison captures use the real offline Harper engine. Captures are
1280×900 in the app's dark-hard and light-hard themes. The six before captures
were retained from the cancelled attempt at the unchanged baseline; the eight
after captures were regenerated and visually inspected for this implementation.

| Surface | Before dark | After dark | Before light | After light |
| --- | --- | --- | --- | --- |
| Popup | [before](before/dark-popup.png) | [after](after/dark-popup.png) | [before](before/light-popup.png) | [after](after/light-popup.png) |
| Sidebar | [before](before/dark-sidebar.png) | [after](after/dark-sidebar.png) | [before](before/light-sidebar.png) | [after](after/light-sidebar.png) |
| Settings | [before](before/dark-settings.png) | [after](after/dark-settings.png) | [before](before/light-settings.png) | [after](after/light-settings.png) |

Native Harper popup: [dark](after/dark-harper-popup.png),
[light](after/light-harper-popup.png). Its real first finding concerns heading
capitalization; LanguageTool's mocked first finding concerns spelling.

Reproduce after captures on a graphical desktop:

```sh
npm run build --workspace @zennotes/desktop
node tooling/scripts/grammar-ui-smoke.mjs after
```

The script follows the repository's Electron CDP smoke-test workflow, launches
only its own app process with `ZENNOTES_USER_DATA_PATH` and
`ZENNOTES_CONFIG_DIR` in `/tmp/zennotes-grammar-ui.*`, and removes its temporary
profile/vault afterward. It does not contact the user's LanguageTool server.
For baseline captures, run the script with `before` against the baseline build.

## Verification

- `npm run typecheck`: passed, all 8 tasks.
- `npm run build --workspace @zennotes/desktop`: passed, including CLI verification.
- Focused suite: 20 files, 217 tests passed. Coverage includes all numbered
  replacements, mouse actions, dictionary/ignore ownership, shared Vim motions,
  overlap priority, independent/disabled engines, settings switches, and sidebar
  quick apply, plus existing grammar/runtime/provider tests.
- Electron capture script: passed for both themes, popup/sidebar/settings and
  real Harper popup; resulting images visually inspected.
- `git diff --check`: passed.

The existing Vitest config requires runner loading and a config-directory
`__dirname` in this environment. The focused command was:

```sh
node --input-type=module -e 'import path from "node:path"; globalThis.__dirname=path.resolve("packages/app-core"); const {startVitest}=await import("vitest/node"); const ctx=await startVitest("test", ["src/grammar/", "src/lib/grammar-actions.test.ts", "src/lib/keymaps.test.ts", "src/lib/panel-rows.test.ts", "src/lib/harper-runtime.test.ts", "src/components/Grammar"], {root:"packages/app-core", watch:false, cache:false}, {configLoader:"runner"}); await ctx.close()'
```

Not verified: a live LanguageTool service, other operating systems, the entire
monorepo test suite, or interactions with the unmerged live-tables and syntax
highlight branches. No user notes/settings were used and nothing was pushed.

## Changed-file map

Paths below are relative to `packages/app-core/src/`:

- Shared UI/routing: `lib/grammar-popup.ts`, `lib/grammar-actions.ts`,
  `lib/cm-harper.ts`, `lib/keymaps.ts`, `lib/commands.ts`,
  `components/SettingsSwitch.tsx`, `components/Editor.tsx`.
- LanguageTool: `grammar/editor-suggestion-card.ts`, `grammar/editor-commands.ts`,
  `grammar/editor-extension.ts`, `grammar/ui.css`,
  `components/GrammarReviewPanel.tsx`, `components/GrammarSettings.tsx`.
- Settings/panel integration: `components/SettingsModal.tsx`,
  `components/VimNav.tsx`, `App.tsx`, `lib/panel-rows.ts`.
- Tests: `lib/grammar-actions.test.ts`, `lib/panel-rows.test.ts`,
  `grammar/editor-extension.test.ts`, `components/GrammarSettings.test.ts`,
  `components/GrammarReviewPanel.test.ts`.

Also changed: `tooling/scripts/grammar-ui-smoke.mjs` and this documentation's
README plus 14 PNG screenshots.
