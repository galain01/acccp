# Immutable conversion publication

## Problem and acceptance criteria

At base `8fd29ecc592b27228dd9ad8dd58988b80efba720`, reconversions
reused the same output and review object keys. Storage writes could succeed
before a later storage or database failure rolled back the transaction. An
existing available artifact would then describe different bytes. Canvas Word
reconversion had the same problem for the rendered PDF paired with its HTML.

This increment requires that every available output, review and set of findings
continue to describe the same completed conversion until a complete replacement
commits. Failed or superseded work must preserve that result, original source
and retry identity. All new objects must have a committed cleanup receipt before
upload. A lost database commit response must not trigger deletion of a committed
result or change it to a failed job. Original ownership and 14-day expiry remain
enforced, and existing canonical artifact pointers remain readable.

## Publication protocol

`lib/conversion-publication.ts` uses the existing document lock and artifact
table; no schema change or new service is required.

1. Recheck the owner, source session, requested user, target, retained document
   and conversion attempt. Record completed model usage using the route's
   deterministic, conflict-safe receipts.
2. Commit expired, non-downloadable artifact rows with unique object keys,
   checksums, sizes and expiry from the original document. An unacknowledged
   reservation never starts an upload.
3. In a second retained transaction, recheck the current processing attempt.
   Upload the output and review, plus the rendered PDF for Word-to-Canvas,
   using overwrite-disabled writes and a shared 30-second cancellation signal.
4. Retire the old available pointers and promote the exact reserved rows.
   Publish original-source metadata, findings, completion event and completed
   job state in that same database transaction. The partial unique artifact
   index still permits only one available artifact per job/type.
5. If the transaction response fails, reacquire the document lock. Only the
   completed current attempt and the entire exact available artifact set
   establish success. A newer attempt is left untouched. If reconciliation is
   unavailable, return a controlled uncertain response with document/job/target
   identity and retain all blobs and receipts.

The output and review use
`{session}/{document}/{job}/publication-{random UUID}/{artifact type}`. The
storage content type and signed attachment filename preserve the user-facing
file format. All successful targets now have a private review artifact;
Canvas previously constructed that review without storing it.

Failed publication does not eagerly remove candidate objects. Purge already
enumerates every artifact key as well as legacy canonical paths. The pending
review receipt is named `conversion-publication.json`; its one-hour settlement
barrier extends the existing native PDF transport policy. Promotion renames it
to `review.json`, releasing the barrier. This delay affects physical deletion
only; expired/deleted documents remain unavailable to users immediately.

The existing recent-processing guard now covers Canvas as well as native
targets. Failure accounting also checks the current processing state, preventing
a delayed failure from downgrading a completed attempt.

## Selected PowerPoint exports

The recovery increment based on
`e2089405a5a7e5f9bf1b4440f604ce177011be6f` applies the same publication
invariants to `lib/powerpoint-review-storage.ts`, while preserving its separate
selection protocol. The existing original-source hash, exact selected change
IDs, description edits, saved-review hash, conversion attempt and five-minute
export lease remain authoritative. Rendering and independent checks still run
outside the document lock; completed model calls are recorded once before any
output publication, including calls from failed checks.

1. Commit the export lease and two expired, non-downloadable artifact receipts
   for unique `review-{export UUID}.pptx` and `.json` keys. The review receipt
   uses the existing `conversion-publication.json` marker and one-hour upload
   settlement barrier. Neither receipt is an available download.
2. Replay only the instructor's exact selection from the immutable original,
   then run the existing checks. Recheck the current attempt, source-review
   hash and lease; commit the expected output/review checksums and sizes to the
   exact reserved rows. If that commit acknowledgement is lost, stop before
   uploading. Keep the receipts and recorded usage.
3. Recheck the same attempt, review and lease under the document lock. Upload
   both objects with overwrite disabled and one shared 30-second cancellation
   signal. Promote only matching receipt IDs, job, types, keys, checksums and
   sizes. Retire the prior pair and publish the selected findings and finished
   export event atomically. Rename the private review receipt to `review.json`.
4. Before preparing the download, verify the entire exact available pair, the
   completed original attempt and the matching finished export event in a fresh
   retained transaction. This verification also reconciles a lost publication
   acknowledgement; it never repeats replay, rendering, model calls or usage
   recording. A newer attempt or selected output cannot satisfy the proof.
