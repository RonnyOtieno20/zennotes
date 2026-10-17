# Three-feature integration

Base: `grammar-main` at `f994ca6c`. Safety branch:
`backup/grammar-main-before-feature-merge-20261017083517`.
Integration branch/worktree: `merge/three-features` / `worktrees/merge-three-features`.

## Merges and conflict handling

All three merges used `git merge --no-ff`, in the approved order:

1. `feature/live-tables` (`006c53a9`) → merge commit `9da3923d`.
2. `feature/editor-syntax-highlight` (`c6e830b3`) → `1ee6539f`.
3. `feature/grammar-ui-glowup` (`e93eab2d`) → `7c67e87c`.

**No textual conflicts occurred.** Git merged the shared `EditorPane.tsx`,
`SettingsModal.tsx`, `styles/index.css`, and `App.tsx` changes automatically.
No product code was changed during integration. The live-table extension and
selection-aware source editing, Markdown colour rules and Appearance setting,
and shared Harper/LanguageTool popup and Vim routing were all retained.

The colour verification script expected the former `.cm-table-widget` renderer;
it now checks `.cm-live-table th` and uses `zztest-markdown-colors.md`.
Both existing Electron scripts accept `ZENNOTES_SMOKE_OUTPUT_DIR`, so reruns
save integration evidence here without overwriting their branch screenshots.
The new combined harness waits for Electron's reload event and dismisses the
startup release-notes dialog before capturing screenshots.

## Verification

- `npm ci --offline`: passed; local dependencies and existing patch applied.
- `npm run typecheck`: **8/8 workspace tasks passed** (3 cache hits).
- `npm run test:run --workspace @zennotes/desktop`: **74 files passed, 2 skipped;
  1,159 tests passed, 8 skipped**. Skips are the suite's existing defaults.
- `npm run build --workspace @zennotes/desktop`: passed, including the packaged
  CLI check. Rebuilt after development runs because they replace build output.
- Combined app-core feature regressions: **36 files, 752 tests passed**. Includes
  the live-table README's 15 suites plus grammar UI/routing, syntax colours,
  Markdown source roles, and preference persistence. The first invocation had
  runner configuration failures (WASM access and a relative CSS fixture path);
  the passing invocation ran with the package working directory and repository
  filesystem allowlist. No test or application assertion was changed.
- `node scripts/downstream/verify-markdown-colors.mjs`: passed in real Electron
  dev, including Preview/Live Preview/source parity, Appearance toggle and
  persistence, and contrast across **34 built-in theme variants**.
- `node tooling/scripts/grammar-ui-smoke.mjs after`: passed in real Electron production
  output with isolated profiles, a loopback mock LanguageTool server, and the
  real offline Harper engine. See `grammar-ui/` captures.
- `node scripts/downstream/verify-three-feature-merge.mjs`: passed in real
  Electron dev using `zztest-three-features.md`, temporary profile/config/vault,
  and a loopback mock LanguageTool server. In the same note it checked coloured
  headings, a rendered table, three numbered suggestions, `]s` navigation to
  successive issues, number-key replacement, clicking a cell to reveal source,
  and rerendering after the cursor leaves. See `combined-evidence.json`.
- Screenshot inspection: all 16 integration captures inspected, including
  unobscured combined-feature captures in dark/light themes and source editing.
- `node --check` for the three Electron scripts and `git diff --check`: passed.

Reproduce captures from the repository root:

```sh
ZENNOTES_SMOKE_OUTPUT_DIR="$PWD/docs/downstream/merge-three-features/markdown-colors" \
  node scripts/downstream/verify-markdown-colors.mjs
node scripts/downstream/verify-three-feature-merge.mjs
npm run build --workspace @zennotes/desktop
ZENNOTES_SMOKE_OUTPUT_DIR="$PWD/docs/downstream/merge-three-features/grammar-ui" \
  node tooling/scripts/grammar-ui-smoke.mjs after
```

The combined harness invokes the desktop `npm run dev` script and supplies
`ZENNOTES_USER_DATA_PATH` and `ZENNOTES_CONFIG_DIR` under `/tmp/zennotes-merge.*`.
The workspace form forwards the Electron debugging option without the root
npm aliases consuming it. No real notes, settings, or LanguageTool service
were used. Nothing was pushed, and feature branches/worktrees were retained.

## Screenshots

- [Dark: table, coloured heading, numbered grammar popup](dark-table-heading-grammar-popup.png)
- [Light: table, coloured heading, numbered grammar popup](light-table-heading-grammar-popup.png)
- [Light: native table-source editing](light-table-source.png)
- `markdown-colors/`: five mode/theme screenshots and `electron-evidence.json`.
- `grammar-ui/`: dark/light LanguageTool popup, sidebar, settings, and Harper popup.

## Scope limits

A full code review, the complete app-core/monorepo test suite, live LanguageTool,
other operating systems, real IME input, performance benchmarking, custom theme
palettes, and installer/release packaging were not verified. Desktop build
warnings about the browser-externalized Harper `fs` import were nonfatal.
