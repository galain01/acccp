CREATE TABLE "retained_job_metrics" (
	"day" date NOT NULL,
	"status" "job_status" NOT NULL,
	"job_count" bigint NOT NULL,
	CONSTRAINT "retained_job_metrics_day_status_pk" PRIMARY KEY("day","status"),
	CONSTRAINT "retained_job_metrics_count_nonnegative_chk" CHECK (job_count >= 0)
);
--> statement-breakpoint
ALTER TABLE "retained_job_metrics" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "retained_model_metrics" (
	"day" date NOT NULL,
	"model" text NOT NULL,
	"stage" "model_call_stage" NOT NULL,
	"call_count" bigint NOT NULL,
	"prompt_tokens" bigint NOT NULL,
	"completion_tokens" bigint NOT NULL,
	"cost_usd" numeric,
	CONSTRAINT "retained_model_metrics_day_model_stage_pk" PRIMARY KEY("day","model","stage"),
	CONSTRAINT "retained_model_metrics_count_nonnegative_chk" CHECK (call_count >= 0),
	CONSTRAINT "retained_model_metrics_prompt_tokens_nonnegative_chk" CHECK (prompt_tokens >= 0),
	CONSTRAINT "retained_model_metrics_completion_tokens_nonnegative_chk" CHECK (completion_tokens >= 0)
);
--> statement-breakpoint
ALTER TABLE "retained_model_metrics" ENABLE ROW LEVEL SECURITY;