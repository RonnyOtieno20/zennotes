# Android Edit-mode highlighting port

Implemented on `feature/editor-syntax-highlight`, based on `grammar-main`
at `f994ca6c`. Android source was inspected read-only.

## Comparison and changes

Desktop already parsed Markdown headings, emphasis, quotes, links and lists,
and eagerly parsed many common code-fence languages. The gaps were:

- Source-mode headings used the body colour; list/quote markers lacked
  Android's muted, bold treatment. Quotes italicized their entire contents.
- Tags and completed-task treatment depended on Live Preview; raw frontmatter
  stayed undimmed. Inline code lacked Android's secondary colour, and links
  used the primary colour rather than the tertiary colour.
- Heading rules suppressed explicit italics inside headings. Bold and italics
  in ordinary paragraphs already worked and remain handled by CodeMirror.
- Shell, Kotlin, C#, Swift, Scala, Groovy and other Android fence aliases
  depended on lazy loaders or were absent. Plain `text` fences could fuzzy-match
  LaTeX. YAML's LR parser left bare numeric/boolean values uncoloured.
- Secondary editors had incomplete copies of the main HighlightStyle.

The new source-mode ViewPlugin decorates Lezer nodes in visible ranges, keeping
all source text and offsets intact. A small hashtag scan also stays within
visible ranges. It skips code/frontmatter/link contexts. It yields to Live
Preview when that plugin is installed, including compartment changes.
Desktop heading sizes, folding and Live Preview/table rendering are retained.

All editors now share one HighlightStyle. Added stream parsers use the existing
locked `@codemirror/legacy-modes` 6.5.2 as a direct dependency, without upgrading
it or adding another transitive dependency. Existing eager LR parsers remain
in use for their respective languages. StreamLanguage supplies incremental
parsing for the additional languages. Unknown-language lazy fallback remains.
Fish/console use shell tokenization; Vue/Svelte use HTML-level tokenization,
matching Android's broad language families. CodeMirror grammar semantics
apply rather than reproducing Android's regex edge cases byte for byte.

| Role | Theme variable |
| --- | --- |
| Heading / keyword / boolean / null | `--z-accent` |
| Link / wikilink / hashtag / type | `--z-purple` |
| Inline code / function / builtin | `--z-blue` |
| String | `--z-green` |
| Number / attribute / annotation | `--z-yellow` |
| Shell variable / markup tag | `--z-red` |
| Comment / punctuation | `--z-fg-2` |
| List/quote marker / frontmatter / completed task | `--z-grey-0` |

Syntax colours add no opaque backgrounds or underlines. Inline code keeps its
existing background; completed source tasks add strikethrough. Grammar waves,
selected-issue backgrounds and search matches continue to overlap these marks.

## Changed files

- `packages/app-core/src/lib/cm-markdown-source-highlight.ts` and its test:
  source-mode Markdown roles, exclusions, updates and viewport coverage.
- `packages/app-core/src/lib/cm-syntax-highlight.ts` and its test: shared
  HighlightStyle, fence-language roles, aliases and decoration overlap tests.
- `packages/app-core/src/lib/cm-code-languages.ts`: eager language registry.
- `packages/app-core/src/styles/index.css`: theme-token colour roles and
  source-mode Markdown styles, including nested emphasis.
- `packages/app-core/src/components/{EditorPane,FloatingNoteApp,ExternalFileApp,
  PinnedReferencePane,QuickCaptureApp,TemplateEditorModal}.tsx`: shared wiring.
- `packages/shared-domain/src/custom-code-languages.ts`: reserve built-in aliases
  so custom languages cannot shadow them.
- `packages/app-core/package.json`, `package-lock.json`: direct legacy-modes
  dependency declaration.
- This report.

## Validation

- `npm run test:run --workspace @zennotes/app-core`: **293 files passed,
  1 skipped; 3,464 tests passed, 1 skipped**. The new suites contain 91 tests.
- `npm run test:run --workspace @zennotes/shared-domain`: **69 files passed;
  1,994 tests passed**.
- `npm run typecheck -- --force`: **8/8 tasks successful, 0 cached**:
  all four shared packages and desktop, web, quicklook and share-viewer.
- `npm run build --workspace @zennotes/desktop`: main, preload and renderer
  build passed; `verify-packaged-cli` passed.
- Playwright rendered actual editor modules and application CSS with synthetic
  text at 1200 × 1100. Light and dark screenshots were inspected. Computed
  palette checks passed in all **34 built-in variants**. Grammar waves, selected
  diagnostics and search matches were checked together. No horizontal overflow.
- A 440,026-character fixture scrolled from the start to its final heading/tag;
  source marks updated there and remained bounded to the viewport.

The collaborative preview timed out twice; Playwright was used instead.
This did not include visual inspection of a running Electron window, every
secondary editor window, an Android device, or user-authored custom themes.
No real notes were opened. No system installation, updater, push or merge ran.

### Large-note measurement

A synthetic 847,000-character / 60,501-line note repeated Markdown prose, tasks
and Python fences. Browser measurements timed synchronous `EditorView.dispatch`
with one animation frame between insert/delete operations. Parsing was completed
before timing; warm-up samples were discarded. This isolates editor work, not
the full app's grammar-provider/network latency or end-to-end input-to-paint.

An initial three-run baseline/candidate comparison gave warmed median times
of 13.5–14.0 / 12.8–13.3 ms, respectively. A follow-up alternating prose/fence
typing check produced these per-run ranges:

| Check | Baseline median / p95 (ms) | Candidate median / p95 (ms) |
| --- | --- | --- |
| Prose, original parser/highlighter vs port | 13.7–13.8 / 14.8–15.3 | 12.8–14.6 / 16.0–23.5 |
| Fence, original parser/highlighter vs port | 13.8–14.1 / 15.9–16.1 | 13.0–14.6 / 15.1–18.6 |
| Same parsed view, source plugin toggled off/on | 12.2–14.2 / 16.2–16.6 | 10.2–11.4 / 15.2–19.3 |

Median typing cost stayed comparable. Tail timings varied, including a slower
candidate prose run; these samples do not establish a speed improvement or a
universal latency guarantee. New marks traversed only the visible slice (46
rendered source marks in the initial large-note viewport), with no whole-note
regex pass, forced synchronous parse, document replacement or grammar rebuild.

## Try it with disposable data

From this worktree:

```sh
cd ~/projects/grammar-checker/worktrees/editor-syntax-highlight
syntax_trial=$(mktemp -d /tmp/zennotes-syntax.XXXXXX)
mkdir "$syntax_trial/vault"
printf 'Use this throwaway vault: %s\n' "$syntax_trial/vault"
ZENNOTES_USER_DATA_PATH="$syntax_trial/profile" npm run dev
```

Choose the printed vault in onboarding, create a throwaway note, and turn
**Live Preview off** to inspect raw Markdown. Try headings, `**bold**`,
`*italic*`, `> quotes`, lists, `- [x] done`, inline code, links, `#tags`,
frontmatter and fences tagged `python`, `bash`, `kotlin`, `sql` or `yaml`.
Switch between light and dark theme variants. Live Preview retains its existing
rendering when re-enabled. Electron dependencies are prepared locally in this
worktree; nothing was installed system-wide.
