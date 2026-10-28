# Recovering the first upload

## Scope and acceptance criteria

The previous browser flow learned a PDF/Word document ID only from the final
conversion response. A lost response could leave a saved source or completed
result without an identity the browser could reconcile. PowerPoint had the same
gap if its initial reservation response was lost.

The new browser protocol learns a server-issued identity before any persistent
work. It binds that identity to the authenticated owner, session, filename,
size, SHA-256 and selected output. Repeated initial submissions must preserve
the original, reuse that identity, and never start a second paid attempt.
Removal must win even before a source row exists. Expired or deleted identities
must not be recreated, and the original 14-day retention must not restart.

This increment changes local code and synthetic tests only. It needs no schema
change, deployment, new service, paid call or new credential.

## Protocol

1. The browser hashes the selected file and posts bounded metadata to
   `/api/document-submission`. The authenticated endpoint checks the owned,
   active session and returns a fresh server UUID plus a ten-minute signed
   preparation token. This step creates no database row, storage capability or
   model work. Losing its response therefore leaves nothing to recover.
2. The browser retains that preparation in memory before sending source bytes.
   PDF/Word multipart requests include the file and `submissionToken`.
   PowerPoint reservation metadata includes `submissionToken`, followed by the
   existing private, overwrite-disabled upload. Its first conversion includes
   both `documentId` and `submissionToken`.
3. First persistence locks the owner, checks the current database clock, and
   creates the exact document and a queued target with attempt count zero in
   one transaction. Existing IDs must match every source/ownership field and
   the queued target. A collision never adopts or overwrites another source.
4. PDF/Word source writes disable overwrite. A rejected storage response is
   reconciled by bounded download and exact length/hash checks; uncertain or
   mismatched originals remain discoverable and are never deleted as recovery.
   PowerPoint reservation similarly recognizes an already uploaded exact source
   and returns `sourceReady: true` instead of uploading again. Source readiness
   commits before a conversion starts.
5. A token-bearing initial request can start only its unstarted queued job and
   only inside the preparation deadline, checked again under the document lock.
   Processing, completed and failed initial attempts are read/recovery cases.
   They never automatically become new model work. An explicit later user
   reconversion uses the saved `documentId` without the initial token.
6. On response failure, the browser uses the already known ID to read the saved
   result. It does not automatically repeat conversion. Source readiness is
   separate from preparation identity, so an incomplete upload can reuse its
   still-valid preparation without pretending the source was stored.

The token is fixed-version, bounded, strictly parsed and HMAC-SHA256 signed with
a purpose-separated prefix using the existing `BETTER_AUTH_SECRET`. Missing or
short signing configuration fails closed. Verification uses constant-time
signature comparison. No token field grants authorization by itself: owned
session, document, source and target checks run again at persistence boundaries.

## Cancellation and deadlines

`DELETE /api/document-submission` accepts the signed token. It uses the same
owner lock as first persistence. If removal arrives first, it creates the exact
tombstone; a late upload cannot create the document after removal. If persistence
arrives first, cancellation marks that existing identity deleted. Normal network
failures do not cancel a reservation.

A missing-ID cancellation cannot have issued any storage capability under this
lock. Only that newly created tombstone is marked upload-settled using
`uploadCompletedAt`, so it does not consume unfinished-upload capacity. Existing
reservations cancelled after creation keep their incomplete state: their live
or uncertain capabilities still count against the existing cap. Deleted rows
remain inaccessible regardless of this settlement marker.

The existing `uploadExpiresAt` settlement barrier retains tombstones until their
preparation can no longer create data, plus the existing conservative hour.
PowerPoint signed upload URLs last two hours. Its fixed cleanup deadline is
the original preparation expiry plus 125 minutes, covering every permitted
re-sign. Signing is checked before and after the awaited provider call, and a
capability beyond the committed deadline is withheld. Neither re-signing nor
reconciliation changes document creation time or the 14-day access limit.
An expired token can inspect matching existing state or cancel it, but can never
create a missing ID or refresh its deadline.

## Validation and limits

Tests use synthetic tokens, bytes, storage responses and isolated PGlite schema
constraints. They cover ownership/hash/target collisions, idempotent reservation,
uncertain commits and source writes, both cancellation orderings, cancellation
capacity, late-write cleanup and first-attempt replay prevention. PGlite runs in
one local process; explicit transaction orderings do not establish hosted
multi-client contention or Supabase network behavior.

Run the focused suites with `node node_modules/vitest/vitest.mjs run` and the
isolated PostgreSQL suite with
`node node_modules/vitest/vitest.mjs run --config test/document-submission-postgres.config.mjs`,
setting `PGLITE_RUNTIME_DIR` to the reviewed isolated runtime. Existing native
engine preservation and accessibility checks remain unchanged.

Legacy callers without a preparation token retain their old API behavior. They
do not gain first-response identity recovery; the updated browser uses the new
protocol. Preparations and file bytes are kept only in browser memory. Reloads
can recover persisted rows through the dashboard, but an unsaved local file or
unconsumed token is not durably retained. Hard process termination, durable job
execution, comprehensive request-rate limits and authenticated tombstone-abuse
limits remain separate work. The settlement allowance is conservative, not a
guarantee about arbitrarily stalled remote writes. These tests do not certify
document accessibility or prove Office/Acrobat/assistive-technology behavior.

Provider behavior: [Supabase signed upload URLs](https://supabase.com/docs/reference/javascript/storage-from-createsigneduploadurl).
Cryptographic API: [Node.js HMAC and constant-time comparison](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptotimingsafeequala-b).
