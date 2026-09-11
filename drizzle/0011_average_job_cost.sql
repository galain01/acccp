ALTER TABLE "retained_job_stats" ADD COLUMN "job_cost_usd" numeric;--> statement-breakpoint
ALTER TABLE "retained_job_stats" ADD COLUMN "cost_measured_job_count" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "retained_job_stats" ADD COLUMN "cost_estimated_job_count" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "retained_job_stats" ADD CONSTRAINT "retained_job_stats_cost_coverage_consistent_chk" CHECK (cost_estimated_job_count >= 0 and cost_estimated_job_count <= cost_measured_job_count and cost_measured_job_count <= job_count and
        ((cost_measured_job_count = 0 and job_cost_usd is null) or (cost_measured_job_count > 0 and job_cost_usd is not null)));