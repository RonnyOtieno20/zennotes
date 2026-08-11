# Grammar assistant — Milestone 2

Milestone 2 connects the Markdown-aware LanguageTool pipeline from Milestone 1 to each CodeMirror editor pane. Grammar checking remains an explicit, local opt-in and is off by default.

## User workflow

1. Install and start the local LanguageTool HTTP server:

   ```bash
   ./scripts/grammar/install-languagetool.sh
   ```

   ZenNotes does not bundle or start LanguageTool itself. The installer downloads
   the official standalone release, installs a user-level systemd service, and
   starts it at `http://127.0.0.1:8081/v2`.

2. Verify the API is available:

   ```bash
   curl --fail http://127.0.0.1:8081/v2/languages
   ```

   The API base path is not a web application. Use `/v2/languages` or
   `/v2/check` to verify it rather than opening `/v2` by itself.

3. Open a Markdown note in the desktop application.
4. Select the checkmark button in the note toolbar to enable grammar checking.
5. Hover or click a wavy underline to open its correction card, or place the cursor in an issue and press `Alt-Enter`.
6. Select a replacement to apply it and advance to the next issue, or select **Ignore once**.

While the card is open, `j`/`k` and the arrow keys move through its actions, `Enter` activates the current action, and `Esc` closes it. These keys are not claimed while the card is closed, so normal CodeMirror and Vim behavior is preserved.

## Implementation

- `grammar/document-sessions.ts` owns one reference-counted session per vault/note key. Split panes subscribe to the same diagnostics and deduplicate identical provider requests.
- `grammar/editor-runtime.ts` connects the shared session to a pane, extracts updated prose after editor transactions, and confines the default provider to the host-mediated localhost transport.
- `grammar/editor-extension.ts` owns pane-local CodeMirror decorations, the hover/keyboard correction card, edit mapping, ignore-once, and normal replacement transactions.
- `EditorPane.tsx` installs the feature through a compartment and releases the note session on disable, note switch, or pane teardown.
- `store.ts` persists only the local opt-in flag. It is deliberately excluded from portable/vault configuration.

## Safety properties

A replacement is dispatched only when all of these still match:

- vault and note identity;
- accepted generation and whole-document fingerprint;
- segment identity and fingerprint;
- source range and original text;
- diagnostic identity and selected replacement.

The replacement is a single ordinary CodeMirror transaction. It therefore participates in normal undo/redo, the existing note persistence listener, and peer-pane synchronization. An edit overlapping an issue drops that issue immediately; other edits map untouched ranges until the debounced check returns.

Disabling grammar checking releases the pane lease. Releasing the final pane cancels active work and disposes the note session, so late results cannot decorate a different note.

## Current boundaries

- Desktop only. The web bridge advertises no grammar-provider transport and the toolbar control is disabled there.
- English (`en-US`) is fixed for this milestone.
- Automatic checks are disabled for notes larger than 120,000 characters.
- Provider health/status UI, configurable endpoint/language, dictionaries, and ignored rules remain Milestone 4 work.
- The full categorized review sidebar is delivered in
  [Milestone 3](./grammar-assistant-milestone-3.md).

## Verification

Focused coverage includes shared split-pane requests, note-session teardown, late note responses, initial and edited prose checks, exact diagnostic decoration ranges, overlapping-edit invalidation, full-document stale-apply rejection, correction-card actions, ignore-once, apply-and-next, scoped Vim-friendly keys, and undo/redo.

The bridge/provider contract and editor path are covered with deterministic integration tests. A local installation can be checked end to end with:

```bash
curl --fail \
  --data-urlencode 'language=en-US' \
  --data-urlencode 'text=This are an eror.' \
  http://127.0.0.1:8081/v2/check
```

### Service management

The installer creates the user service `zennotes-languagetool.service`. ZenNotes starts
it on demand when grammar checking first needs the managed local endpoint, stops it
immediately when grammar is disabled, and stops it after five minutes without a check.
The service is deliberately not enabled at login.

For manual diagnostics, use:

```bash
systemctl --user status zennotes-languagetool.service
systemctl --user restart zennotes-languagetool.service
journalctl --user -u zennotes-languagetool.service
```

The standalone local server uses LanguageTool's offline rules. LanguageTool's
cloud-only AI rules are not included.
