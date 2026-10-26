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
```

The runtime is installed separately with lifecycle scripts disabled; it does not
change application dependencies or connect to any database service.

## Remaining boundaries

- Existing signed URLs can remain usable for their already-issued short TTL;
  changing an available pointer does not revoke them. Legacy keys are preserved
  as discovery rows until normal retention cleanup.
- The one-hour upload settlement allowance is conservative, not a provider
  guarantee for arbitrarily stalled remote writes. Failed candidates remain
  stored until document cleanup, so repeated failures temporarily consume space.
- Selected PowerPoint exports have their own immutable-pair protocol. Their
  pending marker and ambiguous-commit response behavior are not unified here.
  Editing the previous PowerPoint review after a failed reconversion remains a
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
