# Staged uploads for published notes

Lift the 20-attachment limit on published notes by sending attachments ahead of
the publish, instead of inside it.

> **Status (October 9, 2026).** Built the same day for 2.66.0. The service side is
> website `e94851c` (on in production behind `CLOUD_PUBLISH_UPLOADS`, verified
> live with a 30-image note); the apps share `publishWithStagedUploads` in
> shared-domain (desktop `1c05780e`; the phone shells call it through their native
> file hashing and upload). Built as designed below, with 50 attachments and
> 100 MB per note. Not built yet: upload progress in the publish dialog (the
> routine reports it through `onProgress`, nothing shows it), and referencing
> unchanged attachments by hash on republish.

## Why the limit exists

Publishing (`POST /api/v1/shares`, `PUT /api/v1/shares/{share}`) sends one
multipart request: a JSON `payload` (markdown, appearance, `asset_refs`) plus
every attachment as `assets[]` and, when it changes, a `brand_logo`. PHP drops
every file past `max_file_uploads` before Laravel sees the request. Production
runs PHP's default of 20, and Laravel Cloud has no setting for it, so the server
now caps a note at 20 attachments and says so (19 when a new logo rides along).

The one request has other costs too:

- **25 MB per publish.** The whole request is capped, not the note's real needs.
- **Memory.** Desktop reads every attachment as base64 and moves it across IPC
  twice (read, then publish); the phones' CapacitorHttp turns FormData into
  base64 entries. A 40-image note is held in memory several times over.
- **All or nothing.** One slow image holds up the request until it times out
  (300 s), and a retry sends everything again.

## Goal

- A published note can have up to **50 attachments and 100 MB in total**, each
  still within the plan's per-file limit (`publish_max_asset_bytes`, 10 MB on
  the Publish add-on).
- No dependence on PHP's file limit or on one request's size.
- Attachments stream from disk, with progress ("Uploading 12 of 40").
- Capacity, locking and cleanup stay as strict as today.
- Apps already in people's hands keep working, with the 20 limit.

## Plan: stage, then publish

The flow sync already uses for large files (`SyncUploadController`), applied to
published notes.

1. **Start an upload.** `POST /api/v1/shares/uploads` with the note path and one
   entry per attachment: `ref`, file name, mime type, byte length, SHA-256. The
   server checks the count (50), the note's total (100 MB), mime types, per-file
   sizes and publish capacity (as the publish pre-check does today), records a
   session, and answers with one presigned PUT per attachment (Content-Type and
   Content-Length signed, 15 minutes), staged under
   `shares/staging/{user}/{session}/`.
2. **Upload.** The app PUTs each attachment straight to storage, four to six at
   a time, streaming from disk. No PHP, no base64, no file-count limit. A failed
   file is retried alone.
3. **Publish.** The usual `POST`/`PUT /api/v1/shares` with JSON only: the payload
   plus `upload_id`, and no logo. The server checks every staged object (exists,
   size, SHA-256: sync's `verifyUploadedObject`, which reads each object once;
   the 100 MB total keeps that to a second or two), then, under the same account
   lock as today, checks capacity again, moves the objects into `shares/{slug}/`,
   records the assets, and marks the session used. A republish deletes the old
   objects after commit, as it does now.
4. **Clean up.** A scheduled job deletes staged objects of sessions that expired
   or were never used (sync's `PruneExpiredSyncUploads` pattern: every 5 minutes,
   with a grace period).

Attachments the note already has on its current publication could be referenced
by hash instead of uploaded again, so republishing a long note after a typo fix
sends nothing but text. That is a follow-up, not part of the first version.

### Why not literally "batches of 20"

The alternative is the same session with a multipart endpoint that takes up to
20 files per call. It needs no presigned URLs, but every byte still passes
through PHP, desktop and phones still move base64, and each batch keeps the
per-request size cap. Uploading straight to storage removes all three and
reuses code that is already tested in production: presigning, verification and
pruning on the server, the streaming PUT on desktop (including the explicit
Content-Length fix for the 411 problem), and the phones' native `ZenDirectUpload`
plugin. If presigned uploads hit a snag, the batch endpoint is the fallback with
the same session model.

## Work by repo

**Website**

- `publish_upload_sessions` and `publish_upload_assets` tables (sync's upload
  table is tied to vaults, so it is not reused).
- `ShareUploadController` (create, abort) with the shares middleware stack
  (`entitled:publish`, `share:manage`, `throttle:shares`); a service built on
  sync's presign and verify helpers.
- `StoreSharedNoteRequest` accepts `upload_id` instead of files and refuses a
  logo on that path; the controller's record and replace paths take staged
  objects.
- Two server settings: attachments per note (50) and total per note (100 MB),
  next to the existing per-file limit from the plan.
- The multipart path stays for older apps, with the 20 limit and its logo
  support. The account API advertises the new path and both limits, so apps
  know which path to use and what to check before uploading.
- Prune job and schedule; behind a flag (`CLOUD_PUBLISH_UPLOADS`) until the apps
  ship.

**Desktop and shared code** (`zennotes`)

- `shared-domain/src/cloud-sync-api.ts`: start-upload and publish-with-upload
  calls next to the current ones.
- `app-core/src/lib/cloud-publishing.ts`: collect attachment paths, sizes and
  hashes instead of base64; check the server's advertised limits; progress in
  the publish dialog. Remove `prepareCloudPublishLogo`, which nothing calls.
- Desktop main: stream attachments with the existing direct-upload client.

**Phones** (`zennotesios`, `zennotesandroid`)

- Upload staged attachments with `ZenDirectUpload`, as sync does.
- Adopt the core release that carries the client change.

## Order

0. **Now, small:** the app still says "A public note can include up to 50
   attachments" when a note has more than 50. Make it check 20 and say so, in
   the next desktop release and phone core adoption.
1. Website: sessions, staging, prune job, flag off. Deploy.
2. Desktop: the new client path, used only when the server advertises it.
3. Phones: the same, then store releases.
4. Turn the flag on. The staged path allows 50 attachments and 100 MB per note;
   the multipart path keeps 20.

## Tests

- Website: start-upload validation (count over 50, total over 100 MB, mime,
  per-file size, capacity), a logo on the staged path refused, a missing or
  mismatched staged object refused, a session used once only, another user's
  session refused, expiry and pruning, two publishes racing for the last
  capacity, the multipart path unchanged (logo included).
- Clients: unit tests for the new calls, with the old path kept green.
- End to end: publish a 50-image note from the built desktop app over CDP and
  from both phone simulators, then a live check against production with the QA
  account, as on October 9.

## Decisions (October 9, 2026)

- **50 attachments per note, not 100.** The publish API was designed and load
  tested for 50, the apps already check 50, and the Publish add-on's 1 GB across
  up to 100 notes averages about 10 MB a note. Publishing is barely used so far
  (two published notes in production), and the limit is a server setting the
  apps read, so it can rise later without an app release.
- **100 MB per note.** Without a total, one note could take nearly the whole
  1 GB, and a page that heavy is unusable on a phone. The total also bounds the
  publish-time verification (the server reads each staged file once) and keeps
  public notes from turning into file hosting. 100 MB fits 50 photos or
  screenshots at a typical 2 MB; the 10 MB per-file limit stays.
- **No logo in the publish request.** No current app sends one: the publish
  dialog says theme and logo are managed for the whole publication in ZenNotes
  Cloud, `prepareCloudPublishLogo` has no callers, and the public page prefers
  the account-wide logo, so the per-note logo is legacy. The staged path takes
  none; the multipart path keeps accepting it for older apps. This also retires
  the "19 with a new logo" special case.
