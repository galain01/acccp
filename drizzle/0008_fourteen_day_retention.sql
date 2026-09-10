ALTER TABLE "artifacts" ALTER COLUMN "expires_at" SET DEFAULT (now() + '336 hours'::interval);--> statement-breakpoint
ALTER TABLE "conversion_jobs" ALTER COLUMN "expires_at" SET DEFAULT (now() + '336 hours'::interval);
--> statement-breakpoint
-- Original document creation anchors retention, including existing records and
-- reconversions. Do not grant another fourteen days when this migration runs.
UPDATE "conversion_jobs" j
SET "expires_at" = d."created_at" + interval '336 hours'
FROM "documents" d
WHERE j."document_id" = d."id";
--> statement-breakpoint
UPDATE "artifacts" a
SET "expires_at" = d."created_at" + interval '336 hours'
FROM "conversion_jobs" j JOIN "documents" d ON d."id" = j."document_id"
WHERE a."job_id" = j."id";