5. Sign only that proven output, with the existing 60-second maximum and
   original-expiry checks. Return `savedOutputArtifactId` with the corresponding
   findings, changes and review token so client download bindings can advance
   together. A signing failure after proven publication reports that the
   selection was saved but its download could not be prepared. If the saved
   status cannot be verified, report uncertainty and preserve all receipts and
   events instead of asserting that the prior output was unchanged.

The PostgreSQL [row-lock behavior](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS)
and Drizzle's [update returning](https://orm.drizzle.team/docs/update#returning)
support the existing document serialization and exact receipt-match checks.
This does not add a worker, migration or new storage destination.

## Verification

The two new route regressions reproduced reused Canvas object keys and model
work starting during an overlapping request before the fix. Route tests exercise
the actual publication helper with mocked services. A separate PGlite suite
uses the schema snapshot, actual transactions, foreign keys and the exact
partial artifact unique index with a synthetic in-memory blob store. It checks
partial upload and metadata failures, acknowledged and unacknowledged commits,
reconciliation failure, supersession, ownership, expiry, cleanup of late writes,
legacy replacement and the rendered-PDF/HTML pair across all output formats.
PGlite runs in one local process. Tests inject attempt changes and commit faults
at explicit transaction boundaries; they do not measure hosted multi-client
lock contention or Supabase network behavior.

The existing Linux CI job installs the independent two-package test runtime
from `.github/test-runtime/package-lock.json` with lifecycle scripts disabled.
This installation boundary has no application workspace membership and adds no
production dependency. Run the PostgreSQL suite without application environment
variables:

```powershell
npm ci --prefix .github/test-runtime --ignore-scripts
$env:PGLITE_RUNTIME_DIR = (Resolve-Path .github/test-runtime).Path
node node_modules/vitest/vitest.mjs run --config test/conversion-publication-postgres.config.mjs
node node_modules/vitest/vitest.mjs run --config test/powerpoint-review-publication-postgres.config.mjs
```

The runtime is installed separately with lifecycle scripts disabled; it does not
change application dependencies or connect to any database service.

The selected-PowerPoint suite adds 12 isolated PostgreSQL cases: private
committed receipts, exact selected output/review identity, failure on either
upload, metadata rollback after both uploads, lost publication acknowledgement,
lost checksum-stage acknowledgement, unavailable reconciliation, superseding
attempts, signing failure, overlapping selection leases and late-write purge
settlement. Before the implementation, regressions reproduced non-private
receipts, premature purge and an unrecovered successful commit. The existing
20 storage and eight route tests also pass. Storage, native rendering and model
services are synthetic boundaries; these tests do not certify their hosted
network or accessibility behavior.

## Remaining boundaries

- Existing signed URLs can remain usable for their already-issued short TTL;
  changing an available pointer does not revoke them. Legacy keys are preserved
  as discovery rows until normal retention cleanup.
- The one-hour upload settlement allowance is conservative, not a provider
  guarantee for arbitrarily stalled remote writes. Failed candidates and retired
  successful versions remain stored until the original document's cleanup;
  repeated attempts temporarily consume additional space in the existing bucket.
  No new storage service, paid plan or retention extension is introduced. A
  separate bounded retired-version cleanup policy can reduce that footprint.
- Selected PowerPoint exports retain their own lease and selection protocol,
  with the publication safeguards described above. Editing the previous
  PowerPoint review after a failed reconversion remains a
  separate workflow; the saved output can still be retrieved by its pointer.
- Hard process termination, durable queued execution and recovery after losing
  the first response before learning a new document's identity remain separate
  work. This change does not automatically resume or repeat model calls.
- Synthetic SQL/storage failures establish these publication invariants, not
  hosted Supabase behavior, accessibility conformance, Office/Acrobat behavior,
  or assistive-technology usability. There was no production migration,
  deployment, document upload, credential change or paid model request.

The storage choice follows Supabase's [standard upload documentation](https://supabase.com/docs/guides/storage/uploads/standard-uploads):
new paths avoid overwrite propagation delays, and overwrite-disabled uploads
reject an existing object at the same key.
