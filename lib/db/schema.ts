import {
  pgTable,
  uniqueIndex,
  check,
  uuid,
  text,
  timestamp,
  index,
  foreignKey,
  bigint,
  integer,
  numeric,
  boolean,
  jsonb,
  unique,
  pgView,
  date,
  pgEnum,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const artifactStatus = pgEnum("artifact_status", [
  "available",
  "expired",
  "deleted",
]);
export const artifactType = pgEnum("artifact_type", [
  "source_docx",
  "source_pdf",
  "extracted_text",
  "html_output",
  "validation_report",
  "review_metadata",
]);
export const findingSeverity = pgEnum("finding_severity", [
  "info",
  "warning",
  "error",
]);
export const jobStatus = pgEnum("job_status", [
  "queued",
  "processing",
  "needs_review",
  "completed",
  "failed",
  "expired",
  "cancelled",
]);
export const reviewStatus = pgEnum("review_status", [
  "not_required",
  "pending",
  "reviewed",
]);
export const userRole = pgEnum("user_role", ["pending", "instructor", "admin"]);
export const modelCallStage = pgEnum("model_call_stage", [
  "convert",
  "validate",
]);

export const users = pgTable(
  "users",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    email: text().notNull(),
    displayName: text("display_name").notNull(),
    emailVerified: boolean("email_verified").default(false).notNull(),
    image: text(),
    role: userRole().default("pending").notNull(),
    // date (not string) mode: better-auth's adapter always writes native JS
    // Date objects to fields it manages, and a string-mode column would try
    // to insert Date.toString() output, which Postgres can't parse.
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    lastLoginAt: timestamp("last_login_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (table) => [
    uniqueIndex("uq_users_email_lower").using("btree", sql`lower(email)`),
  ]
).enableRLS();

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    userId: uuid("user_id").notNull(),
    token: text().notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("uq_auth_sessions_token").using(
      "btree",
      table.token.asc().nullsLast().op("text_ops")
    ),
    index("idx_auth_sessions_user_id").using(
      "btree",
      table.userId.asc().nullsLast().op("uuid_ops")
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "auth_sessions_user_id_fkey",
    }).onDelete("cascade"),
  ]
).enableRLS();

export const accounts = pgTable(
  "accounts",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    userId: uuid("user_id").notNull(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    scope: text(),
    password: text(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("uq_accounts_provider_account").using(
      "btree",
      table.providerId.asc().nullsLast().op("text_ops"),
      table.accountId.asc().nullsLast().op("text_ops")
    ),
    index("idx_accounts_user_id").using(
      "btree",
      table.userId.asc().nullsLast().op("uuid_ops")
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "accounts_user_id_fkey",
    }).onDelete("cascade"),
  ]
).enableRLS();

export const verifications = pgTable(
  "verifications",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_verifications_identifier").using(
      "btree",
      table.identifier.asc().nullsLast().op("text_ops")
    ),
  ]
).enableRLS();

