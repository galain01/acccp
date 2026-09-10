CREATE TABLE "retained_job_duration_metrics" (
	"day" date NOT NULL,
	"model" text NOT NULL,
	"duration_ms" bigint NOT NULL,
	"job_count" bigint NOT NULL,
	CONSTRAINT "retained_job_duration_metrics_day_model_duration_ms_pk" PRIMARY KEY("day","model","duration_ms"),
	CONSTRAINT "retained_job_duration_metrics_duration_nonnegative_chk" CHECK (duration_ms >= 0),
	CONSTRAINT "retained_job_duration_metrics_count_positive_chk" CHECK (job_count > 0)
);
--> statement-breakpoint
ALTER TABLE "retained_job_duration_metrics" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "retained_job_stats" (
	"day" date NOT NULL,
	"model" text NOT NULL,
	"job_count" bigint NOT NULL,
	"total_tokens" bigint NOT NULL,
	"page_count_sum" bigint NOT NULL,
	"page_measured_job_count" bigint NOT NULL,
	CONSTRAINT "retained_job_stats_day_model_pk" PRIMARY KEY("day","model"),
	CONSTRAINT "retained_job_stats_count_positive_chk" CHECK (job_count > 0),
	CONSTRAINT "retained_job_stats_tokens_nonnegative_chk" CHECK (total_tokens >= 0),
	CONSTRAINT "retained_job_stats_pages_consistent_chk" CHECK (page_measured_job_count >= 0 and page_measured_job_count <= job_count and page_count_sum >= page_measured_job_count)
);
--> statement-breakpoint
ALTER TABLE "retained_job_stats" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversion_jobs" ADD COLUMN "processing_duration_ms" bigint;--> statement-breakpoint
ALTER TABLE "conversion_jobs" ADD COLUMN "page_count" integer;--> statement-breakpoint
ALTER TABLE "model_calls" ADD COLUMN "cost_source" text;--> statement-breakpoint
ALTER TABLE "model_calls" ADD COLUMN "cached_prompt_tokens" integer;--> statement-breakpoint
ALTER TABLE "model_calls" ADD COLUMN "cache_creation_prompt_tokens" integer;--> statement-breakpoint
ALTER TABLE "retained_model_metrics" ADD COLUMN "priced_call_count" bigint;--> statement-breakpoint
ALTER TABLE "retained_model_metrics" ADD COLUMN "estimated_call_count" bigint;--> statement-breakpoint
ALTER TABLE "retained_model_metrics" ADD COLUMN "unpriced_call_count" bigint;--> statement-breakpoint
ALTER TABLE "conversion_jobs" ADD CONSTRAINT "conversion_jobs_duration_nonnegative_chk" CHECK (processing_duration_ms >= 0);--> statement-breakpoint
ALTER TABLE "conversion_jobs" ADD CONSTRAINT "conversion_jobs_page_count_positive_chk" CHECK (page_count > 0);--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_cost_source_chk" CHECK (cost_source in ('gateway', 'model-info', 'openai-list-price'));--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_cached_tokens_nonnegative_chk" CHECK (cached_prompt_tokens >= 0);--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_cache_creation_tokens_nonnegative_chk" CHECK (cache_creation_prompt_tokens >= 0);--> statement-breakpoint
ALTER TABLE "retained_model_metrics" ADD CONSTRAINT "retained_model_metrics_priced_count_nonnegative_chk" CHECK (priced_call_count >= 0);--> statement-breakpoint
ALTER TABLE "retained_model_metrics" ADD CONSTRAINT "retained_model_metrics_estimated_count_nonnegative_chk" CHECK (estimated_call_count >= 0);--> statement-breakpoint
ALTER TABLE "retained_model_metrics" ADD CONSTRAINT "retained_model_metrics_unpriced_count_nonnegative_chk" CHECK (unpriced_call_count >= 0);--> statement-breakpoint
ALTER TABLE "retained_model_metrics" ADD CONSTRAINT "retained_model_metrics_coverage_consistent_chk" CHECK (estimated_call_count <= priced_call_count and priced_call_count + unpriced_call_count = call_count);
--> statement-breakpoint
ALTER TABLE "model_calls" ALTER COLUMN "cost_usd" SET DATA TYPE numeric;
