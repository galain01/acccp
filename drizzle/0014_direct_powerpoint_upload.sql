ALTER TABLE "documents" ADD COLUMN "upload_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "upload_completed_at" timestamp with time zone;