export const sessions = pgTable(
  "sessions",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    ownerUserId: uuid("owner_user_id").notNull(),
    title: text().notNull(),
    description: text(),
    courseLabel: text("course_label"),
    termLabel: text("term_label"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    archivedAt: timestamp("archived_at", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table) => [
    index("idx_sessions_owner_user_id").using(
      "btree",
      table.ownerUserId.asc().nullsLast().op("uuid_ops")
    ),
    index("idx_sessions_updated_at").using(
      "btree",
      table.updatedAt.desc().nullsFirst().op("timestamptz_ops")
    ),
    uniqueIndex("uq_active_session_title_per_user")
      .using("btree", sql`owner_user_id`, sql`lower(title)`)
      .where(sql`(archived_at IS NULL)`),
    foreignKey({
      columns: [table.ownerUserId],
      foreignColumns: [users.id],
      name: "sessions_owner_user_id_fkey",
    }).onDelete("cascade"),
    check("sessions_title_not_blank_chk", sql`btrim(title) <> ''::text`),
  ]
).enableRLS();

export const documents = pgTable(
  "documents",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    sessionId: uuid("session_id").notNull(),
    uploadedByUserId: uuid("uploaded_by_user_id").notNull(),
    originalFilename: text("original_filename").notNull(),
    mimeType: text("mime_type")
      .default(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      )
      .notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    fileSizeBytes: bigint("file_size_bytes", { mode: "number" }).notNull(),
    checksumSha256: text("checksum_sha256"),
    pageCount: integer("page_count"),
    replacedByDocumentId: uuid("replaced_by_document_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    index("idx_documents_created_at").using(
      "btree",
      table.createdAt.desc().nullsFirst().op("timestamptz_ops")
    ),
    index("idx_documents_session_id").using(
      "btree",
      table.sessionId.asc().nullsLast().op("uuid_ops")
    ),
    index("idx_documents_uploaded_by_user_id").using(
      "btree",
      table.uploadedByUserId.asc().nullsLast().op("uuid_ops")
    ),
    foreignKey({
      columns: [table.replacedByDocumentId],
      foreignColumns: [table.id],
      name: "documents_replaced_by_document_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.sessionId],
      foreignColumns: [sessions.id],
      name: "documents_session_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.uploadedByUserId],
      foreignColumns: [users.id],
      name: "documents_uploaded_by_user_id_fkey",
    }).onDelete("restrict"),
    check("documents_file_size_positive_chk", sql`file_size_bytes > 0`),
    check(
      "documents_original_filename_not_blank_chk",
      sql`btrim(original_filename) <> ''::text`
    ),
    check(
      "documents_page_count_nonnegative_chk",
      sql`(page_count IS NULL) OR (page_count >= 0)`
    ),
  ]
).enableRLS();

export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    jobId: uuid("job_id").notNull(),
    artifactType: artifactType("artifact_type").notNull(),
    artifactStatus: artifactStatus("artifact_status")
      .default("available")
      .notNull(),
    filename: text().notNull(),
    mimeType: text("mime_type").notNull(),
    storageKey: text("storage_key").notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    fileSizeBytes: bigint("file_size_bytes", { mode: "number" }),
    checksumSha256: text("checksum_sha256"),
    previewSnippet: text("preview_snippet"),
    isUserDownloadable: boolean("is_user_downloadable").default(true).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" })
      .default(sql`(now() + '30 days'::interval)`)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    index("idx_artifacts_expires_at").using(
      "btree",
      table.expiresAt.asc().nullsLast().op("timestamptz_ops")
    ),
    index("idx_artifacts_job_id").using(
      "btree",
      table.jobId.asc().nullsLast().op("uuid_ops")
    ),
    index("idx_artifacts_status").using(
      "btree",
      table.artifactStatus.asc().nullsLast().op("enum_ops")
    ),
    index("idx_artifacts_type").using(
      "btree",
      table.artifactType.asc().nullsLast().op("enum_ops")
    ),
    uniqueIndex("uq_available_artifact_per_job_type")
      .using(
        "btree",
        table.jobId.asc().nullsLast().op("uuid_ops"),
        table.artifactType.asc().nullsLast().op("uuid_ops")
      )
      .where(sql`(artifact_status = 'available'::artifact_status)`),
    foreignKey({
      columns: [table.jobId],
      foreignColumns: [conversionJobs.id],
      name: "artifacts_job_id_fkey",
    }).onDelete("cascade"),
    check(
      "artifacts_file_size_nonnegative_chk",
      sql`(file_size_bytes IS NULL) OR (file_size_bytes >= 0)`
    ),
    check("artifacts_filename_not_blank_chk", sql`btrim(filename) <> ''::text`),
    check(
      "artifacts_storage_key_not_blank_chk",
      sql`btrim(storage_key) <> ''::text`
    ),
  ]
).enableRLS();

