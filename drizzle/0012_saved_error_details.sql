CREATE TABLE "daily_failure_metrics" (
	"day" date NOT NULL,
	"stage" text NOT NULL,
	"code" text NOT NULL,
	"failure_count" bigint NOT NULL,
	CONSTRAINT "daily_failure_metrics_day_stage_code_pk" PRIMARY KEY("day","stage","code"),
	CONSTRAINT "daily_failure_metrics_count_positive_chk" CHECK (failure_count > 0),
	CONSTRAINT "daily_failure_metrics_stage_chk" CHECK (stage in ('word_to_pdf', 'pdf_render', 'conversion', 'audit', 'save_output', 'unknown')),
	CONSTRAINT "daily_failure_metrics_code_chk" CHECK (code in ('unknown_error', 'provider_configuration', 'provider_auth', 'provider_model_not_found', 'provider_request_rejected', 'provider_payload_limit', 'provider_rate_or_quota', 'provider_rate_limit', 'provider_quota', 'provider_budget', 'provider_unavailable', 'provider_connection', 'provider_invalid_json', 'provider_invalid_response', 'model_output_limit', 'model_content_filter', 'model_invalid_output', 'pdf_invalid', 'pdf_password', 'pdf_page_limit', 'pdf_image_limit', 'pdf_complexity_limit', 'pdf_render_warning', 'pdf_page_failed', 'pdf_output_limit', 'pdf_timeout', 'pdf_worker_failed', 'pdf_protocol_error', 'word_configuration', 'word_rejected', 'word_size_limit', 'word_busy', 'word_timeout', 'word_connection', 'word_invalid_output', 'output_storage_failed'))
);
--> statement-breakpoint
ALTER TABLE "daily_failure_metrics" ENABLE ROW LEVEL SECURITY;