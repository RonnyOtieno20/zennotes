# Grammar Assistant Milestone 1

Date: 2026-08-01
Upstream baseline: `87f60a5` (`main`, ZenNotes `2.20.2`)

## Outcome

Milestone 1 is a test-visible grammar-engine proof of concept. It does not register editor decorations, settings, commands, or review UI.

The implemented pipeline is:

```text
CodeMirror Markdown state
  -> Lezer-based prose segments with UTF-16 source maps
  -> debounced/cancellable document coordinator
  -> provider-neutral LanguageTool adapter
  -> host-mediated desktop HTTP transport
  -> normalized diagnostics with exact CodeMirror ranges
```

The proof test starts with Markdown containing the intentional errors `This 😀 are an eror.`, inline code, and a Mermaid block. Only the visible sentence reaches the provider. The normalized grammar and spelling diagnostics map back to the exact `are` and `eror` source ranges despite the preceding astral character.

## Implemented boundaries

### Provider and diagnostics

`packages/app-core/src/grammar/types.ts`, `provider.ts`, and `providers/languagetool.ts` define:

- provider-neutral diagnostics, replacements, categories, severity, generations, and segment identities;
- deterministic diagnostic IDs independent of document position and check generation;
- a cancellable provider contract that accepts prose segments rather than raw Markdown;
- defensive LanguageTool response validation and normalization;
- explicit JavaScript/LanguageTool UTF-16 handling.

Positive provider ranges are accepted only when every mapped source code unit is contiguous. A diagnostic spanning stripped Markdown is discarded rather than allowed to delete hidden syntax. Zero-length insertions require an explicit safe boundary in the segment's `insertionMap`.

### Markdown prose extraction

`packages/app-core/src/grammar/prose.ts` walks CodeMirror's Lezer Markdown tree and uses focused scanners only for ZenNotes syntax not represented by the base tree.

It checks headings, paragraphs, blockquotes, lists, tasks, table cells, link labels, callout prose, and safe wiki aliases. It excludes front matter, fenced and indented code, inline code, diagram/config blocks, URLs and link destinations, image paths, HTML tags/attributes, script/style/template content, math, table delimiters, wiki targets, and embeds.

Each segment carries:

- a stable content-and-occurrence identity;
- an exact UTF-16 code-unit map to the CodeMirror document;
- conservative safe insertion boundaries;
- a content fingerprint for incremental caching.

Characterization tests cover emoji, astral characters, combining marks, CRLF normalization, stripped Markdown markers, repeated content, stable identities after preceding insertions, and multiple prose blocks.

### Coordinator

`packages/app-core/src/grammar/coordinator.ts` provides one request lifecycle per document/editor state:

- 750 ms default debounce;
- one active request at a time with superseded-request cancellation;
- sequence, document, generation, and provider-configuration stale checks;
- changed-segment checks while preserving unchanged diagnostics;
- exact-text plus content-fingerprint caching;
- safe diagnostic rebasing only when all source and insertion maps shift uniformly;
- bounded sequential batches for large notes;
- disabled, checking, ready, idle, and error states;
- a forced whole-note path for the future manual command.

Late results are rejected even when a mock provider deliberately ignores its abort signal.

### Desktop transport

The typed contract and optional capability live in `packages/bridge-contract`. The desktop preload exposes check/cancel calls; the web runtime reports the capability as unsupported.

`apps/desktop/src/main/grammar/languagetool-transport.ts`:

- accepts HTTP only on loopback and HTTPS for remote endpoints;
- rejects embedded credentials and all endpoint query parameters, redirects, invalid language/rule identifiers, duplicate request IDs, empty or oversized text, and oversized/malformed responses;
- enforces bounded timeouts and request ownership per renderer;
- cancels outstanding work when the renderer is destroyed;
- never logs submitted note text.

The renderer adapter defaults to `http://127.0.0.1:8081/v2`, generates request IDs, and propagates `AbortSignal` cancellation through IPC. No CSP policy was broadened and no dependency was added.

## Verification

Focused Milestone 1 verification includes:

- provider and source-map tests;
- LanguageTool normalization tests;
- prose extraction tests;
- coordinator cancellation/cache/staleness tests;
- renderer-to-host bridge adapter tests;
- desktop transport validation/cancellation/size-limit tests;
- the Markdown-to-normalized-diagnostics proof test.

Repository-wide typecheck, tests, and production build are the completion gate recorded in the implementation handoff.

## Milestone 2 boundary

Milestone 2 may now register a document-keyed session and pane-local CodeMirror extension for underlines and the correction card. It must not bypass the coordinator's accepted-result gate. Applying a replacement must additionally verify the current document key, generation, segment fingerprint, source range, and original text, then use a normal CodeMirror transaction so undo and split-pane synchronization remain intact.
