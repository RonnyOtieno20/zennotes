# Markdown colours: Android → desktop

Desktop Preview, Edit with Live Preview on, and raw source share Android's
**rendered** Markdown roles. `Settings → Appearance → Markdown colours → Coloured
headings and emphasis` defaults on. Turning it off restores the existing neutral
headings/emphasis; links, code syntax and explicit highlights retain their usual
upstream treatment. The setting is saved in `zen:prefs:v2` and portable TOML as
`[appearance] colorful_markdown = true` (or `false`). Main, floating/standalone
note and Quick Capture windows apply it.

## Role mapping

Read-only references in `~/projects/zennotes-android/app/src/main/java/com/justronny/zennotes/`:
`ui/markdown/ZenMarkdown.kt` (`previewTints`, typography, inline annotator),
`ui/screens/MarkdownHighlight.kt` (raw editor), `ui/theme/Theme.kt`
(`syntaxOf`, `schemeFrom`, syntax overrides), `ui/theme/Palettes.kt`, generated
`ui/theme/DesktopPalettes.kt`, and `ui/markdown/CodeCard.kt` (`CodePalette.of`).

| Android rendered role | Desktop theme token / treatment |
| --- | --- |
| H1: `syntax.accent` | `--z-accent` |
| H2: `syntax.blue` | `--z-blue` |
| H3: `syntax.purple` | `--z-purple` |
| H4: `syntax.green` | `--z-green` |
| H5: `syntax.aqua` | `--z-aqua` |
| H6: `syntax.yellow` | `--z-yellow` |
| Bold: `syntax.red` | `--z-red` |
| Italic: `syntax.aqua` | `--z-aqua` |
| Links / wikilinks: `scheme.primary` | `--z-accent` |
| Tags: `onTertiaryContainer` on `tertiaryContainer` | `--z-fg` on 24% `--z-purple` mixed with `--z-bg` |
| Blockquote: `syntax.green`, italic | `--z-green`; green background at 10% dark / 7% light |
| Quote stripe: inherited `scheme.onSurface` | `--z-fg` |
| List / ordered marker: body `scheme.onSurface` | `--z-fg` |
| Checked task: `scheme.primary` | `--z-accent` (existing Preview and live checkbox styles); raw task syntax uses accent |
| Inline code: `scheme.onSurface` on `surfaceContainerHighest` | `--z-fg` on 13% foreground mixed with `--z-bg`, a neutral chip |
| Strikethrough: inherited text with strike decoration | Inherited foreground and line-through; completed-task styling remains separately configurable |
| Horizontal rule: `scheme.outlineVariant` | 16% `--z-fg` over the note surface |
| Table header: `syntax.blue` | `--z-blue`; 12% blue over the 9% foreground surface |
| `==highlight==` | Android has no special role for this desktop extension; inherited text on 34% `--z-yellow` |
| Body: `scheme.onSurface` | Existing `--z-fg` (off-white in Catppuccin Mocha) |

Fenced code keeps the language palette from round 1, matching `CodeCard.kt`:
keywords → accent, strings → green, comments/punctuation → muted, numbers and
attributes → yellow, types → purple, functions/builtins → blue, variables/tags →
red, properties/plain code → foreground.

Android's raw editor currently uses a simpler primary/secondary/tertiary palette.
Desktop deliberately shares Android's **Preview** roles across all three desktop
modes, as requested, while retaining source punctuation and grammar underlines.

All added colour rules resolve from existing `--z-*` tokens, including user syntax
colour tweaks. The `--z-md-*` aliases bound OKLCH lightness (light ≤ 0.47, dark
≥ 0.78) while retaining the token's hue; light-mode chroma scales with lightness
to keep saturated orange accents within gamut. Table-header text has a separate
blue alias (light ≤ 0.43, dark ≥ 0.83) for its tinted surface. This addresses weak
contrast in palettes such as Apple light and Tokyo Night day without changing
the theme's global palette. Arbitrary user-authored palettes/overrides can still
choose unsuitable note backgrounds; the recorded contrast guarantee covers the
34 built-in variants.

## Verification and screenshots

