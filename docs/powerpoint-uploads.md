# PowerPoint uploads up to 25 MiB

PowerPoint files upload directly from the browser to private storage, then the application converts the saved original by document ID. This MVP keeps conversion within the existing request lifecycle. It has no durable conversion queue or resumable upload protocol.

| File or resource                                   | Limit                         |
| -------------------------------------------------- | ----------------------------- |
| Uploaded PowerPoint                                | 25 MiB                        |
| Generated PowerPoint, including description slides | 30 MiB                        |
| PDF generated temporarily from PowerPoint          | 16 MiB                        |
| Uploaded PDF or Word document                      | 4 MiB                         |
| Expanded PowerPoint ZIP contents                   | 96 MiB total; 32 MiB per part |

The interface labels file sizes “MB”; these code limits use MiB (1,048,576 bytes). Slide, object, XML, image-pixel, and processing-time limits remain separate. A file within the upload limit can still exceed a conversion limit. See [PowerPoint accessibility](powerpoint-accessibility.md) for supported repairs and review behavior; the limits and transport described here supersede its earlier 4 MiB PowerPoint upload description.

## Upload and conversion

1. The browser computes the selected file's SHA-256 and posts its session ID, filename, size, and hash to `/api/document-upload`.
2. The server verifies the instructor/admin role and active session ownership, then commits a document reservation before requesting a signed upload URL. An account can have at most three outstanding reservations; the account row lock makes this check apply across its sessions.
3. The browser sends the raw file with a single `PUT` to that URL. The capability permits creation at one server-chosen path, with overwrite disabled. The browser receives no storage service credentials. An interrupted upload must be retried; it cannot resume from a byte offset.
4. `/api/convert` receives the document ID. Under the retention lock, it reads the canonical object with a 25 MiB streaming bound and verifies the recorded size, SHA-256, and file envelope before marking the upload complete. Package inspection then runs before model work.

The browser processes a batch serially. This controls work in that browser; other browsers and users can still convert simultaneously. A recent active PowerPoint attempt blocks duplicate starts for the same document. Publication and failure handling compare attempt numbers so an older request cannot replace a newer result. Billable calls retain a stable receipt per attempt.

Successful downloads use short-lived private storage URLs. Conversion responses contain metadata rather than the PowerPoint binary. Selected exports retain a full output and review record, so repeated exports increase storage until cleanup.

## Rendering larger presentations

For a PowerPoint larger than 4 MiB, `lib/powerpoint-render-storage.ts` creates a temporary copy in the existing private bucket. It commits an artifact receipt before uploading, then passes a 60-second signed **read** URL to the existing renderer's `downloadFrom` option. The renderer receives a small request rather than the large PowerPoint body. Accepted URLs are restricted to the configured storage project and expected signed PowerPoint path; clients cannot submit arbitrary download URLs.

The application attempts to delete the temporary copy immediately after rendering, including on failure. Its receipt remains discoverable by document purge if deletion fails. This path also renders large selected exports. Smaller presentations retain the multipart renderer path.

The generated PDF still travels back from the renderer to the application, where its header and streamed size are checked against 16 MiB. **A hosted renderer response larger than 4.5 MB has not yet been verified.** That transport must be tested on the intended deployment before release; a successful local conversion does not establish that the hosted response path accepts it.

## Retention and abandoned uploads

Signed upload URLs normally last two hours. Before signing, the application reserves a conservative 125-minute deadline; after receiving the token, it records its actual expiry before returning the URL. Interrupted signing therefore leaves a cleanup receipt.

Deleting a document hides it immediately. Physical deletion waits until the upload token expires plus a one-hour allowance for an upload already in progress, so a still-valid upload URL cannot recreate an object whose receipt has been removed. The allowance is conservative; it is not a provider guarantee about arbitrarily stalled uploads. Abandoned reservations become eligible for cleanup after that window.

Completed documents retain the existing **14 days from original document creation**. Reconversion, review, and exports do not extend it. Purge discovers canonical files, selected exports, temporary renderer copies, and other artifact-linked objects. It preserves discovery records when cleanup fails and retains anonymous usage totals when content is deleted. Eligibility does not mean immediate physical deletion: the existing daily purge processes up to 200 documents within 240 seconds. See [document retention](document-retention.md).

## Deployment prerequisites

- Apply the generated Drizzle migration `0014_direct_powerpoint_upload.sql` before deploying code that reads the new nullable `upload_expires_at` and `upload_completed_at` columns. Existing documents keep their original retention behavior.
- Keep the `documents` bucket private. Its file-size limit must allow at least **30 MiB** for generated outputs and temporary render copies; **32 MiB** is a practical setting. The application independently limits uploaded PowerPoints to 25 MiB. A signed upload does not itself bind the expected size or hash, so bucket limits remain necessary alongside finalization checks.
- If MIME restrictions are enabled, allow PowerPoint's `application/vnd.openxmlformats-officedocument.presentationml.presentation` and review `application/json`, retaining existing PDF, DOCX, and HTML types.
- Use the updated renderer configuration and verify direct upload, conversion, selected export, temporary-copy cleanup, and a generated PDF response over 4.5 MB in the intended hosted environment.

Creating the migration and updating local preview settings does not apply these changes to a hosted database or bucket.

## Rollback

Keep the additive database migrations when rolling back application behavior. Once signed uploads have been issued, preserve this branch's retention handling: older cleanup code can remove a reservation while its upload URL is still valid, leaving a later upload without a cleanup record. A rollback must retain the upload-aware cleanup rules while those capabilities or PowerPoint artifacts exist.
