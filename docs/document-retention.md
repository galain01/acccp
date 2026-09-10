# Document retention: 14 days

Documents expire **336 hours after the original `documents.created_at`**. This
is the first conversion/save, because selecting a file alone keeps it in the
browser. Reconversion, moving through review, and archiving a session do not
extend retention. The policy includes existing documents and failed conversions
with no job/artifact records. Deploying it does not start a new 14-day window.

At expiry the application blocks listing, saved HTML retrieval and reconversion.
Admin tables also hide expired document filenames. The daily purge removes:

- Original Word/PDF files and generated HTML in the private `documents` bucket.
- Other storage objects referenced by that document's artifacts, including old
  artifact types and unavailable/deleted artifacts.
- The document row and its cascading jobs, artifacts, preview snippets,
  validation findings, job events, and model-call usage records.

Accounts, authentication records, sessions and their titles remain. Historical
job/token/cost reports lose the deleted per-document records; this implementation
does not copy them into another retention store.

## Cleanup and concurrency

The purge and conversion storage operations take the same PostgreSQL document
row lock. The database clock is checked after acquiring the lock and again after
retained-document operations. Model calls run outside transactions; a result
arriving after expiry/deletion cannot recreate artifacts or return saved HTML.

Storage deletion must succeed before the document row is hard-deleted. Missing
objects are safe to delete again. If storage or the database fails, the row stays
discoverable for another attempt. Manual Delete and partial source-upload
failures commit a tombstone before trying cleanup, making them eligible for the
next sweep immediately. Each run is bounded to 200 documents and a 240-second
budget; locked documents are skipped and remain eligible. Counts and remaining
work are returned without filenames, content, storage keys or provider errors.

The scheduler calls `GET /api/cron/purge-documents` daily at `0 3 * * *` (UTC).
All requests require a server-only `CRON_SECRET` of at least 32 characters.
Actual deletion also requires both `VERCEL_ENV=production` and
`DOCUMENT_PURGE_ENABLED=true`. An authenticated `?dryRun=true` request counts
eligible documents without deleting anything, even before enablement.

The daily schedule fits Vercel Hobby. Hobby can invoke the job anywhere within
the scheduled hour; delivery is best effort, with no automatic retry on failure.
**Access expiry is 14 days; physical deletion occurs on a successful cleanup run,
not necessarily at that exact instant.** Failures or backlog can delay deletion.
For a tighter deletion deadline, use a supported more frequent scheduler and
monitor completion. See [Vercel scheduling limits](https://vercel.com/docs/cron-jobs/usage-and-pricing)
and [cron authentication, retries and delivery](https://vercel.com/docs/cron-jobs/manage-cron-jobs).

## Enable on the intended production project

The branch and migration do not themselves run a purge. Do not test destructive
cleanup with production credentials: the current `acccp-pdf-test` project shares
database/storage with `acccp`.

1. Test with synthetic documents in a separate database/bucket. Cover the exact
   expiry boundary, a fresh document, archived sessions, failed/no-job uploads,
   legacy artifact keys, storage failure followed by retry, repeated runs, and
   a conversion finishing after deletion.
2. Review the first sweep's scope using this read-only count against the intended
   database (it includes previously deleted documents):

   ```sql
   SELECT count(*) AS eligible_documents
   FROM documents
   WHERE deleted_at IS NOT NULL
      OR created_at <= clock_timestamp() - interval '336 hours';
   ```

3. Apply `0008_fourteen_day_retention.sql` through the normal Drizzle migration
   process to that database. It changes the two expiry defaults and aligns all
   existing job/artifact expiry timestamps with their original document. It does
   not delete data. Use the existing verified-TLS migration setup in the README.
4. Configure a fresh `CRON_SECRET` only for the original **acccp Production**
   environment. Leave `DOCUMENT_PURGE_ENABLED` unset initially. Keep these values
   out of source control, client variables, shell history and query strings.
5. Deploy the branch after review. Confirm the cron entry appears in Vercel's
   Cron Jobs settings and routes to the web service. Invoke the authenticated
   dry-run URL and review the aggregate count. Do not enable deletion in the
   test project or Preview environments.
6. Set `DOCUMENT_PURGE_ENABLED=true` in **acccp Production**, redeploy, and run the
   job once. Verify `failed=0` and `hasMore=false`. A 503 means failed/incomplete
   cleanup or disabled configuration, not successful enforcement. If there is a
   backlog, rerun until it clears; investigate repeated failures.
7. Monitor daily invocations, including missing runs. Vercel's Cron Jobs page
   exposes logs and manual runs; these are counts-only operational reports.
   Disabling the flag stops automated deletions but does not restore purged data
   or disable application access expiry.

## Scope limits

This deletes application-managed current records and objects. It cannot erase
already-downloaded copies, provider backups/logs, model-provider retention, or
renderer temporary files. Existing orphan objects without any document/artifact
record are not discoverable through this sweep; audit them separately before
making a complete historical-erasure claim. Institutional approval and provider
retention arrangements remain separate requirements.

Old deployments and the separate test app must not remain usable against this
database with code that can access expired records or bypass the new write locks.
Before enabling the purge, retire/protect old deployments and update the test
app to use isolated data or the same retention-aware code. Keeping the purge
disabled in that app does not by itself enforce read/write expiry there.

## Local verification without cloud data

Run `npm test`, `npm run typecheck`, `npm run format:check`, and `npm run build`.
The retention unit tests mock storage/database calls. An optional integration
suite executes the real retention helper and migration against an in-memory
PostgreSQL engine, with fake storage and synthetic document content:

```powershell
# Choose a disposable directory outside the application repository.
npm install --prefix C:\scratch\retention-check @electric-sql/pglite@0.5.8 drizzle-orm@0.45.2
$env:PGLITE_RUNTIME_DIR = 'C:\scratch\retention-check'
npx vitest run --config test/retention-postgres.config.mjs
```

It reads no application env files or database URL. The fixture uses the actual
0007 schema snapshot's enums, table definitions, checks and foreign keys, then
applies 0008. It omits unrelated indexes/views. The five integration tests cover
migration reruns/backfill/defaults, expiry visibility, cascades, partial-storage
failure/retry, ownership and rollback of writes that cross expiry. PGlite runs
one backend, so this does not simulate separate database connections competing
for a lock; unit tests separately verify the lock/query ordering.