export const validationFindings = pgTable(
  "validation_findings",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    jobId: uuid("job_id").notNull(),
    severity: findingSeverity().notNull(),
    category: text().default("accessibility").notNull(),
    ruleCode: text("rule_code"),
    title: text().notNull(),
    message: text().notNull(),
    /** How to fix the issue. Produced by the AI validation stage. */
    suggestion: text(),
    /** WCAG criterion the finding violates, e.g. "WCAG 1.1.1". */
    wcag: text(),
    location: jsonb(),
    userVisible: boolean("user_visible").default(true).notNull(),
    resolved: boolean().default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    resolvedAt: timestamp("resolved_at", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table) => [
    index("idx_validation_findings_category").using(
      "btree",
      table.category.asc().nullsLast().op("text_ops")
    ),
    index("idx_validation_findings_job_id").using(
      "btree",
      table.jobId.asc().nullsLast().op("uuid_ops")
    ),
    index("idx_validation_findings_location_gin").using(
      "gin",
      table.location.asc().nullsLast().op("jsonb_ops")
    ),
    index("idx_validation_findings_rule_code").using(
      "btree",
      table.ruleCode.asc().nullsLast().op("text_ops")
    ),
    index("idx_validation_findings_severity").using(
      "btree",
      table.severity.asc().nullsLast().op("enum_ops")
    ),
    foreignKey({
      columns: [table.jobId],
      foreignColumns: [conversionJobs.id],
      name: "validation_findings_job_id_fkey",
    }).onDelete("cascade"),
    check(
      "validation_findings_message_not_blank_chk",
      sql`btrim(message) <> ''::text`
    ),
    check(
      "validation_findings_resolved_consistency_chk",
      sql`((resolved = true) AND (resolved_at IS NOT NULL)) OR (resolved = false)`
    ),
    check(
      "validation_findings_title_not_blank_chk",
      sql`btrim(title) <> ''::text`
    ),
  ]
).enableRLS();

export const jobEvents = pgTable(
  "job_events",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    jobId: uuid("job_id").notNull(),
    eventType: text("event_type").notNull(),
    message: text(),
    metadata: jsonb(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_job_events_created_at").using(
      "btree",
      table.createdAt.desc().nullsFirst().op("timestamptz_ops")
    ),
    index("idx_job_events_event_type").using(
      "btree",
      table.eventType.asc().nullsLast().op("text_ops")
    ),
    index("idx_job_events_job_id").using(
      "btree",
      table.jobId.asc().nullsLast().op("uuid_ops")
    ),
    index("idx_job_events_metadata_gin").using(
      "gin",
      table.metadata.asc().nullsLast().op("jsonb_ops")
    ),
    foreignKey({
      columns: [table.jobId],
      foreignColumns: [conversionJobs.id],
      name: "job_events_job_id_fkey",
    }).onDelete("cascade"),
    check(
      "job_events_event_type_not_blank_chk",
      sql`btrim(event_type) <> ''::text`
    ),
  ]
).enableRLS();