Run from this worktree:

```sh
node scripts/downstream/verify-markdown-colors.mjs
```

The harness launches **Electron via `electron-vite dev`**, creates temporary
profile/config/vault directories, opens `sample-note.md` through the real sidebar,
and imports the exact Vite store URL already loaded by that window. It verifies
that this store owns the visible note. It drives the actual Appearance toggle,
checks local persistence, portable config, mode parity (including nested quote
emphasis), and computed contrast on the actual composited backgrounds across all
34 built-in variants. Its process group is terminated in `finally`.

Screenshots at 1440 × 1400 CSS pixels:

- [Dark Preview](dark-preview.png), Catppuccin Mocha.
- [Light Preview](light-preview.png), Catppuccin Latte.
- [Dark Edit / Live Preview](dark-live-preview.png).
- [Light Edit / Live Preview](light-live-preview.png).
- [Light Preview, colours off](light-preview-monochrome.png).

Visual review: all five screenshots were inspected. H1 is peach/orange, H2 blue,
H3 purple, and bold pink/red in both enabled modes; inline code is a neutral
grey chip. The disabled screenshot has neutral headings/emphasis. The sample
fits without clipped note content. The existing compact Edit table and wider
Preview table remain intentional; table layout is outside this change.

The sample includes H1–H6, bold, italic, nested emphasis, external and wiki links,
a tag, blockquote, unordered/ordered lists, a task, inline code, SQL fence,
strikethrough, highlight, horizontal rule and table. Table changes are CSS and
source decoration only; table rendering code was not modified.

See [electron-evidence.json](electron-evidence.json) for renderer identity,
mode parity and per-theme measured contrast. Screenshots must also be visually
inspected; computed styles alone do not prove the rendered appearance.

Checks run successfully:

- `npm run typecheck`: all 8 workspace tasks passed (3 cached).
- App-core focused suites: 340 tests across 10 files passed: source Markdown,
  Markdown language/syntax, WYSIWYG blocks/composition, highlight, rendered
  Markdown, portable defaults, store persistence, and floating-window close.
- Desktop `src/main/app-config.test.ts`: 20 tests passed, including the new
  default and false TOML round-trip assertions.
- Electron harness: Preview/Live Preview/source H1–H6 and emphasis/quote/header
  parity; real Appearance toggle and persistence; disabled-state checks in all
  three modes; 34 built-in variants. Minimum measured coloured-role contrast:
  **4.70:1** (Catppuccin Frappé table header), using composited backgrounds.
- `node --check scripts/downstream/verify-markdown-colors.mjs` and
  `git diff --check` passed.

The production packaging build was not run; the real Electron development main,
preload and renderer build and runtime were exercised. Custom user-authored
palettes were not covered by the built-in contrast sweep.

## Try the dev build manually with disposable data

From the worktree root (this never selects the real vault):

```sh
trial=$(mktemp -d /tmp/zennotes-colours-manual-XXXXXX)
mkdir -p "$trial/profile" "$trial/config" "$trial/vault/inbox"
cp docs/downstream/markdown-colors/sample-note.md "$trial/vault/inbox/Android Colour Comparison.md"
node - "$trial" <<'JS'
const fs = require('node:fs');
const path = require('node:path');
const trial = process.argv[2];
fs.writeFileSync(path.join(trial, 'profile/zennotes.config.json'), JSON.stringify({
  workspaceMode: 'local', vaultRoot: path.join(trial, 'vault'),
  remoteWorkspace: null, remoteWorkspaceProfileId: null,
  remoteWorkspaceProfiles: [], quickCaptureHotkey: ''
}));
JS
env -u ELECTRON_RUN_AS_NODE ZENNOTES_USER_DATA_PATH="$trial/profile" \
  ZENNOTES_CONFIG_DIR="$trial/config" npm run dev:desktop
```

Open **Inbox → Android Colour Comparison**. Compare Preview and Edit with Live
Preview enabled. Pick light/dark variants under **Settings → Appearance**, and
switch **Coloured headings and emphasis** off/on in the same tab. Quit Electron
and stop the dev command with Ctrl+C when finished.
