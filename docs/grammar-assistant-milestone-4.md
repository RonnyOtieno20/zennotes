# Grammar assistant — Milestone 4

Milestone 4 makes the spelling and grammar assistant configurable and safe to
leave enabled during normal desktop editing. The feature remains local-first and
off by default, but can now use a deliberately configured HTTPS LanguageTool
endpoint with an explicit privacy warning.

## Settings

Open **Settings → Grammar** to configure:

- the master device-local opt-in;
- the LanguageTool endpoint and a fixed-text connection test;
- language or dialect, including `auto` and custom LanguageTool language tags;
- automatic checking and the 250–5000 ms provider debounce;
- spelling, grammar, punctuation, style, and other diagnostic categories;
- headings, lists/tasks, blockquotes/callouts, tables, and link labels;
- ignored LanguageTool rule IDs and a local custom dictionary;
- inline underlines and privacy-safe diagnostic logging.

Preferences are normalized before persistence. Invalid types fall back safely,
debounce values are bounded, rule IDs are validated, duplicate list entries are
removed, and list sizes are capped. Grammar preferences remain local preferences
and are not included in portable vault configuration.

The editor toolbar also exposes a master checkmark toggle. The adjacent review
button opens the Milestone 3 issue list.

## Provider status and privacy

Endpoint handling follows these rules:

- `http://localhost`, `http://127.0.0.0/8`, and `http://[::1]` are labelled
  **Local** and may use plain HTTP;
- remote endpoints must use HTTPS and are labelled
  **Remote — note text is sent to this service**;
- credentials, query parameters, non-loopback remote HTTP, and other protocols
  are rejected before a request is sent.

The connection test sends only the fixed sentence
`ZenNotes grammar connection test.`. It never reads the current note. Provider
requests remain confined to the desktop main process, reject redirects, enforce
request/response size limits and timeouts, and support cancellation by a
renderer-owned request ID.

Diagnostic logging is off by default. When enabled, it records only status,
generation, issue count, category counts, and whether an error exists. Note text
and note paths are excluded.

## Personalization

**Ignore rule** is available from both inline suggestion cards and review cards.
It persists the LanguageTool rule ID and immediately rebuilds the provider
configuration. **Add word** stores the exact selected word or phrase in the
local custom dictionary. Dictionary matching is case-insensitive and is applied
locally after provider normalization; dictionary contents are not sent as
provider configuration.

Changing the language, endpoint, visible categories, ignored rules, or custom
dictionary invalidates the bounded segment cache. Display-only changes such as
hiding underlines do not discard valid provider results.

## Performance and large notes

Normal edits continue to extract Markdown prose locally, debounce provider work,
cancel superseded requests, reuse unchanged segment results, and send only
changed segments in bounded batches. Split panes share one session and do not
duplicate provider requests.

ZenNotes never accepts a partial CodeMirror syntax tree as a complete grammar
result. Automatic parsing gets an 8 ms bounded completion attempt; if the full
tree is not ready, checking pauses instead of showing a false clean result. A
manual **Recheck** gets a bounded 50 ms completion attempt. Notes above 120,000
characters remain paused to protect editor responsiveness.

A local Node 22 profile on the development machine measured the following
synthetic Markdown fixture results (machine-specific, not enforced as flaky
timing assertions):

| Fixture | Result |
| --- | --- |
| 20,000 characters | complete parse in 8.71 ms; extraction in 4.29 ms |
| 50,000 characters | automatic parse paused at the 8 ms budget |
| 118,000 characters | automatic parse paused; manual parse completed in 28.82 ms and extraction in 26.15 ms |

The 118,000-character fixture produced 1,390 independent prose segments after
the completed tree was used. This profiling exposed and fixed a stale-tree edge
case where a completed parse was not previously reused for extraction.

## Markdown safety

Code blocks, inline code, frontmatter, URLs and link destinations, math, diagram
blocks, HTML attributes, and hidden wiki-link targets remain excluded regardless
of provider configuration. Optional region controls only broaden or narrow the
already-safe prose candidates. A mixed acceptance fixture covers headings,
paragraphs, blockquotes, lists, tasks, tables, links, code, frontmatter, math,
diagrams, and Unicode source mapping in one document.

## Verification boundary

Milestone 4 tests cover preference normalization and persistence, endpoint
classification, fixed-text health probes, provider category/rule/dictionary
filtering, Markdown-region configuration, completed-tree extraction, large-note
pausing, optional underlines, personalization actions, settings search and
privacy disclosure, session reuse, stale-result rejection, cancellation,
replacement safety, and review-panel behavior.

The remaining project work is Milestone 5: downstream identity and updater
policy, reproducible Ubuntu packaging, automated upstream synchronization, and
safe conflict reporting.