export const conversionJobs = pgTable(
  "conversion_jobs",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    documentId: uuid("document_id").notNull(),
    requestedByUserId: uuid("requested_by_user_id").notNull(),
    status: jobStatus().default("queued").notNull(),
    reviewStatus: reviewStatus("review_status").default("pending").notNull(),
    provider: text(),
    modelName: text("model_name"),
    promptVersion: text("prompt_version"),
    attemptCount: integer("attempt_count").default(0).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "string",
    }),
    reviewedAt: timestamp("reviewed_at", {
      withTimezone: true,
      mode: "string",
    }),
    reviewedByUserId: uuid("reviewed_by_user_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" })
      .default(sql`(now() + '30 days'::interval)`)
      .notNull(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_conversion_jobs_created_at").using(
      "btree",
      table.createdAt.desc().nullsFirst().op("timestamptz_ops")
    ),
    index("idx_conversion_jobs_document_id").using(
      "btree",
      table.documentId.asc().nullsLast().op("uuid_ops")
    ),
    index("idx_conversion_jobs_expires_at").using(
      "btree",
      table.expiresAt.asc().nullsLast().op("timestamptz_ops")
    ),
    index("idx_conversion_jobs_requested_by_user_id").using(
      "btree",
      table.requestedByUserId.asc().nullsLast().op("uuid_ops")
    ),
    index("idx_conversion_jobs_review_status").using(
      "btree",
      table.reviewStatus.asc().nullsLast().op("enum_ops")
    ),
    index("idx_conversion_jobs_status").using(
      "btree",
      table.status.asc().nullsLast().op("enum_ops")
    ),
    foreignKey({
      columns: [table.documentId],
      foreignColumns: [documents.id],
      name: "conversion_jobs_document_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.requestedByUserId],
      foreignColumns: [users.id],
      name: "conversion_jobs_requested_by_user_id_fkey",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.reviewedByUserId],
      foreignColumns: [users.id],
      name: "conversion_jobs_reviewed_by_user_id_fkey",
    }).onDelete("set null"),
    unique("conversion_jobs_one_job_per_document").on(table.documentId),
    check(
      "conversion_jobs_attempt_count_nonnegative_chk",
      sql`attempt_count >= 0`
    ),
    check(
      "conversion_jobs_review_consistency_chk",
      sql`((review_status = 'reviewed'::review_status) AND (reviewed_at IS NOT NULL)) OR (review_status <> 'reviewed'::review_status)`
    ),
  ]
).enableRLS();
export const modelCalls = pgTable(
  "model_calls",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    jobId: uuid("job_id").notNull(),
    stage: modelCallStage().notNull(),
    model: text().notNull(),
    promptTokens: integer("prompt_tokens").notNull(),
    completionTokens: integer("completion_tokens").notNull(),
    // Snapshotted at call time from LiteLLM /model/info so historical spend
    // doesn't shift if pricing changes later. Null when pricing lookup fails.
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_model_calls_job_id").using(
      "btree",
      table.jobId.asc().nullsLast().op("uuid_ops")
    ),
    index("idx_model_calls_created_at").using(
      "btree",
      table.createdAt.desc().nullsFirst().op("timestamptz_ops")
    ),
    foreignKey({
      columns: [table.jobId],
      foreignColumns: [conversionJobs.id],
      name: "model_calls_job_id_fkey",
    }).onDelete("cascade"),
    check("model_calls_prompt_tokens_nonnegative_chk", sql`prompt_tokens >= 0`),
    check(
      "model_calls_completion_tokens_nonnegative_chk",
      sql`completion_tokens >= 0`
    ),
  ]
).enableRLS();

export const adminFindingSummary = pgView("admin_finding_summary", {
  severity: findingSeverity(),
  category: text(),
  ruleCode: text("rule_code"),
  title: text(),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  findingCount: bigint("finding_count", { mode: "number" }),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  findingsCreatedLast24H: bigint("findings_created_last_24h", {
    mode: "number",
  }),
})
  .with({ securityInvoker: true })
  .as(
    sql`SELECT severity, category, COALESCE(rule_code, 'uncoded'::text) AS rule_code, title, count(*) AS finding_count, count(*) FILTER (WHERE created_at >= (now() - '24:00:00'::interval)) AS findings_created_last_24h FROM validation_findings WHERE user_visible = true GROUP BY severity, category, (COALESCE(rule_code, 'uncoded'::text)), title ORDER BY (count(*)) DESC`
  );

export const adminRetentionSummary = pgView("admin_retention_summary", {
  artifactType: artifactType("artifact_type"),
  artifactStatus: artifactStatus("artifact_status"),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  artifactCount: bigint("artifact_count", { mode: "number" }),
  nextExpirationAt: timestamp("next_expiration_at", {
    withTimezone: true,
    mode: "string",
  }),
  latestExpirationAt: timestamp("latest_expiration_at", {
    withTimezone: true,
    mode: "string",
  }),
})
  .with({ securityInvoker: true })
  .as(
    sql`SELECT artifact_type, artifact_status, count(*) AS artifact_count, min(expires_at) AS next_expiration_at, max(expires_at) AS latest_expiration_at FROM artifacts GROUP BY artifact_type, artifact_status`
  );

