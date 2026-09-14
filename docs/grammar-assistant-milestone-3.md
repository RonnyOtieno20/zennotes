# Grammar assistant — Milestone 3

Milestone 3 adds a full-note proofreading workflow on top of the inline spelling
and grammar diagnostics from Milestone 2. The review panel is native to each
editor pane and uses the same document session, so inline marks, the correction
card, and the issue list cannot disagree about the accepted provider response.

## User workflow

1. Start the local LanguageTool service documented in
   [Milestone 2](./grammar-assistant-milestone-2.md).
2. Open a Markdown note in the desktop application.
3. Use the checkmark toolbar button to enable local grammar checking.
4. Select the list toolbar button, run **Toggle Grammar Review** from the command
   palette, or press `Ctrl+Shift+G` on Linux/Windows (`Cmd+Shift+G` on macOS).
5. Review all issues or filter the list by spelling, grammar, punctuation, style,
   or other rules.
6. Select a replacement to apply it and advance to the next issue. **Ignore once**
   also advances without changing the note.

Selecting a card highlights and centers its exact source range in CodeMirror.
The previous/next controls wrap through the currently filtered category, and
**Recheck** requests a fresh full-note result immediately.

## Keyboard review

The entire panel is usable without a mouse.

- `Up`/`Down` move between issues; `Home`/`End` jump to the first/last issue
  when Vim mode is off.
- `Enter` applies the first replacement, or ignores the issue when no replacement
  is available.
- `Esc` or `Left` returns focus to the editor.
- In Vim mode, `j`/`k`, `gg`/`G`, `l`/`Enter`, and `h`/`Esc` provide the same flow.
- Existing pane navigation includes the grammar panel in its left-to-right focus
  order.

The shortcut is part of the normal configurable keymap and the command palette;
the implementation does not reserve ordinary editor keys while the editor owns
focus.

## States and recovery

The panel explicitly distinguishes:

- grammar checking off, with an enable action;
- unsupported runtime (the web application has no host-confined provider bridge);
- connecting or waiting for prose;
- checking, while retaining the last accepted results;
- ready with no issues;
- automatic checking paused for a large note;
- provider failure, including the error text and a retry action;
- a category filter with no matching issues.

The header labels the current fixed provider as **Local**. Milestone 4 adds
endpoint configuration and an explicit remote-provider privacy disclosure.

## Implementation

- `components/GrammarReviewPanel.tsx` renders categorized cards, filters, counts,
  navigation, recovery actions, and the resizable persisted panel width.
- `components/EditorPane.tsx` owns the pane-local panel lifecycle and maps panel
  selection, replacement, ignore, and recheck actions onto the existing grammar
  editor binding.
- `grammar/editor-runtime.ts` exposes the shared note session plus an immediate
  full-note check without creating a second provider path.
- `lib/panel-rows.ts`, `lib/vim-nav.ts`, and `components/VimNav.tsx` integrate the
  panel with both standard and Vim keyboard navigation.
- `lib/keymaps.ts`, `lib/commands.ts`, and `App.tsx` provide the configurable
  shortcut and command-palette entry.
- `store.ts` persists only the panel width and local grammar opt-in. The current
  card cursor remains ephemeral.

## Safety properties

Panel replacements use the same `applyGrammarReplacementAndNext` transaction as
the inline card. Before dispatch, the shared session still validates note
identity, accepted generation, whole-document fingerprint, segment fingerprint,
source range, original text, and diagnostic identity. The normal CodeMirror
transaction remains undoable and participates in existing save and split-pane
synchronization.

The panel never sends text itself. Manual recheck reuses Markdown prose
extraction, excluded-region handling, host-confined localhost transport,
cancellation, accepted-result gating, and the 120,000-character automatic-check
limit from Milestones 1 and 2.

## Verification

Focused tests cover category counts and filters, card rendering, one-click apply,
disabled/error recovery, immediate recheck, panel row activation, persisted panel
width, focus order, and the existing editor/session safety suite. Production
verification should also include the full workspace test suites, typechecks, a
production build, and a live `/v2/check` request against the local service.

## Next milestone

The settings, personalization, privacy, and hardening boundary is delivered in
[Milestone 4](./grammar-assistant-milestone-4.md). Milestone 5 covers maintained
downstream packaging and upstream synchronization.