export const userSessionFileOverview = pgView("user_session_file_overview", {
  sessionId: uuid("session_id"),
  ownerUserId: uuid("owner_user_id"),
  sessionTitle: text("session_title"),
  documentId: uuid("document_id"),
  originalFilename: text("original_filename"),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  fileSizeBytes: bigint("file_size_bytes", { mode: "number" }),
  pageCount: integer("page_count"),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true, mode: "string" }),
  jobId: uuid("job_id"),
  status: jobStatus(),
  reviewStatus: reviewStatus("review_status"),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  htmlArtifactId: uuid("html_artifact_id"),
  htmlFilename: text("html_filename"),
  htmlStorageKey: text("html_storage_key"),
  htmlPreviewSnippet: text("html_preview_snippet"),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  visibleFindingCount: bigint("visible_finding_count", { mode: "number" }),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  visibleErrorCount: bigint("visible_error_count", { mode: "number" }),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  visibleWarningCount: bigint("visible_warning_count", { mode: "number" }),
})
  .with({ securityInvoker: true })
  .as(
    sql`SELECT s.id AS session_id, s.owner_user_id, s.title AS session_title, d.id AS document_id, d.original_filename, d.file_size_bytes, d.page_count, d.created_at AS uploaded_at, j.id AS job_id, j.status, j.review_status, j.expires_at, j.error_code, j.error_message, html.id AS html_artifact_id, html.filename AS html_filename, html.storage_key AS html_storage_key, html.preview_snippet AS html_preview_snippet, count(vf.id) FILTER (WHERE vf.user_visible = true) AS visible_finding_count, count(vf.id) FILTER (WHERE vf.severity = 'error'::finding_severity AND vf.user_visible = true) AS visible_error_count, count(vf.id) FILTER (WHERE vf.severity = 'warning'::finding_severity AND vf.user_visible = true) AS visible_warning_count FROM sessions s JOIN documents d ON d.session_id = s.id LEFT JOIN conversion_jobs j ON j.document_id = d.id LEFT JOIN artifacts html ON html.job_id = j.id AND html.artifact_type = 'html_output'::artifact_type AND html.artifact_status = 'available'::artifact_status LEFT JOIN validation_findings vf ON vf.job_id = j.id WHERE d.deleted_at IS NULL GROUP BY s.id, s.owner_user_id, s.title, d.id, d.original_filename, d.file_size_bytes, d.page_count, d.created_at, j.id, j.status, j.review_status, j.expires_at, j.error_code, j.error_message, html.id, html.filename, html.storage_key, html.preview_snippet`
  );

export const adminJobStatusSummary = pgView("admin_job_status_summary", {
  status: jobStatus(),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  jobCount: bigint("job_count", { mode: "number" }),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  jobsCreatedLast24H: bigint("jobs_created_last_24h", { mode: "number" }),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  jobsCompletedLast24H: bigint("jobs_completed_last_24h", { mode: "number" }),
})
  .with({ securityInvoker: true })
  .as(
    sql`SELECT status, count(*) AS job_count, count(*) FILTER (WHERE created_at >= (now() - '24:00:00'::interval)) AS jobs_created_last_24h, count(*) FILTER (WHERE completed_at >= (now() - '24:00:00'::interval)) AS jobs_completed_last_24h FROM conversion_jobs GROUP BY status`
  );

export const adminDailyJobSummary = pgView("admin_daily_job_summary", {
  day: date(),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  totalJobs: bigint("total_jobs", { mode: "number" }),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  completedJobs: bigint("completed_jobs", { mode: "number" }),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  failedJobs: bigint("failed_jobs", { mode: "number" }),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  needsReviewJobs: bigint("needs_review_jobs", { mode: "number" }),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  expiredJobs: bigint("expired_jobs", { mode: "number" }),
})
  .with({ securityInvoker: true })
  .as(
    sql`SELECT date_trunc('day'::text, created_at)::date AS day, count(*) AS total_jobs, count(*) FILTER (WHERE status = 'completed'::job_status) AS completed_jobs, count(*) FILTER (WHERE status = 'failed'::job_status) AS failed_jobs, count(*) FILTER (WHERE status = 'needs_review'::job_status) AS needs_review_jobs, count(*) FILTER (WHERE status = 'expired'::job_status) AS expired_jobs FROM conversion_jobs GROUP BY (date_trunc('day'::text, created_at)::date) ORDER BY (date_trunc('day'::text, created_at)::date) DESC`
  );
